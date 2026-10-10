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

/** 宿主会话目录行的结构最小镜像：SessionSummary.cwd + 0.1.7 的 retainedBy.mainView 引用计数。
 *  id 字段两形状都容：宿主 SessionSummary.sessionId；测试/预览桩等简化形状用 id。 */
export interface SessionRowLike {
  readonly sessionId?: string;
  readonly id?: string;
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
  const row = firstMainViewRow(rows);
  if (row === null) return null;
  return typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null;
}

/**
 * 主视图会话的 id（PB-6）：与 mainSessionCwdOf 同一行（retainedBy.mainView > 0 的第一行）。
 * id 是 store 取数请求的 sessionId 参数（远程会话为 `zr~<serverId>~<id>` 虚拟形式，桥凭
 * 它改道）。行两种 id 形状都认（见 SessionRowLike 注）；都缺时 null——不带参数即本机行为。
 * @param rows - ctx.sessions.list 的行。
 * @returns 主视图会话的 id，没有主视图行或 id 缺失时 null。
 */
export function mainSessionIdOf(rows: ReadonlyArray<SessionRowLike>): string | null {
  const row = firstMainViewRow(rows);
  if (row === null) return null;
  if (typeof row.sessionId === 'string' && row.sessionId !== '') return row.sessionId;
  return typeof row.id === 'string' && row.id !== '' ? row.id : null;
}

/** 目录里第一条主视图行（官方 publishMain 同款先到先得），没有则 null。 */
function firstMainViewRow(rows: ReadonlyArray<SessionRowLike>): SessionRowLike | null {
  for (const row of rows) {
    if ((row.retainedBy?.mainView ?? 0) > 0) return row;
  }
  return null;
}

/** zen-remote 插件桥的虚拟会话 id 前缀（`zr~<serverId>~<原始 id>`，src/virtual-id.ts 同款）。 */
export const VIRTUAL_ID_PREFIX = 'zr~';

/** 面板数据所在的「侧」：本机，或某台远程主服务端（serverId 是虚拟 id 的第二段）。 */
export type SessionSide = { readonly kind: 'local' } | { readonly kind: 'remote'; readonly serverId: string };

/**
 * 会话 id → 侧（PB-6）：`zr~` 前缀 + 非空 serverId 段 = 远程侧；本机 id（session-…）、
 * null、以及前缀后面不带 serverId 段的坏形状都算本机（坏虚拟 id 打到本机路由自然兜底，
 * 不会让面板挂死）。同侧判定只比较 serverId 字符串，不解析它的含义。
 * @param id - 主会话 id（mainSessionIdOf 的产出；null = 没有主会话）。
 * @returns 侧。
 */
export function sideOfSessionId(id: string | null): SessionSide {
  if (id === null || !id.startsWith(VIRTUAL_ID_PREFIX)) return { kind: 'local' };
  const rest = id.slice(VIRTUAL_ID_PREFIX.length);
  const separator = rest.indexOf('~');
  if (separator <= 0) return { kind: 'local' };
  return { kind: 'remote', serverId: rest.slice(0, separator) };
}

/** 两侧是否同侧：本机只跟本机同侧；远程侧再比 serverId（同机换会话算同侧）。 */
export function sideEquals(a: SessionSide, b: SessionSide): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === 'remote' && b.kind === 'remote' ? a.serverId === b.serverId : true;
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
