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
export type WatchEvent = {
    type: 'hello';
    repo?: string | null;
} | {
    type: 'session';
    session?: SessionSnapshot | null;
} | {
    type: 'synced';
} | {
    type: 'removed';
    id?: string;
} | {
    type: 'connection';
    link: Link;
};
/** 初始状态（CC mod EMPTY_PANEL 的去展示字段版：展示用的连接态与时间归渲染层，Task 4/5）。 */
export declare function emptyState(): ReducerState;
/**
 * 处理一个事件，返回新状态（输入原样不动）。语义：
 * hello 开始一轮新基线并回到未同步（旧表保留到 synced，断连期间面板不清屏）；
 * 未同步时 session/removed 只动基线（重连后的首轮变化不当作面板更新）；
 * synced 行把基线整体换上成为正式表；已同步时 session 进表、removed 从表删。
 * connection 的 down / starting 同样回到未同步（之后的行只进基线），live / failed 不改同步态。
 * 认不出的行原样返回。
 */
export declare function applyEvent(state: ReducerState, msg: unknown): ReducerState;
//# sourceMappingURL=reducer.d.ts.map