// lib/session.mjs 的行为测试：attachSession / Session / settleTurn。
// 全部对 test/mock-appserver.mjs 跑（T0.3 的 helpers），不发真机 session/send，不花额度。
// 3.12 起每个回合前 mock 会要一次 provider 运行时头（verified.md「3.12.2 直连探针实测」表第 5 行），spawn 都带
// providerAuth 答 startMock 的 key，回合才跑得起来。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppServerClient } from '../lib/appserver.mjs';
import { attachSession, settleTurn } from '../lib/session.mjs';
import { startMock, waitFor, readRecord, killAll } from './helpers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pids = [];
const mockDirs = [];
test.after(async () => {
  killAll(pids);
  for (const dir of mockDirs) await rm(dir, { recursive: true, force: true });
});

const SESSION_ID = 'sess_test-1';

// 起 mock + 客户端 + attach 会话的公共壳；eventsPath 在临时目录里由本壳指定（路径约定归调用者）。
// spawn 失败也要清临时目录、收掉起了一半的客户端（T2.7 第 3 条）
async function withSession(script, opts, fn) {
  const mock = await startMock({ script });
  mockDirs.push(mock.dir);
  const eventsPath = path.join(mock.dir, 'nested', 'dir', 'events.jsonl');
  const stderrLines = [];
  let client = null;
  try {
    client = await AppServerClient.spawn({
      zcodePath: mock.zcodePath,
      cwd: mock.dir,
      env: mock.env,
      providerAuth: () => mock.apiKey,
      onStderr: (line) => stderrLines.push(line),
    });
    pids.push(client.pid);
    const session = await attachSession({
      client,
      sessionId: SESSION_ID,
      cwd: mock.dir,
      eventsPath,
      handlers: opts.handlers,
      onEvent: opts.onEvent,
    });
    return await fn({ session, eventsPath, recordPath: mock.recordPath, client, stderrLines });
  } finally {
    if (client) await client.close({ timeoutMs: 2000 }).catch(() => {});
    await mock.cleanup();
  }
}

test('settleTurn：completed → done，lastText 拼接 text_delta，usage 透传', () => {
  const settled = settleTurn([
    { type: 'turn.started', payload: {} },
    { type: 'model.streaming', payload: { kind: 'text_delta', delta: '你好' } },
    { type: 'model.streaming', payload: { kind: 'reasoning_delta', delta: '不该出现' } },
    { type: 'model.streaming', payload: { kind: 'text_delta', delta: '，世界' } },
    { type: 'turn.completed', payload: { resultType: 'success', usage: { totalTokens: 42 } } },
  ]);
  assert.deepEqual(settled, { outcome: 'done', reason: null, lastText: '你好，世界', usage: { totalTokens: 42 } });
});

test('settleTurn：failed 带 error.message', () => {
  const failed = settleTurn([{ type: 'turn.failed', payload: { error: { code: 1308, message: 'prompt is running' } } }]);
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.reason, 'prompt is running');
  const none = settleTurn([{ type: 'turn.started', payload: {} }]);
  assert.equal(none.outcome, null);
});

// 六种 resultType 各一条（2026-09-21 对照 ZCode 源码：非 success 也走 turn.completed，不走 turn.failed；
// 结束事件只有这两个）
test('settleTurn：resultType 缺省 → done', () => {
  const settled = settleTurn([{ type: 'turn.completed', payload: { usage: { totalTokens: 3 } } }]);
  assert.deepEqual(settled, { outcome: 'done', reason: null, lastText: '', usage: { totalTokens: 3 } });
});

test('settleTurn：resultType null 也算缺省 → done', () => {
  const settled = settleTurn([{ type: 'turn.completed', payload: { resultType: null, usage: { totalTokens: 3 } } }]);
  assert.deepEqual(settled, { outcome: 'done', reason: null, lastText: '', usage: { totalTokens: 3 } });
});

test('settleTurn：resultType success → done', () => {
  const settled = settleTurn([{ type: 'turn.completed', payload: { resultType: 'success', usage: { totalTokens: 4 } } }]);
  assert.deepEqual(settled, { outcome: 'done', reason: null, lastText: '', usage: { totalTokens: 4 } });
});

test('settleTurn：resultType cancelled → outcome cancelled，reason 说明被叫停', () => {
  const settled = settleTurn([{ type: 'turn.completed', payload: { resultType: 'cancelled', usage: { totalTokens: 0 } } }]);
  assert.deepEqual(settled, {
    outcome: 'cancelled',
    reason: '回合被叫停（resultType=cancelled）',
    lastText: '',
    usage: { totalTokens: 0 },
  });
});

test('settleTurn：resultType error_max_turns → failed，reason 带 resultType 值', () => {
  const settled = settleTurn([{ type: 'turn.completed', payload: { resultType: 'error_max_turns' } }]);
  assert.equal(settled.outcome, 'failed');
  assert.equal(settled.reason, 'turn.completed resultType=error_max_turns');
});

test('settleTurn：resultType error_max_budget → failed', () => {
  const settled = settleTurn([{ type: 'turn.completed', payload: { resultType: 'error_max_budget' } }]);
  assert.equal(settled.outcome, 'failed');
  assert.equal(settled.reason, 'turn.completed resultType=error_max_budget');
});

test('settleTurn：resultType error_during_execution → failed', () => {
  const settled = settleTurn([{ type: 'turn.completed', payload: { resultType: 'error_during_execution' } }]);
  assert.equal(settled.outcome, 'failed');
  assert.equal(settled.reason, 'turn.completed resultType=error_during_execution');
});

test('settleTurn：resultType error_max_tool_calls → failed', () => {
  const settled = settleTurn([{ type: 'turn.completed', payload: { resultType: 'error_max_tool_calls' } }]);
  assert.equal(settled.outcome, 'failed');
  assert.equal(settled.reason, 'turn.completed resultType=error_max_tool_calls');
});

test('attach 后 send：事件依次落盘，outcome done，lastText 与 usage 正确', async () => {
  const script = {
    turns: [
      {
        events: [
          { type: 'model.streaming', payload: { kind: 'text_delta', delta: '你好' } },
          { type: 'model.streaming', payload: { kind: 'text_delta', delta: '，世界' } },
          { type: 'tool.updated', payload: { toolName: 'Bash' } },
        ],
      },
    ],
  };
  await withSession(script, {}, async ({ session, eventsPath }) => {
    const result = await session.send('跑个命令');
    assert.equal(result.outcome, 'done');
    assert.equal(result.reason, null);
    assert.equal(result.lastText, '你好，世界');
    assert.deepEqual(result.usage, { totalTokens: 0 });
    assert.match(result.startedAt, /^\d{4}-\d{2}-\d{2}T/); // ISO 8601（RULES §6）
    assert.match(result.endedAt, /^\d{4}-\d{2}-\d{2}T/);
    const raw = await readFile(eventsPath, 'utf8');
    const events = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      events.map((e) => e.type),
      ['turn.started', 'model.streaming', 'model.streaming', 'tool.updated', 'turn.completed'],
    );
    assert.ok(events.every((e) => e.sessionId === SESSION_ID));
  });
});

test('剧本开 runtimeHeaders 且 spawn 没给 providerAuth → 回合在模型请求前失败，reason 说明缺哪个 provider 的 key', async () => {
  const script = { runtimeHeaders: true, turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: '不该到' } }] }] };
  const mock = await startMock({ script });
  mockDirs.push(mock.dir);
  const client = await AppServerClient.spawn({ zcodePath: mock.zcodePath, cwd: mock.dir, env: mock.env, onStderr: () => {} });
  pids.push(client.pid);
  try {
    const session = await attachSession({ client, sessionId: SESSION_ID, cwd: mock.dir, eventsPath: path.join(mock.dir, 'events.jsonl') });
    const result = await session.send('hi');
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, 'zcode-executor 没有 provider zcode-executor 的 API key，模型请求发不出去');
    assert.equal(result.lastText, '');
  } finally {
    await client.close({ timeoutMs: 2000 }).catch(() => {});
    await mock.cleanup();
  }
});

test('剧本 fail → outcome failed，reason 是剧本里的 message', async () => {
  const script = {
    turns: [{ fail: { code: 1308, message: 'prompt is running' } }],
  };
  await withSession(script, {}, async ({ session }) => {
    const result = await session.send('hi');
    assert.equal(result.outcome, 'failed');
    assert.equal(result.reason, 'prompt is running');
  });
});

test('只有未知结束事件 → 不结算，outcome null', async () => {
  const script = {
    turns: [
      {
        hang: true, // 挡住引擎自动推的 turn.completed，制造「只有未知事件」
        events: [
          // 随便一个不在事件枚举里的类型（旧协议里那个已删的收尾事件也在其列）
          { type: 'turn.finished', payload: { status: 'success', inputTokens: 1, outputTokens: 4, totalTokens: 5 } },
        ],
      },
    ],
  };
  await withSession(script, {}, async ({ session }) => {
    // 2026-09-21 对照 ZCode 源码：结束事件只有 turn.completed / turn.failed，
    // 未知事件只落盘、不结算；回合要等真正的结束事件（这里等不到，按超时收）
    const result = await session.send('hi', { timeoutMs: 300 });
    assert.equal(result.outcome, 'timeout');
    assert.deepEqual(result.usage, null);
  });
});

test('hang + timeoutMs → outcome timeout，mock 记录里的 session/stop 带 id（请求，不是通知）', async () => {
  const script = { turns: [{ hang: true }] };
  await withSession(script, {}, async ({ session, recordPath }) => {
    const startedAt = Date.now();
    const result = await session.send('hi', { timeoutMs: 300 });
    assert.equal(result.outcome, 'timeout');
    assert.match(result.reason, /超时/);
    // 宽限期最多 5 秒（任务单定死），总耗时应略高于 300ms + 5s，不能无限等
    assert.ok(Date.now() - startedAt < 8000);
    const record = readRecord(recordPath);
    // 2026-09-21 对照 ZCode 源码：app-server 忽略无 id 的消息，session/stop 必须带 id 才会被处理
    assert.ok(record.some((m) => m.method === 'session/stop' && m.id !== undefined));
  });
});

test('exitAfter session/send → outcome exited，reason 带退出码', async () => {
  const script = { exitAfter: 'session/send' };
  await withSession(script, {}, async ({ session }) => {
    const result = await session.send('hi');
    assert.equal(result.outcome, 'exited');
    assert.match(result.reason, /code=3/);
  });
});

test('两次 send 串行：第二回合 lastText 独立，两回合事件都在', async () => {
  const script = {
    turns: [
      { events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: '第一回合' } }] },
      { events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: '第二回合' } }] },
    ],
  };
  await withSession(script, {}, async ({ session, eventsPath }) => {
    const first = await session.send('a');
    assert.equal(first.lastText, '第一回合');
    const second = await session.send('b');
    assert.equal(second.lastText, '第二回合');
    assert.ok(!second.lastText.includes('第一回合'));
    const raw = await readFile(eventsPath, 'utf8');
    const events = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.type === 'turn.started').length, 2);
    assert.equal(events.filter((e) => e.type === 'turn.completed').length, 2);
  });
});

test('回合中 steer（session/send）被拒 -32010，第一回合正常结束', async () => {
  const script = {
    turns: [
      {
        events: [{ type: 'model.streaming', delayMs: 200, payload: { kind: 'text_delta', delta: '慢慢来' } }],
      },
    ],
  };
  await withSession(script, {}, async ({ session, recordPath }) => {
    const sendPromise = session.send('慢慢跑');
    await sleep(60); // turn.started 已到、回合进行中
    // 2026-09-21 对照 ZCode 源码：3.12.2 起回合进行中再发 session/send 直接拒绝（3.11 是排队插话）
    await assert.rejects(
      session.steer('插一句'),
      (err) => {
        assert.match(err.message, /A prompt is already running for this session/);
        assert.equal(err.details.code, -32010);
        return true;
      },
    );
    const result = await sendPromise;
    assert.equal(result.outcome, 'done');
    assert.equal(result.lastText, '慢慢来'); // 插话被拒，不影响本回合
    const sends = readRecord(recordPath).filter((m) => m.method === 'session/send');
    assert.equal(sends.length, 2);
    assert.equal(sends[1].params.content, '插一句'); // 第二条确实发出去了，被 mock 拒的
  });
});

test('handlers.permission：收到 params（toolName/input/options），应答回给 mock，回合继续', async () => {
  const seen = [];
  const script = {
    turns: [{ permission: { toolName: 'Bash', input: { command: 'rm -rf /tmp/x' }, reason: '清理临时目录' } }],
  };
  await withSession(
    script,
    {
      handlers: {
        permission: async (params) => {
          seen.push(params);
          return { decision: 'allow', reason: '放行' };
        },
      },
    },
    async ({ session, recordPath }) => {
      const result = await session.send('干活');
      assert.equal(result.outcome, 'done');
      assert.equal(seen.length, 1);
      assert.equal(seen[0].toolName, 'Bash');
      assert.deepEqual(seen[0].input, { command: 'rm -rf /tmp/x' });
      assert.ok(Array.isArray(seen[0].options));
      assert.ok(seen[0].options.some((o) => o.kind === 'allow_once'));
      const record = readRecord(recordPath);
      const answers = record.filter((m) => m.id !== undefined && m.method === undefined && m.result?.headersApplied === undefined);
      assert.deepEqual(answers[0].result, { decision: 'allow', reason: '放行' });
    },
  );
});

test('resume 失败 → attachSession reject，details.data 透传', async () => {
  const script = { errors: { 'session/resume': { code: -32602, message: 'no such session', data: { details: ['会话不存在'] } } } };
  const mock = await startMock({ script });
  mockDirs.push(mock.dir);
  const client = await AppServerClient.spawn({ zcodePath: mock.zcodePath, cwd: mock.dir, env: mock.env });
  pids.push(client.pid);
  try {
    await assert.rejects(
      attachSession({
        client,
        sessionId: SESSION_ID,
        cwd: mock.dir,
        eventsPath: path.join(mock.dir, 'events.jsonl'),
      }),
      (err) => {
        assert.equal(err.details.code, -32602);
        assert.deepEqual(err.details.data.details, ['会话不存在']);
        return true;
      },
    );
  } finally {
    await client.close({ timeoutMs: 2000 }).catch(() => {});
    await mock.cleanup();
  }
});

test('别的 sessionId 的事件不落盘', async () => {
  const script = {
    turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: '自己的' } }] }],
    strayEvents: [{ sessionId: 'sess_other', type: 'turn.completed', payload: { resultType: 'success' } }],
  };
  await withSession(script, {}, async ({ session, eventsPath }) => {
    const result = await session.send('hi');
    assert.equal(result.outcome, 'done');
    const raw = await readFile(eventsPath, 'utf8');
    const events = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    assert.ok(events.every((e) => e.sessionId === SESSION_ID)); // 别人的没进来
    // 自己的 turn.completed 恰一条（stray 那条同名事件被过滤）
    assert.equal(events.filter((e) => e.type === 'turn.completed').length, 1);
  });
});

test('eventsPath 的目录不存在时自动创建（先建目录再追加）', async () => {
  const script = { turns: [{ hang: true }] };
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'zcode-session-test-'));
  try {
    const mock = await startMock({ script });
    mockDirs.push(mock.dir);
    const eventsPath = path.join(tmp, 'a', 'b', 'events.jsonl');
    const client = await AppServerClient.spawn({ zcodePath: mock.zcodePath, cwd: mock.dir, env: mock.env, providerAuth: () => mock.apiKey });
    pids.push(client.pid);
    const session = await attachSession({ client, sessionId: SESSION_ID, cwd: mock.dir, eventsPath });
    const result = await session.send('hi', { timeoutMs: 200 });
    assert.equal(result.outcome, 'timeout');
    const raw = await readFile(eventsPath, 'utf8'); // 目录被建出来且文件有内容
    assert.ok(raw.includes('turn.started'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('send 的超时定时器在回合结束后撤销，进程不空转', async () => {
  const script = {
    turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: '很快' } }] }],
  };
  await withSession(script, {}, async ({ session }) => {
    const startedAt = Date.now();
    const result = await session.send('hi', { timeoutMs: 5000 }); // 给很大，回合 33ms 就结束
    assert.equal(result.outcome, 'done');
    assert.ok(Date.now() - startedAt < 1000); // T1.1b 第 1 条：不等满 5 秒
    await sleep(50);
    assert.equal(process.getActiveResourcesInfo().includes('Timeout'), false); // 分支定时器已撤
  });
});

test('上一回合被叫停后，残留的收尾事件不把下一次 send 判成假 done', async () => {
  const script = {
    turns: [
      // 回合 1：completed 在超时+宽限都过了之后才到（seq 落在旧时间线）；
      // stop 在 300ms 就到了，mock 在 5600ms 的检查点以 resultType=cancelled 收尾
      { events: [{ type: 'turn.completed', delayMs: 5600, payload: { resultType: 'success' } }] },
      { hang: true }, // 回合 2：挂住，专等上一回合的收尾事件来污染
    ],
  };
  await withSession(script, {}, async ({ session, eventsPath }) => {
    const first = await session.send('a', { timeoutMs: 300 });
    assert.equal(first.outcome, 'timeout'); // 宽限 5 秒耗尽，mock 的收尾事件还没来
    // 等 mock 侧回合真正收尾（cancelled 的 turn.completed 落盘）再投第二条：
    // 不等它，下一次 send 会撞上「回合进行中」的 -32010 拒绝
    await waitFor(async () => {
      let events = [];
      try {
        const raw = await readFile(eventsPath, 'utf8');
        events = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      } catch {
        // 文件还没建出来，当空处理
      }
      return events.some((e) => e.type === 'turn.completed' && e.payload?.resultType === 'cancelled') ? true : undefined;
    });
    const second = await session.send('b', { timeoutMs: 300 });
    // T1.1b 第 2 条：上一回合时间线的收尾事件不能算第二回合的结束
    assert.equal(second.outcome, 'timeout');
    assert.equal(second.lastText, '');
  });
});

test('send 超时 → stop 请求 → mock 推 cancelled → 对外仍报 timeout', async () => {
  const script = {
    turns: [{ events: [{ type: 'turn.completed', delayMs: 1000, payload: { resultType: 'success' } }] }],
  };
  await withSession(script, {}, async ({ session, recordPath, eventsPath }) => {
    const startedAt = Date.now();
    const result = await session.send('hi', { timeoutMs: 300 });
    // 只要本次 send 触发过超时，宽限内不管等到什么结束事件对外都是 timeout（退出码 3：再投一次接着做），
    // 4 的「回合异常」和 3 的「取消后重投」用户处理方式不同，不能丢掉「是超时」这个事实
    assert.equal(result.outcome, 'timeout');
    assert.match(result.reason, /已发 session\/stop/);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 300 && elapsed < 5000); // cancelled 一到就返回，不等满 5 秒宽限
    // 但 stop 是真的生效了：带 id 的请求发出去了，mock 也以 resultType=cancelled 收掉了回合
    const stops = readRecord(recordPath).filter((m) => m.method === 'session/stop');
    assert.equal(stops.length, 1);
    assert.ok(stops[0].id !== undefined); // 带 id 的请求
    const raw = await readFile(eventsPath, 'utf8');
    const completed = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'turn.completed');
    assert.equal(completed.payload.resultType, 'cancelled'); // 剧本的 success 没推，推的是叫停的 cancelled
  });
});

test('stop() 返回 mock 的 result，记录里带 id', async () => {
  await withSession({}, {}, async ({ session, recordPath }) => {
    const result = await session.stop(); // 空闲时叫停：mock 回 {}
    assert.deepEqual(result, {});
    const stops = readRecord(recordPath).filter((m) => m.method === 'session/stop');
    assert.equal(stops.length, 1);
    assert.ok(stops[0].id !== undefined);
    assert.equal(stops[0].params.sessionId, SESSION_ID);
  });
});

test('Session.close() 后 mock 记录里有 session/close', async () => {
  await withSession({}, {}, async ({ session, recordPath, client }) => {
    await session.close();
    const record = readRecord(recordPath);
    const closes = record.filter((m) => m.method === 'session/close');
    assert.equal(closes.length, 1);
    assert.equal(closes[0].params.sessionId, SESSION_ID);
    await client.exited; // client.close() 也被带上了
  });
});

test('后台任务回合（inputSource=background_task）整段不认', async () => {
  const script = {
    turns: [
      {
        hang: true, // 挡住引擎自动推的收尾，整段都是「后台」时间线
        events: [
          { type: 'turn.started', payload: { inputSource: 'background_task' } },
          { type: 'model.streaming', payload: { kind: 'text_delta', delta: '后台的' } },
          { type: 'turn.completed', payload: { resultType: 'success' } },
        ],
      },
    ],
  };
  await withSession(script, {}, async ({ session }) => {
    const result = await session.send('hi', { timeoutMs: 300 });
    // T1.1b 第 7 条：后台回合的事件不参与结算——否则这条会被判成 done
    assert.equal(result.outcome, 'timeout');
    assert.equal(result.lastText, '');
  });
});

test('非 session/event 的通知按 {method, params} 落盘', async () => {
  const script = {
    turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'x' } }] }],
    strayEvents: [{ method: 'process/mcpTelemetry', sessionId: SESSION_ID, params: { foo: 'bar' } }],
  };
  await withSession(script, {}, async ({ session, eventsPath }) => {
    const result = await session.send('hi');
    assert.equal(result.outcome, 'done');
    const raw = await readFile(eventsPath, 'utf8');
    const events = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const telemetry = events.filter((e) => e.method === 'process/mcpTelemetry');
    assert.equal(telemetry.length, 1); // T1.1b 第 11 条：{method, params} 形状落盘
    assert.deepEqual(telemetry[0].params.foo, 'bar');
  });
});
