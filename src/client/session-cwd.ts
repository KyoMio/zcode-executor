// src/client/session-cwd.ts —— 「当前项目」cwd 的派生（SPEC 客户端半场：优先主会话行，
// 无会话退工作区列表），Task 5 接 DSH ctx 时用。纯函数：不 import、不 fetch、不碰 DOM，
// 对缺字段容错（typeof 守卫）。
//
// 行形状照 dsh-zen-remote src/client/compat/types.ts 的结构镜像法：宿主两版的类型不同
// （0.1.1 SessionSummary 在 dsh-client-runtime、0.1.2 起在 dsh-api-session-controller）
// 且本插件依赖里没有这两个包，只镜像真正读的字段——mainView 读法与该文件 mainSessionIdOf
// 相同：retainedBy.mainView > 0 即「主视图正打开这个会话」，官方 uiSession publishMain
// 同款挑选（全表找第一条 mainView retain）。工作区字段对照 ~/.dsh/profiles/node_modules/
// @deepseek-ai/dsh-workspace/lib/types/types.d.ts 的 Workspace（path、updatedAt ISO-8601）。

/** 宿主会话目录行的结构最小镜像：SessionSummary.cwd + 0.1.7 的 retainedBy.mainView 引用计数。 */
export interface SessionRowLike {
  readonly cwd?: string;
  readonly retainedBy?: Readonly<{ mainView?: number }>;
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
export function mainSessionCwdOf(rows: ReadonlyArray<SessionRowLike>): string | null {
  for (const row of rows) {
    if ((row.retainedBy?.mainView ?? 0) > 0) {
      return typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null;
    }
  }
  return null;
}

/**
 * 工作区列表的 cwd 回退：唯一项直接取 path；多项取 updatedAt 最近的一条（ISO-8601 字符串
 * 字典序即时间序；缺 updatedAt 当最旧，同刻先到先得）。空列表或选中项缺 path 返回 null。
 * @param items - ctx.workspaces.list 的行。
 * @returns 工作区 path，没有可用项时 null。
 */
export function pickWorkspacePath(items: ReadonlyArray<WorkspaceRowLike>): string | null {
  let best: WorkspaceRowLike | null = null;
  for (const item of items) {
    if (best === null || String(item.updatedAt ?? '') > String(best.updatedAt ?? '')) best = item;
  }
  if (best === null) return null;
  return typeof best.path === 'string' && best.path !== '' ? best.path : null;
}
