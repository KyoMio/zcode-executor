// src/client/pane/cards.tsx —— 面板的卡片族与回复渲染。信息架构与文案出自 view.ts 的纯函数
// （headOf/outcomeOf/cornerOf/replyFold），版式对照 mockup/pane.html 的卡片段；样式类见 styles.ts。
// 回复两条渲染路：宿主 MarkdownText（pane/host-modules.ts 探测，优先）与自绘轻量渲染
// （段落/加粗/行内码/列表/围栏代码块），replyMarkdown 缺失回退 reply 逐行（view.ts 已有语义）。
// 面板只看不应答：任何卡片都不得出现 approve/deny/answer 控件（AGENTS.md 硬边界）。
import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { Outcome, SessionSnapshot, ToolCall } from '../view.ts';
import { cornerOf, headOf, outcomeOf, replyFold } from '../view.ts';
import { hostModules, pickMarkdownText } from './host-modules.ts';
import { PulseIcon, QueueIcon, StatusIcon } from './icons.tsx';
import type { StatusIconKey } from './icons.tsx';

/** 卡片公共 props：一条快照 + 走字用的当前时间（分钟精度，pane/index.tsx 每分钟一跳）。 */
export interface CardProps {
  s: SessionSnapshot;
  now: number;
}

/** meta 行：会话 id 与任务单名，缺谁跳谁。 */
function metaOf(s: SessionSnapshot): string {
  return [s.id, s.task].filter((part) => typeof part === 'string' && part !== '').join(' · ');
}

/** 标题行的显示文字：会话 title 优先（人写的任务名），task 次之（任务单文件名）；空串不算命中，两者皆缺返回 undefined（CardHead 不画）。 */
function headTitleOf(s: SessionSnapshot): string | undefined {
  if (typeof s.title === 'string' && s.title !== '') return s.title;
  if (typeof s.task === 'string' && s.task !== '') return s.task;
  return undefined;
}

/** 所属仓库的显示名：路径最后一段。 */
export function repoNameOf(repo: string | null | undefined): string {
  if (typeof repo !== 'string' || repo === '') return '';
  const parts = repo.split('/').filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? repo) : repo;
}

/** 结束时刻的 HH:MM（卡片右上角与已结束行）；解析不了返回 null（不显示）。 */
export function endClockOf(iso: string | null | undefined): string | null {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 结果 → 图标键：与 outcomeOf 的文案一一对应，认不出的按已退出画。 */
function outcomeIconOf(outcome: Outcome): StatusIconKey {
  if (outcome.label === '已完成') return 'done';
  if (outcome.label === '已超时') return 'timeout';
  if (outcome.label === '执行失败') return 'fail';
  if (outcome.label === '已取消') return 'cancel';
  if (outcome.label === '空闲') return 'idle';
  return 'exited';
}

/** 结果 → 卡片 data-outcome / 行类名（styles.ts 按它染状态色）。 */
function outcomeAttrOf(outcome: Outcome): 'done' | 'timeout' | 'failed' | 'cancel' | 'idle' | 'exited' {
  if (outcome.color === 'success') return 'done';
  if (outcome.color === 'warning') return 'timeout';
  if (outcome.color === 'error') return 'failed';
  if (outcome.label === '空闲') return 'idle';
  if (outcome.label === '已取消') return 'cancel';
  return 'exited';
}

// ---- 回复渲染 ----

/** 宿主 MarkdownText 的探测结果与固定文案：模块加载时探测一次，labels 引用稳定（官方要求）。 */
const HOST_MARKDOWN = pickMarkdownText(hostModules());
const MARKDOWN_LABELS = {
  code: { copyLabel: '复制', copiedLabel: '已复制' },
  footnotes: '脚注',
} as const;

/** 行内记号的最小切分：反引号代码与加粗，其余原样。 */
function renderInline(text: string, keyBase: string): Array<string | ReactElement> {
  const parts = text.split(/(`[^`]*`|\*\*[^*]+\*\*)/g).filter((part) => part !== '');
  return parts.map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) return <code key={key}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length >= 4) return <strong key={key}>{part.slice(2, -2)}</strong>;
    return part;
  });
}

/** 自绘轻量 Markdown：段落、加粗、行内码、列表、围栏代码块——宿主拿不到时的降级路。 */
function SelfMarkdown(props: { text: string }): ReactElement {
  const blocks = useMemo(() => {
    type ListBlock = { kind: 'ul' | 'ol'; items: string[] };
    type Block = { kind: 'p'; text: string } | { kind: 'pre'; text: string } | ListBlock;
    const out: Block[] = [];
    let paragraph: string[] = [];
    let list: ListBlock | null = null;
    let fence: string[] | null = null;
    const flush = (): void => {
      if (paragraph.length > 0) {
        out.push({ kind: 'p', text: paragraph.join('\n') });
        paragraph = [];
      }
    };
    const flushList = (): void => {
      if (list !== null) {
        out.push(list);
        list = null;
      }
    };
    for (const line of props.text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) {
        if (fence === null) {
          flush();
          flushList();
          fence = [];
        } else {
          out.push({ kind: 'pre', text: fence.join('\n') });
          fence = null;
        }
        continue;
      }
      if (fence !== null) {
        fence.push(line);
        continue;
      }
      // 列表行：`- `/`* ` 无序、`N. `/`N) ` 有序（`*` 后必须空白，不吞 `**加粗**` 行）；同类行聚进当前列表
      const ulItem = /^(?:-|\*)\s+(.+)$/.exec(line);
      const olItem = ulItem === null ? /^\d+[.)]\s+(.+)$/.exec(line) : null;
      const listMatch = ulItem ?? olItem;
      if (listMatch !== null) {
        const kind: ListBlock['kind'] = ulItem !== null ? 'ul' : 'ol';
        const item = listMatch[1] ?? '';
        if (list === null || list.kind !== kind) {
          flushList();
          list = { kind, items: [] };
        }
        const current = list;
        current.items.push(item);
        continue;
      }
      if (line.trim() === '') {
        flush();
        flushList();
      } else {
        flushList();
        paragraph.push(line);
      }
    }
    if (fence !== null) out.push({ kind: 'pre', text: fence.join('\n') });
    flush();
    flushList();
    return out;
  }, [props.text]);
  return (
    <>
      {blocks.map((block, i) => {
        if (block.kind === 'pre') {
          // 内容是纯文本节点，React 转义；不存在 HTML 注入面
          return (
            <pre className="zxe-mono" key={i}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.kind === 'p') return <p key={i}>{renderInline(block.text, String(i))}</p>;
        // 剩下 ul | ol（pre 与 p 已在上面 return）
        const items = block.items.map((item, j) => <li key={j}>{renderInline(item, `${i}-${j}`)}</li>);
        return block.kind === 'ul' ? <ul key={i}>{items}</ul> : <ol key={i}>{items}</ol>;
      })}
    </>
  );
}

/** 全文按 Markdown 渲染：宿主 MarkdownText 优先，探测不到退 SelfMarkdown。 */
function MarkdownBody(props: { text: string }): ReactElement {
  if (HOST_MARKDOWN === null) return <SelfMarkdown text={props.text} />;
  const HostMarkdownText = HOST_MARKDOWN;
  return (
    <div className="zxe-md">
      <HostMarkdownText text={props.text} labels={MARKDOWN_LABELS} variant="compact" />
    </div>
  );
}

/**
 * 回复的取值（2026-10-07 真机排障定案）：快照的 replyMarkdown 是「最新一条消息」，工具消息
 * 穿插或消息切换的空窗里会短暂为空——面板若照单全收就会把已显示的中途回复顶掉。这里取
 * 「快照里最新的非空值（replyMarkdown 优先，空则 reply 行拼），仍空则沿用该会话上一次的
 * 非空值」（粘滞）；两条都没有且无缓存才不画回复区。模块级缓存随面板活，超上限清空防膨胀。
 */
const lastReplyOf = new Map<string, string>();
const REPLY_CACHE_CAP = 200;

/** 会话 → 当前应显示的回复全文；null = 不画回复区。 */
function resolveReply(s: SessionSnapshot): string | null {
  const md = typeof s.replyMarkdown === 'string' && s.replyMarkdown.trim() !== '' ? s.replyMarkdown : null;
  const lines = Array.isArray(s.reply) && s.reply.length > 0 ? s.reply.join('\n') : null;
  const fresh = md ?? lines;
  if (fresh !== null) {
    if (lastReplyOf.size >= REPLY_CACHE_CAP) lastReplyOf.clear();
    lastReplyOf.set(s.id, fresh);
    return fresh;
  }
  return lastReplyOf.get(s.id) ?? null;
}

/**
 * 回复区：复刻 CC mod replyOf 的折叠语义——有内容的行 ≤2（replyFold 判定）整段按 Markdown
 * 显示、不出按钮（zxe-flat，CSS 里与展开态同显全文）；超过 2 行默认收起成前两行 +「展开回复」，
 * 展开后全文 +「收起」。fold=false 整段显示是 CC mod 的原行为，2026-10-07 晚间修复：此前该
 * 分支渲染进 .zxe-full 却被 CSS 无条件藏死、又没有展开按钮——单段无换行的回复（真实数据约
 * 一成）与执行中每条新消息的开头整段不可见。
 * 来源 resolveReply（replyMarkdown 优先、空窗粘滞上一条；缺失回退 reply 逐行）。
 */
export function ReplyView(props: { s: SessionSnapshot }): ReactElement | null {
  const [open, setOpen] = useState(false);
  const s = props.s;
  const markdown = resolveReply(s);
  if (markdown === null) return null;
  const { fold, lines } = replyFold(markdown);
  if (!fold) {
    return (
      <div className="zxe-reply zxe-flat">
        <div className="zxe-full">
          <MarkdownBody text={markdown} />
        </div>
      </div>
    );
  }
  return (
    <div className={open ? 'zxe-reply zxe-open' : 'zxe-reply'}>
      <div className="zxe-peek">
        {lines.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
      <div className="zxe-full">
        <MarkdownBody text={markdown} />
      </div>
      <button className="zxe-fold" type="button" onClick={() => setOpen(!open)}>
        {open ? '收起' : '展开回复'}
      </button>
    </div>
  );
}

// ---- 工具行 ----

/** 一行工具：▸ 正在执行（绿）/ ✓ 完成 / ✕ 失败；摘要超长省略。 */
function ToolRow(props: { tool: ToolCall; active: boolean }): ReactElement {
  const bad = props.tool.ok === false;
  const cls = props.active ? 'zxe-tool zxe-active' : bad ? 'zxe-tool zxe-bad' : 'zxe-tool zxe-ok';
  return (
    <div className={cls}>
      <span className="zxe-g">{props.active ? '▸' : bad ? '✕' : '✓'}</span>
      <span className="zxe-tn">{props.tool.toolName ?? '未知工具'}</span>
      {typeof props.tool.summary === 'string' && props.tool.summary !== '' ? (
        <span className="zxe-ts zxe-mono">{props.tool.summary}</span>
      ) : null}
    </div>
  );
}

/** 执行中卡片的工具区：正在执行的一行 + 最近完成的至多五行（快照 recentTools 上限 5）；两者皆空则整块不画。 */
function ToolsView(props: { s: SessionSnapshot }): ReactElement | null {
  const { activeTool, recentTools } = props.s;
  const recent = Array.isArray(recentTools) ? recentTools.slice(0, 5) : [];
  if ((activeTool === undefined || activeTool === null) && recent.length === 0) return null;
  return (
    <div className="zxe-tools">
      {activeTool !== undefined && activeTool !== null ? <ToolRow tool={activeTool} active /> : null}
      {recent.map((tool, i) => (
        <ToolRow key={`${tool.toolName ?? 'tool'}-${i}`} tool={tool} active={false} />
      ))}
    </div>
  );
}

// ---- 卡片 ----

/** 卡片头：状态图标芯片 + 文案（headOf）+ 标题 + 时长角标（cornerOf）。 */
function CardHead(props: {
  icon: ReactElement;
  label: string;
  title?: string | null | undefined;
  corner: string | null;
}): ReactElement {
  return (
    <div className="zxe-chead">
      <span className="zxe-sticon">{props.icon}</span>
      <span className="zxe-clabel">{props.label}</span>
      {typeof props.title === 'string' && props.title !== '' ? <span className="zxe-ctitle">{props.title}</span> : null}
      {props.corner !== null ? <span className="zxe-corner">{props.corner}</span> : null}
    </div>
  );
}

/** 挂起卡片（待处理段）：审批请求带工具名与命令全文，提问带条数与问题文本；下方最新回复（2026-10-07 用户要求补，原版无）。 */
export function PendingCard(props: CardProps): ReactElement {
  const { s, now } = props;
  const head = headOf(s);
  const p = s.pendingDetail;
  const isQuestion = p?.kind === 'question';
  const body = isQuestion
    ? (p?.questionTexts ?? []).filter((t): t is string => typeof t === 'string' && t !== '').join('\n')
    : (typeof p?.summary === 'string' ? p.summary : '');
  const reason = typeof p?.reason === 'string' && p.reason !== '' ? p.reason : null;
  return (
    <article className="zxe-card zxe-k-pend">
      <CardHead
        icon={<StatusIcon k={isQuestion ? 'question' : 'pause'} size={16} />}
        label={head.label}
        corner={cornerOf(s, now)}
      />
      <div className="zxe-meta">{metaOf(s)}</div>
      {body !== '' ? (
        <div className="zxe-pend-body">
          <pre className="zxe-mono">{body}</pre>
          {reason !== null ? <div className="zxe-reason">原因：{reason}</div> : null}
        </div>
      ) : null}
      <ReplyView s={s} />
      <div className="zxe-hint">由派单智能体在对话中处理</div>
    </article>
  );
}

/** 中断卡片（待处理段）：回合没有正常收尾，重投或取消仍由派单智能体在对话里处理。 */
export function StaleCard(props: CardProps): ReactElement {
  const { s, now } = props;
  return (
    <article className="zxe-card zxe-k-stale">
      <CardHead
        icon={<StatusIcon k="warn" size={16} />}
        label={headOf(s).label}
        title={headTitleOf(s)}
        corner={cornerOf(s, now)}
      />
      <div className="zxe-meta">{metaOf(s)}</div>
      <ReplyView s={s} />
      <div className="zxe-hint">回合没有正常收尾；重投或取消由派单智能体在对话里处理</div>
    </article>
  );
}

/** 闲时排队卡片（执行中段）：转弧动态图标 + 排位，就绪后文案换「闲时已就绪」。 */
export function QueueCard(props: CardProps): ReactElement {
  const { s, now } = props;
  const head = headOf(s);
  const queued = s.offpeakQueue?.phase === 'queued';
  return (
    <article className="zxe-card zxe-k-queue">
      <CardHead icon={<QueueIcon size={16} />} label={head.label} corner={cornerOf(s, now)} />
      <div className="zxe-meta">
        {[s.id, s.task, queued ? '等服务器放出闲时算力' : ''].filter((part) => typeof part === 'string' && part !== '').join(' · ')}
        <span className="zxe-repotag">{s.repo ? ` · ${repoNameOf(s.repo)}` : ''}</span>
      </div>
    </article>
  );
}

/** 执行中卡片：脉冲图标、回复（Markdown + 折叠）、正在执行与最近完成的工具。 */
export function RunningCard(props: CardProps): ReactElement {
  const { s, now } = props;
  return (
    <article className="zxe-card zxe-k-run">
      <CardHead icon={<PulseIcon size={16} />} label={headOf(s).label} title={headTitleOf(s)} corner={cornerOf(s, now)} />
      <div className="zxe-meta">{metaOf(s)}</div>
      <ReplyView s={s} />
      <ToolsView s={s} />
    </article>
  );
}

/**
 * 刚结束的卡片（已结束段，30 分钟内；已结束行点开也复用它）：结果配色 + 最后回复（默认一行+展开）。
 * onCollapse 有值时多出「收起」按钮——已结束行点开成卡片的收回入口。
 */
export function RecentCard(props: CardProps & { onCollapse?: (() => void) | undefined }): ReactElement {
  // now 只为与其它卡片同构的 props 签名存在（已结束卡片没有时长角标）
  const { s, onCollapse } = props;
  const outcome = outcomeOf(s);
  return (
    <article className="zxe-card zxe-k-recent" data-outcome={outcomeAttrOf(outcome)}>
      <CardHead
        icon={<StatusIcon k={outcomeIconOf(outcome)} size={16} />}
        label={outcome.label}
        title={headTitleOf(s)}
        corner={endClockOf(s.since)}
      />
      <div className="zxe-meta">
        {metaOf(s)}
        <span className="zxe-repotag">{s.repo ? ` · ${repoNameOf(s.repo)}` : ''}</span>
      </div>
      <ReplyView s={s} />
      {onCollapse !== undefined ? (
        <button className="zxe-fold" type="button" onClick={onCollapse}>
          收起
        </button>
      ) : null}
    </article>
  );
}

/** 已结束的一行（超出 30 分钟的）：图标 + 结果 + 标题 +（全部项目时的仓库名，repo 缺失回退 cwd）+ 时刻；点行展开成卡片。 */
export function EndedRow(props: CardProps & { onToggle?: (() => void) | undefined }): ReactElement {
  const { s, onToggle } = props;
  const outcome = outcomeOf(s);
  const attr = outcomeAttrOf(outcome);
  const clock = endClockOf(s.since);
  const clickable = onToggle !== undefined;
  return (
    <div
      className={`zxe-row zxe-r-${attr}`}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? onToggle : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') onToggle();
            }
          : undefined
      }
    >
      <span className="zxe-ric">
        <StatusIcon k={outcomeIconOf(outcome)} size={15} />
      </span>
      <span className="zxe-rl">{outcome.label}</span>
      <span className="zxe-rt">{headTitleOf(s) ?? s.id}</span>
      <span className="zxe-rrepo">{repoNameOf(s.repo ?? s.cwd)}</span>
      {clock !== null ? <span className="zxe-rat zxe-mono">{clock}</span> : null}
    </div>
  );
}
