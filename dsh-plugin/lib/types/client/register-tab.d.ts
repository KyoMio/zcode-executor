import type { Context } from '@deepseek-ai/cordis';
import type { SnapshotStore } from './store.ts';
/**
 * 注册右栏 tab 与本体槽位。挂载失败（比如插件重载时上下文已失活）把类型注册一并回滚，
 * 不留占死 id 的半挂载（better-sidebar 同款防守）。
 * @param ctx - 客户端根上下文。
 * @param store - 面板数据 store（T4），作为 Body 的业务面经槽位 inject 工厂下发。
 */
export declare function registerTasksTab(ctx: Context, store: SnapshotStore): void;
//# sourceMappingURL=register-tab.d.ts.map