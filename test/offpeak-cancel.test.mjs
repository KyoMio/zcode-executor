// 闲时投递的 cancel 与孤儿号收尾（SPEC-offpeak D，任务 OP6）：排号中 cancel、运行中 cancel、runner 已死时由 CLI 结算、
// 重取之后 cancel 结算新号、下一次 send --offpeak 前结算没收尾的旧号。
// 全部对 test/mock-appserver.mjs 与 test/mock-offpeak.mjs 跑，夹具见 test/offpeak-fixture.mjs；不碰真网络、不读真实 ~/.zcode。
// 每条都做泄密检查：runs 目录全部文件（含 runner.log）、命令输出、mock 记录里查不到 JWT 与 key。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readRecord, waitFor } from './helpers.mjs';
import {
  assertNoSecrets, cleanupAll, lay, offPeakJson, readEvents, readJson, runBin, settleRequests, setup, takeRequests, takeTicket,
  trackPids, waitRunnerGone,
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
