// hooks/view.mjs —— 观察面板的纯计算（decisions D22）：按所属仓库过滤、分三段、文案、提示判定、状态栏文字。
// 不负责画（hooks/pane.mjs）也不和引擎打交道（hooks/register.mjs）。输入是 watch --json 的快照，
// 字段见 SPEC-watch-pane D（本地记录）与 PRD 第 4 节。不 import lib/：mod 运行环境没有 Node。

const RECENT_MS = 10 * 60 * 1000; // 结束 10 分钟内的会话在「已结束」里以卡片显示
const DONE_LIMIT = 5;

const OUTCOMES = {
  done: { glyph: '✓', label: '已完成', color: 'success' },
  timeout: { glyph: '◷', label: '已超时', color: 'warning' },
  failed: { glyph: '✕', label: '执行失败', color: 'error' },
  exited: { glyph: '✕', label: '执行失败', color: 'error' },
  cancelled: { glyph: '–', label: '已取消', color: 'inactive' },
};

const timeOf = (iso) => (iso ? Date.parse(iso) : NaN);

/** 只留所属仓库等于 repo 的会话；repo 为 null（Claude 会话不在 git 仓库里）时全留。repo 为 null 的会话在过滤时隐藏。 */
export function filterByRepo(sessions, repo) {
  if (repo === null || repo === undefined) return [...sessions];
  return sessions.filter((s) => s.repo === repo);
}

/** 已结束会话的结果文案：exited 没有结果记录时是「已退出」，idle 没有结果是「空闲」。 */
export function outcomeOf(session) {
  const known = OUTCOMES[session.lastOutcome];
  if (known) return known;
  if (session.phase === 'idle') return { glyph: '○', label: '空闲', color: 'inactive' };
  if (session.lastOutcome === null || session.lastOutcome === undefined) return { glyph: '–', label: '已退出', color: 'inactive' };
  return { glyph: '?', label: String(session.lastOutcome), color: 'inactive' };
}

/** 卡片标题的状态文案与配色；kind 告诉布局用哪种图标（pulse 脉冲、wait 转圈、其余用 glyph）。 */
export function headOf(session) {
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
export function elapsed(since, now) {
  const t = timeOf(since);
  if (Number.isNaN(t)) return null;
  const m = Math.max(0, Math.floor((now - t) / 60000));
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/** 卡片右上角：执行中「已运行」、挂起「已等待」、排队「已排」、中断只写时长。 */
export function cornerOf(session, now) {
  const span = elapsed(session.since, now);
  if (span === null) return null;
  if (session.phase === 'stale') return span;
  if (session.phase === 'pending') return `已等待 ${span}`;
  if (headOf(session).kind === 'wait') return `已排 ${span}`;
  return `已运行 ${span}`;
}

/**
 * 分三段：待处理（挂起、中断）、执行中（含闲时排队）、已结束（exited、idle）。
 * 已结束按 since 新的在前、没有 since 的排最后，只留前 5 条；其中结束 10 分钟内的进 recent（卡片），其余进 rows（一行）。
 * counts.done 是已结束的总数，不受 5 条限制。
 */
export function sectionsOf(sessions, now) {
  const newestFirst = (a, b) => {
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
  const shown = ended.slice(0, DONE_LIMIT);
  const isRecent = (s) => {
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

/** 状态栏文字：只算执行中（不含闲时排队）与挂起；两项都为零返回 undefined（清掉状态栏）。 */
export function statusLine(sessions) {
  const running = sessions.filter((s) => s.phase === 'running' && headOf(s).kind === 'pulse').length;
  const pending = sessions.filter((s) => s.phase === 'pending').length;
  const parts = [];
  if (running > 0) parts.push(`${running} 个回合执行中`);
  if (pending > 0) parts.push(`${pending} 个挂起`);
  return parts.length === 0 ? undefined : `zcode：${parts.join('，')}`;
}

/**
 * 同一会话前后两份快照之间该弹的提示。prev 为空（基线里没有它）不弹。
 * 进入挂起、进入中断各一条；lastEndedAt 变了是一回合结束（不看阶段：队列里连投时 idle 可能一闪而过）。
 */
export function toastsFor(prev, next) {
  if (!prev) return [];
  const name = next.title || next.id;
  const out = [];
  if (next.phase === 'pending' && prev.phase !== 'pending') out.push(`zcode ${name} ${headOf(next).label}`);
  if (next.phase === 'stale' && prev.phase !== 'stale') out.push(`zcode ${name} 执行进程已中断`);
  if (next.lastEndedAt && next.lastEndedAt !== prev.lastEndedAt) {
    // 结果取 last.json 的 lastEndOutcome：runner 先写 last.json 后改登记簿，取样落在两次写之间时 lastOutcome 还是旧的
    out.push(`zcode ${name} 回合结束：${outcomeOf({ ...next, lastOutcome: next.lastEndOutcome ?? next.lastOutcome }).label}`);
  }
  return out;
}

/** 面板顶部的范围说明：不在 git 仓库里时注明显示的是全部项目。 */
export function scopeNote(repo) {
  return repo === null || repo === undefined ? '未在 git 仓库中，显示全部项目' : null;
}

/** 仓库根目录的最后一段，用在一行一条的已结束列表里。 */
export function repoName(session) {
  const p = session.repo ?? session.cwd ?? '';
  return p.split('/').filter(Boolean).pop() ?? '';
}

/** 面板数据的初始值（同 types/index.d.ts 的 ZcodeExecutorPanel）。 */
export const EMPTY_PANEL = { sessions: {}, repo: null, synced: false, updatedAt: null, link: 'starting', message: null };

/**
 * 处理 watch --json 的一行（PRD 第 4 节）。纯函数：输入面板数据、基线、这一行和当前时间文字，
 * 返回新面板数据、新基线、该弹的提示、状态栏文字（status 为 null 表示这一行不动状态栏）。
 * hello 开始一轮新基线；synced 之前的快照只进基线、不弹提示（重连后不补弹）；synced 时基线整体换上。
 * 提示只对本项目的会话（与面板、状态栏同一套过滤）。
 */
export function applyLine(panel, baseline, msg, clockText) {
  const statusOf = (p) => statusLine(filterByRepo(Object.values(p.sessions), p.repo));
  const keep = { panel, baseline, toasts: [], status: null };
  if (msg?.type === 'hello') {
    return { ...keep, panel: { ...panel, repo: msg.repo ?? null, synced: false }, baseline: {} };
  }
  if (msg?.type === 'session' && msg.session?.id) {
    const s = msg.session;
    if (!panel.synced) return { ...keep, baseline: { ...baseline, [s.id]: s } };
    const inScope = panel.repo === null || s.repo === panel.repo;
    const next = { ...panel, sessions: { ...panel.sessions, [s.id]: s }, updatedAt: clockText };
    return { ...keep, panel: next, toasts: inScope ? toastsFor(panel.sessions[s.id], s) : [], status: statusOf(next) };
  }
  if (msg?.type === 'removed' && msg.id) {
    if (!panel.synced) {
      const { [msg.id]: _gone, ...rest } = baseline;
      return { ...keep, baseline: rest };
    }
    const { [msg.id]: _gone, ...rest } = panel.sessions;
    const next = { ...panel, sessions: rest, updatedAt: clockText };
    return { ...keep, panel: next, status: statusOf(next) };
  }
  if (msg?.type === 'synced') {
    const next = { ...panel, sessions: { ...baseline }, synced: true, link: 'live', message: null, updatedAt: clockText };
    return { ...keep, panel: next, baseline: {}, status: statusOf(next) };
  }
  return keep;
}

/** watch 起不来时面板上的说明：只有看得出是找不到 node 时才提 nodePath 配置项。 */
export function startFailure(reason) {
  const text = String(reason ?? '').trim() || 'watch 没有输出就退出了';
  const noNode = /env: .?node|ENOENT|No such file|not found/i.test(text);
  return `启动 watch 失败：${text}${noNode ? '。可在插件配置里填写 node 路径（nodePath）' : ''}`;
}

/** 收起时回复区的一行预览：第一行有内容的文字，去掉开头的 Markdown 记号（标题、列表、引用、表格竖线）与加粗。 */
export function previewLine(markdown) {
  for (const raw of String(markdown ?? '').split('\n')) {
    const line = raw.trim();
    if (!line || line === '…' || /^(```|~~~)/.test(line) || /^\|?[\s|:-]+\|?$/.test(line)) continue;
    const text = line.replace(/^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '').replace(/^\||\|$/g, '').replace(/\*\*|__/g, '').trim();
    if (text) return text;
  }
  return '';
}
