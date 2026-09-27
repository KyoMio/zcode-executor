// lib/offpeak.mjs 的行为测试：闲时服务器客户端对 test/mock-offpeak.mjs 的四个接口、错误分类与凭据不外泄。
// 只连本机 mock，不碰真网络、不读真实 ~/.zcode（RULES §9）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOffPeakClient } from '../lib/offpeak.mjs';
import { ExecutorError } from '../lib/errors.mjs';
import { startMockOffPeak } from './mock-offpeak.mjs';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjo0Mn0.offpeak-test-signature';
const PLAN_KEY = 'offpeak-test-plan-key-0123456789';
const AUTH = { jwt: JWT, planKey: PLAN_KEY };

const mocks = [];
test.after(async () => {
  for (const m of mocks) await m.close();
});

async function mock(options = {}) {
  const m = await startMockOffPeak({ jwt: JWT, planKey: PLAN_KEY, ...options });
  mocks.push(m);
  return m;
}

/** 断言抛的是 ExecutorError，并且 message 与 details 里查不到 JWT 和 key；返回 err 供后续断言。 */
async function rejection(promise) {
  let caught;
  await assert.rejects(promise, (err) => {
    caught = err;
    return true;
  });
  assert.ok(caught instanceof ExecutorError, `应是 ExecutorError，实际 ${caught?.name}`);
  const text = `${caught.message}\n${JSON.stringify(caught.details)}`;
  assert.equal(text.includes(JWT), false, '错误里出现了 JWT');
  assert.equal(text.includes(PLAN_KEY), false, '错误里出现了 plan key');
  return caught;
}

// ---------- 正常形状 ----------

test('闲时客户端：查资格返回 canTakeNumber', async () => {
  const m = await mock();
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  assert.deepEqual(await client.availability(), { canTakeNumber: true });
});

test('闲时客户端：额度用完时查资格带 nextTakeAt', async () => {
  const m = await mock({ quotaExhaustedCount: 1 });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const out = await client.availability();
  assert.equal(out.canTakeNumber, false);
  assert.equal(typeof out.nextTakeAt, 'number');
});

test('闲时客户端：取号返回号、状态、排位与轮询间隔（毫秒）', async () => {
  const m = await mock({ readyDelayMs: 60000, nextPollS: 90 });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const out = await client.take('offpeak-task-1');
  assert.deepEqual(out, { ticketId: 'mock-ticket-1', state: 'queued', position: 1, nextPollMs: 90000 });
  assert.deepEqual(m.requests.at(-1).body, { task_id: 'offpeak-task-1' });
});

test('闲时客户端：取号时服务器没给 next_poll_after，轮询间隔按 60 秒', async () => {
  const m = await mock({
    failRoute: { take: { status: 200, body: { code: 0, msg: 'success', data: { ticket_id: 't-1', state: 'queued', position: 3 } } } },
  });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const out = await client.take('offpeak-task-1');
  assert.equal(out.nextPollMs, 60000);
});

test('闲时客户端：查排位返回每个号的状态，就绪的带 readyDeadline，未知号是 not_found', async () => {
  const m = await mock({ readyDelayMs: 0, nextPollS: 5 });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const { ticketId } = await client.take('offpeak-task-2');
  const out = await client.status([ticketId, '1000000000000000000']);
  assert.equal(out.nextPollMs, 5000);
  assert.equal(out.tickets.length, 2);
  assert.equal(out.tickets[0].ticketId, ticketId);
  assert.equal(out.tickets[0].state, 'ready');
  assert.equal(out.tickets[0].position, null);
  assert.equal(typeof out.tickets[0].readyDeadline, 'number');
  assert.deepEqual(out.tickets[1], { ticketId: '1000000000000000000', state: 'not_found', position: null });
});

test('闲时客户端：开跑后的号带 activeDeadline', async () => {
  const m = await mock({ readyDelayMs: 0 });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const { ticketId } = await client.take('offpeak-task-3');
  assert.equal(m.activate(ticketId), true);
  const out = await client.status([ticketId]);
  assert.equal(out.tickets[0].state, 'active');
  assert.equal(typeof out.tickets[0].activeDeadline, 'number');
});

test('闲时客户端：查排位一次最多发 100 个号', async () => {
  const m = await mock();
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const ids = Array.from({ length: 120 }, (_, i) => String(i));
  const out = await client.status(ids);
  assert.equal(m.requests.at(-1).body.ticket_ids.length, 100);
  assert.equal(out.tickets.length, 100);
});

test('闲时客户端：结算返回 settled 与结算时间；票号按 URL 编码', async () => {
  const m = await mock();
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const { ticketId } = await client.take('offpeak-task-4');
  const out = await client.settle(ticketId);
  assert.equal(out.state, 'settled');
  assert.equal(typeof out.settledAt, 'number');
  await client.settle('a/b');
  assert.equal(m.requests.at(-1).path, '/api/v1/off-peak/ticket/a%2Fb/settle');
});

test('闲时客户端：同一任务再取号，旧号作废', async () => {
  const m = await mock({ readyDelayMs: 60000 });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const first = await client.take('offpeak-task-5');
  const second = await client.take('offpeak-task-5');
  const out = await client.status([first.ticketId, second.ticketId]);
  assert.deepEqual(out.tickets.map((t) => t.state), ['expired', 'queued']);
});

test('闲时客户端：每个请求都带 Bearer JWT 与 Coding Plan key，有 body 的带 content-type', async () => {
  const m = await mock();
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  await client.availability();
  const { ticketId } = await client.take('offpeak-task-6');
  await client.status([ticketId]);
  await client.settle(ticketId);
  assert.equal(m.requests.length, 4);
  assert.ok(m.requests.every((r) => r.authOk), '有请求没带对鉴权头');
  assert.deepEqual(m.requests.map((r) => r.hasContentType), [false, true, true, false]);
});

test('闲时客户端：origin 缺省时取 ZCODE_EXECUTOR_OFFPEAK_ORIGIN', async () => {
  const m = await mock();
  const client = createOffPeakClient({ auth: AUTH, env: { ZCODE_EXECUTOR_OFFPEAK_ORIGIN: m.origin } });
  assert.deepEqual(await client.availability(), { canTakeNumber: true });
  assert.equal(m.requests.length, 1);
});

// ---------- 错误分类 ----------

test('闲时客户端：连不上服务器 → unavailable', async () => {
  const m = await mock();
  await m.close();
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const err = await rejection(client.take('offpeak-task-x'));
  assert.equal(err.details.kind, 'unavailable');
  assert.equal(err.details.step, 'take');
  assert.match(err.message, /取号/);
});

test('闲时客户端：服务器超时不答 → unavailable', async () => {
  const m = await mock({ failRoute: { status: { delayMs: 500 } } });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH, timeoutMs: 50 });
  const err = await rejection(client.status(['1']));
  assert.equal(err.details.kind, 'unavailable');
  assert.match(err.message, /查排位/);
  assert.match(err.message, /超时/);
});

test('闲时客户端：HTTP 5xx → unavailable，带 HTTP 状态与 logid', async () => {
  const m = await mock({ failRoute: { settle: { status: 502, body: { code: 2001, msg: 'bad gateway', logid: 'log-502' } } } });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const err = await rejection(client.settle('t-1'));
  assert.equal(err.details.kind, 'unavailable');
  assert.equal(err.details.httpStatus, 502);
  assert.equal(err.details.logid, 'log-502');
  assert.match(err.message, /结算/);
});

test('闲时客户端：业务码 3101 → not-applicable，说要 Coding Plan 订阅', async () => {
  const m = await mock({ eligible: false });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const err = await rejection(client.take('offpeak-task-x'));
  assert.equal(err.details.kind, 'not-applicable');
  assert.equal(err.details.bizCode, 3101);
  assert.match(err.message, /Coding Plan/);
});

test('闲时客户端：业务码 3103 → quota，带 nextTakeAt（毫秒时间戳）', async () => {
  const m = await mock({ quotaExhaustedCount: 1 });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const err = await rejection(client.take('offpeak-task-x'));
  assert.equal(err.details.kind, 'quota');
  assert.equal(err.details.bizCode, 3103);
  assert.equal(typeof err.details.nextTakeAt, 'number');
  assert.ok(err.details.nextTakeAt > Date.now());
});

test('闲时客户端：3103 的 next_take_at 在顶层也认', async () => {
  const m = await mock({ failRoute: { take: { status: 429, body: { code: 3103, msg: 'limit', next_take_at: 1790000000000 } } } });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const err = await rejection(client.take('offpeak-task-x'));
  assert.equal(err.details.nextTakeAt, 1790000000000);
});

test('闲时客户端：JWT 失效（HTTP 401）→ not-applicable，提示在 ZCode App 里重新登录', async () => {
  const m = await mock();
  const client = createOffPeakClient({ origin: m.origin, auth: { jwt: 'another-stale-jwt-value', planKey: PLAN_KEY } });
  const err = await rejection(client.availability());
  assert.equal(err.details.kind, 'not-applicable');
  assert.equal(err.details.httpStatus, 401);
  assert.match(err.message, /重新登录/);
  assert.match(err.message, /查资格/);
});

test('闲时客户端：HTTP 404 → changed，提示跑 doctor --offpeak', async () => {
  const m = await mock({ failRoute: { availability: { status: 404 } } });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const err = await rejection(client.availability());
  assert.equal(err.details.kind, 'changed');
  assert.equal(err.details.httpStatus, 404);
  assert.match(err.message, /zcode-executor doctor --offpeak/);
});

test('闲时客户端：没见过的业务码 → changed，带服务器原话、业务码与 logid', async () => {
  const m = await mock({ failRoute: { take: { status: 200, body: { code: 3999, msg: 'something new', logid: 'log-3999' } } } });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const err = await rejection(client.take('offpeak-task-x'));
  assert.equal(err.details.kind, 'changed');
  assert.equal(err.details.bizCode, 3999);
  assert.equal(err.details.logid, 'log-3999');
  assert.match(err.message, /something new/);
  assert.match(err.message, /doctor --offpeak/);
});

test('闲时客户端：返回形状不对 → changed', async () => {
  const cases = {
    availability: { code: 0, msg: 'success', data: { can_take_number: 'yes' } },
    take: { code: 0, msg: 'success', data: { ticket_id: 123, state: 'queued' } },
    status: { code: 0, msg: 'success', data: { tickets: 'none' } },
    settle: { code: 0, msg: 'success', data: null },
  };
  for (const [route, body] of Object.entries(cases)) {
    const m = await mock({ failRoute: { [route]: { status: 200, body } } });
    const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
    const call = { availability: () => client.availability(), take: () => client.take('x'), status: () => client.status(['1']), settle: () => client.settle('1') }[route];
    const err = await rejection(call());
    assert.equal(err.details.kind, 'changed', route);
    assert.equal(err.details.step, route);
  }
});

test('闲时客户端：返回不是 JSON → changed', async () => {
  const m = await mock({ failRoute: { availability: { status: 200, body: '<html>maintenance</html>' } } });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const err = await rejection(client.availability());
  assert.equal(err.details.kind, 'changed');
});

test('闲时客户端：服务器原话里带了凭据，错误里也查不到', async () => {
  const m = await mock({
    failRoute: { take: { status: 200, body: { code: 3999, msg: `bad header Bearer ${JWT} key ${PLAN_KEY}`, logid: 'log-echo' } } },
  });
  const client = createOffPeakClient({ origin: m.origin, auth: AUTH });
  const err = await rejection(client.take('offpeak-task-x'));
  assert.equal(err.details.kind, 'changed');
});
