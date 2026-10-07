/**
 * dsh-zcode-executor 的三个 GET 路由，注册进宿主 webServer 前全部先过 connection.admit
 * （webServer 路由不走 DSH 的 /api 鉴权，写法照 dsh-zen-remote 的既有模式：admit 的拒绝
 * 原样回给浏览器，服务缺席时整块不挂载——挂载与否由 index.ts 的 ctx.inject 决定）；admit
 * 之后还有一道 method 墙：非 GET 一律 405 + Allow: GET（Task 8 ②，zen-remote 同款）。
 *
 * - GET /zcode-executor/stream：NDJSON 流。连接即报当前连接态；已同步再补一轮
 *   hello+表+synced，新客户端不用等下一次变化就拿到全量。之后 watch 的行原样转发，
 *   连接态迁移转成 { type:'connection' } 行（客户端归约器认这两种形状）。活跃连接数
 *   上报给 watch 进程（on-demand 模式按计数起停，always 忽略），断开即退订减计数。
 * - GET /zcode-executor/snapshot：一次性全量（连接态 + 快照表），流不可用时的轮询兜底。
 * - GET /zcode-executor/repo?cwd=…：按 git 共同数据目录判所属仓库，规则与
 *   zcode-executor 的 worktreeStatus().repo 一致（lib/cli/common.mjs）：common dir 叫
 *   .git 就取它的上一级（真实路径）；不是 git 仓、裸仓库、坏路径都回 { repo: null }。
 *   进程内按 cwd 缓存（成功才缓存，git 一时出错不该永久记成无仓库）。
 */
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WatchSource } from './watch-process.ts';
/** GET /zcode-executor/stream：NDJSON 推送。 */
export declare const STREAM_ROUTE = "/zcode-executor/stream";
/** GET /zcode-executor/snapshot：一次性全量快照。 */
export declare const SNAPSHOT_ROUTE = "/zcode-executor/snapshot";
/** GET /zcode-executor/repo?cwd=…：cwd 的所属仓库。 */
export declare const REPO_ROUTE = "/zcode-executor/repo";
/** connection.admit 的回答：放行（带操作者信息）或拒绝状态（zen-remote 同款形状）。 */
export type Admission = {
    readonly peer: unknown;
} | {
    readonly rejection: 401 | 403;
};
/** webServer.register 需要的最小形状（由 index.ts 的接线绑到宿主服务上；测试收集调用）。 */
export type RouteRegistrar = (route: {
    kind: 'exact';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void;
}) => () => void;
export interface RouteDeps {
    register: RouteRegistrar;
    /** DSH connection 服务的 admit，由 index.ts 注入；测试假它。 */
    admit: (req: IncomingMessage) => Admission;
    watch: WatchSource;
    /** 缺省用模块级共享实例（缓存在进程内活一辈子，行重载不丢）。 */
    repoResolver?: RepoResolver;
}
/** git 共同数据目录的解析与缓存（测试注入假 execFileSync 数调用次数）。 */
export interface RepoResolver {
    resolve(cwd: unknown): string | null;
}
export declare function createRepoResolver(deps?: {
    execFileSync?: typeof execFileSync;
}): RepoResolver;
/** 把三条路由挂到给定的 register 上；返回一次性清理函数（卸载全部注册）。 */
export declare function registerRoutes(deps: RouteDeps): () => void;
//# sourceMappingURL=routes.d.ts.map