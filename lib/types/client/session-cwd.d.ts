/** 宿主会话目录行的结构最小镜像：SessionSummary.cwd + 0.1.7 的 retainedBy.mainView 引用计数。 */
export interface SessionRowLike {
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
 * 工作区列表的 cwd 回退：唯一项直接取 path；多项取 updatedAt 最近的一条（ISO-8601 字符串
 * 字典序即时间序；缺 updatedAt 当最旧，同刻先到先得）。空列表或选中项缺 path 返回 null。
 * @param items - ctx.workspaces.list 的行。
 * @returns 工作区 path，没有可用项时 null。
 */
export declare function pickWorkspacePath(items: ReadonlyArray<WorkspaceRowLike>): string | null;
//# sourceMappingURL=session-cwd.d.ts.map