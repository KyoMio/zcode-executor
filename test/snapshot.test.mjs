// test/snapshot.test.mjs —— 会话快照与本回合事件读取器的用例（SPEC-watch-pane D）。
// mkdtemp 造 ZCODE_EXECUTOR_HOME 那套结构（sessions.json + runs/<id>/），直接调函数，不起子进程。
// 活 pid 用测试进程自己（process.pid 一定活着），死 pid 照 test/ 现有造法用 999999999；
// 时间全是 ISO 8601 UTC 字符串（RULES §6），可直接字符串比较。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLast, readState } from '../lib/runs.mjs';
import { createTurnReader, findTurnStart, snapshotOf } from '../lib/snapshot.mjs';

const dirs = [];
test.after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const T = (n) => `2026-10-02T00:0${n}:00Z`;
const DEAD_PID = 999999999; // 照 run.test.mjs 的 stale 造法：肯定不存在的 pid
const mkEntry = (id, cwd, extra = {}) => ({ id, sessionId: null, title: 't', cwd, ...extra });
const telemetry = (n) => ({ type: 'v4/telemetry/event', seq: n, payload: { name: 'tick' } });
const SEND = { type: 'executor.send', at: T(0), text: '干活', task: null };
// 一次完成的调用：scheduled + started + result 三行（verified.md 2026-10-02 形状，成败看 result）
const doneCall = (id, toolName, input) => [
  { type: 'tool.updated', payload: { toolCallId: id, toolName, kind: 'scheduled', input } },
  { type: 'tool.updated', payload: { toolCallId: id, kind: 'started' } },
  { type: 'tool.updated', payload: { toolCallId: id, kind: 'result', result: { success: true } } },
];

async function makeHome() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-snap-home-'));
  dirs.push(home);
  await writeFile(path.join(home, 'sessions.json'), JSON.stringify({ sessions: {} }));
  return home;
}

/** 造 runs/<id>/ 下的文件；events 是事件数组（逐行 JSON），字符串值原样写（造坏 JSON 用）。 */
const SESSION_FILES = { state: 'state.json', last: 'last.json', pending: 'pending.json', offpeak: 'offpeak.json', lock: 'lock', events: 'events.jsonl' };
async function makeSession(home, id, files = {}) {
  const dir = path.join(home, 'runs', id);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (content === undefined) continue;
    const target = path.join(dir, SESSION_FILES[name] ?? name);
    if (name === 'events') {
      await writeFile(target, content.map((e) => `${JSON.stringify(e)}\n`).join(''));
    } else if (typeof content === 'string') {
      await writeFile(target, content);
    } else {
      await writeFile(target, JSON.stringify(content));
    }
  }
  return dir;
}

const linesOffset = (lines) => {
  let off = 0;
  for (const l of lines) off += Buffer.byteLength(`${JSON.stringify(l)}\n`);
  return off;
};

// ---------- findTurnStart ----------

test('findTurnStart：没有 send 返回 0，文件不存在返回 0', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-snap-find-'));
  dirs.push(dir);
  const noSend = path.join(dir, 'no-send.jsonl');
  await writeFile(noSend, [telemetry(1), { type: 'tool.updated', payload: {} }].map((e) => `${JSON.stringify(e)}\n`).join(''));
  assert.equal(findTurnStart(noSend), 0);
  assert.equal(findTurnStart(path.join(dir, 'missing.jsonl')), 0);
});

test('findTurnStart：send 在文件中间时给那行的偏移，且是最后一条 send', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-snap-mid-'));
  dirs.push(dir);
  const file = path.join(dir, 'events.jsonl');
  const lines = [telemetry(1), SEND, { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'x' } }, SEND, telemetry(2)];
  await writeFile(file, lines.map((e) => `${JSON.stringify(e)}\n`).join(''));
  const secondSend = linesOffset(lines.slice(0, 3));
  assert.equal(findTurnStart(file), secondSend);
});

// findTurnStart 从文件尾倒着每 64KB 切一块：先定下「send 行首到文件尾」的字节数，再往前垫遥测行，
// 让 send 行首压在倒数第一块的分界附近。tailBase 是分界附近的骨架，padLen 按几何精确补齐。
function straddleFile(file, distanceToEof) {
  const head = [telemetry(1), SEND, telemetry(2)].map((e) => `${JSON.stringify(e)}\n`).join('');
  const straddle = `${JSON.stringify(SEND)}\n`;
  const closer = `${JSON.stringify({ type: 'model.streaming', payload: { kind: 'text_delta', delta: '好' } })}\n`;
  const base = JSON.stringify({ type: 'v4/telemetry/event', seq: 9, payload: { pad: '' } });
  const padLen = distanceToEof - Buffer.byteLength(straddle) - Buffer.byteLength(closer) - Buffer.byteLength(base) - 1;
  assert.ok(padLen > 0, '几何不对：垫行长度算出负数');
  const text = head + straddle + `${JSON.stringify({ type: 'v4/telemetry/event', seq: 9, payload: { pad: 'x'.repeat(padLen) } })}\n` + closer;
  return writeFile(file, text).then(() => Buffer.byteLength(head)); // send 行首偏移
}

test('findTurnStart：send 行首落在倒数第一块分界前 10 字节，标记跨块拼读也认得', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-snap-edge-'));
  dirs.push(dir);
  const file = path.join(dir, 'events.jsonl');
  // send 行首到文件尾 65536 + 10：23 字节的标记跨在倒数第一、二块的分界上，块内只剩前 10 字节，
  // 必须靠跨块补读才认得出来；head 里另有一条完整的 send，证明找到的是最后一条
  const sendOffset = await straddleFile(file, 64 * 1024 + 10);
  const size = (await stat(file)).size;
  assert.equal(size - sendOffset, 64 * 1024 + 10); // 前置：几何按文件尾算
  assert.equal(findTurnStart(file), sendOffset);
});

test('findTurnStart：send 行首正好是倒数第一块的块首（块首看前一字节的路径）', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-snap-edge0-'));
  dirs.push(dir);
  const file = path.join(dir, 'events.jsonl');
  const sendOffset = await straddleFile(file, 64 * 1024);
  const size = (await stat(file)).size;
  assert.equal(size - sendOffset, 64 * 1024); // 前置：send 行首正好压在倒数第一块的块首
  assert.equal(findTurnStart(file), sendOffset);
});

// ---------- createTurnReader ----------

test('createTurnReader：首读从回合起点开始，遥测行不进 events，send 留在开头', async (t) => {
  const home = await makeHome();
  const file = path.join(home, 'runs', 'x_00000001', 'events.jsonl');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    [
      telemetry(1),
      { type: 'tool.updated', payload: { toolCallId: 'old', toolName: 'Bash', kind: 'scheduled' } },
      SEND,
      { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '来了' } },
      { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Write', kind: 'scheduled', inputOmitted: true } },
      telemetry(2),
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(''),
  );
  const first = createTurnReader(file).read();
  assert.equal(first.changed, true);
  assert.deepEqual(first.events.map((e) => e.type), ['executor.send', 'model.streaming', 'tool.updated']);
  assert.equal(first.events[0].at, T(0)); // send 本身留着，下游用 turnEvents 取它之后的
});

test('createTurnReader：追加事件后第二次只读新增，events 是累计的', async (t) => {
  const home = await makeHome();
  const file = path.join(home, 'events.jsonl');
  await writeFile(file, [SEND, { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '一' } }]
    .map((e) => `${JSON.stringify(e)}\n`)
    .join(''));
  const reader = createTurnReader(file);
  const first = reader.read();
  assert.equal(first.events.length, 2);
  await appendFile(
    file,
    [
      { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Bash', kind: 'result', result: { success: true } } },
      telemetry(9),
    ]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(''),
  );
  const second = reader.read();
  assert.equal(second.changed, true);
  assert.deepEqual(second.events.map((e) => e.type), ['executor.send', 'model.streaming', 'tool.updated']);
  assert.equal(second.events.length, 3); // 遥测行被筛掉，工具结果是新增
});

test('createTurnReader：追加新的 executor.send 后清空重攒', async (t) => {
  const home = await makeHome();
  const file = path.join(home, 'events.jsonl');
  await writeFile(file, [SEND, { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '旧回合' } }]
    .map((e) => `${JSON.stringify(e)}\n`)
    .join(''));
  const reader = createTurnReader(file);
  reader.read();
  const send2 = { type: 'executor.send', at: T(5), text: '新回合' };
  await appendFile(
    file,
    [send2, { type: 'model.streaming', payload: { assistantMessageId: 'm2', kind: 'text_delta', delta: '新' } }]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(''),
  );
  const next = reader.read();
  assert.equal(next.changed, true);
  assert.deepEqual(next.events.map((e) => e.type), ['executor.send', 'model.streaming']); // 旧回合全清掉
  assert.equal(next.events[0].at, T(5));
  assert.equal(next.events[0].text, '新回合');
});

test('createTurnReader：半截行留到下次；坏行跳过不进 events', async (t) => {
  const home = await makeHome();
  const file = path.join(home, 'events.jsonl');
  await writeFile(file, `${JSON.stringify(SEND)}\n`);
  const reader = createTurnReader(file);
  reader.read();
  // 一条完整行 + 一条含标记但坏 JSON 的行 + 一条半截行
  await appendFile(
    file,
    `${JSON.stringify({ type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Read', kind: 'started' } })}\n` +
      '{"type":"tool.updated","payload":\n' +
      '{"type":"model.streaming","payload":{"kind":"text_de',
  );
  const second = reader.read();
  assert.equal(second.changed, true);
  assert.deepEqual(second.events.map((e) => e.type ?? e.payload?.kind), ['executor.send', 'tool.updated']); // 坏行没了，半截的没进来
  await appendFile(file, `lta","delta":"补全"}}\n${JSON.stringify({ type: 'tool.updated', payload: { toolCallId: 't2', toolName: 'Grep', kind: 'scheduled' } })}\n`);
  const third = reader.read();
  assert.equal(third.changed, true);
  const kinds = third.events.filter((e) => e.type === 'model.streaming').map((e) => e.payload.kind);
  assert.deepEqual(kinds, ['text_delta']); // 上次的半截行补全后这次读到
  assert.equal(third.events.at(-1).payload.toolCallId, 't2');
});

test('createTurnReader：文件整个换短后清空重攒，旧文件的事件不残留', async (t) => {
  const home = await makeHome();
  const file = path.join(home, 'events.jsonl');
  await writeFile(
    file,
    [SEND, { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '旧' } }]
      .map((e) => `${JSON.stringify(e)}\n`)
      .join(''),
  );
  const reader = createTurnReader(file);
  assert.equal(reader.read().events.length, 2);
  // 整个换成更短、没有 send 的新文件：偏移与已攒事件都得清掉重来
  await writeFile(file, `${JSON.stringify({ type: 'model.streaming', payload: { assistantMessageId: 'm2', kind: 'text_delta', delta: '新' } })}\n`);
  const next = reader.read();
  assert.equal(next.changed, true);
  assert.deepEqual(next.events.map((e) => e.payload.delta), ['新']); // 旧回合的 send 与 delta 都不在
});

// ---------- snapshotOf ----------

test('snapshotOf：running 给 reply/activeTool/recentTools/task，since 取 current.startedAt', async (t) => {
  const home = await makeHome();
  const cwd = home; // phaseOf 只看 runs/<id>/，cwd 给什么都行，路径摘要按它算相对
  const runsDir = await makeSession(home, 'x_00000001', {
    lock: { pid: process.pid },
    state: {
      sessionId: 'sess_1',
      pid: process.pid, // 活 pid：测试进程自己
      phase: 'running',
      startedAt: T(0),
      updatedAt: T(0),
      // 真机 send 存的是 path.resolve 之后的绝对任务单路径
      current: { text: '改画板', task: path.join(cwd, 'docs/tasks/t.md'), startedAt: T(1) },
    },
    events: [
      SEND,
      { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '第一行\n\n第二行\n' } },
      ...doneCall('c1', 'Write', { file_path: path.join(cwd, 'src/a.mjs') }),
      ...['r1', 'r2', 'r3', 'r4', 'r5'].flatMap((id, i) => doneCall(id, 'Read', { file_path: path.join(cwd, `docs/r${i + 1}.md`) })),
      { type: 'tool.updated', payload: { toolCallId: 'c2', toolName: 'Bash', kind: 'started', input: { command: 'npm test\nls' } } },
    ],
  });
  const { events } = createTurnReader(path.join(runsDir, 'events.jsonl')).read();
  const snap = snapshotOf({
    home,
    entry: mkEntry('x_00000001', cwd, { sessionId: 'sess_1' }),
    repo: '/repo',
    turnEvents: events,
  });
  assert.equal(snap.phase, 'running');
  assert.equal(snap.repo, '/repo');
  assert.equal(snap.task, 'docs/tasks/t.md'); // 绝对任务单路径转成相对 cwd
  assert.deepEqual(snap.reply, ['第一行', '第二行']);
  assert.deepEqual(snap.activeTool, { toolName: 'Bash', summary: 'npm test' }); // 最后一个 running 的调用
  assert.deepEqual(snap.recentTools, [
    { toolName: 'Read', summary: 'docs/r1.md', ok: true },
    { toolName: 'Read', summary: 'docs/r2.md', ok: true },
    { toolName: 'Read', summary: 'docs/r3.md', ok: true },
    { toolName: 'Read', summary: 'docs/r4.md', ok: true },
    { toolName: 'Read', summary: 'docs/r5.md', ok: true },
  ]); // 6 个完成只留最后 5 个（Write c1 被挤掉），新的在后
  assert.equal(snap.since, T(1)); // current.startedAt 优先于 state.startedAt
  assert.equal(snap.lastEndedAt, null);
  assert.equal(snap.lastEndOutcome, null); // 还没有 last.json：结束结果为 null
  assert.equal(snap.offpeakQueue, null);
  assert.equal(snap.pendingDetail, null);
});

test('snapshotOf：挂起审批给 pendingDetail 与 since=pending.at，摘要按 cwd 给相对路径', async (t) => {
  const home = await makeHome();
  await makeSession(home, 'x_00000002', {
    lock: { pid: process.pid },
    state: { sessionId: 'sess_2', pid: process.pid, phase: 'running', startedAt: T(0), updatedAt: T(0), current: null },
    pending: {
      kind: 'permission',
      requestId: 'req_1',
      at: T(3),
      stage: 'hard',
      why: '越界',
      toolName: 'Write',
      input: { file_path: path.join(home, 'src/b.mjs') },
      reason: '副作用',
      options: [],
    },
  });
  const snap = snapshotOf({ home, entry: mkEntry('x_00000002', home), repo: null, turnEvents: null });
  assert.equal(snap.phase, 'pending');
  assert.equal(snap.since, T(3));
  assert.deepEqual(snap.pendingDetail, { kind: 'permission', toolName: 'Write', summary: 'src/b.mjs', reason: '副作用' });
});

test('snapshotOf：挂起提问的 questionTexts 取每项的 question 字段（题干）', async (t) => {
  const home = await makeHome();
  await makeSession(home, 'x_00000003', {
    lock: { pid: process.pid },
    state: { sessionId: 'sess_3', pid: process.pid, phase: 'running', startedAt: T(0), updatedAt: T(0), current: null },
    pending: {
      kind: 'question',
      requestId: 'req_2',
      at: T(4),
      questions: [{ question: '选哪种方案？', options: [{ label: '快速' }] }, { question: '继续吗' }],
    },
  });
  const snap = snapshotOf({ home, entry: mkEntry('x_00000003', home), repo: null, turnEvents: null });
  assert.equal(snap.phase, 'pending');
  assert.deepEqual(snap.pendingDetail, { kind: 'question', questionTexts: ['选哪种方案？', '继续吗'] });
  assert.equal(snap.since, T(4));
});

test('snapshotOf：state 写 running 但 pid 已死 → stale，since 取 state.updatedAt', async (t) => {
  const home = await makeHome();
  await makeSession(home, 'x_00000004', {
    lock: { pid: DEAD_PID }, // phaseOf 判活看 lock 里的 pid，不看 state 的
    state: { sessionId: 'sess_4', pid: DEAD_PID, phase: 'running', startedAt: T(0), updatedAt: T(2), current: null },
    events: [SEND, { type: 'tool.updated', payload: { toolCallId: 'c1', toolName: 'Bash', kind: 'started', input: { command: 'ls' } } }],
  });
  const { events } = createTurnReader(path.join(home, 'runs', 'x_00000004', 'events.jsonl')).read();
  const snap = snapshotOf({ home, entry: mkEntry('x_00000004', home), repo: null, turnEvents: events });
  assert.equal(snap.phase, 'stale');
  assert.equal(snap.since, T(2));
  assert.equal(snap.activeTool, null); // 回合被打断：调用停在 running 也不给 activeTool
  assert.deepEqual(snap.recentTools, []);
});

test('snapshotOf：exited/idle 的 since 按 last.endedAt → state.updatedAt → null 回退', async (t) => {
  const home = await makeHome();
  // endedAt 不早于 startedAt：用 endedAt
  await makeSession(home, 'x_00000005', {
    state: { sessionId: 'sess_5', pid: DEAD_PID, phase: 'exited', startedAt: T(0), updatedAt: T(2), current: null },
    last: { outcome: 'done', lastText: null, startedAt: T(0), endedAt: T(1), task: 'docs/from-last.md' },
  });
  const done = snapshotOf({ home, entry: mkEntry('x_00000005', home, { lastOutcome: 'done' }), repo: null, turnEvents: null });
  assert.equal(done.phase, 'exited');
  assert.equal(done.since, T(1));
  assert.equal(done.lastEndedAt, T(1));
  assert.equal(done.lastEndOutcome, 'done'); // SPEC 快照表新增行：结束结果随 last.json 走
  assert.equal(done.lastOutcome, 'done');
  assert.equal(done.task, 'docs/from-last.md'); // current 没有就取 last.task

  // endedAt 早于 startedAt（上一回合的结算）：改用 state.updatedAt
  await makeSession(home, 'x_00000006', {
    state: { sessionId: 'sess_6', pid: DEAD_PID, phase: 'exited', startedAt: T(5), updatedAt: T(6), current: null },
    last: { outcome: 'done', lastText: null, startedAt: T(0), endedAt: T(1), task: null },
  });
  const staleLast = snapshotOf({ home, entry: mkEntry('x_00000006', home), repo: null, turnEvents: null });
  assert.equal(staleLast.since, T(6));

  // idle：什么文件都没有 → null
  const bare = snapshotOf({ home, entry: mkEntry('x_00000007', home), repo: null, turnEvents: null });
  assert.equal(bare.phase, 'idle');
  assert.equal(bare.since, null);
  assert.equal(bare.lastEndedAt, null);
  assert.equal(bare.task, null);
});

test('snapshotOf：闲时排队中 offpeakQueue 有值、since 取 taken 事件的 at，快照里没有号 id', async (t) => {
  const home = await makeHome();
  await makeSession(home, 'x_00000008', {
    lock: { pid: process.pid },
    state: { sessionId: 'sess_8', pid: process.pid, phase: 'running', startedAt: T(0), updatedAt: T(0), current: null },
    offpeak: { phase: 'queued', position: 3, ticketId: 'tk_1', offPeakId: 'op_1', updatedAt: T(0) },
  });
  // taken 写在 send 之前（排号阶段本回合的 send 还没写），这里直接作为调用方给的事件传入；
  // 两条 taken 加一条 retaken：取最后一条的 at，retaken 也认
  const taken = (at, position, ticketId) => ({ type: 'executor.offpeak.taken', at, offPeakId: 'op_1', ticketId, position });
  const retaken = { type: 'executor.offpeak.retaken', at: T(3), offPeakId: 'op_1', ticketId: 'tk_9', position: 5 };
  const snap = snapshotOf({ home, entry: mkEntry('x_00000008', home), repo: null, turnEvents: [taken(T(1), 3, 'tk_1'), taken(T(2), 4, 'tk_2'), retaken] });
  assert.equal(snap.phase, 'running');
  assert.deepEqual(snap.offpeakQueue, { phase: 'queued', position: 3 }); // 只有 phase 与 position（offpeak.json 的 position）
  assert.equal(snap.since, T(3)); // 最后一条取号事件（retaken）的 at
  assert.equal(JSON.stringify(snap).includes('tk_'), false); // 号 id 不进快照
});

test('snapshotOf：闲时 ready 给 position null；done 时 offpeakQueue 为 null 且 since 不看 taken', async (t) => {
  const home = await makeHome();
  await makeSession(home, 'x_00000009', {
    lock: { pid: process.pid },
    state: { sessionId: 'sess_9', pid: process.pid, phase: 'running', startedAt: T(0), updatedAt: T(0), current: { text: 'x', task: null, startedAt: T(2) } },
    offpeak: { phase: 'ready', position: null, ticketId: 'tk_2', offPeakId: 'op_2', updatedAt: T(0) },
  });
  const ready = snapshotOf({ home, entry: mkEntry('x_00000009', home), repo: null, turnEvents: null });
  assert.deepEqual(ready.offpeakQueue, { phase: 'ready', position: null });
  assert.equal(ready.since, T(0)); // 排队行没有 taken 就回退 state.startedAt（号就绪时回合还没开始，current 是空的）

  await makeSession(home, 'x_0000000a', {
    lock: { pid: process.pid },
    state: { sessionId: 'sess_a', pid: process.pid, phase: 'running', startedAt: T(0), updatedAt: T(0), current: { text: 'x', task: null, startedAt: T(2) } },
    offpeak: { phase: 'done', position: 1, ticketId: 'tk_2', offPeakId: 'op_2', updatedAt: T(0) },
  });
  const taken = { type: 'executor.offpeak.taken', at: T(1), offPeakId: 'op_2', ticketId: 'tk_2', position: 1 };
  const done = snapshotOf({ home, entry: mkEntry('x_0000000a', home), repo: null, turnEvents: [taken] });
  assert.equal(done.offpeakQueue, null);
  assert.equal(done.since, T(2)); // 队列已结算：不用 taken 的 at
});

test('snapshotOf：turnEvents 为 null 时 reply 取 lastText 末尾 800 字，空白的给 []', async (t) => {
  const home = await makeHome();
  await makeSession(home, 'x_0000000b', {
    state: { sessionId: 'sess_b', pid: DEAD_PID, phase: 'exited', startedAt: T(0), updatedAt: T(2), current: null },
    last: { outcome: 'done', lastText: `啊${'嗯'.repeat(900)}`, startedAt: T(0), endedAt: T(1), task: null },
  });
  const snap = snapshotOf({ home, entry: mkEntry('x_0000000b', home), repo: null, turnEvents: null });
  assert.deepEqual(snap.reply, ['嗯'.repeat(800)]); // 只留末尾 800 字
  assert.deepEqual(snap.activeTool, null);
  assert.deepEqual(snap.recentTools, []);

  await makeSession(home, 'x_0000000c', {
    state: { sessionId: 'sess_c', pid: DEAD_PID, phase: 'exited', startedAt: T(0), updatedAt: T(2), current: null },
    last: { outcome: 'done', lastText: '  \n\t', startedAt: T(0), endedAt: T(1), task: null },
  });
  const blank = snapshotOf({ home, entry: mkEntry('x_0000000c', home), repo: null, turnEvents: null });
  assert.deepEqual(blank.reply, []);

  // lastMessageText（最终回复原文，新字段）优先于 lastText：lastText 是整回合拼接，面板要的是最终回复
  await makeSession(home, 'x_0000000d2', {
    state: { sessionId: 'sess_d2', pid: DEAD_PID, phase: 'exited', startedAt: T(0), updatedAt: T(2), current: null },
    last: { outcome: 'done', lastText: '中途的话。改完了，测试全绿。', lastMessageText: '改完了，测试全绿。', startedAt: T(0), endedAt: T(1), task: null },
  });
  const final = snapshotOf({ home, entry: mkEntry('x_0000000d2', home), repo: null, turnEvents: null });
  assert.deepEqual(final.reply, ['改完了，测试全绿。']);
  assert.equal(final.replyMarkdown, '改完了，测试全绿。');
});

test('snapshotOf：replyMarkdown 有 turnEvents 取最后一条消息，为 null 取 lastText，都没有为空串', async (t) => {
  const home = await makeHome();
  await makeSession(home, 'x_00000011', {
    state: { sessionId: 'sess_11', pid: DEAD_PID, phase: 'exited', startedAt: T(0), updatedAt: T(2), current: null },
    events: [
      SEND,
      { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '# 第一条' } },
      { type: 'model.streaming', payload: { assistantMessageId: 'm2', kind: 'text_delta', delta: '## 第二条\n\n正文' } },
    ],
  });
  const { events } = createTurnReader(path.join(home, 'runs', 'x_00000011', 'events.jsonl')).read();
  const withTurn = snapshotOf({ home, entry: mkEntry('x_00000011', home), repo: null, turnEvents: events });
  assert.equal(withTurn.replyMarkdown, '## 第二条\n\n正文'); // 只留最后一条消息的原文

  await makeSession(home, 'x_00000012', {
    state: { sessionId: 'sess_12', pid: DEAD_PID, phase: 'exited', startedAt: T(0), updatedAt: T(2), current: null },
    last: { outcome: 'done', lastText: '# 标题\n\n结尾的话', startedAt: T(0), endedAt: T(1), task: null },
  });
  const fromLast = snapshotOf({ home, entry: mkEntry('x_00000012', home), repo: null, turnEvents: null });
  assert.equal(fromLast.replyMarkdown, '# 标题\n\n结尾的话'); // lastText 整段当一条

  const bare = snapshotOf({ home, entry: mkEntry('x_00000013', home), repo: null, turnEvents: null });
  assert.equal(bare.replyMarkdown, ''); // 什么都没有
});

test('snapshotOf：pending.json 坏 JSON 时快照照出，pendingDetail 为 null', async (t) => {
  const home = await makeHome();
  await makeSession(home, 'x_0000000d', {
    lock: { pid: process.pid },
    state: { sessionId: 'sess_d', pid: process.pid, phase: 'running', startedAt: T(0), updatedAt: T(0), current: null },
    pending: '{broken',
  });
  const snap = snapshotOf({ home, entry: mkEntry('x_0000000d', home), repo: null, turnEvents: null });
  assert.equal(snap.phase, 'pending'); // 文件在、pid 活：阶段照判
  assert.equal(snap.pendingDetail, null); // 内容读不出：按没有挂起处理
  assert.equal(snap.since, null); // at 拿不到：按没有处理，不编时间
});

test('snapshotOf：pending.questions 不是数组时快照照出，questionTexts 为 []', async (t) => {
  const home = await makeHome();
  await makeSession(home, 'x_0000000e', {
    lock: { pid: process.pid },
    state: { sessionId: 'sess_e', pid: process.pid, phase: 'running', startedAt: T(0), updatedAt: T(0), current: null },
    pending: { kind: 'question', requestId: 'req_3', at: T(4), questions: { question: '这不是数组' } },
  });
  const snap = snapshotOf({ home, entry: mkEntry('x_0000000e', home), repo: null, turnEvents: null });
  assert.equal(snap.phase, 'pending'); // 形状坏也不许炸整条快照
  assert.deepEqual(snap.pendingDetail, { kind: 'question', questionTexts: [] });
});

test('snapshotOf：有当前投递时 task 只认 current.task（纯文字投递为 null），没有当前投递才取 last.task', async (t) => {
  const home = await makeHome();
  await makeSession(home, 'x_0000000f', {
    state: { sessionId: 'sess_f', pid: DEAD_PID, phase: 'exited', startedAt: T(0), updatedAt: T(2), current: { text: '纯文字投递', task: null, startedAt: T(1) } },
    last: { outcome: 'done', lastText: null, startedAt: T(1), endedAt: T(2), task: 'docs/old-turn.md' },
  });
  const noTask = snapshotOf({ home, entry: mkEntry('x_0000000f', home), repo: null, turnEvents: null });
  assert.equal(noTask.task, null); // current 在但这条投递没有任务单：不回退上一回合的

  await makeSession(home, 'x_00000010', {
    state: { sessionId: 'sess_10', pid: DEAD_PID, phase: 'exited', startedAt: T(0), updatedAt: T(2), current: null },
    last: { outcome: 'done', lastText: null, startedAt: T(1), endedAt: T(2), task: 'docs/old-turn.md' },
  });
  const fromLast = snapshotOf({ home, entry: mkEntry('x_00000010', home), repo: null, turnEvents: null });
  assert.equal(fromLast.task, 'docs/old-turn.md'); // 没有当前投递才取 last.task
});

test('snapshotOf：按 watch 的顺序先读 state/last 再读事件，runner 夹在中间结束回合也不出「已结束 + 旧回复」', async (t) => {
  const home = await makeHome();
  const id = 'x_00000011';
  const entry = mkEntry(id, home);
  const running = { sessionId: 'sess_11', pid: process.pid, phase: 'running', startedAt: T(0), updatedAt: T(0), current: { text: '干活', task: null, startedAt: T(0) } };
  const delta = (text) => ({ type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: text } });
  const runsDir = await makeSession(home, id, { lock: { pid: process.pid }, state: running, events: [SEND, delta('旧的一行\n')] });
  const eventsPath = path.join(runsDir, 'events.jsonl');
  const reader = createTurnReader(eventsPath);
  reader.read(); // 上一轮已经读过旧事件

  // 这一轮：先读 state 与 last……
  const state = readState(home, id);
  const last = readLast(home, id);
  // ……runner 恰好在此刻结束回合：追加最后的事件 → 写 last.json → 改 state
  await appendFile(eventsPath, `${JSON.stringify(delta('最后一行\n'))}\n`);
  await writeFile(path.join(runsDir, 'last.json'), JSON.stringify({ outcome: 'done', lastText: '旧的一行\n最后一行', startedAt: T(0), endedAt: T(3), task: null }));
  await writeFile(path.join(runsDir, 'state.json'), JSON.stringify({ ...running, phase: 'exited', updatedAt: T(3), current: null }));
  // ……再读事件
  const mid = snapshotOf({ home, entry, repo: null, turnEvents: reader.read().events, state, last });
  assert.equal(mid.phase, 'running'); // phase 跟着先读的那份 state，不被磁盘上已改的 exited 盖掉
  assert.equal(mid.lastEndedAt, null); // last 也是先读的那份
  assert.equal(mid.since, T(0));
  assert.deepEqual(mid.reply, ['旧的一行', '最后一行']); // 事件比 state 新：回复已经完整

  // 下一轮读到已结束的 state：回复同样完整
  const next = snapshotOf({ home, entry, repo: null, turnEvents: reader.read().events, state: readState(home, id), last: readLast(home, id) });
  assert.equal(next.phase, 'exited');
  assert.equal(next.lastEndedAt, T(3));
  assert.deepEqual(next.reply, ['旧的一行', '最后一行']);

  // 显式给 null 也算给了，不回头再读磁盘
  assert.equal(snapshotOf({ home, entry, repo: null, turnEvents: null, state: null, last: null }).phase, 'idle');
});
