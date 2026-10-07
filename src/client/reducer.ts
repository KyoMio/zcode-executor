// src/client/reducer.ts —— 客户端的流行归约器：watch 的一行（或一个连接事件）进 { table,
// baseline, synced }，出下一个状态。语义对应 zcode-executor CC mod hooks/view.mjs 的 applyLine
// 去 toast 版（面板不弹提示、不算状态栏，连接态改由连接事件驱动；基线/同步语义与其一致）。
// 行形状出处：zcode-executor PRD 第 4 节 watch 段（hello / session / synced / removed）；
// 纯函数：不碰 DOM、不 fetch，输入对象不被修改（React 渲染层与 store（Task 4）直接可依赖）。
// 快照字段可缺（旧版 CLI 容错，SPEC 用户故事 24）：缺 id 的行整行忽略。
import type { SessionSnapshot } from './view.ts';

/** 归约器持有的状态：table 是已同步的正式快照表，baseline 是 synced 之前只攒不生效的基线。 */
export interface ReducerState {
  table: Record<string, SessionSnapshot>;
  baseline: Record<string, SessionSnapshot>;
  synced: boolean;
}

/** 连接三态之外的第四态 failed：watch 起不来（同步前退出），同样不打断已有数据。 */
export type Link = 'starting' | 'live' | 'down' | 'failed';

/** 归约器吃的事件：watch --json 的行（PRD 第 4 节）或插件自己的连接事件。 */
export type WatchEvent =
  | { type: 'hello'; repo?: string | null }
  | { type: 'session'; session?: SessionSnapshot | null }
  | { type: 'synced' }
  | { type: 'removed'; id?: string }
  | { type: 'connection'; link: Link };

/** 初始状态（CC mod EMPTY_PANEL 的去展示字段版：展示用的连接态与时间归渲染层，Task 4/5）。 */
export function emptyState(): ReducerState {
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
export function applyEvent(state: ReducerState, msg: unknown): ReducerState {
  const { table, baseline, synced } = state;
  if (isEvent(msg, 'hello')) {
    // hello 带的 repo 故意不存进状态：每条会话快照各带自己的 repo，按仓库过滤由客户端
    // 拿 sessions + repo 自己路由（SPEC 客户端半场），不同于 CC mod 把 repo 记在 panel 上。
    return { table, baseline: {}, synced: false };
  }
  // id 只认字符串：JSON.parse 的行不受类型标注约束，数字 id 经计算键会变成 "42"，整行忽略
  if (isEvent(msg, 'session') && typeof msg.session?.id === 'string') {
    const s = msg.session;
    if (!synced) return { table, baseline: { ...baseline, [s.id]: s }, synced };
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
function isEvent<T extends WatchEvent['type']>(msg: unknown, type: T): msg is Extract<WatchEvent, { type: T }> {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === type;
}
