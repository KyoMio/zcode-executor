// src/client/pane/index.tsx —— 观察面板 Body：右栏 tab 的组件本体（register-tab.ts 挂它进
// sidebar.right.pane.tab 槽）。信息架构照 view.ts 的三段语义与 mockup/pane.html 的版式：
// 摘要计数行（可点跳分段）+ 实时指示 + 时钟、范围切换（本项目/全部项目，chip 态组件内自持）、
// 断连横幅、三段（吸顶标题、计数；挂起/中断/执行中/闲时排队/刚结束成卡片、其余一行一条且
// 点行展开成卡片看回复、上限 20 条）、空态文案。数据来自 store（T4），过滤与文案全部走
// view.ts 纯函数。
// 面板只看不应答：全树没有任何 approve/deny/answer 控件（AGENTS.md 硬边界）。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import type { SnapshotStore, SnapshotStoreState } from '../store.ts';
import { filterByRepo, sectionsOf } from '../view.ts';
import type { SessionSnapshot } from '../view.ts';
import { EndedRow, PendingCard, QueueCard, RecentCard, RunningCard, StaleCard, repoNameOf } from './cards.tsx';
import { PulseIcon } from './icons.tsx';

/** 面板的「已结束」条数上限（CC mod 是 5，面板放宽到 20；SPEC 用户故事 13）。 */
export const PANE_DONE_LIMIT = 20;

type Link = SnapshotStoreState['link'];
type ScopeChip = 'proj' | 'all';
type SectionKey = 'todo' | 'doing' | 'done';

/** 每隔 tickMs 跳一次的当前时间：时长角标（已运行 N 分钟）的燃料。 */
function useNow(tickMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, tickMs);
    return () => {
      clearInterval(timer);
    };
  }, [tickMs]);
  return now;
}

const twoDigits = (n: number): string => String(n).padStart(2, '0');

/** 实时时钟 HH:MM:SS，每秒一跳（独立小组件，整面板不必跟着每秒重渲）。 */
function LiveClock(): ReactElement {
  const now = useNow(1000);
  const d = new Date(now);
  return (
    <span className="zxe-mono">
      {twoDigits(d.getHours())}:{twoDigits(d.getMinutes())}:{twoDigits(d.getSeconds())}
    </span>
  );
}

/** 摘要行：三段计数（点击滚动到对应分段）+ 实时指示（连接态着色，live 带脉冲点与时钟）+
 * 数据时钟（最后一次数据变化的时刻——与走秒的本地钟对比即可看出数据流是否停格，2026-10-07 排障加）。 */
function SummaryRow(props: {
  counts: { todo: number; doing: number; done: number };
  link: Link;
  dataAt: number;
  onJump: (section: SectionKey) => void;
}): ReactElement {
  const { counts, link, dataAt, onJump } = props;
  const chip = (key: SectionKey, cls: string, label: string, n: number): ReactElement => (
    <button type="button" className={`zxe-count ${cls}`} onClick={() => onJump(key)}>
      <span className="zxe-dot" />
      {label} <b>{n}</b>
    </button>
  );
  const d = dataAt > 0 ? new Date(dataAt) : null;
  const dataClock = d
    ? `${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}:${twoDigits(d.getSeconds())}`
    : '--:--:--';
  return (
    <div className="zxe-summary">
      {chip('todo', 'zxe-c-todo', '待处理', counts.todo)}
      {chip('doing', 'zxe-c-doing', '执行中', counts.doing)}
      {chip('done', 'zxe-c-done', '已结束', counts.done)}
      <span className="zxe-live" data-link={link} title="「数据」是最后一次数据到达的时刻：和右侧走秒的本地钟差距变大，说明数据流停格">
        <span className="zxe-dclock">数据 {dataClock}</span>
        <PulseIcon size={12} />
        <LiveClock />
      </span>
    </div>
  );
}

/** 范围切换：本项目 / 全部项目（chip 态在 Body 自持）；旁注当前仓库名或「显示全部项目」。 */
function ScopeBar(props: {
  scope: ScopeChip;
  scopeRepo: string | null;
  onChange: (scope: ScopeChip) => void;
}): ReactElement {
  const { scope, scopeRepo, onChange } = props;
  const note =
    scope === 'all' ? '显示全部项目' : scopeRepo !== null ? repoNameOf(scopeRepo) : '未识别当前项目，显示全部';
  return (
    <div className="zxe-scopebar">
      <span className="zxe-seg" role="group" aria-label="显示范围">
        <button type="button" aria-pressed={scope === 'proj'} onClick={() => onChange('proj')}>
          本项目
        </button>
        <button type="button" aria-pressed={scope === 'all'} onClick={() => onChange('all')}>
          全部项目
        </button>
      </span>
      <span className="zxe-scope-note">{note}</span>
    </div>
  );
}

/** 分段：吸顶标题（可被摘要行计数点跳过来）+ 计数 + 内容。 */
function Section(props: {
  title: string;
  count: string;
  innerRef: (el: HTMLElement | null) => void;
  empty: string;
  children: ReactElement | Array<ReactElement>;
  isEmpty: boolean;
}): ReactElement {
  return (
    <>
      <section className="zxe-sechead" ref={props.innerRef}>
        {props.title} <span className="zxe-n">{props.count}</span>
      </section>
      {props.isEmpty ? <div className="zxe-empty">{props.empty}</div> : props.children}
    </>
  );
}

/** 断连 / 启动失败横幅的文案：down 用服务端带来的原因，failed 指向 execPath 配置。 */
function bannerOf(state: SnapshotStoreState): string | null {
  if (state.link === 'down') return state.message ?? '实时连接中断，正在重连。重连完成前的变化不补提示。';
  if (state.link === 'failed') return state.message ?? 'watch 进程启动失败：请检查插件设置里的 execPath（zcode-executor 可执行文件路径）。';
  return null;
}

/** 卡片选择：待处理段挂起 → PendingCard、中断 → StaleCard。 */
function TodoCard(props: { s: SessionSnapshot; now: number }): ReactElement {
  return props.s.phase === 'stale' ? <StaleCard s={props.s} now={props.now} /> : <PendingCard s={props.s} now={props.now} />;
}

/** 执行中段：闲时排队 → QueueCard，其余 → RunningCard。 */
function DoingCard(props: { s: SessionSnapshot; now: number }): ReactElement {
  return props.s.offpeakQueue !== undefined && props.s.offpeakQueue !== null ? (
    <QueueCard s={props.s} now={props.now} />
  ) : (
    <RunningCard s={props.s} now={props.now} />
  );
}

/**
 * 面板 Body。props 的其余成员是槽位框架注入的（hooks/useSession 等），这里只用得到 store；
 * inject 工厂由 register-tab.ts 提供 { store }。
 * @param props - store 与槽位框架的标准注入。
 */
export function Body(props: { store: SnapshotStore }): ReactElement {
  const { store } = props;
  // 第三参 getServerSnapshot 只在服务端渲染取快照时用（scripts/preview.mjs 的静态预览走这条
  // 路，缺它 react-dom/server 直接抛「Missing getServerSnapshot」）；客户端挂载后仍只用第二
  // 参，行为不变——两参是同一个 getState。
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  // 时长角标的走字（每分钟）；时钟的每秒跳在 LiveClock 自持
  const now = useNow(60_000);
  // 范围 chip：本项目（按所属仓库过滤）/ 全部项目（旁路过滤并标注仓库名）
  const [scope, setScope] = useState<ScopeChip>('proj');
  // 已结束行点开的会话 id 集合：点行展开成卡片（看回复），卡片上「收起」收回成行
  const [expandedEnded, setExpandedEnded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleEnded = (id: string): void => {
    setExpandedEnded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const sectionRefs = {
    todo: useRef<HTMLElement | null>(null),
    doing: useRef<HTMLElement | null>(null),
    done: useRef<HTMLElement | null>(null),
  };
  const jumpTo = (key: SectionKey): void => {
    sectionRefs[key].current?.scrollIntoView();
  };

  const sessions = Object.values(state.table);
  // 本项目 chip 且识别到了过滤仓库才过滤；范围仓库 null（未识别）时显示全部并注明
  const repoActive = scope === 'proj' && state.scopeRepo !== null;
  const visible = repoActive ? filterByRepo(sessions, state.scopeRepo) : sessions;
  const sections = sectionsOf(visible, now, PANE_DONE_LIMIT);
  const shownDone = sections.recent.length + sections.rows.length;
  const banner = bannerOf(state);
  const isEmptyPane = visible.length === 0;

  return (
    <div className="zxe-pane" data-scope={scope} data-link={state.link}>
      <SummaryRow counts={sections.counts} link={state.link} dataAt={state.dataAt} onJump={jumpTo} />
      <div className="zxe-scroll">
        <ScopeBar scope={scope} scopeRepo={state.scopeRepo} onChange={setScope} />
        {banner !== null ? <div className="zxe-banner">{banner}</div> : null}
        {isEmptyPane ? (
          <div className="zxe-empty">没有 zcode 会话。</div>
        ) : (
          <>
            <Section
              title="待处理"
              count={String(sections.counts.todo)}
              innerRef={(el) => {
                sectionRefs.todo.current = el;
              }}
              isEmpty={sections.todo.length === 0}
              empty="没有挂起的回合。"
            >
              {/* 与已结束段同款容器：卡片族的横向留白与间距都在 .zxe-cards 上（2026-10-07 修复：
                  此前两段裸渲染导致贴边，已结束段改的 padding 对它们不生效） */}
              <div className="zxe-cards">
                {sections.todo.map((s) => (
                  <TodoCard key={s.id} s={s} now={now} />
                ))}
              </div>
            </Section>
            <Section
              title="执行中"
              count={String(sections.counts.doing)}
              innerRef={(el) => {
                sectionRefs.doing.current = el;
              }}
              isEmpty={sections.doing.length === 0}
              empty="没有执行中的回合。"
            >
              <div className="zxe-cards">
                {sections.doing.map((s) => (
                  <DoingCard key={s.id} s={s} now={now} />
                ))}
              </div>
            </Section>
            <Section
              title="已结束"
              count={shownDone > 0 ? `最近 ${shownDone} 条` : '0'}
              innerRef={(el) => {
                sectionRefs.done.current = el;
              }}
              isEmpty={shownDone === 0}
              empty="还没有结束的回合。"
            >
              <>
                {sections.recent.length > 0 ? (
                  <div className="zxe-cards">
                    {sections.recent.map((s) => (
                      <RecentCard key={s.id} s={s} now={now} />
                    ))}
                  </div>
                ) : null}
                {sections.rows.length > 0 ? (
                  <div className="zxe-rows">
                    {sections.rows.map((s) =>
                      expandedEnded.has(s.id) ? (
                        <RecentCard key={s.id} s={s} now={now} onCollapse={() => toggleEnded(s.id)} />
                      ) : (
                        <EndedRow key={s.id} s={s} now={now} onToggle={() => toggleEnded(s.id)} />
                      ),
                    )}
                  </div>
                ) : null}
              </>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
