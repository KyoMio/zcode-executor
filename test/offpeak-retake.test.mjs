// 闲时投递的失败路径（SPEC-offpeak B.1、B.3、B.4、C，任务 OP5）：号失效重取（就绪前、运行中）、续跑提示与
// offPeakRunType:"resume"、重取上限、重取被服务器拒、exited 后重投续跑、结算退避重试、401 时重读凭据。
// 全部对 test/mock-appserver.mjs 与 test/mock-offpeak.mjs 跑，夹具见 test/offpeak-fixture.mjs；不碰真网络、不读真实 ~/.zcode。
// 每条都做泄密检查：runs 目录全部文件、输出、mock 记录里查不到任何用过的 JWT 与 key。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readRecord, waitFor } from './helpers.mjs';
import {
  assertNoSecrets, cleanupAll, lay, offPeakJson, readEvents, readJson, replaceJwt, runBin, runnerLog, settleRequests, setup,
  startRunner, takeRequests, takeTicket, trackPids, waitRunnerGone,
} from './offpeak-fixture.mjs';

test.after(cleanupAll);

// App 原文（verified.md「闲时任务探针」错误码一行），一个字不改
const RESUME_PROMPT = 'Continue the previous task from where it left off. The run was interrupted (app restart or execution window expired). '
  + 'Do not start over; review what has already been done and complete the remaining work.';

// 真机回合失败的 code 是字符串，3102 的 message 以 off-peak-ticket-expired: 开头（verified.md「闲时任务探针」2026-09-27）；
// 3001 的 message 取直接 fetch 时见过的 parameter error
const TICKET_LOST = {
  3102: 'off-peak-ticket-expired: off-peak ticket has expired or exceeded max running time',
  3104: 'off-peak ticket is invalid',
  3001: 'parameter error',
};

// 查排位时把请求里的每个号都说成 state（expired / not_found）
const allIn = (state) => (req) => ({ code: 0, msg: 'success', data: { next_poll_after: 1, tickets: req.ticket_ids.map((id) => ({ ticket_id: id, state })) } });

const offPeakSends = (s) => readRecord(s.recordPath).filter((m) => m.method === 'session/send').map((m) => m.params);
const ticketOf = (params) => params.modelExecution.requestAuth.headers['X-Off-Peak-Ticket-ID'];
const eventsOf = (s, type) => readEvents(s.runsDir).filter((e) => e.type === type);
const lastJson = (s) => readJson(path.join(s.runsDir, 'last.json'));
const offpeakJson = (s) => readJson(path.join(s.runsDir, 'offpeak.json'));
const settledTickets = (s) => settleRequests(s).map((q) => q.path.split('/').at(-2));

// ---------- 就绪前号失效 ----------

for (const [state, settled] of [['expired', ['mock-ticket-1', 'mock-ticket-2']], ['not_found', ['mock-ticket-2']]]) test(`就绪前号 ${state}：同一个 offPeakId 重取号，第二个号就绪后照常开跑、done；expired 的旧号不重试地结算一次，not_found 不结算`, async (t) => {
  const s = await setup(t, { offpeak: { failRoute: { status: { status: 200, times: 1, body: allIn(state) } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, 'done');
  await waitRunnerGone(s.runsDir);

  const op = offpeakJson(s);
  const takes = takeRequests(s);
  assert.equal(takes.length, 2);
  assert.deepEqual(takes.map((q) => q.body.task_id), [op.offPeakId, op.offPeakId], '重取号不换 offPeakId');
  assert.equal(op.ticketId, 'mock-ticket-2');
  assert.equal(op.ticketCount, 2);
  assert.equal(op.phase, 'done');
  assert.match(op.settledAt, /Z$/);
  const retaken = eventsOf(s, 'executor.offpeak.retaken');
  assert.equal(retaken.length, 1);
  const { type, at, ...fields } = retaken[0];
  assert.deepEqual(fields, { offPeakId: op.offPeakId, oldTicketId: 'mock-ticket-1', ticketId: 'mock-ticket-2', reason: state, ticketCount: 2 });
  const sends = offPeakSends(s);
  assert.equal(sends.length, 1);
  assert.equal(ticketOf(sends[0]), 'mock-ticket-2');
  assert.equal(sends[0].offPeakRunType, 'init');
  assert.equal(sends[0].content, '闲时的活');
  assert.deepEqual(settledTickets(s), settled);
  assert.deepEqual(op.unsettledTickets, []);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('就绪前号接连失效把 3 个号用完：failed「闲时号用完了（共 3 个）」，不起 app-server，最后一个号结算过', async (t) => {
  const s = await setup(t, { offpeak: { failRoute: { status: { status: 200, body: allIn('expired') } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '会过期的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.outcome, 'failed');
  assert.equal(out.reason, '闲时号用完了（共 3 个）');
  await waitRunnerGone(s.runsDir);
  assert.deepEqual(readRecord(s.recordPath), [], '号没就绪不该起 app-server');
  assert.equal(takeRequests(s).length, 3);
  assert.equal(eventsOf(s, 'executor.offpeak.retaken').length, 2);
  assert.deepEqual(settledTickets(s), ['mock-ticket-1', 'mock-ticket-2', 'mock-ticket-3'], '过期的号各结算一次，最后一个不重复结算');
  const op = offpeakJson(s);
  assert.equal(op.ticketCount, 3);
  assert.equal(op.phase, 'done');
  assert.deepEqual(await readdir(path.join(s.runsDir, 'queue')), []);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

// ---------- 运行中号失效 ----------

for (const [code, message] of Object.entries(TICKET_LOST)) {
  test(`运行中号失效（${code}）：先结算旧号再重取，新号就绪后在同一会话发续跑提示（resume），重推授权`, async (t) => {
    const s = await setup(t, { script: { offPeakTurnErrors: [{ code, message }] } });
    const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
    trackPids(s.runsDir);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.outcome, 'done');
    assert.equal(out.text, '闲时的活', 'last.json 里记的是原投递正文');
    await waitRunnerGone(s.runsDir);
    trackPids(s.runsDir);

    const record = readRecord(s.recordPath);
    const sends = offPeakSends(s);
    assert.equal(sends.length, 2);
    assert.equal(sends[0].content, '闲时的活');
    assert.equal(sends[0].offPeakRunType, 'init');
    assert.equal(ticketOf(sends[0]), 'mock-ticket-1');
    assert.equal(sends[1].content, RESUME_PROMPT);
    assert.equal(sends[1].offPeakRunType, 'resume');
    assert.equal(ticketOf(sends[1]), 'mock-ticket-2');
    assert.equal(sends[1].offPeakTaskId, sends[0].offPeakTaskId);
    assert.equal(sends[1].sessionId, sends[0].sessionId, '续跑在同一条会话');
    // 两次 send 之前各推一次授权
    const methods = record.map((m) => m.method).filter(Boolean);
    const pushes = methods.flatMap((m, i) => (m === 'provider/updateAccountConfig' ? [i] : []));
    const sendAts = methods.flatMap((m, i) => (m === 'session/send' ? [i] : []));
    assert.equal(pushes.length, 2, methods.join(','));
    assert.ok(pushes[0] < sendAts[0] && sendAts[0] < pushes[1] && pushes[1] < sendAts[1], methods.join(','));

    // 先结算旧号，再重取
    const paths = s.server.requests.map((q) => `${q.method} ${q.path}`);
    const settleOld = paths.indexOf('POST /api/v1/off-peak/ticket/mock-ticket-1/settle');
    const retake = paths.lastIndexOf('POST /api/v1/off-peak/ticket');
    assert.ok(settleOld >= 0 && settleOld < retake, paths.join('\n'));
    assert.deepEqual(settledTickets(s), ['mock-ticket-1', 'mock-ticket-2']);

    const retaken = eventsOf(s, 'executor.offpeak.retaken');
    assert.equal(retaken.length, 1);
    assert.equal(retaken[0].reason, code);
    assert.equal(retaken[0].oldTicketId, 'mock-ticket-1');
    assert.equal(retaken[0].ticketId, 'mock-ticket-2');
    assert.equal(retaken[0].ticketCount, 2);
    const results = eventsOf(s, 'executor.result');
    assert.deepEqual(results.map((e) => e.outcome), ['done'], '号失效的那一回合不写结果');
    const op = offpeakJson(s);
    assert.equal(op.ticketCount, 2);
    assert.equal(op.ticketId, 'mock-ticket-2');
    assert.equal(op.phase, 'done');
    assert.deepEqual(await readdir(path.join(s.runsDir, 'queue')), []);
    await assertNoSecrets(s, [r.stdout, r.stderr]);
  });
}

test('运行中号接连失效把 3 个号用完：failed「闲时号用完了（共 3 个）」，三个号都结算过', async (t) => {
  const lost = { code: '3102', message: TICKET_LOST[3102] };
  const s = await setup(t, { script: { offPeakTurnErrors: [lost, lost, lost] } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.outcome, 'failed');
  assert.equal(out.reason, '闲时号用完了（共 3 个）');
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(offPeakSends(s).length, 3);
  assert.equal(takeRequests(s).length, 3);
  assert.deepEqual(settledTickets(s), ['mock-ticket-1', 'mock-ticket-2', 'mock-ticket-3']);
  assert.equal(eventsOf(s, 'executor.offpeak.retaken').length, 2);
  assert.deepEqual(eventsOf(s, 'executor.result').map((e) => e.outcome), ['failed']);
  const op = offpeakJson(s);
  assert.equal(op.ticketCount, 3);
  assert.equal(op.phase, 'done');
  assert.deepEqual(await readdir(path.join(s.runsDir, 'queue')), []);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('重取号时服务器回 3103：failed，reason 带「几点以后可再取」，旧号结算一次', async (t) => {
  const s = await setup(t, {
    offpeak: { readyDelayMs: 1000 },
    script: { offPeakTurnErrors: [{ code: '3102', message: TICKET_LOST[3102] }] },
  });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  // send 取号之后、runner 重取之前换上：之后取号一律 3103（号 1 秒后才就绪，runner 此时还在排号）
  s.server.setFailRoute('take', { status: 429, body: { code: 3103, msg: 'free tier limit reached', data: { next_take_at: Date.now() + 3600_000 } } });
  await waitFor(() => existsSync(path.join(s.runsDir, 'last.json')), { timeoutMs: 30000 });
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  const last = lastJson(s);
  assert.equal(last.outcome, 'failed');
  assert.match(last.reason, /额度用完/);
  assert.match(last.reason, /\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2} 以后可再取/);
  assert.deepEqual(settledTickets(s), ['mock-ticket-1']);
  assert.equal(eventsOf(s, 'executor.offpeak.retaken').length, 0);
  const op = offpeakJson(s);
  assert.equal(op.ticketCount, 1);
  assert.equal(op.phase, 'done');
  assert.deepEqual(await readdir(path.join(s.runsDir, 'queue')), []);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

// ---------- 不重取的结局 ----------

for (const [name, opts, args, outcome] of [
  ['其他业务码的 failed', { script: { offPeakTurnError: { code: '1301', message: 'content filtered' } } }, [], 'failed'],
  ['超时', { script: { turns: [{ hang: true }] } }, ['--timeout', '1'], 'timeout'],
]) {
  test(`回合以${name}结束：照普通回合结算，不重取号`, async (t) => {
    const s = await setup(t, opts);
    const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json', ...args]);
    trackPids(s.runsDir);
    assert.equal(JSON.parse(r.stdout).outcome, outcome, r.stderr);
    await waitRunnerGone(s.runsDir);
    trackPids(s.runsDir);
    assert.equal(takeRequests(s).length, 1);
    assert.equal(offPeakSends(s).length, 1);
    assert.equal(eventsOf(s, 'executor.offpeak.retaken').length, 0);
    assert.deepEqual(settledTickets(s), ['mock-ticket-1']);
    assert.equal(offpeakJson(s).phase, 'done');
    await assertNoSecrets(s, [r.stdout, r.stderr]);
  });
}

test('回合被 cancel：照普通回合结算，不重取号', async (t) => {
  const s = await setup(t, {
    script: { turns: [{ events: [
      { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'a' }, delayMs: 3000 },
      { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'b' }, delayMs: 3000 },
    ] }] },
  });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => offpeakJson(s).phase === 'running', { timeoutMs: 30000 });
  trackPids(s.runsDir);
  const cancel = await runBin(s.env, ['cancel', s.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitFor(() => existsSync(path.join(s.runsDir, 'last.json')), { timeoutMs: 30000 });
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
  assert.equal(lastJson(s).outcome, 'cancelled');
  assert.equal(takeRequests(s).length, 1);
  assert.equal(eventsOf(s, 'executor.offpeak.retaken').length, 0);
  assert.deepEqual(settledTickets(s), ['mock-ticket-1']);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

// ---------- 续跑的其他来源（exited 后重投） ----------

test('回合 exited 后下一个 runner 重投：offpeak.json 显示开跑过，发续跑提示（resume），不重取号', async (t) => {
  const s = await setup(t, { script: { exitAfter: 'session/send' } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(lastJson(s).outcome, 'exited');
  await writeFile(s.mock.env.MOCK_APPSERVER_SCRIPT, '{}'); // 子进程这次不再退出
  await startRunner(s);
  await waitFor(() => lastJson(s).outcome === 'done', { timeoutMs: 30000 });
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  const sends = offPeakSends(s);
  assert.equal(sends.length, 2);
  assert.equal(sends[0].content, '闲时的活');
  assert.equal(sends[0].offPeakRunType, 'init');
  assert.equal(sends[1].content, RESUME_PROMPT);
  assert.equal(sends[1].offPeakRunType, 'resume');
  assert.equal(ticketOf(sends[1]), 'mock-ticket-1');
  assert.equal(lastJson(s).text, '闲时的活');
  assert.equal(takeRequests(s).length, 1);
  assert.deepEqual(settledTickets(s), ['mock-ticket-1']);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('重投时号已经是 active：发续跑提示（resume）', async (t) => {
  const s = await setup(t);
  const offPeakId = 'offpeak-00000000-0000-4000-8000-000000000003';
  const ticket = await takeTicket(s, offPeakId);
  await waitFor(() => s.server.activate(ticket.ticket_id));
  await lay(s, { offpeak: offPeakJson(offPeakId, ticket.ticket_id), queue: [{ text: '闲时的活', offpeak: { offPeakId } }] });
  await startRunner(s);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(lastJson(s).outcome, 'done');
  const sends = offPeakSends(s);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].content, RESUME_PROMPT);
  assert.equal(sends[0].offPeakRunType, 'resume');
  await assertNoSecrets(s);
});

// ---------- 结算重试 ----------

test('结算失败 2 次后成功：结算请求 3 次，settledAt 有值、unsettledTickets 为空、stderr 不报结算失败', async (t) => {
  const s = await setup(t, { offpeak: { failRoute: { settle: { status: 500, times: 2 } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  await waitRunnerGone(s.runsDir);
  assert.equal(settleRequests(s).length, 3);
  const op = offpeakJson(s);
  assert.equal(op.phase, 'done');
  assert.match(op.settledAt, /Z$/);
  assert.deepEqual(op.unsettledTickets, []);
  assert.equal(eventsOf(s, 'executor.offpeak.settled').length, 1);
  assert.doesNotMatch(runnerLog(s), /结算失败/);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

// ---------- 401 时重读凭据 ----------

test('查排位遇到 401：重读凭据，JWT 换了就用新 JWT 继续，照常 done；新旧 JWT 都不落盘', async (t) => {
  const NEW_JWT = 'offpeak-retake-new-jwt-header.offpeak-retake-new-jwt-payload.offpeak-retake-new-jwt-signature';
  const s = await setup(t, { offpeak: { readyDelayMs: 1500 } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => s.server.requests.some((q) => q.path.endsWith('/ticket/status')));
  // 先换凭据文件再让服务器只认新 JWT：runner 撞上 401 时重读到的一定是新的
  await replaceJwt(s, NEW_JWT);
  s.server.setJwt(NEW_JWT);
  await waitFor(() => existsSync(path.join(s.runsDir, 'last.json')), { timeoutMs: 30000 });
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(lastJson(s).outcome, 'done', JSON.stringify(lastJson(s)));
  assert.ok(s.server.requests.some((q) => !q.authOk), '应当撞上过一次 401');
  assert.equal(s.server.requests.at(-1).authOk, true);
  assert.deepEqual(settledTickets(s), ['mock-ticket-1']);
  assert.equal(offpeakJson(s).phase, 'done');
  await assertNoSecrets(s, [r.stdout, r.stderr], [NEW_JWT]);
});

// ---------- 评审返工（OP5 评审 C1、C2、I1、M5、M6） ----------

test('同一会话连续两次 send --offpeak：第二次发原文、runType init（offpeak.json 整份重写，不带上次的 startedAt）', async (t) => {
  const s = await setup(t);
  const r1 = await runBin(s.env, ['send', s.entry.id, '第一件', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r1.status, 0, r1.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  const r2 = await runBin(s.env, ['send', s.entry.id, '第二件', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r2.status, 0, r2.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  const sends = offPeakSends(s);
  assert.deepEqual(sends.map((p) => [p.content, p.offPeakRunType]), [['第一件', 'init'], ['第二件', 'init']]);
  const op = offpeakJson(s);
  assert.equal(op.ticketId, 'mock-ticket-2');
  assert.equal(op.ticketCount, 1);
  assert.deepEqual(op.unsettledTickets, []);
  await assertNoSecrets(s, [r1.stdout, r1.stderr, r2.stdout, r2.stderr]);
});

test('号失效后结算旧号期间 cancel：投递按 cancelled 收尾，不再发第 2 个回合，取过的号都结算了', async (t) => {
  const s = await setup(t, {
    offpeak: { failRoute: { settle: { delayMs: 1500, times: 1 } } },
    script: { offPeakTurnErrors: [{ code: '3102', message: TICKET_LOST[3102] }] },
  });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => settleRequests(s).length >= 1, { timeoutMs: 20000 });
  trackPids(s.runsDir);
  const cancel = await runBin(s.env, ['cancel', s.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(lastJson(s).outcome, 'cancelled', JSON.stringify(lastJson(s)));
  assert.deepEqual(eventsOf(s, 'executor.result').map((e) => e.outcome), ['cancelled']);
  assert.equal(offPeakSends(s).length, 1, '不该再跑一回合');
  assert.deepEqual(await readdir(path.join(s.runsDir, 'queue')), [], '队列项不该被写回');
  const taken = takeRequests(s).length;
  const settled = settledTickets(s);
  for (let n = 1; n <= taken; n += 1) assert.ok(settled.includes(`mock-ticket-${n}`), `号 ${n} 应当结算过：${settled}`);
  assert.equal(offpeakJson(s).phase, 'done');
  await assertNoSecrets(s, [r.stdout, r.stderr, cancel.stdout, cancel.stderr]);
});

test('旧号结算失败、重取成功、新号结算成功：unsettledTickets 只有旧号，当前号已结算', async (t) => {
  const s = await setup(t, {
    offpeak: { failRoute: { settle: { status: 500, times: 4 } } }, // 旧号首次 + 重试 3 次都失败
    script: { offPeakTurnErrors: [{ code: '3102', message: TICKET_LOST[3102] }] },
  });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.deepEqual(settledTickets(s), ['mock-ticket-1', 'mock-ticket-1', 'mock-ticket-1', 'mock-ticket-1', 'mock-ticket-2']);
  const op = offpeakJson(s);
  assert.equal(op.ticketId, 'mock-ticket-2');
  assert.match(op.settledAt, /Z$/);
  assert.equal(op.unsettledTickets.length, 1);
  assert.equal(op.unsettledTickets[0].ticketId, 'mock-ticket-1');
  assert.match(op.unsettledTickets[0].error, /结算失败/);
  assert.match(op.unsettledTickets[0].at, /Z$/);
  assert.equal([...runnerLog(s).matchAll(/^runner: 闲时号 mock-ticket-1 结算失败/gm)].length, 1);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('结算失败过的号不再整轮重试：3 个号接连失效且结算一直失败，每个号只退避重试一轮', async (t) => {
  const lost = { code: '3102', message: TICKET_LOST[3102] };
  const s = await setup(t, {
    offpeak: { failRoute: { settle: { status: 500 } } },
    script: { offPeakTurnErrors: [lost, lost, lost] },
  });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  const settled = settledTickets(s);
  for (const n of [1, 2, 3]) assert.equal(settled.filter((id) => id === `mock-ticket-${n}`).length, 4, settled.join(','));
  assert.deepEqual(offpeakJson(s).unsettledTickets.map((u) => u.ticketId), ['mock-ticket-1', 'mock-ticket-2', 'mock-ticket-3']);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('session/send 被拒（回合没开跑）：不记 startedAt，下一个 runner 重投发原文、runType init', async (t) => {
  const s = await setup(t, { script: { errors: { 'session/send': { code: -32000, message: 'send rejected' } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => readRecord(s.recordPath).some((m) => m.method === 'session/send'), { timeoutMs: 30000 });
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(offpeakJson(s).startedAt ?? null, null, '原文没被接受过，不算开跑');
  await writeFile(s.mock.env.MOCK_APPSERVER_SCRIPT, '{}');
  await startRunner(s);
  await waitFor(() => existsSync(path.join(s.runsDir, 'last.json')), { timeoutMs: 30000 });
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(lastJson(s).outcome, 'done');
  const sends = offPeakSends(s);
  assert.equal(sends.at(-1).content, '闲时的活');
  assert.equal(sends.at(-1).offPeakRunType, 'init');
  assert.match(offpeakJson(s).startedAt, /Z$/);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});
