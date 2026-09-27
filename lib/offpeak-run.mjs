// 本文件负责：闲时投递（SPEC-offpeak A、B、E，decisions D20）在工作流层的部分——
// send --offpeak 的前置条件与当场取号（takeOffPeak），runs/<id>/offpeak.json 的读写（readOffPeak），
// 闲时投递期间挡普通 send 的判据（offPeakBlocks），以及 runner 的闲时部分（createOffPeakRunner：
// 等号就绪、号失效重取（SPEC-offpeak C）、推授权并拼 send 额外参数（首跑或续跑）、结算号与结算重试）。
// 不负责：命令行解析与打印（lib/cli/send.mjs）、runner 的其余一生（lib/run.mjs 只在几处调这里）、
// 闲时服务器请求本身（lib/offpeak.mjs）、授权配置与 send 参数的形状（协议层 lib/offpeak-provider.mjs）、
// 凭据解密（lib/credentials.mjs）。排号中 cancel、caffeinate 与排号显示不在这里（后续任务 OP6）。
// 和谁打交道：lib/credentials.mjs、lib/offpeak.mjs、lib/offpeak-provider.mjs、lib/queue.mjs、lib/runs.mjs、
// lib/registry.mjs、lib/tiers.mjs、lib/models.mjs（取号前核对 provider 表），协议层 lib/appserver.mjs 只用来定位内置 provider 文件。
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
import { loadZcodeConfig } from './models.mjs';

const DEFAULT_POLL_CAP_MS = 60000; // 轮询间隔封顶（SPEC-offpeak B.1），测试用 ZCODE_EXECUTOR_OFFPEAK_POLL_MS 压短
// 等号时查排位连续「暂时不可用」多久才放弃；测试用 ZCODE_EXECUTOR_OFFPEAK_STATUS_GIVEUP_MS 压短
const DEFAULT_STATUS_GIVEUP_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TICKETS = 3; // 一次投递最多用 3 个号（重取 2 次），就绪前过期与运行中失效共用（SPEC-offpeak C）
// 回合以这几个错误码失败 = 号过期或无效，要重取（verified.md「闲时任务探针」错误码一行：3102/3001 票过期；3104 号无效）
const TICKET_LOST_CODES = new Set(['3102', '3104', '3001']);
const SETTLE_RETRIES = 3; // 结算失败退避重试次数（SPEC-offpeak B.4），间隔 1、2、4 秒
// 结算重试的起始间隔，之后每次翻倍；测试用 ZCODE_EXECUTOR_OFFPEAK_SETTLE_RETRY_MS 压短
const DEFAULT_SETTLE_RETRY_MS = 1000;
// 续跑提示：App 原文照抄，一个字不改（verified.md「闲时任务探针」错误码一行）
const RESUME_PROMPT = 'Continue the previous task from where it left off. The run was interrupted (app restart or execution window expired). '
  + 'Do not start over; review what has already been done and complete the remaining work.';

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
 * 发一个闲时服务器请求；401/403（JWT 失效）时重读一次凭据，JWT 变了就换新凭据重试一次（OP4 评审 M5：
 * 用户在 App 里重新登录过）。没变、重读失败或重试仍失败按原错误抛。返回 {result, auth}，auth 是最后用的那份凭据。
 */
async function requestWithAuth(auth, env, fn) {
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
 * runner 的闲时部分（SPEC-offpeak B、C）。每个 runner 建一个；队列里一出现闲时项就读一次凭据，之后这个 runner 的
 * 连接都把 JWT 与 plan key 放进 secrets（401 后换上的新 JWT 也进，见 call）。普通队列项不经过这里的任何方法。
 * 号失效（就绪前 expired / not_found，回合以 3102 / 3104 / 3001 失败）用同一个 offPeakId 重取，一次投递最多 MAX_TICKETS 个号。
 * 号用完、重取被拒、查排位失败、推授权失败一律把这条投递按 failed 结束：写 last.json、executor.result、
 * 登记簿 lastOutcome，删队列项，再结算当前号。
 */
export function createOffPeakRunner({ home, sessionId, env = process.env }) {
  const dir = runsDirOf(home, sessionId);
  const eventsPath = path.join(dir, 'events.jsonl');
  const pollCapMs = Number(env.ZCODE_EXECUTOR_OFFPEAK_POLL_MS) || DEFAULT_POLL_CAP_MS;
  const giveUpMs = Number(env.ZCODE_EXECUTOR_OFFPEAK_STATUS_GIVEUP_MS) || DEFAULT_STATUS_GIVEUP_MS;
  const settleRetryMs = Number(env.ZCODE_EXECUTOR_OFFPEAK_SETTLE_RETRY_MS) || DEFAULT_SETTLE_RETRY_MS;
  let auth = null;
  const seenSecrets = new Set(); // 读到过的全部 JWT 与 plan key：401 后换了新 JWT，旧的照样抹
  let readyFile = null; // awaitReady 放行的那个队列文件；内层循环只开跑它
  let resume = false; // 放行的这一项该发续跑提示（号已 active，或这次投递开跑过）
  const failedSettles = new Set(); // 这个 runner 里结算失败过的号：不再整轮退避重试（OP5 评审 M5）
  const remember = (a) => {
    if (!a.error) [a.jwt, a.planKey].forEach((v) => seenSecrets.add(v));
    return a;
  };
  const loadAuth = () => (auth ??= remember(readOffPeakAuth({ env })));
  const write = (patch) => writeOffPeak(home, sessionId, patch);
  const event = (type, extra) => appendEvent(eventsPath, { type, at: now(), ...extra });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // cancel 先写 stop 与 cancel 标记再清队列：任一出现，或队列项已被删，都算这条投递被叫停
  const stopRequested = (queueFile) => !existsSync(queueFile) || ['stop', 'cancel'].some((f) => existsSync(path.join(dir, f)));

  /** 发一个闲时服务器请求；401/403 时重读凭据重试一次，换上的新凭据留给之后的请求与连接（requestWithAuth）。 */
  async function call(fn) {
    if (loadAuth().error) throw new ExecutorError(`闲时凭据读不了：${auth.error}`, 2);
    const res = await requestWithAuth(auth, env, fn);
    auth = remember(res.auth);
    return res.result;
  }

  /**
   * 结算 op 的当前号（SPEC-offpeak B.4）：失败按 1、2、4 倍间隔退避重试 retries 次，仍失败把号记进 offpeak.json 的
   * unsettledTickets（{ticketId, error, at}，I1）、stderr 一行；这个 runner 里失败过的号不再结算（M5）。
   * 成功记 settledAt、executor.offpeak.settled，并把这个号从 unsettledTickets 里拿掉。
   */
  async function settleTicket(op, { retries = SETTLE_RETRIES } = {}) {
    if (failedSettles.has(op.ticketId)) return;
    const unsettled = () => readOffPeak(home, sessionId)?.unsettledTickets ?? [];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await call((client) => client.settle(op.ticketId));
        write({ settledAt: iso(res.settledAt) ?? now(), unsettledTickets: unsettled().filter((u) => u.ticketId !== op.ticketId) });
        event('executor.offpeak.settled', { offPeakId: op.offPeakId, ticketId: op.ticketId, state: res.state });
        return;
      } catch (err) {
        if (!(err instanceof ExecutorError)) throw err;
        if (attempt < retries) {
          await sleep(settleRetryMs * 2 ** attempt);
          continue;
        }
        failedSettles.add(op.ticketId);
        write({ unsettledTickets: [...unsettled().filter((u) => u.ticketId !== op.ticketId), { ticketId: op.ticketId, error: err.message, at: now() }] });
        process.stderr.write(`runner: 闲时号 ${op.ticketId} 结算失败：${err.message}\n`);
        return;
      }
    }
  }

  /**
   * 投递终局：结算当前号，offpeak.json 收成 done。offpeak.json 属于另一次投递（offPeakId 对不上）时什么都不碰：
   * 那个号不是这条投递的。当前号已经结算过（运行中失效先结算了旧号、重取却没成）不再发请求，结算失败过的也不再重试。
   */
  async function settle(item) {
    const op = readOffPeak(home, sessionId);
    if (!op || op.offPeakId !== item.offpeak?.offPeakId) return;
    if (op.ticketId && !op.settledAt) await settleTicket(op);
    write({ phase: 'done' });
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
   * 用同一个 offPeakId 重取号（SPEC-offpeak C），旧号的结算归调用方。成功返回 null：offpeak.json 换成新号、ticketCount
   * 加 1、phase 回到 queued、settledAt 清空，记 executor.offpeak.retaken。号用完或服务器拒了返回失败原因。
   */
  async function retake(item, reason) {
    const op = readOffPeak(home, sessionId);
    if (op?.offPeakId !== item.offpeak.offPeakId) {
      return `offpeak.json 与队列里的闲时投递 ${item.offpeak.offPeakId} 对不上，号找不到了。重新 send --offpeak`;
    }
    const count = op.ticketCount ?? 1;
    if (count >= MAX_TICKETS) return `闲时号用完了（共 ${MAX_TICKETS} 个）`;
    let ticket;
    try {
      ticket = await call((client) => client.take(op.offPeakId));
    } catch (err) {
      if (!(err instanceof ExecutorError)) throw err;
      return `重取闲时号失败：${err.message}`;
    }
    write({
      ticketId: ticket.ticketId,
      ticketCount: count + 1,
      phase: 'queued',
      position: ticket.position,
      readyDeadline: iso(ticket.readyDeadline),
      activeDeadline: null,
      settledAt: null,
    });
    event('executor.offpeak.retaken', { offPeakId: op.offPeakId, oldTicketId: op.ticketId, ticketId: ticket.ticketId, reason, ticketCount: count + 1 });
    return null;
  }

  /**
   * 队列里只要有闲时项就先读凭据，这条连接的 secrets 才一定带 JWT 与 key。
   * 队列头是闲时项时按 nextPollMs（封顶 pollCapMs）轮询到号就绪，期间不起 app-server（SPEC-offpeak B.1）：
   * 查排位暂时不可用按封顶间隔重试（连续超过 giveUpMs 放弃），接口变了、不适用立刻放弃；号 expired / not_found 重取。
   * 返回 true 表示可以起连接；false 表示这条已按 failed 结束并出队，或队列项已被 cancel 删掉。
   * 号已是 active（上个 runner 开跑后中途退出）也当就绪。
   */
  async function awaitHead(queueDir) {
    if (queuedOffPeakIds(queueDir).length > 0) loadAuth();
    const queueFile = nextQueueFile(queueDir);
    const item = queueFile ? readJsonOrNull(queueFile) : null;
    if (!item?.offpeak) return true;
    let op = readOffPeak(home, sessionId);
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
        res = await call((client) => client.status([op.ticketId]));
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
        // 号已 active，或这次投递开跑过（回合 exited 后重投、号失效重取后）：续跑，不重发原文（OP4 评审 M4）
        resume = state === 'active' || Boolean(op.startedAt);
        return true;
      }
      if (state === 'expired' || state === 'not_found') {
        // 过期的号结算一次、不重试（verified.md「闲时任务探针」：已过期的号 settle 仍回 200）；not_found 没有可结算的（OP5 评审 M1）
        if (state === 'expired') await settleTicket(op, { retries: 0 });
        const why = await retake(item, state);
        if (why) return fail(queueFile, item, why);
        op = readOffPeak(home, sessionId);
        continue;
      }
      if (state !== 'queued') return fail(queueFile, item, `闲时号 ${op.ticketId} 的状态是 ${state}，等不到就绪`);
      write({ position: ticket.position });
      await sleep(Math.min(res.nextPollMs, pollCapMs));
    }
  }

  return {
    /** 读到过的闲时凭据（JWT、plan key，含 401 后换上的新 JWT），没读过或读失败是空数组。交给 spawn 与 attachSession 的 secrets。 */
    secrets: () => [...seenSecrets],

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
     * offpeak.json 进 running、记 executor.offpeak.started。返回 {extraParams, onAccepted, sendText?}：续跑时 sendText 是
     * 续跑提示，runType 为 resume（SPEC-offpeak B.3，续跑不重复发原文）；onAccepted 交给 session.send，session/send 被
     * 接受后才记 startedAt——被拒的原文不算开跑过，重投时照发原文（OP5 评审 M6）。推送报错或回执 revision 对不上时
     * 这条按 failed 结束并出队，返回 null（回执 unchanged 不算失败）。
     */
    async prepareSend({ client, item, entry, providerObj, queueFile }) {
      const op = readOffPeak(home, sessionId);
      const runType = resume ? 'resume' : 'init';
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
          runType,
          toolDenylist: entry.toolDenylist ?? [],
        });
      } catch (err) {
        if (!(err instanceof ExecutorError)) throw err;
        await fail(queueFile, item, `闲时授权没推成：${err.message}`);
        return null;
      }
      write({ phase: 'running' });
      event('executor.offpeak.started', { offPeakId: op.offPeakId, ticketId: op.ticketId, runType });
      const onAccepted = () => {
        if (!op.startedAt) write({ startedAt: now() });
      };
      return { extraParams, onAccepted, ...(resume ? { sendText: RESUME_PROMPT } : {}) };
    },

    /**
     * 闲时回合结束、写结果之前（SPEC-offpeak B.3、C）。回合不是以号失效的错误码失败时返回 null，照普通回合结算。
     * 号失效时先结算旧号再重取：
     * - 'retaken'：重取成了，队列项写回（这次取出不算重投），run.mjs 回外层等新号后续跑；
     * - 'failed'：号用完或重取被拒，这条已按 failed 结束并出队（结算过当前号）；
     * - 'cancelled'：进来时、结算旧号后、取号后任一刻见到 cancel/stop 标记或队列项没了（OP5 评审 C2）——不再重取、
     *   不写回队列，run.mjs 照 cancelled 收尾，收尾时结算当前号（取到了新号就是新号）。
     */
    async afterTurn({ outcome, item, queueFile }) {
      if (outcome.outcome !== 'failed' || !TICKET_LOST_CODES.has(outcome.errorCode)) return null;
      if (stopRequested(queueFile)) return 'cancelled';
      readyFile = null;
      const op = readOffPeak(home, sessionId);
      if (op?.ticketId && op.offPeakId === item.offpeak.offPeakId) await settleTicket(op);
      if (stopRequested(queueFile)) return 'cancelled';
      const why = await retake(item, outcome.errorCode);
      if (stopRequested(queueFile)) return 'cancelled';
      if (why) {
        await fail(queueFile, item, why);
        return 'failed';
      }
      // 撤销本次取出时加的计数：号失效不是子进程退出，不该吃掉重投次数
      writeJsonAtomic(queueFile, { ...item, attempts: (item.attempts ?? 1) - 1 });
      return 'retaken';
    },

    /** 回合照普通回合结算、出队之后（SPEC-offpeak B.4）：结算这条投递的号。 */
    settle,
  };
}
