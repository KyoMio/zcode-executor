// lib/errors.mjs 与 lib/appserver.mjs 的行为测试。
// 纯函数用例（classify / findZcode / ExecutorError）直接喂输入；
// 客户端用例一律对 test/mock-appserver.mjs 跑（T0.3），不 spawn 真 zcode，不花额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutorError } from '../lib/errors.mjs';
import { findZcode, classify, AppServerClient } from '../lib/appserver.mjs';
import { buildRegistry } from '../lib/providers.mjs';
import { startMock, waitFor, readRecord, killAll } from './helpers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// after() 兜底：清僵尸进程与临时目录（RULES §9）
const pids = [];
const mockDirs = [];
test.after(async () => {
  killAll(pids);
  for (const dir of mockDirs) await rm(dir, { recursive: true, force: true });
});

// 合成 provider 表：一个 provider 两个模型，走 buildRegistry 真实构造路径
const CONFIG = {
  provider: {
    'builtin:test-plan': {
      kind: 'anthropic',
      name: 'Test Plan',
      options: { baseURL: 'https://api.test.example', apiKey: 'sk-mock-local' },
      models: {
        'GLM-5.3': {
          name: 'GLM 5.3',
          limit: { context: 200000, output: 32000 },
          reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' },
        },
        'GLM-5.3-Flash': { reasoning: { enabled: true, variants: ['low', 'high'], defaultVariant: 'high' } },
      },
    },
  },
};
const REGISTRY = buildRegistry(CONFIG);

// 起 mock + 客户端的公共壳：collect 通知与 stderr，登记 pid，finally 收场。
// spawn 失败也要清临时目录、收掉起了一半的客户端（T2.7 第 3 条）
async function withMock(script, opts, fn) {
  const mock = await startMock({ script });
  mockDirs.push(mock.dir);
  const notifications = [];
  const stderrLines = [];
  let client = null;
  try {
    client = await AppServerClient.spawn({
      zcodePath: mock.zcodePath,
      cwd: mock.dir,
      env: mock.env,
      secrets: opts.secrets ?? [],
      onServerRequest: opts.onServerRequest,
      onNotification: (n) => notifications.push(n),
      onStderr: (line) => stderrLines.push(line),
    });
    pids.push(client.pid);
    return await fn({ client, notifications, stderrLines, recordPath: mock.recordPath });
  } finally {
    if (client) await client.close({ timeoutMs: 2000 }).catch(() => {});
    await mock.cleanup();
  }
}

const pushRegistry = (client, workspace) =>
  client.request('workspace/updateProviderRegistry', { workspace, registry: REGISTRY }, { timeoutMs: 2000 });

const WORKSPACE = { workspacePath: '/tmp/probe-ws', workspaceKey: '/tmp/probe-ws' };

const isResponse = (m) => m.id !== undefined && m.method === undefined;

test('ExecutorError：带 exitCode 与 details', () => {
  const err = new ExecutorError('白名单外的 cwd，改用 worktree 目录', 2, { cwd: '/tmp/x' });
  assert.ok(err instanceof Error);
  assert.equal(err.message, '白名单外的 cwd，改用 worktree 目录');
  assert.equal(err.name, 'ExecutorError');
  assert.equal(err.exitCode, 2);
  assert.deepEqual(err.details, { cwd: '/tmp/x' });
});

test('ExecutorError：exitCode 默认 1，details 默认空对象', () => {
  const err = new ExecutorError('出错了');
  assert.equal(err.exitCode, 1);
  assert.deepEqual(err.details, {});
});

test('ExecutorError：第二参传对象视为 details，退出码用默认（评审第 7 条）', () => {
  const err = new ExecutorError('协议层不定退出码', { method: 'x' });
  assert.equal(err.exitCode, 1);
  assert.deepEqual(err.details, { method: 'x' });
});

test('classify：id + method 是反向请求', () => {
  assert.equal(classify({ id: 7, method: 'interaction/requestPermission', params: {} }), 'request');
});

test('classify：id 无 method 是响应', () => {
  assert.equal(classify({ id: 7, result: { ok: 1 } }), 'response');
  assert.equal(classify({ id: 7, error: { code: 1, message: 'x' } }), 'response');
});

test('classify：无 id 有 method 是通知', () => {
  assert.equal(classify({ method: 'session/event', params: {} }), 'notification');
});

test('classify：既无 id 也无 method 判为 invalid', () => {
  // id 无 method 一律算响应（协议分类只看字段有无，畸形响应也归这堆）
  assert.equal(classify({ id: 7 }), 'response');
  assert.equal(classify({ params: {} }), 'invalid');
  assert.equal(classify(null), 'invalid');
  assert.equal(classify('hello'), 'invalid');
});

test('findZcode：优先用 ZCODE_BIN（显式传参，不改全局环境变量）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-executor-test-'));
  mockDirs.push(dir);
  const bin = path.join(dir, 'zcode-bin.cjs');
  await writeFile(bin, '// fake\n');
  assert.equal(findZcode({ zcodeBin: bin }), path.resolve(bin));
});

test('findZcode：ZCODE_BIN 指向不存在的文件时抛 ExecutorError(1)', () => {
  assert.throws(() => findZcode({ zcodeBin: '/nonexistent/zcode-bin.cjs' }), (err) => err instanceof ExecutorError && err.exitCode === 1);
});

test('推表 → create → runtimePreferences：处理器只跑一次，每个信封都拿到同一默认应答', async () => {
  let handlerCalls = 0;
  await withMock(
    { resendIntervalMs: 40 },
    {
      // 拖 150ms 再交默认应答：期间 mock 按真机行为重发（同 requestId、新信封 id）
      onServerRequest: (req) => {
        if (req.method === 'session/requestRuntimePreferences') {
          handlerCalls += 1;
          return sleep(150).then(() => undefined);
        }
        return undefined;
      },
    },
    async ({ client, recordPath, stderrLines }) => {
      const pushed = await pushRegistry(client, WORKSPACE);
      assert.equal(pushed.status, 'applied');
      assert.equal(pushed.appliedProviderRevision, REGISTRY.revision);
      assert.equal(pushed.providerCount, 1);
      const created = await client.request(
        'session/create',
        { workspace: WORKSPACE, mode: 'build', persistence: 'immediate',
          titleGenerationEnabled: false, thoughtLevel: 'high' },
        { timeoutMs: 2000 },
      );
      assert.match(created.session.sessionId, /^sess_/);
      assert.equal(created.settings.thoughtLevel.current, 'high'); // 合法值回显
      assert.equal(created.settings.appliedProviderRevision, REGISTRY.revision);
      // mock 发出的反向请求不进记录文件（记录只收收到的），从 stderr 日志数发送次数；
      // 先等「已应答」（重发循环停了）再计数，不然快照期间还会冒新的重发
      await waitFor(() => (stderrLines.some((l) => l.includes('runtimePreferences answered')) ? true : undefined), { timeoutMs: 3000 });
      const sent = stderrLines.filter((l) => l.includes('server-request session/requestRuntimePreferences'));
      const envelopeIds = sent.map((l) => Number(l.match(/envelope=(\d+)/)?.[1]));
      assert.ok(envelopeIds.length >= 3); // 150ms 处理器 + 40ms 重发：至少发 3 次
      assert.equal(new Set(sent.map((l) => l.match(/requestId=(\S+)/)?.[1])).size, 1); // 重发同一 requestId
      assert.equal(new Set(envelopeIds).size, envelopeIds.length); // 信封 id 各不相同
      // 记录文件里是收到的应答：每个信封恰一条，结果全是内置默认值（T0.2c：漏答会让 zcode 挂等）
      const expected = {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      };
      const answers = await waitFor(() => {
        const r = readRecord(recordPath).filter(isResponse);
        return r.length >= envelopeIds.length ? r : undefined;
      }, { timeoutMs: 3000 });
      assert.equal(handlerCalls, 1); // 处理器只跑一次
      assert.equal(answers.length, envelopeIds.length);
      assert.ok(answers.every((m) => JSON.stringify(m.result) === JSON.stringify(expected)));
      assert.deepEqual(new Set(answers.map((m) => m.id)), new Set(envelopeIds)); // 逐个信封补答
    },
  );
});

test('没推表 create 被拒，details 带 model_config_missing', async () => {
  await withMock({}, {}, async ({ client }) => {
    await assert.rejects(
      client.request('session/create', { workspace: WORKSPACE, mode: 'build' }, { timeoutMs: 2000 }),
      (err) => {
        assert.ok(err instanceof ExecutorError);
        assert.match(err.message, /Model config is missing/);
        assert.equal(err.details.data.code, 'model_config_missing');
        assert.equal(err.details.data.name, 'ModelProtocolError');
        return true;
      },
    );
  });
});

test('剧本让方法挂住 → 请求超时，信息里有方法名', async () => {
  await withMock({ hangMethods: ['workspace/readState'] }, {}, async ({ client }) => {
    const startedAt = Date.now();
    await assert.rejects(client.request('workspace/readState', {}, { timeoutMs: 200 }), (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.match(err.message, /超时/);
      assert.match(err.message, /workspace\/readState/);
      return true;
    });
    assert.ok(Date.now() - startedAt < 2000); // 按超时算，不等默认 30s
  });
});

test('exitAfter 让子进程崩：挂着的请求全部 reject，exited code 3', async () => {
  await withMock({ exitAfter: 'session/subscribe' }, {}, async ({ client }) => {
    const answered = client.request('session/subscribe', { sessionId: 'sess_x', deliveryKind: 'desktop-continuous' }, { timeoutMs: 3000 });
    const pending = client.request('workspace/readState', {}, { timeoutMs: 3000 });
    assert.deepEqual(await answered, { eventSeq: 0, snapshot: {} }); // exitAfter 的方法本身有应答
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.match(err.message, /退出/);
      assert.equal(err.details.method, 'workspace/readState');
      return true;
    });
    const exitInfo = await client.exited;
    assert.deepEqual(exitInfo, { code: 3, signal: null });
  });
});

test('junkStdoutLine 不崩，正常应答照走', async () => {
  const junk = '<html>server busy</html>';
  await withMock({ junkStdoutLine: junk }, {}, async ({ client, stderrLines }) => {
    const result = await client.request('session/subscribe', { deliveryKind: 'desktop-continuous' }, { timeoutMs: 2000 });
    assert.deepEqual(result, { eventSeq: 0, snapshot: {} });
    await waitFor(() => (stderrLines.some((l) => l.includes(junk)) ? true : undefined));
    assert.ok(stderrLines.some((l) => l.startsWith('zcode: ')));
  });
});

test('ignoreEof 时 close 走 SIGKILL，返回 signal SIGKILL', async () => {
  await withMock({ ignoreEof: true }, {}, async ({ client }) => {
    const info = await client.close({ timeoutMs: 200 });
    assert.deepEqual(info, { code: null, signal: 'SIGKILL' });
  });
});

test('stdin 关闭后 request 立刻 reject，不等满超时', async () => {
  // ignoreEof 让 mock 活过 EOF，模拟「close 之后进程还没退」的窗口
  await withMock({ ignoreEof: true }, {}, async ({ client }) => {
    const startedAt = Date.now();
    void client.close({ timeoutMs: 5000 }); // 关 stdin，进程还活着
    await assert.rejects(client.request('anything', {}, { timeoutMs: 30_000 }), (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.match(err.message, /连接已关闭/);
      assert.match(err.message, /anything/);
      return true;
    });
    assert.ok(Date.now() - startedAt < 2000); // 立刻失败，没等 30s
    await client.close({ timeoutMs: 200 }); // 收尾 SIGKILL
  });
});

test('未知反向请求回 -32601，应答进了记录文件', async () => {
  await withMock(
    { serverRequests: [{ method: 'mock/unknown', params: { reason: 'testing' } }] },
    { onServerRequest: () => undefined }, // 没人接住 → 客户端回 -32601
    async ({ recordPath }) => {
      const record = await waitFor(() => {
        const r = readRecord(recordPath);
        const answers = r.filter((m) => isResponse(m) && m.error !== undefined);
        return answers.length >= 1 ? answers : undefined;
      });
      assert.equal(record[0].error.code, -32601);
      assert.match(record[0].error.message, /mock\/unknown/);
    },
  );
});

test('子进程 stderr 经 onStderr 收到并带 zcode: 前缀', async () => {
  await withMock({}, {}, async ({ stderrLines }) => {
    await waitFor(() => (stderrLines.some((l) => l.startsWith('zcode: mock: started')) ? true : undefined));
    assert.ok(stderrLines[0].includes('version='));
  });
});

test('session/send 后按顺序收到 turn.started、tool.updated、turn.completed', async () => {
  await withMock(
    {
      turns: [
        {
          events: [{ type: 'tool.updated', payload: { toolName: 'Bash', input: { command: 'ls' } } }],
        },
      ],
    },
    {},
    async ({ client, notifications }) => {
      await pushRegistry(client, WORKSPACE);
      const created = await client.request('session/create', { workspace: WORKSPACE, mode: 'build' }, { timeoutMs: 2000 });
      const sessionId = created.session.sessionId;
      await client.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, { timeoutMs: 2000 });
      const sent = await client.request('session/send', { sessionId }, { timeoutMs: 2000 });
      assert.deepEqual(sent, { accepted: true });
      await waitFor(() =>
        notifications.some((n) => n.method === 'session/event' && n.params.type === 'turn.completed') ? true : undefined,
      );
      const events = notifications.filter((n) => n.method === 'session/event');
      assert.deepEqual(
        events.map((n) => n.params.type),
        ['turn.started', 'tool.updated', 'turn.completed'],
      );
      // T0.3c 第 10 条：seq 严格递增，值都定下来
      assert.deepEqual(events.map((n) => n.params.seq), [1, 2, 3]);
      assert.equal(events.find((n) => n.params.type === 'turn.completed').params.payload.resultType, 'success');
    },
  );
});

test('session/list 与 session/close：建了在列，close 后移除', async () => {
  await withMock({}, {}, async ({ client }) => {
    await pushRegistry(client, WORKSPACE);
    const created = await client.request('session/create', { workspace: WORKSPACE, mode: 'build' }, { timeoutMs: 2000 });
    const sessionId = created.session.sessionId;
    const list = await client.request('session/list', { workspace: WORKSPACE }, { timeoutMs: 2000 });
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].sessionId, sessionId);
    assert.equal(list.sessions[0].status, 'idle');
    const closed = await client.request('session/close', { sessionId }, { timeoutMs: 2000 });
    assert.deepEqual(closed, { closed: true });
    const afterClose = await client.request('session/list', { workspace: WORKSPACE }, { timeoutMs: 2000 });
    assert.deepEqual(afterClose.sessions, []);
  });
});

test('推表前 readState 是未配置形状', async () => {
  await withMock({}, {}, async ({ client }) => {
    const state = await client.request('workspace/readState', { workspace: WORKSPACE }, { timeoutMs: 2000 });
    assert.deepEqual(state.modelCatalog, { available: [], providers: [], revision: 0 });
    assert.deepEqual(state.settings.model.current, { modelId: 'missing-model', providerId: 'zcode-unconfigured' });
    assert.equal(state.settings.thoughtLevel.enabled, false);
  });
});

test('推表后 readState 按 registry 生成模型列表与思考等级', async () => {
  await withMock({}, {}, async ({ client }) => {
    await pushRegistry(client, WORKSPACE);
    const state = await client.request('workspace/readState', { workspace: WORKSPACE }, { timeoutMs: 2000 });
    assert.equal(state.settings.model.available.length, 2); // 每 model 一条
    assert.deepEqual(state.settings.model.available[0].ref, { modelId: 'GLM-5.3', providerId: 'builtin:test-plan' });
    assert.deepEqual(
      state.settings.model.available[0].reasoning.levels.map((l) => l.value),
      ['low', 'high', 'max'],
    );
    assert.equal(state.settings.thoughtLevel.current, 'max'); // 默认档
    assert.equal(state.settings.thoughtLevel.enabled, true);
    assert.equal(state.settings.appliedProviderRevision, REGISTRY.revision);
  });
});

test('反向请求应答后停止重发，记录里应答条数不再增长', async () => {
  await withMock({ resendIntervalMs: 50 }, {}, async ({ client, recordPath, stderrLines }) => {
    await pushRegistry(client, WORKSPACE);
    await client.request('session/create', { workspace: WORKSPACE, mode: 'build' }, { timeoutMs: 2000 });
    // 等首轮应答落地（mock 记到 answered 说明重发循环已停）
    await waitFor(() => (stderrLines.some((l) => l.includes('runtimePreferences answered')) ? true : undefined));
    const countAt = () => readRecord(recordPath).filter(isResponse).length;
    const before = countAt();
    await sleep(300); // 够 mock 重发两轮——如果还在重发的话
    assert.equal(countAt(), before); // T0.3c 第 1 条：应答后不再有新信封、不再有新应答
  });
});

test('subscribe 缺 deliveryKind 被 mock 拒 -32602', async () => {
  await withMock({}, {}, async ({ client }) => {
    await assert.rejects(client.request('session/subscribe', {}, { timeoutMs: 2000 }), (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.equal(err.details.code, -32602);
      assert.match(err.message, /deliveryKind/);
      return true;
    });
  });
});

test('剧本读不出来时 mock 退出码 1', async () => {
  const mock = await startMock({ script: {} });
  mockDirs.push(mock.dir);
  // 把传给子进程的剧本路径指向不存在的地方（T0.3c 第 3 条：不能静默变全默认）。
  // 注意改 env 对象本身，别改 process.env——spawn 的 env 选项会覆盖全局环境
  mock.env.MOCK_APPSERVER_SCRIPT = '/nonexistent/mock-script.json';
  const client = await AppServerClient.spawn({ zcodePath: mock.zcodePath, cwd: mock.dir, env: mock.env });
  pids.push(client.pid);
  try {
    const exitInfo = await client.exited;
    assert.deepEqual(exitInfo, { code: 1, signal: null });
  } finally {
    await client.close({ timeoutMs: 500 }).catch(() => {});
    await mock.cleanup();
  }
});

test('同时起两个 mock，各自剧本互不影响', async () => {
  const modelA = [{ modelId: 'GLM-A', reasoning: { enabled: true, levels: [{ value: 'high', label: 'high' }], defaultLevel: 'high' } }];
  const modelB = [{ modelId: 'GLM-B', reasoning: { enabled: true, levels: [{ value: 'low', label: 'low' }], defaultLevel: 'low' } }];
  const mockA = await startMock({ script: { models: modelA, registryRequired: false } });
  const mockB = await startMock({ script: { models: modelB, registryRequired: false } });
  mockDirs.push(mockA.dir, mockB.dir);
  assert.equal(process.env.MOCK_APPSERVER_SCRIPT, undefined); // startMock 不碰全局 env
  const clientA = await AppServerClient.spawn({ zcodePath: mockA.zcodePath, cwd: mockA.dir, env: mockA.env });
  const clientB = await AppServerClient.spawn({ zcodePath: mockB.zcodePath, cwd: mockB.dir, env: mockB.env });
  pids.push(clientA.pid, clientB.pid);
  try {
    // script.models 覆盖的是「推表后生成」的列表，未推表就是真机未配置形状，所以两边都先推表
    await pushRegistry(clientA, WORKSPACE);
    await pushRegistry(clientB, WORKSPACE);
    const stateA = await clientA.request('workspace/readState', {}, { timeoutMs: 2000 });
    const stateB = await clientB.request('workspace/readState', {}, { timeoutMs: 2000 });
    assert.equal(stateA.settings.model.available[0].modelId, 'GLM-A');
    assert.equal(stateB.settings.model.available[0].modelId, 'GLM-B');
  } finally {
    await clientA.close({ timeoutMs: 2000 });
    await clientB.close({ timeoutMs: 2000 });
    await mockA.cleanup();
    await mockB.cleanup();
  }
});

test('models 覆盖时思考等级从各条目的 reasoning.levels 取', async () => {
  const models = [
    { modelId: 'GLM-9', label: 'GLM 9', reasoning: { enabled: true, levels: [{ value: 'high', label: 'high' }, { value: 'max', label: 'max' }], defaultLevel: 'high' } },
  ];
  await withMock({ models, registryRequired: false }, {}, async ({ client }) => {
    await pushRegistry(client, WORKSPACE); // models 覆盖的前提是推过表
    const state = await client.request('workspace/readState', {}, { timeoutMs: 2000 });
    assert.deepEqual(state.settings.thoughtLevel, {
      available: [
        { value: 'high', label: 'high' },
        { value: 'max', label: 'max' },
      ],
      current: 'high',
      defaultLevel: 'high',
      enabled: true,
    });
  });
});

test('未知方法 client.request 也会收到 -32601', async () => {
  await withMock({}, {}, async ({ client }) => {
    await assert.rejects(client.request('mock/nope', {}, { timeoutMs: 2000 }), (err) => {
      assert.equal(err.details.code, -32601);
      return true;
    });
  });
});

test('runtimePreferences 在 create 应答之后才到，带 sessionId 与 scope', async () => {
  const prefsSeen = [];
  await withMock(
    {},
    {
      onServerRequest: (req) => {
        if (req.method === 'session/requestRuntimePreferences') prefsSeen.push(req.params);
        return undefined;
      },
    },
    async ({ client }) => {
      await pushRegistry(client, WORKSPACE);
      const created = await client.request('session/create', { workspace: WORKSPACE, mode: 'build' }, { timeoutMs: 2000 });
      // verified.md「requestRuntimePreferences 时序」行：它在 create 应答之后才发。
      // 不断言「resolve 那一刻还没见过它」：两行若在同一个 stdout 数据块里到达，客户端会在
      // await 续跑之前同步处理完第二行，CI 慢机器上就是这样，那不是时序错
      assert.match(created.session.sessionId, /^sess_/);
      await waitFor(() => (prefsSeen.length >= 1 ? true : undefined)); // 随后一定到
      assert.match(prefsSeen[0].sessionId, /^sess_/);
      assert.equal(prefsSeen[0].scope, 'runtime-materialization');
    },
  );
});

test('registry 有空 models 的 provider 被拒 -32602', async () => {
  const bad = {
    providers: [{ providerId: 'p1', kind: 'anthropic', models: [] }],
    generatedAt: Date.now(),
    revision: 'deadbeef',
  };
  await withMock({ registryStrict: true }, {}, async ({ client }) => {
    await assert.rejects(
      client.request('workspace/updateProviderRegistry', { workspace: WORKSPACE, registry: bad }, { timeoutMs: 2000 }),
      (err) => {
        assert.equal(err.details.code, -32602);
        assert.match(err.message, /p1/);
        return true;
      },
    );
  });
});

test('question 透传 schema 和 toolCallId，能造 ExitPlanMode 形状', async () => {
  const seen = [];
  await withMock(
    {
      registryRequired: false,
      turns: [
        {
          question: {
            questions: [{ question: '计划如何？', header: 'Plan', options: [{ label: '继续' }] }],
            schema: { interaction: 'plan_approval' },
            toolCallId: 'plan_1',
          },
        },
      ],
    },
    {
      onServerRequest: (req) => {
        if (req.method === 'interaction/requestUserInput') seen.push(req.params);
        // requestUserInput 的合法应答形状（verified.md「审批」行）
        return { action: 'accept', content: { answers: {} } };
      },
    },
    async ({ client }) => {
      await client.request('session/create', { workspace: WORKSPACE, mode: 'build' }, { timeoutMs: 2000 });
      await client.request('session/send', { sessionId: 'whatever' }, { timeoutMs: 2000 });
      await waitFor(() => (seen.length >= 1 ? true : undefined), { timeoutMs: 3000 });
      assert.equal(seen[0].schema.interaction, 'plan_approval');
      assert.equal(seen[0].toolCallId, 'plan_1');
      assert.equal(seen[0].questions.length, 1);
    },
  );
});

test('应答形状不对时 mock 在 stderr 警告一行', async () => {
  await withMock(
    {
      registryRequired: false,
      turns: [{ permission: { toolName: 'Bash', input: { command: 'ls' }, reason: 'test' } }],
    },
    {
      // 故意回错形状：permission 应答该是 {decision}，这里给 {action}
      onServerRequest: (req) => (req.method === 'interaction/requestPermission' ? { action: 'allow' } : undefined),
    },
    async ({ client, stderrLines }) => {
      await client.request('session/create', { workspace: WORKSPACE, mode: 'build' }, { timeoutMs: 2000 });
      await client.request('session/send', { sessionId: 'whatever' }, { timeoutMs: 2000 });
      await waitFor(() => (stderrLines.some((l) => l.includes('应答形状不对')) ? true : undefined));
      assert.ok(stderrLines.some((l) => l.includes('interaction/requestPermission')));
    },
  );
});

test('挂起期间信封 id 只保留最近 5 个，应答只回 5 条', async () => {
  let calls = 0;
  const notifications = [];
  await withMock(
    { resendIntervalMs: 50 },
    {
      // 处理器拖 500ms：期间 mock 每 50ms 重发一次，出结果前约有 10 个信封
      onServerRequest: async (req) => {
        if (req.method === 'session/requestRuntimePreferences') {
          calls += 1;
          await sleep(500);
        }
        return undefined; // 交回客户端的内置默认应答
      },
      onNotification: (n) => notifications.push(n),
    },
    async ({ client, recordPath }) => {
      await pushRegistry(client, WORKSPACE);
      await client.request(
        'session/create',
        { workspace: WORKSPACE, mode: 'build', persistence: 'immediate', titleGenerationEnabled: false },
        { timeoutMs: 5000 },
      );
      const answers = await waitFor(() => {
        const list = readRecord(recordPath).filter(isResponse);
        return list.length >= 5 ? list : undefined;
      }, { timeoutMs: 3000 });
      await sleep(100); // 等可能还在路上的应答都落进记录
      assert.equal(calls, 1); // 处理器仍只跑一次
      // T1.1b 第 12 条：RULES §7 例外——10 个信封只回最近 5 个
      assert.equal(readRecord(recordPath).filter(isResponse).length, 5);
      assert.ok(answers.every((m) => JSON.stringify(m.result) === JSON.stringify({
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false,
      })));
    },
  );
});
