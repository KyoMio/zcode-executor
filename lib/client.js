window.__ModuleLoader__.load({ id: "dsh-zcode-executor", factory: (require) => {
var __modules = {};
__modules["client/reducer.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emptyState = emptyState;
exports.applyEvent = applyEvent;
/** 初始状态（CC mod EMPTY_PANEL 的去展示字段版：展示用的连接态与时间归渲染层，Task 4/5）。 */
function emptyState() {
    return { table: {}, baseline: {}, synced: false };
}
/**
 * 处理一个事件，返回新状态（输入原样不动）。语义：
 * hello 开始一轮新基线并回到未同步（旧表保留到 synced，断连期间面板不清屏）；
 * 未同步时 session/removed 只动基线（重连后的首轮变化不当作面板更新）；
 * synced 行把基线整体换上成为正式表；已同步时 session 进表、removed 从表删。
 * connection 的 down / starting 同样回到未同步（之后的行只进基线），live / failed 不改同步态。
 * 认不出的行原样返回。
 */
function applyEvent(state, msg) {
    const { table, baseline, synced } = state;
    if (isEvent(msg, 'hello')) {
        // hello 带的 repo 故意不存进状态：每条会话快照各带自己的 repo，按仓库过滤由客户端
        // 拿 sessions + repo 自己路由（SPEC 客户端半场），不同于 CC mod 把 repo 记在 panel 上。
        return { table, baseline: {}, synced: false };
    }
    // id 只认字符串：JSON.parse 的行不受类型标注约束，数字 id 经计算键会变成 "42"，整行忽略
    if (isEvent(msg, 'session') && typeof msg.session?.id === 'string') {
        const s = msg.session;
        if (!synced)
            return { table, baseline: { ...baseline, [s.id]: s }, synced };
        return { table: { ...table, [s.id]: s }, baseline, synced };
    }
    if (isEvent(msg, 'removed') && typeof msg.id === 'string') {
        if (!synced) {
            const { [msg.id]: _gone, ...rest } = baseline;
            return { table, baseline: rest, synced };
        }
        const { [msg.id]: _gone, ...rest } = table;
        return { table: rest, baseline, synced };
    }
    if (isEvent(msg, 'synced')) {
        return { table: { ...baseline }, baseline: {}, synced: true };
    }
    if (isEvent(msg, 'connection') && (msg.link === 'down' || msg.link === 'starting')) {
        return { table, baseline, synced: false };
    }
    return state;
}
/** 事件类型守卫：客户端拿到的行是 JSON.parse 的未知形状，先认 type 再认字段。 */
function isEvent(msg, type) {
    return typeof msg === 'object' && msg !== null && msg.type === type;
}
};
__modules["client/session-cwd.js"] = function (require, module, exports) {
"use strict";
// src/client/session-cwd.ts —— 「当前项目」的派生（SPEC 客户端半场：优先主会话行，
// 无会话退工作区列表），Task 5 接 DSH ctx 时用。纯函数：不 import、不 fetch、不碰 DOM，
// 对缺字段容错（typeof 守卫）。
//
// 行形状照 dsh-zen-remote src/client/compat/types.ts 的结构镜像法：宿主两版的类型不同
// （0.1.1 SessionSummary 在 dsh-client-runtime、0.1.2 起在 dsh-api-session-controller）
// 且本插件依赖里没有这两个包，只镜像真正读的字段——mainView 读法与该文件 mainSessionIdOf
// 相同：retainedBy.mainView > 0 即「主视图正打开这个会话」，官方 uiSession publishMain
// 同款挑选（全表找第一条 mainView retain）。工作区字段对照 ~/.dsh/profiles/node_modules/
// @deepseek-ai/dsh-workspace/lib/types/types.d.ts 的 Workspace（path、updatedAt ISO-8601）。
//
// PB-6 起派生「主会话 id」与「侧」：远程会话（dsh-zen-remote 插件桥）在子客户端里用
// `zr~<serverId>~<原始 id>` 的虚拟 id（zen-remote src/virtual-id.ts 的形状，serverId 是
// 8 位 hex——这里只认前缀与分隔符，不复制 hex 校验：桥若放宽形状，误判成本机会让面板
// 悄悄显示本机数据，比放过一个非标 serverId 危险）。侧决定面板数据源：远程侧的取数请求
// 带 `?sessionId=<虚拟 id>`，由桥改道到主服务端；本机侧不带（打到本机路由）。
Object.defineProperty(exports, "__esModule", { value: true });
exports.VIRTUAL_ID_PREFIX = void 0;
exports.mainSessionCwdOf = mainSessionCwdOf;
exports.mainSessionIdOf = mainSessionIdOf;
exports.sideOfSessionId = sideOfSessionId;
exports.sideEquals = sideEquals;
exports.pickWorkspacePath = pickWorkspacePath;
/**
 * 主视图会话的 cwd：目录里第一条 retainedBy.mainView > 0 的行。行缺 cwd（子代理行等）
 * 同样算没有——返回 null，调用方退工作区路径。
 * rows 是普通数组、按顺序先到先得（官方 publishMain 同款挑第一条）；T5 接线传
 * ctx.sessions.list() 的原序或 Object.values(byId 表) 皆可，本函数不排序。
 * @param rows - ctx.sessions.list 的行。
 * @returns 主视图会话的 cwd，没有主视图行或 cwd 缺失时 null。
 */
function mainSessionCwdOf(rows) {
    const row = firstMainViewRow(rows);
    if (row === null)
        return null;
    return typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null;
}
/**
 * 主视图会话的 id（PB-6）：与 mainSessionCwdOf 同一行（retainedBy.mainView > 0 的第一行）。
 * id 是 store 取数请求的 sessionId 参数（远程会话为 `zr~<serverId>~<id>` 虚拟形式，桥凭
 * 它改道）。行两种 id 形状都认（见 SessionRowLike 注）；都缺时 null——不带参数即本机行为。
 * @param rows - ctx.sessions.list 的行。
 * @returns 主视图会话的 id，没有主视图行或 id 缺失时 null。
 */
function mainSessionIdOf(rows) {
    const row = firstMainViewRow(rows);
    if (row === null)
        return null;
    if (typeof row.sessionId === 'string' && row.sessionId !== '')
        return row.sessionId;
    return typeof row.id === 'string' && row.id !== '' ? row.id : null;
}
/** 目录里第一条主视图行（官方 publishMain 同款先到先得），没有则 null。 */
function firstMainViewRow(rows) {
    for (const row of rows) {
        if ((row.retainedBy?.mainView ?? 0) > 0)
            return row;
    }
    return null;
}
/** zen-remote 插件桥的虚拟会话 id 前缀（`zr~<serverId>~<原始 id>`，src/virtual-id.ts 同款）。 */
exports.VIRTUAL_ID_PREFIX = 'zr~';
/**
 * 会话 id → 侧（PB-6）：`zr~` 前缀 + 非空 serverId 段 = 远程侧；本机 id（session-…）、
 * null、以及前缀后面不带 serverId 段的坏形状都算本机（坏虚拟 id 打到本机路由自然兜底，
 * 不会让面板挂死）。同侧判定只比较 serverId 字符串，不解析它的含义。
 * @param id - 主会话 id（mainSessionIdOf 的产出；null = 没有主会话）。
 * @returns 侧。
 */
function sideOfSessionId(id) {
    if (id === null || !id.startsWith(exports.VIRTUAL_ID_PREFIX))
        return { kind: 'local' };
    const rest = id.slice(exports.VIRTUAL_ID_PREFIX.length);
    const separator = rest.indexOf('~');
    if (separator <= 0)
        return { kind: 'local' };
    return { kind: 'remote', serverId: rest.slice(0, separator) };
}
/** 两侧是否同侧：本机只跟本机同侧；远程侧再比 serverId（同机换会话算同侧）。 */
function sideEquals(a, b) {
    if (a.kind !== b.kind)
        return false;
    return a.kind === 'remote' && b.kind === 'remote' ? a.serverId === b.serverId : true;
}
/**
 * 工作区列表的 cwd 回退：唯一项直接取 path；多项取 updatedAt 最近的一条（ISO-8601 字符串
 * 字典序即时间序；缺 updatedAt 当最旧，同刻先到先得）。空列表或选中项缺 path 返回 null。
 * @param items - ctx.workspaces.list 的行。
 * @returns 工作区 path，没有可用项时 null。
 */
function pickWorkspacePath(items) {
    let best = null;
    for (const item of items) {
        if (best === null || String(item.updatedAt ?? '') > String(best.updatedAt ?? ''))
            best = item;
    }
    if (best === null)
        return null;
    return typeof best.path === 'string' && best.path !== '' ? best.path : null;
}
};
__modules["client/store.js"] = function (require, module, exports) {
"use strict";
// src/client/store.ts —— 面板的快照取数 store：fetch GET /zcode-executor/stream 流式读
// （ReadableStream + TextDecoder 按行切，逐行过 T2 归约器），流断开或 fetch 异常退化为
// GET /zcode-executor/snapshot 每 pollMs 轮询兜底，并按 retryMs 重试流，流恢复即停轮询。
// 对外 getState / subscribe（useSyncExternalStore 兼容）/ start / stop / setScopeRepo；
// 内部状态 = 归约器三键（table/baseline/synced，src/client/reducer.ts）+ 连接态 link/message
// + 过滤仓库 scopeRepo（过滤本身由消费方做，store 只存）。
//
// 浏览器目标：不 import node:*，fetch/ReadableStream/TextDecoder/AbortController 全局即得。
// 因此 stream/snapshot 两条路径常量在本文件复制（src/routes.ts 带 node:child_process 等，
// 客户端不能引，构建内联会炸）；两边不一致时以 routes.ts 为准。
//
// snapshot 的喂法与流等价：先照响应体喂一条 connection 事件，已同步再走一轮
// hello + 表 + synced（routes.ts stream 路由对已同步新客户端的回放形状）——归约器语义
// 下这正好是「整表换血 + 回到已同步」，断流期间错过的一切由此对齐。
//
// 连接态语义：link/message 只由服务端事件驱动（流的 connection 行、snapshot 响应体），
// 照 T2 归约器语义进状态；唯传递层自己出问题时 store 合成连接行，且三种病因各说各话（Task 8 ⑥）：
// 连 snapshot 都拉不到 → down「实时连接中断」（服务端已报 failed 时不覆盖——起不来的诊断优先）；
// snapshot 回 401/403 → down「无权访问（admit 拒绝）」（传输是通的，病根在鉴权，不说「连接中断」）。
// fetch 首响应限时 firstResponseMs（Task 8 ⑤）：服务器收 TCP 不回时 fetch 永久挂起，
// 超时按连接失败走退化；响应头到达即拆闹钟，流/正文的后续读取不限时（空闲是常态）。
// 流挂、轮询挂这类退化各 console.warn 一条（去重位拦周期性重复，恢复即复位），其余全程静默。
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPO_PATH = exports.SNAPSHOT_PATH = exports.STREAM_PATH = void 0;
exports.unbridgedMessageOf = unbridgedMessageOf;
exports.createSnapshotStore = createSnapshotStore;
const reducer_ts_1 = require("./client/reducer.js");
const session_cwd_ts_1 = require("./client/session-cwd.js");
/** 与 src/routes.ts 的 STREAM_ROUTE 一致（那边 import node:*，客户端不能引；测试断言两边相等防漂移）。 */
exports.STREAM_PATH = '/zcode-executor/stream';
/** 与 src/routes.ts 的 SNAPSHOT_ROUTE 一致（同上，测试断言相等）。 */
exports.SNAPSHOT_PATH = '/zcode-executor/snapshot';
/** 与 src/routes.ts 的 REPO_ROUTE 一致（同上；GET /…?cwd=… 返回 { repo }）。 */
exports.REPO_PATH = '/zcode-executor/repo';
const LINKS = ['starting', 'live', 'down', 'failed'];
/** admit 拒绝（snapshot 回 401/403）时合成的连接说明：传输是通的，病根在鉴权（Task 8 ⑥）。 */
const AUTH_DENIED_MESSAGE = '无权访问（admit 拒绝）：本机登录态可能已失效，重新登录 DSH 后自动恢复';
/** 子客户端 zen-remote 拦截层回未桥接时的响应标记：503 + 这个响应头（PB-6 协议）。 */
const UNBRIDGED_HEADER = 'x-zen-remote';
const UNBRIDGED_HEADER_VALUE = 'unbridged';
/** 未桥接体的错误码（协议定死；头是简写、体带 reason 细分）。 */
const UNBRIDGED_CODE = 'zr-plugin-unbridged';
/**
 * 未桥接 reason → 面板横幅的中文原因（PB-6 口径四类 + 其他附原文）。导出供测试对表。
 * not-on-server 与 version-mismatch 都归「服务端未安装同版本插件」——前者没装、后者装
 * 的不是同一版，对用户是同一件事：两端装同版本。
 */
function unbridgedMessageOf(reason) {
    switch (reason) {
        case 'not-on-server':
        case 'version-mismatch':
            return '远程面板暂不可用：主服务端未安装同版本的本插件（两端装同版本后自动恢复）。';
        case 'consent-off':
            return '远程面板暂不可用：主服务端未允许转发整机数据（主服务端主人在 zen-remote 设置里同意后自动恢复）。';
        case 'offline':
            return '远程面板暂不可用：中继离线（远程链路恢复后自动重试）。';
        case 'server-too-old':
            return '远程面板暂不可用：主服务端的 zen-remote 版本过旧（升级服务端后自动恢复）。';
        default:
            return `远程面板暂不可用（插件桥未桥接，原因：${reason}），恢复后自动重试。`;
    }
}
/** 连接态守卫：JSON 来的字段不受类型标注约束，先认值再存。 */
function isLink(value) {
    return typeof value === 'string' && LINKS.includes(value);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
/** 把未知抛出物变成一行可读文字（console 提示用）。 */
function describeError(err) {
    return err instanceof Error ? err.message : String(err);
}
/**
 * 建一个快照 store。构造后不取数，start() 才连；stop() 后可再 start() 从头连。
 * @param options - baseUrl 与两个注入计时（测试给小值）。
 * @returns store。
 */
function createSnapshotStore(options) {
    // 尾斜杠剥一次：调用方传 'http://host/' 时拼出 //zcode-executor/stream 会静默 404
    const baseUrl = options.baseUrl.replace(/\/+$/, '');
    const pollMs = options.pollMs ?? 1000;
    const retryMs = options.retryMs ?? 3000;
    // 0 或负数的间隔会让轮询/重试变成紧密循环打爆服务器，构造时就拒绝
    if (!Number.isFinite(pollMs) || pollMs <= 0) {
        throw new Error(`createSnapshotStore：pollMs 必须是正的有限数，收到 ${pollMs}`);
    }
    if (!Number.isFinite(retryMs) || retryMs <= 0) {
        throw new Error(`createSnapshotStore：retryMs 必须是正的有限数，收到 ${retryMs}`);
    }
    const firstResponseMs = options.firstResponseMs ?? 15_000;
    if (!Number.isFinite(firstResponseMs) || firstResponseMs <= 0) {
        throw new Error(`createSnapshotStore：firstResponseMs 必须是正的有限数，收到 ${firstResponseMs}`);
    }
    const safetyPollMs = options.safetyPollMs ?? 2_000;
    if (!Number.isFinite(safetyPollMs) || safetyPollMs < 0) {
        throw new Error(`createSnapshotStore：safetyPollMs 必须是非负有限数（0 关闭），收到 ${safetyPollMs}`);
    }
    const unbridgedRetryMs = options.unbridgedRetryMs ?? 5_000;
    if (!Number.isFinite(unbridgedRetryMs) || unbridgedRetryMs <= 0) {
        throw new Error(`createSnapshotStore：unbridgedRetryMs 必须是正的有限数，收到 ${unbridgedRetryMs}`);
    }
    let state = { ...(0, reducer_ts_1.emptyState)(), link: 'starting', message: null, scopeRepo: null, dataAt: 0 };
    const listeners = new Set();
    let running = false;
    let polling = false;
    /**
     * 当前主会话 id（setSession 存的）：stream/snapshot 请求带 `?sessionId=<id>`，null 不带
     * （本机行为）。远程会话的 id 是 `zr~<serverId>~<id>` 虚拟形式，由桥改道。
     */
    let sessionId = null;
    /** 正在跑的取数连接的侧（连接发起时记下）：侧变化重开的判据。null = 还没连过。 */
    let liveSide = null;
    /** 上次响应是否「未桥接」（503 + x-zen-remote: unbridged）：重试节奏放宽 + 横幅换文案。 */
    let unbridged = false;
    /** 退化提示去重位：每次退化只 console 一条，流恢复即复位（别让轮询/重试的周期性失败刷屏）。 */
    let warnedDegraded = false;
    /** 安全网失败的独立去重位：安全网失败不改变连接态（流还活着），但一行告警必须有——
     *  2026-10-07 真机教训：静默失败让「流被缓冲且安全网也挂」的组合完全不可见。 */
    let warnedSafety = false;
    let streamController = null;
    let pollController = null;
    let pollTimer = null;
    let retryTimer = null;
    let safetyTimer = null;
    const notify = () => {
        // 遍历快照：某个回调里退订（或新订）不影响本轮（dsh-zen-remote compat/store.ts 同款）
        for (const fn of [...listeners])
            fn();
    };
    /** 取数请求的会话参数：有主会话才带（桥凭它改道；本机路由的 sessionId 分支也认它）。 */
    const sessionQuery = () => (sessionId !== null ? `?sessionId=${encodeURIComponent(sessionId)}` : '');
    /** 未桥接时节奏放宽到不短于 unbridgedRetryMs（「不疯狂重试」），平时照常规。 */
    const retryDelayNow = () => (unbridged ? Math.max(retryMs, unbridgedRetryMs) : retryMs);
    const pollDelayNow = () => (unbridged ? Math.max(pollMs, unbridgedRetryMs) : pollMs);
    /** 响应是不是子客户端拦截层回的「未桥接」（PB-6 协议：503 + x-zen-remote: unbridged）。 */
    const isUnbridged = (res) => res.status === 503 && res.headers.get(UNBRIDGED_HEADER) === UNBRIDGED_HEADER_VALUE;
    /** 未桥接体里的 reason（协议形状 {"ok":false,"error":{"code","reason"}}），读不出回 'unknown'。 */
    const reasonOfUnbridged = async (res) => {
        try {
            const body = (await res.json());
            if (body?.error?.code === UNBRIDGED_CODE && typeof body.error.reason === 'string' && body.error.reason !== '') {
                return body.error.reason;
            }
        }
        catch {
            // 体不是 JSON / 已被消费：头已证明是未桥接，reason 未知
        }
        return 'unknown';
    };
    /** 未桥接进面板：合成 down + 中文原因（沿用横幅位置），不喂 503 体（它不是快照数据）。 */
    const noteUnbridged = (reason) => {
        unbridged = true;
        const message = unbridgedMessageOf(reason);
        if (state.link === 'down' && state.message === message)
            return; // 同原因不重复打扰订阅者
        const before = state;
        accept({ type: 'connection', link: 'down', message });
        if (state !== before)
            notify();
    };
    /**
     * 首响应闹钟（Task 8 ⑤）：给一次 fetch 挂上「多久没等到响应头就 abort」的计时。
     * 响应头一到必须 disarm（之后的正文/流读不限时——流空闲本来就可能很久）；超时的 abort
     * 与 stop() 的主动 abort 都让 fetch 以 rejection 收场，靠 timedOut() 区分：前者算连接失败
     * 走退化，后者是主动停、静默。
     */
    const armFirstResponse = (controller) => {
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, firstResponseMs);
        return {
            timedOut: () => timedOut,
            disarm: () => {
                clearTimeout(timer);
            },
        };
    };
    /**
     * 一条事件进归约器（静默，不通知）。connection 行顺带把 link/message 存进状态
     * （归约器只管同步语义，展示用的连接态归 store）。无事发生时不换引用。
     */
    const accept = (msg) => {
        const prev = state;
        const core = (0, reducer_ts_1.applyEvent)(prev, msg);
        let link = prev.link;
        let message = prev.message;
        // link 不认识就整行不认：非法 connection 行连 message 都不更新（归约器对它同样零副作用）
        if (isRecord(msg) && msg.type === 'connection' && isLink(msg.link)) {
            link = msg.link;
            message = typeof msg.message === 'string' ? msg.message : null;
        }
        if (core === prev && link === prev.link && message === prev.message)
            return;
        state = { ...core, link, message, scopeRepo: prev.scopeRepo, dataAt: Date.now() };
    };
    /** snapshot 响应体走与流等价的归约路径：connection 事件 +（已同步时）hello+表+synced 回放。 */
    const acceptSnapshot = (body) => {
        if (!isRecord(body))
            return;
        const { link, message, synced, table } = body;
        if (!isLink(link))
            return;
        const before = state;
        accept({ type: 'connection', link, message: typeof message === 'string' ? message : null });
        if (synced === true && isRecord(table)) {
            accept({ type: 'hello', repo: null });
            for (const session of Object.values(table))
                accept({ type: 'session', session });
            accept({ type: 'synced' });
        }
        if (state !== before)
            notify();
    };
    /** 流断开：进轮询兜底，并按 retryMs 重试流（未桥接时放宽节奏）。 */
    const onStreamDown = () => {
        if (!running)
            return;
        startPolling();
        retryTimer = setTimeout(() => {
            retryTimer = null;
            void connectStream();
        }, retryDelayNow());
    };
    const startPolling = () => {
        if (polling || !running)
            return;
        polling = true;
        pollTimer = setTimeout(() => void runPoll('degraded'), pollDelayNow());
    };
    /** 流活着时的安全网轮询：低频拉 snapshot，防传输层把流缓冲住（见 options.safetyPollMs 注）。 */
    const startSafetyPoll = () => {
        if (safetyPollMs <= 0 || safetyTimer !== null || !running)
            return;
        safetyTimer = setTimeout(() => void runPoll('safety'), safetyPollMs);
    };
    const stopPolling = () => {
        polling = false;
        if (pollTimer !== null) {
            clearTimeout(pollTimer);
            pollTimer = null;
        }
    };
    /**
     * 一轮 snapshot 轮询：拉得到喂归约器，拉不到/超时合成 down；degraded（流断的兜底，按 pollMs
     * 连轴转）与 safety（流活着的安全网，按 safetyPollMs 低频）共用本体，只在「响应要不要收」与
     * 「下一轮要不要排」上分叉：degraded 在流恢复后丢弃晚到响应（不倒拨新状态），safety 只要还
     * 在跑就收（响应取自服务端当前状态，与服务端发给流的是同一份，回环毫秒级的在途差不构成倒拨）。
     */
    const runPoll = async (mode) => {
        if (mode === 'degraded') {
            pollTimer = null;
            if (!running || !polling)
                return;
        }
        else {
            safetyTimer = null;
            if (!running)
                return;
        }
        const controller = new AbortController();
        pollController = controller;
        const alarm = armFirstResponse(controller);
        try {
            const res = await fetch(`${baseUrl}${exports.SNAPSHOT_PATH}${sessionQuery()}`, {
                signal: controller.signal,
                cache: 'no-store', // 防任何 HTTP 缓存层扣下 GET 响应（2026-10-07 真机排查加）
            });
            alarm.disarm(); // 响应头到了：本轮不再限时
            if (isUnbridged(res)) {
                // 插件桥没桥上（远程会话）：横幅说原因、节奏放宽，绝不退化成本机数据
                //（请求始终带 sessionId，桥恢复后自动接上）
                noteUnbridged(await reasonOfUnbridged(res));
            }
            else if (res.status === 401 || res.status === 403) {
                // 服务端明确拒了鉴权：传输其实是通的，「连接中断」会误导排障（Task 8 ⑥）
                noteAuthDenied();
            }
            else {
                if (!res.ok)
                    throw new Error(`snapshot HTTP ${res.status}`);
                unbridged = false; // 正常响应：未桥接解除（如主人刚在服务端点了同意），节奏回常规
                const body = await res.json();
                if (running && (mode === 'safety' || polling))
                    acceptSnapshot(body);
            }
        }
        catch (err) {
            alarm.disarm();
            // stop 的主动 abort（running 已为 false）静默；超时的 abort 算连接失败，不吞
            if (!running || (controller.signal.aborted && !alarm.timedOut()))
                return;
            // 安全网的失败不打扰连接态（流还活着），但各病因打一条告警（去重）：静默失败曾让
            // 「流被缓冲 + 安全网也挂」的组合整整一天不可见（2026-10-07 教训）
            if (mode === 'safety' && !warnedSafety) {
                warnedSafety = true;
                console.warn(`[zcode-executor] 安全网 snapshot 拉取失败（流仍连着，中途输出可能不刷新）：${alarm.timedOut() ? `${firstResponseMs}ms 没等到响应` : describeError(err)}`);
            }
            if (mode === 'degraded') {
                // 每次退化只提示一条：去重位拦住之后轮询周期的重复失败，别刷屏
                if (!warnedDegraded) {
                    warnedDegraded = true;
                    console.warn(`[zcode-executor] snapshot 轮询不可达，连接态转 down：${alarm.timedOut() ? `${firstResponseMs}ms 没等到响应` : describeError(err)}`);
                }
                noteTransportDown();
            }
        }
        finally {
            if (pollController === controller)
                pollController = null;
        }
        if (mode === 'degraded') {
            if (running && polling)
                pollTimer = setTimeout(() => void runPoll('degraded'), pollDelayNow());
        }
        else if (running && !polling) {
            // 退化轮询接管期间安全网不排；流恢复（stopPolling）后由恢复点重排
            safetyTimer = setTimeout(() => void runPoll('safety'), safetyPollMs);
        }
    };
    /** 连 snapshot 都不可达：整个数据源看不见了，合成 down（已在 down / failed 不重复打扰订阅者）。 */
    const noteTransportDown = () => {
        // failed 是服务端自己的诊断（watch 起不来 + 原因），transport 全断盖不掉它——
        // 「起不来」比「看不见」更接近病根，覆盖掉会误导排障（Task 8 ⑥）
        if (state.link === 'down' || state.link === 'failed')
            return;
        const before = state;
        accept({ type: 'connection', link: 'down', message: '实时连接中断，正在重试' });
        if (state !== before)
            notify();
    };
    /** admit 拒绝（401/403）：连接态仍记 down（横幅位置不变），message 把病根与出路说清；
     *  轮询照常继续，用户重新登录后下一轮自动恢复（Task 8 ⑥）。
     *  与 noteTransportDown 的守卫不对称是有意的：401/403 是服务端的权威响应而非本函数合成的
     *  down——响应能回来本身就证明传输是通的，病根在鉴权；所以它允许更新 failed（「起不来」的
     *  旧诊断在服务端亲口改判「请求被拒」时让位于更接近病根的说法），而 transport 全断只是
     *  「看不见」，那个猜测盖不掉服务端自己的 failed 诊断。 */
    const noteAuthDenied = () => {
        if (state.link === 'down' && state.message === AUTH_DENIED_MESSAGE)
            return;
        const before = state;
        accept({ type: 'connection', link: 'down', message: AUTH_DENIED_MESSAGE });
        if (state !== before)
            notify();
    };
    /** 连一次流：逐行喂归约器；任何形状的收场（读到底、报错、被掐、首响应超时）都走断流处理。 */
    const connectStream = async () => {
        if (!running)
            return;
        const controller = new AbortController();
        streamController = controller;
        const alarm = armFirstResponse(controller);
        liveSide = (0, session_cwd_ts_1.sideOfSessionId)(sessionId); // 本连接的侧：之后 setSession 的侧变化据此判重开
        try {
            const res = await fetch(`${baseUrl}${exports.STREAM_PATH}${sessionQuery()}`, {
                signal: controller.signal,
                headers: { accept: 'application/x-ndjson' },
                cache: 'no-store', // 同上：流请求也不许任何缓存层介入
            });
            alarm.disarm(); // 响应头到了：之后的流读不限时（watch 空闲时长时间无行是常态）
            if (isUnbridged(res))
                noteUnbridged(await reasonOfUnbridged(res));
            if (!res.ok || res.body === null)
                throw new Error(`stream HTTP ${res.status}`);
            unbridged = false; // 流接上了：未桥接解除，节奏回常规
            stopPolling(); // 流恢复即停退化轮询；若刚连上又断，onStreamDown 会再排
            startSafetyPoll(); // 安全网回到低频节奏（退化期间它让位）
            warnedDegraded = false; // 流活了：退化提示位复位，下次再退化才再提示
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (controller.signal.aborted)
                    return;
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                let newline = buffer.indexOf('\n');
                while (newline !== -1) {
                    const line = buffer.slice(0, newline).trim();
                    buffer = buffer.slice(newline + 1);
                    newline = buffer.indexOf('\n');
                    if (!line)
                        continue;
                    let parsed;
                    try {
                        parsed = JSON.parse(line);
                    }
                    catch {
                        continue; // 坏行跳过（服务端对坏行同款容错）
                    }
                    const before = state;
                    accept(parsed);
                    if (state !== before)
                        notify();
                }
            }
            // 正常读到底也是断流（服务端关了流）；残缺的末行没有换行符，视为截断丢弃
        }
        catch (err) {
            alarm.disarm();
            // abort（stop）或网络错或首响应超时：都落到下面的统一断流处理，由 running/timedOut 区分
            // 主动 stop 不算退化，静默；真失败与超时各打一条（去重位拦住重试期的周期性重复）
            if (running && !warnedDegraded) {
                warnedDegraded = true;
                console.warn(`[zcode-executor] 实时流连接失败，退化为 snapshot 轮询兜底：${alarm.timedOut() ? `${firstResponseMs}ms 没等到响应` : describeError(err)}`);
            }
        }
        finally {
            if (streamController === controller)
                streamController = null;
        }
        if (!running)
            return;
        if (controller.signal.aborted && !alarm.timedOut())
            return; // stop 的主动掐断不算退化
        onStreamDown();
    };
    /** 停掉在途取数（定时器与两个 abort），不动 running：stop 与侧切换重开共用。 */
    const halt = () => {
        stopPolling();
        if (retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
        if (safetyTimer !== null) {
            clearTimeout(safetyTimer);
            safetyTimer = null;
        }
        streamController?.abort();
        streamController = null;
        pollController?.abort();
        pollController = null;
    };
    /** 侧切换的清屏：表/基线/同步态归零、连接态回 starting；scopeRepo 是外层的过滤意图，保留。 */
    const resetForSide = () => {
        state = { ...(0, reducer_ts_1.emptyState)(), link: 'starting', message: null, scopeRepo: state.scopeRepo, dataAt: 0 };
        unbridged = false;
        notify();
    };
    return {
        getState: () => state,
        subscribe: (fn) => {
            listeners.add(fn);
            return () => {
                listeners.delete(fn);
            };
        },
        start: () => {
            if (running)
                return;
            running = true;
            startSafetyPoll();
            void connectStream();
        },
        stop: () => {
            running = false;
            halt();
        },
        setSession: (next) => {
            const side = (0, session_cwd_ts_1.sideOfSessionId)(next);
            // 正在跑的连接与新的侧不同侧才重开（本机 ↔ 远程、或两台主服务端之间）；同侧内换
            // 会话只换后续请求的参数，数据是整机的、流不动。liveSide 为 null（还没连过/已停）
            // 时不重开：start 的下一次连接自然用新参数。
            const restart = running && liveSide !== null && !(0, session_cwd_ts_1.sideEquals)(liveSide, side);
            sessionId = next;
            if (!restart)
                return;
            halt(); // 关掉当前流与兜底（在途的无参/旧侧请求作废）
            resetForSide(); // 清空面板数据：旧侧的整机数据对新侧是错的
            void connectStream();
        },
        setScopeRepo: (repo) => {
            if (state.scopeRepo === repo)
                return;
            state = { ...state, scopeRepo: repo };
            notify();
        },
    };
}
};
__modules["client/view.js"] = function (require, module, exports) {
"use strict";
// SPDX-License-Identifier: Apache-2.0
// 衍生自 zcode-executor（github.com/kyomio/zcode-executor）的 hooks/view.mjs（Apache-2.0），
// 2026-10-07 搬入；本文件继续按 Apache-2.0 授权，许可证全文见上游仓库 LICENSE。
// src/client/view.ts —— 观察面板的纯计算：按所属仓库过滤、分三段、结果与标题文案、时长角标、
// 回复折叠判定。自 zcode-executor 的 hooks/view.mjs 逐字搬入（2026-10-07），只加 TypeScript
// 类型不改逻辑；语义与其 test/view.test.mjs 对齐（本插件的 test/view.test.mjs 是等价改写）。
// 不搬 CC mod 专属的 toastsFor / statusLine / applyLine / EMPTY_PANEL / startFailure；
// scopeNote / repoName 也在搬运清单之外（面板层的范围说明与仓库名，Task 5 需要时再补）。
// 输入是 watch --json 的快照，字段表见 zcode-executor PRD 第 4 节与 lib/snapshot.mjs:242-260。
// 纯函数：不 import lib/（mod 运行环境没有 Node 的约定沿用），不碰 DOM、不 fetch。
Object.defineProperty(exports, "__esModule", { value: true });
exports.filterByRepo = filterByRepo;
exports.outcomeOf = outcomeOf;
exports.headOf = headOf;
exports.elapsed = elapsed;
exports.cornerOf = cornerOf;
exports.sectionsOf = sectionsOf;
exports.plainLine = plainLine;
exports.replyFold = replyFold;
// 已结束成卡片的窗口 30 分钟（2026-10-07 用户改规格，CC mod 原值 10 分钟）；已结束行可点开
// 成卡片（交互在 pane/cards 层，本文件只管分段）。回复折叠阈值 replyFold 见其自身注释。
const RECENT_MS = 30 * 60 * 1000; // 结束 30 分钟内的会话在「已结束」里以卡片显示
const DONE_LIMIT = 5;
const OUTCOMES = {
    done: { glyph: '✓', label: '已完成', color: 'success' },
    timeout: { glyph: '◷', label: '已超时', color: 'warning' },
    failed: { glyph: '✕', label: '执行失败', color: 'error' },
    exited: { glyph: '✕', label: '执行失败', color: 'error' },
    cancelled: { glyph: '–', label: '已取消', color: 'inactive' },
};
const timeOf = (iso) => (iso ? Date.parse(iso) : NaN);
/** 只留所属仓库等于 repo 的会话；repo 为 null（Claude 会话不在 git 仓库里）时全留。repo 为 null 的会话在过滤时隐藏。 */
function filterByRepo(sessions, repo) {
    if (repo === null || repo === undefined)
        return [...sessions];
    return sessions.filter((s) => s.repo === repo);
}
/** 已结束会话的结果文案：exited 没有结果记录时是「已退出」，idle 没有结果是「空闲」。 */
function outcomeOf(session) {
    const known = OUTCOMES[session.lastOutcome ?? ''];
    if (known)
        return known;
    if (session.phase === 'idle')
        return { glyph: '○', label: '空闲', color: 'inactive' };
    if (session.lastOutcome === null || session.lastOutcome === undefined)
        return { glyph: '–', label: '已退出', color: 'inactive' };
    return { glyph: '?', label: String(session.lastOutcome), color: 'inactive' };
}
/** 卡片标题的状态文案与配色；kind 告诉布局用哪种图标（pulse 脉冲、wait 转圈、其余用 glyph）。 */
function headOf(session) {
    if (session.phase === 'stale')
        return { kind: 'glyph', glyph: '⚠', label: '执行进程已中断', color: 'error' };
    if (session.phase === 'pending') {
        const p = session.pendingDetail;
        const label = p?.kind === 'question'
            ? `挂起：提问 ${p.questionTexts?.length ?? 0} 条`
            : `挂起：审批请求（${p?.toolName ?? '未知工具'}）`;
        return { kind: 'glyph', glyph: '⏸', label, color: 'warning' };
    }
    const q = session.offpeakQueue;
    if (session.phase === 'running' && q?.phase === 'queued') {
        return { kind: 'wait', label: q.position === null || q.position === undefined ? '闲时排队中' : `闲时排队中，第 ${q.position} 位`, color: 'suggestion' };
    }
    if (session.phase === 'running' && q?.phase === 'ready')
        return { kind: 'wait', label: '闲时已就绪，等待开始', color: 'suggestion' };
    return { kind: 'pulse', label: '执行中', color: 'success' };
}
/** 「N 分钟」「N 小时 M 分」；since 为空或解析不了给 null（卡片右上角就不显示）。 */
function elapsed(since, now) {
    const t = timeOf(since);
    if (Number.isNaN(t))
        return null;
    const m = Math.max(0, Math.floor((now - t) / 60000));
    if (m < 1)
        return '不到 1 分钟';
    if (m < 60)
        return `${m} 分钟`;
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}
/** 卡片右上角：执行中「已运行」、挂起「已等待」、排队「已排」、中断只写时长。 */
function cornerOf(session, now) {
    const span = elapsed(session.since, now);
    if (span === null)
        return null;
    if (session.phase === 'stale')
        return span;
    if (session.phase === 'pending')
        return `已等待 ${span}`;
    if (headOf(session).kind === 'wait')
        return `已排 ${span}`;
    return `已运行 ${span}`;
}
/**
 * 分三段：待处理（挂起、中断）、执行中（含闲时排队）、已结束（exited、idle）。
 * 已结束按 since 新的在前、没有 since 的排最后，只留前 limit 条（面板传 20，不传保持
 * CC mod 的 5 条）；其中结束 30 分钟内的进 recent（卡片），其余进 rows（一行，可点开成卡片）。
 * counts.done 是已结束的总数，不受 limit 限制。
 */
function sectionsOf(sessions, now, limit = DONE_LIMIT) {
    const newestFirst = (a, b) => {
        const ta = timeOf(a.since);
        const tb = timeOf(b.since);
        if (Number.isNaN(ta) && Number.isNaN(tb))
            return 0;
        if (Number.isNaN(ta))
            return 1;
        if (Number.isNaN(tb))
            return -1;
        return tb - ta;
    };
    const todo = sessions.filter((s) => s.phase === 'pending' || s.phase === 'stale').sort(newestFirst);
    const doing = sessions.filter((s) => s.phase === 'running').sort(newestFirst);
    const ended = sessions.filter((s) => s.phase === 'exited' || s.phase === 'idle').sort(newestFirst);
    const shown = ended.slice(0, limit);
    const isRecent = (s) => {
        const t = timeOf(s.since);
        return !Number.isNaN(t) && now - t <= RECENT_MS;
    };
    return {
        todo,
        doing,
        recent: shown.filter(isRecent),
        rows: shown.filter((s) => !isRecent(s)),
        counts: { todo: todo.length, doing: doing.length, done: ended.length },
    };
}
/**
 * 回复的一行文字（收起时用）：只去掉纯排版的 Markdown 记号，内容里的符号一个不动。
 * 行首的标题 `# `、无序列表 `- ` `* ` `+ `、引用 `> `（记号后面必须跟空格才算）；表格行（以 `|` 开头）首尾的竖线；
 * 反引号代码以外成对的 `**加粗**` 记号。有序列表的编号保留（表示步骤顺序）；`__` 一律不动（常是 `__init__` 这类内容）。
 * 纯排版的行返回 ''：空行、`…`、代码块围栏、表格分隔行、整行分隔线（`---` `***` `___`）。
 */
function plainLine(raw) {
    const line = String(raw ?? '').trim();
    if (!line || line === '…' || /^(```|~~~)/.test(line))
        return '';
    if (line.startsWith('|') && /^[\s|:-]+$/.test(line))
        return ''; // 表格分隔行 | --- | :-: |
    if (/^([-*_])(\s*\1){2,}\s*$/.test(line))
        return ''; // 分隔线
    let text = line.replace(/^(#{1,6}|[-*+]|>)\s+/, '');
    if (line.startsWith('|'))
        text = text.replace(/^\|/, '').replace(/\|$/, '');
    return text.split(/(`[^`]*`)/).map((part, i) => (i % 2 === 1 ? part : part.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1'))).join('').trim();
}
/**
 * 回复要不要折叠：按原文里有内容的行（plainLine 非空）数，超过 limit 行才折叠。
 * 返回 { fold, lines }：fold 为 false 时整段按 Markdown 显示、不出按钮；为 true 时 lines 是收起时显示的前 limit 行。
 * limit = 2 复刻 CC mod 原值（2026-10-07 晚间定案：当日早先改的 1 行是在「不折叠分支被 CSS
 * 藏死、短回复整段不可见」的坏行为下定的；回到 CC mod 语义——≤2 行整段显示、>2 行收两行加展开）。
 */
function replyFold(markdown, limit = 2) {
    const lines = String(markdown ?? '').split('\n').map(plainLine).filter(Boolean);
    return { fold: lines.length > limit, lines: lines.slice(0, limit) };
}
};
__modules["client/pane/host-modules.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickComponent = pickComponent;
exports.pickMarkdownText = pickMarkdownText;
exports.hostModules = hostModules;
/** 探测到的 primitives 模块（null = 模块表没有它，全部自绘/自渲）。 */
let hostPrimitives = null;
try {
    hostPrimitives = require('@deepseek-ai/dsh-client-ui-primitives');
}
catch {
    hostPrimitives = null; // 老宿主没有 primitives：面板退化为自绘图标与自绘 Markdown
}
/**
 * 从模块对象里认一个「可渲染成 React 元素」的组件：函数组件直接认；
 * React.memo 的返回是带 $$typeof 的对象，认它的 type 是函数。
 * @param mod - 模块对象（可能是 null 或任何未知形状）。
 * @param name - 导出名。
 * @returns 组件本体，认不出时 null。
 */
function pickComponent(mod, name) {
    if (typeof mod !== 'object' || mod === null)
        return null;
    const value = mod[name];
    if (typeof value === 'function')
        return value;
    if (typeof value === 'object' && value !== null) {
        const memo = value;
        if (typeof memo.type === 'function')
            return memo.type;
    }
    return null;
}
/**
 * 探测宿主 MarkdownText（memo 包装的导出）。
 * @param mod - 待探测的模块对象。
 * @returns 组件，拿不到时 null（调用方走自绘轻量渲染）。
 */
function pickMarkdownText(mod) {
    return pickComponent(mod, 'MarkdownText');
}
/** 当前宿主环境探测到的 primitives 模块（可能为 null）。 */
function hostModules() {
    return hostPrimitives;
}
};
__modules["client/pane/icons.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusIcon = StatusIcon;
exports.PulseIcon = PulseIcon;
exports.QueueIcon = QueueIcon;
exports.TabGlyph = TabGlyph;
const jsx_runtime_1 = require("react/jsx-runtime");
/** 20×20 视箱的公共描边属性（mockup symbol 的 g 属性）。 */
const STROKE = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
};
/** 自绘形状表：mockup/pane.html 的 <symbol> 内容（viewBox 0 0 20 20），done/idle 两处按真机反馈归一。 */
const SELF_DRAWN = {
    pause: ((0, jsx_runtime_1.jsxs)("g", { ...STROKE, children: [(0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "10", r: "7.2" }), (0, jsx_runtime_1.jsx)("path", { d: "M8 7.7v4.6M12 7.7v4.6" })] })),
    question: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("g", { ...STROKE, children: [(0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "10", r: "7.2" }), (0, jsx_runtime_1.jsx)("path", { d: "M7.6 7.9c.2-1.5 1.2-2.4 2.5-2.4 1.4 0 2.4.9 2.4 2.1 0 .8-.4 1.3-1.1 1.8-.7.5-1 1-1 1.7" })] }), (0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "13.9", r: "1", fill: "currentColor" })] })),
    warn: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("g", { ...STROKE, children: [(0, jsx_runtime_1.jsx)("path", { d: "M10 3.7 17.2 16.3H2.8Z" }), (0, jsx_runtime_1.jsx)("path", { d: "M10 8.3v3.4" })] }), (0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "14.2", r: "1", fill: "currentColor" })] })),
    done: ((0, jsx_runtime_1.jsxs)("g", { ...STROKE, children: [(0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "10", r: "7.2" }), (0, jsx_runtime_1.jsx)("path", { d: "m7.1 10.2 2 2 3.7-4.1" })] })),
    timeout: ((0, jsx_runtime_1.jsxs)("g", { ...STROKE, children: [(0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "10", r: "7.2" }), (0, jsx_runtime_1.jsx)("path", { d: "M10 6.2v4l2.8 1.7" })] })),
    fail: ((0, jsx_runtime_1.jsxs)("g", { ...STROKE, children: [(0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "10", r: "7.2" }), (0, jsx_runtime_1.jsx)("path", { d: "m7.4 7.4 5.2 5.2M12.6 7.4 7.4 12.6" })] })),
    cancel: ((0, jsx_runtime_1.jsxs)("g", { ...STROKE, children: [(0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "10", r: "7.2" }), (0, jsx_runtime_1.jsx)("path", { d: "M7.4 10h5.2" })] })),
    idle: ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)("g", { fill: "none", stroke: "currentColor", strokeWidth: "1.6", children: (0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "10", r: "7.2" }) }), (0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "10", r: "1.6", fill: "currentColor" })] })),
    exited: ((0, jsx_runtime_1.jsxs)("g", { ...STROKE, children: [(0, jsx_runtime_1.jsx)("circle", { cx: "10", cy: "10", r: "7.2" }), (0, jsx_runtime_1.jsx)("path", { d: "M7.7 12.3l4.6-4.6M8.5 7.7h3.8v3.8" })] })),
};
/**
 * 静态状态图标：统一自绘族（宿主映射已撤，见文件头注）。颜色随 currentColor（外层 .zxe-sticon/.zxe-row 定色）。
 * @param props - k 状态键；size 像素边长，默认 16。
 */
function StatusIcon(props) {
    const size = props.size ?? 16;
    return ((0, jsx_runtime_1.jsx)("svg", { className: "zxe-icon", width: size, height: size, viewBox: "0 0 20 20", "aria-hidden": "true", children: SELF_DRAWN[props.k] }));
}
/**
 * 执行中的动态脉冲（呼吸点 + 扩散环，绿色）：卡片头 16、摘要实时指示 12 都用它。
 * 动画在 styles.ts 的 .zxe-apulse 段，prefers-reduced-motion 时停用。
 */
function PulseIcon(props) {
    const size = props.size ?? 16;
    return ((0, jsx_runtime_1.jsxs)("svg", { className: "zxe-apulse", width: size, height: size, viewBox: "0 0 20 20", "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("circle", { className: "zxe-p-ring", cx: "10", cy: "10", r: "4.4" }), (0, jsx_runtime_1.jsx)("circle", { className: "zxe-p-dot", cx: "10", cy: "10", r: "4" })] }));
}
/** 闲时排队的动态转弧（蓝色匀速弧线 + 淡轨道圈）；动画同上受 prefers-reduced-motion 管制。 */
function QueueIcon(props) {
    const size = props.size ?? 16;
    return ((0, jsx_runtime_1.jsxs)("svg", { className: "zxe-aqueue", width: size, height: size, viewBox: "0 0 20 20", "aria-hidden": "true", children: [(0, jsx_runtime_1.jsx)("circle", { className: "zxe-q-track", cx: "10", cy: "10", r: "6.6" }), (0, jsx_runtime_1.jsx)("circle", { className: "zxe-q-arc", cx: "10", cy: "10", r: "6.6", strokeDasharray: "10.4 31" })] }));
}
/** 右栏 guide 条目的自绘 glyph（宿主 Icon* 无同款方形拉手形；mockup 的 #i-tab）。 */
function TabGlyph(props) {
    const size = props.size ?? 16;
    return ((0, jsx_runtime_1.jsx)("svg", { className: "zxe-icon", width: size, height: size, viewBox: "0 0 20 20", "aria-hidden": "true", children: (0, jsx_runtime_1.jsxs)("g", { ...STROKE, children: [(0, jsx_runtime_1.jsx)("rect", { x: "3.5", y: "3.5", width: "13", height: "13", rx: "3" }), (0, jsx_runtime_1.jsx)("path", { d: "M7 12.5V10c0-1.7 1.3-3 3-3s3 1.3 3 3v2.5" })] }) }));
}
};
__modules["client/pane/cards.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.repoNameOf = repoNameOf;
exports.endClockOf = endClockOf;
exports.ReplyView = ReplyView;
exports.PendingCard = PendingCard;
exports.StaleCard = StaleCard;
exports.QueueCard = QueueCard;
exports.RunningCard = RunningCard;
exports.RecentCard = RecentCard;
exports.EndedRow = EndedRow;
const jsx_runtime_1 = require("react/jsx-runtime");
// src/client/pane/cards.tsx —— 面板的卡片族与回复渲染。信息架构与文案出自 view.ts 的纯函数
// （headOf/outcomeOf/cornerOf/replyFold），版式对照 mockup/pane.html 的卡片段；样式类见 styles.ts。
// 回复两条渲染路：宿主 MarkdownText（pane/host-modules.ts 探测，优先）与自绘轻量渲染
// （段落/加粗/行内码/列表/围栏代码块），replyMarkdown 缺失回退 reply 逐行（view.ts 已有语义）。
// 面板只看不应答：任何卡片都不得出现 approve/deny/answer 控件（AGENTS.md 硬边界）。
const react_1 = require("react");
const view_ts_1 = require("./client/view.js");
const host_modules_ts_1 = require("./client/pane/host-modules.js");
const icons_tsx_1 = require("./client/pane/icons.js");
/** meta 行：会话 id 与任务单名，缺谁跳谁。 */
function metaOf(s) {
    return [s.id, s.task].filter((part) => typeof part === 'string' && part !== '').join(' · ');
}
/** 标题行的显示文字：会话 title 优先（人写的任务名），task 次之（任务单文件名）；空串不算命中，两者皆缺返回 undefined（CardHead 不画）。 */
function headTitleOf(s) {
    if (typeof s.title === 'string' && s.title !== '')
        return s.title;
    if (typeof s.task === 'string' && s.task !== '')
        return s.task;
    return undefined;
}
/** 所属仓库的显示名：路径最后一段。 */
function repoNameOf(repo) {
    if (typeof repo !== 'string' || repo === '')
        return '';
    const parts = repo.split('/').filter(Boolean);
    return parts.length > 0 ? (parts[parts.length - 1] ?? repo) : repo;
}
/** 结束时刻的 HH:MM（卡片右上角与已结束行）；解析不了返回 null（不显示）。 */
function endClockOf(iso) {
    const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (Number.isNaN(t))
        return null;
    const d = new Date(t);
    const two = (n) => String(n).padStart(2, '0');
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
}
/** 结果 → 图标键：与 outcomeOf 的文案一一对应，认不出的按已退出画。 */
function outcomeIconOf(outcome) {
    if (outcome.label === '已完成')
        return 'done';
    if (outcome.label === '已超时')
        return 'timeout';
    if (outcome.label === '执行失败')
        return 'fail';
    if (outcome.label === '已取消')
        return 'cancel';
    if (outcome.label === '空闲')
        return 'idle';
    return 'exited';
}
/** 结果 → 卡片 data-outcome / 行类名（styles.ts 按它染状态色）。 */
function outcomeAttrOf(outcome) {
    if (outcome.color === 'success')
        return 'done';
    if (outcome.color === 'warning')
        return 'timeout';
    if (outcome.color === 'error')
        return 'failed';
    if (outcome.label === '空闲')
        return 'idle';
    if (outcome.label === '已取消')
        return 'cancel';
    return 'exited';
}
// ---- 回复渲染 ----
/** 宿主 MarkdownText 的探测结果与固定文案：模块加载时探测一次，labels 引用稳定（官方要求）。 */
const HOST_MARKDOWN = (0, host_modules_ts_1.pickMarkdownText)((0, host_modules_ts_1.hostModules)());
const MARKDOWN_LABELS = {
    code: { copyLabel: '复制', copiedLabel: '已复制' },
    footnotes: '脚注',
};
/** 行内记号的最小切分：反引号代码与加粗，其余原样。 */
function renderInline(text, keyBase) {
    const parts = text.split(/(`[^`]*`|\*\*[^*]+\*\*)/g).filter((part) => part !== '');
    return parts.map((part, i) => {
        const key = `${keyBase}-${i}`;
        if (part.startsWith('`') && part.endsWith('`') && part.length >= 2)
            return (0, jsx_runtime_1.jsx)("code", { children: part.slice(1, -1) }, key);
        if (part.startsWith('**') && part.endsWith('**') && part.length >= 4)
            return (0, jsx_runtime_1.jsx)("strong", { children: part.slice(2, -2) }, key);
        return part;
    });
}
/** 自绘轻量 Markdown：段落、加粗、行内码、列表、围栏代码块——宿主拿不到时的降级路。 */
function SelfMarkdown(props) {
    const blocks = (0, react_1.useMemo)(() => {
        const out = [];
        let paragraph = [];
        let list = null;
        let fence = null;
        const flush = () => {
            if (paragraph.length > 0) {
                out.push({ kind: 'p', text: paragraph.join('\n') });
                paragraph = [];
            }
        };
        const flushList = () => {
            if (list !== null) {
                out.push(list);
                list = null;
            }
        };
        for (const line of props.text.split('\n')) {
            if (/^\s*(```|~~~)/.test(line)) {
                if (fence === null) {
                    flush();
                    flushList();
                    fence = [];
                }
                else {
                    out.push({ kind: 'pre', text: fence.join('\n') });
                    fence = null;
                }
                continue;
            }
            if (fence !== null) {
                fence.push(line);
                continue;
            }
            // 列表行：`- `/`* ` 无序、`N. `/`N) ` 有序（`*` 后必须空白，不吞 `**加粗**` 行）；同类行聚进当前列表
            const ulItem = /^(?:-|\*)\s+(.+)$/.exec(line);
            const olItem = ulItem === null ? /^\d+[.)]\s+(.+)$/.exec(line) : null;
            const listMatch = ulItem ?? olItem;
            if (listMatch !== null) {
                const kind = ulItem !== null ? 'ul' : 'ol';
                const item = listMatch[1] ?? '';
                if (list === null || list.kind !== kind) {
                    flushList();
                    list = { kind, items: [] };
                }
                const current = list;
                current.items.push(item);
                continue;
            }
            if (line.trim() === '') {
                flush();
                flushList();
            }
            else {
                flushList();
                paragraph.push(line);
            }
        }
        if (fence !== null)
            out.push({ kind: 'pre', text: fence.join('\n') });
        flush();
        flushList();
        return out;
    }, [props.text]);
    return ((0, jsx_runtime_1.jsx)(jsx_runtime_1.Fragment, { children: blocks.map((block, i) => {
            if (block.kind === 'pre') {
                // 内容是纯文本节点，React 转义；不存在 HTML 注入面
                return ((0, jsx_runtime_1.jsx)("pre", { className: "zxe-mono", children: (0, jsx_runtime_1.jsx)("code", { children: block.text }) }, i));
            }
            if (block.kind === 'p')
                return (0, jsx_runtime_1.jsx)("p", { children: renderInline(block.text, String(i)) }, i);
            // 剩下 ul | ol（pre 与 p 已在上面 return）
            const items = block.items.map((item, j) => (0, jsx_runtime_1.jsx)("li", { children: renderInline(item, `${i}-${j}`) }, j));
            return block.kind === 'ul' ? (0, jsx_runtime_1.jsx)("ul", { children: items }, i) : (0, jsx_runtime_1.jsx)("ol", { children: items }, i);
        }) }));
}
/** 全文按 Markdown 渲染：宿主 MarkdownText 优先，探测不到退 SelfMarkdown。 */
function MarkdownBody(props) {
    if (HOST_MARKDOWN === null)
        return (0, jsx_runtime_1.jsx)(SelfMarkdown, { text: props.text });
    const HostMarkdownText = HOST_MARKDOWN;
    return ((0, jsx_runtime_1.jsx)("div", { className: "zxe-md", children: (0, jsx_runtime_1.jsx)(HostMarkdownText, { text: props.text, labels: MARKDOWN_LABELS, variant: "compact" }) }));
}
/**
 * 回复的取值（2026-10-07 真机排障定案）：快照的 replyMarkdown 是「最新一条消息」，工具消息
 * 穿插或消息切换的空窗里会短暂为空——面板若照单全收就会把已显示的中途回复顶掉。这里取
 * 「快照里最新的非空值（replyMarkdown 优先，空则 reply 行拼），仍空则沿用该会话上一次的
 * 非空值」（粘滞）；两条都没有且无缓存才不画回复区。模块级缓存随面板活，超上限清空防膨胀。
 */
const lastReplyOf = new Map();
const REPLY_CACHE_CAP = 200;
/** 会话 → 当前应显示的回复全文；null = 不画回复区。 */
function resolveReply(s) {
    const md = typeof s.replyMarkdown === 'string' && s.replyMarkdown.trim() !== '' ? s.replyMarkdown : null;
    const lines = Array.isArray(s.reply) && s.reply.length > 0 ? s.reply.join('\n') : null;
    const fresh = md ?? lines;
    if (fresh !== null) {
        if (lastReplyOf.size >= REPLY_CACHE_CAP)
            lastReplyOf.clear();
        lastReplyOf.set(s.id, fresh);
        return fresh;
    }
    return lastReplyOf.get(s.id) ?? null;
}
/**
 * 回复区：复刻 CC mod replyOf 的折叠语义——有内容的行 ≤2（replyFold 判定）整段按 Markdown
 * 显示、不出按钮（zxe-flat，CSS 里与展开态同显全文）；超过 2 行默认收起成前两行 +「展开回复」，
 * 展开后全文 +「收起」。fold=false 整段显示是 CC mod 的原行为，2026-10-07 晚间修复：此前该
 * 分支渲染进 .zxe-full 却被 CSS 无条件藏死、又没有展开按钮——单段无换行的回复（真实数据约
 * 一成）与执行中每条新消息的开头整段不可见。
 * 来源 resolveReply（replyMarkdown 优先、空窗粘滞上一条；缺失回退 reply 逐行）。
 */
function ReplyView(props) {
    const [open, setOpen] = (0, react_1.useState)(false);
    const s = props.s;
    const markdown = resolveReply(s);
    if (markdown === null)
        return null;
    const { fold, lines } = (0, view_ts_1.replyFold)(markdown);
    if (!fold) {
        return ((0, jsx_runtime_1.jsx)("div", { className: "zxe-reply zxe-flat", children: (0, jsx_runtime_1.jsx)("div", { className: "zxe-full", children: (0, jsx_runtime_1.jsx)(MarkdownBody, { text: markdown }) }) }));
    }
    return ((0, jsx_runtime_1.jsxs)("div", { className: open ? 'zxe-reply zxe-open' : 'zxe-reply', children: [(0, jsx_runtime_1.jsx)("div", { className: "zxe-peek", children: lines.map((line, i) => ((0, jsx_runtime_1.jsx)("p", { children: line }, i))) }), (0, jsx_runtime_1.jsx)("div", { className: "zxe-full", children: (0, jsx_runtime_1.jsx)(MarkdownBody, { text: markdown }) }), (0, jsx_runtime_1.jsx)("button", { className: "zxe-fold", type: "button", onClick: () => setOpen(!open), children: open ? '收起' : '展开回复' })] }));
}
// ---- 工具行 ----
/** 一行工具：▸ 正在执行（绿）/ ✓ 完成 / ✕ 失败；摘要超长省略。 */
function ToolRow(props) {
    const bad = props.tool.ok === false;
    const cls = props.active ? 'zxe-tool zxe-active' : bad ? 'zxe-tool zxe-bad' : 'zxe-tool zxe-ok';
    return ((0, jsx_runtime_1.jsxs)("div", { className: cls, children: [(0, jsx_runtime_1.jsx)("span", { className: "zxe-g", children: props.active ? '▸' : bad ? '✕' : '✓' }), (0, jsx_runtime_1.jsx)("span", { className: "zxe-tn", children: props.tool.toolName ?? '未知工具' }), typeof props.tool.summary === 'string' && props.tool.summary !== '' ? ((0, jsx_runtime_1.jsx)("span", { className: "zxe-ts zxe-mono", children: props.tool.summary })) : null] }));
}
/** 执行中卡片的工具区：正在执行的一行 + 最近完成的至多五行（快照 recentTools 上限 5）；两者皆空则整块不画。 */
function ToolsView(props) {
    const { activeTool, recentTools } = props.s;
    const recent = Array.isArray(recentTools) ? recentTools.slice(0, 5) : [];
    if ((activeTool === undefined || activeTool === null) && recent.length === 0)
        return null;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "zxe-tools", children: [activeTool !== undefined && activeTool !== null ? (0, jsx_runtime_1.jsx)(ToolRow, { tool: activeTool, active: true }) : null, recent.map((tool, i) => ((0, jsx_runtime_1.jsx)(ToolRow, { tool: tool, active: false }, `${tool.toolName ?? 'tool'}-${i}`)))] }));
}
// ---- 卡片 ----
/** 卡片头：状态图标芯片 + 文案（headOf）+ 标题 + 时长角标（cornerOf）。 */
function CardHead(props) {
    return ((0, jsx_runtime_1.jsxs)("div", { className: "zxe-chead", children: [(0, jsx_runtime_1.jsx)("span", { className: "zxe-sticon", children: props.icon }), (0, jsx_runtime_1.jsx)("span", { className: "zxe-clabel", children: props.label }), typeof props.title === 'string' && props.title !== '' ? (0, jsx_runtime_1.jsx)("span", { className: "zxe-ctitle", children: props.title }) : null, props.corner !== null ? (0, jsx_runtime_1.jsx)("span", { className: "zxe-corner", children: props.corner }) : null] }));
}
/** 挂起卡片（待处理段）：审批请求带工具名与命令全文，提问带条数与问题文本；下方最新回复（2026-10-07 用户要求补，原版无）。 */
function PendingCard(props) {
    const { s, now } = props;
    const head = (0, view_ts_1.headOf)(s);
    const p = s.pendingDetail;
    const isQuestion = p?.kind === 'question';
    const body = isQuestion
        ? (p?.questionTexts ?? []).filter((t) => typeof t === 'string' && t !== '').join('\n')
        : (typeof p?.summary === 'string' ? p.summary : '');
    const reason = typeof p?.reason === 'string' && p.reason !== '' ? p.reason : null;
    return ((0, jsx_runtime_1.jsxs)("article", { className: "zxe-card zxe-k-pend", children: [(0, jsx_runtime_1.jsx)(CardHead, { icon: (0, jsx_runtime_1.jsx)(icons_tsx_1.StatusIcon, { k: isQuestion ? 'question' : 'pause', size: 16 }), label: head.label, corner: (0, view_ts_1.cornerOf)(s, now) }), (0, jsx_runtime_1.jsx)("div", { className: "zxe-meta", children: metaOf(s) }), body !== '' ? ((0, jsx_runtime_1.jsxs)("div", { className: "zxe-pend-body", children: [(0, jsx_runtime_1.jsx)("pre", { className: "zxe-mono", children: body }), reason !== null ? (0, jsx_runtime_1.jsxs)("div", { className: "zxe-reason", children: ["\u539F\u56E0\uFF1A", reason] }) : null] })) : null, (0, jsx_runtime_1.jsx)(ReplyView, { s: s }), (0, jsx_runtime_1.jsx)("div", { className: "zxe-hint", children: "\u7531\u6D3E\u5355\u667A\u80FD\u4F53\u5728\u5BF9\u8BDD\u4E2D\u5904\u7406" })] }));
}
/** 中断卡片（待处理段）：回合没有正常收尾，重投或取消仍由派单智能体在对话里处理。 */
function StaleCard(props) {
    const { s, now } = props;
    return ((0, jsx_runtime_1.jsxs)("article", { className: "zxe-card zxe-k-stale", children: [(0, jsx_runtime_1.jsx)(CardHead, { icon: (0, jsx_runtime_1.jsx)(icons_tsx_1.StatusIcon, { k: "warn", size: 16 }), label: (0, view_ts_1.headOf)(s).label, title: headTitleOf(s), corner: (0, view_ts_1.cornerOf)(s, now) }), (0, jsx_runtime_1.jsx)("div", { className: "zxe-meta", children: metaOf(s) }), (0, jsx_runtime_1.jsx)(ReplyView, { s: s }), (0, jsx_runtime_1.jsx)("div", { className: "zxe-hint", children: "\u56DE\u5408\u6CA1\u6709\u6B63\u5E38\u6536\u5C3E\uFF1B\u91CD\u6295\u6216\u53D6\u6D88\u7531\u6D3E\u5355\u667A\u80FD\u4F53\u5728\u5BF9\u8BDD\u91CC\u5904\u7406" })] }));
}
/** 闲时排队卡片（执行中段）：转弧动态图标 + 排位，就绪后文案换「闲时已就绪」。 */
function QueueCard(props) {
    const { s, now } = props;
    const head = (0, view_ts_1.headOf)(s);
    const queued = s.offpeakQueue?.phase === 'queued';
    return ((0, jsx_runtime_1.jsxs)("article", { className: "zxe-card zxe-k-queue", children: [(0, jsx_runtime_1.jsx)(CardHead, { icon: (0, jsx_runtime_1.jsx)(icons_tsx_1.QueueIcon, { size: 16 }), label: head.label, corner: (0, view_ts_1.cornerOf)(s, now) }), (0, jsx_runtime_1.jsxs)("div", { className: "zxe-meta", children: [[s.id, s.task, queued ? '等服务器放出闲时算力' : ''].filter((part) => typeof part === 'string' && part !== '').join(' · '), (0, jsx_runtime_1.jsx)("span", { className: "zxe-repotag", children: s.repo ? ` · ${repoNameOf(s.repo)}` : '' })] })] }));
}
/** 执行中卡片：脉冲图标、回复（Markdown + 折叠）、正在执行与最近完成的工具。 */
function RunningCard(props) {
    const { s, now } = props;
    return ((0, jsx_runtime_1.jsxs)("article", { className: "zxe-card zxe-k-run", children: [(0, jsx_runtime_1.jsx)(CardHead, { icon: (0, jsx_runtime_1.jsx)(icons_tsx_1.PulseIcon, { size: 16 }), label: (0, view_ts_1.headOf)(s).label, title: headTitleOf(s), corner: (0, view_ts_1.cornerOf)(s, now) }), (0, jsx_runtime_1.jsx)("div", { className: "zxe-meta", children: metaOf(s) }), (0, jsx_runtime_1.jsx)(ReplyView, { s: s }), (0, jsx_runtime_1.jsx)(ToolsView, { s: s })] }));
}
/**
 * 刚结束的卡片（已结束段，30 分钟内；已结束行点开也复用它）：结果配色 + 最后回复（默认一行+展开）。
 * onCollapse 有值时多出「收起」按钮——已结束行点开成卡片的收回入口。
 */
function RecentCard(props) {
    // now 只为与其它卡片同构的 props 签名存在（已结束卡片没有时长角标）
    const { s, onCollapse } = props;
    const outcome = (0, view_ts_1.outcomeOf)(s);
    return ((0, jsx_runtime_1.jsxs)("article", { className: "zxe-card zxe-k-recent", "data-outcome": outcomeAttrOf(outcome), children: [(0, jsx_runtime_1.jsx)(CardHead, { icon: (0, jsx_runtime_1.jsx)(icons_tsx_1.StatusIcon, { k: outcomeIconOf(outcome), size: 16 }), label: outcome.label, title: headTitleOf(s), corner: endClockOf(s.since) }), (0, jsx_runtime_1.jsxs)("div", { className: "zxe-meta", children: [metaOf(s), (0, jsx_runtime_1.jsx)("span", { className: "zxe-repotag", children: s.repo ? ` · ${repoNameOf(s.repo)}` : '' })] }), (0, jsx_runtime_1.jsx)(ReplyView, { s: s }), onCollapse !== undefined ? ((0, jsx_runtime_1.jsx)("button", { className: "zxe-fold", type: "button", onClick: onCollapse, children: "\u6536\u8D77" })) : null] }));
}
/** 已结束的一行（超出 30 分钟的）：图标 + 结果 + 标题 +（全部项目时的仓库名，repo 缺失回退 cwd）+ 时刻；点行展开成卡片。 */
function EndedRow(props) {
    const { s, onToggle } = props;
    const outcome = (0, view_ts_1.outcomeOf)(s);
    const attr = outcomeAttrOf(outcome);
    const clock = endClockOf(s.since);
    const clickable = onToggle !== undefined;
    return ((0, jsx_runtime_1.jsxs)("div", { className: `zxe-row zxe-r-${attr}`, role: clickable ? 'button' : undefined, tabIndex: clickable ? 0 : undefined, onClick: clickable ? onToggle : undefined, onKeyDown: clickable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ')
                    onToggle();
            }
            : undefined, children: [(0, jsx_runtime_1.jsx)("span", { className: "zxe-ric", children: (0, jsx_runtime_1.jsx)(icons_tsx_1.StatusIcon, { k: outcomeIconOf(outcome), size: 15 }) }), (0, jsx_runtime_1.jsx)("span", { className: "zxe-rl", children: outcome.label }), (0, jsx_runtime_1.jsx)("span", { className: "zxe-rt", children: headTitleOf(s) ?? s.id }), (0, jsx_runtime_1.jsx)("span", { className: "zxe-rrepo", children: repoNameOf(s.repo ?? s.cwd) }), clock !== null ? (0, jsx_runtime_1.jsx)("span", { className: "zxe-rat zxe-mono", children: clock }) : null] }));
}
};
__modules["client/pane/index.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PANE_DONE_LIMIT = void 0;
exports.Body = Body;
const jsx_runtime_1 = require("react/jsx-runtime");
// src/client/pane/index.tsx —— 观察面板 Body：右栏 tab 的组件本体（register-tab.ts 挂它进
// sidebar.right.pane.tab 槽）。信息架构照 view.ts 的三段语义与 mockup/pane.html 的版式：
// 摘要计数行（可点跳分段）+ 实时指示 + 时钟、范围切换（本项目/全部项目，chip 态组件内自持）、
// 断连横幅、三段（吸顶标题、计数；挂起/中断/执行中/闲时排队/刚结束成卡片、其余一行一条且
// 点行展开成卡片看回复、上限 20 条）、空态文案。数据来自 store（T4），过滤与文案全部走
// view.ts 纯函数。
// 面板只看不应答：全树没有任何 approve/deny/answer 控件（AGENTS.md 硬边界）。
const react_1 = require("react");
const view_ts_1 = require("./client/view.js");
const cards_tsx_1 = require("./client/pane/cards.js");
const icons_tsx_1 = require("./client/pane/icons.js");
/** 面板的「已结束」条数上限（CC mod 是 5，面板放宽到 20；SPEC 用户故事 13）。 */
exports.PANE_DONE_LIMIT = 20;
/** 每隔 tickMs 跳一次的当前时间：时长角标（已运行 N 分钟）的燃料。 */
function useNow(tickMs) {
    const [now, setNow] = (0, react_1.useState)(() => Date.now());
    (0, react_1.useEffect)(() => {
        const timer = setInterval(() => {
            setNow(Date.now());
        }, tickMs);
        return () => {
            clearInterval(timer);
        };
    }, [tickMs]);
    return now;
}
const twoDigits = (n) => String(n).padStart(2, '0');
/** 实时时钟 HH:MM:SS，每秒一跳（独立小组件，整面板不必跟着每秒重渲）。 */
function LiveClock() {
    const now = useNow(1000);
    const d = new Date(now);
    return ((0, jsx_runtime_1.jsxs)("span", { className: "zxe-mono", children: [twoDigits(d.getHours()), ":", twoDigits(d.getMinutes()), ":", twoDigits(d.getSeconds())] }));
}
/** 摘要行：三段计数（点击滚动到对应分段）+ 实时指示（连接态着色，live 带脉冲点与时钟）+
 * 数据时钟（最后一次数据变化的时刻——与走秒的本地钟对比即可看出数据流是否停格，2026-10-07 排障加）。 */
function SummaryRow(props) {
    const { counts, link, dataAt, onJump } = props;
    const chip = (key, cls, label, n) => ((0, jsx_runtime_1.jsxs)("button", { type: "button", className: `zxe-count ${cls}`, onClick: () => onJump(key), children: [(0, jsx_runtime_1.jsx)("span", { className: "zxe-dot" }), label, " ", (0, jsx_runtime_1.jsx)("b", { children: n })] }));
    const d = dataAt > 0 ? new Date(dataAt) : null;
    const dataClock = d
        ? `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}:${twoDigits(d.getSeconds())}`
        : '--:--:--';
    return ((0, jsx_runtime_1.jsxs)("div", { className: "zxe-summary", children: [chip('todo', 'zxe-c-todo', '待处理', counts.todo), chip('doing', 'zxe-c-doing', '执行中', counts.doing), chip('done', 'zxe-c-done', '已结束', counts.done), (0, jsx_runtime_1.jsxs)("span", { className: "zxe-live", "data-link": link, title: "\u300C\u6570\u636E\u300D\u662F\u6700\u540E\u4E00\u6B21\u6570\u636E\u5230\u8FBE\u7684\u65F6\u523B\uFF1A\u548C\u53F3\u4FA7\u8D70\u79D2\u7684\u672C\u5730\u949F\u5DEE\u8DDD\u53D8\u5927\uFF0C\u8BF4\u660E\u6570\u636E\u6D41\u505C\u683C", children: [(0, jsx_runtime_1.jsxs)("span", { className: "zxe-dclock", children: ["\u6570\u636E ", dataClock] }), (0, jsx_runtime_1.jsx)(icons_tsx_1.PulseIcon, { size: 12 }), (0, jsx_runtime_1.jsx)(LiveClock, {})] })] }));
}
/** 范围切换：本项目 / 全部项目（chip 态在 Body 自持）；旁注当前仓库名或「显示全部项目」。 */
function ScopeBar(props) {
    const { scope, scopeRepo, onChange } = props;
    const note = scope === 'all' ? '显示全部项目' : scopeRepo !== null ? (0, cards_tsx_1.repoNameOf)(scopeRepo) : '未识别当前项目，显示全部';
    return ((0, jsx_runtime_1.jsxs)("div", { className: "zxe-scopebar", children: [(0, jsx_runtime_1.jsxs)("span", { className: "zxe-seg", role: "group", "aria-label": "\u663E\u793A\u8303\u56F4", children: [(0, jsx_runtime_1.jsx)("button", { type: "button", "aria-pressed": scope === 'proj', onClick: () => onChange('proj'), children: "\u672C\u9879\u76EE" }), (0, jsx_runtime_1.jsx)("button", { type: "button", "aria-pressed": scope === 'all', onClick: () => onChange('all'), children: "\u5168\u90E8\u9879\u76EE" })] }), (0, jsx_runtime_1.jsx)("span", { className: "zxe-scope-note", children: note })] }));
}
/** 分段：吸顶标题（可被摘要行计数点跳过来）+ 计数 + 内容。 */
function Section(props) {
    return ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsxs)("section", { className: "zxe-sechead", ref: props.innerRef, children: [props.title, " ", (0, jsx_runtime_1.jsx)("span", { className: "zxe-n", children: props.count })] }), props.isEmpty ? (0, jsx_runtime_1.jsx)("div", { className: "zxe-empty", children: props.empty }) : props.children] }));
}
/** 断连 / 启动失败横幅的文案：down 用服务端带来的原因，failed 指向 execPath 配置。 */
function bannerOf(state) {
    if (state.link === 'down')
        return state.message ?? '实时连接中断，正在重连。重连完成前的变化不补提示。';
    if (state.link === 'failed')
        return state.message ?? 'watch 进程启动失败：请检查插件设置里的 execPath（zcode-executor 可执行文件路径）。';
    return null;
}
/** 卡片选择：待处理段挂起 → PendingCard、中断 → StaleCard。 */
function TodoCard(props) {
    return props.s.phase === 'stale' ? (0, jsx_runtime_1.jsx)(cards_tsx_1.StaleCard, { s: props.s, now: props.now }) : (0, jsx_runtime_1.jsx)(cards_tsx_1.PendingCard, { s: props.s, now: props.now });
}
/** 执行中段：闲时排队 → QueueCard，其余 → RunningCard。 */
function DoingCard(props) {
    return props.s.offpeakQueue !== undefined && props.s.offpeakQueue !== null ? ((0, jsx_runtime_1.jsx)(cards_tsx_1.QueueCard, { s: props.s, now: props.now })) : ((0, jsx_runtime_1.jsx)(cards_tsx_1.RunningCard, { s: props.s, now: props.now }));
}
/**
 * 面板 Body。props 的其余成员是槽位框架注入的（hooks/useSession 等），这里只用得到 store；
 * inject 工厂由 register-tab.ts 提供 { store }。
 * @param props - store 与槽位框架的标准注入。
 */
function Body(props) {
    const { store } = props;
    // 第三参 getServerSnapshot 只在服务端渲染取快照时用（scripts/preview.mjs 的静态预览走这条
    // 路，缺它 react-dom/server 直接抛「Missing getServerSnapshot」）；客户端挂载后仍只用第二
    // 参，行为不变——两参是同一个 getState。
    const state = (0, react_1.useSyncExternalStore)(store.subscribe, store.getState, store.getState);
    // 时长角标的走字（每分钟）；时钟的每秒跳在 LiveClock 自持
    const now = useNow(60_000);
    // 范围 chip：本项目（按所属仓库过滤）/ 全部项目（旁路过滤并标注仓库名）
    const [scope, setScope] = (0, react_1.useState)('proj');
    // 已结束行点开的会话 id 集合：点行展开成卡片（看回复），卡片上「收起」收回成行
    const [expandedEnded, setExpandedEnded] = (0, react_1.useState)(() => new Set());
    const toggleEnded = (id) => {
        setExpandedEnded((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    };
    const sectionRefs = {
        todo: (0, react_1.useRef)(null),
        doing: (0, react_1.useRef)(null),
        done: (0, react_1.useRef)(null),
    };
    const jumpTo = (key) => {
        sectionRefs[key].current?.scrollIntoView();
    };
    const sessions = Object.values(state.table);
    // 本项目 chip 且识别到了过滤仓库才过滤；范围仓库 null（未识别）时显示全部并注明
    const repoActive = scope === 'proj' && state.scopeRepo !== null;
    const visible = repoActive ? (0, view_ts_1.filterByRepo)(sessions, state.scopeRepo) : sessions;
    const sections = (0, view_ts_1.sectionsOf)(visible, now, exports.PANE_DONE_LIMIT);
    const shownDone = sections.recent.length + sections.rows.length;
    const banner = bannerOf(state);
    const isEmptyPane = visible.length === 0;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "zxe-pane", "data-scope": scope, "data-link": state.link, children: [(0, jsx_runtime_1.jsx)(SummaryRow, { counts: sections.counts, link: state.link, dataAt: state.dataAt, onJump: jumpTo }), (0, jsx_runtime_1.jsxs)("div", { className: "zxe-scroll", children: [(0, jsx_runtime_1.jsx)(ScopeBar, { scope: scope, scopeRepo: state.scopeRepo, onChange: setScope }), banner !== null ? (0, jsx_runtime_1.jsx)("div", { className: "zxe-banner", children: banner }) : null, isEmptyPane ? ((0, jsx_runtime_1.jsx)("div", { className: "zxe-empty", children: "\u6CA1\u6709 zcode \u4F1A\u8BDD\u3002" })) : ((0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [(0, jsx_runtime_1.jsx)(Section, { title: "\u5F85\u5904\u7406", count: String(sections.counts.todo), innerRef: (el) => {
                                    sectionRefs.todo.current = el;
                                }, isEmpty: sections.todo.length === 0, empty: "\u6CA1\u6709\u6302\u8D77\u7684\u56DE\u5408\u3002", children: (0, jsx_runtime_1.jsx)("div", { className: "zxe-cards", children: sections.todo.map((s) => ((0, jsx_runtime_1.jsx)(TodoCard, { s: s, now: now }, s.id))) }) }), (0, jsx_runtime_1.jsx)(Section, { title: "\u6267\u884C\u4E2D", count: String(sections.counts.doing), innerRef: (el) => {
                                    sectionRefs.doing.current = el;
                                }, isEmpty: sections.doing.length === 0, empty: "\u6CA1\u6709\u6267\u884C\u4E2D\u7684\u56DE\u5408\u3002", children: (0, jsx_runtime_1.jsx)("div", { className: "zxe-cards", children: sections.doing.map((s) => ((0, jsx_runtime_1.jsx)(DoingCard, { s: s, now: now }, s.id))) }) }), (0, jsx_runtime_1.jsx)(Section, { title: "\u5DF2\u7ED3\u675F", count: shownDone > 0 ? `最近 ${shownDone} 条` : '0', innerRef: (el) => {
                                    sectionRefs.done.current = el;
                                }, isEmpty: shownDone === 0, empty: "\u8FD8\u6CA1\u6709\u7ED3\u675F\u7684\u56DE\u5408\u3002", children: (0, jsx_runtime_1.jsxs)(jsx_runtime_1.Fragment, { children: [sections.recent.length > 0 ? ((0, jsx_runtime_1.jsx)("div", { className: "zxe-cards", children: sections.recent.map((s) => ((0, jsx_runtime_1.jsx)(cards_tsx_1.RecentCard, { s: s, now: now }, s.id))) })) : null, sections.rows.length > 0 ? ((0, jsx_runtime_1.jsx)("div", { className: "zxe-rows", children: sections.rows.map((s) => expandedEnded.has(s.id) ? ((0, jsx_runtime_1.jsx)(cards_tsx_1.RecentCard, { s: s, now: now, onCollapse: () => toggleEnded(s.id) }, s.id)) : ((0, jsx_runtime_1.jsx)(cards_tsx_1.EndedRow, { s: s, now: now, onToggle: () => toggleEnded(s.id) }, s.id))) })) : null] }) })] }))] })] }));
}
};
__modules["client/tab-def.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TAB_GUIDE_ORDER = exports.TAB_DESCRIPTION = exports.TAB_TITLE = exports.TAB_KIND = exports.TAB_ID = void 0;
exports.tabDefinition = tabDefinition;
exports.missingServiceNote = missingServiceNote;
/** 右栏 tab 的实现 id（官方要求跨注册唯一，包名前缀）；kind 同 id（页面类型按 kind 打开）。 */
exports.TAB_ID = 'zcode-executor:tasks';
exports.TAB_KIND = 'zcode-executor:tasks';
/** tab 标题与菜单条目文案。 */
exports.TAB_TITLE = 'zcode 任务';
exports.TAB_DESCRIPTION = '本机 zcode-executor 会话的实时观察面板';
/** guide 条目在菜单里的位置：排在宿主自己的条目（files/changes 等 10–30 段）之后。 */
exports.TAB_GUIDE_ORDER = 50;
/**
 * tab 类型定义（纯数据）：页面类型（无 patterns，按 kind 打开），extension 段最高优先。
 * guide 条目的 id 按官方要求在提供方内唯一（DSH 0.1.6-alpha.2 起必填）。
 * @param icon - 菜单条目的 glyph（接线层给 TabGlyph；测试可不传，条目退宿主方块占位）。
 * @returns 可直接交给 sidebarRightTabs.register 的定义。
 */
function tabDefinition(icon) {
    return {
        id: exports.TAB_ID,
        kind: exports.TAB_KIND,
        priority: 'extension',
        title: () => exports.TAB_TITLE,
        guide: [
            {
                id: 'tasks',
                order: exports.TAB_GUIDE_ORDER,
                title: () => exports.TAB_TITLE,
                description: () => exports.TAB_DESCRIPTION,
                ...(icon === undefined ? {} : { icon }),
            },
        ],
    };
}
/**
 * 到点仍未注册上时的说明行：true（已注册）给 null，false 给一行 console 说明。
 * @param registered - sidebarRightTabs 服务到点前是否完成过注册。
 * @returns 说明文字或 null。
 */
function missingServiceNote(registered) {
    if (registered)
        return null;
    return '[dsh-zcode-executor] 到点仍未出现 sidebarRightTabs 服务（宿主版本过旧或仍在加载），右侧栏「zcode 任务」不挂载';
}
};
__modules["client/register-tab.js"] = function (require, module, exports) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerTasksTab = registerTasksTab;
const index_tsx_1 = require("./client/pane/index.js");
const icons_tsx_1 = require("./client/pane/icons.js");
const tab_def_ts_1 = require("./client/tab-def.js");
/**
 * 注册右栏 tab 与本体槽位。挂载失败（比如插件重载时上下文已失活）把类型注册一并回滚，
 * 不留占死 id 的半挂载（better-sidebar 同款防守）。
 * @param ctx - 客户端根上下文。
 * @param store - 面板数据 store（T4），作为 Body 的业务面经槽位 inject 工厂下发。
 */
function registerTasksTab(ctx, store) {
    let registered = false;
    ctx.inject(['sidebarRightTabs'], (inner) => {
        // inject 已等到了服务；运行时值仍不受类型标注约束，先认值再存（better-sidebar 同款镜像法）
        const tabs = inner.get('sidebarRightTabs');
        if (tabs === undefined)
            return;
        let disposeType;
        try {
            disposeType = tabs.register((0, tab_def_ts_1.tabDefinition)(icons_tsx_1.TabGlyph));
        }
        catch (error) {
            // register 抛错只 console 一行、不 rethrow：cordis 会吞掉 fiber 里的异常，rethrow 等于
            // 无声失败；标志也不翻真，与下方 slots.inject 的 rollback 防守同款
            console.error('[dsh-zcode-executor] sidebarRightTabs.register 抛错，右侧栏「zcode 任务」不挂载', error);
            return;
        }
        registered = true;
        let disposeSlots = null;
        try {
            // keyed 槽：key = 类型 id（官方两段注册的第二段）；slots.inject 的效果活在
            // 本 inject 子 fiber 里，插件卸载自动级联；register 的业务面把 store 交给 Body。
            disposeSlots = inner.slots.inject('sidebar.right.pane.tab', () => inner.slots.register({
                name: 'sidebar.right.pane.tab',
                key: tab_def_ts_1.TAB_ID,
                inject: () => ({ store }),
            }, index_tsx_1.Body));
        }
        catch (error) {
            disposeType();
            throw error;
        }
        return () => {
            disposeSlots?.();
            disposeType();
        };
    });
    // 到点说明：到点前 registered 已翻真（服务出现并注册上）就不打印；说明措辞用「仍未出现」
    // 而非「宿主未提供」——慢宿主 10-15 秒才供上服务时，这行只是到点那刻的快照，不是版本确诊
    const timer = setTimeout(() => {
        const note = (0, tab_def_ts_1.missingServiceNote)(registered);
        if (note !== null)
            console.info(note);
    }, 10_000);
    ctx.effect(() => () => {
        clearTimeout(timer);
    }, 'zcode-executor: sidebar right fallback note');
}
};
__modules["client/pane/styles.js"] = function (require, module, exports) {
"use strict";
// src/client/pane/styles.ts —— 观察面板的全部样式，模板字符串 CSS 由 client/index.tsx 的
// apply 一次注入 <style data-plugin="dsh-zcode-executor">（zen-remote 同款机制）。
// 版式与颜色逐段对照 mockup/pane.html（2026-10-06 用户确认的视觉基准）搬运，两处系统化改动：
//   1. 类名全部加 zxe- 前缀——面板挂在宿主页面的 DOM 树里，mockup 的 .pane/.card/.row 这类
//      裸名会与宿主样式互相误伤；
//   2. 颜色只写 var(--dsw-alias-*) 官方令牌（取值由宿主提供；名字以 2026-10-07 宿主 app.asar 实测
//      名单为准——状态色是 state-*-primary 三段式，无后缀短名不存在），状态派生色 --zxe-* 定义在
//      面板根类上、全部别名到状态令牌并带字面量兜底——深浅主题随
//      body[data-ds-dark-theme] 的令牌翻转自动生效，不需要第二套取值（mockup 里自带取值
//      只是为了独立打开预览）。唯一离开令牌的取值是 mockup 也用的 rgba/白影微调，照搬。
// 与 mockup 的有意差异（2026-10-07 真机反馈三轮）：摘要行不放进滚动容器（mockup 里它 sticky 在
// 滚动容器顶），改为 flex 列里的固定行——屏上效果相同（摘要常驻顶部），分段标题才能在自己的
// 滚动容器里吸顶可见（mockup 里两层 sticky 同为 top:0，分段标题会被摘要盖住）；
// 横向内边距 12→14px（真机贴窗口边缘显得局促）；弱化灰 label-dimmed 全部升为 label-tertiary
// （深色底上 dimmed 对比不足）；图标芯片 6px 方圆角改 50% 圆形（方形底衬在真机上显突兀）。
// 图标族 2026-10-07 起统一自绘（见 icons.tsx 头注），mockup 仍是历史基准、不再逐值同步。
Object.defineProperty(exports, "__esModule", { value: true });
exports.PANE_CSS = void 0;
/** 面板样式全文；apply 时整段挂一次，dispose 时随 style 标签一起走。 */
exports.PANE_CSS = `
.zxe-pane {
  /* 状态色：宿主令牌真名带 -primary 后缀（2026-10-07 从宿主 app.asar 实测：state-success-primary /
     warn-primary / error-primary / idle-primary / business-primary——无后缀短名不存在，用错时整个
     声明作废、颜色回落成黑，真机出过一次全灰阶）；兜底字面量取 mockup 调色板，宿主将来改名只回落不糊黑 */
  --zxe-ok: var(--dsw-alias-state-success-primary, #1a7f37);
  --zxe-warn: var(--dsw-alias-state-warn-primary, #9a6700);
  --zxe-err: var(--dsw-alias-state-error-primary, #cf222e);
  --zxe-dim: var(--dsw-alias-state-idle-primary, #6e7681);
  --zxe-acc: var(--dsw-alias-state-business-primary, #4f6ef7);
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  font: 12.5px/1.55 -apple-system, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
}
.zxe-pane .zxe-mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11.5px; }

/* ---- 滚动区：摘要行之下的一切 ---- */
.zxe-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.zxe-scroll::-webkit-scrollbar { width: 8px; }
.zxe-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 4px; }

/* ---- 摘要行：三段计数 + 实时指示 ---- */
.zxe-summary {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px 8px;
  background: var(--dsw-alias-bg-layer-1);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.zxe-count {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px 1px 6px;
  border-radius: 999px;
  text-decoration: none;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.zxe-count b { font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.zxe-count .zxe-dot { width: 6px; height: 6px; border-radius: 50%; }
.zxe-count.zxe-c-todo .zxe-dot { background: var(--zxe-warn); }
.zxe-count.zxe-c-doing .zxe-dot { background: var(--zxe-ok); }
.zxe-count.zxe-c-done .zxe-dot { background: var(--zxe-dim); }
.zxe-count:hover { background: var(--dsw-alias-interactive-bg-hover); }
.zxe-live {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.zxe-live .zxe-mono { letter-spacing: .2px; }
.zxe-dclock { white-space: nowrap; }
.zxe-live[data-link="down"], .zxe-live[data-link="failed"] { color: var(--zxe-err); }

/* ---- 范围切换（本项目 / 全部项目） ---- */
.zxe-scopebar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 16px 0;
}
.zxe-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.zxe-seg button {
  border: 0;
  background: none;
  cursor: pointer;
  border-radius: 6px;
  padding: 2px 10px;
  font: inherit;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
}
.zxe-seg button[aria-pressed="true"] {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 2px rgba(0,0,0,.10);
  font-weight: 500;
}
.zxe-scope-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- 断连 / 失败横幅 ---- */
.zxe-banner {
  display: none;
  margin: 8px 16px 0;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--zxe-err);
  background: color-mix(in srgb, var(--zxe-err) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--zxe-err) 28%, transparent);
}
.zxe-pane[data-link="down"] .zxe-banner, .zxe-pane[data-link="failed"] .zxe-banner { display: block; }

/* ---- 分段标题（吸顶，吸在自己的滚动区顶） ---- */
.zxe-sechead {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 14px 16px 6px;
  background: var(--dsw-alias-bg-layer-1);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary);
}
.zxe-sechead .zxe-n { color: var(--dsw-alias-label-tertiary); font-weight: 400; }

/* ---- 空态 ---- */
.zxe-empty { padding: 10px 16px 14px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }

/* ---- 卡片 ---- */
.zxe-cards { padding: 8px 16px 4px; display: flex; flex-direction: column; gap: 8px; }
.zxe-card {
  --c: var(--zxe-dim);
  --tint: color-mix(in srgb, var(--c) 6%, transparent);
  border: 1px solid var(--dsw-alias-border-l1);
  border-left: 3px solid var(--c);
  background: linear-gradient(90deg, var(--tint), transparent 42%), var(--dsw-alias-bg-layer-1);
  border-radius: 10px;
  padding: 9px 10px 9px 11px;
}
.zxe-card.zxe-k-pend  { --c: var(--zxe-warn); }
.zxe-card.zxe-k-stale { --c: var(--zxe-err); }
.zxe-card.zxe-k-run   { --c: var(--zxe-ok); }
.zxe-card.zxe-k-queue { --c: var(--zxe-acc); }
.zxe-card.zxe-k-recent { --c: var(--zxe-dim); }
.zxe-card.zxe-k-recent[data-outcome="done"]    { --c: var(--zxe-ok); }
.zxe-card.zxe-k-recent[data-outcome="timeout"] { --c: var(--zxe-warn); }
.zxe-card.zxe-k-recent[data-outcome="failed"]  { --c: var(--zxe-err); }
/* exited（无结果记录/认不出）不单独覆盖：回落上面 .zxe-k-recent 的默认 dim，与行侧 zxe-r-exited 同色 */

.zxe-chead { display: flex; align-items: center; gap: 7px; min-width: 0; }
/* 图标底衬 2026-10-07 按用户反馈移除（先方后圆都不要）：只留 22px 槽位对齐图标，着色随 --c */
.zxe-sticon {
  flex: none;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  color: var(--c);
}
.zxe-clabel { font-weight: 600; font-size: 12.5px; flex: none; white-space: nowrap; }
.zxe-ctitle { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zxe-corner {
  margin-left: auto;
  flex: none;
  max-width: 46%;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  padding: 0 7px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.zxe-meta {
  margin-top: 3px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zxe-repotag { display: none; }
.zxe-pane[data-scope="all"] .zxe-repotag { display: inline; }

/* 挂起正文：命令/参数代码块 */
.zxe-pend-body { margin-top: 7px; }
.zxe-pend-body pre {
  margin: 0;
  padding: 7px 9px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--dsw-alias-label-secondary);
}
.zxe-reason { margin-top: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.zxe-hint { margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }

/* 回复区（Markdown）：≤2 行整段平铺（zxe-flat，复刻 CC mod 的不折叠整显）；超过则默认收起
   前两行、点「展开回复」看全文。zxe-full 只在展开态与平铺态显示——折叠态藏（按钮在 cards 层） */
.zxe-reply { margin-top: 8px; border-left: 2px solid color-mix(in srgb, var(--zxe-ok) 45%, transparent); padding-left: 9px; }
.zxe-reply .zxe-peek, .zxe-reply .zxe-full { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.zxe-reply .zxe-peek p { margin: 0 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zxe-reply .zxe-peek p:last-child::after { content: " …"; color: var(--dsw-alias-label-tertiary); }
.zxe-reply .zxe-full { display: none; }
.zxe-reply.zxe-open .zxe-full, .zxe-reply.zxe-flat .zxe-full { display: block; }
.zxe-reply.zxe-open .zxe-peek { display: none; }
.zxe-reply .zxe-full p { margin: 0 0 6px; }
.zxe-reply .zxe-full ul, .zxe-reply .zxe-full ol { margin: 0 0 6px; padding-left: 18px; }
.zxe-reply .zxe-full li { margin: 2px 0; }
.zxe-reply code {
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 4px;
  padding: 0 4px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11.5px;
}
.zxe-reply pre {
  margin: 4px 0 6px;
  padding: 7px 9px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  overflow-x: auto;
  color: var(--dsw-alias-label-secondary);
}
.zxe-reply pre code { background: none; border: 0; padding: 0; }
.zxe-fold {
  margin-top: 4px;
  border: 0;
  background: none;
  cursor: pointer;
  padding: 1px 0;
  font: inherit;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.zxe-fold:hover { color: var(--dsw-alias-label-primary); text-decoration: underline; }
.zxe-fold:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; border-radius: 4px; }

/* 工具行 */
.zxe-tools { margin-top: 7px; display: flex; flex-direction: column; gap: 2px; }
.zxe-tool { display: flex; gap: 7px; align-items: baseline; min-width: 0; font-size: 11.5px; }
.zxe-tool .zxe-g { flex: none; width: 14px; text-align: center; font-weight: 700; }
.zxe-tool .zxe-tn { flex: none; font-weight: 600; }
.zxe-tool .zxe-ts { flex: 1; min-width: 0; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zxe-tool.zxe-active .zxe-g, .zxe-tool.zxe-active .zxe-tn { color: var(--zxe-ok); }
.zxe-tool.zxe-ok .zxe-g { color: var(--dsw-alias-label-tertiary); }
.zxe-tool.zxe-ok .zxe-tn { color: var(--dsw-alias-label-secondary); }
.zxe-tool.zxe-bad .zxe-g, .zxe-tool.zxe-bad .zxe-tn { color: var(--zxe-err); }
.zxe-tool.zxe-active .zxe-ts { color: var(--dsw-alias-label-secondary); }

/* 已结束：一行一条；点行展开成卡片（看回复），卡片带「收起」收回 */
.zxe-rows { padding: 4px 16px 14px; display: flex; flex-direction: column; }
.zxe-rows .zxe-card { margin: 6px 0; }
.zxe-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 4px;
  border-radius: 6px;
  cursor: pointer;
  border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 60%, transparent);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.zxe-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.zxe-row:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: -2px; }
.zxe-row:last-child { border-bottom: 0; }
.zxe-row .zxe-ric { flex: none; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 5px; }
.zxe-row .zxe-rl { flex: none; width: 52px; font-weight: 600; font-size: 11.5px; }
.zxe-row .zxe-rt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.zxe-row .zxe-rrepo { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); display: none; }
.zxe-pane[data-scope="all"] .zxe-row .zxe-rrepo { display: inline; }
.zxe-row .zxe-rat { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.zxe-row.zxe-r-done .zxe-ric, .zxe-row.zxe-r-done .zxe-rl { color: var(--zxe-ok); }
.zxe-row.zxe-r-timeout .zxe-ric, .zxe-row.zxe-r-timeout .zxe-rl { color: var(--zxe-warn); }
.zxe-row.zxe-r-failed .zxe-ric, .zxe-row.zxe-r-failed .zxe-rl { color: var(--zxe-err); }
.zxe-row.zxe-r-cancel .zxe-ric, .zxe-row.zxe-r-cancel .zxe-rl,
.zxe-row.zxe-r-idle .zxe-ric, .zxe-row.zxe-r-idle .zxe-rl,
.zxe-row.zxe-r-exited .zxe-ric, .zxe-row.zxe-r-exited .zxe-rl { color: var(--zxe-dim); }

/* ---- 图标族 ---- */
.zxe-icon { display: block; }

/* 动态图标：执行中脉冲（呼吸点 + 扩散环，绿色） */
.zxe-apulse .zxe-p-dot { animation: zxe-breathe 1.6s ease-in-out infinite; }
.zxe-apulse .zxe-p-ring { transform-origin: 10px 10px; animation: zxe-ring 1.6s ease-out infinite; }
@keyframes zxe-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .6; } }
@keyframes zxe-ring { 0% { transform: scale(1); opacity: .5; } 75%, 100% { transform: scale(2.05); opacity: 0; } }
/* 动态图标：闲时排队（匀速转弧，蓝色） */
.zxe-aqueue .zxe-q-arc { transform-origin: 10px 10px; animation: zxe-spin 1.4s linear infinite; }
@keyframes zxe-spin { to { transform: rotate(360deg); } }
.zxe-apulse .zxe-p-ring { fill: none; stroke: var(--zxe-ok); stroke-width: 1.6; }
.zxe-apulse .zxe-p-dot { fill: var(--zxe-ok); stroke: none; }
.zxe-aqueue circle { fill: none; stroke-width: 2; }
.zxe-aqueue .zxe-q-track { stroke: color-mix(in srgb, var(--zxe-acc) 25%, transparent); }
.zxe-aqueue .zxe-q-arc { stroke: var(--zxe-acc); stroke-linecap: round; }
@media (prefers-reduced-motion: reduce) {
  .zxe-apulse .zxe-p-dot, .zxe-apulse .zxe-p-ring, .zxe-aqueue .zxe-q-arc { animation: none; }
}
`;
};
__modules["client/index.js"] = function (require, module, exports) {
"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.inject = exports.name = void 0;
exports.apply = apply;
const store_ts_1 = require("./client/store.js");
const session_cwd_ts_1 = require("./client/session-cwd.js");
const register_tab_ts_1 = require("./client/register-tab.js");
const styles_ts_1 = require("./client/pane/styles.js");
/** 客户端半场插件名（与 host 半场同名的包标识，自研插件惯例）。 */
exports.name = 'dsh-zcode-executor';
/** 需要的客户端服务：slots 挂槽位；sessions/workspaces 派生当前项目的过滤仓库。 */
exports.inject = ['slots', 'sessions', 'workspaces'];
/** 同源根：路由常量都以前导斜杠写死（store.ts 与 src/routes.ts 两处复制，测试防漂移）。 */
const BASE_URL = '';
/**
 * 「当前项目」变化时的换仓动作（PB-6）：调 repo 路由解析所属仓库进 store。主会话存在时
 * 按 `?sessionId=<主会话 id>` 解析（服务端用该会话的 cwd 判仓库；远程会话由插件桥转发到
 * 主服务端解析，本地会话 id 原样到本机路由），无主会话退回工作区路径 `?cwd=`。
 * 解析失败 / 不是 git 仓（repo null）/ 两者都没有 → scopeRepo 置 null，
 * 面板显示全部并注明（SPEC 用户故事 14 的另一面）。
 * @param isCurrent - 代际守卫：dispose 或换了新会话之后，旧回应不得倒拨新 scope。
 */
async function routeScopeRepo(store, target, isCurrent) {
    if (target === null) {
        if (isCurrent())
            store.setScopeRepo(null);
        return;
    }
    const query = 'sessionId' in target
        ? `sessionId=${encodeURIComponent(target.sessionId)}`
        : `cwd=${encodeURIComponent(target.cwd)}`;
    try {
        const res = await fetch(`${BASE_URL}${store_ts_1.REPO_PATH}?${query}`);
        if (!res.ok)
            throw new Error(`repo HTTP ${res.status}`);
        const body = (await res.json());
        if (!isCurrent())
            return;
        store.setScopeRepo(typeof body.repo === 'string' && body.repo !== '' ? body.repo : null);
    }
    catch (error) {
        if (!isCurrent())
            return;
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[zcode-executor] 解析当前项目所属仓库失败，面板显示全部：${message}`);
        store.setScopeRepo(null);
    }
}
/**
 * 浏览器半场入口。ctx.slots 由 renderer 提供、ctx.sessions/ctx.workspaces 由宿主控制器提供
 * （类型来自两个 controller 包的 /client 声明，文件尾的纯类型引入）。
 * @param ctx - 客户端根上下文。
 */
function apply(ctx) {
    // 构建号：真机排障用（宿主模块缓存按应用会话发旧 bundle，2026-10-07 连续两轮踩坑）——
    // devtools Console 里一眼核对跑的是哪版；改动记号见 git/构建时间，格式 YYYYMMDD-HHMM。
    console.info('[zcode-executor] 面板构建 20261010-1200（插件桥：远程会话看主服务端任务）');
    // 面板数据 store：每插件激活一份；start/stop 跟 fiber 走，状态不清（重载后面板保留旧数据
    // 直到流重连，重连首轮按基线对齐——归约器语义）。侧切换的清屏重开在 store.setSession 里。
    const store = (0, store_ts_1.createSnapshotStore)({ baseUrl: BASE_URL });
    ctx.effect(() => {
        store.start();
        return () => {
            store.stop();
        };
    }, 'zcode-executor: snapshot store');
    // 样式：apply 时一次注入（ zen-remote 同款）；dispose 时随 style 标签移除。
    ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-zcode-executor';
        tag.textContent = styles_ts_1.PANE_CSS;
        document.head.appendChild(tag);
        return () => {
            tag.remove();
        };
    }, 'zcode-executor: pane styles');
    // 当前项目 → 数据侧与过滤仓库：两个目录都可观察，任一变化就重派生。主会话 id 变化时
    // store.setSession（侧变化重开流、同侧只换参数）；repo 的变化检测键是「主会话 id，无
    // 主会话退工作区路径」——repo 路由进程内有缓存，但这挡得住客户端侧的重复请求。
    ctx.effect(() => {
        let lastKey = null;
        let routed = false; // 首轮即使键是 null 也要把 scope 落到「显示全部」
        let sequence = 0; // 在途请求的代际号：dispose 或换会话后，旧回应不得倒拨新 scope
        const rederive = () => {
            // 直接传参（不提中间变量）：rows 的宿主类型经参数位置的上下文推断对上 SessionRowLike
            const sessionId = (0, session_cwd_ts_1.mainSessionIdOf)(Object.values(ctx.sessions.list.getSnapshot().byId));
            // 侧判定与重开在 store 内部（与本 effect 的 repo 代际互不干扰）
            store.setSession(sessionId);
            // repo 的目标：主会话在 → sessionId 分支（服务端按会话 cwd 判仓库）；不在 → 退
            // 现有的工作区路径 cwd 分支。变化检测键同理：主会话 id 优先，无主会话用工作区路径。
            const workspaceCwd = sessionId !== null ? null : (0, session_cwd_ts_1.pickWorkspacePath)(ctx.workspaces.list.getSnapshot().items);
            const target = sessionId !== null ? { sessionId } : workspaceCwd !== null ? { cwd: workspaceCwd } : null;
            const key = sessionId ?? workspaceCwd;
            if (routed && key === lastKey)
                return; // 无变化不重路由，也不作废在途请求
            const mine = ++sequence;
            lastKey = key;
            routed = true;
            void routeScopeRepo(store, target, () => mine === sequence);
        };
        const unsubscribeSessions = ctx.sessions.list.subscribe(rederive);
        const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(rederive);
        rederive();
        return () => {
            sequence++; // 在途的 routeScopeRepo 回应作废
            unsubscribeSessions();
            unsubscribeWorkspaces();
        };
    }, 'zcode-executor: scope repo');
    // 官方右栏「zcode 任务」tab（两段注册 + 老宿主降级说明，见 register-tab.ts）。
    (0, register_tab_ts_1.registerTasksTab)(ctx, store);
}
};
var __cache = {};
function __localRequire(id) {
  if (id.charCodeAt(0) !== 46) return require(id);
  id = id.slice(2);
  var cached = __cache[id];
  if (cached) return cached.exports;
  var module = { exports: {} };
  __cache[id] = module;
  __modules[id](__localRequire, module, module.exports);
  return module.exports;
}
var module = { exports: {} };
__modules["client/index.js"](__localRequire, module, module.exports);
return module.exports; } });
