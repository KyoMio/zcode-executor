// send --offpeak 与 runner 闲时部分的行为测试（SPEC-offpeak A、B、E 的正常路径，任务 OP4）：
// 全部对 test/mock-appserver.mjs 与 test/mock-offpeak.mjs 跑，夹具与环境变量见 test/offpeak-fixture.mjs；
// 不碰真网络、不读真实 ~/.zcode。号失效重取、续跑与结算重试在 test/offpeak-retake.test.mjs（任务 OP5）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readRecord, waitFor } from './helpers.mjs';
import {
  assertNoSecrets, cleanupAll, isAlive, lay, offPeakJson, readEvents, readJson, runBin, runnerLog, settleRequests, setup,
  startRunner, takeTicket, TEST_JWT, trackPids, waitRunnerGone, ZCODE_CONFIG,
} from './offpeak-fixture.mjs';

test.after(cleanupAll);


// ---------- 前置条件 ----------

test('send --offpeak --steer：用法错，退出码 1，不取号', async (t) => {
  const s = await setup(t);
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak', '--steer']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--offpeak.*--steer|--steer.*--offpeak/);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：runner 活着 → 退出码 2，说要等会话空闲，不取号', async (t) => {
  const s = await setup(t);
  await mkdir(s.runsDir, { recursive: true });
  await writeFile(path.join(s.runsDir, 'lock'), JSON.stringify({ pid: process.pid })); // 本测试进程当作活着的 runner
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^send: .*空闲/m);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：队列非空 → 退出码 2，不取号', async (t) => {
  const s = await setup(t);
  await mkdir(path.join(s.runsDir, 'queue'), { recursive: true });
  await writeFile(path.join(s.runsDir, 'queue', '2026-01-01T00-00-00.000Z-1-aaaa.json'), JSON.stringify({ text: '排着的', steer: false }));
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /空闲/);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：会话模型不在闲时模型表 → 退出码 2，报模型名', async (t) => {
  const s = await setup(t, { provider: 'builtin:other' });
  assert.equal(s.entry.modelId, 'GLM-4.6');
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /GLM-4\.6/);
  assert.match(r.stderr, /闲时模型/);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：凭据里没有 JWT → 退出码 2，原因原样给', async (t) => {
  const s = await setup(t, { credentials: {} });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /zcodejwttoken/);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：只有团队版 → 退出码 2「团队版暂不支持」', async (t) => {
  const s = await setup(t, { credentials: { jwt: TEST_JWT, individual: false, team: true } });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /团队版暂不支持/);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：取号 3103 → 退出码 2，带本地时间「以后可再取」，不入队不起 runner', async (t) => {
  const s = await setup(t, { offpeak: { quotaExhaustedCount: 1 } });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /额度用完/);
  assert.match(r.stderr, /\d{1,2}:\d{2}:\d{2}.*以后可再取/);
  assert.equal(existsSync(path.join(s.runsDir, 'offpeak.json')), false);
  assert.equal(existsSync(path.join(s.runsDir, 'lock')), false);
  const queued = existsSync(path.join(s.runsDir, 'queue')) ? await readdir(path.join(s.runsDir, 'queue')) : [];
  assert.deepEqual(queued, []);
});

test('send --offpeak：取号 3101 → 退出码 2「没有闲时资格」', async (t) => {
  const s = await setup(t, { offpeak: { eligible: false } });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /没有闲时资格/);
});

test('send --offpeak：会话的 provider 已不在 provider 表里 → 退出码 2，不取号', async (t) => {
  const s = await setup(t);
  const { 'builtin:bigmodel-coding-plan': _gone, ...rest } = ZCODE_CONFIG.provider;
  await writeFile(s.zcodeConfigPath, JSON.stringify({ provider: rest }));
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /builtin:bigmodel-coding-plan.*不在 provider 表里/);
  assert.equal(s.server.requests.length, 0);
  assert.equal(existsSync(path.join(s.runsDir, 'offpeak.json')), false);
});

// ---------- 正常路径 ----------

test('send --offpeak --json：取号入队、等号就绪才起 app-server，推授权后带闲时参数开跑，回合 done 后结算', async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 1500 } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  // 原有字段照旧，另加 offpeak
  for (const k of ['id', 'sessionId', 'queued', 'spawned', 'pid']) assert.ok(k in out, k);
  assert.equal(out.queued, 1);
  assert.equal(out.spawned, true);
  assert.match(out.offpeak.offPeakId, /^offpeak-[0-9a-f-]{36}$/);
  assert.equal(out.offpeak.ticketId, 'mock-ticket-1');
  assert.equal(out.offpeak.position, 1);
  // 取号时 task_id 就是 offPeakId
  assert.deepEqual(s.server.requests[0].body, { task_id: out.offpeak.offPeakId });

  // offpeak.json 起始形状（SPEC-offpeak E）：不含凭据，时间是 ISO 字符串
  const initial = readJson(path.join(s.runsDir, 'offpeak.json'));
  assert.equal(initial.offPeakId, out.offpeak.offPeakId);
  assert.equal(initial.ticketId, 'mock-ticket-1');
  assert.equal(initial.ticketCount, 1);
  assert.equal(initial.phase, 'queued');
  assert.equal(initial.position, 1);
  assert.match(initial.updatedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  // 队列项带 offpeak
  const queueFiles = await readdir(path.join(s.runsDir, 'queue'));
  assert.equal(queueFiles.length, 1);
  const item = readJson(path.join(s.runsDir, 'queue', queueFiles[0]));
  assert.equal(item.text, '闲时的活');
  assert.deepEqual(item.offpeak, { offPeakId: out.offpeak.offPeakId });

  // 排号期间 runner 在轮询，app-server 还没起：记录文件里一条消息都没有
  await waitFor(() => s.server.requests.filter((q) => q.path.endsWith('/ticket/status')).length >= 4);
  trackPids(s.runsDir);
  assert.deepEqual(readRecord(s.recordPath), [], '号没就绪前不该起 app-server');
  assert.doesNotMatch(runnerLog(s), /mock: started/, '号没就绪前 runner.log 里不该有 mock 的启动行');

  await waitFor(() => existsSync(path.join(s.runsDir, 'last.json')), { timeoutMs: 30000 });
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
  const found = trackPids(s.runsDir);

  const last = readJson(path.join(s.runsDir, 'last.json'));
  assert.equal(last.outcome, 'done', JSON.stringify(last));
  assert.equal(last.text, '闲时的活');

  // 推授权在 send 之前，send 带全部闲时参数
  const record = readRecord(s.recordPath);
  const methods = record.map((m) => m.method).filter(Boolean);
  const pushAt = methods.indexOf('provider/updateAccountConfig');
  const sendAt = methods.indexOf('session/send');
  assert.ok(pushAt >= 0 && sendAt > pushAt, methods.join(','));
  const push = record.find((m) => m.method === 'provider/updateAccountConfig').params;
  assert.equal(push.providers['account:bigmodel-offpeak-idle-plan'].access.entitled, true);
  const sent = record.find((m) => m.method === 'session/send').params;
  assert.equal(sent.content, '闲时的活');
  assert.equal(sent.modelSelection.providerId, 'account:bigmodel-offpeak-idle-plan');
  assert.equal(sent.modelSelection.modelId, 'GLM-5.3');
  assert.equal(sent.modelSelection.options.reasoningLevel, 'high');
  assert.equal(sent.modelExecution.requestAuth.headers['X-Off-Peak-Ticket-ID'], 'mock-ticket-1');
  assert.equal(sent.offPeakTaskId, out.offpeak.offPeakId);
  assert.equal(sent.offPeakRunType, 'init');
  assert.ok(sent.toolDenylist.includes('CronCreate'));
  assert.ok(sent.toolDenylist.includes('OffPeakCreate'));

  // 号结算过
  assert.ok(s.server.requests.some((q) => q.path === '/api/v1/off-peak/ticket/mock-ticket-1/settle'));
  const final = readJson(path.join(s.runsDir, 'offpeak.json'));
  assert.equal(final.phase, 'done');
  assert.match(final.settledAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.deepEqual(final.unsettledTickets, []);

  // 事件齐全、顺序对：taken → ready → started → result → settled
  const types = readEvents(s.runsDir).map((e) => e.type);
  const order = ['executor.offpeak.taken', 'executor.offpeak.ready', 'executor.offpeak.started', 'executor.result', 'executor.offpeak.settled'];
  const at = order.map((type) => types.indexOf(type));
  assert.ok(at.every((i) => i >= 0), types.join(','));
  assert.deepEqual([...at].sort((a, b) => a - b), at, types.join(','));
  const taken = readEvents(s.runsDir).find((e) => e.type === 'executor.offpeak.taken');
  assert.deepEqual({ offPeakId: taken.offPeakId, ticketId: taken.ticketId, position: taken.position }, out.offpeak);

  // 泄密检查：runs 目录全部文件、输出、mock 记录里都查不到 JWT 与 key
  await assertNoSecrets(s, [r.stdout, r.stderr]);

  // 不残留子进程，个人 provider 文件删干净
  await waitFor(() => !isAlive(found.runnerPid));
  assert.ok(found.mockPids.length >= 1);
  await waitFor(() => found.mockPids.every((pid) => !isAlive(pid)));
  assert.deepEqual(await readdir(s.tmp), []);

  // 闲时投递结束后普通 send 真的放行：实际跑一回合
  const plain = await runBin(s.env, ['send', s.entry.id, '普通的活', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).outcome, 'done');
  const plainSend = readRecord(s.recordPath).filter((m) => m.method === 'session/send').at(-1).params;
  assert.equal(plainSend.content, '普通的活');
  assert.equal(plainSend.modelSelection, undefined, '普通投递不带闲时参数');
  await waitRunnerGone(s.runsDir);
});

test('send --offpeak --wait：等到回合结果，退出码 0，普通 --wait 输出', async (t) => {
  const s = await setup(t);
  const r = await runBin(s.env, ['send', s.entry.id, '等结果的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kind, 'last');
  assert.equal(out.outcome, 'done');
  await waitRunnerGone(s.runsDir);
  assert.equal(readJson(path.join(s.runsDir, 'offpeak.json')).phase, 'done');
});

test('闲时投递期间：排号时普通 send 与 --steer 都拒（2）；运行中 --steer 被接受，普通 send 仍拒', async (t) => {
  const s = await setup(t, {
    offpeak: { readyDelayMs: 1500 },
    // 回合拖 4 秒，留出运行中插话的窗口
    script: { turns: [{ events: [
      { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'a' }, delayMs: 2000 },
      { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'b' }, delayMs: 2000 },
    ] }] },
  });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^send: 已取号，排第 1 位（闲时投递 offpeak-[0-9a-f-]{36}）\n$/);
  trackPids(s.runsDir);

  const plain = await runBin(s.env, ['send', s.entry.id, '插队的活']);
  assert.equal(plain.status, 2, plain.stderr);
  assert.match(plain.stderr, /这条会话有闲时投递在排号或运行，先 cancel 或另开会话/);
  const steerQueued = await runBin(s.env, ['send', s.entry.id, '插话', '--steer']);
  assert.equal(steerQueued.status, 2, steerQueued.stderr);

  await waitFor(() => readJson(path.join(s.runsDir, 'offpeak.json')).phase === 'running', { timeoutMs: 30000 });
  trackPids(s.runsDir);
  const plainRunning = await runBin(s.env, ['send', s.entry.id, '插队的活']);
  assert.equal(plainRunning.status, 2, plainRunning.stderr);
  const steer = await runBin(s.env, ['send', s.entry.id, '顺便补个测试', '--steer']);
  assert.equal(steer.status, 0, steer.stderr);
  await waitFor(() => readEvents(s.runsDir).some((e) => e.type === 'executor.steer' && e.text === '顺便补个测试'));
  await waitFor(() => existsSync(path.join(s.runsDir, 'last.json')), { timeoutMs: 30000 });
  await waitRunnerGone(s.runsDir);
  assert.equal(readJson(path.join(s.runsDir, 'last.json')).outcome, 'done');
  // 闲时投递结束后普通 send 放行
  assert.equal(readJson(path.join(s.runsDir, 'offpeak.json')).phase, 'done');
});

// ---------- 评审返工：陈旧记录、竞争、暂时性失败、失败路径 ----------

test('排号中 cancel 之后，runner 收摊，普通 send 能正常投递（offpeak.json 是陈旧记录）', async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 60000 } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => s.server.requests.some((q) => q.path.endsWith('/ticket/status')));
  trackPids(s.runsDir);
  const cancel = await runBin(s.env, ['cancel', s.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitRunnerGone(s.runsDir);
  assert.equal(readJson(path.join(s.runsDir, 'offpeak.json')).phase, 'done'); // 排号中 cancel 结算号并收尾（OP6）
  const plain = await runBin(s.env, ['send', s.entry.id, '普通的活', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(JSON.parse(plain.stdout).outcome, 'done');
  await waitRunnerGone(s.runsDir);
  await assertNoSecrets(s, [r.stdout, r.stderr, plain.stdout, plain.stderr]);
});

test('队列里普通项之后跟着闲时项：闲时项回外层重新等号，另起一条连接开跑', async (t) => {
  const s = await setup(t);
  const offPeakId = 'offpeak-00000000-0000-4000-8000-000000000001';
  const ticket = await takeTicket(s, offPeakId);
  await lay(s, {
    offpeak: offPeakJson(offPeakId, ticket.ticket_id),
    queue: [{ text: '先来的普通活' }, { text: '闲时的活', offpeak: { offPeakId } }],
  });
  await startRunner(s);
  await waitFor(() => existsSync(path.join(s.runsDir, 'last.json')) && readJson(path.join(s.runsDir, 'last.json')).text === '闲时的活', { timeoutMs: 30000 });
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(readJson(path.join(s.runsDir, 'last.json')).outcome, 'done');
  assert.equal([...runnerLog(s).matchAll(/mock: started/g)].length, 2, '闲时项要另起一条连接');
  const types = readEvents(s.runsDir).map((e) => e.type);
  const firstResult = types.indexOf('executor.result');
  assert.ok(firstResult >= 0 && firstResult < types.indexOf('executor.offpeak.ready'), types.join(','));
  assert.ok(types.indexOf('executor.offpeak.ready') < types.indexOf('executor.offpeak.started'), types.join(','));
  const sends = readRecord(s.recordPath).filter((m) => m.method === 'session/send').map((m) => m.params);
  assert.equal(sends.length, 2);
  assert.equal(sends[0].modelSelection, undefined);
  assert.equal(sends[1].offPeakTaskId, offPeakId);
  assert.equal(readJson(path.join(s.runsDir, 'offpeak.json')).phase, 'done');
  await assertNoSecrets(s);
});

test('offpeak.json 属于另一次闲时投递：这条按 failed 结束，不结算、不碰 offpeak.json', async (t) => {
  const s = await setup(t);
  const other = offPeakJson('offpeak-00000000-0000-4000-8000-00000000000a', 'mock-ticket-99');
  await lay(s, { offpeak: other, queue: [{ text: '闲时的活', offpeak: { offPeakId: 'offpeak-00000000-0000-4000-8000-00000000000b' } }] });
  await startRunner(s);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(readJson(path.join(s.runsDir, 'last.json')).outcome, 'failed');
  assert.deepEqual(settleRequests(s), []);
  assert.deepEqual(readJson(path.join(s.runsDir, 'offpeak.json')), other);
  await assertNoSecrets(s);
});

test('闲时项重投次数用完：按 failed 结束，结算号，offpeak.json 收成 done', async (t) => {
  const s = await setup(t);
  const offPeakId = 'offpeak-00000000-0000-4000-8000-000000000002';
  const ticket = await takeTicket(s, offPeakId);
  await lay(s, { offpeak: offPeakJson(offPeakId, ticket.ticket_id), queue: [{ text: '闲时的活', offpeak: { offPeakId }, attempts: 2 }] });
  await startRunner(s);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  const last = readJson(path.join(s.runsDir, 'last.json'));
  assert.equal(last.outcome, 'failed');
  assert.match(last.reason, /重投/);
  assert.deepEqual(settleRequests(s).map((q) => q.path), [`/api/v1/off-peak/ticket/${ticket.ticket_id}/settle`]);
  const op = readJson(path.join(s.runsDir, 'offpeak.json'));
  assert.equal(op.phase, 'done');
  assert.match(op.settledAt, /Z$/);
  await assertNoSecrets(s);
});

test('等号时查排位暂时不可用（5xx）：stderr 每次一行，按封顶间隔继续轮询，最后照常开跑', async (t) => {
  const s = await setup(t, { offpeak: { failRoute: { status: { status: 503, times: 3 } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, 'done');
  await waitRunnerGone(s.runsDir);
  assert.equal([...runnerLog(s).matchAll(/^runner: 等号时查排位暂时失败/gm)].length, 3);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('等号时查排位连续不可用超过上限：投递以 failed 结束', async (t) => {
  const s = await setup(t, { offpeak: { failRoute: { status: { status: 503 } } }, envExtra: { ZCODE_EXECUTOR_OFFPEAK_STATUS_GIVEUP_MS: '500' } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  assert.match(JSON.parse(r.stdout).reason, /连续失败/);
  await waitRunnerGone(s.runsDir);
  assert.deepEqual(readRecord(s.recordPath), []);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('等号时查排位返回接口变了（404）：投递立刻以 failed 结束', async (t) => {
  const s = await setup(t, { offpeak: { failRoute: { status: { status: 404 } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  assert.match(JSON.parse(r.stdout).reason, /查排位失败/);
  await waitRunnerGone(s.runsDir);
  assert.deepEqual(readRecord(s.recordPath), []);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('updateAccountConfig 被拒：投递以 failed 结束，不发 session/send，号照样结算', async (t) => {
  const s = await setup(t, { script: { errors: { 'provider/updateAccountConfig': { code: -32602, message: 'invalid account config' } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  assert.match(JSON.parse(r.stdout).reason, /闲时授权没推成/);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(readRecord(s.recordPath).some((m) => m.method === 'session/send'), false);
  assert.equal(settleRequests(s).length, 1);
  assert.equal(readJson(path.join(s.runsDir, 'offpeak.json')).phase, 'done');
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('updateAccountConfig 回执 revision 对不上：投递以 failed 结束', async (t) => {
  const s = await setup(t, { script: { accountConfigReply: { receivedRevision: 'zcode-executor-offpeak:0' } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  assert.match(JSON.parse(r.stdout).reason, /回执对不上/);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(readRecord(s.recordPath).some((m) => m.method === 'session/send'), false);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('结算一直失败：回合照样 done，退避重试 3 次后号记进 offpeak.json 的 unsettledTickets、phase 为 done，stderr 一行', async (t) => {
  const s = await setup(t, { offpeak: { failRoute: { settle: { status: 500 } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, 'done');
  await waitRunnerGone(s.runsDir);
  const op = readJson(path.join(s.runsDir, 'offpeak.json'));
  assert.equal(op.phase, 'done');
  assert.equal(op.unsettledTickets.length, 1);
  assert.equal(op.unsettledTickets[0].ticketId, 'mock-ticket-1');
  assert.match(op.unsettledTickets[0].error, /结算失败/);
  assert.match(op.unsettledTickets[0].at, /Z$/);
  assert.equal(op.settledAt, null);
  assert.equal(settleRequests(s).length, 4, '首次 + 退避重试 3 次');
  assert.equal([...runnerLog(s).matchAll(/^runner: 闲时号 mock-ticket-1 结算失败/gm)].length, 1, '重试用完才打一行');
  assert.equal(readEvents(s.runsDir).some((e) => e.type === 'executor.offpeak.settled'), false);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('回合 exited：队列项保留给下个 runner，号不结算', async (t) => {
  const s = await setup(t, { script: { exitAfter: 'session/send' } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(readJson(path.join(s.runsDir, 'last.json')).outcome, 'exited');
  assert.equal((await readdir(path.join(s.runsDir, 'queue'))).length, 1);
  assert.deepEqual(settleRequests(s), []);
  assert.equal(readJson(path.join(s.runsDir, 'offpeak.json')).phase, 'running');
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});
