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
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
/** GET /zcode-executor/stream：NDJSON 推送。 */
export const STREAM_ROUTE = '/zcode-executor/stream';
/** GET /zcode-executor/snapshot：一次性全量快照。 */
export const SNAPSHOT_ROUTE = '/zcode-executor/snapshot';
/** GET /zcode-executor/repo?cwd=…：cwd 的所属仓库。 */
export const REPO_ROUTE = '/zcode-executor/repo';
/** git 钩子会带 GIT_DIR 等变量压过 -C，判仓库前剥掉（zcode-executor 同款名单）。 */
const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];
/** 唯一的 JSON 响应出口：no-store、nosniff，照 zen-remote 的信封。 */
function responseJson(res, status, body) {
    const bytes = Buffer.from(JSON.stringify(body));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.writeHead(status);
    res.end(bytes);
}
/** admit 的拒绝原样回给浏览器（zen-remote 同款错误体）。 */
function refuse(res, rejection) {
    responseJson(res, rejection, {
        ok: false,
        error: { code: rejection === 401 ? 'unauthorized' : 'forbidden' },
    });
}
/**
 * method 墙（Task 8 ②，zen-remote 同款）：三条路由只认 GET。webServer 对不带 method 的
 * 请求按 GET 算；其余方法回 405 + Allow: GET 与 JSON 错误体。放在 admit 之后（zen-remote
 * 的墙序：admit 先行），admit 放行后的 GET 语义不变。
 */
function requireGet(req, res) {
    if ((req.method ?? 'GET') === 'GET')
        return true;
    res.setHeader('Allow', 'GET');
    responseJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'Use GET' } });
    return false;
}
export function createRepoResolver(deps = {}) {
    const runGit = deps.execFileSync ?? execFileSync;
    const repoByCwd = new Map();
    return {
        resolve(cwd) {
            if (typeof cwd !== 'string' || !isAbsolute(cwd) || !existsSync(cwd))
                return null;
            const hit = repoByCwd.get(cwd);
            if (hit !== undefined)
                return hit;
            let repo = null;
            try {
                const env = { ...process.env };
                for (const key of GIT_LOCATION_ENV)
                    delete env[key];
                const out = runGit('git', ['rev-parse', '--git-common-dir'], {
                    cwd,
                    env,
                    encoding: 'utf8',
                    timeout: 5000,
                    stdio: ['ignore', 'pipe', 'ignore'], // git 的原生报错不外漏
                });
                const commonDir = String(out).trim().split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? '';
                const abs = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
                if (basename(abs) === '.git') {
                    try {
                        repo = realpathSync(dirname(abs)); // 真实路径：watch 的 hello 与各会话快照的 repo 同口径
                    }
                    catch {
                        repo = null; // 目录没了等 realpath 失败：宁缺毋错
                    }
                }
            }
            catch {
                repo = null; // 不是 git 仓、裸仓库（common dir 不叫 .git 也落到这形状）、git 不可用
            }
            if (repo === null)
                return null;
            repoByCwd.set(cwd, repo);
            return repo;
        },
    };
}
/** 进程内共享的解析器：缓存活一辈子（watch 常驻也用它，执行副本被删的会话本就已结束）。 */
const sharedRepoResolver = createRepoResolver();
/** 把三条路由挂到给定的 register 上；返回一次性清理函数（卸载全部注册）。 */
export function registerRoutes(deps) {
    const repoResolver = deps.repoResolver ?? sharedRepoResolver;
    const writeLine = (res, line) => {
        // 背压结论（Task 8 ③ 评估，全文见 SPEC「Implementation Decisions」）：write 的返回值
        // 故意不查、不做 drain——单用户桌面端、本地回环、浏览器持续在读（响应头已带
        // X-Accel-Buffering: no 防反代攒批），表有界（首轮回放 240 条 ≈ 数百 KB，实测 244 行
        // 1.0s 内齐），write 返回 false 只是进了用户态缓冲等回环排空（毫秒级）。
        res.write(`${JSON.stringify(line)}\n`);
    };
    const disposers = [
        deps.register({
            kind: 'exact',
            path: STREAM_ROUTE,
            handler: (req, res) => {
                const admission = deps.admit(req);
                if ('rejection' in admission) {
                    refuse(res, admission.rejection);
                    return;
                }
                if (!requireGet(req, res))
                    return;
                res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.setHeader('X-Accel-Buffering', 'no'); // 别让反代把 NDJSON 攒住
                res.writeHead(200);
                // 头先行：中间件/代理攒正文时至少别攒头（2026-10-07 真机流缓冲排查补）。
                // 存在才调：测试桩的假 res 与个别宿主包装层没有这个方法。
                if (typeof res.flushHeaders === 'function')
                    res.flushHeaders();
                let closed = false;
                const unsubscribe = deps.watch.subscribe((event) => {
                    if (closed || res.destroyed)
                        return;
                    if (event.kind === 'line')
                        writeLine(res, event.line);
                    else
                        writeLine(res, { type: 'connection', link: event.link, message: event.message });
                });
                const close = () => {
                    if (closed)
                        return;
                    closed = true;
                    unsubscribe();
                    deps.watch.removeStreamClient();
                };
                res.on('close', close);
                // 先订阅再计数再读快照：起进程、断连不会落在缝里漏行
                deps.watch.addStreamClient();
                const snapshot = deps.watch.getSnapshot();
                writeLine(res, { type: 'connection', link: snapshot.link, message: snapshot.message });
                if (snapshot.synced) {
                    // 补一轮 hello+表+synced（hello 的 repo 照归约器约定不参与过滤，各会话快照自带 repo）
                    writeLine(res, { type: 'hello', repo: null });
                    for (const session of Object.values(snapshot.table))
                        writeLine(res, { type: 'session', session });
                    writeLine(res, { type: 'synced' });
                }
            },
        }),
        deps.register({
            kind: 'exact',
            path: SNAPSHOT_ROUTE,
            handler: (req, res) => {
                const admission = deps.admit(req);
                if ('rejection' in admission) {
                    refuse(res, admission.rejection);
                    return;
                }
                if (!requireGet(req, res))
                    return;
                responseJson(res, 200, deps.watch.getSnapshot());
            },
        }),
        deps.register({
            kind: 'exact',
            path: REPO_ROUTE,
            handler: (req, res) => {
                const admission = deps.admit(req);
                if ('rejection' in admission) {
                    refuse(res, admission.rejection);
                    return;
                }
                if (!requireGet(req, res))
                    return;
                const url = new URL(req.url ?? REPO_ROUTE, 'http://dsh.internal');
                responseJson(res, 200, { repo: repoResolver.resolve(url.searchParams.get('cwd')) });
            },
        }),
    ];
    return () => {
        for (const dispose of disposers)
            dispose();
    };
}
//# sourceMappingURL=routes.js.map