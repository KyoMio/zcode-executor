// 闲时投递 runner 退出后的恢复与收尾窗口（任务 OP6）：send --offpeak --resume 的成功与拒绝、普通 send 被挡时与
// send --wait 见 runner 没了时提示怎么恢复、回合已结束（结算中）时的 --steer 不变成一次普通投递。
// 全部对 test/mock-appserver.mjs 与 test/mock-offpeak.mjs 跑，夹具见 test/offpeak-fixture.mjs；不碰真网络、不读真实 ~/.zcode。
// 每条都做泄密检查：runs 目录全部文件（含 runner.log）、命令输出、mock 记录里查不到 JWT 与 key。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readRecord, waitFor } from './helpers.mjs';
import {
  assertNoSecrets, cleanupAll, lay, offPeakJson, readEvents, readJson, runBin, settleRequests, setup, takeRequests, takeTicket,
  trackPids, waitRunnerGone,
} from './offpeak-fixture.mjs';

test.after(cleanupAll);

const RESUME_PROMPT = 'Continue the previous task from where it left off. The run was interrupted (app restart or execution window expired). '
  + 'Do not start over; review what has already been done and complete the remaining work.';
const lastJson = (s) => readJson(path.join(s.runsDir, 'last.json'));
const offpeakJson = (s) => readJson(path.join(s.runsDir, 'offpeak.json'));
const offPeakSends = (s) => readRecord(s.recordPath).filter((m) => m.method === 'session/send').map((m) => m.params);
const queueFiles = async (s) => (existsSync(path.join(s.runsDir, 'queue')) ? readdir(path.join(s.runsDir, 'queue')) : []);

/** 闲时投递跑到回合 exited、runner 退出：队列项留着，offpeak.json 停在 running。返回 send 的输出。 */
async function exitedOffPeak(s) {
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait', '--json']);
  trackPids(s.runsDir);
  assert.equal(r.status, 4, r.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(lastJson(s).outcome, 'exited');
  assert.equal((await queueFiles(s)).length, 1);
  return r;
}

test('exited 之后 send --offpeak --resume：只重新拉起 runner（不入队、不取号），续跑到 done 并结算', async (t) => {
  const s = await setup(t, { script: { exitAfter: 'session/send' } });
  const r = await exitedOffPeak(s);
  const { offPeakId } = offpeakJson(s);
  await writeFile(s.mock.env.MOCK_APPSERVER_SCRIPT, '{}'); // 子进程这次不再退出
  const resume = await runBin(s.env, ['send', s.entry.id, '--offpeak', '--resume']);
  assert.equal(resume.status, 0, resume.stderr);
  assert.equal(resume.stdout, `send: 已重新拉起 runner，继续闲时投递 ${offPeakId}\n`);
  await waitFor(() => lastJson(s).outcome === 'done', { timeoutMs: 30000 });
  trackPids(s.runsDir);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(takeRequests(s).length, 1, '恢复不取号');
  const sends = offPeakSends(s);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].content, RESUME_PROMPT);
  assert.equal(sends[1].offPeakRunType, 'resume');
  assert.equal(lastJson(s).text, '闲时的活');
  assert.deepEqual(settleRequests(s).map((q) => q.path.split('/').at(-2)), ['mock-ticket-1']);
  assert.equal(offpeakJson(s).phase, 'done');
  assert.deepEqual(await queueFiles(s), []);
  await assertNoSecrets(s, [r.stdout, r.stderr, resume.stdout, resume.stderr]);
});

test('send --offpeak --resume：runner 还活着 → 退出码 2，说明原因，不动队列', async (t) => {
  const s = await setup(t);
  const offPeakId = 'offpeak-00000000-0000-4000-8000-0000000000d1';
  const ticket = await takeTicket(s, offPeakId);
  await lay(s, { offpeak: offPeakJson(offPeakId, ticket.ticket_id, { phase: 'running' }), queue: [{ text: '闲时的活', offpeak: { offPeakId } }] });
  await writeFile(path.join(s.runsDir, 'lock'), JSON.stringify({ pid: process.pid })); // 本测试进程当作活着的 runner
  const r = await runBin(s.env, ['send', s.entry.id, '--offpeak', '--resume']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^send: .*runner 还活着/m);
  assert.equal((await queueFiles(s)).length, 1);
  assert.equal(takeRequests(s).length, 1);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('send --offpeak --resume：队列头不是这次闲时投递的项 → 退出码 2，说明原因，不起 runner', async (t) => {
  const s = await setup(t);
  const offPeakId = 'offpeak-00000000-0000-4000-8000-0000000000d2';
  const ticket = await takeTicket(s, offPeakId);
  await lay(s, { offpeak: offPeakJson(offPeakId, ticket.ticket_id, { phase: 'running' }), queue: [{ text: '普通的活' }] });
  const r = await runBin(s.env, ['send', s.entry.id, '--offpeak', '--resume']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^send: .*队列头不是/m);
  assert.equal(existsSync(path.join(s.runsDir, 'lock')), false);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

for (const [name, args] of [
  ['带了正文', ['正文', '--offpeak', '--resume']],
  ['没带 --offpeak', ['--resume']],
  ['带了 --timeout', ['--offpeak', '--resume', '--timeout', '60']],
  ['带了 --task', ['--offpeak', '--resume', '--task', 'README.md']],
]) {
  test(`send --resume ${name}：用法错，退出码 1，不起 runner`, async (t) => {
    const s = await setup(t);
    const r = await runBin(s.env, ['send', s.entry.id, ...args]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^send: .*--resume/m);
    assert.equal(existsSync(path.join(s.runsDir, 'lock')), false);
    assert.equal(s.server.requests.length, 0);
  });
}

test('runner 已死、队列头是闲时项时普通 send 被挡：退出码 2，提示用 --offpeak --resume 恢复或 cancel', async (t) => {
  const s = await setup(t, { script: { exitAfter: 'session/send' } });
  const r = await exitedOffPeak(s);
  const plain = await runBin(s.env, ['send', s.entry.id, '普通的活']);
  assert.equal(plain.status, 2, plain.stderr);
  assert.match(plain.stderr, new RegExp(`send ${s.entry.id} --offpeak --resume`));
  assert.match(plain.stderr, /cancel/);
  const steer = await runBin(s.env, ['send', s.entry.id, '插话', '--steer']);
  assert.equal(steer.status, 2, steer.stderr);
  assert.match(steer.stderr, /--offpeak --resume/);
  assert.equal((await queueFiles(s)).length, 1, '被挡的投递不入队');
  await assertNoSecrets(s, [r.stdout, r.stderr, plain.stdout, plain.stderr, steer.stdout, steer.stderr]);
});

test('send --offpeak --wait 排号中 runner 被杀：提示用 --offpeak --resume 恢复或 cancel，退出码 4', async (t) => {
  const s = await setup(t, { offpeak: { readyDelayMs: 60000 } });
  const child = runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak', '--wait']);
  await waitFor(() => s.server.requests.some((q) => q.path.endsWith('/ticket/status')));
  const { runnerPid } = trackPids(s.runsDir);
  process.kill(runnerPid, 'SIGKILL');
  const r = await child;
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stdout, new RegExp(`runner 没了（pid ${runnerPid}）.*send ${s.entry.id} --offpeak --resume.*cancel`));
  assert.doesNotMatch(r.stdout, /再 send 一次会重起 runner/);
  await assertNoSecrets(s, [r.stdout, r.stderr]);
});

test('回合已结束、正在结算号时 --steer：runner 不把它当普通投递（不再发 session/send），记 executor.steer_failed', async (t) => {
  const s = await setup(t, { offpeak: { failRoute: { settle: { delayMs: 2000, times: 1 } } } });
  const r = await runBin(s.env, ['send', s.entry.id, '闲时的活', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  await waitFor(() => settleRequests(s).length >= 1, { timeoutMs: 30000 });
  trackPids(s.runsDir);
  assert.equal(offpeakJson(s).phase, 'running', '结算期间 offpeak.json 还是 running');
  const steer = await runBin(s.env, ['send', s.entry.id, '顺手补个测试', '--steer']);
  assert.equal(steer.status, 0, steer.stderr);
  await waitRunnerGone(s.runsDir);
  trackPids(s.runsDir);
  assert.equal(offPeakSends(s).length, 1, '插话不能变成一次普通投递');
  assert.equal(lastJson(s).outcome, 'done');
  assert.equal(lastJson(s).text, '闲时的活');
  const failed = readEvents(s.runsDir).filter((e) => e.type === 'executor.steer_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].text, '顺手补个测试');
  assert.match(failed[0].reason, /闲时回合已结束/);
  assert.equal(offpeakJson(s).phase, 'done');
  assert.deepEqual(await queueFiles(s), []);
  await assertNoSecrets(s, [r.stdout, r.stderr, steer.stdout, steer.stderr]);
});
