import type { ReactElement } from 'react';
import type { SessionSnapshot } from '../view.ts';
/** 卡片公共 props：一条快照 + 走字用的当前时间（分钟精度，pane/index.tsx 每分钟一跳）。 */
export interface CardProps {
    s: SessionSnapshot;
    now: number;
}
/** 所属仓库的显示名：路径最后一段。 */
export declare function repoNameOf(repo: string | null | undefined): string;
/** 结束时刻的 HH:MM（卡片右上角与已结束行）；解析不了返回 null（不显示）。 */
export declare function endClockOf(iso: string | null | undefined): string | null;
/**
 * 回复区：复刻 CC mod replyOf 的折叠语义——有内容的行 ≤2（replyFold 判定）整段按 Markdown
 * 显示、不出按钮（zxe-flat，CSS 里与展开态同显全文）；超过 2 行默认收起成前两行 +「展开回复」，
 * 展开后全文 +「收起」。fold=false 整段显示是 CC mod 的原行为，2026-10-07 晚间修复：此前该
 * 分支渲染进 .zxe-full 却被 CSS 无条件藏死、又没有展开按钮——单段无换行的回复（真实数据约
 * 一成）与执行中每条新消息的开头整段不可见。
 * 来源 resolveReply（replyMarkdown 优先、空窗粘滞上一条；缺失回退 reply 逐行）。
 */
export declare function ReplyView(props: {
    s: SessionSnapshot;
}): ReactElement | null;
/** 挂起卡片（待处理段）：审批请求带工具名与命令全文，提问带条数与问题文本；下方最新回复（2026-10-07 用户要求补，原版无）。 */
export declare function PendingCard(props: CardProps): ReactElement;
/** 中断卡片（待处理段）：回合没有正常收尾，重投或取消仍由派单智能体在对话里处理。 */
export declare function StaleCard(props: CardProps): ReactElement;
/** 闲时排队卡片（执行中段）：转弧动态图标 + 排位，就绪后文案换「闲时已就绪」。 */
export declare function QueueCard(props: CardProps): ReactElement;
/** 执行中卡片：脉冲图标、回复（Markdown + 折叠）、正在执行与最近完成的工具。 */
export declare function RunningCard(props: CardProps): ReactElement;
/**
 * 刚结束的卡片（已结束段，30 分钟内；已结束行点开也复用它）：结果配色 + 最后回复（默认一行+展开）。
 * onCollapse 有值时多出「收起」按钮——已结束行点开成卡片的收回入口。
 */
export declare function RecentCard(props: CardProps & {
    onCollapse?: (() => void) | undefined;
}): ReactElement;
/** 已结束的一行（超出 30 分钟的）：图标 + 结果 + 标题 +（全部项目时的仓库名，repo 缺失回退 cwd）+ 时刻；点行展开成卡片。 */
export declare function EndedRow(props: CardProps & {
    onToggle?: (() => void) | undefined;
}): ReactElement;
//# sourceMappingURL=cards.d.ts.map