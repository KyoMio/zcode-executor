// src/client/pane/icons.tsx —— 面板的状态图标族：统一自绘一族。20×20 视箱、外圈 r=7.2、
// 内芯收敛在约 5.2 宽的内芯框、1.6px 圆头描边（基准是 mockup/pane.html 的 <symbol> 表，
// 2026-10-07 按真机反馈做了两处归一：done 对勾缩进内芯框、idle 外圈 6.4→7.2）。
//
// 为什么不再用宿主 Icon*Regular 做静态映射（T5 曾做过五个）：真机上两族并存光学大小不一
// ——宿主图标的视箱与描边是它自己的一套，与自绘的 fail/cancel/idle/exited 混排时「已完成」
// 明显偏大（2026-10-07 用户真机反馈）；统一自绘换回 mockup 的整齐度，代价是不再自动跟随
// 宿主图标改版。MarkdownText 的宿主探测不受影响（host-modules.ts 只剩那一个探测）。
// 动态两个（执行中脉冲、闲时排队转弧）自绘 + CSS 关键帧（styles.ts 末段，
// prefers-reduced-motion 时停用）。
import type { ReactElement } from 'react';

/** 静态状态图标键（view.ts 的文案与配色在其外层组件选）。 */
export type StatusIconKey =
  | 'pause'
  | 'question'
  | 'warn'
  | 'done'
  | 'timeout'
  | 'fail'
  | 'cancel'
  | 'idle'
  | 'exited';

/** 20×20 视箱的公共描边属性（mockup symbol 的 g 属性）。 */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** 自绘形状表：mockup/pane.html 的 <symbol> 内容（viewBox 0 0 20 20），done/idle 两处按真机反馈归一。 */
const SELF_DRAWN: Record<StatusIconKey, ReactElement> = {
  pause: (
    <g {...STROKE}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M8 7.7v4.6M12 7.7v4.6" />
    </g>
  ),
  question: (
    <>
      <g {...STROKE}>
        <circle cx="10" cy="10" r="7.2" />
        <path d="M7.6 7.9c.2-1.5 1.2-2.4 2.5-2.4 1.4 0 2.4.9 2.4 2.1 0 .8-.4 1.3-1.1 1.8-.7.5-1 1-1 1.7" />
      </g>
      <circle cx="10" cy="13.9" r="1" fill="currentColor" />
    </>
  ),
  warn: (
    <>
      <g {...STROKE}>
        <path d="M10 3.7 17.2 16.3H2.8Z" />
        <path d="M10 8.3v3.4" />
      </g>
      <circle cx="10" cy="14.2" r="1" fill="currentColor" />
    </>
  ),
  done: (
    <g {...STROKE}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="m7.1 10.2 2 2 3.7-4.1" />
    </g>
  ),
  timeout: (
    <g {...STROKE}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M10 6.2v4l2.8 1.7" />
    </g>
  ),
  fail: (
    <g {...STROKE}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="m7.4 7.4 5.2 5.2M12.6 7.4 7.4 12.6" />
    </g>
  ),
  cancel: (
    <g {...STROKE}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M7.4 10h5.2" />
    </g>
  ),
  idle: (
    <>
      <g fill="none" stroke="currentColor" strokeWidth="1.6">
        <circle cx="10" cy="10" r="7.2" />
      </g>
      <circle cx="10" cy="10" r="1.6" fill="currentColor" />
    </>
  ),
  exited: (
    <g {...STROKE}>
      <circle cx="10" cy="10" r="7.2" />
      <path d="M7.7 12.3l4.6-4.6M8.5 7.7h3.8v3.8" />
    </g>
  ),
};

/**
 * 静态状态图标：统一自绘族（宿主映射已撤，见文件头注）。颜色随 currentColor（外层 .zxe-sticon/.zxe-row 定色）。
 * @param props - k 状态键；size 像素边长，默认 16。
 */
export function StatusIcon(props: { k: StatusIconKey; size?: number | undefined }): ReactElement {
  const size = props.size ?? 16;
  return (
    <svg className="zxe-icon" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      {SELF_DRAWN[props.k]}
    </svg>
  );
}

/**
 * 执行中的动态脉冲（呼吸点 + 扩散环，绿色）：卡片头 16、摘要实时指示 12 都用它。
 * 动画在 styles.ts 的 .zxe-apulse 段，prefers-reduced-motion 时停用。
 */
export function PulseIcon(props: { size?: number | undefined }): ReactElement {
  const size = props.size ?? 16;
  return (
    <svg className="zxe-apulse" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle className="zxe-p-ring" cx="10" cy="10" r="4.4" />
      <circle className="zxe-p-dot" cx="10" cy="10" r="4" />
    </svg>
  );
}

/** 闲时排队的动态转弧（蓝色匀速弧线 + 淡轨道圈）；动画同上受 prefers-reduced-motion 管制。 */
export function QueueIcon(props: { size?: number | undefined }): ReactElement {
  const size = props.size ?? 16;
  return (
    <svg className="zxe-aqueue" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle className="zxe-q-track" cx="10" cy="10" r="6.6" />
      <circle className="zxe-q-arc" cx="10" cy="10" r="6.6" strokeDasharray="10.4 31" />
    </svg>
  );
}

/** 右栏 guide 条目的自绘 glyph（宿主 Icon* 无同款方形拉手形；mockup 的 #i-tab）。 */
export function TabGlyph(props: { size?: number | undefined }): ReactElement {
  const size = props.size ?? 16;
  return (
    <svg className="zxe-icon" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <g {...STROKE}>
        <rect x="3.5" y="3.5" width="13" height="13" rx="3" />
        <path d="M7 12.5V10c0-1.7 1.3-3 3-3s3 1.3 3 3v2.5" />
      </g>
    </svg>
  );
}
