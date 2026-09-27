// 闲时投递的 cancel 与孤儿号收尾（SPEC-offpeak D，任务 OP6）：排号中 cancel、运行中 cancel、runner 已死时由 CLI 结算、
// 重取之后 cancel 结算新号、下一次 send --offpeak 前结算没收尾的旧号；评审返工补的竞争窗口与孤儿记录见文件末尾。
// 全部对 test/mock-appserver.mjs 与 test/mock-offpeak.mjs 跑，夹具见 test/offpeak-fixture.mjs；不碰真网络、不读真实 ~/.zcode。
// 每条都做泄密检查：runs 目录全部文件（含 runner.log）、命令输出、mock 记录里查不到 JWT 与 key。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readRecord, waitFor } from './helpers.mjs';
import {
  assertNoSecrets, cleanupAll, lay, offPeakJson, readEvents, readJson, runBin, settleRequests, setup, startRunner, takeRequests,
  takeTicket, trackPids, waitRunnerGone,
} from './offpeak-fixture.mjs';

test.after(cleanupAll);

const lastJson = (s) => readJson(path.join(s.runsDir, 'last.json'));
const offpeakJson = (s) => readJson(path.join(s.runsDir, 'offpeak.json'));
const settledTickets = (s) => settleRequests(s).map((q) => q.path.split('/').at(-2));
const resultsOf = (s) => readEvents(s.runsDir).filter((e) => e.type === 'executor.result').map((e) => e.outcome);
const statusPolls = (s) => s.server.requests.filter((q) => q.path.endsWith('/ticket/status')).length;
const queueFiles = async (s) => (existsSync(path.join(s.runsDir, 'queue')) ? readdir(path.join(s.runsDir, 'queue')) : []);
const allIn = (state) => (req) => ({ code: 0, msg: 'success', data: { next_poll_after: 1, tickets: req.ticket_ids.map((id) => ({ ticket_id: id, state })) } });

test('排号中 cancel：runner 停止轮询、结算当前号，投递以 cancelled 结束，offpeak.json 收成 done', async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 60000 } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => statusPolls(s) >= 1);
  trackPids(s.runsDir);
  const cancel = await runBin(s.env, ['cancel', s.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitRunnerGone(s.runsDir);
  const last = lastJson(s);
  assert.equal(last.outcome, 'cancelled');
  assert.equal(last.reason, '已被 cancel 叫停');
  assert.equal(last.text, '闲时的活');
  assert.deepEqual(resultsOf(s), ['cancelled']);
  assert.deepEqual(settledTickets(s), ['mock-ticket-1']);
  const op = offpeakJson(s);
  assert.equal(op.phase, 'done');
  assert.match(op.settledAt, /Z$/);
  assert.deepEqual(await queueFiles(s), []);
  assert.deepEqual(readRecord(s.recordPath), [], '排号中取消不该起 app-server');
  await assertNoSecrets(s, [r.stdout, r.stderr, cancel.stdout, cancel.stderr]);
});

test('运行中 cancel：停回合后结算号，投递以 cancelled 结束，offpeak.json 收成 done', async (t) => {
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
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(lastJson(s).outcome, 'cancelled');
  assert.deepEqual(resultsOf(s), ['cancelled']);
  assert.deepEqual(settledTickets(s), ['mock-ticket-1']);
  assert.equal(offpeakJson(s).phase, 'done');
  await assertNoSecrets(s, [r.stdout, r.stderr, cancel.stdout, cancel.stderr]);
});

test('runner 已死时 cancel（回合 exited 后）：CLI 直接结算号，写 cancelled 的 last.json，offpeak.json 收成 done', async (t) => {
  const s = await setup(t, { script: { exitAfter: 'session/send' } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.deepEqual(settledTickets(s), []);
  const cancel = await runBin(s.env, ['cancel', s.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /runner 已不在/);
  assert.match(cancel.stdout, /号 mock-ticket-1 已结算/);
  assert.equal(existsSync(path.join(s.runsDir, 'lock')), false, 'cancel 不该起 runner');
  assert.deepEqual(settledTickets(s), ['mock-ticket-1']);
  const last = lastJson(s);
  assert.equal(last.outcome, 'cancelled');
  assert.equal(last.text, '闲时的活');
  assert.deepEqual(resultsOf(s), ['exited', 'cancelled']);
  const op = offpeakJson(s);
  assert.equal(op.phase, 'done');
  assert.match(op.settledAt, /Z$/);
  assert.ok(readEvents(s.runsDir).some((e) => e.type === 'executor.offpeak.settled' && e.ticketId === 'mock-ticket-1'));
  assert.deepEqual(await queueFiles(s), []);
  await assertNoSecrets(s, [r.stdout, r.stderr, cancel.stdout, cancel.stderr]);
});

test('runner 已死时 cancel、结算失败：只请求一次，号记进 unsettledTickets，stderr 一行，offpeak.json 照样收成 done', async (t) => {
  const s = await setup(t, { script: { exitAfter: 'session/send' }, offpeak: { failRoute: { settle: { status: 500 } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  const cancel = await runBin(s.env, ['cancel', s.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal([...cancel.stderr.matchAll(/^cancel: 闲时号 mock-ticket-1 结算失败/gm)].length, 1, cancel.stderr);
  assert.match(cancel.stdout, /结算失败/);
  assert.equal(settleRequests(s).length, 1, '不退避重试');
  const op = offpeakJson(s);
  assert.equal(op.phase, 'done');
  assert.deepEqual(op.unsettledTickets.map((u) => u.ticketId), ['mock-ticket-1']);
  assert.equal(lastJson(s).outcome, 'cancelled');
  await assertNoSecrets(s, [r.stdout, r.stderr, cancel.stdout, cancel.stderr]);
});

test('就绪前重取之后又被 cancel：旧号（expired）与新号都结算，投递以 cancelled 结束', async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 60000, failRoute: { status: { status: 200, times: 1, body: allIn('expired') } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => readEvents(s.runsDir).some((e) => e.type === 'executor.offpeak.retaken'));
  await waitFor(() => statusPolls(s) >= 2); // 新号开始排了
  trackPids(s.runsDir);
  const cancel = await runBin(s.env, ['cancel', s.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitRunnerGone(s.runsDir);
  assert.equal(lastJson(s).outcome, 'cancelled');
  assert.equal(takeRequests(s).length, 2);
  assert.deepEqual(settledTickets(s), ['mock-ticket-1', 'mock-ticket-2']);
  const op = offpeakJson(s);
  assert.equal(op.ticketId, 'mock-ticket-2');
  assert.equal(op.phase, 'done');
  assert.match(op.settledAt, /Z$/);
  await assertNoSecrets(s, [r.stdout, r.stderr, cancel.stdout, cancel.stderr]);
});

test('孤儿号：上一次闲时投递没收尾（runner 不在、队列里没有它），下一次 send --offpeak 先结算旧号再取新号', async (t) => {
  const s = await setup(t);
  const oldId = 'offpeak-00000000-0000-4000-8000-0000000000c1';
  const ticket = await takeTicket(s, oldId);
  await lay(s, { offpeak: offPeakJson(oldId, ticket.ticket_id, { phase: 'running' }), queue: [] });
  const r = await runBin(s.env, ['send', s.entry.id, '新的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, 'done');
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  const paths = s.server.requests.map((q) => `${q.method} ${q.path}`);
  const settleOld = paths.indexOf(`POST /api/v1/off-peak/ticket/${ticket.ticket_id}/settle`);
  const takeNew = paths.lastIndexOf('POST /api/v1/off-peak/ticket');
  assert.ok(settleOld >= 0 && settleOld < takeNew, paths.join('\n'));
  assert.deepEqual(settledTickets(s), [ticket.ticket_id, 'mock-ticket-2']);
  const op = offpeakJson(s);
  assert.notEqual(op.offPeakId, oldId);
  assert.equal(op.phase, 'done');
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('孤儿号结算失败：stderr 一行，照样取新号开跑', async (t) => {
  const s = await setup(t, { offpeak: { failRoute: { settle: { status: 500, times: 1 } } } });
  const oldId = 'offpeak-00000000-0000-4000-8000-0000000000c2';
  const ticket = await takeTicket(s, oldId);
  await lay(s, { offpeak: offPeakJson(oldId, ticket.ticket_id), queue: [] });
  const r = await runBin(s.env, ['send', s.entry.id, '新的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal([...r.stderr.matchAll(new RegExp(`^send: 闲时号 ${ticket.ticket_id} 结算失败`, 'gm'))].length, 1, r.stderr);
  await waitRunnerGone(s.runsDir);
  assert.equal(takeRequests(s).length, 2);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

// ---------- OP6 评审返工：cancel 与开跑、重取、runner 拉起的竞争（I1），孤儿记录不影响普通投递（I2），结算回写前重读（M1） ----------

/** 像 cancel 那样直接动文件：写 stop、写 cancel、删队列项（不经过 CLI，好卡进 runner 的窗口）。 */
function cancelByFiles(s) {
  writeFileSync(path.join(s.runsDir, 'stop'), '{}');
  writeFileSync(path.join(s.runsDir, 'cancel'), '{}');
  for (const f of readdirSync(path.join(s.runsDir, 'queue'))) rmSync(path.join(s.runsDir, 'queue', f), { force: true });
}

test('号 ready 之后、回合开跑之前被 cancel：投递以 cancelled 结束，号结算一次，offpeak.json 收成 done', async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 300 }, script: { turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'a' }, delayMs: 3000 }] }] } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => existsSync(path.join(s.runsDir, 'offpeak.json')) && offpeakJson(s).phase === 'ready', { timeoutMs: 10000, intervalMs: 5 });
  trackPids(s.runsDir);
  cancelByFiles(s);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(lastJson(s).outcome, 'cancelled');
  assert.equal(lastJson(s).text, '闲时的活');
  assert.deepEqual(settledTickets(s), ['mock-ticket-1']);
  assert.equal(offpeakJson(s).phase, 'done');
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('运行中号失效、重取窗口里被 cancel（直接动文件）：cancelled，新旧号各结算一次，offpeak.json 收成 done', async (t) => {
  const s = await setup(t, { script: { offPeakTurnErrors: [{ code: '3102', message: 'off-peak-ticket-expired: off-peak ticket has expired or exceeded max running time' }] } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  s.server.setFailRoute('take', { delayMs: 800, times: 1 }); // 重取号时服务器慢一拍，cancel 落在重取窗口里
  await waitFor(() => takeRequests(s).length >= 2, { timeoutMs: 30000, intervalMs: 5 });
  trackPids(s.runsDir);
  cancelByFiles(s);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(lastJson(s).outcome, 'cancelled');
  assert.deepEqual(settledTickets(s), ['mock-ticket-1', 'mock-ticket-2']);
  assert.equal(offpeakJson(s).phase, 'done');
  assert.deepEqual(await queueFiles(s), []);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('runner 刚拉起时队列已被 cancel 清空（没活 runner 的判断落在它拿锁之后）：runner 不起 app-server，结算号并收成 done', async (t) => {
  const s = await setup(t);
  const offPeakId = 'offpeak-00000000-0000-4000-8000-0000000000c3';
  const ticket = await takeTicket(s, offPeakId);
  await lay(s, { offpeak: offPeakJson(offPeakId, ticket.ticket_id), queue: [] });
  await startRunner(s);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.deepEqual(readRecord(s.recordPath), [], '队列空了不该起 app-server');
  assert.deepEqual(settledTickets(s), [ticket.ticket_id]);
  assert.equal(offpeakJson(s).phase, 'done');
  await assertNoSecrets(s);
});

test('孤儿 offpeak.json（phase ready）下普通投递：第一条 send 先结算孤儿号；运行期间第二条 send 与 --steer 照普通规则工作', async (t) => {
  const s = await setup(t, { script: { turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'a' }, delayMs: 3000 }] }, {}] } });
  const offPeakId = 'offpeak-00000000-0000-4000-8000-0000000000e1';
  const ticket = await takeTicket(s, offPeakId);
  await lay(s, { offpeak: offPeakJson(offPeakId, ticket.ticket_id, { phase: 'ready' }), queue: [] });
  const a = await runBin(s.env, ['send', s.entry.id, '普通一']);
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(settledTickets(s), [ticket.ticket_id], '入队前先结算孤儿号');
  assert.equal(offpeakJson(s).phase, 'done');
  await waitFor(() => readEvents(s.runsDir).some((e) => e.type === 'turn.started'), { timeoutMs: 20000 });
  trackPids(s.runsDir);
  const b = await runBin(s.env, ['send', s.entry.id, '普通二']);
  assert.equal(b.status, 0, b.stderr);
  const steer = await runBin(s.env, ['send', s.entry.id, '插话', '--steer']);
  assert.equal(steer.status, 0, steer.stderr);
  await waitFor(() => resultsOf(s).length >= 2, { timeoutMs: 30000 });
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.deepEqual(resultsOf(s), ['done', 'done']);
  assert.ok(readEvents(s.runsDir).some((e) => e.type === 'executor.steer' && e.text === '插话'));
  assert.equal(readEvents(s.runsDir).some((e) => e.type === 'executor.steer_failed'), false);
  assert.deepEqual(settledTickets(s), [ticket.ticket_id], '孤儿号只结算一次');
  await assertNoSecrets(s, [a.stdout, a.stderr, b.stdout, b.stderr, steer.stdout, steer.stderr]);
});

test('普通回合进行中出现孤儿 offpeak.json（phase running）：第二条 send 与 --steer 不被挡、插话不打闲时标记，runner 收尾时结算孤儿号', async (t) => {
  const s = await setup(t, { script: { turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'a' }, delayMs: 3000 }] }, {}] } });
  const a = await runBin(s.env, ['send', s.entry.id, '普通一']);
  assert.equal(a.status, 0, a.stderr);
  await waitFor(() => readEvents(s.runsDir).some((e) => e.type === 'turn.started'), { timeoutMs: 20000 });
  trackPids(s.runsDir);
  const offPeakId = 'offpeak-00000000-0000-4000-8000-0000000000e2';
  const ticket = await takeTicket(s, offPeakId);
  writeFileSync(path.join(s.runsDir, 'offpeak.json'), JSON.stringify(offPeakJson(offPeakId, ticket.ticket_id, { phase: 'running', runnerPid: 999999 })));
  const b = await runBin(s.env, ['send', s.entry.id, '普通二']);
  assert.equal(b.status, 0, b.stderr);
  const steer = await runBin(s.env, ['send', s.entry.id, '插话', '--steer']);
  assert.equal(steer.status, 0, steer.stderr);
  await waitFor(() => resultsOf(s).length >= 2, { timeoutMs: 30000 });
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.deepEqual(resultsOf(s), ['done', 'done']);
  assert.ok(readEvents(s.runsDir).some((e) => e.type === 'executor.steer' && e.text === '插话'));
  assert.equal(readEvents(s.runsDir).some((e) => e.type === 'executor.steer_failed'), false);
  assert.deepEqual(settledTickets(s), [ticket.ticket_id]);
  assert.equal(offpeakJson(s).phase, 'done');
  await assertNoSecrets(s, [a.stdout, a.stderr, b.stdout, b.stderr, steer.stdout, steer.stderr]);
});

test('CLI 结算期间 offpeak.json 换成了另一次闲时投递：结算完不回写，新记录原样保留，也不写 cancelled 的 last.json', async (t) => {
  const s = await setup(t, { script: { exitAfter: 'session/send' } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  s.server.setFailRoute('settle', { delayMs: 1000, times: 1 });
  const cancel = runBin(s.env, ['cancel', s.entry.id]);
  await waitFor(() => settleRequests(s).length >= 1, { intervalMs: 5 });
  const other = offPeakJson('offpeak-00000000-0000-4000-8000-0000000000f1', 'mock-ticket-77');
  writeFileSync(path.join(s.runsDir, 'offpeak.json'), JSON.stringify(other));
  const c = await cancel;
  assert.equal(c.status, 0, c.stderr);
  assert.deepEqual(offpeakJson(s), other);
  assert.equal(lastJson(s).outcome, 'exited', '不该改写 last.json');
  await assertNoSecrets(s, [r.stdout, r.stderr, c.stdout, c.stderr]);
});
