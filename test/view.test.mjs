// 观察面板的纯计算（hooks/view.mjs）：过滤、分段、文案、提示判定、状态栏。快照形状同 watch --json（PRD 第 4 节）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_PANEL,
  applyLine,
  cornerOf,
  elapsed,
  filterByRepo,
  headOf,
  outcomeOf,
  repoName,
  scopeNote,
  sectionsOf,
  startFailure,
  statusLine,
  toastsFor,
} from '../hooks/view.mjs';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
const snap = (over) => ({
  id: 'x_00000001',
  title: 'T1',
  cwd: '/wt/app',
  repo: '/repo/app',
  phase: 'idle',
  lastOutcome: null,
  since: null,
  lastEndedAt: null,
  reply: [],
  activeTool: null,
  recentTools: [],
  pendingDetail: null,
  offpeakQueue: null,
  ...over,
});

test('只留同一所属仓库的会话，所属仓库为空的隐藏；不在 git 仓库里时全留', () => {
  const list = [snap({ id: 'a', repo: '/repo/app' }), snap({ id: 'b', repo: '/repo/other' }), snap({ id: 'c', repo: null })];
  assert.deepEqual(filterByRepo(list, '/repo/app').map((s) => s.id), ['a']);
  assert.deepEqual(filterByRepo(list, null).map((s) => s.id), ['a', 'b', 'c']);
  assert.equal(scopeNote(null), '未在 git 仓库中，显示全部项目');
  assert.equal(scopeNote('/repo/app'), null);
});

test('三段归类：挂起与中断进待处理，执行中含闲时排队，已结束按时间新的在前、只留 5 条', () => {
  const list = [
    snap({ id: 'p', phase: 'pending', since: ago(3) }),
    snap({ id: 's', phase: 'stale', since: ago(30) }),
    snap({ id: 'r', phase: 'running', since: ago(12) }),
    snap({ id: 'q', phase: 'running', since: ago(40), offpeakQueue: { phase: 'queued', position: 3 } }),
    snap({ id: 'e1', phase: 'exited', lastOutcome: 'done', since: ago(2) }),
    snap({ id: 'e2', phase: 'exited', lastOutcome: 'failed', since: ago(90) }),
    snap({ id: 'e3', phase: 'idle', since: null }),
    snap({ id: 'e4', phase: 'exited', lastOutcome: 'cancelled', since: ago(200) }),
    snap({ id: 'e5', phase: 'exited', lastOutcome: 'timeout', since: ago(300) }),
    snap({ id: 'e6', phase: 'exited', lastOutcome: 'done', since: ago(400) }),
  ];
  const s = sectionsOf(list, NOW);
  assert.deepEqual(s.todo.map((x) => x.id), ['p', 's']);
  assert.deepEqual(s.doing.map((x) => x.id), ['r', 'q']);
  assert.deepEqual(s.recent.map((x) => x.id), ['e1']); // 10 分钟内的成卡片
  assert.deepEqual(s.rows.map((x) => x.id), ['e2', 'e4', 'e5', 'e6']); // 没有 since 的 e3 排最后，被 5 条上限挤掉
  assert.deepEqual(s.counts, { todo: 2, doing: 2, done: 6 });
});

test('刚结束的卡片过了 10 分钟缩成一行', () => {
  const ended = snap({ id: 'e', phase: 'exited', lastOutcome: 'done', since: ago(10) });
  assert.equal(sectionsOf([ended], NOW).recent.length, 1);
  assert.equal(sectionsOf([ended], NOW + 60000).rows.length, 1);
});

test('卡片标题文案：审批请求、提问、中断、执行中、闲时排队与就绪', () => {
  assert.deepEqual(headOf(snap({ phase: 'pending', pendingDetail: { kind: 'permission', toolName: 'Bash', summary: 'rm -rf x', reason: '越界' } })),
    { kind: 'glyph', glyph: '⏸', label: '挂起：审批请求（Bash）', color: 'warning' });
  assert.equal(headOf(snap({ phase: 'pending', pendingDetail: { kind: 'question', questionTexts: ['a', 'b'] } })).label, '挂起：提问 2 条');
  assert.equal(headOf(snap({ phase: 'stale' })).label, '执行进程已中断');
  assert.deepEqual(headOf(snap({ phase: 'running' })), { kind: 'pulse', label: '执行中', color: 'success' });
  assert.equal(headOf(snap({ phase: 'running', offpeakQueue: { phase: 'queued', position: 3 } })).label, '闲时排队中，第 3 位');
  assert.equal(headOf(snap({ phase: 'running', offpeakQueue: { phase: 'ready', position: null } })).label, '闲时已就绪，等待开始');
});

test('已结束的结果文案：各结果、空闲、没有结果记录的已退出', () => {
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'done' })).label, '已完成');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'timeout' })).label, '已超时');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'failed' })).label, '执行失败');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'exited' })).label, '执行失败');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'cancelled' })).label, '已取消');
  assert.equal(outcomeOf(snap({ phase: 'idle', lastOutcome: null })).label, '空闲');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: null })).label, '已退出');
});

test('卡片右上角时长：执行中、挂起、排队、中断各自的说法，没有 since 不显示', () => {
  assert.equal(cornerOf(snap({ phase: 'running', since: ago(12) }), NOW), '已运行 12 分钟');
  assert.equal(cornerOf(snap({ phase: 'pending', since: ago(3) }), NOW), '已等待 3 分钟');
  assert.equal(cornerOf(snap({ phase: 'running', since: ago(75), offpeakQueue: { phase: 'queued', position: 1 } }), NOW), '已排 1 小时 15 分');
  assert.equal(cornerOf(snap({ phase: 'stale', since: ago(0) }), NOW), '不到 1 分钟');
  assert.equal(cornerOf(snap({ phase: 'running', since: null }), NOW), null);
  assert.equal(elapsed('不是时间', NOW), null);
});

test('状态栏：执行中不含闲时排队，只有一项时只写一项，都没有时清掉', () => {
  const running = snap({ phase: 'running' });
  const queued = snap({ phase: 'running', offpeakQueue: { phase: 'queued', position: 2 } });
  const pending = snap({ phase: 'pending' });
  assert.equal(statusLine([running, running, pending]), 'zcode：2 个回合执行中，1 个挂起');
  assert.equal(statusLine([pending]), 'zcode：1 个挂起');
  assert.equal(statusLine([running, queued]), 'zcode：1 个回合执行中');
  assert.equal(statusLine([queued, snap({ phase: 'exited' })]), undefined);
});

test('提示：基线里没有的不弹；进入挂起、进入中断、回合结束各弹一条', () => {
  const running = snap({ phase: 'running', title: 'W1' });
  assert.deepEqual(toastsFor(undefined, snap({ phase: 'pending' })), []);
  assert.deepEqual(toastsFor(running, { ...running, phase: 'pending', pendingDetail: { kind: 'permission', toolName: 'Bash' } }),
    ['zcode W1 挂起：审批请求（Bash）']);
  assert.deepEqual(toastsFor(running, { ...running, phase: 'stale' }), ['zcode W1 执行进程已中断']);
  assert.deepEqual(toastsFor(running, { ...running, phase: 'idle', lastOutcome: 'done', lastEndedAt: ago(0) }), ['zcode W1 回合结束：已完成']);
  // 队列里连投：阶段一直是 running，只有 lastEndedAt 变了，照样算一回合结束
  assert.deepEqual(toastsFor({ ...running, lastEndedAt: ago(5) }, { ...running, lastOutcome: 'done', lastEndedAt: ago(0) }), ['zcode W1 回合结束：已完成']);
  // 登记簿的 lastOutcome 还没跟上（runner 先写 last.json）：提示按 lastEndOutcome
  assert.deepEqual(toastsFor(running, { ...running, phase: 'idle', lastOutcome: null, lastEndOutcome: 'failed', lastEndedAt: ago(0) }), ['zcode W1 回合结束：执行失败']);
  // 挂起期间快照再变（比如工具列表）不重复弹
  const pending = { ...running, phase: 'pending', pendingDetail: { kind: 'question', questionTexts: ['a'] } };
  assert.deepEqual(toastsFor(pending, { ...pending, recentTools: [{ toolName: 'Read', summary: 'a', ok: true }] }), []);
});

test('仓库名取所属仓库最后一段，没有所属仓库时退到 cwd', () => {
  assert.equal(repoName(snap({ repo: '/Volumes/x/projects/graph-rig' })), 'graph-rig');
  assert.equal(repoName(snap({ repo: null, cwd: '/wt/zcode-executor-op6' })), 'zcode-executor-op6');
});

// pane.mjs 用全局 h 构造元素（mod 运行环境给的）；这里装一个桩，把树收成普通对象，查文案在不在。
test('布局：样稿数据在桌面与终端两种元素表下都能画出，关键文案都在树里', async () => {
  // 桩 h 按引擎类型声明（BoxProps、TextProps、SvgProps、CodeProps）核对属性名与取值：多一个不认的属性，引擎会整树拒画
  const ALLOWED = {
    Box: new Set(['key', 'flexDirection', 'flexGrow', 'flexShrink', 'alignItems', 'justifyContent', 'gap', 'width', 'height',
      'margin', 'marginX', 'marginY', 'marginTop', 'marginBottom', 'marginLeft', 'marginRight', 'padding', 'paddingX', 'paddingY',
      'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'borderStyle', 'borderColor', 'borderDimColor', 'backgroundColor', 'overflow', 'display']),
    Text: new Set(['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse', 'wrap']),
    Svg: new Set(['source', 'alt', 'width', 'height', 'isInteractive']),
    Code: new Set(['source', 'language', 'path', 'startLine', 'format']),
    Markdown: new Set(['key', 'text', 'dimColor']),
  };
  globalThis.h = (type, props, ...kids) => {
    for (const [k, v] of Object.entries(props ?? {})) {
      assert.ok(ALLOWED[type]?.has(k), `${type} 不认属性 ${k}`);
      assert.ok(['string', 'number', 'boolean'].includes(typeof v), `${type}.${k} 不是简单值`);
    }
    if (type === 'Markdown') assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(props.text) && props.text.length <= 10000, 'Markdown 内容有不许的控制字符或过长');
    if (type === 'Code') assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(props.source) && props.source.length <= 10000, 'Code 内容有不许的控制字符或过长');
    assert.equal(props?.isInteractive, undefined, 'Svg 不开交互框（桌面版会闪）');
    return { type, props: props ?? {}, kids: kids.flat() };
  };
  const { drawPane, SPINNER } = await import('../hooks/pane.mjs');
  const texts = (node) => {
    if (node === null || node === undefined || node === false) return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    const own = node.props?.source && node.type === 'Code' ? [node.props.source] : [];
    return [...own, ...node.kids.flatMap(texts)];
  };
  const types = (node) => (node && typeof node === 'object' ? [node.type, ...node.kids.flatMap(types)] : []);
  const sessions = [
    snap({ id: 'p', title: 'T5', phase: 'pending', since: ago(3), pendingDetail: { kind: 'permission', toolName: 'Bash', summary: 'rm -rf ../dist\r\necho \x1b[31mdone', reason: '任务单没有授权' } }),
    snap({ id: 'q1', title: 'T2', phase: 'pending', since: ago(1), pendingDetail: { kind: 'question', questionTexts: ['保留兼容吗？'] } }),
    snap({ id: 's', title: 'T7', phase: 'stale', since: ago(26) }),
    snap({ id: 'r', title: 'T4', phase: 'running', since: ago(12), task: 'docs/tasks/T4.md', reply: ['画板读取投影的部分已经改完。'],
      activeTool: { toolName: 'Edit', summary: 'src/board/CardFlow.tsx' },
      recentTools: [{ toolName: 'Bash', summary: 'npm test', ok: true }, { toolName: 'Bash', summary: 'npx tsc', ok: false }] }),
    snap({ id: 'q', title: 'T8', phase: 'running', since: ago(40), offpeakQueue: { phase: 'queued', position: 3 } }),
    snap({ id: 'e1', title: 'T3', phase: 'exited', lastOutcome: 'done', since: ago(2), reply: ['已完成，测试全绿。'] }),
    snap({ id: 'e2', title: 'T1', phase: 'exited', lastOutcome: 'cancelled', since: ago(130) }),
  ];
  const desktop = { Box: 'Box', Text: 'Text', Code: 'Code', Svg: 'Svg' };
  const terminal = { Box: 'Box', Text: 'Text', Code: 'Code' };
  for (const el of [desktop, terminal]) {
    const tree = drawPane(el, { sessions, repo: '/repo/app', updatedAt: '17:32:44', now: NOW, frame: 3 });
    const all = texts(tree).join('\n');
    for (const want of ['待处理 3', '执行中 2', '已结束 2', '挂起：审批请求（Bash）', 'rm -rf ../dist', '原因：任务单没有授权',
      '挂起：提问 1 条', '1. 保留兼容吗？', '执行进程已中断', '画板读取投影的部分已经改完。', '▸ Edit  ', 'src/board/CardFlow.tsx',
      '✕ Bash  ', '闲时排队中，第 3 位', '已排 40 分钟', '已运行 12 分钟', '已完成，测试全绿。', '已取消', '实时 · 17:32:44']) {
      assert.ok(all.includes(want), `缺「${want}」`);
    }
    assert.equal(types(tree).includes('Svg'), el === desktop); // 终端没有 Svg，不能出现
    if (el === terminal) assert.ok(all.includes(SPINNER[3]));
  }
  const down = texts(drawPane(desktop, { sessions: [], repo: null, updatedAt: null, link: 'down', message: '实时连接中断，5 秒后重连', now: NOW })).join('\n');
  for (const want of ['已断开', '实时连接中断，5 秒后重连', '未在 git 仓库中，显示全部项目', '没有执行中的回合']) assert.ok(down.includes(want), `缺「${want}」`);
  delete globalThis.h;
});

test('逐行处理：hello 开新基线，synced 前的快照不弹提示，synced 后的变化才弹，且只弹本项目的', () => {
  let panel = { ...EMPTY_PANEL, sessions: { old: snap({ id: 'old' }) } };
  let baseline = {};
  const step = (msg) => {
    const r = applyLine(panel, baseline, msg, '12:00:00');
    panel = r.panel;
    baseline = r.baseline;
    return r;
  };
  step({ type: 'hello', repo: '/repo/app' });
  assert.equal(panel.synced, false);
  const before = step({ type: 'session', session: snap({ id: 'a', phase: 'pending', pendingDetail: { kind: 'question', questionTexts: ['x'] } }) });
  assert.deepEqual(before.toasts, []); // 重连后的第一轮只是基线
  assert.equal(before.status, null);
  step({ type: 'session', session: snap({ id: 'b', phase: 'running', repo: '/repo/other' }) });
  step({ type: 'session', session: snap({ id: 'gone', phase: 'running' }) });
  step({ type: 'removed', id: 'gone' }); // synced 前消失的会话不带进面板
  const synced = step({ type: 'synced' });
  assert.deepEqual(Object.keys(panel.sessions).sort(), ['a', 'b']); // 旧的 old 被新基线整体换掉
  assert.equal(panel.link, 'live');
  assert.equal(synced.status, 'zcode：1 个挂起'); // b 不是本项目的，不算进状态栏
  const other = step({ type: 'session', session: snap({ id: 'b', phase: 'pending', repo: '/repo/other', pendingDetail: { kind: 'question', questionTexts: ['y'] } }) });
  assert.deepEqual(other.toasts, []); // 别的项目不弹
  const mine = step({ type: 'session', session: snap({ id: 'a', phase: 'idle', lastOutcome: 'done', lastEndedAt: ago(0), title: 'W1' }) });
  assert.deepEqual(mine.toasts, ['zcode W1 回合结束：已完成']);
  assert.equal(mine.status, undefined); // 都没了，清掉状态栏
  const removed = step({ type: 'removed', id: 'a' });
  assert.deepEqual(Object.keys(panel.sessions), ['b']);
  assert.equal(removed.status, undefined); // 删掉后状态栏照样重算
  assert.equal(step({ type: '没见过' }).panel, panel); // 不认识的行原样放过
});

test('watch 起不来的说明：看得出找不到 node 才提 nodePath', () => {
  assert.equal(startFailure('env: node: No such file or directory'), '启动 watch 失败：env: node: No such file or directory。可在插件配置里填写 node 路径（nodePath）');
  assert.equal(startFailure('zcode-executor: 不认识的命令 watch'), '启动 watch 失败：zcode-executor: 不认识的命令 watch');
  assert.equal(startFailure(''), '启动 watch 失败：watch 没有输出就退出了');
});

test('布局：快照带 replyMarkdown 时回复按 Markdown 画，没有时退回逐行；终端与桌面一样', async () => {
  globalThis.h = (type, props, ...kids) => ({ type, props: props ?? {}, kids: kids.flat() });
  const { drawPane } = await import('../hooks/pane.mjs');
  const find = (node, type) => (node && typeof node === 'object'
    ? (node.type === type ? [node] : []).concat(node.kids.flatMap((k) => find(k, type))) : []);
  const md = '## 完成情况\n\n- 改了 `a.mjs`\r\n- 测试 **707** 全过\x1b';
  const running = snap({ id: 'r', phase: 'running', since: ago(1), reply: ['旧的逐行回复'], replyMarkdown: md });
  const ended = snap({ id: 'e', phase: 'exited', lastOutcome: 'done', since: ago(2), reply: ['一', '二', '三', '四', '五'] });
  for (const el of [{ Box: 'Box', Text: 'Text', Code: 'Code', Svg: 'Svg', Markdown: 'Markdown' }, { Box: 'Box', Text: 'Text', Code: 'Code', Markdown: 'Markdown' }]) {
    const tree = drawPane(el, { sessions: [running, ended], repo: '/repo/app', updatedAt: '12:00:00', now: NOW });
    const mds = find(tree, 'Markdown');
    assert.equal(mds.length, 1); // 只有带 replyMarkdown 的执行中卡片
    assert.equal(mds[0].props.text, '## 完成情况\n\n- 改了 `a.mjs`\n- 测试 **707** 全过'); // CR 与控制字符清掉
    const texts = JSON.stringify(tree);
    assert.ok(!texts.includes('旧的逐行回复')); // 有 Markdown 就不再画逐行
    assert.ok(texts.includes('二') && !texts.includes('"一"')); // 刚结束卡片退回逐行，只留最后 4 行
  }
  delete globalThis.h;
});
