// approve / deny / answer 的行为测试（T2.5）：全部对 test/mock-appserver.mjs 跑，子进程跑 bin，
// 不发真 session/send，不花额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, readRecord, killAll, waitFor } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'zcode-executor');
const dirs = [];
const runnerPids = [];
const mockPids = [];
test.after(async () => {
  killAll(runnerPids);
  killAll(mockPids);
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const ZCODE_CONFIG = {
  provider: {
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      options: { apiKey: 'sk-test-plan' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': {},
      },
    },
  },
};

// 两问的提问剧本：单选（按序号或 label）+ 多选（按 value）
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

const envFor = (home, mock, zcodeConfigPath) => ({
  ...process.env,
  ZCODE_BIN: mock.zcodePath,
  ZCODE_EXECUTOR_HOME: home,
  ZCODE_CONFIG_PATH: zcodeConfigPath,
  // 测试压时长（T2.6b 第 10 条）：applied 等尾 1.5 秒、cancel 宽限 0.6 秒
  ZCODE_EXECUTOR_ANSWER_WAIT_MS: '1500',
  ZCODE_EXECUTOR_CANCEL_GRACE_MS: '600',
  ...mock.env,
});

async function setupAnswer(t, { script } = {}) {
  t.after(() => {
    killAll(runnerPids);
    killAll(mockPids);
  });
  const mock = await startMock({ script });
  dirs.push(mock.dir);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-answer-home-'));
  dirs.push(home);
  const workParent = await mkdtemp(path.join(os.tmpdir(), 'zcode-answer-work-'));
  dirs.push(workParent);
  const repo = path.join(workParent, 'repo');
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedRoots: [workParent], review: { enabled: false } })); // T3.2：这组测的是挂起管线本身，模型审批关掉（开了会自动放行）
  const zcodeConfigDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-answer-zconfig-'));
  dirs.push(zcodeConfigDir);
  const zcodeConfigPath = path.join(zcodeConfigDir, 'config.json');
  await writeFile(zcodeConfigPath, JSON.stringify(ZCODE_CONFIG));
  const env = envFor(home, mock, zcodeConfigPath);
  const created = spawnSync(process.execPath, [BIN, 'new', '--cwd', repo, '--tier', 'strong', '--json'], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  assert.equal(created.status, 0, `new 失败：${created.stderr}`);
  const entry = JSON.parse(created.stdout);
  return { mock, home, env, entry, runsDir: path.join(home, 'runs', entry.id), recordPath: mock.env.MOCK_APPSERVER_RECORD };
}

function trackRunnerPids(runsDir) {
  try {
    const { pid } = JSON.parse(readFileSync(path.join(runsDir, 'lock'), 'utf8'));
    if (Number.isInteger(pid)) runnerPids.push(pid);
  } catch {
    // 锁已经没了
  }
  try {
    const log = readFileSync(path.join(runsDir, 'runner.log'), 'utf8');
    for (const m of log.matchAll(/mock: started version=\S+ pid=(\d+)/g)) mockPids.push(Number(m[1]));
  } catch {
    // 还没起 mock
  }
}

const readPending = (runsDir) => JSON.parse(readFileSync(path.join(runsDir, 'pending.json'), 'utf8'));

const readEvents = (runsDir) => {
  try {
    return readFileSync(path.join(runsDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return []; // runner 还没建 events.jsonl：waitFor 轮询的前提
  }
};

test('approve 全链路：应答 {decision:allow}、回合 done、events 有 executor.approve、pending 删除、退 0', async (t) => {
  const env = await setupAnswer(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'hello.txt' }, reason: '有副作用' } }] },
  });
  const queued = runBin(env.env, ['send', env.entry.id, '写文件']);
  assert.equal(queued.status, 0, queued.stderr);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);

  const approve = runBin(env.env, ['approve', env.entry.id, '--json']);
  assert.equal(approve.status, 0, `stderr: ${approve.stderr}`);
  const out = JSON.parse(approve.stdout);
  assert.equal(out.kind, 'approve');
  assert.equal(out.applied, true);
  assert.equal(out.id, env.entry.id); // 本地 id（T2.6b 第 1 条：sessionId 不再装本地 id）
  assert.match(out.requestId, /^req_|^mock_/);

  await waitFor(
    async () => {
      const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8').catch(() => '{}'));
      return last.outcome === 'done' ? last : undefined;
    },
    { timeoutMs: 15000 },
  );
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), false);
  const answers = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined);
  assert.ok(answers.some((m) => m.result && m.result.decision === 'allow'));
  const events = readEvents(env.runsDir).map((e) => e.type);
  assert.ok(events.includes('executor.approve'));
  const approveEvent = readEvents(env.runsDir).find((e) => e.type === 'executor.approve');
  assert.equal(approveEvent.requestId, out.requestId);
});

test('deny：审批 → 记录 {decision:deny}，events 有 executor.deny', async (t) => {
  const env = await setupAnswer(t, {
    script: { turns: [{ permission: { toolName: 'Bash', input: { command: 'ls' }, reason: '列目录' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '跑个命令']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const deny = runBin(env.env, ['deny', env.entry.id, '--json']);
  assert.equal(deny.status, 0, `stderr: ${deny.stderr}`);
  assert.equal(JSON.parse(deny.stdout).kind, 'deny');
  await waitFor(async () => {
    const answers = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined);
    return answers.some((m) => m.result?.decision === 'deny') ? answers : undefined;
  });
  const events = readEvents(env.runsDir).map((e) => e.type);
  assert.ok(events.includes('executor.deny'));
});

test('deny：对提问 decline:true → mock 收到 {action:decline, reason:人工拒答}', async (t) => {
  const env = await setupAnswer(t, { script: QUESTION_SCRIPT });
  runBin(env.env, ['send', env.entry.id, '要拒答的活']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const deny = runBin(env.env, ['deny', env.entry.id, '--json']);
  assert.equal(deny.status, 0, `stderr: ${deny.stderr}`);
  await waitFor(async () => {
    const answers = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined);
    return answers.some((m) => m.result?.action === 'decline') ? answers : undefined;
  });
  const decline = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined).find((m) => m.result?.action === 'decline');
  assert.equal(decline.result.reason, '人工拒答');
});

test('answer：两问按顺序对应——单选按序号、多选按 value 逗号分隔', async (t) => {
  const env = await setupAnswer(t, { script: QUESTION_SCRIPT });
  runBin(env.env, ['send', env.entry.id, '回答问题']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const run = runBin(env.env, ['answer', env.entry.id, '2', 'a,b', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.equal(JSON.parse(run.stdout).kind, 'answer');
  await waitFor(async () => {
    const answers = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined);
    return answers.some((m) => m.result?.action === 'accept') ? answers : undefined;
  });
  const answer = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined).find((m) => m.result?.action === 'accept');
  assert.deepEqual(answer.result.content.answers, { 选择模式: '稳妥', 选模块: 'A 模块, B 模块' });
});

test('answer：按 label 与自由文本；多问少给值 → 2 且列出可选项', async (t) => {
  const env = await setupAnswer(t, { script: QUESTION_SCRIPT });
  runBin(env.env, ['send', env.entry.id, '回答问题']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const short = runBin(env.env, ['answer', env.entry.id, '快速']);
  assert.equal(short.status, 2, short.stderr);
  assert.match(short.stderr, /共 2 个问题/);
  assert.match(short.stderr, /快速|稳妥/); // 列出可选项
  const good = runBin(env.env, ['answer', env.entry.id, '快速', 'a', '--json']);
  assert.equal(good.status, 0, good.stderr); // label 与 value 都能匹配
});

test('answer：对不上选项 → 退 2 且 pending 还在、answer.json 不写', async (t) => {
  const env = await setupAnswer(t, { script: QUESTION_SCRIPT });
  runBin(env.env, ['send', env.entry.id, '回答问题']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const run = runBin(env.env, ['answer', env.entry.id, '不存在的选项', 'a']);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /不存在的选项/);
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), true); // 挂起还在，可重新应答
  assert.equal(existsSync(path.join(env.runsDir, 'answer.json')), false); // 校验不过不写答案
});

test('answer：对审批用 answer → 退 2；approve 对提问 → 退 2', async (t) => {
  const perm = await setupAnswer(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(perm.env, ['send', perm.entry.id, '审批的活']);
  await waitFor(async () => (existsSync(path.join(perm.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(perm.runsDir);
  const answerOnPerm = runBin(perm.env, ['answer', perm.entry.id, '随便']);
  assert.equal(answerOnPerm.status, 2, answerOnPerm.stderr);
  assert.match(answerOnPerm.stderr, /当前挂起是审批/);
  const approveOnPerm = runBin(perm.env, ['approve', perm.entry.id, '--json']);
  assert.equal(approveOnPerm.status, 0, approveOnPerm.stderr); // 对照：approve 正常

  const question = await setupAnswer(t, { script: QUESTION_SCRIPT });
  runBin(question.env, ['send', question.entry.id, '提问的活']);
  await waitFor(async () => (existsSync(path.join(question.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(question.runsDir);
  const approveOnQuestion = runBin(question.env, ['approve', question.entry.id]);
  assert.equal(approveOnQuestion.status, 2, approveOnQuestion.stderr);
  assert.match(approveOnQuestion.stderr, /当前挂起是提问/);
});

test('options 只有 allow_always 没有 allow_once → approve 退 2，deny 仍可（RULES §8）', async (t) => {
  const env = await setupAnswer(t, {
    script: {
      turns: [
        {
          permission: {
            toolName: 'Write',
            input: { file_path: 'x' },
            reason: '副作用',
            options: [
              { optionId: 'allow_project', kind: 'allow_always', response: { decision: 'allow', reason: 'Approved for this project' } },
              { optionId: 'deny', kind: 'deny', response: { decision: 'deny', reason: 'Denied' } },
            ],
          },
        },
      ],
    },
  });
  runBin(env.env, ['send', env.entry.id, '只有一直允许的活']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const approve = runBin(env.env, ['approve', env.entry.id]);
  assert.equal(approve.status, 2, approve.stderr);
  assert.match(approve.stderr, /allow_once/);
  const deny = runBin(env.env, ['deny', env.entry.id, '--json']);
  assert.equal(deny.status, 0, deny.stderr); // deny 不受 allow_once 限制
  assert.equal(JSON.parse(deny.stdout).kind, 'deny');
});

test('没有挂起 → approve/deny/answer 都退 2', async (t) => {
  const env = await setupAnswer(t);
  for (const cmd of ['approve', 'deny', 'answer']) {
    const run = runBin(env.env, [cmd, env.entry.id, ...(cmd === 'answer' ? ['x'] : [])]);
    assert.equal(run.status, 2, `${cmd}: ${run.stderr}`);
    assert.match(run.stderr, /当前没有挂起/);
  }
});

test('runner 死了（SIGKILL）→ approve 退 2 且 answer.json 不写', async (t) => {
  const env = await setupAnswer(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '挂起后杀 runner']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const { pid } = JSON.parse(readFileSync(path.join(env.runsDir, 'lock'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await waitFor(async () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  });
  const run = runBin(env.env, ['approve', env.entry.id, '--json']);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /runner 没了/);
  assert.equal(existsSync(path.join(env.runsDir, 'answer.json')), false); // 没人消费就不写
});

test('--json 形状：{id, sessionId, requestId, kind, applied, pendingKind, eventType}（T2.6b 第 1 条）', async (t) => {
  const env = await setupAnswer(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '看形状']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const approve = runBin(env.env, ['approve', env.entry.id, '--json']);
  const out = JSON.parse(approve.stdout);
  assert.deepEqual(Object.keys(out).sort(), [
    'applied', 'eventType', 'id', 'kind', 'pendingKind', 'requestId', 'sessionId',
  ]);
  assert.equal(out.pendingKind, 'permission');
  assert.equal(out.eventType, 'executor.approve');
  assert.deepEqual([out.kind, out.applied], ['approve', true]);
  // 值断言（T2.6b 第 1 条）：id 是本地 id，sessionId 是登记簿里 zcode 的 sess_
  assert.equal(out.id, env.entry.id);
  const registry = JSON.parse(await readFile(path.join(env.home, 'sessions.json'), 'utf8'));
  assert.match(registry.sessions[env.entry.id].sessionId, /^sess_/);
  assert.equal(out.sessionId, registry.sessions[env.entry.id].sessionId);

  // deny 的形状单独起一条会话验证（approve 已经把挂起消费掉了）
  const env2 = await setupAnswer(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env2.env, ['send', env2.entry.id, '看形状二']);
  await waitFor(async () => (existsSync(path.join(env2.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env2.runsDir);
  const deny = runBin(env2.env, ['deny', env2.entry.id, '--json']);
  const dout = JSON.parse(deny.stdout);
  assert.deepEqual(Object.keys(dout).sort(), [
    'applied', 'eventType', 'id', 'kind', 'pendingKind', 'requestId', 'sessionId',
  ]);
  assert.equal(dout.kind, 'deny');
  assert.equal(dout.pendingKind, 'permission');
  assert.equal(dout.id, env2.entry.id);
});

test('answer：自由文本问题（无 options）直接文字应答', async (t) => {
  const env = await setupAnswer(t, { script: { turns: [{ question: { questions: [{ question: '还有什么要求' }] } }] } });
  runBin(env.env, ['send', env.entry.id, '自由问答']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const run = runBin(env.env, ['answer', env.entry.id, '别删 .git', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  await waitFor(async () => {
    const answers = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined);
    return answers.some((m) => m.result?.action === 'accept') ? answers : undefined;
  });
  const answer = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined).find((m) => m.result?.action === 'accept');
  assert.deepEqual(answer.result.content.answers, { 还有什么要求: '别删 .git' });
});

function runBin(env, args, { input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, timeout: 120_000, input });
}

// ---------- T2.5b 评审补充 ----------

test('同一回合两个挂起：approve 后 applied true 且不等满 5 秒（评审 T2.5b 第 1 条）', async (t) => {
  const env = await setupAnswer(t, {
    script: {
      turns: [
        {
          permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' },
          question: { questions: [{ question: '继续吗', options: [{ label: '继续' }] }] },
        },
      ],
    },
  });
  runBin(env.env, ['send', env.entry.id, '审批后接着问']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const started = Date.now();
  const approve = runBin(env.env, ['approve', env.entry.id, '--json']);
  const elapsed = Date.now() - started;
  assert.equal(approve.status, 0, `stderr: ${approve.stderr}`);
  const out = JSON.parse(approve.stdout);
  assert.equal(out.applied, true); // 第二个挂起顶上来也算已消费
  assert.ok(elapsed < 4500, `不该等满 5 秒，实际 ${elapsed}ms`);
  // runner 继续处理第二个挂起（提问）：清理
  const pending = JSON.parse(await readFile(path.join(env.runsDir, 'pending.json'), 'utf8'));
  await writeFile(path.join(env.runsDir, 'answer.json'), JSON.stringify({ requestId: pending.requestId, values: ['继续'] }));
  await waitFor(
    async () => {
      const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8').catch(() => '{}'));
      return last.outcome === 'done' ? last : undefined;
    },
    { timeoutMs: 15000 },
  );
});

test('applied:false：runner 被挂起（SIGSTOP）活着但不消费 → approve 如实报 false（评审 T2.5b 第 6 条）', { skip: process.platform === 'win32' && '用 SIGSTOP 冻住 runner，Windows 没有这个信号' }, async (t) => {
  const env = await setupAnswer(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '挂起不消费']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const { pid } = JSON.parse(readFileSync(path.join(env.runsDir, 'lock'), 'utf8'));
  process.kill(pid, 'SIGSTOP'); // 活着但不消费
  const started = Date.now();
  const approve = runBin(env.env, ['approve', env.entry.id, '--json']);
  const elapsed = Date.now() - started;
  process.kill(pid, 'SIGKILL');
  assert.equal(approve.status, 0, approve.stderr);
  const out = JSON.parse(approve.stdout);
  assert.equal(out.applied, false); // 等到 ANSWER_WAIT_MS 也没消费
  assert.ok(elapsed >= 1400, `应等满 ANSWER_WAIT_MS(1500ms)，实际 ${elapsed}ms`);
  assert.ok(elapsed < 6000, `不该等更久，实际 ${elapsed}ms`);
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), true); // 挂起还在，可重新处理
});

test('两次 approve：第二次（无挂起）退 2（评审 T2.5b 第 6 条）', async (t) => {
  const env = await setupAnswer(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '只挂起一次']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const first = runBin(env.env, ['approve', env.entry.id, '--json']);
  assert.equal(first.status, 0, first.stderr);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? undefined : true));
  const second = runBin(env.env, ['approve', env.entry.id]);
  assert.equal(second.status, 2, second.stderr);
  assert.match(second.stderr, /当前没有挂起/);
});

// ---------- T2.6 补充 ----------

test('events.jsonl 混入 {method,params} 通知行与坏行 → approve 仍报 applied（T2.6 第 1 条）', async (t) => {
  const env = await setupAnswer(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '通知行不该撞崩 approve']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  // 真机通知落盘成 {method, params}（没有 type 字段），再混一行完整的坏 JSON（也要带换行，
  // 不带会把 runner 追加的下一行事件粘成一行坏 JSON，那是另一个性质的损坏）
  await appendFile(
    path.join(env.runsDir, 'events.jsonl'),
    `${JSON.stringify({ method: 'process/mcpTelemetry', params: {} })}\n{"type":\n`,
  );
  const approve = runBin(env.env, ['approve', env.entry.id, '--json']);
  assert.equal(approve.status, 0, `stderr: ${approve.stderr}`); // 修前在这里 TypeError
  const out = JSON.parse(approve.stdout);
  assert.equal(out.applied, true);
  assert.equal(out.eventType, 'executor.approve');
  await waitFor(
    async () => {
      const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8').catch(() => '{}'));
      return last.outcome === 'done' ? last : undefined;
    },
    { timeoutMs: 15000 },
  );
});

test('挂起时 approve 与 cancel 并发 → eventType executor.deny、人读如实说被拒（T2.6b 第 2 条）', { skip: process.platform === 'win32' && '用 SIGSTOP 冻住 runner，Windows 没有这个信号' }, async (t) => {
  // 冻住 runner 编排并发：approve 先写放行，cancel 再写 deny 并落 cancel 文件，SIGCONT 后
  // runner 见 cancel 文件替人拒答——approve 必须拿到 executor.deny 回执而不是谎报放行
  const build = async () => {
    const env = await setupAnswer(t, {
      script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
    });
    runBin(env.env, ['send', env.entry.id, '审批撞取消']);
    await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
    trackRunnerPids(env.runsDir);
    const { pid } = JSON.parse(readFileSync(path.join(env.runsDir, 'lock'), 'utf8'));
    process.kill(pid, 'SIGSTOP');
    return { env, pid };
  };

  // 第一遍：--json 断言 eventType
  const first = await build();
  const approveJson = spawn(process.execPath, [BIN, 'approve', first.env.entry.id, '--json'], {
    encoding: 'utf8',
    env: first.env.env,
    timeout: 60_000,
  });
  let jsonOut = '';
  approveJson.stdout.on('data', (d) => { jsonOut += d; });
  await waitFor(async () => (existsSync(path.join(first.env.runsDir, 'answer.json')) ? true : undefined));
  const cancel1 = runBin(first.env.env, ['cancel', first.env.entry.id]);
  assert.equal(cancel1.status, 0, cancel1.stderr);
  process.kill(first.pid, 'SIGCONT');
  const code1 = await new Promise((resolve) => approveJson.on('close', (c) => resolve(c)));
  assert.equal(code1, 0, jsonOut);
  const out = JSON.parse(jsonOut);
  assert.equal(out.applied, true); // 挂起确实被消费了
  assert.equal(out.eventType, 'executor.deny'); // 但消费它的是 cancel 的替人拒答
  const denyEvent = readEvents(first.env.runsDir).find((e) => e.type === 'executor.deny' && e.requestId === out.requestId);
  assert.equal(denyEvent.reason, '任务已取消'); // 事件带 reason（runner 替人拒答也写事件）
  await waitFor(async () => (existsSync(path.join(first.env.runsDir, 'lock')) ? undefined : true), { timeoutMs: 20000 });

  // 第二遍：人读输出如实说被拒
  const second = await build();
  const approveHuman = spawn(process.execPath, [BIN, 'approve', second.env.entry.id], {
    encoding: 'utf8',
    env: second.env.env,
    timeout: 60_000,
  });
  let humanOut = '';
  approveHuman.stdout.on('data', (d) => { humanOut += d; });
  await waitFor(async () => (existsSync(path.join(second.env.runsDir, 'answer.json')) ? true : undefined));
  const cancel2 = runBin(second.env.env, ['cancel', second.env.entry.id]);
  assert.equal(cancel2.status, 0, cancel2.stderr);
  process.kill(second.pid, 'SIGCONT');
  const code2 = await new Promise((resolve) => approveHuman.on('close', (c) => resolve(c)));
  assert.equal(code2, 0, humanOut);
  assert.match(humanOut, /被 deny\/cancel 取代/);
  await waitFor(async () => (existsSync(path.join(second.env.runsDir, 'lock')) ? undefined : true), { timeoutMs: 20000 });
});

test('pending.json 坏 JSON：status/follow/send --wait/cancel 都退 1 且报中文（T2.6b 第 9 条）', { skip: process.platform === 'win32' && '用 SIGSTOP 冻住 runner，Windows 没有这个信号' }, async (t) => {
  const env = await setupAnswer(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '挂起写坏']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const { pid } = JSON.parse(readFileSync(path.join(env.runsDir, 'lock'), 'utf8'));
  process.kill(pid, 'SIGSTOP'); // 冻住 runner：坏文件保持原样，不被消费或清理
  await writeFile(path.join(env.runsDir, 'pending.json'), '{oops');
  const status = runBin(env.env, ['status', env.entry.id, '--json']);
  assert.equal(status.status, 1, status.stderr);
  assert.match(status.stderr, /pending\.json 解析失败/);
  const follow = runBin(env.env, ['follow', env.entry.id]);
  assert.equal(follow.status, 1, follow.stderr);
  assert.match(follow.stderr, /pending\.json 解析失败/);
  const send = runBin(env.env, ['send', env.entry.id, '再投一条', '--wait']);
  assert.equal(send.status, 1, send.stderr);
  assert.match(send.stderr, /pending\.json 解析失败/);
  const cancel = runBin(env.env, ['cancel', env.entry.id]);
  assert.equal(cancel.status, 1, cancel.stderr);
  assert.match(cancel.stderr, /pending\.json 解析失败/);
  process.kill(pid, 'SIGKILL');
});
