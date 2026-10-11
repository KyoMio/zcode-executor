/**
 * dsh-zen-remote 插件桥（2.1）的协作插件声明（PB-6）。
 *
 * 远程会话里 zen-remote 的子客户端把声明过的插件路由改道到主服务端执行（主服务端以本机
 * 回环请求我们的路由，带合法 DSH cookie，connection.admit 照常放行）。本模块只管「声明」
 * 这一件事：版本运行时读本包 package.json、按三条路由构造 decl、经 `zenRemote` 服务登记。
 * 桥的登记/比对/转发逻辑都在 zen-remote 仓（其 src/plugin-bridge.ts 是协议权威）：
 * `decl = { plugin, version, routes }`，未知字段报错，path 须是我们在 webServer 上注册的
 * exact 路径，`scope:'server'` 的整机数据要主服务端主人在 zen-remote 设置页同意后才转发。
 *
 * 没装 zen-remote 时 `ctx.inject(['zenRemote'], …)` 永不触发（cordis 等服务语义），插件
 * 照常加载——桥是纯增量能力，本仓对它的全部依赖面就是这一个 inject。
 */
import { readFileSync } from 'node:fs';
import { REPO_ROUTE, SNAPSHOT_ROUTE, STREAM_ROUTE } from "./routes.js";
/**
 * 本包版本，运行时读 package.json（不写死）：桥的两端按「plugin + version + 声明摘要」
 * 三者一致才算桥上，版本对不上子客户端就回未桥接。读不到（产物被单独拷走等极端情况）
 * 给 '0.0.0'——登记会被 zen-remote 判 version-mismatch 而不桥上，好过写死一个会过期
 * 的版本号骗两端握手。
 */
export const PACKAGE_VERSION = (() => {
    try {
        const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
})();
/**
 * 桥声明：三条路由。
 * - stream / snapshot 是整机数据（watch 从用户主目录 spawn，流里是全量会话）→ scope 'server'；
 * - repo 带 sessionId（远程会话由桥转发到服务端按会话解析所属仓库）→ scope 'session'。
 * sessionParam 用默认 'sessionId'：客户端的 stream/snapshot/repo 请求都带这个参数。
 */
export function bridgeDeclaration(version = PACKAGE_VERSION) {
    return {
        plugin: 'dsh-zcode-executor',
        version,
        routes: [
            { path: STREAM_ROUTE, scope: 'server', stream: true },
            { path: SNAPSHOT_ROUTE, scope: 'server' },
            { path: REPO_ROUTE, scope: 'session' },
        ],
    };
}
/**
 * 登记桥声明。cordis 语义：没装 zen-remote 时 inject 回调永不执行（无分支代码）；
 * zenRemote 服务在但形状不对（老版本）或声明被拒（非法路径等，协议错误在本仓就该炸出来）
 * 时降级 warn，不影响插件其余部分。dispose 挂 inject 子 fiber 的 effect：行卸载或
 * zen-remote 行重载（服务更换）时随 fiber 撤销登记。
 * @param ctx - 插件行上下文。
 * @param logger - 可选日志（cordis ctx.logger 形状）。
 */
export function registerBridgeDeclaration(ctx, logger) {
    ctx.inject(['zenRemote'], (bridgeCtx) => {
        // inject 已等到服务；运行时值仍不受类型标注约束，先认值再调（register-tab.ts 同款镜像法）
        const service = bridgeCtx.zenRemote;
        if (typeof service?.bridge !== 'function') {
            logger?.warn?.('zenRemote 服务存在但没有 bridge 方法（zen-remote 版本过旧），插件桥不登记');
            return;
        }
        try {
            const dispose = service.bridge(bridgeDeclaration());
            bridgeCtx.effect(() => dispose, 'zcode-executor: zenRemote bridge declaration');
            logger?.info?.('插件桥声明已登记（%s 条路由，版本 %s）', 3, PACKAGE_VERSION);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger?.warn?.('插件桥声明被拒绝：%s（远程会话面板将回未桥接态，其余功能不受影响）', message);
        }
    });
}
//# sourceMappingURL=bridge.js.map