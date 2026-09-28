// send --start-plan 与 runner start plan 部分的行为测试（decisions D21，任务 T8）：
// 全部对 test/mock-appserver.mjs 跑，夹具与环境变量见 test/offpeak-fixture.mjs（共用，不起闲时服务器也要起：
// setup 的固定形状）；不碰真网络、不读真实 ~/.zcode。start plan 没有号：没有取号、等号与结算。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRecord, waitFor } from './helpers.mjs';
import {
  assertNoSecrets, cleanupAll, isAlive, lay, readEvents, readJson, runBin, setup, startRunner, TEST_JWT, trackPids, waitRunnerGone,
} from './offpeak-fixture.mjs';

test.after(cleanupAll);

// ---------- 用法错 ----------

test('send --start-plan --steer：用法错，退出码 1，不入队', async (t) => {
  const s = await setup(t, { tier: 'fast' });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--start-plan', '--steer']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--start-plan.*--steer|--steer.*--start-plan/);
});

test('send --offpeak --start-plan：用法错，退出码 1，一次投递只走一条通道', async (t) => {
  const s = await setup(t, { tier: 'fast' });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak', '--start-plan']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--offpeak.*--start-plan|--start-plan.*--offpeak/);
});

// ---------- 前置条件（退出码 2） ----------

test('send --start-plan：会话模型不在 start plan 模型表 → 退出码 2，报模型名与模型表', async (t) => {
  const s = await setup(t, { tier: 'strong' }); // GLM-5.3 不在 start plan 表里
  assert.equal(s.entry.modelId, 'GLM-5.3');
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--start-plan']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /GLM-5\.3 不在 start plan 模型表/);
  assert.match(r.stderr, /GLM-5\.3-Flash、GLM-5\.2、GLM-5-Turbo/);
});

test('send --start-plan：凭据里没有 JWT → 退出码 2，原因原样给', async (t) => {
  const s = await setup(t, { tier: 'fast', credentials: {} });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--start-plan']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /start plan 投递用不了/);
  assert.match(r.stderr, /zcodejwttoken/);
});

test('send --start-plan：内置文件没有 start plan 条目 → 退出码 2，报接口可能变了', async (t) => {
  const s = await setup(t, { tier: 'fast' });
  // 换一份删掉 start plan 条目的内置文件（模拟旧版 App）；文件放 mock 的临时目录里，cleanupAll 统一清
  const stripped = path.join(s.mock.dir, 'zcode-builtin-no-startplan.json');
  const builtin = JSON.parse(readFileSync(s.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, 'utf8'));
  builtin.config.providerConfigRules.providerRules = builtin.config.providerConfigRules.providerRules
    .filter((r) => !String(r.providerId).endsWith('-start-plan'));
  writeFileSync(stripped, JSON.stringify(builtin));
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--start-plan'], {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: stripped,
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /找不到 start plan 条目的模型表/);
});

test('send --start-plan：内置文件环境变量指到不存在的文件 → CLI 启动就报环境问题（退出码 1），轮不到前置检查', async (t) => {
  const s = await setup(t, { tier: 'fast' });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--start-plan'], {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: path.join(os.tmpdir(), `zcode-startplan-missing-${Date.now()}.json`),
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /ZCODE_BUILTIN_PROVIDER_CONFIG_FILE/);
});

// ---------- 正常路径 ----------

test('send --start-plan：入队起 runner，推授权、反向请求答 JWT，回合走 start plan 改道的模型，done', async (t) => {
  const s = await setup(t, { tier: 'fast' }); // GLM-5.3-Flash 在 start plan 表里
  const r = await runBin(s.env, ['send', s.entry.id, 'start plan 的活', '--start-plan', '--wait']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /send: done/);

  const last = readJson(path.join(s.runsDir, 'last.json'));
  assert.equal(last.outcome, 'done', JSON.stringify(last));
  assert.equal(last.text, 'start plan 的活');

  const record = readRecord(s.recordPath);
  const methods = record.map((m) => m.method ?? m.recorded).filter(Boolean);
  // 推授权在 send 之前
  const pushAt = methods.indexOf('provider/updateAccountConfig');
  const sendAt = methods.indexOf('session/send');
  assert.ok(pushAt >= 0 && sendAt > pushAt, methods.join(','));
  const push = record.find((m) => m.method === 'provider/updateAccountConfig').params;
  assert.equal(push.revision.startsWith('zcode-executor-start-plan:'), true);
  assert.equal(push.providers['account:bigmodel-start-plan'].access.entitled, true);
  assert.equal(push.providers['account:bigmodel-start-plan'].access.type, 'zhipu-account');
  assert.deepEqual(push.states['account:bigmodel-start-plan'], { availability: 'available', entitled: true, current: true });

  const sent = record.find((m) => m.method === 'session/send').params;
  assert.equal(sent.content, 'start plan 的活');
  assert.equal(sent.modelSelection.providerId, 'account:bigmodel-start-plan');
  assert.equal(sent.modelSelection.modelId, 'GLM-5.3-Flash');
  assert.match(sent.modelSelection.options.reasoningLevel, /^(low|high|max)$/);
  // execution 作用域：逐回合改道不许落成会话当前模型；memoryExtraction 跳过；没有 requestAuth（鉴权走反向请求）
  assert.deepEqual(sent.modelExecution, { selectionScope: 'execution', memoryExtraction: 'skip' });
  assert.equal(sent.offPeakTaskId, undefined);
  assert.equal(sent.offPeakRunType, undefined);

  // mock 以 start plan 模型来要运行时头，宿主按 providerId 答了 JWT（记录只带长度不落值）
  const headers = record.find((m) => m.recorded === 'runtimeHeaders');
  assert.ok(headers, '记录里该有 runtimeHeaders 条目');
  assert.equal(headers.providerId, 'account:bigmodel-start-plan');
  assert.equal(headers.hasAccountAccess, true);
  assert.equal(headers.headersApplied, true);
  assert.equal(headers.apiKeyLength, TEST_JWT.length);

  // 事件：startplan.started（prepareSend 里，与闲时同序）→ send → result
  const types = readEvents(s.runsDir).map((e) => e.type);
  const at = ['executor.startplan.started', 'executor.send', 'executor.result'].map((type) => types.indexOf(type));
  assert.ok(at.every((i) => i >= 0), types.join(','));
  assert.deepEqual([...at].sort((a, b) => a - b), at, types.join(','));
  const started = readEvents(s.runsDir).find((e) => e.type === 'executor.startplan.started');
  assert.deepEqual(started.providerId, 'account:bigmodel-start-plan');

  // 泄密检查：runs 目录全部文件、输出、mock 记录里都查不到 JWT 与 key
  await assertNoSecrets(s, [r.stdout, r.stderr]);
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
});

test('send --start-plan --json：不带 --wait 时输出 startPlan.providerId', async (t) => {
  const s = await setup(t, { tier: 'fast', script: { hangMethods: ['session/send'] } }); // 挂住回合，测试自己收尾
  const r = await runBin(s.env, ['send', s.entry.id, 'start plan 的活', '--start-plan', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  for (const k of ['id', 'sessionId', 'queued', 'spawned', 'pid']) assert.ok(k in out, k);
  assert.deepEqual(out.startPlan, { providerId: 'account:bigmodel-start-plan' });
  // runner 是 send 刚 detached 起的：等 lock 出现再抓 pid
  await waitFor(() => existsSync(path.join(s.runsDir, 'lock')));
  const { runnerPid, mockPids } = trackPids(s.runsDir);
  assert.ok(runnerPid);
  // runner 取走队列项后 send 真的带 start plan 的 modelSelection
  await waitFor(() => readRecord(s.recordPath).some((m) => m.method === 'session/send'));
  const sent = readRecord(s.recordPath).find((m) => m.method === 'session/send');
  assert.equal(sent.params.modelSelection.providerId, 'account:bigmodel-start-plan');
  // 收尾：停掉 runner 与 mock
  for (const pid of [runnerPid, ...mockPids]) {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('send --start-plan：授权回执对不上 → 投递按 failed 结束，退出码 4', async (t) => {
  const s = await setup(t, { tier: 'fast', script: { accountConfigReply: { receivedRevision: '别的版本' } } });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--start-plan', '--wait']);
  assert.equal(r.status, 4, r.stderr);
  const last = readJson(path.join(s.runsDir, 'last.json'));
  assert.equal(last.outcome, 'failed');
  assert.match(last.reason, /start plan 授权没推成/);
  assert.ok(readEvents(s.runsDir).some((e) => e.type === 'executor.result' && e.outcome === 'failed'));
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
});

test('runner 接手 start plan 项时凭据没了 → 投递按 failed 结束，报凭据问题（send 的前置检查过了才可能撞上）', async (t) => {
  const s = await setup(t, { tier: 'fast' });
  // 手动入队一项 start plan，删掉凭据文件，再起 runner：runner 的 peek 读不到 JWT
  await lay(s, { queue: [{ text: '凭据没了的活', startPlan: { providerId: 'account:bigmodel-start-plan' } }] });
  await rm(path.join(s.env.ZCODE_DATA_BASE_DIR, '.zcode', 'v2', 'credentials.json'));
  await startRunner(s);
  await waitFor(() => existsSync(path.join(s.runsDir, 'last.json')));
  const last = readJson(path.join(s.runsDir, 'last.json'));
  assert.equal(last.outcome, 'failed');
  assert.match(last.reason, /start plan 凭据读不了/);
  assert.match(last.reason, /登录/);
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
  await assertNoSecrets(s, []);
});

test('send：普通投递之后接着 --start-plan（同一会话混用两条通道，普通投递不带 modelSelection）', async (t) => {
  const s = await setup(t, { tier: 'fast' });
  const first = await runBin(s.env, ['send', s.entry.id, '普通投递', '--wait']);
  assert.equal(first.status, 0, first.stderr);
  const second = await runBin(s.env, ['send', s.entry.id, 'start plan 投递', '--start-plan', '--wait']);
  assert.equal(second.status, 0, second.stderr);
  const record = readRecord(s.recordPath);
  const sends = record.filter((m) => m.method === 'session/send');
  assert.equal(sends.length, 2);
  // 第一发没有 modelSelection（普通投递走会话当前模型），第二发改道 start plan
  assert.equal(sends[0].params.modelSelection, undefined);
  assert.equal(sends[1].params.modelSelection.providerId, 'account:bigmodel-start-plan');
  await assertNoSecrets(s, [first.stdout, first.stderr, second.stdout, second.stderr]);
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
});
