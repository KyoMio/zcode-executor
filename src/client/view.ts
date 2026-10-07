// SPDX-License-Identifier: Apache-2.0
// 衍生自 zcode-executor（github.com/kyomio/zcode-executor）的 hooks/view.mjs（Apache-2.0），
// 2026-10-07 搬入；本文件继续按 Apache-2.0 授权，许可证全文见上游仓库 LICENSE。
// src/client/view.ts —— 观察面板的纯计算：按所属仓库过滤、分三段、结果与标题文案、时长角标、
// 回复折叠判定。自 zcode-executor 的 hooks/view.mjs 逐字搬入（2026-10-07），只加 TypeScript
// 类型不改逻辑；语义与其 test/view.test.mjs 对齐（本插件的 test/view.test.mjs 是等价改写）。
// 不搬 CC mod 专属的 toastsFor / statusLine / applyLine / EMPTY_PANEL / startFailure；
// scopeNote / repoName 也在搬运清单之外（面板层的范围说明与仓库名，Task 5 需要时再补）。
// 输入是 watch --json 的快照，字段表见 zcode-executor PRD 第 4 节与 lib/snapshot.mjs:242-260。
// 纯函数：不 import lib/（mod 运行环境没有 Node 的约定沿用），不碰 DOM、不 fetch。

/** 工具调用的显示形状（真机快照 recentTools / activeTool 的成员）。 */
export interface ToolCall {
  toolName: string;
  summary?: string | null;
  ok?: boolean;
}

/** 挂起详情（zcode-executor lib/snapshot.mjs:219-230 的两种 kind）。 */
export interface PendingDetail {
  kind: 'permission' | 'question';
  toolName?: string | null;
  summary?: string | null;
  reason?: string | null;
  questionTexts?: Array<string | null>;
}

/** 闲时排队状态（zcode-executor lib/snapshot.mjs:205-206）。 */
export interface OffpeakQueue {
  phase: 'queued' | 'ready';
  position?: number | null;
}

/**
 * watch --json 的一条会话快照。所有 id 之外的字段都可缺（旧版 CLI 与容错降级，SPEC 用户故事 24），
 * 视图函数按「没有」处理。
 */
export interface SessionSnapshot {
  id: string;
  sessionId?: string | null;
  title?: string | null;
  cwd?: string | null;
  repo?: string | null;
  phase?: string | null;
  task?: string | null;
  lastOutcome?: string | null;
  since?: string | null;
  lastEndedAt?: string | null;
  lastEndOutcome?: string | null;
  reply?: string[];
  replyMarkdown?: string | null;
  activeTool?: ToolCall | null;
  recentTools?: ToolCall[];
  pendingDetail?: PendingDetail | null;
  offpeakQueue?: OffpeakQueue | null;
}

/** 已结束会话的结果与卡片标题的文案 + 配色名（配色映射归渲染层，Task 5）。 */
export interface Outcome {
  glyph: string;
  label: string;
  color: 'success' | 'warning' | 'error' | 'inactive' | 'suggestion';
}

/** 卡片标题：kind 告诉布局用哪种图标（pulse 脉冲、wait 转圈、其余用 glyph）。 */
export interface Head {
  kind: 'glyph' | 'pulse' | 'wait';
  glyph?: string;
  label: string;
  color: Outcome['color'];
}

// 已结束成卡片的窗口 30 分钟（2026-10-07 用户改规格，CC mod 原值 10 分钟）；已结束行可点开
// 成卡片（交互在 pane/cards 层，本文件只管分段）。回复折叠阈值 replyFold 见其自身注释。
const RECENT_MS = 30 * 60 * 1000; // 结束 30 分钟内的会话在「已结束」里以卡片显示
const DONE_LIMIT = 5;

const OUTCOMES: Record<string, Outcome> = {
  done: { glyph: '✓', label: '已完成', color: 'success' },
  timeout: { glyph: '◷', label: '已超时', color: 'warning' },
  failed: { glyph: '✕', label: '执行失败', color: 'error' },
  exited: { glyph: '✕', label: '执行失败', color: 'error' },
  cancelled: { glyph: '–', label: '已取消', color: 'inactive' },
};

const timeOf = (iso?: string | null): number => (iso ? Date.parse(iso) : NaN);

/** 只留所属仓库等于 repo 的会话；repo 为 null（Claude 会话不在 git 仓库里）时全留。repo 为 null 的会话在过滤时隐藏。 */
export function filterByRepo(sessions: SessionSnapshot[], repo: string | null | undefined): SessionSnapshot[] {
  if (repo === null || repo === undefined) return [...sessions];
  return sessions.filter((s) => s.repo === repo);
}

/** 已结束会话的结果文案：exited 没有结果记录时是「已退出」，idle 没有结果是「空闲」。 */
export function outcomeOf(session: SessionSnapshot): Outcome {
  const known = OUTCOMES[session.lastOutcome ?? ''];
  if (known) return known;
  if (session.phase === 'idle') return { glyph: '○', label: '空闲', color: 'inactive' };
  if (session.lastOutcome === null || session.lastOutcome === undefined) return { glyph: '–', label: '已退出', color: 'inactive' };
  return { glyph: '?', label: String(session.lastOutcome), color: 'inactive' };
}

/** 卡片标题的状态文案与配色；kind 告诉布局用哪种图标（pulse 脉冲、wait 转圈、其余用 glyph）。 */
export function headOf(session: SessionSnapshot): Head {
  if (session.phase === 'stale') return { kind: 'glyph', glyph: '⚠', label: '执行进程已中断', color: 'error' };
  if (session.phase === 'pending') {
    const p = session.pendingDetail;
    const label = p?.kind === 'question'
      ? `挂起：提问 ${p.questionTexts?.length ?? 0} 条`
      : `挂起：审批请求（${p?.toolName ?? '未知工具'}）`;
    return { kind: 'glyph', glyph: '⏸', label, color: 'warning' };
  }
  const q = session.offpeakQueue;
  if (session.phase === 'running' && q?.phase === 'queued') {
    return { kind: 'wait', label: q.position === null || q.position === undefined ? '闲时排队中' : `闲时排队中，第 ${q.position} 位`, color: 'suggestion' };
  }
  if (session.phase === 'running' && q?.phase === 'ready') return { kind: 'wait', label: '闲时已就绪，等待开始', color: 'suggestion' };
  return { kind: 'pulse', label: '执行中', color: 'success' };
}

/** 「N 分钟」「N 小时 M 分」；since 为空或解析不了给 null（卡片右上角就不显示）。 */
export function elapsed(since: string | null | undefined, now: number): string | null {
  const t = timeOf(since);
  if (Number.isNaN(t)) return null;
  const m = Math.max(0, Math.floor((now - t) / 60000));
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 卡片右上角：执行中「已运行」、挂起「已等待」、排队「已排」、中断只写时长。 */
export function cornerOf(session: SessionSnapshot, now: number): string | null {
  const span = elapsed(session.since, now);
  if (span === null) return null;
  if (session.phase === 'stale') return span;
  if (session.phase === 'pending') return `已等待 ${span}`;
  if (headOf(session).kind === 'wait') return `已排 ${span}`;
  return `已运行 ${span}`;
}

/**
 * 分三段：待处理（挂起、中断）、执行中（含闲时排队）、已结束（exited、idle）。
 * 已结束按 since 新的在前、没有 since 的排最后，只留前 limit 条（面板传 20，不传保持
 * CC mod 的 5 条）；其中结束 30 分钟内的进 recent（卡片），其余进 rows（一行，可点开成卡片）。
 * counts.done 是已结束的总数，不受 limit 限制。
 */
export function sectionsOf(sessions: SessionSnapshot[], now: number, limit: number = DONE_LIMIT): {
  todo: SessionSnapshot[];
  doing: SessionSnapshot[];
  recent: SessionSnapshot[];
  rows: SessionSnapshot[];
  counts: { todo: number; doing: number; done: number };
} {
  const newestFirst = (a: SessionSnapshot, b: SessionSnapshot) => {
    const ta = timeOf(a.since);
    const tb = timeOf(b.since);
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  };
  const todo = sessions.filter((s) => s.phase === 'pending' || s.phase === 'stale').sort(newestFirst);
  const doing = sessions.filter((s) => s.phase === 'running').sort(newestFirst);
  const ended = sessions.filter((s) => s.phase === 'exited' || s.phase === 'idle').sort(newestFirst);
  const shown = ended.slice(0, limit);
  const isRecent = (s: SessionSnapshot) => {
    const t = timeOf(s.since);
    return !Number.isNaN(t) && now - t <= RECENT_MS;
  };
  return {
    todo,
    doing,
    recent: shown.filter(isRecent),
    rows: shown.filter((s) => !isRecent(s)),
    counts: { todo: todo.length, doing: doing.length, done: ended.length },
  };
}

/**
 * 回复的一行文字（收起时用）：只去掉纯排版的 Markdown 记号，内容里的符号一个不动。
 * 行首的标题 `# `、无序列表 `- ` `* ` `+ `、引用 `> `（记号后面必须跟空格才算）；表格行（以 `|` 开头）首尾的竖线；
 * 反引号代码以外成对的 `**加粗**` 记号。有序列表的编号保留（表示步骤顺序）；`__` 一律不动（常是 `__init__` 这类内容）。
 * 纯排版的行返回 ''：空行、`…`、代码块围栏、表格分隔行、整行分隔线（`---` `***` `___`）。
 */
export function plainLine(raw: string | null | undefined): string {
  const line = String(raw ?? '').trim();
  if (!line || line === '…' || /^(```|~~~)/.test(line)) return '';
  if (line.startsWith('|') && /^[\s|:-]+$/.test(line)) return ''; // 表格分隔行 | --- | :-: |
  if (/^([-*_])(\s*\1){2,}\s*$/.test(line)) return ''; // 分隔线
  let text = line.replace(/^(#{1,6}|[-*+]|>)\s+/, '');
  if (line.startsWith('|')) text = text.replace(/^\|/, '').replace(/\|$/, '');
  return text.split(/(`[^`]*`)/).map((part, i) => (i % 2 === 1 ? part : part.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '$1'))).join('').trim();
}

/**
 * 回复要不要折叠：按原文里有内容的行（plainLine 非空）数，超过 limit 行才折叠。
 * 返回 { fold, lines }：fold 为 false 时整段按 Markdown 显示、不出按钮；为 true 时 lines 是收起时显示的前 limit 行。
 * limit = 2 复刻 CC mod 原值（2026-10-07 晚间定案：当日早先改的 1 行是在「不折叠分支被 CSS
 * 藏死、短回复整段不可见」的坏行为下定的；回到 CC mod 语义——≤2 行整段显示、>2 行收两行加展开）。
 */
export function replyFold(markdown: string | null | undefined, limit = 2): { fold: boolean; lines: string[] } {
  const lines = String(markdown ?? '').split('\n').map(plainLine).filter(Boolean);
  return { fold: lines.length > limit, lines: lines.slice(0, limit) };
}
