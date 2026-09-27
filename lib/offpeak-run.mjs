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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
import { appendEvent, livePidOf, readJsonOrNull, removeFileIfExists, runsDirOf, writeFailedLast } from './runs.mjs';
import { updateSession } from './registry.mjs';
import { reasoningLevelFor } from './tiers.mjs';

const DEFAULT_POLL_CAP_MS = 60000; // 轮询间隔封顶（SPEC-offpeak B.1），测试用 ZCODE_EXECUTOR_OFFPEAK_POLL_MS 压短
// 等号时查排位连续「暂时不可用」多久才放弃；测试用 ZCODE_EXECUTOR_OFFPEAK_STATUS_GIVEUP_MS 压短
const DEFAULT_STATUS_GIVEUP_MS = 30 * 60 * 1000;
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

/** 队列里各项带的 offPeakId（没有闲时项是空数组）；队列目录不在也是空数组。 */
function queuedOffPeakIds(queueDir) {
  if (!existsSync(queueDir)) return [];
  return readdirSync(queueDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJsonOrNull(path.join(queueDir, f))?.offpeak?.offPeakId)
    .filter(Boolean);
}

/**
 * 普通 send / --steer 在闲时投递期间能不能进：能进返回 null，不能进返回拒绝原因（退出码 2 由调用方抛）。
 * 只有 offpeak.json 的 phase 没收尾、而且确实有人占着（runner 活着，或队列里还有这次闲时投递的项）才算占用；
 * 否则是陈旧记录（排号中被 cancel、runner 死了），放行。权宜：孤儿号不结算，OP6 的 cancel 接手。
 * 插话只影响当前回合，所以回合开跑（phase running）后放行 --steer；排号中（queued / ready）回合还没开始，插不了。
 */
export function offPeakBlocks(home, sessionId, { steer = false } = {}) {
  const op = readOffPeak(home, sessionId);
  const phase = op?.phase;
  if (!BUSY_PHASES.has(phase)) return null;
  const queueDir = path.join(runsDirOf(home, sessionId), 'queue');
  if (!livePidOf(home, sessionId) && !queuedOffPeakIds(queueDir).includes(op.offPeakId)) return null;
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
 * runner 的闲时部分（SPEC-offpeak B 的正常路径）。每个 runner 建一个；队列里一出现闲时项就读一次凭据，
 * 之后这个 runner 的连接都把 JWT 与 plan key 放进 secrets。普通队列项不经过这里的任何方法。
 * 失败（号过期、查不到、查排位失败、推授权失败）一律把这条投递按 failed 结束：写 last.json、executor.result、
 * 登记簿 lastOutcome，删队列项，再结算号。权宜：号失效不重取，后续任务 OP5 改成重取号与退避重试结算。
 */
export function createOffPeakRunner({ home, sessionId, env = process.env }) {
  const dir = runsDirOf(home, sessionId);
  const eventsPath = path.join(dir, 'events.jsonl');
  const pollCapMs = Number(env.ZCODE_EXECUTOR_OFFPEAK_POLL_MS) || DEFAULT_POLL_CAP_MS;
  const giveUpMs = Number(env.ZCODE_EXECUTOR_OFFPEAK_STATUS_GIVEUP_MS) || DEFAULT_STATUS_GIVEUP_MS;
  let auth = null;
  let server = null;
  let readyFile = null; // awaitReady 放行的那个队列文件；内层循环只开跑它
  const loadAuth = () => (auth ??= readOffPeakAuth({ env }));
  const serverClient = () => (server ??= createOffPeakClient({ auth: loadAuth(), env }));
  const write = (patch) => writeOffPeak(home, sessionId, patch);
  const event = (type, extra) => appendEvent(eventsPath, { type, at: now(), ...extra });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * 结算这条闲时投递的号，offpeak.json 收成 done。offpeak.json 属于另一次投递（offPeakId 对不上）时什么都不碰：
   * 那个号不是这条投递的。结算失败只记 settleError 并打一行 stderr。
   */
  async function settle(item) {
    const op = readOffPeak(home, sessionId);
    if (!op || op.offPeakId !== item.offpeak?.offPeakId) return;
    if (!op.ticketId) {
      write({ phase: 'done' });
      return;
    }
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

  // 闲时投递以 failed 终局：落盘同普通回合（writeFailedLast），先出队再结算
  async function fail(queueFile, item, reason) {
    writeFailedLast(dir, { reason, text: item.text, task: item.task });
    updateSession(home, sessionId, { lastOutcome: 'failed' });
    removeFileIfExists(queueFile);
    await settle(item);
    return false;
  }

  /**
   * 队列里只要有闲时项就先读凭据，这条连接的 secrets 才一定带 JWT 与 key。
   * 队列头是闲时项时按 nextPollMs（封顶 pollCapMs）轮询到号就绪，期间不起 app-server（SPEC-offpeak B.1）：
   * 查排位暂时不可用按封顶间隔重试（连续超过 giveUpMs 放弃），接口变了、不适用立刻放弃。
   * 返回 true 表示可以起连接；false 表示这条已按 failed 结束并出队，或队列项已被 cancel 删掉。
   * 号已是 active（上个 runner 开跑后中途退出）也当就绪。
   */
  async function awaitHead(queueDir) {
    if (queuedOffPeakIds(queueDir).length > 0) loadAuth();
    const queueFile = nextQueueFile(queueDir);
    const item = queueFile ? readJsonOrNull(queueFile) : null;
    if (!item?.offpeak) return true;
    const op = readOffPeak(home, sessionId);
    if (!op?.ticketId || op.offPeakId !== item.offpeak.offPeakId) {
      return fail(queueFile, item, `offpeak.json 与队列里的闲时投递 ${item.offpeak.offPeakId} 对不上，号找不到了。重新 send --offpeak`);
    }
    if (auth.error) return fail(queueFile, item, `闲时凭据读不了：${auth.error}`);
    let failingSince = null;
    for (;;) {
      // 权宜：排号中被 cancel（队列项没了）就收摊，号不结算，OP6 的 cancel 接手
      if (!existsSync(queueFile)) return false;
      let res;
      try {
        res = await serverClient().status([op.ticketId]);
        failingSince = null;
      } catch (err) {
        if (!(err instanceof ExecutorError)) throw err;
        if (err.details?.kind !== 'unavailable') return fail(queueFile, item, `等号时查排位失败：${err.message}`);
        failingSince ??= Date.now();
        if (Date.now() - failingSince > giveUpMs) {
          return fail(queueFile, item, `等号时查排位连续失败超过 ${Math.round(giveUpMs / 1000)} 秒：${err.message}`);
        }
        process.stderr.write(`runner: 等号时查排位暂时失败，${pollCapMs} 毫秒后重试：${err.message}\n`);
        await sleep(pollCapMs);
        continue;
      }
      const ticket = res.tickets.find((t) => t.ticketId === op.ticketId);
      const state = ticket?.state ?? 'not_found';
      if (state === 'ready' || state === 'active') {
        write({ phase: 'ready', position: null, readyDeadline: iso(ticket.readyDeadline) ?? op.readyDeadline, activeDeadline: iso(ticket.activeDeadline) });
        event('executor.offpeak.ready', { offPeakId: op.offPeakId, ticketId: op.ticketId });
        readyFile = queueFile;
        return true;
      }
      if (state === 'expired') return fail(queueFile, item, `闲时号 ${op.ticketId} 在开跑前过期了（expired）`);
      if (state !== 'queued') return fail(queueFile, item, `闲时号 ${op.ticketId} 服务器那边查不到了（${state}）`);
      write({ position: ticket.position });
      await sleep(Math.min(res.nextPollMs, pollCapMs));
    }
  }

  return {
    /** 当前已读到的闲时凭据（JWT、plan key），没读过或读失败是空数组。交给 spawn 与 attachSession 的 secrets。 */
    secrets: () => (auth && !auth.error ? [auth.jwt, auth.planKey] : []),

    /** 这个队列文件是不是 awaitReady 刚放行的闲时项。 */
    isReady: (queueFile) => queueFile === readyFile,

    /**
     * 外层起连接之前调：队列头等不到号的一条条按 failed 出队，直到队列头可以开跑（返回 true）或队列空了（返回 false）。
     */
    async awaitReady(queueDir) {
      while (!(await awaitHead(queueDir))) {
        if (!nextQueueFile(queueDir)) return false;
      }
      return true;
    },

    /**
     * 连接起好后、session/send 之前（SPEC-offpeak B.2）：推 provider/updateAccountConfig，拼闲时回合的 send 额外参数，
     * offpeak.json 进 running、记 executor.offpeak.started。返回 extraParams；推送报错或回执 revision 对不上时这条按
     * failed 结束并出队，返回 null（回执 unchanged 不算失败）。
     */
    async prepareSend({ client, item, entry, providerObj, queueFile }) {
      const op = readOffPeak(home, sessionId);
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

    /** 回合照普通回合结算、出队之后（SPEC-offpeak B.4）：结算这条投递的号。 */
    settle,
  };
}
