/**
 * dsh-zcode-executor，host 半场（Node）。
 *
 * Task 3 接线：按 watchMode 起 `zcode-executor watch --json` 子进程（src/watch-process.ts，
 * always 常驻到 fiber dispose；on-demand 由 stream 路由的活跃连接数起停），并把三个路由挂进
 * 宿主 webServer（src/routes.ts，全部先过 connection.admit）。webServer / connection 用
 * ctx.inject 惰性注入（照 dsh-zen-remote 的 absent-half 模式）：composition 里没有这两个
 * 服务时回调根本不执行——插件行照常加载，只是不挂路由、不起 watch。
 *
 * 派单教学（Task 7）：ensureSkillLink 幂等软链 ~/.dsh/skills/zcode-executor → 包内 skill 目录
 * （src/skill-link.ts），systemPrompt 公告把派单通道与「挂起按授权分流」写进智能体的系统提示。
 * 浏览器半边经 package.json 的 dsh.client 声明走 exports["./client"]。
 *
 * 插件桥（PB-6）：另起 ctx.inject(['zenRemote'], …) 向 dsh-zen-remote 2.1 登记桥声明
 * （src/bridge.ts），远程会话里 zen-remote 的子客户端把三条路由改道到主服务端执行；
 * 没装 zen-remote 时该 inject 永不触发，插件照常。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { RowConfig } from './config.ts';
/** 插件名：cordis 对象插件的标识（同 dsh-auto-approve 等自研插件的惯例，用包名）。 */
export declare const name = "dsh-zcode-executor";
/**
 * 依赖的服务：这里故意留空。路由要的 webServer / connection 走 apply 里的 ctx.inject
 * 惰性注入——声明在这里的话，没有这些服务的 composition（如 Electron）会让整行加载失败。
 */
export declare const inject: string[];
export { Config, resolveWatchSettings } from './config.ts';
export type { RowConfig } from './config.ts';
/**
 * @param ctx - 插件行上下文。
 * @param config - 插件行配置（volatile 引用）。
 */
export declare function apply(ctx: Context, config?: RowConfig): void;
//# sourceMappingURL=index.d.ts.map