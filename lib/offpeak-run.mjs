// 本文件负责：闲时投递（SPEC-offpeak A、B、E，decisions D20）在工作流层的部分——
// send --offpeak 的前置条件与当场取号（takeOffPeak），runs/<id>/offpeak.json 的读写（readOffPeak），
// 闲时投递期间挡普通 send 的判据（offPeakBlocks）。
// 不负责：命令行解析与打印（lib/cli/send.mjs）、runner 等号与结算（下一步加在这里）、
// 闲时服务器请求本身（lib/offpeak.mjs）、授权配置与 send 参数的形状（协议层 lib/offpeak-provider.mjs）、
// 凭据解密（lib/credentials.mjs）。重取号、cancel、caffeinate 与排号显示不在这里（后续任务 OP5、OP6）。
// 和谁打交道：lib/credentials.mjs、lib/offpeak.mjs、lib/offpeak-provider.mjs、lib/queue.mjs、lib/runs.mjs，
// 协议层 lib/appserver.mjs 只用来定位内置 provider 文件。
//
// 安全边界（RULES §8，D20）：JWT 与 plan key 只进内存与请求头；offpeak.json、事件、错误文案里都不带。
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';
import { writeJsonAtomic } from './config.mjs';
import { readOffPeakAuth } from './credentials.mjs';
import { createOffPeakClient } from './offpeak.mjs';
import { offPeakModelIds } from './offpeak-provider.mjs';
import { builtinProviderConfigPath, findZcode } from './appserver.mjs';
import { enqueue, nextQueueFile } from './queue.mjs';
import { appendEvent, livePidOf, readJsonOrNull, runsDirOf } from './runs.mjs';

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

