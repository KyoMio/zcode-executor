// 本文件负责：在 AppServerClient 之上盖一层「会话」——接上一条已存在的会话（resume + subscribe）、
// 把本会话的事件原样落盘、投递一条消息并等回合结束、按结算规则算 outcome；对外给
// attachSession / Session（send、steer、stop、close）/ settleTurn 三个形状（T1.1，后续 runner 依赖）。
// 不负责：建会话（session/create 归工作流层）、runs 目录以外的路径约定（eventsPath 由调用者给）、
// CLI 退出码表（只透传子进程的原始退出信息）、审批与提问的挂起策略（handlers 没给就不答，T1.2 决定）。
// 被依赖方：工作流层 runner / CLI。只依赖 lib/errors.mjs、lib/scrub.mjs（落盘抹密）；client 由调用方给。
//
// 结算规则出处：docs/SPEC.md「工作流层·结算」——turn.completed 按 payload.resultType 结算
// （2026-09-21 对照 ZCode 源码：非 success 也走 turn.completed，不走 turn.failed）：
// success/缺省 → done，cancelled → cancelled，error_* → failed；turn.failed → failed；
// 等待到点 → 发 session/stop，outcome timeout。事件形状见
// docs/reference/zcode-app-server-protocol.md「Event Types」。
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';
import { scrubValues } from './scrub.mjs';

const TURN_END_TYPES = new Set(['turn.completed', 'turn.failed']);
// 任务单：timeoutMs 到点发 session/stop，之后等回合结束事件最多 5 秒
const GRACE_AFTER_STOP_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 纯函数：本回合的事件数组 → {outcome, reason, lastText, usage, errorCode, errorReason}（SPEC「结算」）。
 * turn.completed 按 payload.resultType 结算（2026-09-21 对照 ZCode 源码：resultType 取值
 * success | cancelled | error_max_turns | error_max_budget | error_during_execution | error_max_tool_calls，
 * null/undefined 都算缺省）：缺省或 success → done（usage 取 payload.usage）；cancelled → cancelled；
 * 其余 → failed（reason 带上 resultType 值）。turn.failed → failed（reason 取 payload.error.message，
 * errorCode 取 payload.error.code 转字符串，闲时投递靠它认号失效；errorReason 取 payload.error.attribution.reason，
 * doctor 闲时自检靠它分辨限流、网络一类暂时性失败）；其余情况两者为 null。
 * attribution 的形状出自 zcode.cjs 3.14.1 源码（turn.failed schema），未验证。
 * lastText = 本回合所有 model.streaming text_delta 的拼接。没有结束事件 → outcome null（调用方定夺）。
 */
export function settleTurn(events) {
  const lastText = events
    .filter((e) => e.type === 'model.streaming' && e.payload?.kind === 'text_delta')
    .map((e) => e.payload.delta ?? '')
    .join('');
  const completed = events.find((e) => e.type === 'turn.completed');
  const failed = events.find((e) => e.type === 'turn.failed');
  if (completed) {
    const resultType = completed.payload?.resultType;
    const usage = completed.payload?.usage ?? null;
    if (resultType == null || resultType === 'success') { // null 与 undefined 都算缺省
      return { outcome: 'done', reason: null, lastText, usage, errorCode: null, errorReason: null };
    }
    if (resultType === 'cancelled') {
      return { outcome: 'cancelled', reason: '回合被叫停（resultType=cancelled）', lastText, usage, errorCode: null, errorReason: null };
    }
    return { outcome: 'failed', reason: `turn.completed resultType=${resultType}`, lastText, usage, errorCode: null, errorReason: null };
  }
  if (failed) {
    // verified.md 2026-09-27：闲时号失效的 code 是字符串 '3102'/'3104'，别的失败可能是数字，统一成字符串好比较
    const code = failed.payload?.error?.code;
    const attributionReason = failed.payload?.error?.attribution?.reason;
    return {
      outcome: 'failed',
      reason: failed.payload?.error?.message ?? null,
      lastText,
      usage: failed.payload?.usage ?? null,
      errorCode: code == null ? null : String(code),
      errorReason: typeof attributionReason === 'string' ? attributionReason : null,
    };
  }
  return { outcome: null, reason: null, lastText, usage: null, errorCode: null, errorReason: null };
}

/**
 * 接上一条已存在的会话：先建事件目录、装事件与反向请求路由（resume 期间来事件才接得住），
 * 再 resume（resume:false 跳过——刚 create 完的会话直接 subscribe，D13）→ subscribe → 返回 Session。
 * resume 失败 reject ExecutorError（details 带 error.data）。handlers 没给的反向请求
 * （permission/question）一律不应答——zcode 每秒重发、回合挂在原地，等上层闸门决定放行或转人工；
 * 其它反向请求走客户端默认（prefs 默认应答，未知回 -32601）。
 * secrets（可选）：写 events.jsonl 前、session/send 失败的错误往上抛前按值抹掉的字符串（闲时回合的
 * JWT 与 plan key，RULES §8）；不给就和原来一样原样落盘、原样抛。同一份 secrets 名单也要交给
 * AppServerClient.spawn，stderr 转发靠它。
 * 权宜：onEvent 拿到的是没抹的原事件，onEvent 目前没有调用方；一旦有调用方要打印或落盘，先抹密。
 */
export async function attachSession({ client, sessionId, cwd, eventsPath, handlers = {}, onEvent, resume = true, secrets }) {
  mkdirSync(path.dirname(eventsPath), { recursive: true }); // 必须在装路由前：resume 期间来事件就要落盘
  const session = new Session(client, { sessionId, eventsPath, handlers, onEvent, secrets });
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
  #secrets;
  #turn = null; // 活动回合：{ events, onEnd, sawStarted, watermark, skip }
  #lastSeq = 0; // 会话内事件序号水位：send 起点记下来，迟到的旧时间线不进新回合

  constructor(client, { sessionId, eventsPath, handlers, onEvent, secrets }) {
    this.#client = client;
    this.#sessionId = sessionId;
    this.#eventsPath = eventsPath;
    this.#handlers = handlers;
    this.#onEvent = onEvent;
    this.#secrets = secrets;
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
   * 投递一条消息并等本回合结束。extraParams 并进 session/send 的参数（闲时回合的 modelSelection、
   * modelExecution 等，providers.mjs 的 buildOffPeakSendParams），但盖不掉 sessionId 与 content。
   * onAccepted（可选）：session/send 请求被 app-server 接受（回了 result）之后、等回合结束之前调一次；
   * 被拒或进程已退时不调。闲时投递靠它判「原文确实发出去过」。
   * @returns {Promise<{outcome:'done'|'failed'|'cancelled'|'timeout'|'exited', reason:string|null, startedAt, endedAt, lastText:string, usage:object|null, errorCode:string|null, errorReason:string|null}>}
   *   outcome cancelled：非超时路径下回合以 turn.completed resultType="cancelled" 结束（比如
   *   runner 的 cancel 叫停）。触发过超时的 send 一律 timeout——超时叫停后回合以 cancelled
   *   收尾是预期现象，对外仍报 timeout（退出码 3：再投一次接着做）。
   */
  async send(text, { timeoutMs, extraParams, onAccepted } = {}) {
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
        await this.#client.request('session/send', { ...extraParams, sessionId: this.#sessionId, content: text });
      } catch (err) {
        this.#scrubError(err); // 拒绝原因可能回显带凭据的参数，往上抛（或进 reason）之前先抹
        const dead = await Promise.race([this.#client.exited, Promise.resolve(null)]);
        if (dead) {
          return this.#settle(turn, { outcome: 'exited', reason: err.message, startedAt });
        }
        throw err;
      }

      onAccepted?.(); // 放在 try 外：回调自己抛错不能被当成 send 被拒
      // SPEC「结算」：等待到点 → 发 session/stop，再等回合结束事件最多 5 秒
      for (;;) {
        const branches = [ended.then(() => 'ended'), this.#client.exited.then(() => 'exited')];
        if (!timedOut && timeoutMs) branches.push(after(timeoutMs - (Date.now() - startedAtMs), 'timeout'));
        if (timedOut) branches.push(after(graceDeadline - Date.now(), 'grace'));
        won = await Promise.race(branches);
        cancelBranchTimers();
        if (won === 'timeout') {
          timedOut = true;
          graceDeadline = Date.now() + GRACE_AFTER_STOP_MS;
          // 2026-09-21 对照 ZCode 源码：stop 是带 id 的请求，且真的会叫停回合（resultType=cancelled）。
          // 超时分支保持 fire-and-forget：发不出去记一行 stderr，退路是宽限到点按 timeout 结算
          this.stop().catch((err) => {
            process.stderr.write(`session/stop 发送失败：${err?.message ?? err}\n`);
          });
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
        // 只要本次 send 触发过超时，宽限内不管等到什么结束事件对外都是 timeout（任务单：等回合
        // 结束事件最多 5 秒）。2026-09-21 对照 ZCode 源码：超时叫停后回合以 resultType=cancelled
        // 结束是预期现象，但对外仍报 timeout（退出码 3：再投一次接着做；4 是「回合异常」，两码事）。
        // cancelled 只在非超时路径下出现（比如 runner 的 cancel 叫停）
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

  /**
   * 回合进行中的原生插话，不等结束。2026-09-21 对照 ZCode 源码：回合中再走普通 send 投递会被拒
   * -32010（3.12.2 起 3.11 的排队插话已删），插话改发 v4/command 的 sendText、requestedDelivery
   * 为 "guide"——回合忙时在下一个工具批次之后、下一次模型请求之前注入；没有工具边界或带附件时
   * CLI 自己退回排队（回合结束后作为下一条输入执行），两种 delivery 都算插话成功。插话被接受后
   * 事件流照推 turn.steerQueued / turn.steerDrained（普通回合事件，#feedTurn 不用区分）。
   * 2026-09-21 对照 ZCode 源码：空闲会话收到 sendText 直接起新回合（startNow）；runner 的观察点
   * 500ms 一轮，插话可能在回合收尾后才到。startNow 说明起了计划外的回合：立刻发 v4 stop 叫停
   * （叫停失败只记 stderr，不吞掉下面的抛错），再按失败抛给调用方——没审批过的输入不能自己跑。
   * 空闲时的 steer 项照旧走普通投递（run.mjs 的队列逻辑，不改）。
   * @returns {Promise<{accepted: true, delivery: string|null, status: string}>}
   *   delivery 是 ACK result 里的投递方式（"queue"），没有 result 时为 null
   */
  async steer(text) {
    const ack = await this.#client.command(this.#sessionId, 'sendText', { text, requestedDelivery: 'guide' });
    if (ack.result?.delivery === 'startNow') {
      try {
        await this.#client.command(this.#sessionId, 'stop', {});
      } catch (err) {
        process.stderr.write(`steer: startNow 后的 v4 stop 没发出去：${err?.message ?? err}\n`);
      }
      throw new ExecutorError('插话到达时回合已结束，sendText 起了计划外的回合，已发 v4 stop 叫停', {
        delivery: 'startNow',
        commandId: ack.commandId,
      });
    }
    return { accepted: true, delivery: ack.result?.delivery ?? null, status: ack.status };
  }

  /**
   * 叫停当前回合。session/stop 是带 id 的请求（2026-09-21 对照 ZCode 源码：app-server 对
   * 没有 id 的消息一律忽略），回 {}（result 形状可能另有字段，忽略）；叫停生效后回合以
   * turn.completed（payload.resultType="cancelled"）结束，正在等的 send() 会收到它。
   */
  stop() {
    return this.#client.request('session/stop', { sessionId: this.#sessionId });
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
      // 只有 failed 才带错误码：超时宽限里到的 turn.failed 对外是 timeout，错误码不能让调用方误判成号失效
      errorCode: outcome === 'failed' ? s.errorCode : null,
      errorReason: outcome === 'failed' ? s.errorReason : null,
    };
  }

  // 按值抹掉错误 message 与 details 里的密钥（details 是 JSON-RPC 错误的 {method, code, data}，纯数据）。
  // 没给 secrets 时不动，行为同原来
  #scrubError(err) {
    if (!this.#secrets?.length || !err || typeof err !== 'object') return;
    if (typeof err.message === 'string') err.message = scrubValues(err.message, this.#secrets);
    if (err.details !== undefined) err.details = JSON.parse(scrubValues(JSON.stringify(err.details), this.#secrets));
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

  // 回合边界（SPEC「回合边界」）：send 之后第一个 turn.started 到 completed/failed
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

  // 按值抹密：事件会不会回显带凭据的 send 参数未验证，防御性抹密。
  // 抹的是 JSON 文本，'<redacted>' 不含要转义的字符，行仍是合法 JSON
  #append(event) {
    appendFileSync(this.#eventsPath, scrubValues(JSON.stringify(event), this.#secrets) + '\n');
  }
}
