// 闸门接进 runner 的行为测试（T3.2）：对 test/mock-appserver.mjs 跑 CLI，ZCODE_EXECUTOR_HOME
// 指向临时目录。runner 是 detached 的：每个用例开头 t.after 登记清理，收尾统一 SIGKILL。
// generateText 剧本字段见 mock-appserver.mjs 文件头（T3.2 增量：replies / generateTextErrors /
// generateTextDelayMs / cancelGenerateText）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
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

// Flash 也给思考档位：让 review 的 modelRef 能解析出 variant:'high'（真机 GLM-5.3 族有 low/high/max）
const ZCODE_CONFIG = {
  provider: {
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      options: { apiKey: 'sk-review-plan' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': { name: 'GLM 5.3 Flash', reasoning: { enabled: true, variants: ['low', 'high'], defaultVariant: 'high' } },
      },
    },
  },
};

async function setupReview(t, { script, reviewConfig } = {}) {
  t.after(() => {
    killAll(runnerPids);
    killAll(mockPids);
  });
  const mock = await startMock({ script });
  dirs.push(mock.dir);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-gate-home-'));
  dirs.push(home);
  const workParent = await mkdtemp(path.join(os.tmpdir(), 'zcode-gate-work-'));
  dirs.push(workParent);
  const repo = path.join(workParent, 'repo');
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedRoots: [workParent], ...reviewConfig }));
  const zcodeConfigDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-gate-zconfig-'));
  dirs.push(zcodeConfigDir);
  const zcodeConfigPath = path.join(zcodeConfigDir, 'config.json');
  await writeFile(zcodeConfigPath, JSON.stringify(ZCODE_CONFIG));
  const env = {
    ...process.env,
    ZCODE_BIN: mock.zcodePath,
    ZCODE_EXECUTOR_HOME: home,
    ZCODE_CONFIG_PATH: zcodeConfigPath,
    ...mock.env,
  };
  const created = spawnSync(process.execPath, [BIN, 'new', '--cwd', repo, '--tier', 'strong', '--json'], { encoding: 'utf8', env, timeout: 60_000 });
  assert.equal(created.status, 0, `new 失败：${created.stderr}`);
  const entry = JSON.parse(created.stdout);
  return {
    env,
    entry,
    repo,
    outside: path.join(workParent, 'elsewhere.txt'), // cwd（repo）之外、白名单之内的越界写目标
    runsDir: path.join(home, 'runs', entry.id),
    recordPath: mock.env.MOCK_APPSERVER_RECORD,
    scriptPath: mock.env.MOCK_APPSERVER_SCRIPT,
  };
}

function runBin(env, args, { input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, timeout: 120_000, input });
}

/** runner 常是 detached 的：把 lock 里的 runner pid 与 runner.log 里的 mock pid 记进全局，after() 杀。 */
function trackRunnerPids(runsDir) {
  try {
    const { pid } = JSON.parse(readFileSync(path.join(runsDir, 'lock'), 'utf8'));
    if (Number.isInteger(pid)) runnerPids.push(pid);
  } catch {
    // 锁已经没了：runner 正常退出了
  }
  try {
    const log = readFileSync(path.join(runsDir, 'runner.log'), 'utf8');
    for (const m of log.matchAll(/mock: started version=\S+ pid=(\d+)/g)) mockPids.push(Number(m[1]));
  } catch {
    // 还没起 mock
  }
}

const readEvents = (runsDir) => {
  try {
    return readFileSync(path.join(runsDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

const gateEvents = (runsDir) => readEvents(runsDir).filter((e) => e.type === 'executor.gate');

const generateTexts = (recordPath) =>
  readRecord(recordPath).filter((m) => m.method === 'workspace/generateText');

// 等挂起出现，断言完写一个 deny 答案让 runner 走完收摊（不留孤儿）
async function settlePending(env, assertPending) {
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  const pending = JSON.parse(await readFile(path.join(env.runsDir, 'pending.json'), 'utf8'));
  if (assertPending) assertPending(pending);
  trackRunnerPids(env.runsDir);
  await writeFile(path.join(env.runsDir, 'answer.json'), JSON.stringify({ decision: 'deny', requestId: pending.requestId }));
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true));
}

const PERM_INSIDE = (extra = {}) => ({ toolName: 'Write', input: { file_path: 'hello.txt' }, reason: '有副作用', ...extra });

test('红线命中：Write 到 cwd 外 → 不调 generateText，pending 带 stage hard，退 5', async (t) => {
  const env = await setupReview(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: path.join('..', 'elsewhere.txt') }, reason: '越界写' } }] },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '越界写个文件', '--wait']);
  assert.equal(run.status, 5, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  await settlePending(env, (pending) => {
    assert.equal(pending.stage, 'hard');
    assert.equal(pending.ruleId, 'outside-worktree');
    assert.match(pending.why, /执行副本之外/);
  });
  assert.equal(generateTexts(env.recordPath).length, 0, '红线命中不许调模型');
  const hard = gateEvents(env.runsDir).find((e) => e.stage === 'hard');
  assert.ok(hard, 'events 里要有 executor.gate stage hard');
  assert.equal(hard.decision, 'ask');
  assert.equal(hard.ruleId, 'outside-worktree');
});

test('快筛 pass：自动应答 allow、不落 pending、事件 review-fast，modelRef 是 fast 档 + variant low（默认）', async (t) => {
  const env = await setupReview(t, {
    script: {
      generateText: { replies: ['Y'] },
      turns: [{ permission: PERM_INSIDE() }],
    },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '写个文件', '--wait', '--json']);
  assert.equal(run.status, 0, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  assert.equal(JSON.parse(run.stdout).outcome, 'done');
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), false, '自动放行不落 pending');
  const gateEvent = gateEvents(env.runsDir).at(-1);
  assert.equal(gateEvent.stage, 'review-fast');
  assert.equal(gateEvent.decision, 'allow');
  const calls = generateTexts(env.recordPath);
  assert.equal(calls.length, 1, '快筛过了就只该有一次 generateText');
  assert.deepEqual(calls[0].params.modelRef, {
    providerId: 'builtin:bigmodel-coding-plan',
    modelId: 'GLM-5.3-Flash',
    variant: 'low',
  });
  assert.equal(calls[0].params.querySource, 'zcode-executor.review');
  assert.equal(calls[0].params.messages[0].role, 'system');
  assert.equal(calls[0].params.messages[1].role, 'user');
});

test('快筛 flag + 慢判 allow：两次调用，事件 review-slow allow', async (t) => {
  const env = await setupReview(t, {
    script: {
      generateText: { replies: ['N', '结论: allow | 规则: none | 理由: 日常工作'] },
      turns: [{ permission: PERM_INSIDE() }],
    },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '写个文件', '--wait', '--json']);
  assert.equal(run.status, 0, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  const gateEvent = gateEvents(env.runsDir).at(-1);
  assert.equal(gateEvent.stage, 'review-slow');
  assert.equal(gateEvent.decision, 'allow');
  assert.match(gateEvent.reason, /日常工作/);
  assert.equal(generateTexts(env.recordPath).length, 2);
});

test('慢判 deny：挂起转人工（why 是模型理由、ruleId 带上），退 5', async (t) => {
  const env = await setupReview(t, {
    script: {
      generateText: { replies: ['N', '结论: deny | 规则: cred-exfil | 理由: 凭据外发'] },
      turns: [{ permission: PERM_INSIDE() }],
    },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '写个文件', '--wait']);
  assert.equal(run.status, 5, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  await settlePending(env, (pending) => {
    assert.equal(pending.stage, 'review-slow');
    assert.equal(pending.ruleId, 'cred-exfil');
    assert.match(pending.why, /凭据外发/);
  });
});

test('慢判垃圾文本：挂起 stage review-failed', async (t) => {
  const env = await setupReview(t, {
    script: {
      generateText: { replies: ['N', '模型自由发挥没有结论行'] },
      turns: [{ permission: PERM_INSIDE() }],
    },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '写个文件', '--wait']);
  assert.equal(run.status, 5, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  await settlePending(env, (pending) => {
    assert.equal(pending.stage, 'review-failed');
    assert.match(pending.why, /解析失败/);
  });
});

test('generateText 报错：挂起 review-failed，reason 带错误信息', async (t) => {
  const env = await setupReview(t, {
    script: {
      generateTextErrors: { '1': { code: -32000, message: '模型后端不可用' } },
      turns: [{ permission: PERM_INSIDE() }],
    },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '写个文件', '--wait']);
  assert.equal(run.status, 5, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  await settlePending(env, (pending) => {
    assert.equal(pending.stage, 'review-failed');
    assert.match(pending.why, /后端不可用/);
  });
});

test('generateText 超时：先发 cancelGenerateText，再挂起 review-failed', async (t) => {
  const env = await setupReview(t, {
    script: {
      generateText: { replies: ['Y'] },
      generateTextDelayMs: 2000,
      turns: [{ permission: PERM_INSIDE() }],
    },
    reviewConfig: { review: { timeoutMs: 300 } },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '写个文件', '--wait']);
  assert.equal(run.status, 5, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  await settlePending(env, (pending) => {
    assert.equal(pending.stage, 'review-failed');
    assert.match(pending.why, /超时/);
  });
  const methods = readRecord(env.recordPath).map((m) => m.method);
  assert.ok(methods.includes('workspace/cancelGenerateText'), '超时要发取消');
});

test('options 无 allow_once：直接挂起，不调 generateText', async (t) => {
  const env = await setupReview(t, {
    script: {
      generateText: { replies: ['Y'] },
      turns: [{
        permission: PERM_INSIDE({
          options: [{ optionId: 'deny', kind: 'deny', response: { decision: 'deny' } }],
        }),
      }],
    },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '写个文件', '--wait']);
  assert.equal(run.status, 5, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  await settlePending(env, (pending) => {
    assert.equal(pending.stage, 'no-allow-option');
  });
  assert.equal(generateTexts(env.recordPath).length, 0);
});

test('提问：直接挂起不调模型，answer 按值应答后回合到 done', async (t) => {
  const env = await setupReview(t, {
    script: {
      generateText: { replies: ['Y'] },
      turns: [{ question: { questions: [{ question: '用哪个名字？', multiSelect: false, options: [{ label: '甲', value: 'jia' }] }] } }],
    },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '要问名字的活', '--wait']);
  assert.equal(run.status, 5, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  assert.equal(generateTexts(env.recordPath).length, 0, '提问不进模型审批');
  const pending = JSON.parse(await readFile(path.join(env.runsDir, 'pending.json'), 'utf8'));
  assert.equal(pending.kind, 'question');
  trackRunnerPids(env.runsDir);
  await writeFile(path.join(env.runsDir, 'answer.json'), JSON.stringify({ values: ['jia'], requestId: pending.requestId }));
  await waitFor(
    async () => {
      const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8').catch(() => '{}'));
      return last.outcome === 'done' ? last : undefined;
    },
    { timeoutMs: 15000 },
  );
});

test('review.enabled:false：其余挂起且不调模型，红线仍判', async (t) => {
  const env = await setupReview(t, {
    script: { generateText: { replies: ['Y'] }, turns: [{ permission: PERM_INSIDE() }] },
    reviewConfig: { review: { enabled: false } },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '写个文件', '--wait']);
  assert.equal(run.status, 5, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  await settlePending(env, (pending) => {
    assert.equal(pending.stage, 'review-disabled');
  });
  assert.equal(generateTexts(env.recordPath).length, 0);

  // 同配置下越界写：红线照常命中
  const env2 = await setupReview(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: path.join('..', 'elsewhere.txt') }, reason: '越界写' } }] },
    reviewConfig: { review: { enabled: false } },
  });
  const run2 = await runBin(env2.env, ['send', env2.entry.id, '越界写', '--wait']);
  assert.equal(run2.status, 5, run2.stderr);
  await settlePending(env2, (pending) => {
    assert.equal(pending.stage, 'hard');
    assert.equal(pending.ruleId, 'outside-worktree');
  });
});

test('意图进提示词：generateText 的 user 消息含任务单全文（超 600 字也不截）与投递正文', async (t) => {
  const env = await setupReview(t, {
    script: {
      generateText: { replies: ['Y'] },
      turns: [{ permission: PERM_INSIDE() }],
    },
  });
  const taskPath = path.join(env.repo, 'tasks', 'T-900.md');
  await mkdir(path.dirname(taskPath), { recursive: true });
  // 任务单正文 700+ 字，末尾一句是唯一的断言锚点：按旧的 clip(600) 它必然被截掉（T3.2b）
  const filler = '背景：这一段是凑字数的上下文交代，让任务单超过六百字。'.repeat(35);
  await writeFile(taskPath, `# 任务\n${filler}\n末尾独特句：蓝鲸是哺乳动物，写完 hello.txt 就停。`);
  assert.ok(readFileSync(taskPath, 'utf8').length > 600, '夹具自检：任务单确实超 600 字');
  const run = await runBin(env.env, ['send', env.entry.id, '按任务单执行蓝鲸计划', '--task', taskPath, '--wait', '--json']);
  assert.equal(run.status, 0, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  const calls = generateTexts(env.recordPath);
  assert.equal(calls.length, 1);
  const user = calls[0].params.messages.find((m) => m.role === 'user').content;
  assert.ok(user.includes('蓝鲸是哺乳动物'), '任务单末尾那句要进意图（超 600 字不截）');
  assert.ok(user.includes('按任务单执行蓝鲸计划'), '投递正文要进意图');
});

test('review.fastMaxTokens / slowMaxTokens：两段调用的 maxOutputTokens 等于配置值且不同', async (t) => {
  const env = await setupReview(t, {
    script: {
      generateText: { replies: ['N', '结论: allow | 规则: none | 理由: 日常工作'] },
      turns: [{ permission: PERM_INSIDE() }],
    },
    reviewConfig: { review: { fastMaxTokens: 50, slowMaxTokens: 777 } },
  });
  const run = await runBin(env.env, ['send', env.entry.id, '写个文件', '--wait', '--json']);
  assert.equal(run.status, 0, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  const calls = generateTexts(env.recordPath);
  assert.equal(calls.length, 2, '快筛 flag 后进慢判，共两次调用');
  assert.equal(calls[0].params.maxOutputTokens, 50, '快筛预算用配置值');
  assert.equal(calls[1].params.maxOutputTokens, 777, '慢判预算用配置值（T3.3）');
});
