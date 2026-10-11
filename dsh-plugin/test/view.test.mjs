// 客户端纯逻辑层 view 函数（src/client/view.ts）：过滤、三段、文案、折叠判定。
// 快照形状同 watch --json（zcode-executor PRD 第 4 节；字段表见其 lib/snapshot.mjs 的返回值）。
// 用例对照 zcode-executor 的 test/view.test.mjs 改写，只覆盖本插件搬入的八个函数；
// 样例快照的取值参考该先例与 mockup/pane.html 的手工样板。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cornerOf,
  elapsed,
  filterByRepo,
  headOf,
  outcomeOf,
  plainLine,
  replyFold,
  sectionsOf,
} from '../src/client/view.ts';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
// 真机快照形状（2026-10-07 zcode-executor 仓 `node bin/zcode-executor watch --json` 首轮的
// session 行，裁去长回复；字段表 PRD 第 4 节 watch 段与其 lib/snapshot.mjs:242-260）。
const snap = (over) => ({
  id: 'x_00000001',
  sessionId: 'sess_2b195e9f-4a10-40d1-bb00-3f5278864ef2',
  title: 'T1',
  cwd: '/wt/app',
  lastOutcome: null,
  repo: '/repo/app',
  phase: 'idle',
  task: null,
  since: null,
  lastEndOutcome: null,
  lastEndedAt: null,
  reply: [],
  replyMarkdown: null,
  activeTool: null,
  recentTools: [],
  pendingDetail: null,
  offpeakQueue: null,
  ...over,
});

test('过滤：只留同所属仓库的会话，所属仓库为 null 的隐藏；查全部（repo 为 null）时全留', () => {
  const list = [snap({ id: 'a', repo: '/repo/app' }), snap({ id: 'b', repo: '/repo/other' }), snap({ id: 'c', repo: null })];
  assert.deepEqual(filterByRepo(list, '/repo/app').map((s) => s.id), ['a']);
  assert.deepEqual(filterByRepo(list, null).map((s) => s.id), ['a', 'b', 'c']);
});

test('三段归类排序：挂起与中断进待处理，执行中含闲时排队，已结束按时间新的在前、只留 5 条', () => {
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
  assert.deepEqual(s.recent.map((x) => x.id), ['e1']); // 结束 30 分钟内的成卡片（2026-10-07 用户改规格，原 10 分钟）
  assert.deepEqual(s.rows.map((x) => x.id), ['e2', 'e4', 'e5', 'e6']); // 没有 since 的 e3 排最后，被 5 条上限挤掉
  assert.deepEqual(s.counts, { todo: 2, doing: 2, done: 6 }); // counts.done 是总数，不受 5 条限制
});

test('sectionsOf 的 limit 参数：传 20 时已结束 6 条全显，默认仍只留 5 条', () => {
  // 面板（Task 5）把「已结束」上限从 CC mod 搬来的 5 条放宽到 20：limit 是可选第三参，
  // 不传时默认行为逐字不变（同形状见上面「只留 5 条」那条用例）。
  const ended = Array.from({ length: 6 }, (_, i) =>
    snap({ id: `e${i}`, phase: 'exited', lastOutcome: 'done', since: ago(20 + i) }));
  const kept = sectionsOf(ended, NOW);
  assert.equal(kept.recent.length + kept.rows.length, 5);
  const wide = sectionsOf(ended, NOW, 20);
  assert.equal(wide.recent.length + wide.rows.length, 6);
  assert.equal(wide.counts.done, 6);
  // limit 只收「已结束」段的条数：待处理与执行中不受它影响
  const doing = snap({ id: 'r', phase: 'running', since: ago(1) });
  assert.deepEqual(sectionsOf([doing], NOW, 0).doing.map((x) => x.id), ['r']);
});

test('刚结束的卡片正好 30 分钟还在，再过一分钟缩成一行', () => {
  const ended = snap({ id: 'e', phase: 'exited', lastOutcome: 'done', since: ago(30) });
  assert.equal(sectionsOf([ended], NOW).recent.length, 1);
  assert.equal(sectionsOf([ended], NOW + 60000).rows.length, 1);
});

test('卡片标题文案：审批请求、提问、中断、执行中、闲时排队与就绪', () => {
  // pendingDetail 形状出处：zcode-executor lib/snapshot.mjs:219-230
  assert.deepEqual(headOf(snap({ phase: 'pending', pendingDetail: { kind: 'permission', toolName: 'Bash', summary: 'rm -rf x', reason: '越界' } })),
    { kind: 'glyph', glyph: '⏸', label: '挂起：审批请求（Bash）', color: 'warning' });
  assert.equal(headOf(snap({ phase: 'pending', pendingDetail: { kind: 'question', questionTexts: ['a', 'b'] } })).label, '挂起：提问 2 条');
  assert.equal(headOf(snap({ phase: 'stale' })).label, '执行进程已中断');
  assert.deepEqual(headOf(snap({ phase: 'running' })), { kind: 'pulse', label: '执行中', color: 'success' });
  // offpeakQueue 形状出处：zcode-executor lib/snapshot.mjs:205-206
  assert.equal(headOf(snap({ phase: 'running', offpeakQueue: { phase: 'queued', position: 3 } })).label, '闲时排队中，第 3 位');
  assert.equal(headOf(snap({ phase: 'running', offpeakQueue: { phase: 'ready', position: null } })).label, '闲时已就绪，等待开始');
  assert.equal(headOf(snap({ phase: 'running', offpeakQueue: { phase: 'queued', position: null } })).label, '闲时排队中');
});

test('已结束的结果文案：各结果、空闲、没有结果记录的已退出、认不出的原样给出', () => {
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'done' })).label, '已完成');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'timeout' })).label, '已超时');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'failed' })).label, '执行失败');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'exited' })).label, '执行失败');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'cancelled' })).label, '已取消');
  assert.equal(outcomeOf(snap({ phase: 'idle', lastOutcome: null })).label, '空闲');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: null })).label, '已退出');
  assert.equal(outcomeOf(snap({ phase: 'exited', lastOutcome: 'weird' })).label, 'weird');
});

test('卡片右上角时长：执行中、挂起、排队、中断各自的说法，没有 since 或解析不了不显示', () => {
  assert.equal(cornerOf(snap({ phase: 'running', since: ago(12) }), NOW), '已运行 12 分钟');
  assert.equal(cornerOf(snap({ phase: 'pending', since: ago(3) }), NOW), '已等待 3 分钟');
  assert.equal(cornerOf(snap({ phase: 'running', since: ago(75), offpeakQueue: { phase: 'queued', position: 1 } }), NOW), '已排 1 小时 15 分');
  assert.equal(cornerOf(snap({ phase: 'stale', since: ago(0) }), NOW), '不到 1 分钟');
  assert.equal(cornerOf(snap({ phase: 'running', since: null }), NOW), null);
  assert.equal(elapsed('不是时间', NOW), null);
});

test('回复折叠判定：按有内容的行数，超过两行才折叠，收起时给前两行（复刻 CC mod 原值；2026-10-07 晚间从当日早先的 1 行规格改回）', () => {
  // 断言与 CC mod test/view.test.mjs:267-271 逐条对齐（等价改写）
  assert.deepEqual(replyFold('一句话就完'), { fold: false, lines: ['一句话就完'] });
  assert.deepEqual(replyFold('## 标题\n\n正文一行\n\n---'), { fold: false, lines: ['标题', '正文一行'] }); // 空行与分隔线不算；两行有内容不折叠
  assert.deepEqual(replyFold('…\n\n第一\n第二\n第三'), { fold: true, lines: ['第一', '第二'] });
  assert.deepEqual(replyFold('```js\nconst a = 1;\nconst b = 2;\n```\n结束'), { fold: true, lines: ['const a = 1;', 'const b = 2;'] });
  assert.deepEqual(replyFold(''), { fold: false, lines: [] });
  // limit 显式传参仍然生效
  assert.deepEqual(replyFold('第一\n第二\n第三', 3), { fold: false, lines: ['第一', '第二', '第三'] });
});

test('收起用的一行文字：只去纯排版记号，内容里的符号不动；纯排版的行为空', () => {
  for (const [raw, want] of [
    ['## 完成情况', '完成情况'], ['**W4 完成**：加了字段', 'W4 完成：加了字段'], ['| 项 | 结果 |', '项 | 结果'],
    ['改了 `__init__.py` 与 `**kwargs`', '改了 `__init__.py` 与 `**kwargs`'], ['Python 的 __name__ 判断', 'Python 的 __name__ 判断'],
    ['**加粗** 与 `**代码里**`', '加粗 与 `**代码里**`'], ['1. 先读任务单', '1. 先读任务单'], ['a | b 两种写法', 'a | b 两种写法'],
    ['#123 已修', '#123 已修'], ['-1 度、->、*重要*、C++', '-1 度、->、*重要*、C++'], ['> 引用的话', '引用的话'], ['- 列表项', '列表项'],
    ['--- 之后的说明', '--- 之后的说明'],
    ['', ''], ['…', ''], ['```js', ''], ['| --- | :-: |', ''], ['---', ''], ['* * *', ''],
  ]) assert.equal(plainLine(raw), want, raw);
});

test('缺字段容错：缺 phase 的会话不进任何段；缺 pendingDetail 的挂起写未知工具；缺 lastOutcome 按 null 处理', () => {
  // 旧版 CLI 快照可能缺字段（SPEC 用户故事 24）：view 函数按「没有」处理，不抛错
  const bare = { id: 'x_bare' };
  const s = sectionsOf([bare], NOW);
  assert.deepEqual(s.todo, []);
  assert.deepEqual(s.doing, []);
  assert.deepEqual(s.recent, []);
  assert.deepEqual(s.rows, []);
  assert.deepEqual(s.counts, { todo: 0, doing: 0, done: 0 });
  assert.equal(headOf(snap({ phase: 'pending' })).label, '挂起：审批请求（未知工具）');
  assert.equal(outcomeOf({ id: 'x' }).label, '已退出'); // phase 与 lastOutcome 都缺
  assert.deepEqual(filterByRepo([{ id: 'a' }, snap({ id: 'b' })], '/repo/app').map((x) => x.id), ['b']); // 缺 repo 字段的会话被过滤掉
  assert.equal(cornerOf({ id: 'x', phase: 'running' }, NOW), null);
});
