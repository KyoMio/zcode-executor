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

// 起 mock、写好 MOCK_* 环境变量，spawnSync 跑 real-send；返回结果和各路径
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

test('real-send：create 带 runtimeModel，provider/model 自洽且 mock 回显一致', async () => {
  // 自洽断言（评审 T1.3b 第 3 条）：不依赖本机 config 里有哪些 provider/model
  const { run, recordPath } = await runRealSend({}, []);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const creates = readRecord(recordPath).filter((m) => m.method === 'session/create');
  assert.equal(creates.length, 1);
  const rm = creates[0].params.runtimeModel;
  assert.ok(rm, 'create 要带 runtimeModel');
  const lines = parseLines(run.stdout);
  const push = lines.find((l) => l.step === 'updateProviderRegistry');
  assert.ok(push.providerIds.includes(rm.model.providerId)); // 选的 provider 确实推过表
  assert.equal(rm.provider.providerId, rm.model.providerId); // provider 定义与 model ref 同一家
  assert.ok(rm.provider.models.some((m) => m.modelId === rm.model.modelId)); // 模型确实在该 provider 下
  assert.equal(rm.provider.apiKey?.source, 'inline'); // provider 原样带内联 key（值已在记录里抹掉）
  assert.match(rm.revision, /^[0-9a-f]{8}$/);
  // mock 回显：settings.model.current 是 runtimeModel 指定的 ref，stdout 的 create 行带出来
  const createLine = lines.find((l) => l.step === 'create');
  assert.deepEqual(createLine.result.model, rm.model);
});

test('real-send：--provider 不存在 → 退出码 2，mock 没被 spawn（记录为空）', async () => {
  const { run, recordPath } = await runRealSend({}, ['--provider', 'no-such-plan']);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /no-such-plan/);
  assert.deepEqual(readRecord(recordPath), []); // 评审 T1.3b 第 4 条：参数给错不起子进程
});

test('real-send：--model 不存在 → 退出码 2，mock 没被 spawn（记录为空）', async () => {
  const { run, recordPath } = await runRealSend({}, ['--model', 'no-such-model']);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /no-such-model/);
  assert.deepEqual(readRecord(recordPath), []);
});

test('real-send：mock 记录里的 apiKey 值已抹掉（RULES §8 永不落盘）', async () => {
  const { run, recordPath } = await runRealSend({}, []);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const pushes = readRecord(recordPath).filter((m) => m.method === 'workspace/updateProviderRegistry');
  assert.ok(pushes.length >= 1);
  const withKey = pushes[0].params.registry.providers.filter((p) => p.apiKey !== undefined);
  assert.ok(withKey.length >= 1, '至少一个 provider 带内联 key');
  for (const p of withKey) {
    assert.equal(p.apiKey.value, '[REDACTED]'); // 评审 T1.3b 第 6 条：mock 端抹密
  }
  const creates = readRecord(recordPath).filter((m) => m.method === 'session/create');
  assert.equal(creates[0].params.runtimeModel.provider.apiKey.value, '[REDACTED]');
});

test('real-send：--resume 不发 session/create、不带 runtimeModel（verified）', async () => {
  const { run, recordPath } = await runRealSend({}, ['--resume', 'sess_resume-t13']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const methods = readRecord(recordPath).map((m) => m.method);
  assert.equal(methods.includes('session/create'), false);
  assert.ok(methods.includes('session/resume'));
});
