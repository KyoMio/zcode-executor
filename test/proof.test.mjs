// Proof Manifest / 断点续跑 / investigate 止损的纯函数与采集落盘测试（ZCE-8/9/10）。
// 覆盖：解析（文件 JSON 与消息围栏两条路、畸形形状剔除）、脱敏、旧证据不冒充新证据、
// 检查点归档、续跑命令生成条件、止损阈值判定。mock 全链路（落盘proof/超时续跑/status 止损）在 run.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveCheckpoint,
  collectProof,
  investigateSteerHint,
  parseProofFromMessage,
  parseProofText,
  proofSummaryOf,
  resumeHintFor,
  worktreeHasChanges,
} from '../lib/proof.mjs';
import { execFileSync } from 'node:child_process';

const dirs = [];
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'zcode-proof-'));
  dirs.push(root);
  const cwd = path.join(root, 'wt');
  const dir = path.join(root, 'runs', 'x_test0001');
  await mkdir(cwd, { recursive: true });
  await mkdir(dir, { recursive: true });
  return { cwd, dir };
}

// ---------- parseProofText：形状体检 ----------

test('parseProofText：合法证据原样通过，畸形命令逐项剔除', () => {
  const good = parseProofText(JSON.stringify({
    commands: [
      { cmd: 'npm test', exitCode: 0, summary: '847 passed' },
      { cmd: 'npm run lint', exitCode: 1 }, // summary 可缺省
      { cmd: '', exitCode: 0 }, // 空 cmd：剔除
      { cmd: 'x' }, // 缺 exitCode：剔除
      { cmd: 'x', exitCode: '0' }, // exitCode 不是整数：剔除
      'not-an-object', // 非对象：剔除
    ],
    artifacts: ['out/a.png', 42, 'out/b.log'], // 非字符串剔除
    unverified: ['没跑真机', null],
    prematureStop: true,
  }));
  assert.equal(good.commands.length, 2);
  assert.equal(good.commands[0].summary, '847 passed');
  assert.equal(good.commands[1].summary, ''); // 缺省补空串
  assert.deepEqual(good.artifacts, ['out/a.png', 'out/b.log']);
  assert.deepEqual(good.unverified, ['没跑真机']);
  assert.equal(good.prematureStop, true);

  assert.equal(parseProofText('not json at all'), null); // 坏 JSON
  assert.equal(parseProofText('{"commands": "not-array"}'), null); // commands 不是数组整体无效
  assert.equal(parseProofText('[1,2,3]'), null); // 顶层是数组：不是证据对象
  assert.equal(parseProofText('"just a string"'), null);
});

test('parseProofText：prematureStop 只认 true 字面量，truthy 字符串不算', () => {
  const proof = parseProofText(JSON.stringify({ commands: [], prematureStop: 'yes' }));
  assert.equal(proof.prematureStop, false); // 模糊值不收：提前收手必须是明确自报
});

// ---------- parseProofFromMessage：回复围栏兜底 ----------

test('parseProofFromMessage：取最后一个 executor-proof 围栏，普通 json 围栏不认', () => {
  const text = [
    '做完了。',
    '```executor-proof',
    JSON.stringify({ commands: [{ cmd: 'npm test', exitCode: 1, summary: 'early draft' }] }),
    '```',
    '中间说了一堆',
    '```json', // 普通 json 围栏不算数
    '{"commands": []}',
    '```',
    '最终版：',
    '```executor-proof',
    JSON.stringify({ commands: [{ cmd: 'npm test', exitCode: 0, summary: 'all green' }], prematureStop: false }),
    '```',
  ].join('\n');
  const proof = parseProofFromMessage(text);
  assert.equal(proof.commands[0].exitCode, 0); // 最后一个围栏生效
  assert.equal(parseProofFromMessage('没有围栏的回复'), null);
  assert.equal(parseProofFromMessage('```executor-proof\n{bad json\n```'), null);
  assert.equal(parseProofFromMessage(null), null);
});

// ---------- collectProof：落盘与脱敏 ----------

test('collectProof：工作区文件优先落盘 proof.json，密钥按值抹掉', async () => {
  const { cwd, dir } = await fixture();
  await writeFile(path.join(cwd, '.executor-proof.json'), JSON.stringify({
    commands: [{ cmd: 'curl -H "Authorization: Bearer sk-livekey-12345678" api', exitCode: 0, summary: 'ok' }],
    artifacts: ['shot.png'],
    unverified: [],
    prematureStop: false,
  }));
  const proof = collectProof({ cwd, dir, messageText: '', secrets: ['sk-livekey-12345678'] });
  assert.equal(proof.commands.length, 1);
  assert.equal(proof.commands[0].cmd.includes('sk-livekey-12345678'), false);
  assert.match(proof.commands[0].cmd, /<redacted>/);
  const disk = JSON.parse(readFileSync(path.join(dir, 'proof.json'), 'utf8'));
  assert.equal(disk.source, 'workspace-file');
  assert.equal(disk.commands[0].cmd.includes('sk-livekey-12345678'), false);
  assert.ok(disk.collectedAt);
});

test('collectProof：工作区没文件时从最终回复围栏兜底，source 记 message-fence', async () => {
  const { cwd, dir } = await fixture();
  const message = `做完了\n\`\`\`executor-proof\n${JSON.stringify({ commands: [{ cmd: 'npm test', exitCode: 0, summary: 'x' }] })}\n\`\`\``;
  const proof = collectProof({ cwd, dir, messageText: message, secrets: [] });
  assert.equal(proof.commands[0].cmd, 'npm test');
  const disk = JSON.parse(readFileSync(path.join(dir, 'proof.json'), 'utf8'));
  assert.equal(disk.source, 'message-fence');
});

test('collectProof：两处都没有证据时删除残留——上一回合的证据不冒充本回合', async () => {
  const { cwd, dir } = await fixture();
  // 先落一份真证据（上一回合）
  await writeFile(path.join(cwd, '.executor-proof.json'), JSON.stringify({ commands: [{ cmd: 't', exitCode: 0 }] }));
  collectProof({ cwd, dir, messageText: '', secrets: [] });
  assert.ok(existsSync(path.join(dir, 'proof.json')));
  // 本回合：工作区文件被清理（或没写），回复里也没有 → proof.json 必须跟着清掉
  await rm(path.join(cwd, '.executor-proof.json'));
  const proof = collectProof({ cwd, dir, messageText: '做完了但没写证据', secrets: [] });
  assert.equal(proof, null);
  assert.equal(existsSync(path.join(dir, 'proof.json')), false);
});

test('collectProof：文件是畸形 JSON 时回落到消息围栏，而不是放弃', async () => {
  const { cwd, dir } = await fixture();
  await writeFile(path.join(cwd, '.executor-proof.json'), '{broken');
  const message = `\`\`\`executor-proof\n${JSON.stringify({ commands: [{ cmd: 'npm test', exitCode: 0 }] })}\n\`\`\``;
  const proof = collectProof({ cwd, dir, messageText: message, secrets: [] });
  assert.equal(proof.commands.length, 1); // 文件坏了不挡路，消息兜底接上
});

test('collectProof：cwd 或 dir 不存在不外抛，返回 null 不砸结算', async () => {
  const proof = collectProof({ cwd: '/nonexistent-wt-xyz', dir: '/nonexistent-runs-xyz', messageText: '', secrets: [] });
  assert.equal(proof, null);
});

// ---------- proofSummaryOf ----------

test('proofSummaryOf：折算计数，坏文件/没有文件为 null', async () => {
  const { dir } = await fixture();
  assert.equal(proofSummaryOf(dir), null); // 文件不存在
  await writeFile(path.join(dir, 'proof.json'), 'broken{');
  assert.equal(proofSummaryOf(dir), null); // 坏 JSON
  await writeFile(path.join(dir, 'proof.json'), JSON.stringify({
    commands: [
      { cmd: 'a', exitCode: 0 },
      { cmd: 'b', exitCode: 1 },
      { cmd: 'c', exitCode: 2 },
    ],
    artifacts: ['x.png'],
    unverified: ['没验 A', '没验 B'],
    prematureStop: false,
  }));
  assert.deepEqual(proofSummaryOf(dir), { commands: 3, failed: 2, artifacts: 1, unverified: 2, prematureStop: false });
});

// ---------- archiveCheckpoint ----------

test('archiveCheckpoint：工作区有就复制进 runs，没有返回 null 且不动已有归档', async () => {
  const { cwd, dir } = await fixture();
  assert.equal(archiveCheckpoint({ cwd, dir }), null); // 工作区没有
  await writeFile(path.join(dir, 'checkpoint.md'), '上一回合的旧断点');
  assert.equal(archiveCheckpoint({ cwd, dir }), null);
  assert.equal(readFileSync(path.join(dir, 'checkpoint.md'), 'utf8'), '上一回合的旧断点'); // 不被清掉
  await writeFile(path.join(cwd, '.executor-checkpoint.md'), '已完成 A\n未完成 B');
  const dst = archiveCheckpoint({ cwd, dir });
  assert.equal(dst, path.join(dir, 'checkpoint.md'));
  assert.equal(readFileSync(dst, 'utf8'), '已完成 A\n未完成 B'); // 新断点覆盖旧的
});

// ---------- resumeHintFor ----------

test('resumeHintFor：改动或断点有其一才给命令，带上任务单路径，路径含空格引号安全', () => {
  assert.equal(resumeHintFor({ sessionId: 'x_a', task: null, checkpointPath: null, hasChanges: false }), null); // 啥都没有不值得续
  const withCheckpoint = resumeHintFor({ sessionId: 'x_a', task: '/wt/tasks/T-1.md', checkpointPath: '/home/runs/x_a/checkpoint.md', hasChanges: false });
  assert.match(withCheckpoint, /^zcode-executor send x_a '/);
  assert.match(withCheckpoint, /先读 \/home\/runs\/x_a\/checkpoint\.md/);
  assert.match(withCheckpoint, /--task '\/wt\/tasks\/T-1\.md'$/);
  const noCheckpoint = resumeHintFor({ sessionId: 'x_a', task: null, checkpointPath: null, hasChanges: true });
  assert.match(noCheckpoint, /先查 git status/);
  assert.equal(noCheckpoint.includes('--task'), false); // 没有任务单不带
  const spaced = resumeHintFor({ sessionId: 'x_a', task: '/wt/my tasks/T-1.md', checkpointPath: null, hasChanges: true });
  assert.match(spaced, /--task '\/wt\/my tasks\/T-1\.md'/); // 空格路径被引号包住，整行可复制
});

// ---------- worktreeHasChanges ----------

test('worktreeHasChanges：git 仓库按 porcelain 判定，非仓库/不存在为 false', async (t) => {
  const { cwd } = await fixture();
  execFileSync('git', ['init', '--quiet', cwd]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd });
  assert.equal(worktreeHasChanges(cwd), false); // 干净
  await writeFile(path.join(cwd, 'untracked.txt'), 'x'); // 未跟踪也算改动（执行端新写的文件）
  assert.equal(worktreeHasChanges(cwd), true);
  assert.equal(worktreeHasChanges('/nonexistent-xyz'), false);
  const plain = await mkdtemp(path.join(os.tmpdir(), 'zcode-proof-plain-'));
  dirs.push(plain);
  assert.equal(worktreeHasChanges(plain), false); // 存在但不是仓库
});

// ---------- investigateSteerHint ----------

test('investigateSteerHint：超阈值给可复制 steer 命令，类型不符/没超时/缺字段为 null', () => {
  const nowMs = Date.parse('2026-11-27T10:00:00Z');
  const running = (taskType, startedAt) => ({ current: { text: '查 bug', startedAt, taskType } });
  const started1000sAgo = new Date(nowMs - 1000 * 1000).toISOString();

  const hint = investigateSteerHint({ state: running('investigate', started1000sAgo), sessionId: 'x_inv0001', nowMs, thresholdSec: 900 });
  assert.equal(hint.taskType, 'investigate');
  assert.equal(hint.elapsedSec, 1000);
  assert.match(hint.command, /^zcode-executor send x_inv0001 '.+' --steer$/);
  assert.match(hint.command, /停止继续打补丁/);
  assert.match(hint.command, /最小复现/);

  assert.equal(investigateSteerHint({ state: running('feature', started1000sAgo), sessionId: 'x_a', nowMs, thresholdSec: 900 }), null); // feature 无止损
  assert.equal(investigateSteerHint({ state: running('bugfix', started1000sAgo), sessionId: 'x_a', nowMs, thresholdSec: 900 }), null);
  const started500sAgo = new Date(nowMs - 500 * 1000).toISOString();
  assert.equal(investigateSteerHint({ state: running('investigate', started500sAgo), sessionId: 'x_a', nowMs, thresholdSec: 900 }), null); // 还没到点
  assert.equal(investigateSteerHint({ state: running('investigate', 'bad-date'), sessionId: 'x_a', nowMs, thresholdSec: 900 }), null); // 坏时间戳
  assert.equal(investigateSteerHint({ state: { current: null }, sessionId: 'x_a', nowMs, thresholdSec: 900 }), null); // 没在跑
  assert.equal(investigateSteerHint({ state: running(null, started1000sAgo), sessionId: 'x_a', nowMs, thresholdSec: 900 }), null); // 没标类型
});
