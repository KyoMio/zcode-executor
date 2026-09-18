// lib/errors.mjs 与 lib/appserver.mjs 的行为测试。
// 纯函数用例（classify / findZcode / builtinProviderConfigPath / ExecutorError）直接喂输入；
// 客户端用例一律对 test/mock-appserver.mjs 跑（T0.3），不 spawn 真 zcode，不花额度。
// mock 复刻的是 3.12.2（PLAN-3.12.md）：provider 表来自 startMock 写的个人文件，create 带 model，
// 每个回合与 generateText 前先来一次 interaction/requestProviderRuntimeHeaders。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';
import path from 'node:path';
import { ExecutorError } from '../lib/errors.mjs';
import { findZcode, classify, builtinProviderConfigPath, probeHandshake, AppServerClient } from '../lib/appserver.mjs';
import { buildPersonalProviderConfig } from '../lib/providers.mjs';
import { startMock, waitFor, readRecord, killAll } from './helpers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// after() 兜底：清僵尸进程与临时目录（RULES §9）
const pids = [];
const mockDirs = [];
test.after(async () => {
  killAll(pids);
  for (const dir of mockDirs) await rm(dir, { recursive: true, force: true });
});

// 起 mock + 客户端的公共壳：collect 通知与 stderr，登记 pid，finally 收场。
// providerAuth 缺省答 startMock 的 apiKey（opts.providerAuth 显式传 null 表示不给 key）。
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
      providerAuth: opts.providerAuth === undefined ? () => mock.apiKey : opts.providerAuth ?? undefined,
      onServerRequest: opts.onServerRequest,
      onNotification: (n) => notifications.push(n),
      onStderr: (line) => stderrLines.push(line),
    });
    pids.push(client.pid);
    return await fn({ client, notifications, stderrLines, recordPath: mock.recordPath, mock });
  } finally {
    if (client) await client.close({ timeoutMs: 2000 }).catch(() => {});
    await mock.cleanup();
  }
}

const WORKSPACE = { workspacePath: '/tmp/probe-ws', workspaceKey: '/tmp/probe-ws' };
// startMock 默认个人文件里的模型（providerId 固定 zcode-executor）
const FLASH = { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } };
const createParams = (extra = {}) => ({ workspace: WORKSPACE, mode: 'build', titleGenerationEnabled: false, ...extra });
const create = (client, extra) => client.request('session/create', createParams(extra), { timeoutMs: 2000 });

const isResponse = (m) => m.id !== undefined && m.method === undefined;
const HEADERS_METHOD = 'interaction/requestProviderRuntimeHeaders';

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

test('builtinProviderConfigPath：按 App 目录布局从 zcode.cjs 推出 ../config/provider/zcode-builtin.json', async () => {
  // 复刻 <App>/Contents/Resources/{glm/zcode.cjs, config/provider/zcode-builtin.json}（PLAN-3.12.md 二节第 1 条）
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-executor-test-'));
  mockDirs.push(dir);
  await mkdir(path.join(dir, 'glm'), { recursive: true });
  await mkdir(path.join(dir, 'config', 'provider'), { recursive: true });
  const zcode = path.join(dir, 'glm', 'zcode.cjs');
  await writeFile(zcode, '// fake\n');
  const builtin = path.join(dir, 'config', 'provider', 'zcode-builtin.json');
  // 文件还没有：3.12 之前的 App 就是这样，抛错且信息说明版本门槛与环境变量出路
  assert.throws(() => builtinProviderConfigPath(zcode), (err) => {
    assert.ok(err instanceof ExecutorError);
    assert.match(err.message, /3\.12/);
    assert.match(err.message, /ZCODE_BUILTIN_PROVIDER_CONFIG_FILE/);
    assert.equal(err.details.file, builtin);
    return true;
  });
  await writeFile(builtin, '{}');
  assert.equal(builtinProviderConfigPath(zcode), builtin);
});

test('spawn：没有个人 provider 文件（参数与环境都没有）→ 抛 ExecutorError，不拉进程', async () => {
  const mock = await startMock({});
  mockDirs.push(mock.dir);
  const env = { ...mock.env };
  delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  assert.equal(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, undefined); // 本测试进程里没有它
  try {
    await assert.rejects(AppServerClient.spawn({ zcodePath: mock.zcodePath, cwd: mock.dir, env }), (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.match(err.message, /个人 provider 文件/);
      assert.match(err.message, /ZCODE_PERSONAL_PROVIDER_CONFIG_FILE/);
      return true;
    });
  } finally {
    await mock.cleanup();
  }
});

test('spawn：内置 provider 文件的环境变量指向不存在的文件 → 拉起前就抛 ExecutorError（不起子进程）', async () => {
  const mock = await startMock({});
  mockDirs.push(mock.dir);
  const env = { ...mock.env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: '/nonexistent/zcode-builtin.json' };
  try {
    await assert.rejects(
      AppServerClient.spawn({ zcodePath: mock.zcodePath, cwd: mock.dir, env }),
      (err) => err instanceof ExecutorError && /ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向的文件不存在/.test(err.message),
    );
    assert.deepEqual(readRecord(mock.recordPath), []); // 没起 mock，记录为空
  } finally {
    await mock.cleanup();
  }
});

test('mock：缺内置 provider 文件的环境变量时打「无法定位」原文并退出码 1（层 1 的复刻，直接拉 mock）', async () => {
  const mock = await startMock({});
  mockDirs.push(mock.dir);
  const { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: _dropped, ...env } = mock.env;
  const proc = spawn(process.execPath, [mock.zcodePath, 'app-server', '--stdio'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  pids.push(proc.pid);
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const [code, signal] = await once(proc, 'exit');
    assert.deepEqual({ code, signal }, { code: 1, signal: null });
    assert.match(stderr, /无法定位 CLI ZCode Built-in Provider Config/);
  } finally {
    proc.stdin.end();
    await mock.cleanup();
  }
});

test('spawn：显式 personalProviderFile 压过 env 里的（模型表按显式那份）', async () => {
  const mock = await startMock({});
  mockDirs.push(mock.dir);
  const other = path.join(mock.dir, 'other-provider.json');
  await writeFile(
    other,
    JSON.stringify(
      buildPersonalProviderConfig({
        providerId: 'x',
        apiFormat: 'anthropic-messages',
        baseURL: 'https://x.invalid',
        apiKey: { source: 'inline', value: 'mock-api-key-other' },
        models: [{ modelId: 'GLM-OTHER' }],
      }),
    ),
  );
  const client = await AppServerClient.spawn({ zcodePath: mock.zcodePath, cwd: mock.dir, env: mock.env, personalProviderFile: other });
  pids.push(client.pid);
  try {
    const created = await create(client, { model: { providerId: 'zcode-executor', modelId: 'GLM-OTHER', options: { reasoningLevel: 'high' } } });
    assert.deepEqual(created.settings.model.available.map((m) => m.ref.modelId), ['GLM-OTHER']);
    await assert.rejects(create(client, { model: FLASH }), (err) => err.details.code === -32603); // env 那份的模型不在表里
  } finally {
    await client.close({ timeoutMs: 2000 });
    await mock.cleanup();
  }
});

test('create → runtimePreferences：处理器只跑一次，每个信封都拿到同一默认应答', async () => {
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
      const created = await create(client, { persistence: 'immediate', thoughtLevel: 'high', model: FLASH });
      assert.match(created.session.sessionId, /^sess_/);
      assert.equal(created.settings.thoughtLevel.current, 'high'); // 顶层 thoughtLevel 回显
      // 真机 3.12.2（2026-09-18）：model.current 回显 ref，options.reasoningLevel 跟顶层 thoughtLevel
      assert.deepEqual(created.settings.model.current, { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } });
      assert.deepEqual(created.session.model, { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash' });
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

test('create 带老字段 runtimeModel → -32602 Unrecognized key（层 3 原文）', async () => {
  await withMock({}, {}, async ({ client }) => {
    await assert.rejects(create(client, { runtimeModel: { model: FLASH } }), (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.equal(err.details.code, -32602);
      assert.match(err.message, /Invalid params — \(root\): Unrecognized key: "runtimeModel"/);
      return true;
    });
  });
});

test('create 的 model 不在表里 → -32603 Provider Registry 中不存在 Model', async () => {
  await withMock({}, {}, async ({ client }) => {
    await assert.rejects(create(client, { model: { providerId: 'zcode-executor', modelId: 'GLM-9', options: { reasoningLevel: 'high' } } }), (err) => {
      assert.equal(err.details.code, -32603);
      assert.match(err.message, /Provider Registry 中不存在 Model: zcode-executor\/GLM-9/);
      assert.equal(err.details.data.name, 'ModelProtocolError');
      return true;
    });
    // providerId 不对同样是这句（真机 2026-09-18）
    await assert.rejects(create(client, { model: { providerId: 'nope', modelId: 'GLM-5.3', options: { reasoningLevel: 'high' } } }), (err) => {
      assert.match(err.message, /Provider Registry 中不存在 Model: nope\/GLM-5\.3/);
      return true;
    });
  });
});

test('create 的 model 缺 options.reasoningLevel → -32603 Reasoning level is required', async () => {
  await withMock({}, {}, async ({ client }) => {
    await assert.rejects(create(client, { model: { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash' } }), (err) => {
      assert.equal(err.details.code, -32603);
      assert.match(err.message, /Reasoning level is required for zcode-executor\/GLM-5\.3-Flash/);
      return true;
    });
  });
});

test('create 不带 model → 用表里第一个模型，档位取顶层 thoughtLevel 或默认 max（真机 2026-09-18）', async () => {
  await withMock({}, {}, async ({ client }) => {
    const withLevel = await create(client, { thoughtLevel: 'low' });
    assert.deepEqual(withLevel.settings.model.current, { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } });
    assert.equal(withLevel.settings.thoughtLevel.current, 'low');
    const bare = await create(client);
    assert.deepEqual(bare.settings.model.current, { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'max' } });
    assert.equal(bare.settings.thoughtLevel.current, 'max');
  });
});

test('create 只在 model.options 里给档位、不给顶层 thoughtLevel → current 不带 options，thoughtLevel.current 缺失（真机 2026-09-18）', async () => {
  await withMock({}, {}, async ({ client }) => {
    const created = await create(client, { model: { providerId: 'zcode-executor', modelId: 'GLM-5.3', options: { reasoningLevel: 'max' } } });
    assert.deepEqual(created.settings.model.current, { providerId: 'zcode-executor', modelId: 'GLM-5.3' });
    assert.equal('current' in created.settings.thoughtLevel, false);
    assert.equal(created.settings.thoughtLevel.enabled, true);
  });
});

test('个人文件缺失 → 模型表为空，create 带 model 被拒，不带 model 建出来的 current 缺失', async () => {
  const mock = await startMock({});
  mockDirs.push(mock.dir);
  const env = { ...mock.env, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: '/nonexistent/provider.json' };
  const client = await AppServerClient.spawn({ zcodePath: mock.zcodePath, cwd: mock.dir, env });
  pids.push(client.pid);
  try {
    await assert.rejects(create(client, { model: FLASH }), (err) => err.details.code === -32603);
    const bare = await create(client);
    assert.deepEqual(bare.settings.model.available, []);
    assert.equal('current' in bare.settings.model, false);
    assert.equal(bare.settings.thoughtLevel.enabled, false);
  } finally {
    await client.close({ timeoutMs: 2000 });
    await mock.cleanup();
  }
});

test('被删的 workspace/updateProviderRegistry 与 workspace/readState → -32601 Method not found（层 2 原文）', async () => {
  await withMock({}, {}, async ({ client }) => {
    for (const method of ['workspace/updateProviderRegistry', 'workspace/readState']) {
      await assert.rejects(client.request(method, { workspace: WORKSPACE }, { timeoutMs: 2000 }), (err) => {
        assert.equal(err.details.code, -32601);
        assert.match(err.message, new RegExp(`Method not found: ${method.replace('/', '\\/')}`));
        return true;
      });
    }
  });
});

test('剧本让方法挂住 → 请求超时，信息里有方法名', async () => {
  await withMock({ hangMethods: ['session/list'] }, {}, async ({ client }) => {
    const startedAt = Date.now();
    await assert.rejects(client.request('session/list', {}, { timeoutMs: 200 }), (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.match(err.message, /超时/);
      assert.match(err.message, /session\/list/);
      return true;
    });
    assert.ok(Date.now() - startedAt < 2000); // 按超时算，不等默认 30s
  });
});

test('exitAfter 让子进程崩：挂着的请求全部 reject，exited code 3', async () => {
  await withMock({ exitAfter: 'session/subscribe' }, {}, async ({ client }) => {
    const answered = client.request('session/subscribe', { sessionId: 'sess_x', deliveryKind: 'desktop-continuous' }, { timeoutMs: 3000 });
    const pending = client.request('session/list', {}, { timeoutMs: 3000 });
    assert.deepEqual(await answered, { eventSeq: 0, snapshot: {} }); // exitAfter 的方法本身有应答
    await assert.rejects(pending, (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.match(err.message, /退出/);
      assert.equal(err.details.method, 'session/list');
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
      const created = await create(client, { model: FLASH });
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
    const created = await create(client, { model: FLASH });
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

test('create 的 settings.model.available 按个人文件生成：每模型一条，档位 low/high/max、默认 max（真机 2026-09-18）', async () => {
  await withMock({}, {}, async ({ client }) => {
    const { settings } = await create(client, { model: FLASH, thoughtLevel: 'high' });
    assert.deepEqual(
      settings.model.available.map((m) => m.ref),
      [
        { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash' },
        { providerId: 'zcode-executor', modelId: 'GLM-5.3' },
      ],
    );
    const first = settings.model.available[0];
    assert.equal(first.label, 'GLM-5.3-Flash');
    assert.equal(first.providerLabel, 'zcode-executor');
    assert.deepEqual(first.reasoning.levels.map((l) => l.value), ['low', 'high', 'max']);
    assert.equal(first.reasoning.defaultLevel, 'max');
    // 3.12.2 的 thoughtLevel 只有这三个键（没有 3.11 的 defaultLevel）
    assert.deepEqual(settings.thoughtLevel, {
      available: [
        { value: 'low', label: 'low' },
        { value: 'high', label: 'high' },
        { value: 'max', label: 'max' },
      ],
      current: 'high',
      enabled: true,
    });
  });
});

test('probeHandshake：create(deferred) + close，返回 settings；list 里不留会话，记录里无 send', async () => {
  const mock = await startMock({});
  mockDirs.push(mock.dir);
  try {
    const settings = await probeHandshake({
      zcodePath: mock.zcodePath,
      env: mock.env,
      cwd: mock.dir,
      personalProviderFile: mock.personalProviderFile,
      providerAuth: () => mock.apiKey,
      model: FLASH,
      thoughtLevel: 'high',
    });
    assert.deepEqual(settings.model.current, { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } });
    assert.equal(settings.model.available.length, 2);
    const record = readRecord(mock.recordPath);
    const methods = record.filter((m) => m.method !== undefined).map((m) => m.method);
    assert.deepEqual(methods, ['session/create', 'session/close']);
    assert.equal(record.find((m) => m.method === 'session/create').params.persistence, 'deferred');
  } finally {
    await mock.cleanup();
  }
});

test('deferred 建的会话 session/list 不列（真机 2026-09-18）', async () => {
  await withMock({}, {}, async ({ client }) => {
    const deferred = await create(client, { model: FLASH, persistence: 'deferred' });
    const listed = await create(client, { model: FLASH, persistence: 'immediate' });
    const list = await client.request('session/list', { workspace: WORKSPACE }, { timeoutMs: 2000 });
    assert.deepEqual(list.sessions.map((s) => s.sessionId), [listed.session.sessionId]);
    assert.deepEqual(await client.request('session/close', { sessionId: deferred.session.sessionId }, { timeoutMs: 2000 }), { closed: true });
  });
});

test('session/send 回合：turn.started 之后先来 requestProviderRuntimeHeaders，内置应答带 key，记录里抹成 [REDACTED]', async () => {
  const seen = [];
  await withMock(
    { turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'x' } }] }] },
    {
      onServerRequest: (req) => {
        if (req.method === HEADERS_METHOD) seen.push(req.params);
        return undefined; // 交给客户端内置应答
      },
    },
    async ({ client, notifications, recordPath, mock }) => {
      const created = await create(client, { model: FLASH });
      const sessionId = created.session.sessionId;
      await client.request('session/subscribe', { sessionId, deliveryKind: 'desktop-continuous' }, { timeoutMs: 2000 });
      await client.request('session/send', { sessionId, content: 'hi' }, { timeoutMs: 2000 });
      await waitFor(() => (notifications.some((n) => n.params?.type === 'turn.completed') ? true : undefined));
      assert.equal(seen.length, 1);
      // PLAN-3.12.md 一节层 5：params 形状
      assert.match(seen[0].requestId, new RegExp(`^${sessionId}:provider-runtime-headers:`));
      assert.equal(seen[0].sessionId, sessionId);
      assert.deepEqual(seen[0].modelSelection, { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash' });
      assert.equal(seen[0].providerId, 'zcode-executor');
      assert.equal(seen[0].reason, 'model-request');
      assert.deepEqual(seen[0].workspace, WORKSPACE);
      // 回合照常跑完
      const types = notifications.filter((n) => n.method === 'session/event').map((n) => n.params.type);
      assert.deepEqual(types, ['turn.started', 'model.streaming', 'turn.completed']);
      // 记录里的应答：headersApplied true，apiKey 已抹
      const answers = readRecord(recordPath).filter((m) => isResponse(m) && m.result?.headersApplied !== undefined);
      assert.equal(answers.length, 1);
      assert.deepEqual(answers[0].result, { headersApplied: true, requestAuth: { apiKey: '[REDACTED]' } });
      assert.equal(JSON.stringify(readRecord(recordPath)).includes(mock.apiKey), false);
    },
  );
});

test('providerAuth 没给 key → 应答 headersApplied:false 并打一行 stderr，回合 turn.failed 的 message 是应答里的 errorMessage', async () => {
  await withMock(
    { turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: '不该到' } }] }] },
    { providerAuth: null },
    async ({ client, notifications, recordPath, stderrLines }) => {
      const created = await create(client, { model: FLASH });
      const sessionId = created.session.sessionId;
      await client.request('session/send', { sessionId, content: 'hi' }, { timeoutMs: 2000 });
      await waitFor(() => (notifications.some((n) => n.params?.type === 'turn.failed') ? true : undefined));
      const types = notifications.filter((n) => n.method === 'session/event').map((n) => n.params.type);
      assert.deepEqual(types, ['turn.started', 'turn.failed']);
      const failed = notifications.find((n) => n.params?.type === 'turn.failed');
      const answer = readRecord(recordPath).find((m) => isResponse(m) && m.result?.headersApplied !== undefined);
      assert.deepEqual(answer.result, { headersApplied: false, errorMessage: 'zcode-executor 没有 provider zcode-executor 的 API key，模型请求发不出去' });
      // zcode.cjs：失败信息取应答里的 errorMessage，没给才是那句固定原文
      assert.equal(failed.params.payload.error.message, answer.result.errorMessage);
      assert.ok(stderrLines.some((l) => l.includes('appserver: 没有 provider zcode-executor 的 API key')));
    },
  );
});

test('generateText：带老字段 modelRef / 缺 selection / 模型不在表里，各按真机原文拒（层 4）', async () => {
  await withMock({}, {}, async ({ client }) => {
    const base = { workspace: WORKSPACE, messages: [{ role: 'user', content: 'x' }], querySource: 'zcode-executor.review', maxOutputTokens: 1, operationId: 'review_x' };
    await assert.rejects(client.request('workspace/generateText', { ...base, modelRef: FLASH }, { timeoutMs: 2000 }), (err) => {
      assert.equal(err.details.code, -32602);
      assert.match(err.message, /selection: Invalid input: expected object, received undefined; \(root\): Unrecognized key: "modelRef"/);
      return true;
    });
    await assert.rejects(client.request('workspace/generateText', base, { timeoutMs: 2000 }), (err) => {
      assert.equal(err.details.code, -32602);
      assert.match(err.message, /selection: Invalid input: expected object, received undefined$/);
      return true;
    });
    await assert.rejects(
      client.request('workspace/generateText', { ...base, selection: { providerId: 'zcode-executor', modelId: 'NOPE', options: { reasoningLevel: 'high' } } }, { timeoutMs: 2000 }),
      (err) => {
        assert.equal(err.details.code, -32603);
        assert.match(err.message, /Provider Registry 中不存在 Model: zcode-executor\/NOPE/);
        return true;
      },
    );
  });
});

test('generateText：应答前先来 requestProviderRuntimeHeaders（无 sessionId，requestId 以 workspace: 开头），结果回显 selection', async () => {
  const seen = [];
  await withMock(
    { generateText: { replies: ['Y'] } },
    {
      onServerRequest: (req) => {
        if (req.method === HEADERS_METHOD) seen.push(req.params);
        return undefined;
      },
    },
    async ({ client }) => {
      const result = await client.request(
        'workspace/generateText',
        { workspace: WORKSPACE, selection: FLASH, messages: [{ role: 'user', content: 'x' }], querySource: 'zcode-executor.review', maxOutputTokens: 1, operationId: 'review_x' },
        { timeoutMs: 2000 },
      );
      assert.equal(result.text, 'Y');
      assert.deepEqual(result.selection, FLASH);
      assert.equal(seen.length, 1);
      assert.match(seen[0].requestId, /^workspace:provider-runtime-headers:/);
      assert.equal('sessionId' in seen[0], false);
      assert.deepEqual(seen[0].modelSelection, { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash' });
      assert.equal(seen[0].reason, 'model-request');
    },
  );
});

test('generateText：头没应用上 → -32031，message 取应答的 errorMessage，没给才是固定原文', async () => {
  await withMock({}, { providerAuth: null }, async ({ client }) => {
    await assert.rejects(
      client.request(
        'workspace/generateText',
        { workspace: WORKSPACE, selection: FLASH, messages: [{ role: 'user', content: 'x' }], querySource: 'zcode-executor.review', maxOutputTokens: 1, operationId: 'review_x' },
        { timeoutMs: 2000 },
      ),
      (err) => {
        assert.equal(err.details.code, -32031);
        assert.match(err.message, /没有 provider zcode-executor 的 API key/);
        return true;
      },
    );
  });
  // 处理器自己答 headersApplied:false 不带 errorMessage → 固定原文
  await withMock({}, { onServerRequest: (req) => (req.method === HEADERS_METHOD ? { headersApplied: false } : undefined) }, async ({ client }) => {
    await assert.rejects(
      client.request(
        'workspace/generateText',
        { workspace: WORKSPACE, selection: FLASH, messages: [{ role: 'user', content: 'x' }], querySource: 'zcode-executor.review', maxOutputTokens: 1, operationId: 'review_x' },
        { timeoutMs: 2000 },
      ),
      (err) => {
        assert.equal(err.details.code, -32031);
        assert.match(err.message, /Provider runtime headers were not applied before model request attempt\./);
        return true;
      },
    );
  });
});

test('providerAuth 答出去的 key 自动进 stderr 抹除名单', async () => {
  await withMock(
    { turns: [{ permission: { toolName: 'Bash', input: { command: 'ls' }, reason: 'test' } }] },
    {
      // 审批应答的 reason 里故意塞 key：mock 会把整个应答打到 stderr（permission answered: …），
      // 走一遍子进程 stderr → 客户端转发这条路，验的是转发前按 secrets 抹掉
      onServerRequest: () => undefined,
    },
    async ({ client, notifications, stderrLines, mock }) => {
      client.setHandlers({
        onServerRequest: (req) => (req.method === 'interaction/requestPermission' ? { decision: 'allow', reason: mock.apiKey } : undefined),
        onNotification: (n) => notifications.push(n),
      });
      const created = await create(client, { model: FLASH });
      await client.request('session/send', { sessionId: created.session.sessionId, content: 'hi' }, { timeoutMs: 2000 });
      await waitFor(() => (notifications.some((n) => n.params?.type === 'turn.completed') ? true : undefined));
      const forwarded = stderrLines.filter((l) => l.includes('permission answered'));
      assert.equal(forwarded.length, 1);
      assert.ok(forwarded[0].includes('<redacted>'));
      assert.equal(stderrLines.some((l) => l.includes(mock.apiKey)), false);
    },
  );
});

test('反向请求应答后停止重发，记录里应答条数不再增长', async () => {
  await withMock({ resendIntervalMs: 50 }, {}, async ({ client, recordPath, stderrLines }) => {
    await create(client, { model: FLASH });
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
  const modelA = [{ ref: { providerId: 'zcode-executor', modelId: 'GLM-A' }, reasoning: { levels: [{ value: 'high', label: 'high' }], defaultLevel: 'high' } }];
  const modelB = [{ ref: { providerId: 'zcode-executor', modelId: 'GLM-B' }, reasoning: { levels: [{ value: 'low', label: 'low' }], defaultLevel: 'low' } }];
  const mockA = await startMock({ script: { models: modelA } });
  const mockB = await startMock({ script: { models: modelB } });
  mockDirs.push(mockA.dir, mockB.dir);
  assert.equal(process.env.MOCK_APPSERVER_SCRIPT, undefined); // startMock 不碰全局 env
  const clientA = await AppServerClient.spawn({ zcodePath: mockA.zcodePath, cwd: mockA.dir, env: mockA.env });
  const clientB = await AppServerClient.spawn({ zcodePath: mockB.zcodePath, cwd: mockB.dir, env: mockB.env });
  pids.push(clientA.pid, clientB.pid);
  try {
    const stateA = await create(clientA);
    const stateB = await create(clientB);
    assert.equal(stateA.settings.model.available[0].ref.modelId, 'GLM-A');
    assert.equal(stateB.settings.model.available[0].ref.modelId, 'GLM-B');
  } finally {
    await clientA.close({ timeoutMs: 2000 });
    await clientB.close({ timeoutMs: 2000 });
    await mockA.cleanup();
    await mockB.cleanup();
  }
});

test('models 覆盖时思考等级从各条目的 reasoning.levels 取，create 的模型存在性也按它查', async () => {
  const models = [
    { ref: { providerId: 'zcode-executor', modelId: 'GLM-9' }, label: 'GLM 9', reasoning: { levels: [{ value: 'high', label: 'high' }, { value: 'max', label: 'max' }], defaultLevel: 'high' } },
  ];
  await withMock({ models }, {}, async ({ client }) => {
    const state = await create(client);
    assert.deepEqual(state.settings.thoughtLevel, {
      available: [
        { value: 'high', label: 'high' },
        { value: 'max', label: 'max' },
      ],
      current: 'high',
      enabled: true,
    });
    await assert.rejects(create(client, { model: FLASH }), (err) => err.details.code === -32603); // 个人文件那份被覆盖掉了
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
      const created = await create(client, { model: FLASH });
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

test('question 透传 schema 和 toolCallId，能造 ExitPlanMode 形状', async () => {
  const seen = [];
  await withMock(
    {
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
        if (req.method !== 'interaction/requestUserInput') return undefined; // 头请求等走内置应答
        seen.push(req.params);
        // requestUserInput 的合法应答形状（verified.md「审批」行）
        return { action: 'accept', content: { answers: {} } };
      },
    },
    async ({ client }) => {
      await create(client, { model: FLASH });
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
      turns: [{ permission: { toolName: 'Bash', input: { command: 'ls' }, reason: 'test' } }],
    },
    {
      // 故意回错形状：permission 应答该是 {decision}，这里给 {action}
      onServerRequest: (req) => (req.method === 'interaction/requestPermission' ? { action: 'allow' } : undefined),
    },
    async ({ client, stderrLines }) => {
      await create(client, { model: FLASH });
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
      await client.request('session/create', createParams({ persistence: 'immediate', model: FLASH }), { timeoutMs: 5000 });
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
