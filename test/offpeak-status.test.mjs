// 闲时投递的显示与等待（SPEC-offpeak A.5、B.1、E，任务 OP6）：status / follow 的闲时行与 --json.offpeak、
// send --wait 的排号时间不计入 --timeout、--stream 的排位行、macOS 上等号期间挂 caffeinate。
// 全部对 test/mock-appserver.mjs 与 test/mock-offpeak.mjs 跑，夹具见 test/offpeak-fixture.mjs；不碰真网络、不读真实 ~/.zcode。
// 每条都做泄密检查：runs 目录全部文件（含 runner.log）、命令输出、mock 记录里查不到 JWT 与 key。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { killAll, waitFor } from './helpers.mjs';
import {
  assertNoSecrets, cleanupAll, isAlive, readJson, runBin, settleRequests, setup, trackPids, waitRunnerGone,
} from './offpeak-fixture.mjs';

test.after(cleanupAll);

const offpeakJson = (s) => readJson(path.join(s.runsDir, 'offpeak.json'));
const statusPolls = (s) => s.server.requests.filter((q) => q.path.endsWith('/ticket/status')).length;
const LONG_TURN = { turns: [{ events: [
  { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'a' }, delayMs: 3000 },
  { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'b' }, delayMs: 3000 },
] }] };

/** 起一次闲时投递并等它开始排号（号 60 秒后才就绪）；返回 send 的输出。 */
async function queuedOffPeak(s) {
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => statusPolls(s) >= 1);
  trackPids(s.runsDir);
  return r;
}

/** 收尾：cancel 掉还在排号的闲时投递，等 runner 退出。 */
async function cancelAndWait(s) {
  const cancel = await runBin(s.env, ['cancel', s.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitRunnerGone(s.runsDir);
  return cancel;
}

test('status 排号中：多一行「闲时：排第 N 位（号 …，第 k/3 个号）」；--json 带 offpeak 对象（offpeak.json 的内容）', async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 60000 } });
  const r = await queuedOffPeak(s);
  const human = await runBin(s.env, ['status', s.entry.id]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^ {2}闲时：排第 1 位（号 mock-ticket-1，第 1\/3 个号）$/m);
  const json = await runBin(s.env, ['status', s.entry.id, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const out = JSON.parse(json.stdout);
  const file = offpeakJson(s);
  assert.deepEqual(Object.keys(out.offpeak).sort(), Object.keys(file).sort());
  for (const k of ['offPeakId', 'ticketId', 'ticketCount', 'phase', 'position', 'startedAt', 'unsettledTickets']) assert.deepEqual(out.offpeak[k], file[k], k);
  const cancel = await cancelAndWait(s);
  await assertNoSecrets(s, [r.stdout, r.stderr, human.stdout, human.stderr, json.stdout, json.stderr, cancel.stdout, cancel.stderr]);
});

test('status --json：没有闲时投递时 offpeak 为 null，其余字段照旧', async (t) => {
  const s = await setup(t);
  const json = await runBin(s.env, ['status', s.entry.id, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const out = JSON.parse(json.stdout);
  assert.equal(out.offpeak, null);
  for (const k of ['id', 'sessionId', 'phase', 'cwd', 'current', 'tools', 'queue', 'steerUnavailable', 'pending', 'last', 'totalTokens']) assert.ok(k in out, k);
  const human = await runBin(s.env, ['status', s.entry.id]);
  assert.doesNotMatch(human.stdout, /闲时/);
});

test('status 运行中：多一行「闲时：运行中（号 …，最晚 <本地时间> 截止）」', async (t) => {
  const s = await setup(t, { script: LONG_TURN });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => offpeakJson(s).startedAt, { timeoutMs: 30000 });
  trackPids(s.runsDir);
  const human = await runBin(s.env, ['status', s.entry.id]);
  assert.equal(human.status, 0, human.stderr);
  const deadline = new Date(offpeakJson(s).activeDeadline).toLocaleString();
  assert.ok(human.stdout.includes(`  闲时：运行中（号 mock-ticket-1，最晚 ${deadline} 截止）`), human.stdout);
  const cancel = await cancelAndWait(s);
  await assertNoSecrets(s, [r.stdout, r.stderr, human.stdout, human.stderr, cancel.stdout, cancel.stderr]);
});

test('status：号没结算成时多一行「闲时：号 … 未结算」', async (t) => {
  const s = await setup(t, { offpeak: { failRoute: { settle: { status: 500 } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  await waitRunnerGone(s.runsDir);
  assert.equal(settleRequests(s).length, 4);
  const human = await runBin(s.env, ['status', s.entry.id]);
  assert.match(human.stdout, /^ {2}闲时：号 mock-ticket-1 未结算$/m);
  assert.doesNotMatch(human.stdout, /排第|运行中/, '投递收尾了就不再显示排位或运行');
  await assertNoSecrets(s, [r.stdout, r.stderr, human.stdout, human.stderr]);
});

test('status：runner 已死而闲时投递没收尾时提示用 --offpeak --resume 恢复或 cancel', async (t) => {
  const s = await setup(t, { script: { exitAfter: 'session/send' } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  const human = await runBin(s.env, ['status', s.entry.id]);
  assert.match(human.stdout, new RegExp(`^ {2}闲时：投递 offpeak-[0-9a-f-]{36} 没收尾，runner 已不在：用 send ${s.entry.id} --offpeak --resume 接着跑，或 cancel`, 'm'));
  await assertNoSecrets(s, [r.stdout, r.stderr, human.stdout, human.stderr]);
});

test('follow 排号中：stderr 打闲时排位行；--json 带 offpeak 对象', async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 60000 } });
  const r = await queuedOffPeak(s);
  const human = await runBin(s.env, ['follow', s.entry.id, '--timeout', '1']);
  assert.equal(human.status, 3, human.stderr);
  assert.match(human.stderr, /^follow: 闲时：排第 1 位（号 mock-ticket-1，第 1\/3 个号）$/m);
  const json = await runBin(s.env, ['follow', s.entry.id, '--timeout', '1', '--json']);
  assert.equal(json.status, 3, json.stderr);
  const out = JSON.parse(json.stdout);
  assert.equal(out.kind, 'follow-timeout');
  assert.equal(out.offpeak.ticketId, 'mock-ticket-1');
  assert.equal(out.offpeak.phase, 'queued');
  const cancel = await cancelAndWait(s);
  await assertNoSecrets(s, [r.stdout, r.stderr, human.stdout, human.stderr, json.stdout, json.stderr, cancel.stdout, cancel.stderr]);
});

test('send --offpeak --wait：排号时间不计入 --timeout，排号比 --timeout 长也等到 done（退出码 0）', async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 2500 } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--timeout', '1', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).outcome, 'done');
  await waitRunnerGone(s.runsDir);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('send --offpeak --wait --stream：排号期间每次轮询在 stderr 打一行排位', async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 1500 } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--stream']);
  trackPids(s.runsDir);
  assert.equal(r.status, 0, r.stderr);
  const lines = [...r.stderr.matchAll(/^stream: 闲时：排第 1 位（号 mock-ticket-1，第 1\/3 个号）$/gm)];
  assert.ok(lines.length >= 2, r.stderr);
  await waitRunnerGone(s.runsDir);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('macOS：等号期间挂着 caffeinate -i -w <runner pid>，runner 被杀后它也跟着退出（不留孤儿进程）', { skip: process.platform !== 'darwin' && '只在 macOS 上跑' }, async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 60000 }, envExtra: { ZCODE_EXECUTOR_NO_CAFFEINATE: '' } });
  const found = [];
  t.after(() => killAll(found));
  const r = await queuedOffPeak(s);
  const { runnerPid } = trackPids(s.runsDir);
  const caffeinated = () => {
    try {
      return execFileSync('pgrep', ['-f', `caffeinate -i -w ${runnerPid}$`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
    } catch {
      return []; // pgrep 找不到时退 1
    }
  };
  const pids = await waitFor(() => (caffeinated().length > 0 ? caffeinated() : null));
  found.push(...pids);
  process.kill(runnerPid, 'SIGKILL'); // 不给 runner 收尾的机会：只靠 -w 让 caffeinate 退出
  await waitFor(() => pids.every((pid) => !isAlive(pid)));
  const cancel = await runBin(s.env, ['cancel', s.entry.id]); // runner 不在了，由 CLI 结算号
  assert.equal(cancel.status, 0, cancel.stderr);
  await assertNoSecrets(s, [r.stdout, r.stderr, cancel.stdout, cancel.stderr]);
});

test('macOS：ZCODE_EXECUTOR_NO_CAFFEINATE=1 时等号期间不起 caffeinate', { skip: process.platform !== 'darwin' && '只在 macOS 上跑' }, async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 60000 } }); // 夹具默认就设了 ZCODE_EXECUTOR_NO_CAFFEINATE=1
  assert.equal(s.env.ZCODE_EXECUTOR_NO_CAFFEINATE, '1');
  const r = await queuedOffPeak(s);
  const { runnerPid } = trackPids(s.runsDir);
  await waitFor(() => statusPolls(s) >= 3); // 多等几轮轮询，给 caffeinate 足够的机会冒出来
  let found = '';
  try {
    found = execFileSync('pgrep', ['-f', `caffeinate -i -w ${runnerPid}$`], { encoding: 'utf8' });
  } catch {
    // pgrep 找不到时退 1：正是期望的结果
  }
  assert.equal(found.trim(), '');
  const cancel = await cancelAndWait(s);
  await assertNoSecrets(s, [r.stdout, r.stderr, cancel.stdout, cancel.stderr]);
});
