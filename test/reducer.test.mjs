// 客户端流行归约器（src/client/reducer.ts）：watch 行事件（hello/session/synced/removed）与
// 连接事件进 { table, baseline, synced }，出下一个状态。语义对应 zcode-executor CC mod
// hooks/view.mjs applyLine 的去 toast 版（不弹提示、不算状态栏，连接态改由连接事件驱动）。
// 行形状出处：zcode-executor PRD 第 4 节 watch 段；样例行取自 2026-10-07 真机
// `node bin/zcode-executor watch --json` 首轮输出（hello → session×N → synced，字段见其
// lib/snapshot.mjs:242-260）；挂起与闲时快照形状出处 lib/snapshot.mjs:205-206、219-230。
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, emptyState } from '../src/client/reducer.ts';
import { headOf, cornerOf, sectionsOf, outcomeOf } from '../src/client/view.ts';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60000).toISOString();
// 真机快照形状（同 test/view.test.mjs 的 snap；字段表 PRD 第 4 节与其 lib/snapshot.mjs:242-260）
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
const sessionLine = (over) => ({ type: 'session', session: snap(over) });

test('hello 重置：基线清空、回到未同步；旧表保留到 synced 才整体换上', () => {
  const state = { table: { old: snap({ id: 'old' }) }, baseline: { stale: snap({ id: 'stale' }) }, synced: true };
  const next = applyEvent(state, { type: 'hello', repo: null });
  assert.equal(next.synced, false);
  assert.deepEqual(next.baseline, {});
  assert.deepEqual(Object.keys(next.table), ['old']); // 断连期间面板继续显示旧数据（CC mod 同语义）
});

test('未同步时 session 只进基线、removed 只删基线，正式表不动', () => {
  let state = emptyState();
  state = applyEvent(state, { type: 'hello', repo: null });
  state = applyEvent(state, sessionLine({ id: 'a', phase: 'pending', pendingDetail: { kind: 'question', questionTexts: ['x'] } }));
  state = applyEvent(state, sessionLine({ id: 'b', phase: 'running' }));
  assert.deepEqual(Object.keys(state.baseline).sort(), ['a', 'b']);
  assert.deepEqual(state.table, {});
  state = applyEvent(state, { type: 'removed', id: 'b' }); // synced 前消失的会话不带进面板
  assert.deepEqual(Object.keys(state.baseline), ['a']);
});

test('synced 把基线整体换上成为正式表，基线清空、标记已同步', () => {
  let state = emptyState();
  state = applyEvent(state, { type: 'hello', repo: '/repo/app' });
  state = applyEvent(state, sessionLine({ id: 'a', phase: 'running' }));
  state = applyEvent(state, sessionLine({ id: 'b', phase: 'idle' }));
  state = applyEvent(state, { type: 'synced' });
  assert.equal(state.synced, true);
  assert.deepEqual(Object.keys(state.table).sort(), ['a', 'b']); // hello 前的旧内容被新基线整体换掉
  assert.deepEqual(state.baseline, {});
});

test('已同步时 session 进表、removed 从表删', () => {
  let state = emptyState();
  state = applyEvent(state, { type: 'hello', repo: null });
  state = applyEvent(state, sessionLine({ id: 'a', phase: 'running' }));
  state = applyEvent(state, { type: 'synced' });
  state = applyEvent(state, sessionLine({ id: 'a', phase: 'pending', pendingDetail: { kind: 'permission', toolName: 'Bash' } }));
  assert.equal(state.table.a.phase, 'pending'); // 同 id 的行整份覆盖
  state = applyEvent(state, sessionLine({ id: 'c', phase: 'exited', lastOutcome: 'done' }));
  assert.deepEqual(Object.keys(state.table).sort(), ['a', 'c']);
  state = applyEvent(state, { type: 'removed', id: 'a' });
  assert.deepEqual(Object.keys(state.table), ['c']);
});

test('连接事件：down/starting 回到未同步、之后的行只进基线；live/failed 不动同步态', () => {
  let state = emptyState();
  state = applyEvent(state, { type: 'hello', repo: null });
  state = applyEvent(state, sessionLine({ id: 'a', phase: 'running' }));
  state = applyEvent(state, { type: 'synced' });
  state = applyEvent(state, { type: 'connection', link: 'down' });
  assert.equal(state.synced, false);
  assert.deepEqual(Object.keys(state.table), ['a']); // 断连不清屏
  state = applyEvent(state, sessionLine({ id: 'b', phase: 'running' }));
  assert.deepEqual(Object.keys(state.baseline), ['b']); // 之后的行只进基线
  assert.deepEqual(Object.keys(state.table), ['a']);
  state = applyEvent(state, { type: 'connection', link: 'starting' });
  assert.equal(state.synced, false);
  state = applyEvent(state, { type: 'connection', link: 'live' });
  state = applyEvent(state, { type: 'connection', link: 'failed' });
  assert.equal(state.synced, false); // live/failed 都不把未同步态置成已同步，等 synced 行
  // 已同步态下 live/failed 也不打断同步
  let live = emptyState();
  live = applyEvent(live, { type: 'synced' });
  assert.equal(applyEvent(live, { type: 'connection', link: 'live' }).synced, true);
});

test('重复行幂等：同一 session 行连发两遍与一遍结果一致；removed 删过的再删一遍无变化', () => {
  let once = emptyState();
  once = applyEvent(once, { type: 'synced' });
  const line = sessionLine({ id: 'a', phase: 'running', since: ago(1) });
  once = applyEvent(once, line);
  let twice = applyEvent(once, line);
  assert.deepEqual(twice, once);
  const removedOnce = applyEvent(once, { type: 'removed', id: 'a' });
  assert.deepEqual(applyEvent(removedOnce, { type: 'removed', id: 'a' }), removedOnce);
});

test('容错：缺 session/id 的行与未知 type 原样返回；缺字段的快照照常进表', () => {
  const state = emptyState();
  const before = { table: { a: snap({ id: 'a' }) }, baseline: { b: snap({ id: 'b' }) }, synced: true };
  for (const bad of [
    { type: 'session' }, // 没有 session
    { type: 'session', session: {} }, // 快照没有 id
    { type: 'session', session: null },
    { type: 'removed' }, // 没有 id
    { type: 'removed', id: '' },
    { type: '没见过' },
    null,
  ]) {
    assert.deepEqual(applyEvent(before, bad), before, JSON.stringify(bad));
  }
  assert.deepEqual(applyEvent(state, null), state);
  // 旧版 CLI 缺 replyMarkdown / reply / recentTools 等（SPEC 用户故事 24）：照常进表
  let live = emptyState();
  live = applyEvent(live, { type: 'synced' });
  const sparse = applyEvent(live, { type: 'session', session: { id: 'x_sparse', phase: 'running' } });
  assert.equal(sparse.table.x_sparse.id, 'x_sparse');
  assert.equal(sparse.table.x_sparse.replyMarkdown, undefined);
});

test('纯函数：不改输入状态与事件对象', () => {
  const deepFreeze = (v) => {
    if (v !== null && typeof v === 'object') for (const k of Object.keys(v)) deepFreeze(v[k]);
    return Object.freeze(v);
  };
  const state = deepFreeze({ table: { a: snap({ id: 'a', phase: 'running' }) }, baseline: {}, synced: true });
  const event = deepFreeze(sessionLine({ id: 'a', phase: 'pending', pendingDetail: { kind: 'permission', toolName: 'Bash' } }));
  const next = applyEvent(state, event);
  assert.equal(next.synced, true);
  assert.equal(next.table.a.phase, 'pending');
  assert.equal(state.table.a.phase, 'running'); // 输入没被改
  assert.deepEqual(Object.keys(next.table), ['a']);
});

// 验收抽查（tasks/todo.md Task 2 Verification）：mockup/pane.html 的手工样板数据喂归约器，
// 分段结果与样板一致。样板的会话构成见 pane.html:380-382 的顶部计数（待处理 1 / 执行中 2 /
// 已结束 6）与 404-467 的各卡片（挂起审批 Bash 已等待 3 分钟、执行中已运行 6 分钟、
// 闲时排队第 2 位已排 12 分钟、刚结束的已完成卡片加已结束行）。
test('mockup 样板抽查：行流进归约器，分段、标题与时长角标和 mockup 一致', () => {
  const repo = '/Volumes/MacData/projects/zcode-executor';
  const pending = { id: 'x_9f31c2a0', title: 'T4-board', task: 'tasks/T4-board.md', phase: 'pending', since: ago(3), repo,
    pendingDetail: { kind: 'permission', toolName: 'Bash', summary: 'rm -rf node_modules && npm ci',
      reason: '含删除操作，慢判转人工——任何越出执行副本的写入或删除一律转人工。' } };
  const running = { id: 'x_a1b2c3d4', title: 'T2-auth-flow', task: 'tasks/T2-auth.md', phase: 'running', since: ago(6), repo,
    replyMarkdown: '会话过期的问题定位到了：\n\n`refresh()` 在 401 后没有重试，token 就断了。',
    activeTool: { toolName: 'Edit', summary: 'src/auth/session.ts' },
    recentTools: [
      { toolName: 'Bash', summary: 'npm test -- --runInBand', ok: true },
      { toolName: 'Edit', summary: 'src/auth/session.ts', ok: true },
      { toolName: 'Read', summary: 'docs/SPEC.md', ok: true },
      { toolName: 'Bash', summary: 'npm run lint', ok: false },
    ] };
  const queued = { id: 'x_77aa01ff', title: 'T5-rename', task: 'tasks/T5-rename.md', phase: 'running', since: ago(12), repo,
    offpeakQueue: { phase: 'queued', position: 2 } };
  const doneCard = { id: 'x_4e0b19cc', title: 'T1-api-client', task: 'tasks/T1-api.md', phase: 'exited', lastOutcome: 'done', since: ago(2), repo,
    reply: ['client 封装完成，四个端点都有测试覆盖，npm test 41 个用例全绿。'] };
  // 已结束五行照抄 mockup/pane.html:494-520（面板时钟 14:32:08，各行时刻换算成相对 NOW 的分钟）：
  // 已超时 T0-probe 14:02 / 执行失败 T3-flaky-test 13:44 / 已取消 T6-bench（仓库 zeta-base）12:51 /
  // 空闲 T9-scratch 11:20 / 已退出（无标题，行上显示本地 id）x_5f0d21ab 09:03。
  // T0-probe 原 30 分钟，2026-10-07 卡片窗口放宽到 30 分钟后它落进窗口内成卡片，挪到 40 分钟保持「行」；
  // 其余不动。since 真实形状见 zcode-executor lib/snapshot.mjs sinceOf:183-187：exited/idle 也给 last.endedAt。
  const endedRows = [
    { id: 'x_11aaaaaa', title: 'T0-probe', phase: 'exited', lastOutcome: 'timeout', since: ago(40), repo },
    { id: 'x_22bbbbbb', title: 'T3-flaky-test', phase: 'exited', lastOutcome: 'failed', since: ago(48), repo },
    { id: 'x_33cccccc', title: 'T6-bench', phase: 'exited', lastOutcome: 'cancelled', since: ago(101), repo: '/Volumes/MacData/projects/zeta-base' },
    { id: 'x_44dddddd', title: 'T9-scratch', phase: 'idle', since: ago(192), repo },
    { id: 'x_5f0d21ab', title: '', phase: 'exited', lastOutcome: null, since: ago(329), repo },
  ];
  let state = emptyState();
  state = applyEvent(state, { type: 'hello', repo: null }); // 插件从用户主目录 spawn，范围仓库为 null（SPEC 服务端半场）
  for (const s of [pending, running, queued, doneCard, ...endedRows]) state = applyEvent(state, { type: 'session', session: s });
  state = applyEvent(state, { type: 'synced' });
  const s = sectionsOf(Object.values(state.table), NOW);
  assert.deepEqual(s.counts, { todo: 1, doing: 2, done: 6 }); // mockup 顶部计数
  assert.deepEqual(s.todo.map((x) => x.id), ['x_9f31c2a0']);
  assert.deepEqual(s.doing.map((x) => x.id), ['x_a1b2c3d4', 'x_77aa01ff']); // 新的在前
  assert.deepEqual(s.recent.map((x) => x.id), ['x_4e0b19cc']); // 30 分钟窗口内的已完成成卡片（夹具里只有它够新）
  assert.equal(headOf(s.todo[0]).label, '挂起：审批请求（Bash）'); // pane.html:407
  assert.equal(headOf(s.doing[0]).label, '执行中');
  assert.equal(headOf(s.doing[1]).label, '闲时排队中，第 2 位'); // pane.html:463
  assert.equal(cornerOf(s.todo[0], NOW), '已等待 3 分钟');
  assert.equal(cornerOf(s.doing[0], NOW), '已运行 6 分钟');
  assert.equal(cornerOf(s.doing[1], NOW), '已排 12 分钟');
  // 已结束行：1 张 recent 卡 + 5 行共 6 条，但 sectionsOf 的 5 条上限（view.ts DONE_LIMIT，
  // 语义同 zcode-executor test/view.test.mjs:66）把最旧的已退出行（x_5f0d21ab，09:03）挤掉
  assert.deepEqual(s.rows.map((x) => x.id), ['x_11aaaaaa', 'x_22bbbbbb', 'x_33cccccc', 'x_44dddddd']);
  assert.equal(outcomeOf(s.rows[0]).label, '已超时'); // pane.html:497
  assert.equal(outcomeOf(endedRows[4]).label, '已退出'); // 无结果记录的已退出（pane.html:517）；行被上限挤掉，文案对夹具单测
});
