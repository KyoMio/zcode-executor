import type { ReactElement } from 'react';
/** 静态状态图标键（view.ts 的文案与配色在其外层组件选）。 */
export type StatusIconKey = 'pause' | 'question' | 'warn' | 'done' | 'timeout' | 'fail' | 'cancel' | 'idle' | 'exited';
/**
 * 静态状态图标：统一自绘族（宿主映射已撤，见文件头注）。颜色随 currentColor（外层 .zxe-sticon/.zxe-row 定色）。
 * @param props - k 状态键；size 像素边长，默认 16。
 */
export declare function StatusIcon(props: {
    k: StatusIconKey;
    size?: number | undefined;
}): ReactElement;
/**
 * 执行中的动态脉冲（呼吸点 + 扩散环，绿色）：卡片头 16、摘要实时指示 12 都用它。
 * 动画在 styles.ts 的 .zxe-apulse 段，prefers-reduced-motion 时停用。
 */
export declare function PulseIcon(props: {
    size?: number | undefined;
}): ReactElement;
/** 闲时排队的动态转弧（蓝色匀速弧线 + 淡轨道圈）；动画同上受 prefers-reduced-motion 管制。 */
export declare function QueueIcon(props: {
    size?: number | undefined;
}): ReactElement;
/** 右栏 guide 条目的自绘 glyph（宿主 Icon* 无同款方形拉手形；mockup 的 #i-tab）。 */
export declare function TabGlyph(props: {
    size?: number | undefined;
}): ReactElement;
//# sourceMappingURL=icons.d.ts.map