import type { ReactElement } from 'react';
import type { SnapshotStore } from '../store.ts';
/** 面板的「已结束」条数上限（CC mod 是 5，面板放宽到 20；SPEC 用户故事 13）。 */
export declare const PANE_DONE_LIMIT = 20;
/**
 * 面板 Body。props 的其余成员是槽位框架注入的（hooks/useSession 等），这里只用得到 store；
 * inject 工厂由 register-tab.ts 提供 { store }。
 * @param props - store 与槽位框架的标准注入。
 */
export declare function Body(props: {
    store: SnapshotStore;
}): ReactElement;
//# sourceMappingURL=index.d.ts.map