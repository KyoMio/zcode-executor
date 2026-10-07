// src/client/store.ts —— 面板的快照取数 store：fetch GET /zcode-executor/stream 流式读
// （ReadableStream + TextDecoder 按行切，逐行过 T2 归约器），流断开或 fetch 异常退化为
// GET /zcode-executor/snapshot 每 pollMs 轮询兜底，并按 retryMs 重试流，流恢复即停轮询。
// 对外 getState / subscribe（useSyncExternalStore 兼容）/ start / stop / setScopeRepo；
// 内部状态 = 归约器三键（table/baseline/synced，src/client/reducer.ts）+ 连接态 link/message
// + 过滤仓库 scopeRepo（过滤本身由消费方做，store 只存）。
//
// 浏览器目标：不 import node:*，fetch/ReadableStream/TextDecoder/AbortController 全局即得。
// 因此 stream/snapshot 两条路径常量在本文件复制（src/routes.ts 带 node:child_process 等，
// 客户端不能引，构建内联会炸）；两边不一致时以 routes.ts 为准。
//
// snapshot 的喂法与流等价：先照响应体喂一条 connection 事件，已同步再走一轮
// hello + 表 + synced（routes.ts stream 路由对已同步新客户端的回放形状）——归约器语义
// 下这正好是「整表换血 + 回到已同步」，断流期间错过的一切由此对齐。
//
// 连接态语义：link/message 只由服务端事件驱动（流的 connection 行、snapshot 响应体），
// 照 T2 归约器语义进状态；唯传递层自己出问题时 store 合成连接行，且三种病因各说各话（Task 8 ⑥）：
// 连 snapshot 都拉不到 → down「实时连接中断」（服务端已报 failed 时不覆盖——起不来的诊断优先）；
// snapshot 回 401/403 → down「无权访问（admit 拒绝）」（传输是通的，病根在鉴权，不说「连接中断」）。
// fetch 首响应限时 firstResponseMs（Task 8 ⑤）：服务器收 TCP 不回时 fetch 永久挂起，
// 超时按连接失败走退化；响应头到达即拆闹钟，流/正文的后续读取不限时（空闲是常态）。
// 流挂、轮询挂这类退化各 console.warn 一条（去重位拦周期性重复，恢复即复位），其余全程静默。

import { applyEvent, emptyState } from './reducer.ts';
import type { Link, ReducerState } from './reducer.ts';

/** 与 src/routes.ts 的 STREAM_ROUTE 一致（那边 import node:*，客户端不能引；测试断言两边相等防漂移）。 */
export const STREAM_PATH = '/zcode-executor/stream';
/** 与 src/routes.ts 的 SNAPSHOT_ROUTE 一致（同上，测试断言相等）。 */
export const SNAPSHOT_PATH = '/zcode-executor/snapshot';
/** 与 src/routes.ts 的 REPO_ROUTE 一致（同上；GET /…?cwd=… 返回 { repo }）。 */
export const REPO_PATH = '/zcode-executor/repo';

/** store 的对外状态：归约器三键 + 连接态 + 过滤仓库。 */
export interface SnapshotStoreState extends ReducerState {
  /** watch 连接四态（流 connection 行 / snapshot 响应体驱动）。 */
  link: Link;
  /** 给人看的连接原因（down/failed 时有），照服务端原样带过。 */
  message: string | null;
  /** 过滤仓库（所属仓库完整路径）；null 显示全部。 */
  scopeRepo: string | null;
  /** 最后一次数据状态变化的时刻（epoch ms，0 = 还没来过数据）。面板渲染「数据 HH:MM:SS」，
   *  与走秒的本地时钟对比即可判断数据流是否停格（2026-10-07 真机排障加）。 */
  dataAt: number;
}

export interface SnapshotStoreOptions {
  /** 路由的基址，尾部斜杠（若有）会被剥掉；'' 即同源相对路径。 */
  baseUrl: string;
  /** 流断开后 snapshot 轮询的间隔，默认 1000（SPEC 建议节奏）。 */
  pollMs?: number;
  /** 流断开后重试流式连接的间隔，默认 3000。 */
  retryMs?: number;
  /**
   * 首响应超时：fetch 发出后多久还没等到响应头就按连接失败走退化，默认 15000（Task 8 ⑤；
   * 15 秒的量级照 zen-remote relay-client.ts:70 的DEFAULT_REQUEST_TIMEOUT_MS 同款先例）。
   * 服务器收下 TCP 却不回时 fetch 会永久挂起——流挂着轮询永不启动、轮询挂着合成不了 down。
   * 只限时到响应头为止：流连上后本来就可能长时间无行（watch 空闲），限时正文会掐死健康的流。
   */
  firstResponseMs?: number;
  /**
   * 流健康时的安全网轮询间隔，默认 2000，0 关闭（2026-10-07 真机发现）。宿主 webServer 到
   * webview 的传输层可能把流式响应攒在缓冲里不逐行吐（首轮回放的大块能到、中途的小增量行
   * 全看不到，且流没断、fetch 正常，退化轮询永远不启动）。安全网在流活着时也低频拉一次
   * snapshot：流正常时它拿到的与服务端一致等于空转；流被缓冲时保证状态 ≤ 此间隔必达。
   * 退化轮询（流断）进行中时安全网暂停，由退化轮询接管；流恢复即回到安全网节奏。
   */
  safetyPollMs?: number;
}

export interface SnapshotStore {
  /** 当前状态。内容不变则同一引用（useSyncExternalStore 的防死循环前提）。 */
  getState(): SnapshotStoreState;
  /** 订阅状态变化；返回退订函数。回调同步触发、逐个调（遍历快照，退订不影响本轮）。 */
  subscribe(fn: () => void): () => void;
  /** 起取数：从头连流。已在跑时是空操作。 */
  start(): void;
  /** 停取数：断在途请求（AbortController）、清轮询与重试定时器。状态保留不清屏。 */
  stop(): void;
  /** 换过滤仓库：只改状态，不动取数。 */
  setScopeRepo(repo: string | null): void;
}

const LINKS: ReadonlyArray<string> = ['starting', 'live', 'down', 'failed'];

/** admit 拒绝（snapshot 回 401/403）时合成的连接说明：传输是通的，病根在鉴权（Task 8 ⑥）。 */
const AUTH_DENIED_MESSAGE = '无权访问（admit 拒绝）：本机登录态可能已失效，重新登录 DSH 后自动恢复';

/** 连接态守卫：JSON 来的字段不受类型标注约束，先认值再存。 */
function isLink(value: unknown): value is Link {
  return typeof value === 'string' && LINKS.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 把未知抛出物变成一行可读文字（console 提示用）。 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 建一个快照 store。构造后不取数，start() 才连；stop() 后可再 start() 从头连。
 * @param options - baseUrl 与两个注入计时（测试给小值）。
 * @returns store。
 */
export function createSnapshotStore(options: SnapshotStoreOptions): SnapshotStore {
  // 尾斜杠剥一次：调用方传 'http://host/' 时拼出 //zcode-executor/stream 会静默 404
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const pollMs = options.pollMs ?? 1000;
  const retryMs = options.retryMs ?? 3000;
  // 0 或负数的间隔会让轮询/重试变成紧密循环打爆服务器，构造时就拒绝
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`createSnapshotStore：pollMs 必须是正的有限数，收到 ${pollMs}`);
  }
  if (!Number.isFinite(retryMs) || retryMs <= 0) {
    throw new Error(`createSnapshotStore：retryMs 必须是正的有限数，收到 ${retryMs}`);
  }
  const firstResponseMs = options.firstResponseMs ?? 15_000;
  if (!Number.isFinite(firstResponseMs) || firstResponseMs <= 0) {
    throw new Error(`createSnapshotStore：firstResponseMs 必须是正的有限数，收到 ${firstResponseMs}`);
  }
  const safetyPollMs = options.safetyPollMs ?? 2_000;
  if (!Number.isFinite(safetyPollMs) || safetyPollMs < 0) {
    throw new Error(`createSnapshotStore：safetyPollMs 必须是非负有限数（0 关闭），收到 ${safetyPollMs}`);
  }

  let state: SnapshotStoreState = { ...emptyState(), link: 'starting', message: null, scopeRepo: null, dataAt: 0 };
  const listeners = new Set<() => void>();

  let running = false;
  let polling = false;
  /** 退化提示去重位：每次退化只 console 一条，流恢复即复位（别让轮询/重试的周期性失败刷屏）。 */
  let warnedDegraded = false;
  /** 安全网失败的独立去重位：安全网失败不改变连接态（流还活着），但一行告警必须有——
   *  2026-10-07 真机教训：静默失败让「流被缓冲且安全网也挂」的组合完全不可见。 */
  let warnedSafety = false;
  let streamController: AbortController | null = null;
  let pollController: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;

  const notify = (): void => {
    // 遍历快照：某个回调里退订（或新订）不影响本轮（dsh-zen-remote compat/store.ts 同款）
    for (const fn of [...listeners]) fn();
  };

  /**
   * 首响应闹钟（Task 8 ⑤）：给一次 fetch 挂上「多久没等到响应头就 abort」的计时。
   * 响应头一到必须 disarm（之后的正文/流读不限时——流空闲本来就可能很久）；超时的 abort
   * 与 stop() 的主动 abort 都让 fetch 以 rejection 收场，靠 timedOut() 区分：前者算连接失败
   * 走退化，后者是主动停、静默。
   */
  const armFirstResponse = (controller: AbortController): { timedOut: () => boolean; disarm: () => void } => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, firstResponseMs);
    return {
      timedOut: () => timedOut,
      disarm: () => {
        clearTimeout(timer);
      },
    };
  };

  /**
   * 一条事件进归约器（静默，不通知）。connection 行顺带把 link/message 存进状态
   * （归约器只管同步语义，展示用的连接态归 store）。无事发生时不换引用。
   */
  const accept = (msg: unknown): void => {
    const prev = state;
    const core: ReducerState = applyEvent(prev, msg);
    let link = prev.link;
    let message = prev.message;
    // link 不认识就整行不认：非法 connection 行连 message 都不更新（归约器对它同样零副作用）
    if (isRecord(msg) && msg.type === 'connection' && isLink(msg.link)) {
      link = msg.link;
      message = typeof msg.message === 'string' ? msg.message : null;
    }
    if (core === prev && link === prev.link && message === prev.message) return;
    state = { ...core, link, message, scopeRepo: prev.scopeRepo, dataAt: Date.now() };
  };

  /** snapshot 响应体走与流等价的归约路径：connection 事件 +（已同步时）hello+表+synced 回放。 */
  const acceptSnapshot = (body: unknown): void => {
    if (!isRecord(body)) return;
    const { link, message, synced, table } = body;
    if (!isLink(link)) return;
    const before = state;
    accept({ type: 'connection', link, message: typeof message === 'string' ? message : null });
    if (synced === true && isRecord(table)) {
      accept({ type: 'hello', repo: null });
      for (const session of Object.values(table)) accept({ type: 'session', session });
      accept({ type: 'synced' });
    }
    if (state !== before) notify();
  };

  /** 流断开：进轮询兜底，并按 retryMs 重试流。 */
  const onStreamDown = (): void => {
    if (!running) return;
    startPolling();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connectStream();
    }, retryMs);
  };

  const startPolling = (): void => {
    if (polling || !running) return;
    polling = true;
    pollTimer = setTimeout(() => void runPoll('degraded'), pollMs);
  };

  /** 流活着时的安全网轮询：低频拉 snapshot，防传输层把流缓冲住（见 options.safetyPollMs 注）。 */
  const startSafetyPoll = (): void => {
    if (safetyPollMs <= 0 || safetyTimer !== null || !running) return;
    safetyTimer = setTimeout(() => void runPoll('safety'), safetyPollMs);
  };

  const stopPolling = (): void => {
    polling = false;
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  };

  /**
   * 一轮 snapshot 轮询：拉得到喂归约器，拉不到/超时合成 down；degraded（流断的兜底，按 pollMs
   * 连轴转）与 safety（流活着的安全网，按 safetyPollMs 低频）共用本体，只在「响应要不要收」与
   * 「下一轮要不要排」上分叉：degraded 在流恢复后丢弃晚到响应（不倒拨新状态），safety 只要还
   * 在跑就收（响应取自服务端当前状态，与服务端发给流的是同一份，回环毫秒级的在途差不构成倒拨）。
   */
  const runPoll = async (mode: 'degraded' | 'safety'): Promise<void> => {
    if (mode === 'degraded') {
      pollTimer = null;
      if (!running || !polling) return;
    } else {
      safetyTimer = null;
      if (!running) return;
    }
    const controller = new AbortController();
    pollController = controller;
    const alarm = armFirstResponse(controller);
    try {
      const res = await fetch(`${baseUrl}${SNAPSHOT_PATH}`, {
        signal: controller.signal,
        cache: 'no-store', // 防任何 HTTP 缓存层扣下 GET 响应（2026-10-07 真机排查加）
      });
      alarm.disarm(); // 响应头到了：本轮不再限时
      if (res.status === 401 || res.status === 403) {
        // 服务端明确拒了鉴权：传输其实是通的，「连接中断」会误导排障（Task 8 ⑥）
        noteAuthDenied();
      } else {
        if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
        const body: unknown = await res.json();
        if (running && (mode === 'safety' || polling)) acceptSnapshot(body);
      }
    } catch (err) {
      alarm.disarm();
      // stop 的主动 abort（running 已为 false）静默；超时的 abort 算连接失败，不吞
      if (!running || (controller.signal.aborted && !alarm.timedOut())) return;
      // 安全网的失败不打扰连接态（流还活着），但各病因打一条告警（去重）：静默失败曾让
      // 「流被缓冲 + 安全网也挂」的组合整整一天不可见（2026-10-07 教训）
      if (mode === 'safety' && !warnedSafety) {
        warnedSafety = true;
        console.warn(
          `[zcode-executor] 安全网 snapshot 拉取失败（流仍连着，中途输出可能不刷新）：${
            alarm.timedOut() ? `${firstResponseMs}ms 没等到响应` : describeError(err)
          }`,
        );
      }
      if (mode === 'degraded') {
        // 每次退化只提示一条：去重位拦住之后轮询周期的重复失败，别刷屏
        if (!warnedDegraded) {
          warnedDegraded = true;
          console.warn(
            `[zcode-executor] snapshot 轮询不可达，连接态转 down：${
              alarm.timedOut() ? `${firstResponseMs}ms 没等到响应` : describeError(err)
            }`,
          );
        }
        noteTransportDown();
      }
    } finally {
      if (pollController === controller) pollController = null;
    }
    if (mode === 'degraded') {
      if (running && polling) pollTimer = setTimeout(() => void runPoll('degraded'), pollMs);
    } else if (running && !polling) {
      // 退化轮询接管期间安全网不排；流恢复（stopPolling）后由恢复点重排
      safetyTimer = setTimeout(() => void runPoll('safety'), safetyPollMs);
    }
  };

  /** 连 snapshot 都不可达：整个数据源看不见了，合成 down（已在 down / failed 不重复打扰订阅者）。 */
  const noteTransportDown = (): void => {
    // failed 是服务端自己的诊断（watch 起不来 + 原因），transport 全断盖不掉它——
    // 「起不来」比「看不见」更接近病根，覆盖掉会误导排障（Task 8 ⑥）
    if (state.link === 'down' || state.link === 'failed') return;
    const before = state;
    accept({ type: 'connection', link: 'down', message: '实时连接中断，正在重试' });
    if (state !== before) notify();
  };

  /** admit 拒绝（401/403）：连接态仍记 down（横幅位置不变），message 把病根与出路说清；
   *  轮询照常继续，用户重新登录后下一轮自动恢复（Task 8 ⑥）。
   *  与 noteTransportDown 的守卫不对称是有意的：401/403 是服务端的权威响应而非本函数合成的
   *  down——响应能回来本身就证明传输是通的，病根在鉴权；所以它允许更新 failed（「起不来」的
   *  旧诊断在服务端亲口改判「请求被拒」时让位于更接近病根的说法），而 transport 全断只是
   *  「看不见」，那个猜测盖不掉服务端自己的 failed 诊断。 */
  const noteAuthDenied = (): void => {
    if (state.link === 'down' && state.message === AUTH_DENIED_MESSAGE) return;
    const before = state;
    accept({ type: 'connection', link: 'down', message: AUTH_DENIED_MESSAGE });
    if (state !== before) notify();
  };

  /** 连一次流：逐行喂归约器；任何形状的收场（读到底、报错、被掐、首响应超时）都走断流处理。 */
  const connectStream = async (): Promise<void> => {
    if (!running) return;
    const controller = new AbortController();
    streamController = controller;
    const alarm = armFirstResponse(controller);
    try {
      const res = await fetch(`${baseUrl}${STREAM_PATH}`, {
        signal: controller.signal,
        headers: { accept: 'application/x-ndjson' },
        cache: 'no-store', // 同上：流请求也不许任何缓存层介入
      });
      alarm.disarm(); // 响应头到了：之后的流读不限时（watch 空闲时长时间无行是常态）
      if (!res.ok || res.body === null) throw new Error(`stream HTTP ${res.status}`);
      stopPolling(); // 流恢复即停退化轮询；若刚连上又断，onStreamDown 会再排
      startSafetyPoll(); // 安全网回到低频节奏（退化期间它让位）
      warnedDegraded = false; // 流活了：退化提示位复位，下次再退化才再提示
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue; // 坏行跳过（服务端对坏行同款容错）
          }
          const before = state;
          accept(parsed);
          if (state !== before) notify();
        }
      }
      // 正常读到底也是断流（服务端关了流）；残缺的末行没有换行符，视为截断丢弃
    } catch (err) {
      alarm.disarm();
      // abort（stop）或网络错或首响应超时：都落到下面的统一断流处理，由 running/timedOut 区分
      // 主动 stop 不算退化，静默；真失败与超时各打一条（去重位拦住重试期的周期性重复）
      if (running && !warnedDegraded) {
        warnedDegraded = true;
        console.warn(
          `[zcode-executor] 实时流连接失败，退化为 snapshot 轮询兜底：${
            alarm.timedOut() ? `${firstResponseMs}ms 没等到响应` : describeError(err)
          }`,
        );
      }
    } finally {
      if (streamController === controller) streamController = null;
    }
    if (!running) return;
    if (controller.signal.aborted && !alarm.timedOut()) return; // stop 的主动掐断不算退化
    onStreamDown();
  };

  return {
    getState: (): SnapshotStoreState => state,
    subscribe: (fn: () => void): (() => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    start: (): void => {
      if (running) return;
      running = true;
      startSafetyPoll();
      void connectStream();
    },
    stop: (): void => {
      running = false;
      stopPolling();
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (safetyTimer !== null) {
        clearTimeout(safetyTimer);
        safetyTimer = null;
      }
      streamController?.abort();
      streamController = null;
      pollController?.abort();
      pollController = null;
    },
    setScopeRepo: (repo: string | null): void => {
      if (state.scopeRepo === repo) return;
      state = { ...state, scopeRepo: repo };
      notify();
    },
  };
}
