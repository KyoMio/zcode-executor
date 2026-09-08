// 本文件负责：在 AppServerClient 之上盖一层「会话」——接上一条已存在的会话（resume + subscribe）、
// 把本会话的事件原样落盘、投递一条消息并等回合结束、按结算规则算 outcome；对外给
// attachSession / Session（send、steer、stop、close）/ settleTurn 三个形状（T1.1，后续 runner 依赖）。
// 不负责：建会话（session/create 归工作流层）、runs 目录以外的路径约定（eventsPath 由调用者给）、
// CLI 退出码表（只透传子进程的原始退出信息）、审批与提问的挂起策略（handlers 没给就不答，T1.2 决定）。
// 被依赖方：工作流层 runner / CLI。只依赖 lib/errors.mjs、lib/appserver.mjs。
//
// 结算规则出处：docs/SPEC.md「工作流层·结算」——turn.completed → done；turn.failed → failed；
// 等待到点 → 发 session/stop，outcome timeout。事件形状见
// docs/reference/zcode-app-server-protocol.md「Event Types」。
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { ExecutorError } from './errors.mjs';

const TURN_END_TYPES = new Set(['turn.completed', 'turn.failed', 'turn.terminal']);
// 任务单：timeoutMs 到点发 session/stop，之后等回合结束事件最多 5 秒
const GRACE_AFTER_STOP_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 纯函数：本回合的事件数组 → {outcome, reason, lastText, usage}（SPEC「结算」）。
 * turn.completed → done（usage 取 payload.usage）；turn.failed → failed（reason 取 payload.error.message）；
 * turn.terminal 单独出现时按 status：success → done，其它 → failed；terminal 的 usage 按
 * 协议文档「turn.terminal」的扁平字段（inputTokens/outputTokens/totalTokens）拼出。
 * lastText = 本回合所有 model.streaming text_delta 的拼接。没有结束事件 → outcome null（调用方定夺）。
 */
export function settleTurn(events) {
  const lastText = events
    .filter((e) => e.type === 'model.streaming' && e.payload?.kind === 'text_delta')
    .map((e) => e.payload.delta ?? '')
    .join('');
  const completed = events.find((e) => e.type === 'turn.completed');
  const failed = events.find((e) => e.type === 'turn.failed');
  const terminal = events.find((e) => e.type === 'turn.terminal');
  if (completed) {
    return { outcome: 'done', reason: null, lastText, usage: completed.payload?.usage ?? null };
  }
  if (failed) {
    return { outcome: 'failed', reason: failed.payload?.error?.message ?? null, lastText, usage: failed.payload?.usage ?? null };
  }
  if (terminal) {
    const p = terminal.payload ?? {};
    const usage =
      p.totalTokens !== undefined ? { inputTokens: p.inputTokens, outputTokens: p.outputTokens, totalTokens: p.totalTokens } : null;
    if (p.status === 'success') {
      return { outcome: 'done', reason: null, lastText, usage };
    }
    return { outcome: 'failed', reason: `turn.terminal status=${p.status ?? 'unknown'}`, lastText, usage };
  }
  return { outcome: null, reason: null, lastText, usage: null };
}

/**
 * 接上一条已存在的会话：先建事件目录、装事件与反向请求路由（resume 期间来事件才接得住），
 * 再 resume（resume:false 跳过——刚 create 完的会话直接 subscribe，D13）→ subscribe → 返回 Session。
 * resume 失败 reject ExecutorError（details 带 error.data）。handlers 没给的反向请求
 * （permission/question）一律不应答——zcode 每秒重发、回合挂在原地，等上层闸门决定放行或转人工；
 * 其它反向请求走客户端默认（prefs 默认应答，未知回 -32601）。
 */
export async function attachSession({ client, sessionId, cwd, eventsPath, handlers = {}, onEvent, resume = true }) {
  mkdirSync(path.dirname(eventsPath), { recursive: true }); // 必须在装路由前：resume 期间来事件就要落盘
  const session = new Session(client, { sessionId, eventsPath, handlers, onEvent });
  const workspace = { workspacePath: cwd, workspaceKey: cwd };
  if (resume) await client.request('session/resume', { sessionId, workspace });
  await client.request('session/subscribe', {
    sessionId,
    deliveryKind: 'desktop-continuous',
    includeSnapshot: false,
    afterSeq: 0,
  });
  return session;
}

export class Session {
  #client;
  #sessionId;
  #eventsPath;
  #handlers;
  #onEvent;
  #turn = null; // 活动回合：{ events, onEnd, sawStarted, watermark, skip }
  #lastSeq = 0; // 会话内事件序号水位：send 起点记下来，迟到的旧时间线不进新回合

  constructor(client, { sessionId, eventsPath, handlers, onEvent }) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#eventsPath = eventsPath;
    this.#handlers = handlers;
    this.#onEvent = onEvent;
    this.#install();
  }

  get sessionId() {
    return this.#sessionId;
  }

  // 给 attachSession 装路由：构造时就要装好，resume 期间的事件才接得住
  #install() {
    this.#client.setHandlers({
      onServerRequest: (req) => this.#onServerRequest(req),
      onNotification: (n) => this.#onNotification(n),
    });
  }

  /**
   * 投递一条消息并等本回合结束。
   * @returns {Promise<{outcome:'done'|'failed'|'timeout'|'exited', reason:string|null, startedAt, endedAt, lastText:string, usage:object|null}>}
   */
  async send(text, { timeoutMs } = {}) {
    if (this.#turn) {
      throw new ExecutorError(`会话 ${this.#sessionId} 上一回合还没结束，不能再 send；回合中插话用 steer()`);
    }
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    const turn = { events: [], onEnd: null, sawStarted: false, watermark: this.#lastSeq, skip: false };
    const ended = new Promise((resolve) => {
      turn.onEnd = resolve;
    });
    this.#turn = turn;

    let timedOut = false;
    let graceDeadline = null;
    let exitInfo = null;
    let won = null;
    // 可取消的分支定时器：race 出口统一撤（T1.1b 第 1 条，写法同 appserver close()），
    // 不然回合早结束了进程还要空转到超时点
    let branchTimers = [];
    const after = (ms, value) =>
      new Promise((resolve) => {
        branchTimers.push(setTimeout(() => resolve(value), Math.max(0, ms)));
      });
    const cancelBranchTimers = () => {
      for (const t of branchTimers) clearTimeout(t);
      branchTimers = [];
    };

    try {
      // 发送本身失败：进程已退 → outcome exited；其余协议错误（如 prompt is running）原样抛给调用方
      try {
        await this.#client.request('session/send', { sessionId: this.#sessionId, content: text });
      } catch (err) {
        const dead = await Promise.race([this.#client.exited, Promise.resolve(null)]);
        if (dead) {
          return this.#settle(turn, { outcome: 'exited', reason: err.message, startedAt });
        }
        throw err;
      }

      // SPEC「结算」：等待到点 → 发 session/stop（notify），再等回合结束事件最多 5 秒
      for (;;) {
        const branches = [ended.then(() => 'ended'), this.#client.exited.then(() => 'exited')];
        if (!timedOut && timeoutMs) branches.push(after(timeoutMs - (Date.now() - startedAtMs), 'timeout'));
        if (timedOut) branches.push(after(graceDeadline - Date.now(), 'grace'));
        won = await Promise.race(branches);
        cancelBranchTimers();
        if (won === 'timeout') {
          timedOut = true;
          graceDeadline = Date.now() + GRACE_AFTER_STOP_MS;
          void this.stop(); // stop 是通知式（协议文档「session/stop」），发不出去也无从恢复，退路是 exited 分支
          continue;
        }
        if (won === 'exited') exitInfo = await this.#client.exited;
        break;
      }

      const endedAt = new Date().toISOString();
      const settled = settleTurn(turn.events);
      if (won === 'exited') {
        return this.#settle(turn, {
          outcome: 'exited',
          reason: `zcode app-server 已退出（code=${exitInfo.code}，signal=${exitInfo.signal ?? 'null'}）`,
          startedAt,
          endedAt,
          settled,
        });
      }
      if (won === 'grace' || timedOut) {
        // 宽限期内结束也算 timeout（任务单：等回合结束事件最多 5 秒，outcome 'timeout'）
        return this.#settle(turn, {
          outcome: 'timeout',
          reason: `回合超时（${timeoutMs}ms），已发 session/stop`,
          startedAt,
          endedAt,
          settled,
        });
      }
      return this.#settle(turn, { outcome: settled.outcome, reason: settled.reason, startedAt, endedAt, settled });
    } finally {
      cancelBranchTimers();
      if (won === null) {
        // 异常路径也要拆掉活动回合，否则会话卡死在「回合进行中」
        this.#turn = null;
      }
    }
  }

  /** 回合进行中的原生插话（verified.md：回合中再发一条 session/send 即 steer），不等结束。 */
  async steer(text) {
    const result = await this.#client.request('session/send', { sessionId: this.#sessionId, content: text });
    return { accepted: result?.accepted ?? true };
  }

  /** session/stop 是 fire-and-forget 通知（协议文档「session/stop」一节），没有返回值。 */
  async stop() {
    this.#client.notify('session/stop', { sessionId: this.#sessionId });
  }

  /** session/close 后 client.close()。 */
  async close() {
    try {
      await this.#client.request('session/close', { sessionId: this.#sessionId });
    } finally {
      await this.#client.close();
    }
  }

  // ---------- 内部 ----------

  // 统一收口：组装返回值并拆掉活动回合
  #settle(turn, { outcome, reason, startedAt, endedAt = new Date().toISOString(), settled = null }) {
    this.#turn = null;
    const s = settled ?? settleTurn(turn.events);
    return {
      outcome,
      reason,
      startedAt,
      endedAt,
      lastText: s.lastText,
      usage: s.usage,
    };
  }

  // 反向请求路由：permission/question 交给 handlers；没给的一律不答（挂着）；
  // 其它走客户端默认——返回 undefined 即 prefs 默认应答 / 未知 -32601
  #onServerRequest(req) {
    if (req.method === 'interaction/requestPermission') {
      const handler = this.#handlers.permission;
      // 权宜：不答 = 挂着，挂起时长没有上限。重发信封由客户端只保留最近 5 个 id、应答只回
      // 这几个（RULES §7 例外）；要可观测的挂起状态与应答上限时，再升级成显式限量
      if (!handler) return new Promise(() => {});
      return handler(req.params);
    }
    if (req.method === 'interaction/requestUserInput') {
      const handler = this.#handlers.question;
      // 权宜：同上，question 分支的挂起同样靠客户端的 5 个信封上限撑着
      if (!handler) return new Promise(() => {});
      return handler(req.params);
    }
    return undefined;
  }

  // 通知路由：session/event 落盘 + 结算 + onEvent；别的会话丢弃；
  // 非 session/event 的通知按 {method, params} 落盘但不结算（SPEC「工作流层」通知落盘形状）
  #onNotification({ method, params }) {
    if (method === 'session/event') {
      if (params?.sessionId !== this.#sessionId) return; // 不属于本会话的丢弃
      if (typeof params.seq === 'number' && params.seq > this.#lastSeq) this.#lastSeq = params.seq;
      this.#append(params);
      this.#onEvent?.(params);
      this.#feedTurn(params);
      return;
    }
    if (params && typeof params === 'object' && params.sessionId !== undefined && params.sessionId !== this.#sessionId) {
      return;
    }
    this.#append({ method, params });
  }

  // 回合边界（SPEC「回合边界」）：send 之后第一个 turn.started 到 completed/failed/terminal
  // 之间的事件算本回合。后台任务回合（started.payload.inputSource === 'background_task'）整段
  // 不认（协议文档「Background Tasks & Sub-Agents」）；seq 没过水位的是上一回合迟到的事件，也不认
  #feedTurn(params) {
    const turn = this.#turn;
    if (!turn) return;
    if (params.type === 'turn.started' && params.payload?.inputSource === 'background_task') {
      turn.skip = true;
      return;
    }
    if (turn.skip) {
      if (TURN_END_TYPES.has(params.type)) turn.skip = false;
      return;
    }
    if (params.seq !== undefined && params.seq <= turn.watermark) return;
    if (params.type === 'turn.started') {
      if (!turn.sawStarted) {
        turn.sawStarted = true;
        turn.events.push(params);
      }
      return;
    }
    if (TURN_END_TYPES.has(params.type)) {
      if (!turn.sawStarted) return; // 没见过本回合的 started，不认结束事件（T1.1b 第 2 条）
      turn.events.push(params);
      turn.onEnd(params);
      return;
    }
    if (turn.sawStarted) turn.events.push(params);
  }

  #append(event) {
    appendFileSync(this.#eventsPath, JSON.stringify(event) + '\n');
  }
}
