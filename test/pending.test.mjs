// lib/pending.mjs 的行为测试：闸门挂起、排队、应答转换。全部对 test/mock-appserver.mjs 跑，
// 不发真机 session/send，不花额度。real-send 的行为在 test/real-send.test.mjs。
import test from 'node:test';
import { rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { AppServerClient } from '../lib/appserver.mjs';
import { attachSession } from '../lib/session.mjs';
import { createPendingGate, readPending, permissionResponse, questionResponse, optionClass } from '../lib/pending.mjs';
import { startMock, waitFor, readRecord, killAll } from './helpers.mjs';

const pids = [];
const mockDirs = [];
test.after(async () => {
  killAll(pids);
  for (const dir of mockDirs) await rm(dir, { recursive: true, force: true });
});

const SESSION_ID = 'sess_test-1';

// 起 mock + 客户端 + 挂起闸门的公共壳：pendingPath 放进 mkdtemp 目录随 cleanup 一起清。
// spawn 失败也要清临时目录、收掉起了一半的客户端（T2.7 第 3 条）
async function withGateSession(script, opts, fn) {
  const mock = await startMock({ script });
  mockDirs.push(mock.dir);
  const pendingPath = path.join(mock.dir, 'pending.json');
  let client = null;
  try {
    client = await AppServerClient.spawn({ zcodePath: mock.zcodePath, cwd: mock.dir, env: mock.env });
    pids.push(client.pid);
    // opts.onPending 的第二参把 gate 传回去：同步 answer 的用例要用
    const gate = createPendingGate({ pendingPath, onPending: (pending) => opts.onPending?.(pending, gate) });
    const session = await attachSession({
      client,
      sessionId: SESSION_ID,
      cwd: mock.dir,
      eventsPath: path.join(mock.dir, 'events.jsonl'),
      handlers: gate.handlers,
    });
    return await fn({ gate, session, client, pendingPath, recordPath: mock.recordPath });
  } finally {
    if (client) await client.close({ timeoutMs: 2000 }).catch(() => {});
    await mock.cleanup();
  }
}

const PERMISSION_SCRIPT = {
  turns: [{ permission: { toolName: 'Bash', input: { command: 'ls' }, reason: '列目录' } }],
};

const QUESTION_SCRIPT = {
  turns: [
    {
      question: {
        questions: [
          { question: '选择模式', options: [{ label: '快速' }, { label: '稳妥' }] },
          { question: '选模块', multiSelect: true, options: [{ value: 'a', label: 'A 模块' }, { value: 'b', label: 'B 模块' }, { value: 'c', label: 'C 模块' }] },
        ],
      },
    },
  ],
};

test('permissionResponse：allow / deny 的形状，其它抛错', () => {
  const withAllow = { options: [{ optionId: 'allow', kind: 'allow_once' }] };
  assert.deepEqual(permissionResponse(withAllow, 'allow'), { decision: 'allow' });
  assert.deepEqual(permissionResponse({}, 'deny'), { decision: 'deny', reason: '人工拒绝' });
  assert.throws(() => permissionResponse({}, 'maybe'), (err) => err?.name === 'ExecutorError');
});

test('permissionResponse：options 没有 allow_once 时 allow 抛错（RULES §8）', () => {
  const pending = { options: [{ optionId: 'deny', kind: 'deny_once' }] };
  assert.throws(() => permissionResponse(pending, 'allow'), (err) => err?.name === 'ExecutorError');
  assert.doesNotThrow(() => permissionResponse(pending, 'deny')); // deny 不受 allow_once 限制
});

test('optionClass：deny 类认 deny 和 deny_once，allow 类只认 allow_once（任务单 T1.3）', () => {
  assert.equal(optionClass({ kind: 'allow_once' }), 'allow');
  assert.equal(optionClass({ kind: 'allow_always' }), undefined); // 「一直允许」不算放行依据
  assert.equal(optionClass({ kind: 'deny' }), 'deny'); // 真机拒绝项的 kind 是 deny
  assert.equal(optionClass({ kind: 'deny_once' }), 'deny');
  assert.equal(optionClass({}), undefined);
  assert.equal(optionClass(undefined), undefined);
});

test('permissionResponse：只有 allow_always 没有 allow_once 时 allow 抛错，deny 照常', () => {
  // 真机形状（任务单 T1.3）：allow_project 是 allow_always，放行依据只有 allow_once
  const pending = {
    options: [
      { optionId: 'allow_once', kind: 'allow_once', response: { decision: 'allow' } },
      { optionId: 'allow_project', kind: 'allow_always', response: { decision: 'allow' } },
      { optionId: 'deny', kind: 'deny', response: { decision: 'deny' } },
    ],
  };
  assert.deepEqual(permissionResponse(pending, 'allow'), { decision: 'allow' });
  const alwaysOnly = { options: [{ optionId: 'allow_project', kind: 'allow_always' }, { optionId: 'deny', kind: 'deny' }] };
  assert.throws(() => permissionResponse(alwaysOnly, 'allow'), (err) => err?.name === 'ExecutorError');
  assert.deepEqual(permissionResponse(alwaysOnly, 'deny'), { decision: 'deny', reason: '人工拒绝' });
});

test('questionResponse：序号、option.value、自由文字三种匹配', () => {
  const pending = {
    questions: [
      { question: '选择模式', options: [{ label: '快速' }, { label: '稳妥' }] },
      { question: '选模块', multiSelect: true, options: [{ value: 'a', label: 'A 模块' }, { value: 'b', label: 'B 模块' }] },
      { question: '还有什么要求' },
    ],
  };
  const out = questionResponse(pending, ['2', ['a', 'b'], '别删 .git']);
  assert.deepEqual(out, {
    action: 'accept',
    content: { answers: { '选择模式': '稳妥', '选模块': 'A 模块, B 模块', '还有什么要求': '别删 .git' } },
  });
  // 按 label 匹配
  const byLabel = questionResponse(pending, ['快速', 'A 模块', '无']);
  assert.equal(byLabel.content.answers['选择模式'], '快速');
  // 数量不对 / 不是多选给数组 / 对不上 都抛 ExecutorError
  assert.throws(() => questionResponse(pending, ['快速', 'A 模块']), (e) => e?.name === 'ExecutorError');
  assert.throws(() => questionResponse(pending, [['快速', '稳妥'], 'A 模块', '无']), (e) => e?.name === 'ExecutorError');
  assert.throws(() => questionResponse(pending, ['不存在', 'A 模块', '无']), (e) => e?.name === 'ExecutorError');
});

test('permission 挂起全链路：pending 形状、answer(allow)、回合 done、pending 删除', async () => {
  await withGateSession(PERMISSION_SCRIPT, {}, async ({ gate, session, pendingPath, recordPath }) => {
    const sendPromise = session.send('hi');
    const pending = await waitFor(() => gate.current());
    assert.equal(pending.kind, 'permission');
    assert.equal(pending.stage, 'pending');
    assert.equal(pending.why, '等人');
    assert.equal(pending.reason, '列目录'); // T1.2b 第 9 条：reason 字段
    assert.match(pending.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/); // 带 Z 的 UTC
    assert.equal(pending.toolName, 'Bash');
    assert.deepEqual(pending.input, { command: 'ls' });
    assert.ok(Array.isArray(pending.options) && pending.options.length >= 2);
    assert.ok(readPending(pendingPath)); // 纯读也能看到同一份

    gate.answer({ decision: 'allow' });
    const result = await sendPromise;
    assert.equal(result.outcome, 'done');
    assert.equal(gate.current(), null); // 应答后 pending 已删
    assert.equal(readPending(pendingPath), null);
    // 临时文件也不残留（rename 消费掉了）
    assert.equal(readPending(`${pendingPath}.${process.pid}.tmp`), null);
    const answers = readRecord(recordPath).filter((m) => m.id !== undefined && m.method === undefined);
    assert.deepEqual(answers[0].result, { decision: 'allow' });
  });
});

test('answer(deny) → mock 收到 {decision:deny, reason:人工拒绝}', async () => {
  await withGateSession(PERMISSION_SCRIPT, {}, async ({ gate, session, recordPath }) => {
    const sendPromise = session.send('hi');
    await waitFor(() => gate.current());
    gate.answer({ decision: 'deny' });
    const result = await sendPromise;
    assert.equal(result.outcome, 'done');
    const answers = readRecord(recordPath).filter((m) => m.id !== undefined && m.method === undefined);
    assert.deepEqual(answers[0].result, { decision: 'deny', reason: '人工拒绝' });
  });
});

test('question 两题：values 按序号与 option.value 匹配，多选拼接', async () => {
  await withGateSession(QUESTION_SCRIPT, {}, async ({ gate, session, recordPath }) => {
    const sendPromise = session.send('hi');
    await waitFor(() => gate.current());
    gate.answer({ values: ['2', ['a', 'b']] });
    const result = await sendPromise;
    assert.equal(result.outcome, 'done');
    const answers = readRecord(recordPath).filter((m) => m.id !== undefined && m.method === undefined);
    assert.deepEqual(answers[0].result, {
      action: 'accept',
      content: { answers: { '选择模式': '稳妥', '选模块': 'A 模块, B 模块' } },
    });
  });
});

test('按 label 匹配也算对', async () => {
  await withGateSession(QUESTION_SCRIPT, {}, async ({ gate, session, recordPath }) => {
    const sendPromise = session.send('hi');
    await waitFor(() => gate.current());
    gate.answer({ values: ['快速', 'B 模块'] });
    const result = await sendPromise;
    assert.equal(result.outcome, 'done');
    const answers = readRecord(recordPath).filter((m) => m.id !== undefined && m.method === undefined);
    assert.deepEqual(answers[0].result.content.answers, { '选择模式': '快速', '选模块': 'B 模块' });
  });
});

test('答案对不上：answer 抛 ExecutorError，pending.json 还在', async () => {
  await withGateSession(QUESTION_SCRIPT, {}, async ({ gate, session }) => {
    const sendPromise = session.send('hi');
    await waitFor(() => gate.current());
    assert.throws(() => gate.answer({ values: ['不存在', 'a'] }), (e) => e?.name === 'ExecutorError');
    assert.equal(gate.current().kind, 'question'); // pending 没被删，还能重新 answer
    gate.answer({ values: ['1', ['a']] }); // 再答对，回合继续
    const result = await sendPromise;
    assert.equal(result.outcome, 'done');
  });
});

test('没有挂起时 answer 抛 ExecutorError', () => {
  const gate = createPendingGate({ pendingPath: path.join(os.tmpdir(), `zcode-pending-none-${Date.now()}.json`) });
  assert.throws(() => gate.answer({ decision: 'allow' }), (e) => e?.name === 'ExecutorError');
  assert.equal(gate.current(), null);
});

test('onPending 里同步 answer 也能通（不死锁）', async () => {
  // T1.2b 第 4 条：currentEntry 在写盘和调 onPending 之前就登记好
  await withGateSession(
    PERMISSION_SCRIPT,
    {
      onPending: (pending, gate) => {
        // onPending 里同步 answer：如果 currentEntry 晚于 onPending 登记，这里会抛「无处可去」
        gate.answer({ decision: 'allow' });
      },
    },
    async ({ session, client, pendingPath, recordPath }) => {
      const result = await session.send('hi');
      assert.equal(result.outcome, 'done');
      assert.equal(readPending(pendingPath), null);
    },
  );
});

test('两个反向请求接连来：先排队，第一个应答后第二个才落盘', async () => {
  const script = {
    serverRequestsDelayMs: 300,
    serverRequests: [
      {
        method: 'interaction/requestPermission',
        params: { requestId: 'rq1', toolName: 'Bash', input: { command: 'ls' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'deny_once' }] },
      },
      { method: 'interaction/requestUserInput', params: { requestId: 'rq2', questions: [{ question: '继续吗', options: [{ label: '继续' }] }] } },
    ],
  };
  await withGateSession(script, {}, async ({ gate, recordPath }) => {
    const first = await waitFor(() => gate.current());
    assert.equal(first.kind, 'permission'); // 第二个在排队，pendingPath 只有第一个
    assert.equal(first.requestId, 'rq1');
    gate.answer({ decision: 'allow' });
    const second = await waitFor(() => (gate.current()?.kind === 'question' ? gate.current() : undefined));
    assert.equal(second.requestId, 'rq2');
    gate.answer({ values: ['继续'] });
    const answers = await waitFor(() => {
      const list = readRecord(recordPath).filter((m) => m.id !== undefined && m.method === undefined);
      return list.length >= 2 ? list : undefined;
    });
    assert.deepEqual(answers[0].result, { decision: 'allow' });
    assert.deepEqual(answers[1].result, { action: 'accept', content: { answers: { '继续吗': '继续' } } });
    assert.equal(gate.current(), null);
  });
});
