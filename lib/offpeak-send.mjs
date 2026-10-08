// 本文件负责：闲时投递（SPEC-offpeak A、E，decisions D20）在 CLI 一侧的工作流部分——
// send --offpeak 的前置条件与当场取号（takeOffPeak），runs/<id>/offpeak.json 的读写（readOffPeak、writeOffPeak），
// 闲时投递期间挡普通 send 的判据（offPeakBusy、offPeakBlocks）、孤儿号收尾（settleOrphan）与 --resume 的判据（offPeakResumable），runner 不在时由 CLI 结算没收尾的号（settleLeftover、cancelLeftover），以及 CLI 与 runner 共用的两件小事：
// 队列里有哪些闲时项（queuedOffPeakIds）、401/403 时重读凭据重试一次（requestWithAuth）；
// 还有 quota 命令的取数（offPeakQuota：今天本工具取过几次号 + 服务器现在能不能取）。
// 不负责：命令行解析与打印（lib/cli/send.mjs、lib/cli/quota.mjs）、runner 的闲时部分（lib/offpeak-run.mjs 的 createOffPeakRunner）、
// 闲时服务器请求本身（lib/offpeak.mjs）、授权配置与 send 参数的形状（协议层 lib/offpeak-provider.mjs）、凭据解密（lib/credentials.mjs）。
// 和谁打交道：lib/cli/send.mjs、lib/cli/cancel.mjs 与 lib/cli/quota.mjs（调用方）、lib/offpeak-run.mjs（用这里的读写与请求助手），lib/credentials.mjs、lib/offpeak.mjs、
// lib/offpeak-provider.mjs、lib/queue.mjs、lib/runs.mjs、lib/registry.mjs、lib/models.mjs（取号前核对 provider 表），
// 协议层 lib/appserver.mjs 只用来定位内置 provider 文件。
//
// 安全边界（RULES §8，D20）：JWT 与 plan key 只进内存与请求头；offpeak.json、事件、错误文案里都不带。
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
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
import { appendEvent, ensureRunsDir, livePidOf, readJsonOrNull, runsDirOf, snapshotTask, writeEndedLast } from './runs.mjs';
import { updateSession } from './registry.mjs';
import { loadZcodeConfig } from './models.mjs';

/** offpeak.json 的 phase 在这几个值时，这条会话被闲时投递占着（SPEC-offpeak A.1「闲时投递独占空闲会话」）。 */
export const BUSY_PHASES = new Set(['queued', 'ready', 'running']);
/** 一次投递最多用 3 个号（重取 2 次），就绪前过期与运行中失效共用（SPEC-offpeak C）；status 显示「第 k/3 个号」也用它。 */
export const MAX_TICKETS = 3;

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
export function queuedOffPeakIds(queueDir) {
  if (!existsSync(queueDir)) return [];
  return readdirSync(queueDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJsonOrNull(path.join(queueDir, f))?.offpeak?.offPeakId)
    .filter(Boolean);
}

/**
 * 这条会话是不是被一次闲时投递占着：offpeak.json 的 phase 没收尾，而且队列里还有这次闲时投递的项，或者活着的 runner
 * 正是 offpeak.json 记下的那个（runnerPid，runner 接手闲时项时写）——才算，返回 offpeak.json。否则返回 null：没有闲时投递，
 * 或是孤儿记录（队列里没有它的项，也没有在处理它的 runner；普通投递的 runner 活着不算，OP6 评审 I2）。
 * 孤儿号由 cancel、下一次 send（settleOrphan）或 runner 收场（wrapUp）结算。
 */
export function offPeakBusy(home, sessionId) {
  const op = readOffPeak(home, sessionId);
  if (!BUSY_PHASES.has(op?.phase)) return null;
  if (queuedOffPeakIds(path.join(runsDirOf(home, sessionId), 'queue')).includes(op.offPeakId)) return op;
  const pid = livePidOf(home, sessionId);
  return pid && op.runnerPid === pid ? op : null;
}

/**
 * 普通 send 入队前（与 send --offpeak 取号前）：没有活 runner、队列里没有它的项、offpeak.json 却没收尾的孤儿号，
 * 先结算掉（settleLeftover，best effort，失败 stderr 一行）。不是孤儿返回 null。
 */
export async function settleOrphan({ home, sessionId, env = process.env, cmd }) {
  const op = readOffPeak(home, sessionId);
  if (!BUSY_PHASES.has(op?.phase) || livePidOf(home, sessionId)) return null;
  if (queuedOffPeakIds(path.join(runsDirOf(home, sessionId), 'queue')).includes(op.offPeakId)) return null;
  return settleLeftover({ home, sessionId, env, cmd });
}

/**
 * send --offpeak --resume 能不能接着跑（回合 exited 或 runner 崩了之后）：runner 不在，队列头是 offpeak.json 这次投递的闲时项。
 * 能接着跑返回 {offPeakId, item}（item 是队列头那一项），不能返回 {reason}（给人看的原因）。
 */
export function offPeakResumable(home, sessionId) {
  const pid = livePidOf(home, sessionId);
  if (pid) return { reason: `这条会话的 runner 还活着（pid ${pid}），闲时投递没断，不用恢复：status 看进度` };
  const op = readOffPeak(home, sessionId);
  if (!BUSY_PHASES.has(op?.phase)) return { reason: '这条会话没有没收尾的闲时投递，没什么可恢复的：要新投递就 send --offpeak' };
  const queueDir = path.join(runsDirOf(home, sessionId), 'queue');
  const head = existsSync(queueDir) ? nextQueueFile(queueDir) : null;
  const item = head ? readJsonOrNull(head) : null;
  if (item?.offpeak?.offPeakId !== op.offPeakId) {
    return { reason: `队列头不是闲时投递 ${op.offPeakId} 的项（队列空了或排着别的投递），没法恢复：status 看现状，或 cancel 收掉这个号` };
  }
  return { offPeakId: op.offPeakId, item };
}

/** runner 不在、闲时投递没收尾时给人的提示：怎么恢复。以「投递」开头，调用方按语境在前面加「闲时」或「闲时：」。 */
export const resumeHint = (sessionId, offPeakId) =>
  `投递 ${offPeakId} 没收尾，runner 已不在：用 send ${sessionId} --offpeak --resume 接着跑，或 cancel 收掉这个号`;

/**
 * 普通 send / --steer 在闲时投递期间能不能进：能进返回 null，不能进返回拒绝原因（退出码 2 由调用方抛）。
 * 占用判定见 offPeakBusy。runner 已不在而能恢复时，原因里提示 --offpeak --resume 或 cancel。
 * 插话只影响当前回合，所以回合开跑（phase running）后放行 --steer；排号中（queued / ready）回合还没开始，插不了。
 */
export function offPeakBlocks(home, sessionId, { steer = false } = {}) {
  const op = offPeakBusy(home, sessionId);
  if (!op) return null;
  const resumable = offPeakResumable(home, sessionId);
  if (!resumable.reason) return `这条会话的闲时${resumeHint(sessionId, resumable.offPeakId)}`;
  if (steer && op.phase === 'running') return null;
  if (steer) return '闲时投递还在排号，回合没开跑，插不了话。等它开跑后再 --steer，或先 cancel';
  return '这条会话有闲时投递在排号或运行，先 cancel 或另开会话';
}

/**
 * 发一个闲时服务器请求；401/403（JWT 失效）时重读一次凭据，JWT 变了就换新凭据重试一次（OP4 评审 M5：
 * 用户在 App 里重新登录过）。没变、重读失败或重试仍失败按原错误抛。返回 {result, auth}，auth 是最后用的那份凭据。
 */
export async function requestWithAuth(auth, env, fn) {
  try {
    return { result: await fn(createOffPeakClient({ auth, env })), auth };
  } catch (err) {
    if (!(err instanceof ExecutorError) || ![401, 403].includes(err.details?.httpStatus)) throw err;
    const fresh = readOffPeakAuth({ env });
    if (fresh.error || fresh.jwt === auth.jwt) throw err;
    return { result: await fn(createOffPeakClient({ auth: fresh, env })), auth: fresh };
  }
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
    const resumable = offPeakResumable(home, sessionId);
    if (!resumable.reason) throw new ExecutorError(`这条会话的闲时${resumeHint(sessionId, resumable.offPeakId)}`, 2);
    throw new ExecutorError('闲时投递要会话空闲（没有在跑的 runner、队列为空）：等当前投递结束（status 看进度）再投，或另开会话', 2);
  }
  // 取号前先确认会话的 provider 还在（OP4 评审 M9）：不在的话号取了也跑不了，白白用掉一次免费取号
  const { registry } = loadZcodeConfig(env.ZCODE_CONFIG_PATH);
  if (!registry.providers.some((p) => p.providerId === entry.provider)) {
    throw new ExecutorError(
      `登记簿里的 provider ${entry.provider} 已不在 provider 表里（账号型登出、或 config.json 变了）。重跑 zcode-executor models 看现在有哪些，再 new 一条会话`,
      2,
    );
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

  // 任务单读不了也在取号之前报：入队时要读它留快照（lib/queue.mjs，审计 D3），号取了再发现读不了就白用一次。
  // 这里先留一份，读不了抛 ExecutorError(1)；入队时照常再留（内容没变就是同一个文件）
  if (task) snapshotTask(ensureRunsDir(home, sessionId), task);

  // 孤儿号（上一次闲时投递没收尾，而上面已确认 runner 不在、队列为空）：先结算旧号再取新号，失败只记一行（best effort）
  await settleOrphan({ home, sessionId, env, cmd: 'send' });

  // 一次投递一个 offPeakId，重取号不换（SPEC-offpeak A.2）
  const offPeakId = `offpeak-${randomUUID()}`;
  const { result: ticket } = await requestWithAuth(auth, env, (client) => client.take(offPeakId));
  // 整份覆盖，不和旧文件合并：上一次投递的 startedAt、未结算记录不能带进这一次（OP5 评审 C1）
  writeJsonAtomic(offPeakPath(home, sessionId), {
    offPeakId,
    ticketId: ticket.ticketId,
    ticketCount: 1,
    phase: 'queued',
    position: ticket.position,
    readyDeadline: iso(ticket.readyDeadline),
    activeDeadline: null,
    startedAt: null,
    settledAt: null,
    unsettledTickets: [],
    updatedAt: now(),
  });
  enqueue(home, sessionId, { text, task, timeoutSec, offpeak: { offPeakId } });
  // quota 靠这条事件数今天取过几次号：上面写 offpeak.json 或入队抛错时它不会写，那次取号少算（只少不多）
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
 * runner 不在时由 CLI 收掉一次没收尾的闲时投递的号（cancel、send --offpeak 前的孤儿号）：offpeak.json 的 phase 不是 done
 * 就对当前号结算一次（不退避重试：人等着命令返回），失败把号记进 unsettledTickets、stderr 一行（以 cmd 开头）；然后收成 done。
 * 没有要收的（没有 offpeak.json 或已是 done）、或结算期间 offpeak.json 换成了别的投递（不回写）返回 null，
 * 否则返回 {op: 收尾前的 offpeak.json, settled}。
 */
export async function settleLeftover({ home, sessionId, env = process.env, cmd }) {
  const op = readOffPeak(home, sessionId);
  if (!op || op.phase === 'done') return null;
  let settled = Boolean(op.settledAt);
  // 结算要走网络，这期间 offpeak.json 可能已被新的闲时投递整份覆盖：每次回写前重读，offPeakId 对不上就放弃（OP6 评审 M1）
  const stillOurs = () => readOffPeak(home, sessionId)?.offPeakId === op.offPeakId;
  if (op.ticketId && !settled) {
    const auth = readOffPeakAuth({ env });
    let error = auth.error ? `闲时凭据读不了：${auth.error}` : null;
    if (!error) {
      try {
        const { result } = await requestWithAuth(auth, env, (client) => client.settle(op.ticketId));
        if (!stillOurs()) return null;
        const unsettled = (op.unsettledTickets ?? []).filter((u) => u.ticketId !== op.ticketId);
        writeOffPeak(home, sessionId, { settledAt: iso(result.settledAt) ?? now(), unsettledTickets: unsettled });
        appendEvent(path.join(runsDirOf(home, sessionId), 'events.jsonl'), {
          type: 'executor.offpeak.settled', at: now(), offPeakId: op.offPeakId, ticketId: op.ticketId, state: result.state,
        });
        settled = true;
      } catch (err) {
        if (!(err instanceof ExecutorError)) throw err;
        error = err.message;
      }
    }
    if (error) {
      if (!stillOurs()) return null;
      const unsettled = (op.unsettledTickets ?? []).filter((u) => u.ticketId !== op.ticketId);
      writeOffPeak(home, sessionId, { unsettledTickets: [...unsettled, { ticketId: op.ticketId, error, at: now() }] });
      process.stderr.write(`${cmd}: 闲时号 ${op.ticketId} 结算失败：${error}\n`);
    }
  }
  if (!stillOurs()) return null;
  writeOffPeak(home, sessionId, { phase: 'done' });
  return { op, settled };
}

/**
 * cancel 时 runner 已不在（SPEC-offpeak D）：结算没收尾的闲时投递的号（settleLeftover），cancel 清掉的队列项里有这次
 * 闲时投递的项（投递还没结局，比如回合 exited 后）就以 cancelled 结束：写 last.json、executor.result、登记簿 lastOutcome。
 * 投递已经有结局、只差结算的（runner 写完结果在结算前被杀）不改写 last.json。返回同 settleLeftover。
 */
export async function cancelLeftover({ home, sessionId, dropped, env = process.env }) {
  const res = await settleLeftover({ home, sessionId, env, cmd: 'cancel' });
  const item = res && dropped.find((it) => it?.offpeak?.offPeakId === res.op.offPeakId);
  if (item) {
    writeEndedLast(runsDirOf(home, sessionId), { outcome: 'cancelled', reason: '已被 cancel 叫停', text: item.text, task: item.task });
    updateSession(home, sessionId, { lastOutcome: 'cancelled' });
  }
  return res;
}

/**
 * 每天约几次免费取号。权宜：来自一天的观察（verified.md「闲时任务探针」免费取号额度，2026-09-28：取 3 次后第 4 次回 3103），
 * 服务器不给剩余次数；观察到别的值再改。
 */
export const OFFPEAK_ESTIMATED_DAILY_LIMIT = 3;
const TAKE_EVENTS = new Set(['executor.offpeak.taken', 'executor.offpeak.retaken']);

/**
 * quota（SPEC-offpeak G）：零额度查今天的闲时取号情况——本工具今天取过几次号（数 runs 下各会话 events.jsonl 里机器本地今天的
 * taken 与 retaken；App 里用的看不到），加上服务器「现在能不能取」。不起 app-server、不取号。
 * state 照 doctor ⑤ 的四态口径：凭据按 readOffPeakAuth 的 kind，服务器按客户端错误的 details.kind。
 * 权宜：日界用机器本地日期，服务器的日界若不同会有偏差。只少不多：取号成功后写 offpeak.json 或入队失败时
 * （takeOffPeak），taken 事件不会写，这次取号不计入。
 * @param {object} options
 * @param {(line: string) => void} [options.warn] 某个 events.jsonl 读不了时说一行（跳过它，不算失败）
 * @returns {Promise<{usedToday: number, estimatedDailyLimit: number, canTakeNumber: boolean|null, nextTakeAt: string|null,
 *   state: 'ok'|'unavailable'|'not-applicable'|'changed', reason: string|null}>}
 */
export async function offPeakQuota({ home, env = process.env, fetchImpl, warn = () => {} }) {
  const result = {
    usedToday: await countTakesToday(home, warn),
    estimatedDailyLimit: OFFPEAK_ESTIMATED_DAILY_LIMIT,
    canTakeNumber: null,
    nextTakeAt: null,
    state: 'ok',
    reason: null,
  };
  const auth = readOffPeakAuth({ env });
  if (auth.error) return { ...result, state: auth.kind, reason: auth.error };
  try {
    // 3 秒：quota 是派单前顺手查的，别让它拖住派单
    const a = await createOffPeakClient({ auth, env, fetchImpl, timeoutMs: 3000 }).availability();
    return { ...result, canTakeNumber: a.canTakeNumber, nextTakeAt: iso(a.nextTakeAt) };
  } catch (err) {
    const kind = err?.details?.kind;
    if (kind === undefined) throw err; // 闲时服务地址配错之类的用法错，照常退出码 1
    // 资格接口万一回 3103：约定没变，就是现在不能取
    if (kind === 'quota') return { ...result, canTakeNumber: false, nextTakeAt: iso(err.details.nextTakeAt) };
    return { ...result, state: kind, reason: err.message };
  }
}

/**
 * 数 runs 下各会话 events.jsonl 里本地今天 0 点以后的 taken 与 retaken。runs 可能有几 GB：
 * 修改时间早于今天 0 点的文件整个跳过（事件只追加，旧文件里不会有今天的事件）；其余逐行流式读，
 * 行里带 "executor.offpeak. 才解析，坏行跳过。读不了的文件（权限等）跳过并 warn 一行。
 */
async function countTakesToday(home, warn) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(); // 本地 0 点
  const runsDir = path.join(home, 'runs');
  const ids = existsSync(runsDir) ? readdirSync(runsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
  let count = 0;
  for (const id of ids) {
    const file = path.join(runsDir, id, 'events.jsonl');
    try {
      if (statSync(file).mtimeMs < startOfToday) continue;
      for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
        if (!line.includes('"executor.offpeak.')) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (TAKE_EVENTS.has(e?.type) && Date.parse(e.at) >= startOfToday) count += 1;
      }
    } catch (err) {
      if (err?.code === 'ENOENT') continue; // 会话还没投递过，没有事件文件
      warn(`跳过 ${file}（读不了：${err?.message ?? err}），今天的次数可能少算`);
    }
  }
  return count;
}
