import type { Link, ReducerState } from './reducer.ts';
/** 与 src/routes.ts 的 STREAM_ROUTE 一致（那边 import node:*，客户端不能引；测试断言两边相等防漂移）。 */
export declare const STREAM_PATH = "/zcode-executor/stream";
/** 与 src/routes.ts 的 SNAPSHOT_ROUTE 一致（同上，测试断言相等）。 */
export declare const SNAPSHOT_PATH = "/zcode-executor/snapshot";
/** 与 src/routes.ts 的 REPO_ROUTE 一致（同上；GET /…?cwd=… 返回 { repo }）。 */
export declare const REPO_PATH = "/zcode-executor/repo";
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
    /**
     * 未桥接（503 zr-plugin-unbridged）时的重试节奏下限，默认 5000（任务口径：不疯狂重试、
     * 最长间隔不小于 5 秒）。远程会话里插件桥没桥上（服务端没装同版本 / 未同意 / 中继离线
     * 等）时子客户端回 503，流与轮询照常重试（桥恢复后自动接上），但节奏放宽到本值与常规
     * 间隔的较大者；测试注入小值驱动。构造时校验正数。
     */
    unbridgedRetryMs?: number;
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
    /**
     * 换当前主会话（PB-6）：id 存起来给 stream/snapshot 请求当 `?sessionId=` 参数；它的
     * 「侧」（session-cwd.ts 的 sideOfSessionId）与正在跑的连接不同侧时——本机 ↔ 远程、
     * 或两台远程主服务端之间——关掉当前流、清空面板数据、按新侧重开；同侧内换会话不重开
     * 流（数据是整机的，只有后续请求改用新参数）。没在取数时只记参数，下次 start 生效。
     */
    setSession(sessionId: string | null): void;
    /** 换过滤仓库：只改状态，不动取数。 */
    setScopeRepo(repo: string | null): void;
}
/**
 * 未桥接 reason → 面板横幅的中文原因（PB-6 口径四类 + 其他附原文）。导出供测试对表。
 * not-on-server 与 version-mismatch 都归「服务端未安装同版本插件」——前者没装、后者装
 * 的不是同一版，对用户是同一件事：两端装同版本。
 */
export declare function unbridgedMessageOf(reason: string): string;
/**
 * 建一个快照 store。构造后不取数，start() 才连；stop() 后可再 start() 从头连。
 * @param options - baseUrl 与两个注入计时（测试给小值）。
 * @returns store。
 */
export declare function createSnapshotStore(options: SnapshotStoreOptions): SnapshotStore;
//# sourceMappingURL=store.d.ts.map