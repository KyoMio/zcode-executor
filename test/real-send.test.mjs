// scripts/real-send.mjs 的行为测试：全部对 test/mock-appserver.mjs 跑，不带真 --yes，
// 不向真 zcode 发 session/send，不花额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, readRecord, killAll } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pids = [];
const mockDirs = [];
const workDirs = [];
test.after(async () => {
  killAll(pids);
  for (const dir of mockDirs) await rm(dir, { recursive: true, force: true });
  for (const dir of workDirs) await rm(dir, { recursive: true, force: true });
});

// 模拟本机的 zcode 配置：CI 机器上没有 ~/.zcode，测试不能依赖它
const ZCODE_CONFIG = {
  provider: {
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      options: { apiKey: 'sk-test-plan' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': { name: 'GLM 5.3 Flash', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
      },
    },
  },
};

const PERMISSION_SCRIPT = {
  turns: [{ permission: { toolName: 'Bash', input: { command: 'ls' }, reason: '列目录' } }],
};

function parseLines(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// 起 mock、写好 MOCK_* 环境变量，spawnSync 跑 real-send；返回结果和各路径。
// 3.12（D14）：mock 只认 zcode.cjs 位置推不出来的内置 provider 文件，必须显式给
// ZCODE_BUILTIN_PROVIDER_CONFIG_FILE（mock.env 那份，随便一个存在的文件即可，mock 只查存在与否）。
// 个人 provider 文件不用传——real-send.mjs 自己用 ZCODE_CONFIG_PATH 读到的 provider 写一份、
// 显式传给 AppServerClient.spawn 的 personalProviderFile，优先级本来就盖过环境变量。
async function runRealSend(script, extraArgs) {
  const mock = await startMock({ script });
  mockDirs.push(mock.dir);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-real-send-test-'));
  workDirs.push(workDir);
  const zcodeConfigPath = path.join(workDir, 'zcode-config.json');
  await writeFile(zcodeConfigPath, JSON.stringify(ZCODE_CONFIG));
  const env = {
    ...process.env,
    ZCODE_BIN: mock.zcodePath,
    ZCODE_CONFIG_PATH: zcodeConfigPath,
    MOCK_APPSERVER_SCRIPT: mock.env.MOCK_APPSERVER_SCRIPT,
    MOCK_APPSERVER_RECORD: mock.env.MOCK_APPSERVER_RECORD,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: mock.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
  };
  const run = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'real-send.mjs'), '--yes', '--cwd', workDir, ...extraArgs], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  return { run, recordPath: mock.env.MOCK_APPSERVER_RECORD, pendingPath: path.join(workDir, '.zcode-executor-pending.json') };
}

test('real-send：--on-permission allow 走到 done，退出码 0，pending 已删', async () => {
  const { run, recordPath, pendingPath } = await runRealSend(PERMISSION_SCRIPT, ['--on-permission', 'allow']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const lines = parseLines(run.stdout);
  const outcome = lines.find((l) => l.step === 'outcome');
  assert.ok(outcome, 'stdout 里要有 outcome 行');
  assert.equal(outcome.outcome, 'done');
  assert.match(outcome.sessionId, /^sess_/);
  const answers = readRecord(recordPath).filter((m) => m.id !== undefined && m.method === undefined);
  // 第一条应答是 runtimePreferences 的默认值，审批应答按内容找
  const permAnswer = answers.find((m) => m.result && m.result.decision !== undefined);
  assert.deepEqual(permAnswer.result, { decision: 'allow' });
  await assert.rejects(readFile(pendingPath), (err) => err.code === 'ENOENT'); // 应答后 pending 已删
  // PLAN-3.12.md 一节层 5：回合真的会先收到这个反向请求，real-send 要打一行 stderr 能被看见
  // （检查点 5 的核对项之一：真机上它到底来不来）
  assert.match(run.stderr, /\[反向请求\] requestProviderRuntimeHeaders providerId=zcode-executor/);
});

test('real-send：非终端且没给 --on-permission → blocked，退出码 5，pending 保留', async () => {
  const { run, pendingPath } = await runRealSend(PERMISSION_SCRIPT, []);
  assert.equal(run.status, 5, `stderr: ${run.stderr}`);
  const lines = parseLines(run.stdout);
  const blocked = lines.find((l) => l.outcome === 'blocked');
  assert.ok(blocked, 'stdout 里要有 blocked 行');
  assert.equal(blocked.pendingPath, path.join(path.dirname(pendingPath), '.zcode-executor-pending.json'));
  assert.match(blocked.sessionId, /^sess_/); // 评审 T1.3b 第 2 条：遮蔽修正后 blocked 行带真 sessionId
  const pending = JSON.parse(await readFile(pendingPath, 'utf8')); // pending 保留交人工
  assert.equal(pending.kind, 'permission');
  assert.equal(pending.stage, 'pending');
});

test('real-send：--on-question 文字答案走到 done', async () => {
  const script = {
    turns: [{ question: { questions: [{ question: '计划如何？', options: [{ label: '继续' }] }] } }],
  };
  const { run, recordPath } = await runRealSend(script, ['--on-question', '继续']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const lines = parseLines(run.stdout);
  assert.equal(lines.find((l) => l.step === 'outcome').outcome, 'done');
  const answers = readRecord(recordPath).filter((m) => m.id !== undefined && m.method === undefined);
  const questionAnswer = answers.find((m) => m.result && m.result.action !== undefined);
  assert.deepEqual(questionAnswer.result, { action: 'accept', content: { answers: { '计划如何？': '继续' } } });
});

test('real-send：create 带 model（含 reasoningLevel）与顶层 thoughtLevel，不带 runtimeModel，不推表', async () => {
  // 自洽断言（评审 T1.3b 第 3 条）：不依赖本机 config 里有哪些 provider/model
  const { run, recordPath } = await runRealSend({}, []);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const methods = readRecord(recordPath).map((m) => m.method);
  assert.equal(methods.includes('workspace/updateProviderRegistry'), false); // 3.12 起该方法已删（D14），real-send 不再推表
  const creates = readRecord(recordPath).filter((m) => m.method === 'session/create');
  assert.equal(creates.length, 1);
  const params = creates[0].params;
  assert.equal(params.runtimeModel, undefined, 'create 不该再带 runtimeModel');
  assert.equal(params.model.providerId, 'zcode-executor'); // EXECUTOR_PROVIDER_ID：D14 固定值，不沿用 config.json 的 provider id
  assert.ok(['GLM-5.3', 'GLM-5.3-Flash'].includes(params.model.modelId));
  assert.equal(params.model.options?.reasoningLevel, 'high'); // GLM-5.3 系列 create 缺它会被拒
  assert.equal(params.thoughtLevel, 'high'); // 顶层也要带（PLAN-3.12.md 二节第 3 条）
  // mock 回显：settings.model.current 是 model 指定的 ref，stdout 的 create 行带出来
  const lines = parseLines(run.stdout);
  const createLine = lines.find((l) => l.step === 'create');
  assert.deepEqual(createLine.result.model, params.model);
});

test('real-send：--provider 不存在 → 退出码 2，mock 没被 spawn（记录为空）', async () => {
  const { run, recordPath } = await runRealSend({}, ['--provider', 'no-such-plan']);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /no-such-plan/);
  assert.deepEqual(readRecord(recordPath), []); // 评审 T1.3b 第 4 条：参数给错不起子进程
});

test('real-send：--model 不存在 → 退出码 2，mock 没被 spawn（记录为空），不留临时目录', async () => {
  const { run, recordPath } = await runRealSend({}, ['--model', 'no-such-model']);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /no-such-model/);
  assert.deepEqual(readRecord(recordPath), []); // 校验在 mkdtemp / 写个人文件 / spawn 之前，什么都没起
});

test('real-send：requestProviderRuntimeHeaders 应答里的 apiKey 已抹掉（RULES §8 永不落盘）', async () => {
  const { run, recordPath } = await runRealSend({}, []);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  // D14 起 apiKey 不再经 create 的 params 传（selection 里根本没有这个字段），
  // 唯一会出现在线路上的地方是这条反向请求的应答（result.requestAuth.apiKey）
  const headerAnswers = readRecord(recordPath).filter((m) => m.result?.requestAuth !== undefined);
  assert.ok(headerAnswers.length >= 1, '至少答过一次 requestProviderRuntimeHeaders');
  for (const m of headerAnswers) {
    assert.equal(m.result.requestAuth.apiKey, '[REDACTED]'); // 评审 T1.3b 第 6 条：mock 端抹密
  }
  const creates = readRecord(recordPath).filter((m) => m.method === 'session/create');
  assert.equal(JSON.stringify(creates[0].params.model).includes('sk-test-plan'), false); // model 里本就没有 key，双保险
});

test('real-send：--resume 不发 session/create，仍会写个人 provider 文件应答反向请求', async () => {
  const { run, recordPath } = await runRealSend({}, ['--resume', 'sess_resume-t13']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const methods = readRecord(recordPath).map((m) => m.method);
  assert.equal(methods.includes('session/create'), false);
  assert.ok(methods.includes('session/resume'));
});
