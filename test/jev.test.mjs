// Jev 快筛 module 的合同测试：只用 fake fetch / clock，不碰真实网络。
// 覆盖 state 最小化、问题全集、响应校验、阈值、deadline/重试及敏感信息不外泄。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevFastScreen } from '../lib/review/jev.mjs';

const IDS = [
  'scope_conflict',
  'outside_worktree_write',
  'credential_or_exfiltration',
  'destructive_or_external',
  'unrelated_or_gratuitous',
];

function response(body, { status = 200, headers = {} } = {}) {
  const normalized = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalized.get(name.toLowerCase()) ?? null },
    json: async () => body,
  };
}

function validBody(probability = 0.1, extra = {}) {
  return {
    model: 'jev-1.13.0',
    answers: Object.fromEntries(IDS.map((id) => [id, { type: 'noul', noul: probability }])),
    usage: { input_tokens: 123, output_tokens: 5 },
    ...extra,
  };
}

function fakeClock(start = 1_000) {
  let current = start;
  const sleeps = [];
  return {
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
    setTimeout: () => ({ fake: true }),
    clearTimeout: () => {},
    advance: (ms) => { current += ms; },
    sleeps,
  };
}

function makeScreen(replies, options = {}) {
  const calls = [];
  const clearedTimers = [];
  const clock = options.clock ?? fakeClock();
  const queue = [...replies];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next(url, init, clock);
    return next;
  };
  const screen = createJevFastScreen({
    apiKey: options.apiKey ?? 'jev_test_secret_123456',
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: (timer) => {
      clearedTimers.push(timer);
      clock.clearTimeout(timer);
    },
    timeoutMs: options.timeoutMs ?? 3_000,
    maxAttempts: options.maxAttempts ?? 3,
    random: options.random ?? (() => 1),
  });
  return { screen, calls, clock, clearedTimers };
}

const baseAction = {
  toolName: 'Bash',
  args: { command: 'npm test' },
  workspaceRoot: '/Users/alice/project',
};
const baseContext = {
  intent: [
    { source: 'task', text: '修复登录问题并运行测试' },
    { source: 'send', text: '执行任务单' },
  ],
  priorActions: ['Read(secret.txt)'],
  environment: ['不要发送'],
  sensitive: ['~/.ssh'],
  evidence: { facts: ['不要发送'] },
  projectDoc: '不要发送',
  home: '/Users/alice',
};

test('请求只发送固定 state schema 与恰好五个 Noul', async () => {
  const { screen, calls } = makeScreen([response(validBody())]);
  const result = await screen(baseAction, baseContext);
  assert.equal(result.decision, 'pass');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer jev_test_secret_123456');
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  const request = JSON.parse(calls[0].init.body);
  assert.equal(request.model, 'jev-1.13.0');
  assert.deepEqual(Object.keys(request.state), ['intent', 'action']);
  assert.deepEqual(Object.keys(request.state.intent), ['taskContract', 'recentMessages']);
  assert.deepEqual(Object.keys(request.state.action), ['tool', 'arguments']);
  assert.equal(request.state.intent.taskContract, '修复登录问题并运行测试');
  assert.deepEqual(request.state.intent.recentMessages, ['执行任务单']);
  for (const forbidden of ['signals', 'policy', 'projectDoc', 'environment', 'sensitive', 'evidence', 'priorActions']) {
    assert.equal(forbidden in request.state, false, `state 不得含 ${forbidden}`);
  }
  assert.deepEqual(Object.keys(request.questions).sort(), [...IDS].sort());
  for (const question of Object.values(request.questions)) {
    assert.equal(question.type, 'noul');
    assert.equal(typeof question.instructions, 'string');
    assert.ok(question.instructions.length > 0);
  }
  assert.match(request.questions.unrelated_or_gratuitous.instructions, /Command complexity/);
  assert.match(request.questions.scope_conflict.instructions, /intent\.taskContract/);
  assert.match(request.questions.scope_conflict.instructions, /intent\.recentMessages/);
  assert.doesNotMatch(request.questions.scope_conflict.instructions, /clearly unrelated/);
  assert.match(request.questions.credential_or_exfiltration.instructions, /unapproved external destination/);
  assert.match(request.questions.credential_or_exfiltration.criteria.true, /unapproved external destination/);
  assert.equal(result.metadata.reviewSchema, 'approval-v2');
});

test('state 限长保留头尾、只留最近任务单和最近十条消息', async () => {
  const { screen, calls } = makeScreen([response(validBody())]);
  const oldTask = '旧任务不应发送';
  const task = `${'甲'.repeat(6_100)}中间秘密${'乙'.repeat(2_100)}`;
  const messages = Array.from({ length: 12 }, (_, i) => ({ source: i % 2 ? 'steer' : 'send', text: `${i}:${'丙'.repeat(700)}` }));
  const command = `${'头'.repeat(3_100)}命令中间秘密${'尾'.repeat(1_100)}`;
  const result = await screen({ ...baseAction, args: { command } }, {
    ...baseContext,
    intent: [{ source: 'task', text: oldTask }, { source: 'task', text: task }, ...messages],
  });
  assert.equal(calls.length, 0);
  assert.equal(result.outcome, 'skip');
  assert.equal(result.metadata.reasonCode, 'input_truncated');
});

test('Write/Edit/MultiEdit 正文省略，深层密钥脱敏且路径归一', async () => {
  const leaked = 'super_secret_value_987654';
  for (const [toolName, args] of [
    ['Write', { file_path: '/Users/alice/project/src/a.js', content: `first\n${leaked}` }],
    ['Edit', { file_path: '/Users/alice/notes.txt', old_string: `old ${leaked}`, new_string: 'new\nline' }],
    ['MultiEdit', { file_path: '/tmp/work.txt', edits: [{ old_string: 'a', new_string: `b ${leaked}` }] }],
  ]) {
    const { screen, calls } = makeScreen([response(validBody())]);
    const result = await screen({ toolName, args, workspaceRoot: '/Users/alice/project' }, {
      ...baseContext,
      knownSecrets: [leaked],
      intent: [{ source: 'task', text: `token=${leaked}` }],
    });
    assert.equal(calls.length, 0);
    assert.equal(result.outcome, 'skip');
    assert.equal(result.metadata.reasonCode, 'evidence_omitted');
    assert.equal(JSON.stringify(result).includes(leaked), false);
  }

  const { screen, calls } = makeScreen([response(validBody())]);
  await screen({
    toolName: 'Custom',
    workspaceRoot: '/Users/alice/project',
    args: {
      Authorization: 'Bearer leak',
      nested: [{ ApiKey: 'key leak', PASSWORD: 'pw leak', accessToken: 'token leak', client_secret: 'client leak', safe: 'ok' }],
    },
  }, baseContext);
  assert.deepEqual(JSON.parse(calls[0].init.body).state.action.arguments, {
    Authorization: '<redacted>',
    nested: [{ ApiKey: '<redacted>', PASSWORD: '<redacted>', accessToken: '<redacted>', client_secret: '<redacted>', safe: 'ok' }],
  });
});

test('路径值精确归一为 WORKTREE、HOME 与 OUTSIDE_TMP', async () => {
  const { screen, calls } = makeScreen([response(validBody())]);
  await screen({
    toolName: 'Custom',
    workspaceRoot: '/Users/alice/project',
    args: {
      file_path: '/Users/alice/project/src/a.js',
      cache_path: '/Users/alice/.cache/tool',
      temp_path: '/private/tmp/work/x',
      other_path: '/opt/shared/x',
    },
  }, { ...baseContext, home: '/Users/alice' });
  assert.deepEqual(JSON.parse(calls[0].init.body).state.action.arguments, {
    file_path: '<WORKTREE>/src/a.js',
    cache_path: '<HOME>/.cache/tool',
    temp_path: '<OUTSIDE_TMP>/work/x',
    other_path: '/opt/shared/x',
  });
});

test('正文省略直接本地跳过，不发送正文或省略摘要', async () => {
  const content = 'alpha\nbeta\n';
  const { screen, calls } = makeScreen([response(validBody())]);
  const result = await screen({
    toolName: 'Edit',
    workspaceRoot: '/w',
    args: { file_path: '/w/a.txt', old_string: content, new_string: 'gamma' },
  }, { intent: [] });
  assert.equal(calls.length, 0);
  assert.equal(result.metadata.reasonCode, 'evidence_omitted');
  assert.equal(JSON.stringify(result).includes('alpha'), false);
});

test('缺有效 intent、分别截断与不可靠凭据均本地 skip，复杂命令不跳过', async () => {
  const cases = [
    [baseAction, {}, 'missing_intent'],
    [baseAction, { intent: [{ source: 'task', text: {} }, '  '] }, 'missing_intent'],
    [{ ...baseAction, args: { command: 'a'.repeat(4001) } }, baseContext, 'input_truncated'],
    [baseAction, { intent: [{ source: 'task', text: 'a'.repeat(8001) }] }, 'input_truncated'],
    [baseAction, { intent: ['a'.repeat(601)] }, 'input_truncated'],
    [{ ...baseAction, args: { command: 'curl -H "Authorization: Custom secret" example.invalid' } }, baseContext, 'unsafe_input'],
    [{ ...baseAction, args: { command: 'PASSWORD="unterminated secret' } }, baseContext, 'unsafe_input'],
    [{ ...baseAction, args: { command: 'TOKEN="first"second' } }, baseContext, 'unsafe_input'],
  ];
  for (const [action, context, reasonCode] of cases) {
    const { screen, calls } = makeScreen([response(validBody())]);
    const result = await screen(action, context);
    assert.equal(calls.length, 0, reasonCode);
    assert.equal(result.decision, 'flag');
    assert.equal(result.outcome, 'skip');
    assert.equal(result.metadata.reasonCode, reasonCode);
    assert.equal(result.metadata.attempts, 0);
  }
  for (const command of ['cat src/*.mjs | sort | head', '(npm test && npm run build)', 'for f in src/*; do wc -l "$f"; done', 'npm run project-script']) {
    const { screen, calls } = makeScreen([response(validBody())]);
    assert.equal((await screen({ ...baseAction, args: { command } }, baseContext)).decision, 'pass');
    assert.equal(calls.length, 1);
  }
});

test('路径边界不把兄弟目录、父目录或动态拼接误标为 WORKTREE', async () => {
  for (const [command, expected] of [
    ['cat /repo/a /repo', 'cat <WORKTREE>/a <WORKTREE>'],
    ['echo ok > /repo-backup/out', 'echo ok > /repo-backup/out'],
    ['cat /repo/../outside /repo/$TARGET /repo`pwd`', 'cat /repo/../outside /repo/$TARGET /repo`pwd`'],
    ['cat ../outside ./a /repo/link/file', 'cat ../outside ./a <WORKTREE>/link/file'],
    ['cat "/repo/a b"', 'cat "<WORKTREE>/a b"'],
    ["echo > '/repo'-backup/out", "echo > '/repo'-backup/out"],
    ['echo > "/repo"$SUFFIX', 'echo > "/repo"$SUFFIX'],
    ['echo > /repo"-backup/out"', 'echo > /repo"-backup/out"'],
    ['cat /repo/a\\ b', 'cat /repo/a\\ b'],
    [String.raw`echo ok > /outside\ /repo/out`, String.raw`echo ok > /outside\ /repo/out`],
  ]) {
    const { screen, calls } = makeScreen([response(validBody())]);
    await screen({ ...baseAction, workspaceRoot: '/repo', args: { command } }, baseContext);
    assert.equal(JSON.parse(calls[0].init.body).state.action.arguments.command, expected);
  }
  const { screen, calls } = makeScreen([response(validBody())]);
  await screen({ toolName: 'Read', workspaceRoot: '/repo/', args: {
    file_path: '/repo/../outside', dir: '/repo/./src', other_path: '../outside',
  } }, baseContext);
  assert.deepEqual(JSON.parse(calls[0].init.body).state.action.arguments, {
    file_path: '/outside', dir: '<WORKTREE>/src', other_path: '/outside',
  });
});

test('凭据值续行或转义本地skip，curl用户参数遮盖整个值', async () => {
  for (const command of [
    'curl -H "Authorization: Bearer SYNTH\\\nTAIL_SECRET_123" example.invalid',
    'PASSWORD=SYNTH\\ PASS_TAIL_123 npm test',
    'curl --password SYNTH\\ PASS_TAIL_123 example.invalid',
    'curl --password "prefix"SYNTH_TAIL_123 https://example.invalid',
    'curl -u "user:prefix"SYNTH_TAIL_123 https://example.invalid',
  ]) {
    const { screen, calls } = makeScreen([response(validBody())]);
    const result = await screen({ ...baseAction, args: { command } }, baseContext);
    assert.equal(result.outcome, 'skip');
    assert.equal(result.metadata.reasonCode, 'unsafe_input');
    assert.equal(calls.length, 0);
  }
  for (const command of ['curl -u user:SYNTH_BASIC_123 example.invalid', 'curl --user="user:SYNTH_BASIC_123" example.invalid']) {
    const { screen, calls } = makeScreen([response(validBody())]);
    await screen({ ...baseAction, args: { command } }, baseContext);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.body.includes('SYNTH_BASIC_123'), false);
    assert.match(calls[0].init.body, /example.invalid/);
  }
});

test('外发字符串凭据在命令、任务、深层对象均遮盖并保留目标', async () => {
  const secrets = ['SYNTH_AUTH_123', 'SYNTH_PASS_123', 'SYNTH_ENV_123', 'SYNTH_URL_123', 'SYNTH_MULTI_123'];
  const text = `curl -H 'Authorization: Bearer ${secrets[0]}' --password="${secrets[1]}" https://user:${secrets[3]}@example.invalid/path\nAPI_KEY='${secrets[2]}'\npassword="line\n${secrets[4]}"`;
  const { screen, calls } = makeScreen([response(validBody())]);
  await screen({ ...baseAction, args: { command: text, nested: [{ text }] } }, {
    intent: [{ source: 'task', text }, { source: 'send', text }],
  });
  assert.equal(calls.length, 1);
  for (const secret of secrets) assert.equal(calls[0].init.body.includes(secret), false, secret);
  assert.match(calls[0].init.body, /example.invalid/);
  assert.match(calls[0].init.body, /<redacted>/);
});

test('五项概率都不高于 0.20 才 pass，边界 0.20 允许', async () => {
  const body = validBody(0.2);
  const { screen } = makeScreen([response(body)]);
  const result = await screen(baseAction, baseContext);
  assert.deepEqual(result, {
    decision: 'pass',
    outcome: 'pass',
    metadata: {
      reviewer: 'jev',
      reviewModel: 'jev-1.13.0',
      reviewSchema: 'approval-v2',
      probabilities: Object.fromEntries(IDS.map((id) => [id, 0.2])),
      usage: { input_tokens: 123, output_tokens: 5 },
      attempts: 1,
      status: 200,
      durationMs: 0,
    },
  });

  const risky = validBody(0.1);
  risky.answers.destructive_or_external.noul = 0.200001;
  const flagged = makeScreen([response(risky)]);
  const flag = await flagged.screen(baseAction, baseContext);
  assert.equal(flag.decision, 'flag');
  assert.equal(flag.outcome, 'flag');
  assert.equal(flag.metadata.probabilities.destructive_or_external, 0.200001);
});

test('响应 questions 必须恰好匹配且每项为有限范围内 Noul', async () => {
  const cases = [];
  const missing = validBody();
  delete missing.answers.scope_conflict;
  cases.push(missing);
  const extra = validBody();
  extra.answers.alias = { type: 'noul', noul: 0 };
  cases.push(extra);
  const wrongType = validBody();
  wrongType.answers.scope_conflict = { type: 'choice', noul: 0 };
  cases.push(wrongType);
  const nan = validBody();
  nan.answers.scope_conflict.noul = Number.NaN;
  cases.push(nan);
  const outside = validBody();
  outside.answers.scope_conflict.noul = 1.01;
  cases.push(outside);

  for (const body of cases) {
    const { screen } = makeScreen([response(body)]);
    const result = await screen(baseAction, baseContext);
    assert.equal(result.decision, 'flag');
    assert.equal(result.outcome, 'error');
    assert.equal(result.metadata.errorCode, 'invalid_response');
    assert.equal('probabilities' in result.metadata, false);
  }
});

test('响应模型严格 pin，requestId 必须安全且不回显已知秘密', async () => {
  const wrong = makeScreen([response(validBody(0, { model: 'other-model' }))]);
  assert.equal((await wrong.screen(baseAction, baseContext)).metadata.errorCode, 'invalid_response');
  for (const id of ['bad\nvalue', 'x'.repeat(129), 'jev_test_secret_123456', 'prefix_CONTEXT_SECRET_suffix']) {
    const { screen } = makeScreen([response(validBody(), { headers: { 'x-typesafe-request-id': id } })]);
    const result = await screen(baseAction, { ...baseContext, knownSecrets: ['CONTEXT_SECRET'] });
    assert.equal(result.decision, 'pass');
    assert.equal('requestId' in result.metadata, false);
  }
});

test('JSON结束及校验结束恰好到期或超过 deadline 不得 pass', async () => {
  for (const elapsed of [9, 10, 11]) {
    const clock = fakeClock();
    const reply = response(validBody());
    reply.json = async () => { clock.advance(elapsed); return validBody(); };
    const { screen, clearedTimers } = makeScreen([reply], { clock, timeoutMs: 10 });
    const result = await screen(baseAction, baseContext);
    assert.equal(result.outcome, elapsed < 10 ? 'pass' : 'error');
    if (elapsed >= 10) assert.equal(result.metadata.errorCode, 'deadline_exceeded');
    assert.equal(clearedTimers.length, 1);
  }
  const clock = fakeClock();
  const body = validBody();
  Object.defineProperty(body, 'usage', { get() { clock.advance(10); return undefined; } });
  const { screen } = makeScreen([response(body)], { clock, timeoutMs: 10 });
  assert.equal((await screen(baseAction, baseContext)).metadata.errorCode, 'deadline_exceeded');
});

test('非2xx取消body，取消抛错或挂起不掩盖HTTP且不阻塞重试', async () => {
  for (const status of [401, 422, 429, 503]) {
    for (const mode of ['resolve', 'throw', 'hang']) {
      let cancelled = false;
      const reply = response({}, { status });
      reply.body = { cancel() {
        cancelled = true;
        if (mode === 'throw') throw new Error('secret cleanup');
        return mode === 'hang' ? new Promise(() => {}) : Promise.resolve();
      } };
      const { screen } = makeScreen([reply, response(validBody())]);
      const result = await screen(baseAction, baseContext);
      assert.equal(cancelled, true);
      assert.equal(result.outcome, status >= 429 ? 'pass' : 'error');
      assert.equal(JSON.stringify(result).includes('secret cleanup'), false);
    }
  }
});

test('backoff jitter可注入并受总预算约束，Retry-After保持服务端等待', async () => {
  for (const [random, expected] of [[0, 250], [1, 500]]) {
    const { screen, clock } = makeScreen([response({}, { status: 503 }), response(validBody())], { random: () => random });
    assert.equal((await screen(baseAction, baseContext)).decision, 'pass');
    assert.deepEqual(clock.sleeps, [expected]);
  }
  const { screen, clock } = makeScreen([response({}, { status: 429, headers: { 'retry-after-ms': '123' } }), response(validBody())], { random: () => 0 });
  await screen(baseAction, baseContext);
  assert.deepEqual(clock.sleeps, [123]);
});

test('usage 可缺；非法 model、JSON 或 usage 安全回落且不泄漏响应 body', async () => {
  const noUsage = validBody();
  delete noUsage.usage;
  const okay = makeScreen([response(noUsage, { headers: { 'x-typesafe-request-id': 'req_safe' } })]);
  const pass = await okay.screen(baseAction, baseContext);
  assert.equal(pass.decision, 'pass');
  assert.equal(pass.metadata.requestId, 'req_safe');
  assert.equal('usage' in pass.metadata, false);

  const invalids = [
    response({ ...validBody(), model: '' }),
    response({ ...validBody(), usage: { input_tokens: -1 } }),
    { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('body has TOP_SECRET'); } },
  ];
  for (const reply of invalids) {
    const { screen } = makeScreen([reply]);
    const result = await screen(baseAction, baseContext);
    const text = JSON.stringify(result);
    assert.equal(result.outcome, 'error');
    assert.equal(text.includes('TOP_SECRET'), false);
  }
});

test('401/422 不重试；错误 metadata 不含 key、state 或 body', async () => {
  for (const status of [401, 422]) {
    const key = 'jev_do_not_leak_999999';
    const { screen, calls, clearedTimers } = makeScreen([
      response({ error: `body ${key} task contract` }, { status, headers: { 'x-typesafe-request-id': 'req_err' } }),
    ], { apiKey: key });
    const result = await screen(baseAction, baseContext);
    assert.equal(calls.length, 1);
    assert.equal(clearedTimers.length, 1, '非 2xx 响应必须清掉本次 deadline timer');
    assert.deepEqual(result, {
      decision: 'flag',
      outcome: 'error',
      metadata: {
        reviewer: 'jev',
        reviewModel: 'jev-1.13.0',
        reviewSchema: 'approval-v2',
        requestId: 'req_err',
        attempts: 1,
        status,
        errorCode: `http_${status}`,
        durationMs: 0,
      },
    });
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.equal(JSON.stringify(result).includes('task contract'), false);
  }
});

test('408/429/529/5xx 与连接错误有界重试后成功', async () => {
  for (const first of [
    response({}, { status: 408 }),
    response({}, { status: 429, headers: { 'retry-after': '0.25' } }),
    response({}, { status: 529 }),
    response({}, { status: 503 }),
    new TypeError('fetch failed with secret body'),
  ]) {
    const { screen, calls, clock, clearedTimers } = makeScreen([first, response(validBody())]);
    const result = await screen(baseAction, baseContext);
    assert.equal(result.decision, 'pass');
    assert.equal(calls.length, 2);
    assert.equal(clearedTimers.length, 2, '每次 HTTP attempt 都必须清掉 deadline timer');
    assert.equal(result.metadata.attempts, 2);
    assert.equal(clock.sleeps.length, 1);
    assert.ok(clock.sleeps[0] >= 0);
  }
});

test('Retry-After 与 backoff 服从单一总 deadline，绝不睡过预算', async () => {
  const clock = fakeClock(10_000);
  const { screen, calls } = makeScreen([
    response({}, { status: 429, headers: { 'retry-after': '10' } }),
    response(validBody()),
  ], { clock, timeoutMs: 1_000 });
  const result = await screen(baseAction, baseContext);
  assert.equal(result.decision, 'flag');
  assert.equal(result.outcome, 'error');
  assert.equal(result.metadata.errorCode, 'deadline_exceeded');
  assert.deepEqual(clock.sleeps, [1_000]);
  assert.equal(calls.length, 1);
  assert.equal(result.metadata.durationMs, 1_000);
});

test('总 deadline 也覆盖响应 body 读取', async () => {
  const clock = fakeClock(4_000);
  let timerCallback;
  let signal;
  const fetchImpl = async (_url, init) => {
    signal = init.signal;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('late body secret');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
        clock.advance(500);
        timerCallback();
      }),
    };
  };
  const screen = createJevFastScreen({
    apiKey: 'jev_body_timeout_secret_123456',
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    setTimeoutImpl: (callback) => {
      timerCallback = callback;
      return { fake: true };
    },
    clearTimeoutImpl: () => {},
    timeoutMs: 500,
  });
  const result = await screen(baseAction, baseContext);
  assert.equal(result.decision, 'flag');
  assert.equal(result.metadata.errorCode, 'deadline_exceeded');
  assert.equal(result.metadata.durationMs, 500);
  assert.equal(JSON.stringify(result).includes('late body secret'), false);
});

test('最近消息滚动窗口不把旧消息截断误作本地skip', async () => {
  const { screen, calls } = makeScreen([response(validBody())]);
  const result = await screen(baseAction, { intent: ['old'.repeat(1000), ...Array(10).fill('run tests')] });
  assert.equal(result.decision, 'pass');
  assert.deepEqual(JSON.parse(calls[0].init.body).state.intent.recentMessages, Array(10).fill('run tests'));
});

test('非合作JSON在abort竞态时也结束并释放timer', async () => {
  let callback;
  let cleared = 0;
  const screen = createJevFastScreen({
    apiKey: 'SYNTHETIC_TEST_KEY',
    fetchImpl: async () => ({ ...response(validBody()), json: () => {
      queueMicrotask(() => callback());
      return new Promise(() => {});
    } }),
    setTimeoutImpl: (fn) => { callback = fn; return 1; },
    clearTimeoutImpl: () => { cleared++; },
  });
  const result = await screen(baseAction, baseContext);
  assert.equal(result.metadata.errorCode, 'deadline_exceeded');
  assert.equal(cleared, 1);
});

test('AbortController 的总 deadline 会真实取消挂起 fetch', async () => {
  const clock = fakeClock(5_000);
  let timerCallback;
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted response body must not leak');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
    clock.advance(750);
    timerCallback();
  });
  const screen = createJevFastScreen({
    apiKey: 'jev_timeout_secret_123456',
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    setTimeoutImpl: (callback) => {
      timerCallback = callback;
      return { fake: true };
    },
    clearTimeoutImpl: () => {},
    timeoutMs: 750,
  });
  const result = await screen(baseAction, baseContext);
  assert.equal(result.decision, 'flag');
  assert.equal(result.outcome, 'error');
  assert.equal(result.metadata.errorCode, 'deadline_exceeded');
  assert.equal(result.metadata.attempts, 1);
  assert.equal(result.metadata.durationMs, 750);
  assert.equal(JSON.stringify(result).includes('response body'), false);
});

test('默认总 deadline 为 10 秒，覆盖真实 Jev 常见响应耗时', async () => {
  let delay;
  const screen = createJevFastScreen({
    apiKey: 'jev_default_deadline_secret',
    fetchImpl: async () => response(validBody()),
    setTimeoutImpl: (_callback, ms) => {
      delay = ms;
      return { fake: true };
    },
    clearTimeoutImpl: () => {},
  });
  const result = await screen(baseAction, baseContext);
  assert.equal(result.decision, 'pass');
  assert.equal(delay, 10_000);
});

test('每次 fetch 都收到 AbortSignal，重试耗尽返回稳定 error metadata', async () => {
  const key = 'jev_network_secret_123456';
  const { screen, calls } = makeScreen([
    new TypeError(`failed ${key}`),
    new TypeError(`failed ${key}`),
    new TypeError(`failed ${key}`),
  ], { apiKey: key, maxAttempts: 3 });
  const result = await screen(baseAction, baseContext);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.init.signal instanceof AbortSignal));
  assert.equal(result.decision, 'flag');
  assert.equal(result.outcome, 'error');
  assert.equal(result.metadata.errorCode, 'network_error');
  assert.equal(result.metadata.attempts, 3);
  assert.equal(JSON.stringify(result).includes(key), false);
});
