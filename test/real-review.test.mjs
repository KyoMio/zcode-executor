// real-review 的零费用 CLI 回归：独立临时 home、合成配置与 mock app-server。
// 不读取真实配置、不访问网络，也不执行固定 Write；只检查确认闸门与审批输出。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, readRecord } from './helpers.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/real-review.mjs', import.meta.url));

async function setup(t, { review = {}, replies = ['Y'] } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-real-review-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const mock = await startMock({ script: { generateText: { replies } } });
  t.after(() => mock.cleanup());
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ review }), { mode: 0o600 });
  const configPath = path.join(home, 'zcode.json');
  await writeFile(configPath, JSON.stringify({ provider: {
    'builtin:test-coding-plan': {
      kind: 'anthropic', options: { apiKey: 'synthetic-provider-key' },
      models: { 'GLM-5.3-Flash': { name: 'GLM 5.3 Flash' } },
    },
  } }));
  // 即使前筛回归到 HTTP，也只记尝试并抛错，绝不发出请求。
  const guard = `import { appendFileSync } from 'node:fs';
    globalThis.fetch = async () => {
      appendFileSync(${JSON.stringify(path.join(home, 'network-attempt'))}, 'fetch');
      throw new Error('测试禁止网络');
    };`;
  const env = {
    ...process.env, ...mock.env, HOME: home, TMPDIR: home,
    ZCODE_EXECUTOR_HOME: home, ZCODE_CONFIG_PATH: configPath, ZCODE_BIN: mock.zcodePath,
    NODE_OPTIONS: '',
  };
  return {
    home, mock,
    run(args) {
      return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(guard)}`, SCRIPT, ...args], {
        cwd: home, env, encoding: 'utf8', timeout: 20_000,
      });
    },
  };
}

test('未给 --yes 时退出并准确说明三级调用上限与 Write 本地 skip', async (t) => {
  const { run, mock, home } = await setup(t);
  const result = run([]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /这次会花额度/);
  assert.match(result.stderr, /最多.*1.*Jev.*逻辑调用.*重试.*0-2.*ZCode/);
  assert.match(result.stderr, /Write.*skip.*0.*Jev/);
  assert.match(result.stderr, /--yes/);
  assert.deepEqual(readRecord(mock.recordPath), []);
  assert.ok(!(await readdir(home)).includes('network-attempt'));
});

test('review.enabled:false 即使 --yes 也在 spawn 和付费前拒绝', async (t) => {
  const { run, mock, home } = await setup(t, { review: { enabled: false, jev: { apiKey: 'synthetic-jev-key' } } });
  const result = run(['--yes']);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /review.enabled.*false.*拒绝/);
  assert.deepEqual(readRecord(mock.recordPath), []);
  assert.ok(!(await readdir(home)).includes('network-attempt'));
});

test('Write 配置 Jev 仅本地 skip，第一笔 ZCode 为快筛、第二笔为慢判', async (t) => {
  const { run, home } = await setup(t, {
    review: { jev: { apiKey: 'synthetic-jev-key' } }, replies: ['N', '结论: allow'],
  });
  const result = run(['--yes']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'allow');
  assert.equal(output.stage, 'review-slow');
  assert.equal(output.calls, 2);
  assert.equal(output.review.preScreen.outcome, 'skip');
  assert.equal(output.review.preScreen.attempts, 0);
  assert.equal(output.review.reviewer, 'zcode');
  assert.match(result.stderr, /第 1 次 ZCode 调用（快筛/);
  assert.match(result.stderr, /第 2 次 ZCode 调用（慢判/);
  assert.match(result.stderr, /不是 Jev HTTP.*测量/);
  assert.ok(!(await readdir(home)).includes('network-attempt'));
});

test('无 Jev 配置保留 ZCode 快筛且 preScreen 为空', async (t) => {
  const { run, home } = await setup(t);
  const result = run(['--yes']);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'allow');
  assert.equal(output.calls, 1);
  assert.equal(output.review.preScreen, null);
  assert.match(result.stderr, /第 1 次 ZCode 调用（快筛/);
  assert.ok(!(await readdir(home)).includes('network-attempt'));
});
