// 本文件负责：闲时投递（SPEC-offpeak A、B、E，decisions D20）在工作流层的部分——
// send --offpeak 的前置条件与当场取号（takeOffPeak），runs/<id>/offpeak.json 的读写（readOffPeak），
// 闲时投递期间挡普通 send 的判据（offPeakBlocks），以及 runner 的闲时部分（createOffPeakRunner：
// 等号就绪、推授权并拼 send 额外参数、回合结束后结算号）。
// 不负责：命令行解析与打印（lib/cli/send.mjs）、runner 的其余一生（lib/run.mjs 只在几处调这里）、
// 闲时服务器请求本身（lib/offpeak.mjs）、授权配置与 send 参数的形状（协议层 lib/offpeak-provider.mjs）、
// 凭据解密（lib/credentials.mjs）。重取号、cancel、caffeinate 与排号显示不在这里（后续任务 OP5、OP6）。
// 和谁打交道：lib/credentials.mjs、lib/offpeak.mjs、lib/offpeak-provider.mjs、lib/queue.mjs、lib/runs.mjs、
// lib/registry.mjs、lib/tiers.mjs，协议层 lib/appserver.mjs 只用来定位内置 provider 文件。
//
// 安全边界（RULES §8，D20）：JWT 与 plan key 只进内存、请求头、JSON-RPC 参数与 secrets 抹除名单
// （createOffPeakRunner().secrets() 交给 AppServerClient.spawn 与 attachSession）；offpeak.json、事件、错误文案里都不带。
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';
import { writeJsonAtomic } from './config.mjs';
import { readOffPeakAuth } from './credentials.mjs';
import { createOffPeakClient } from './offpeak.mjs';
import { buildOffPeakAccountConfig, buildOffPeakSendParams, builtinRevision, offPeakModelIds } from './offpeak-provider.mjs';
import { builtinProviderConfigPath, findZcode } from './appserver.mjs';
import { enqueue, nextQueueFile } from './queue.mjs';
import { appendEvent, livePidOf, readJsonOrNull, removeFileIfExists, runsDirOf } from './runs.mjs';
import { updateSession } from './registry.mjs';
import { reasoningLevelFor } from './tiers.mjs';

const DEFAULT_POLL_CAP_MS = 60000; // 轮询间隔封顶（SPEC-offpeak B.1），测试用 ZCODE_EXECUTOR_OFFPEAK_POLL_MS 压短
const REQUEST_TIMEOUT_MS = 20_000;

/** offpeak.json 的 phase 在这几个值时，这条会话被闲时投递占着（SPEC-offpeak A.1「闲时投递独占空闲会话」）。 */
const BUSY_PHASES = new Set(['queued', 'ready', 'running']);

const now = () => new Date().toISOString();
const iso = (ms) => (typeof ms === 'number' ? new Date(ms).toISOString() : null);
const offPeakPath = (home, sessionId) => path.join(runsDirOf(home, sessionId), 'offpeak.json');

/** 纯读 runs/<id>/offpeak.json；没有返回 null。 */
export function readOffPeak(home, sessionId) {
  return readJsonOrNull(offPeakPath(home, sessionId));
}

/** 合并写 offpeak.json（原子写，RULES §6），updatedAt 每次刷新；返回写下的对象。 */
export function writeOffPeak(home, sessionId, patch) {
  const next = { ...readOffPeak(home, sessionId), ...patch, updatedAt: now() };
  writeJsonAtomic(offPeakPath(home, sessionId), next);
  return next;
}

/**
 * 普通 send / --steer 在闲时投递期间能不能进：能进返回 null，不能进返回拒绝原因（退出码 2 由调用方抛）。
 * 插话只影响当前回合，所以回合开跑（phase running）后放行 --steer；排号中（queued / ready）回合还没开始，插不了。
 */
export function offPeakBlocks(home, sessionId, { steer = false } = {}) {
  const phase = readOffPeak(home, sessionId)?.phase;
  if (!BUSY_PHASES.has(phase)) return null;
  if (steer && phase === 'running') return null;
  if (steer) return '闲时投递还在排号，回合没开跑，插不了话。等它开跑后再 --steer，或先 cancel';
  return '这条会话有闲时投递在排号或运行，先 cancel 或另开会话';
}

/**
 * 内置 provider 文件的绝对路径，定位规则与 AppServerClient.spawn 给子进程的一致（lib/appserver.mjs）：
 * 环境变量 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指了就用它，没指从 zcode.cjs 位置推。
 */
export function builtinPathFor(env = process.env) {
  const builtinFile = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '';
  return builtinFile
    ? builtinProviderConfigPath(null, { builtinFile })
    : builtinProviderConfigPath(findZcode({ zcodeBin: env.ZCODE_BIN || '' }), { builtinFile: '' });
}

/**
 * send --offpeak（SPEC-offpeak A.1–A.3）：前置条件 → 当场取号 → 写 offpeak.json → 入队 → 记 executor.offpeak.taken。
 * 前置条件不满足、取号失败都抛 ExecutorError（退出码 2；闲时服务地址配错是 1）。起 runner 归调用方。
 * @returns {Promise<{offPeakId: string, ticketId: string, position: number|null}>}
 */
export async function takeOffPeak({ home, sessionId, entry, text, task, timeoutSec, env = process.env }) {
  const dir = runsDirOf(home, sessionId);
  const queueDir = path.join(dir, 'queue');
  if (livePidOf(home, sessionId) || (existsSync(queueDir) && nextQueueFile(queueDir))) {
    throw new ExecutorError('闲时投递要会话空闲（没有在跑的 runner、队列为空）：等当前投递结束（status 看进度）再投，或另开会话', 2);
  }
  const auth = readOffPeakAuth({ env });
  if (auth.error) throw new ExecutorError(`闲时投递用不了：${auth.error}`, 2);

  const builtinPath = builtinPathFor(env);
  let builtin;
  try {
    builtin = JSON.parse(readFileSync(builtinPath, 'utf8'));
  } catch (err) {
    throw new ExecutorError(`内置 provider 文件读不了或不是合法 JSON：${builtinPath}：${err.message}。确认 ZCode App 安装完整`, 2);
  }
  const modelIds = offPeakModelIds(builtin, auth.family);
  if (!Array.isArray(modelIds)) {
    throw new ExecutorError(`内置 provider 文件里找不到闲时条目的模型表（${builtinPath}）。闲时接口可能变了，跑 zcode-executor doctor --offpeak 确认`, 2);
  }
  if (!modelIds.includes(entry.modelId)) {
    throw new ExecutorError(
      `会话的模型 ${entry.modelId} 不在闲时模型表里（${modelIds.join('、')}）。用 new --tier 另开一条用这些模型的会话`,
      2,
    );
  }

  // 一次投递一个 offPeakId，重取号不换（SPEC-offpeak A.2）
  const offPeakId = `offpeak-${randomUUID()}`;
  const ticket = await createOffPeakClient({ auth, env }).take(offPeakId);
  writeOffPeak(home, sessionId, {
    offPeakId,
    ticketId: ticket.ticketId,
    ticketCount: 1,
    phase: 'queued',
    position: ticket.position,
    readyDeadline: iso(ticket.readyDeadline),
    activeDeadline: null,
    settledAt: null,
    settleError: null,
  });
  enqueue(home, sessionId, { text, task, timeoutSec, offpeak: { offPeakId } });
  appendEvent(path.join(dir, 'events.jsonl'), {
    type: 'executor.offpeak.taken',
    at: now(),
    offPeakId,
    ticketId: ticket.ticketId,
    position: ticket.position,
  });
  return { offPeakId, ticketId: ticket.ticketId, position: ticket.position };
}

/**
 * runner 的闲时部分（SPEC-offpeak B 的正常路径）。每个 runner 建一个；凭据在第一次遇到闲时队列项时读一次，
 * 之后这个 runner 的连接都把 JWT 与 plan key 放进 secrets。普通队列项不经过这里的任何方法。
 * 失败（号过期、查不到、查排位失败、推授权失败）一律把这条投递按 failed 结束：写 last.json、executor.result、
 * 登记簿 lastOutcome，删队列项，再结算号。权宜：号失效不重取，后续任务 OP5 改成重取号与退避重试结算。
 */
export function createOffPeakRunner({ home, sessionId, env = process.env }) {
  const dir = runsDirOf(home, sessionId);
  const eventsPath = path.join(dir, 'events.jsonl');
  const pollCapMs = Number(env.ZCODE_EXECUTOR_OFFPEAK_POLL_MS) || DEFAULT_POLL_CAP_MS;
  let auth = null;
  let server = null;
  const loadAuth = () => (auth ??= readOffPeakAuth({ env }));
  const serverClient = () => (server ??= createOffPeakClient({ auth: loadAuth(), env }));
  const write = (patch) => writeOffPeak(home, sessionId, patch);
  const event = (type, extra) => appendEvent(eventsPath, { type, at: now(), ...extra });

  async function settle() {
    const op = readOffPeak(home, sessionId);
    if (!op?.ticketId) return;
    try {
      if (loadAuth().error) throw new ExecutorError(`闲时凭据读不了：${auth.error}`, 2);
      const res = await serverClient().settle(op.ticketId);
      write({ phase: 'done', settledAt: iso(res.settledAt) ?? now(), settleError: null });
      event('executor.offpeak.settled', { offPeakId: op.offPeakId, ticketId: op.ticketId, state: res.state });
    } catch (err) {
      if (!(err instanceof ExecutorError)) throw err;
      write({ phase: 'done', settleError: err.message });
      process.stderr.write(`runner: 闲时号 ${op.ticketId} 结算失败：${err.message}\n`);
    }
  }

  // 闲时投递以 failed 终局，落盘形状同 lib/run.mjs 的普通回合结算
  async function fail(queueFile, item, reason) {
    writeJsonAtomic(path.join(dir, 'last.json'), {
      kind: 'last',
      outcome: 'failed',
      reason,
      lastText: null,
      usage: null,
      startedAt: null,
      endedAt: now(),
      text: item.text ?? '',
      task: item.task ?? null,
    });
    event('executor.result', { outcome: 'failed', reason });
    updateSession(home, sessionId, { lastOutcome: 'failed' });
    removeFileIfExists(queueFile);
    await settle();
    write({ phase: 'done' }); // 没有号可结算时也收成 done，不然会话一直被占着
    return false;
  }

  return {
    /** 当前已读到的闲时凭据（JWT、plan key），没读过或读失败是空数组。交给 spawn 与 attachSession 的 secrets。 */
    secrets: () => (auth && !auth.error ? [auth.jwt, auth.planKey] : []),

    /**
     * 队列头是闲时项时按 nextPollMs（封顶 pollCapMs）轮询到号就绪，期间不起 app-server（SPEC-offpeak B.1）。
     * 队列头不是闲时项直接返回 true；返回 false 表示这条已按 failed 结束并出队。号已是 active（上个 runner
     * 开跑后中途退出）也当就绪。
     */
    async awaitReady(queueDir) {
      const queueFile = nextQueueFile(queueDir);
      const item = queueFile ? readJsonOrNull(queueFile) : null;
      if (!item?.offpeak) return true;
      const op = readOffPeak(home, sessionId);
      if (!op?.ticketId || op.offPeakId !== item.offpeak.offPeakId) {
        return fail(queueFile, item, `offpeak.json 与队列里的闲时投递 ${item.offpeak.offPeakId} 对不上，号找不到了。重新 send --offpeak`);
      }
      if (loadAuth().error) return fail(queueFile, item, `闲时凭据读不了：${auth.error}`);
      for (;;) {
        let res;
        try {
          res = await serverClient().status([op.ticketId]);
        } catch (err) {
          if (!(err instanceof ExecutorError)) throw err;
          return fail(queueFile, item, `等号时查排位失败：${err.message}`);
        }
        const ticket = res.tickets.find((t) => t.ticketId === op.ticketId);
        const state = ticket?.state ?? 'not_found';
        if (state === 'ready' || state === 'active') {
          write({ phase: 'ready', position: null, readyDeadline: iso(ticket.readyDeadline) ?? op.readyDeadline, activeDeadline: iso(ticket.activeDeadline) });
          event('executor.offpeak.ready', { offPeakId: op.offPeakId, ticketId: op.ticketId });
          return true;
        }
        if (state === 'expired') return fail(queueFile, item, `闲时号 ${op.ticketId} 在开跑前过期了（expired）`);
        if (state !== 'queued') return fail(queueFile, item, `闲时号 ${op.ticketId} 服务器那边查不到了（${state}）`);
        write({ position: ticket.position });
        await new Promise((resolve) => setTimeout(resolve, Math.min(res.nextPollMs, pollCapMs)));
      }
    },

    /**
     * 连接起好后、session/send 之前（SPEC-offpeak B.2）：推 provider/updateAccountConfig，拼闲时回合的 send 额外参数，
     * offpeak.json 进 running、记 executor.offpeak.started。返回 extraParams；推送报错或回执 revision 对不上时这条按
     * failed 结束并出队，返回 null（回执 unchanged 不算失败）。
     */
    async prepareSend({ client, item, entry, providerObj, queueFile }) {
      const op = readOffPeak(home, sessionId);
      // 正常情况 awaitReady 已读过凭据；闲时项不在队列头时（前置条件挡着，不该发生）这里补读
      if (loadAuth().error) {
        await fail(queueFile, item, `闲时凭据读不了：${auth.error}`);
        return null;
      }
      let extraParams;
      try {
        const accountConfig = buildOffPeakAccountConfig({ family: auth.family, basedOnZCodeBuiltinRevision: builtinRevision(builtinPathFor(env)) });
        const reply = await client.request('provider/updateAccountConfig', accountConfig, { timeoutMs: REQUEST_TIMEOUT_MS });
        if (reply?.receivedRevision !== accountConfig.revision) {
          throw new ExecutorError(`provider/updateAccountConfig 回执对不上：${JSON.stringify(reply)}`, 2);
        }
        extraParams = buildOffPeakSendParams({
          family: auth.family,
          modelId: entry.modelId,
          // 与普通投递建会话时同一算法（lib/run.mjs）
          reasoningLevel: reasoningLevelFor(entry.thoughtLevel, providerObj.models.find((m) => m.modelId === entry.modelId)),
          jwt: auth.jwt,
          planKey: auth.planKey,
          ticketId: op.ticketId,
          offPeakId: op.offPeakId,
          runType: 'init',
          toolDenylist: entry.toolDenylist ?? [],
        });
      } catch (err) {
        if (!(err instanceof ExecutorError)) throw err;
        await fail(queueFile, item, `闲时授权没推成：${err.message}`);
        return null;
      }
      write({ phase: 'running' });
      event('executor.offpeak.started', { offPeakId: op.offPeakId, ticketId: op.ticketId });
      return extraParams;
    },

    /** 回合照普通回合结算之后（SPEC-offpeak B.4）：结算当前号。失败只记 settleError 并打一行 stderr。 */
    settle,
  };
}
