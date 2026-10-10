/**
 * dsh-zcode-executor，浏览器半场。
 *
 * apply 里四件事（生命周期全部挂本 fiber，插件卸载级联清掉）：
 * 1. 样式：模板字符串 CSS 一次注入 <style data-plugin="dsh-zcode-executor">（zen-remote 同款）；
 * 2. 数据：createSnapshotStore（baseUrl 同源根，路由常量与 store.ts 对齐）并 start；
 * 3. 范围与侧（PB-6）：订阅 ctx.sessions.list / ctx.workspaces.list，派生当前主会话 id 与
 *    cwd——id 交给 store.setSession（侧变化在 store 内部重开流：远程会话的取数带
 *    `?sessionId=` 由 zen-remote 插件桥改道到主服务端，本机/无会话不带）；repo 路由主会话
 *    存在时按 sessionId 解析（服务端用会话 cwd 判仓库），无主会话退工作区路径 `?cwd=`——
 *    失败或 repo 为 null 时 scope 为 null = 显示全部并在面板注明；
 * 4. 右栏：registerTasksTab 挂官方「zcode 任务」tab（register-tab.ts，含老宿主降级）。
 * 面板只看不应答：本半场不注册任何 approve/deny/answer 控件（AGENTS.md 硬边界）。
 */
import type { Context } from '@deepseek-ai/cordis';
/** 客户端半场插件名（与 host 半场同名的包标识，自研插件惯例）。 */
export declare const name = "dsh-zcode-executor";
/** 需要的客户端服务：slots 挂槽位；sessions/workspaces 派生当前项目的过滤仓库。 */
export declare const inject: string[];
/**
 * 浏览器半场入口。ctx.slots 由 renderer 提供、ctx.sessions/ctx.workspaces 由宿主控制器提供
 * （类型来自两个 controller 包的 /client 声明，文件尾的纯类型引入）。
 * @param ctx - 客户端根上下文。
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map