// hooks/pane.mjs —— 观察面板的布局（decisions D22）：拿 view.mjs 算好的分段与文案，用引擎给的元素表画一棵树。
// 不取数据、不和引擎打交道（hooks/register.mjs），不 import lib/。元素用全局 h(...) 构造（mod 不编译 JSX）。
// 颜色只写主题键（warning/success/error/suggestion/inactive），浅色与深色主题由引擎各自取色；动态图标除外，见下。
import { cornerOf, headOf, outcomeOf, replyFold, repoName, scopeNote, sectionsOf } from './view.mjs';

// 动态图标：SVG 内的 CSS 关键帧动画，按图片显示（不开 isInteractive），浏览器自己播放，不用重画。
// verified.md 2026-10-02：isInteractive 的沙箱框会被宿主不定时刷新、明显闪烁；图片模式照播不闪。
// 循环首尾帧一致，衔接处不跳。SVG 里取不到主题键，用深浅主题下都看得清的中间色。
const GREEN = '#2da44e';
const BLUE = '#2f81f7';
const svgDoc = (size, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 20 20">${body}</svg>`;

// 执行中：实心点轻微呼吸，外圈从点的边缘扩散并在 75% 处淡尽
const pulseSvg = (size) => svgDoc(size, `<style>
.dot{animation:breathe 1.6s ease-in-out infinite}
.ring{animation:ring 1.6s ease-out infinite;transform-origin:10px 10px;opacity:.6}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.7}}
@keyframes ring{0%{transform:scale(1);opacity:.6}75%{transform:scale(2.3);opacity:0}100%{transform:scale(2.3);opacity:0}}
</style>
<circle class="ring" cx="10" cy="10" r="4" fill="none" stroke="${GREEN}" stroke-width="1.5"/>
<circle class="dot" cx="10" cy="10" r="4" fill="${GREEN}"/>`);

// 闲时排队：浅色底圈上一段弧匀速转动
const waitSvg = (size) => svgDoc(size, `<style>
.arc{animation:spin 1.4s linear infinite;transform-origin:10px 10px}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
</style>
<circle cx="10" cy="10" r="6.5" fill="none" stroke="${BLUE}" stroke-opacity=".25" stroke-width="2"/>
<circle class="arc" cx="10" cy="10" r="6.5" fill="none" stroke="${BLUE}" stroke-width="2" stroke-linecap="round" stroke-dasharray="11 30"/>`);

// 终端没有 Svg：执行中用转圈字符，由 register.mjs 定时换帧（frame 递增）
export const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

// Code 与 Markdown 只许制表符与换行两种控制字符、至多 10000 字，否则整棵树被拒（类型声明 CodeProps、MarkdownProps）
const codeText = (text) => String(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').slice(0, 10000);

const hhmm = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * 画面板。model：
 *   sessions   已按所属仓库过滤好的快照数组
 *   repo       当前仓库（null 表示不在 git 仓库里，显示全部项目）
 *   updatedAt  最后收到快照的本地时间文字（HH:MM:SS），没有为 null
 *   link       'live' 实时 / 'down' 断开等重连 / 'failed' 起不来；message 是 down/failed 时的说明
 *   now        毫秒时间戳，算时长用
 *   frame      终端转圈字符的帧号
 *   expanded   展开了回复的会话 id → true
 *   onToggle   按「展开回复 / 收起」时调用，参数是会话 id
 */
export function drawPane(el, { sessions, repo, updatedAt, link = 'live', message = null, now, frame = 0, expanded = {}, onToggle }) {
  const { Box, Text, Code, Svg, Markdown, Button } = el;
  const T = (props, ...kids) => h(Text, { wrap: 'truncate-end', ...props }, ...kids);
  const showRepo = repo === null || repo === undefined; // 显示全部项目时才标仓库名
  const sections = sectionsOf(sessions, now);

  const icon = (kind, size) => {
    if (kind === 'pulse') return Svg ? h(Svg, { source: pulseSvg(size), alt: '执行中', width: size, height: size }) : h(Text, { color: 'success' }, SPINNER[frame % SPINNER.length]);
    return Svg ? h(Svg, { source: waitSvg(size), alt: '排队中', width: size, height: size }) : h(Text, { color: 'suggestion' }, '◷');
  };
  const meta = (s) => T({ dimColor: true }, [s.id, showRepo ? repoName(s) : null, s.task].filter(Boolean).join(' · '));
  const card = (color, ...kids) =>
    h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: color, paddingX: 1, marginBottom: 1 }, ...kids);
  const headRow = (lead, label, color, s, corner) =>
    h(Box, { flexDirection: 'row', justifyContent: 'space-between' },
      h(Box, { flexDirection: 'row', flexShrink: 1, alignItems: 'center', gap: 1 },
        lead,
        h(Text, { color, bold: true }, label),
        T({ bold: true }, ` ${s.title || s.id}`)),
      corner && h(Text, { dimColor: true }, corner));
  // 回复：快照带 replyMarkdown（v0.4.1 起，最新一条消息的原文）时按 Markdown 画，像 Claude 自己的回复一样。
  // 有内容的行不超过两行就整段显示、不出按钮；超过两行默认收起成前两行（第二行末尾接 …）加「展开回复」，
  // 展开后显示全文与「收起」。旧版 watch 没有这个字段时退回逐行显示。
  const markdownBox = (s) => h(Box, { paddingLeft: 2 }, h(Markdown, { text: codeText(s.replyMarkdown) }));
  const toggle = (s, label) => h(Box, { paddingLeft: 2 },
    h(Button, { key: `reply-${s.id}`, label, plain: true, dimColor: true, onPress: () => onToggle(s.id) }));
  const replyOf = (s, lastLines) => {
    if (!(s.replyMarkdown && Markdown)) return replyBlock(lastLines ? (s.reply ?? []).slice(-lastLines) : (s.reply ?? []));
    const { fold, lines } = replyFold(s.replyMarkdown);
    const canToggle = Boolean(Button && onToggle);
    if (!fold || !canToggle) return h(Box, { flexDirection: 'column', marginTop: 1 }, markdownBox(s));
    if (expanded[s.id]) return h(Box, { flexDirection: 'column', marginTop: 1 }, markdownBox(s), toggle(s, '收起'));
    return h(Box, { flexDirection: 'column', marginTop: 1 },
      ...lines.map((line, i) => h(Box, { flexDirection: 'row' },
        h(Text, { color: 'success' }, '┃ '),
        h(Box, { flexShrink: 1 }, T({}, i === lines.length - 1 ? `${line} …` : line)))),
      toggle(s, '展开回复'));
  };
  const replyBlock = (lines) => lines.length > 0 && h(Box, { flexDirection: 'column', marginTop: 1 },
    ...lines.map((line) => h(Box, { flexDirection: 'row' },
      h(Text, { color: 'success' }, '┃ '),
      h(Box, { flexShrink: 1 }, h(Text, { wrap: 'wrap' }, line)))));
  const section = (title, note) =>
    h(Box, { marginTop: 1, marginBottom: 1 }, h(Text, { bold: true }, title), h(Text, { dimColor: true }, `  ${note}`));

  const todoCard = (s) => {
    const head = headOf(s);
    const lead = h(Text, { color: head.color, bold: true }, head.glyph);
    if (s.phase === 'stale') {
      return card('error', headRow(lead, head.label, head.color, s, cornerOf(s, now)), meta(s),
        T({}, '回合没有正常收尾，需要 Claude 决定重新投递或取消。'));
    }
    const p = s.pendingDetail ?? {};
    const body = p.kind === 'question' ? (p.questionTexts ?? []).map((q, i) => `${i + 1}. ${q}`).join('\n') : p.summary;
    return card('warning', headRow(lead, head.label, head.color, s, cornerOf(s, now)), meta(s),
      body && h(Box, { marginTop: 1 }, h(Code, { source: codeText(body), language: p.kind === 'question' ? 'text' : p.toolName === 'Bash' ? 'bash' : 'text' })),
      p.reason && T({ dimColor: true }, `原因：${p.reason}`),
      T({ dimColor: true }, '由 Claude 在对话中处理'));
  };

  const doingCard = (s) => {
    const head = headOf(s);
    if (head.kind === 'wait') return card('suggestion', headRow(icon('wait', 16), head.label, head.color, s, cornerOf(s, now)), meta(s));
    return card('success',
      headRow(icon('pulse', 16), head.label, head.color, s, cornerOf(s, now)),
      meta(s),
      replyOf(s),
      s.activeTool && h(Box, { flexDirection: 'row', marginTop: 1 },
        h(Text, { color: 'success', bold: true }, `▸ ${s.activeTool.toolName}  `),
        T({}, s.activeTool.summary ?? '')),
      ...(s.recentTools ?? []).map((t) => h(Box, { flexDirection: 'row' },
        h(Text, { color: t.ok === false ? 'error' : 'inactive' }, `${t.ok === false ? '✕' : '✓'} ${t.toolName}  `),
        T({ dimColor: true }, t.summary ?? ''))));
  };

  const recentCard = (s) => {
    const o = outcomeOf(s);
    return card(o.color,
      headRow(h(Text, { color: o.color, bold: true }, o.glyph), o.label, o.color, s, s.since ? hhmm(s.since) : null),
      meta(s),
      replyOf(s, 4));
  };

  const doneRow = (s) => {
    const o = outcomeOf(s);
    return h(Box, { flexDirection: 'row', justifyContent: 'space-between' },
      h(Box, { flexDirection: 'row', flexShrink: 1 },
        h(Text, { color: o.color }, `${o.glyph} ${o.label}`.padEnd(6, '　')),
        T({}, `  ${s.title || s.id}`),
        T({ dimColor: true }, `  ${repoName(s)}`)),
      s.since && h(Text, { dimColor: true }, hhmm(s.since)));
  };

  const { counts } = sections;
  const liveMark = link === 'live'
    ? h(Box, { flexDirection: 'row', alignItems: 'center', gap: 1 }, icon('pulse', 12), h(Text, { dimColor: true }, `实时 · ${updatedAt ?? '等待数据'}`))
    : h(Text, { color: 'error' }, `● ${link === 'down' ? '已断开' : '未连接'}`);

  return h(Box, { flexDirection: 'column', paddingX: 1 },
    h(Box, { flexDirection: 'row', justifyContent: 'space-between' },
      h(Box, { flexDirection: 'row' },
        h(Text, { color: 'warning', bold: true }, `待处理 ${counts.todo}`),
        h(Text, { dimColor: true }, '  ·  '),
        h(Text, { color: 'success', bold: true }, `执行中 ${counts.doing}`),
        h(Text, { dimColor: true }, '  ·  '),
        h(Text, { dimColor: true }, `已结束 ${counts.done}`)),
      liveMark),
    link !== 'live' && message && T({ color: 'error' }, message),
    scopeNote(repo) && T({ dimColor: true }, scopeNote(repo)),
    counts.todo > 0 && section('待处理', counts.todo),
    ...sections.todo.map(todoCard),
    section('执行中', counts.doing),
    counts.doing === 0 && T({ dimColor: true }, '没有执行中的回合'),
    ...sections.doing.map(doingCard),
    counts.done > 0 && section('已结束', `最近 ${sections.recent.length + sections.rows.length} 条`),
    ...sections.recent.map(recentCard),
    ...sections.rows.map(doneRow),
  );
}
