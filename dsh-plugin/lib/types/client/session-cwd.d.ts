/** 宿主会话目录行的结构最小镜像：SessionSummary.cwd + 0.1.7 的 retainedBy.mainView 引用计数。
 *  id 字段两形状都容：宿主 SessionSummary.sessionId；测试/预览桩等简化形状用 id。 */
export interface SessionRowLike {
    readonly sessionId?: string;
    readonly id?: string;
    readonly cwd?: string;
    readonly retainedBy?: Readonly<{
        mainView?: number;
    }>;
}
/** 宿主工作区行的结构最小镜像：Workspace.path 与 Workspace.updatedAt（ISO-8601 字符串）。 */
export interface WorkspaceRowLike {
    readonly path?: string;
    readonly updatedAt?: string;
}
/**
 * 主视图会话的 cwd：目录里第一条 retainedBy.mainView > 0 的行。行缺 cwd（子代理行等）
 * 同样算没有——返回 null，调用方退工作区路径。
 * rows 是普通数组、按顺序先到先得（官方 publishMain 同款挑第一条）；T5 接线传
 * ctx.sessions.list() 的原序或 Object.values(byId 表) 皆可，本函数不排序。
 * @param rows - ctx.sessions.list 的行。
 * @returns 主视图会话的 cwd，没有主视图行或 cwd 缺失时 null。
 */
export declare function mainSessionCwdOf(rows: ReadonlyArray<SessionRowLike>): string | null;
/**
 * 主视图会话的 id（PB-6）：与 mainSessionCwdOf 同一行（retainedBy.mainView > 0 的第一行）。
 * id 是 store 取数请求的 sessionId 参数（远程会话为 `zr~<serverId>~<id>` 虚拟形式，桥凭
 * 它改道）。行两种 id 形状都认（见 SessionRowLike 注）；都缺时 null——不带参数即本机行为。
 * @param rows - ctx.sessions.list 的行。
 * @returns 主视图会话的 id，没有主视图行或 id 缺失时 null。
 */
export declare function mainSessionIdOf(rows: ReadonlyArray<SessionRowLike>): string | null;
/** zen-remote 插件桥的虚拟会话 id 前缀（`zr~<serverId>~<原始 id>`，src/virtual-id.ts 同款）。 */
export declare const VIRTUAL_ID_PREFIX = "zr~";
/** 面板数据所在的「侧」：本机，或某台远程主服务端（serverId 是虚拟 id 的第二段）。 */
export type SessionSide = {
    readonly kind: 'local';
} | {
    readonly kind: 'remote';
    readonly serverId: string;
};
/**
 * 会话 id → 侧（PB-6）：`zr~` 前缀 + 非空 serverId 段 = 远程侧；本机 id（session-…）、
 * null、以及前缀后面不带 serverId 段的坏形状都算本机（坏虚拟 id 打到本机路由自然兜底，
 * 不会让面板挂死）。同侧判定只比较 serverId 字符串，不解析它的含义。
 * @param id - 主会话 id（mainSessionIdOf 的产出；null = 没有主会话）。
 * @returns 侧。
 */
export declare function sideOfSessionId(id: string | null): SessionSide;
/** 两侧是否同侧：本机只跟本机同侧；远程侧再比 serverId（同机换会话算同侧）。 */
export declare function sideEquals(a: SessionSide, b: SessionSide): boolean;
/**
 * 工作区列表的 cwd 回退：唯一项直接取 path；多项取 updatedAt 最近的一条（ISO-8601 字符串
 * 字典序即时间序；缺 updatedAt 当最旧，同刻先到先得）。空列表或选中项缺 path 返回 null。
 * @param items - ctx.workspaces.list 的行。
 * @returns 工作区 path，没有可用项时 null。
 */
export declare function pickWorkspacePath(items: ReadonlyArray<WorkspaceRowLike>): string | null;
//# sourceMappingURL=session-cwd.d.ts.map