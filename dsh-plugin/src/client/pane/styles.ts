// src/client/pane/styles.ts —— 观察面板的全部样式，模板字符串 CSS 由 client/index.tsx 的
// apply 一次注入 <style data-plugin="dsh-zcode-executor">（zen-remote 同款机制）。
// 版式与颜色逐段对照 mockup/pane.html（2026-10-06 用户确认的视觉基准）搬运，两处系统化改动：
//   1. 类名全部加 zxe- 前缀——面板挂在宿主页面的 DOM 树里，mockup 的 .pane/.card/.row 这类
//      裸名会与宿主样式互相误伤；
//   2. 颜色只写 var(--dsw-alias-*) 官方令牌（取值由宿主提供；名字以 2026-10-07 宿主 app.asar 实测
//      名单为准——状态色是 state-*-primary 三段式，无后缀短名不存在），状态派生色 --zxe-* 定义在
//      面板根类上、全部别名到状态令牌并带字面量兜底——深浅主题随
//      body[data-ds-dark-theme] 的令牌翻转自动生效，不需要第二套取值（mockup 里自带取值
//      只是为了独立打开预览）。唯一离开令牌的取值是 mockup 也用的 rgba/白影微调，照搬。
// 与 mockup 的有意差异（2026-10-07 真机反馈三轮）：摘要行不放进滚动容器（mockup 里它 sticky 在
// 滚动容器顶），改为 flex 列里的固定行——屏上效果相同（摘要常驻顶部），分段标题才能在自己的
// 滚动容器里吸顶可见（mockup 里两层 sticky 同为 top:0，分段标题会被摘要盖住）；
// 横向内边距 12→14px（真机贴窗口边缘显得局促）；弱化灰 label-dimmed 全部升为 label-tertiary
// （深色底上 dimmed 对比不足）；图标芯片 6px 方圆角改 50% 圆形（方形底衬在真机上显突兀）。
// 图标族 2026-10-07 起统一自绘（见 icons.tsx 头注），mockup 仍是历史基准、不再逐值同步。

/** 面板样式全文；apply 时整段挂一次，dispose 时随 style 标签一起走。 */
export const PANE_CSS = `
.zxe-pane {
  /* 状态色：宿主令牌真名带 -primary 后缀（2026-10-07 从宿主 app.asar 实测：state-success-primary /
     warn-primary / error-primary / idle-primary / business-primary——无后缀短名不存在，用错时整个
     声明作废、颜色回落成黑，真机出过一次全灰阶）；兜底字面量取 mockup 调色板，宿主将来改名只回落不糊黑 */
  --zxe-ok: var(--dsw-alias-state-success-primary, #1a7f37);
  --zxe-warn: var(--dsw-alias-state-warn-primary, #9a6700);
  --zxe-err: var(--dsw-alias-state-error-primary, #cf222e);
  --zxe-dim: var(--dsw-alias-state-idle-primary, #6e7681);
  --zxe-acc: var(--dsw-alias-state-business-primary, #4f6ef7);
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  font: 12.5px/1.55 -apple-system, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);
}
.zxe-pane .zxe-mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11.5px; }

/* ---- 滚动区：摘要行之下的一切 ---- */
.zxe-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.zxe-scroll::-webkit-scrollbar { width: 8px; }
.zxe-scroll::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 4px; }

/* ---- 摘要行：三段计数 + 实时指示 ---- */
.zxe-summary {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px 8px;
  flex-wrap: wrap; /* 侧栏窄时计数与时钟整体换行，不挤扁 chip（文字竖排的根因） */
  row-gap: 6px;
  background: var(--dsw-alias-bg-layer-1);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.zxe-count {
  display: inline-flex;
  flex: none; /* 不参与压缩：压缩会把「待处理 1」挤成竖排 */
  white-space: nowrap;
  align-items: center;
  gap: 5px;
  padding: 1px 8px 1px 6px;
  border-radius: 999px;
  text-decoration: none;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 11.5px;
  cursor: pointer;
}
.zxe-count b { font-weight: 600; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.zxe-count .zxe-dot { width: 6px; height: 6px; border-radius: 50%; }
.zxe-count.zxe-c-todo .zxe-dot { background: var(--zxe-warn); }
.zxe-count.zxe-c-doing .zxe-dot { background: var(--zxe-ok); }
.zxe-count.zxe-c-done .zxe-dot { background: var(--zxe-dim); }
.zxe-count:hover { background: var(--dsw-alias-interactive-bg-hover); }
.zxe-live {
  margin-left: auto;
  display: inline-flex;
  flex: none;
  white-space: nowrap;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.zxe-live .zxe-mono { letter-spacing: .2px; }
.zxe-dclock { white-space: nowrap; }
.zxe-live[data-link="down"], .zxe-live[data-link="failed"] { color: var(--zxe-err); }

/* ---- 范围切换（本项目 / 全部项目） ---- */
.zxe-scopebar {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 16px 0;
}
.zxe-seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
}
.zxe-seg button {
  border: 0;
  background: none;
  cursor: pointer;
  border-radius: 6px;
  padding: 2px 10px;
  font: inherit;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
}
.zxe-seg button[aria-pressed="true"] {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 1px 2px rgba(0,0,0,.10);
  font-weight: 500;
}
.zxe-scope-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- 断连 / 失败横幅 ---- */
.zxe-banner {
  display: none;
  margin: 8px 16px 0;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--zxe-err);
  background: color-mix(in srgb, var(--zxe-err) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--zxe-err) 28%, transparent);
}
.zxe-pane[data-link="down"] .zxe-banner, .zxe-pane[data-link="failed"] .zxe-banner { display: block; }

/* ---- 分段标题（吸顶，吸在自己的滚动区顶） ---- */
.zxe-sechead {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 14px 16px 6px;
  background: var(--dsw-alias-bg-layer-1);
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--dsw-alias-label-secondary);
}
.zxe-sechead .zxe-n { color: var(--dsw-alias-label-tertiary); font-weight: 400; }

/* ---- 空态 ---- */
.zxe-empty { padding: 10px 16px 14px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }

/* ---- 卡片 ---- */
.zxe-cards { padding: 8px 16px 4px; display: flex; flex-direction: column; gap: 8px; }
.zxe-card {
  --c: var(--zxe-dim);
  --tint: color-mix(in srgb, var(--c) 6%, transparent);
  border: 1px solid var(--dsw-alias-border-l1);
  border-left: 3px solid var(--c);
  background: linear-gradient(90deg, var(--tint), transparent 42%), var(--dsw-alias-bg-layer-1);
  border-radius: 10px;
  padding: 9px 10px 9px 11px;
}
.zxe-card.zxe-k-pend  { --c: var(--zxe-warn); }
.zxe-card.zxe-k-stale { --c: var(--zxe-err); }
.zxe-card.zxe-k-run   { --c: var(--zxe-ok); }
.zxe-card.zxe-k-queue { --c: var(--zxe-acc); }
.zxe-card.zxe-k-recent { --c: var(--zxe-dim); }
.zxe-card.zxe-k-recent[data-outcome="done"]    { --c: var(--zxe-ok); }
.zxe-card.zxe-k-recent[data-outcome="timeout"] { --c: var(--zxe-warn); }
.zxe-card.zxe-k-recent[data-outcome="failed"]  { --c: var(--zxe-err); }
/* exited（无结果记录/认不出）不单独覆盖：回落上面 .zxe-k-recent 的默认 dim，与行侧 zxe-r-exited 同色 */

.zxe-chead { display: flex; align-items: center; gap: 7px; min-width: 0; }
/* 图标底衬 2026-10-07 按用户反馈移除（先方后圆都不要）：只留 22px 槽位对齐图标，着色随 --c */
.zxe-sticon {
  flex: none;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  color: var(--c);
}
.zxe-clabel { font-weight: 600; font-size: 12.5px; flex: none; white-space: nowrap; }
.zxe-ctitle { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zxe-corner {
  margin-left: auto;
  flex: none;
  max-width: 46%;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2);
  padding: 0 7px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.zxe-meta {
  margin-top: 3px;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zxe-repotag { display: none; }
.zxe-pane[data-scope="all"] .zxe-repotag { display: inline; }

/* 挂起正文：命令/参数代码块 */
.zxe-pend-body { margin-top: 7px; }
.zxe-pend-body pre {
  margin: 0;
  padding: 7px 9px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--dsw-alias-label-secondary);
}
.zxe-reason { margin-top: 6px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.zxe-hint { margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }

/* 回复区（Markdown）：≤2 行整段平铺（zxe-flat，复刻 CC mod 的不折叠整显）；超过则默认收起
   前两行、点「展开回复」看全文。zxe-full 只在展开态与平铺态显示——折叠态藏（按钮在 cards 层） */
.zxe-reply { margin-top: 8px; border-left: 2px solid color-mix(in srgb, var(--zxe-ok) 45%, transparent); padding-left: 9px; }
.zxe-reply .zxe-peek, .zxe-reply .zxe-full { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.zxe-reply .zxe-peek p { margin: 0 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zxe-reply .zxe-peek p:last-child::after { content: " …"; color: var(--dsw-alias-label-tertiary); }
.zxe-reply .zxe-full { display: none; }
.zxe-reply.zxe-open .zxe-full, .zxe-reply.zxe-flat .zxe-full { display: block; }
.zxe-reply.zxe-open .zxe-peek { display: none; }
.zxe-reply .zxe-full p { margin: 0 0 6px; }
.zxe-reply .zxe-full ul, .zxe-reply .zxe-full ol { margin: 0 0 6px; padding-left: 18px; }
.zxe-reply .zxe-full li { margin: 2px 0; }
.zxe-reply code {
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 4px;
  padding: 0 4px;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: 11.5px;
}
.zxe-reply pre {
  margin: 4px 0 6px;
  padding: 7px 9px;
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  overflow-x: auto;
  color: var(--dsw-alias-label-secondary);
}
.zxe-reply pre code { background: none; border: 0; padding: 0; }
.zxe-fold {
  margin-top: 4px;
  border: 0;
  background: none;
  cursor: pointer;
  padding: 1px 0;
  font: inherit;
  font-size: 11px;
  color: var(--dsw-alias-label-tertiary);
}
.zxe-fold:hover { color: var(--dsw-alias-label-primary); text-decoration: underline; }
.zxe-fold:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; border-radius: 4px; }

/* 工具行 */
.zxe-tools { margin-top: 7px; display: flex; flex-direction: column; gap: 2px; }
.zxe-tool { display: flex; gap: 7px; align-items: baseline; min-width: 0; font-size: 11.5px; }
.zxe-tool .zxe-g { flex: none; width: 14px; text-align: center; font-weight: 700; }
.zxe-tool .zxe-tn { flex: none; font-weight: 600; }
.zxe-tool .zxe-ts { flex: 1; min-width: 0; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zxe-tool.zxe-active .zxe-g, .zxe-tool.zxe-active .zxe-tn { color: var(--zxe-ok); }
.zxe-tool.zxe-ok .zxe-g { color: var(--dsw-alias-label-tertiary); }
.zxe-tool.zxe-ok .zxe-tn { color: var(--dsw-alias-label-secondary); }
.zxe-tool.zxe-bad .zxe-g, .zxe-tool.zxe-bad .zxe-tn { color: var(--zxe-err); }
.zxe-tool.zxe-active .zxe-ts { color: var(--dsw-alias-label-secondary); }

/* 已结束：一行一条；点行展开成卡片（看回复），卡片带「收起」收回 */
.zxe-rows { padding: 4px 16px 14px; display: flex; flex-direction: column; }
.zxe-rows .zxe-card { margin: 6px 0; }
.zxe-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 4px;
  border-radius: 6px;
  cursor: pointer;
  border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 60%, transparent);
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
.zxe-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.zxe-row:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: -2px; }
.zxe-row:last-child { border-bottom: 0; }
.zxe-row .zxe-ric { flex: none; display: grid; place-items: center; width: 18px; height: 18px; border-radius: 5px; }
.zxe-row .zxe-rl { flex: none; width: 52px; font-weight: 600; font-size: 11.5px; }
.zxe-row .zxe-rt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary); }
.zxe-row .zxe-rrepo { flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); display: none; }
.zxe-pane[data-scope="all"] .zxe-row .zxe-rrepo { display: inline; }
.zxe-row .zxe-rat { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.zxe-row.zxe-r-done .zxe-ric, .zxe-row.zxe-r-done .zxe-rl { color: var(--zxe-ok); }
.zxe-row.zxe-r-timeout .zxe-ric, .zxe-row.zxe-r-timeout .zxe-rl { color: var(--zxe-warn); }
.zxe-row.zxe-r-failed .zxe-ric, .zxe-row.zxe-r-failed .zxe-rl { color: var(--zxe-err); }
.zxe-row.zxe-r-cancel .zxe-ric, .zxe-row.zxe-r-cancel .zxe-rl,
.zxe-row.zxe-r-idle .zxe-ric, .zxe-row.zxe-r-idle .zxe-rl,
.zxe-row.zxe-r-exited .zxe-ric, .zxe-row.zxe-r-exited .zxe-rl { color: var(--zxe-dim); }

/* ---- 图标族 ---- */
.zxe-icon { display: block; }

/* 动态图标：执行中脉冲（呼吸点 + 扩散环，绿色） */
.zxe-apulse .zxe-p-dot { animation: zxe-breathe 1.6s ease-in-out infinite; }
.zxe-apulse .zxe-p-ring { transform-origin: 10px 10px; animation: zxe-ring 1.6s ease-out infinite; }
@keyframes zxe-breathe { 0%, 100% { opacity: 1; } 50% { opacity: .6; } }
@keyframes zxe-ring { 0% { transform: scale(1); opacity: .5; } 75%, 100% { transform: scale(2.05); opacity: 0; } }
/* 动态图标：闲时排队（匀速转弧，蓝色） */
.zxe-aqueue .zxe-q-arc { transform-origin: 10px 10px; animation: zxe-spin 1.4s linear infinite; }
@keyframes zxe-spin { to { transform: rotate(360deg); } }
.zxe-apulse .zxe-p-ring { fill: none; stroke: var(--zxe-ok); stroke-width: 1.6; }
.zxe-apulse .zxe-p-dot { fill: var(--zxe-ok); stroke: none; }
.zxe-aqueue circle { fill: none; stroke-width: 2; }
.zxe-aqueue .zxe-q-track { stroke: color-mix(in srgb, var(--zxe-acc) 25%, transparent); }
.zxe-aqueue .zxe-q-arc { stroke: var(--zxe-acc); stroke-linecap: round; }
@media (prefers-reduced-motion: reduce) {
  .zxe-apulse .zxe-p-dot, .zxe-apulse .zxe-p-ring, .zxe-aqueue .zxe-q-arc { animation: none; }
}
`;
