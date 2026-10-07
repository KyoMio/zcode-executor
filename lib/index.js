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
 * （src/skill-link.ts），systemPrompt 公告把派单通道与「挂起必转交用户」写进智能体的系统提示。
 * 浏览器半边经 package.json 的 dsh.client 声明走 exports["./client"]。
 */
import { homedir } from 'node:os';
import { resolveWatchSettings } from "./config.js";
import { installReloadWatcher } from "./reload.js";
import { registerRoutes } from "./routes.js";
import { defaultDshHome, ensureSkillLink } from "./skill-link.js";
import { WatchProcess } from "./watch-process.js";
/** 插件名：cordis 对象插件的标识（同 dsh-auto-approve 等自研插件的惯例，用包名）。 */
export const name = 'dsh-zcode-executor';
/**
 * 依赖的服务：这里故意留空。路由要的 webServer / connection 走 apply 里的 ctx.inject
 * 惰性注入——声明在这里的话，没有这些服务的 composition（如 Electron）会让整行加载失败。
 */
export const inject = [];
export { Config, resolveWatchSettings } from "./config.js";
/**
 * 智能体系统提示里的派单公告（Task 7）。两三句说清通道是什么、细节去哪查、
 * 红线在哪——审批与提问必须转交用户，这是 skill 铁律 4 的前置提醒。
 */
const ANNOUNCE_TO_AGENT = [
    '本机有 zcode-executor 派单通道：把一件想清楚的开发任务写成任务单，派给本机 ZCode（GLM）'
        + '在隔离的执行副本（git worktree）里执行，用 git diff 和测试客观验收。',
    '完整用法见 skill「zcode-executor」。',
    '执行端挂起的审批请求与提问必须转交用户，不替用户批越界操作。',
].join('');
/**
 * @param ctx - 插件行上下文。
 * @param config - 插件行配置（volatile 引用）。
 */
export function apply(ctx, config = {}) {
    // apply 时读一次；三个 volatile 字段的变更走下面的热重载守卫（指纹变了 → fiber.restart
    // 重载插件行，apply 重跑、这里读到新值）。
    const settings = resolveWatchSettings(config);
    // 配置热重载（Task 8 ①，照 zen-remote 先例）：设置页保存只动 volatile 字段时宿主不重启
    // 插件行、只广播 loader/volatile-update——监听它并对解析值做指纹比对，变了就重载行，
    // watch 进程与路由随之用新 execPath/watchMode 重建；announceToAgent 同样走行重载
    // （公告的 section 生命周期挂在行上），不精细到只撤销公告。
    installReloadWatcher(ctx, config);
    // 教学件一：skill 软链。幂等，占名者不指向本包只 warn；dispose 由 ensureSkillLink
    // 内部挂在行 effect 上（只清自己的链接）。失败非致命，不阻断插件加载。
    // 软链没就绪（foreign/error）时公告仍会引用 skill「zcode-executor」——智能体会被告知去
    // 查一个可能不存在的 skill，这里补一行 warn 把两者连起来（T7 评审 Optional 的最小联动，
    // 不改公告文案本身）。
    void ensureSkillLink(ctx, defaultDshHome()).then((handle) => {
        if (handle.outcome !== 'foreign' && handle.outcome !== 'error')
            return;
        ctx.logger.warn('skill 软链未就绪（%s：%s），公告仍会引用 skill「zcode-executor」，智能体可能查不到教学', handle.outcome, handle.linkPath);
    });
    // 教学件二：systemPrompt 公告。section 自带 cordis effect 生命周期（注册进本行 scope，
    // 行卸载自动撤销并广播 system-prompt/change）；inject 惰性注入——没有 systemPrompt
    // 服务的宿主组合里回调根本不执行，插件照常加载。
    ctx.inject(['systemPrompt'], (promptCtx) => {
        const host = promptCtx;
        if (!settings.announceToAgent || !host.systemPrompt)
            return;
        try {
            host.systemPrompt.section({ name: 'zcode-executor', order: 150, text: ANNOUNCE_TO_AGENT });
            ctx.logger.info('派单公告已挂进 system prompt（announceToAgent）');
        }
        catch (e) {
            console.warn(`[dsh-zcode-executor] 无法注册 system prompt 公告: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
    ctx.inject(['webServer', 'connection'], (webCtx) => {
        webCtx.effect(() => {
            const watch = new WatchProcess({
                execPath: settings.execPath,
                cwd: homedir(), // hello.repo 为 null → 流里是全量会话，按仓库过滤归客户端
                mode: settings.watchMode,
                logger: ctx.logger,
            });
            if (settings.watchMode === 'always')
                watch.start();
            const unregister = registerRoutes({
                register: (route) => webCtx.webServer.register(route),
                admit: (req) => webCtx.connection.admit(req),
                watch,
            });
            return () => {
                // 顺序：先摘路由（新连接进不来），再杀 watch 进程（存量订阅随 dispose 清空）
                unregister();
                watch.dispose();
            };
        }, 'zcode-executor: watch process and routes');
    });
}
//# sourceMappingURL=index.js.map