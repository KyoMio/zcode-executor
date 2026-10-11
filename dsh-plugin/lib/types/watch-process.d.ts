/**
 * dsh-zcode-executor，服务端 watch 子进程管理。
 *
 * spawn `zcode-executor watch --json`（argv 从 execPath 换算，缺省 PATH 里找），cwd 取用户主目录
 * （hello.repo 为 null → 流里是全量会话，按仓库过滤归客户端）。逐行 JSON.parse 进快照表，语义与
 * 客户端归约器（src/client/reducer.ts）一致：hello 回到未同步、synced 前只进基线、synced 把基线
 * 整体换上——基线的「只当新基线、不当更新」在客户端归约器里管，服务端只负责把行原样转发加维护
 * 这张表与连接态。
 *
 * 重起语义照 zcode-executor 的 CC mod（hooks/register.mjs keepWatching）：收到 synced 之前退出 =
 * failed（起不来，重试也一样，不重试）；synced 之后退出 = down，restartMs（默认 5 秒）后重起。
 * 订阅接口把每一行原样递给订阅者（{ kind: 'line' }），连接态变化单独递（{ kind: 'link' }）。
 * on-demand 模式下由 stream 路由的活跃连接计数驱动起停（addStreamClient / removeStreamClient），
 * always 模式忽略计数、由 apply 起到 fiber dispose。
 */
/** 连接四态：starting 尝试中、live 已同步在跑、down 断了等重起、failed 起不来。 */
export type WatchLink = 'starting' | 'live' | 'down' | 'failed';
/** 对外的状态：连接态、给人看的原因（down/failed 时有）、当前是否已过首轮同步。 */
export interface WatchStatus {
    link: WatchLink;
    message: string | null;
    synced: boolean;
}
/** 一次性全量快照：状态加快照表（会话 id → watch 的 session 快照，字段表见 zcode-executor PRD 第 4 节）。 */
export interface WatchSnapshot extends WatchStatus {
    table: Record<string, unknown>;
}
/** 订阅者收到的事件：watch 的一行原样转发，或一次连接态迁移。 */
export type WatchStreamEvent = {
    kind: 'line';
    line: unknown;
} | {
    kind: 'link';
    link: WatchLink;
    message: string | null;
};
/** 路由层需要的最小形状（WatchProcess 满足；测试用桩满足同形状）。 */
export interface WatchSource {
    getSnapshot(): WatchSnapshot;
    subscribe(listener: (event: WatchStreamEvent) => void): () => void;
    addStreamClient(): void;
    removeStreamClient(): void;
}
export interface WatchProcessOptions {
    /** watch CLI 的可执行路径，argv 换算成 [execPath, 'watch', '--json']。 */
    execPath: string;
    /** 子进程 cwd：用户主目录（hello.repo 为 null，流里是全量会话）。 */
    cwd: string;
    /** synced 之后意外退出过多久重起，默认 5000（CC mod 的 RESTART_MS）。 */
    restartMs?: number;
    /** always（默认）常驻由 apply/dispose 管；on-demand 按活跃连接计数起停。 */
    mode?: 'always' | 'on-demand';
    /** 可选日志（cordis 的 ctx.logger 形状）：坏行打 debug。 */
    logger?: {
        debug?(format: string, ...args: unknown[]): void;
    };
}
export declare class WatchProcess {
    private readonly execPath;
    private readonly cwd;
    private readonly restartMs;
    private readonly mode;
    private readonly logger?;
    private child;
    private readonly subscribers;
    private restartTimer;
    private link;
    private message;
    private table;
    private baseline;
    private synced;
    private refs;
    private disposed;
    private intentionalStop;
    /** 本轮（一次 spawn 到退出）是否已收尾：'error' 与 'exit' 可能都来，只认第一个。 */
    private settled;
    /** 本轮是否见到过 synced：重起判定的分界（CC mod keepWatching 同款）。 */
    private runSynced;
    private stderrTail;
    private stdoutBuffer;
    constructor(options: WatchProcessOptions);
    /** 当前状态与快照表（表做浅拷贝，外部改不动内部）。 */
    getSnapshot(): WatchSnapshot;
    /** 只测用：当前子进程 pid（没起时 null）。纯读；竞态回归用例拿它断言陈旧 exit 没清掉新进程。 */
    get childPidForTest(): number | null;
    /** 订阅行与连接态；返回退订函数（stream 路由断开时调）。 */
    subscribe(listener: (event: WatchStreamEvent) => void): () => void;
    /** stream 路由：一条活跃连接。on-demand 下 0→1 起进程；always 只计数。 */
    addStreamClient(): void;
    /** stream 路由：一条连接断开。on-demand 下归零杀进程且不进重起循环；always 只计数。 */
    removeStreamClient(): void;
    /** 起一次 watch（已在跑或已卸载时不重复）。 */
    start(): void;
    /** 卸载：杀子进程、清计时器与订阅者；之后不再重起。 */
    dispose(): void;
    /** on-demand 计数归零：杀进程、停掉重起计时，状态记 down（没在跑）。已在 failed 时不覆盖原因。 */
    private stopForIdle;
    private clearRestartTimer;
    private onStdout;
    /** 一行进表（与 src/client/reducer.ts 同语义，服务端自己留一份全量给 snapshot 路由）。 */
    private applyLine;
    private onChildError;
    private onChildExit;
    /** synced 之后断开：报 down 带原因，restartMs 后重起（重起到下个 synced 之间的行只作新基线）。 */
    private scheduleRestart;
    private setLink;
    private emit;
}
//# sourceMappingURL=watch-process.d.ts.map