/**
 * 配置热重载守卫（Task 8 ①，todo.md T3 移交项）。execPath / watchMode / announceToAgent
 * 三个 Config 字段全是 volatile（DSH 的设置服务只渲染 volatile 字段，src/config.ts），于是
 * 「保存了要重载才生效的配置」没法骑在 volatility 旗标上：DSH 对 volatile-only 的保存**不重启
 * 插件行**，只在本行上下文广播 `loader/volatile-update` 事件（cordis-plugin-loader 1.0.5 /
 * DSH 0.2.0-rc.1 实证，dsh-zen-remote src/index.ts:949-997 注释）。本模块监听该事件并对
 * **解析后的**设置值做指纹比对，变了就 `fiber.restart` 重载插件行——apply() 重跑，watch 进程
 * 与三条路由随之用新配置重建；announceToAgent 的变更同样走行重载（systemPrompt 公告的
 * 生命周期挂在行上，不精细到只撤销公告）。
 *
 * 照 zen-remote 的先例（src/restart-watcher.ts + src/index.ts:970-997）：
 * - 比对的是 resolveWatchSettings 的产物而非配置原文——垃圾进/缺省出归解析管，原文改了
 *   但解析值没变（如 execPath 多敲了空格）不值得重载一次行；
 * - 双触发：事件即时比对 + 2 秒轮询兜底（老版本宿主不发事件时轮询仍能生效）；
 * - fire-at-most-once：触发即自解除武装，行重载本身会重跑 apply()、起新的守卫。
 *
 * 纯逻辑 + 可注入计时（测试驱动每一次 tick），ctx 面是最小结构（ReloadCtxFace）。
 */
import type { RowConfig, WatchSettings } from './config.ts';
/**
 * 重载指纹：三项解析值按稳定键序 JSON 串。键序排过序，深等值的配置必得同串，
 * 与键的书写顺序无关（zen-remote restartKey 同款）。
 */
export declare function settingsKey(values: WatchSettings): string;
/** 计时半边的 duck 类型：运行时是 Node 的 setInterval/clearInterval，测试注假钟。 */
type StartInterval = (callback: () => void, ms: number) => unknown;
type ClearInterval = (handle: unknown) => void;
export interface ReloadWatcherOptions {
    /** 读当前的解析设置；启动时读一次作基线，之后每个触发各读一次。 */
    getValues: () => WatchSettings;
    /** 指纹偏离基线时调，至多一次（调用前先自停，回调不可能再触发或与下一 tick 竞争）。 */
    onChange: () => void;
    /** 轮询兜底的节奏，默认 2000ms。 */
    intervalMs?: number;
    /** 可注入计时（测试驱动 tick）。 */
    setIntervalImpl?: StartInterval;
    clearIntervalImpl?: ClearInterval;
}
export interface ReloadWatcher {
    /** 轮询的停止函数（宿主半场把它交给 ctx.effect 当 disposer）。 */
    stop(): void;
    /** 立即做一次指纹比对，语义同见到变化的轮询 tick：至多 fire 一次然后自解除武装。 */
    checkNow(): void;
}
/**
 * 监视重载指纹，解析值偏离启动时的基线就调一次 onChange。两个触发（`checkNow()`——
 * 即 loader/volatile-update 事件的监听体——与轮询 tick）共用同一个「至多一次」闸门。
 * 基线或比对读值抛错都不致命：基线失败延到首个成功触发补记（不 fire），比对失败等下个触发。
 * 轮询计时器 unref：光靠兜底轮询不托住宿主进程。
 */
export declare function startReloadWatcher(options: ReloadWatcherOptions): ReloadWatcher;
/**
 * installReloadWatcher 依赖的 ctx 最小面。cordis 行上下文结构上满足它
 * （effect/on/logger 是固有面，fiber 是行自己的 Fiber——cordis 4.0.4 在 Fiber
 * 构造器里挂上，restart() 是它公开的卸载并重载入口）；fake ctx 同形状即测。
 */
export interface ReloadCtxFace {
    effect(execute: () => unknown, name?: string): unknown;
    on(event: string, listener: (payload?: unknown) => void): unknown;
    fiber?: {
        restart?: () => Promise<unknown>;
    };
    logger?: {
        warn?(format: unknown, ...args: unknown[]): void;
    };
}
/**
 * 把「配置变更 → 插件行重载」接进一个插件行上下文：指纹守卫挂进行 effect（行卸载自动停），
 * loader/volatile-update 监听注册失败只降级为 warn（轮询兜底仍在，守卫照常工作）。
 * 行重载与 zen-remote 同款：fiber.restart 缺失（fake ctx / 异常宿主）只 warn 不炸，
 * restart 的 rejection 也只 warn——重载失败不能变成未处理的 rejection 砸掉宿主。
 */
export declare function installReloadWatcher(ctx: ReloadCtxFace, config: RowConfig, timing?: {
    intervalMs?: number;
    setIntervalImpl?: StartInterval;
    clearIntervalImpl?: ClearInterval;
}): void;
export {};
//# sourceMappingURL=reload.d.ts.map