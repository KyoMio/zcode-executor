// quota 命令（今天的闲时取号情况，零额度，SPEC-offpeak G）的行为测试。
// 对 test/mock-offpeak.mjs 跑：ZCODE_EXECUTOR_OFFPEAK_ORIGIN 指向本进程里的 mock 闲时服务器，凭据夹具来自 startMock，
// 不碰真网络、不读真实 ~/.zcode、不起 app-server。CLI 异步起（runBin）：mock 闲时服务器跑在本进程的事件循环里。
// 时区钉死（子进程经 env 继承）：默认 UTC+8，「只数本地今天」另跑一组 UTC−7，任何机器上都能抓出按 UTC 日期比较的错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './helpers.mjs';
import { startMockOffPeak } from './mock-offpeak.mjs';
import { runBin } from './offpeak-fixture.mjs';

const DEFAULT_TZ = 'Asia/Shanghai';
process.env.TZ = DEFAULT_TZ;

const dirs = [];
const servers = [];
test.after(async () => {
  for (const s of servers) await s.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const TEST_JWT = 'quota-jwt-header.quota-jwt-payload.quota-jwt-signature';

// 造环境：凭据夹具 + mock 闲时服务器 + 空家目录；events 形如 { '<会话 id>': [事件…] }，写进 runs/<id>/events.jsonl
async function setup({ credentials = { jwt: TEST_JWT }, offpeak = {}, events = {} } = {}) {
  const mock = await startMock({ credentials });
  dirs.push(mock.dir);
  const server = await startMockOffPeak({ jwt: TEST_JWT, planKey: mock.accountKeys.individual ?? 'unused-plan-key', ...offpeak });
  servers.push(server);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-quota-home-'));
  dirs.push(home);
  for (const [id, list] of Object.entries(events)) {
    await mkdir(path.join(home, 'runs', id), { recursive: true });
    await writeFile(path.join(home, 'runs', id, 'events.jsonl'), list.map((e) => `${JSON.stringify(e)}\n`).join(''));
  }
  const env = {
    ...process.env,
    ZCODE_BIN: mock.zcodePath,
    ZCODE_EXECUTOR_HOME: home,
    ZCODE_EXECUTOR_OFFPEAK_ORIGIN: server.origin,
    ...mock.env,
  };
  return { mock, server, home, env };
}

// 输出、家目录、mock app-server 的记录里都查不到 JWT 与 key；而且没起 app-server（没有记录、runs 下没有 runner 的锁）
async function assertZeroCostAndSecretFree(s, r) {
  const secrets = [TEST_JWT, s.mock.accountKeys.individual, s.mock.accountKeys.team].filter(Boolean);
  for (const secret of secrets) {
    assert.equal(r.stdout.includes(secret), false, 'stdout 不能有凭据');
    assert.equal(r.stderr.includes(secret), false, 'stderr 不能有凭据');
    assert.equal(JSON.stringify(s.server.requests).includes(secret), false, 'mock 记录不能有凭据');
  }
  assert.equal(existsSync(s.mock.recordPath) && readFileSync(s.mock.recordPath, 'utf8').trim() !== '', false, '不该起 app-server');
  const runs = existsSync(path.join(s.home, 'runs')) ? await readdir(path.join(s.home, 'runs')) : [];
  for (const id of runs) {
    assert.equal(existsSync(path.join(s.home, 'runs', id, 'lock')), false, '不该起 runner');
  }
  assert.equal(s.server.requests.some((q) => q.method === 'POST'), false, '不取号、不查排位、不结算');
}

// 中文本地时间，24 小时制到分钟（如 2026/9/29 00:00）
const localText = (ms) =>
  new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));

// 本地时间的某天某时（day 0 = 今天，-1 = 昨天），转成事件里的 ISO UTC 字符串
function localAt(day, hour, minute = 0) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + day, hour, minute).toISOString();
}

test('quota：能取号时报今天本工具的次数与「现在可以取号」，退出码 0，只查资格', async () => {
  const s = await setup({ events: { x_a: [{ type: 'executor.offpeak.taken', at: new Date().toISOString(), offPeakId: 'offpeak-1' }] } });
  const r = await runBin(s.env, ['quota']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'quota: 闲时取号今天本工具已用 1 次（每天约 3 次，App 里用的不计入）；服务器：现在可以取号\n');
  assert.deepEqual(s.server.requests.map((q) => `${q.method} ${q.path}`), ['GET /api/v1/off-peak/ticket/availability']);
  await assertZeroCostAndSecretFree(s, r);
});

test('quota：额度用完时报服务器给的可再取时间（本地时间），退出码 0', async () => {
  const s = await setup({ offpeak: { quotaExhaustedCount: 1 } });
  const before = Date.now();
  const r = await runBin(s.env, ['quota', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.canTakeNumber, false);
  const next = Date.parse(out.nextTakeAt);
  assert.ok(next >= before + 60000 && next <= Date.now() + 60000, `nextTakeAt 应是 mock 给的「现在 + 60 秒」：${out.nextTakeAt}`);

  const humanBefore = Date.now();
  const human = await runBin(s.env, ['quota']);
  const humanAfter = Date.now();
  assert.equal(human.status, 0, human.stderr);
  const m = /^quota: 闲时取号今天本工具已用 0 次（每天约 3 次，App 里用的不计入）；服务器：今天额度已用完，(.+) 以后可再取\n$/.exec(human.stdout);
  assert.ok(m, human.stdout);
  // 人读行用中文本地时间（子进程与本进程同一时区）：mock 给的是请求时刻 + 60 秒，逐分钟列出候选
  const candidates = [];
  for (let t = Math.floor((humanBefore + 60000) / 60000) * 60000; t <= humanAfter + 60000; t += 60000) candidates.push(localText(t));
  assert.ok(candidates.includes(m[1]), `${m[1]} 应是本地时间，候选 ${candidates.join(' / ')}`);
  await assertZeroCostAndSecretFree(s, human);
});

for (const tz of [DEFAULT_TZ, 'America/Phoenix']) {
  test(`quota：只数本地今天的 taken 与 retaken，昨天的与别的事件不算（${tz}）`, async (t) => {
    process.env.TZ = tz; // localAt 与子进程都按这个时区
    t.after(() => { process.env.TZ = DEFAULT_TZ; });
    const s = await setup({
      events: {
        x_a: [
          { type: 'executor.offpeak.taken', at: localAt(0, 0, 30), offPeakId: 'offpeak-a' }, // 今天 00:30（UTC+8 下 UTC 日期是昨天）
          { type: 'executor.offpeak.ready', at: localAt(0, 0, 31), offPeakId: 'offpeak-a' },
          { type: 'executor.offpeak.retaken', at: localAt(0, 0, 40), offPeakId: 'offpeak-a' },
          { type: 'executor.offpeak.settled', at: localAt(0, 0, 50), offPeakId: 'offpeak-a' },
        ],
        x_b: [
          { type: 'executor.offpeak.taken', at: localAt(-1, 23, 30), offPeakId: 'offpeak-b' }, // 昨天 23:30（UTC−7 下 UTC 日期是今天）
          { type: 'executor.send', at: localAt(0, 0, 10) },
        ],
      },
    });
    // runs 下混一个不是目录的文件、一个没有 events.jsonl 的会话目录：都跳过
    await writeFile(path.join(s.home, 'runs', 'stray.txt'), 'x');
    await mkdir(path.join(s.home, 'runs', 'x_empty'));
    const r = await runBin(s.env, ['quota', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).usedToday, 2);
  });
}

test('quota：修改时间早于本地今天 0 点的 events.jsonl 整个跳过；坏行与 null 行不崩', async () => {
  const s = await setup({
    events: {
      x_old: [{ type: 'executor.offpeak.taken', at: new Date().toISOString(), offPeakId: 'offpeak-old' }],
      x_new: [{ type: 'executor.offpeak.taken', at: new Date().toISOString(), offPeakId: 'offpeak-new' }],
    },
  });
  // 事件只追加：文件最后改在昨天，里面不可能有今天的事件（这里故意放了一条，用来证明确实没读）
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000);
  await utimes(path.join(s.home, 'runs', 'x_old', 'events.jsonl'), yesterday, yesterday);
  const noisy = ['null', '{"type":"executor.offpeak.taken", 坏', '"executor.offpeak.taken"', '[]', '{"type":"executor.offpeak.retaken"}'].join('\n');
  await writeFile(path.join(s.home, 'runs', 'x_new', 'events.jsonl'), `${noisy}\n`, { flag: 'a' });
  const r = await runBin(s.env, ['quota', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).usedToday, 1);
});

test('quota：某个 events.jsonl 读不了只跳过它，stderr 打一行，退出码 0', { skip: process.getuid?.() === 0 && 'root 读得了 000 权限的文件' }, async () => {
  const now = new Date().toISOString();
  const s = await setup({
    events: {
      x_locked: [{ type: 'executor.offpeak.taken', at: now, offPeakId: 'offpeak-locked' }],
      x_ok: [{ type: 'executor.offpeak.taken', at: now, offPeakId: 'offpeak-ok' }],
    },
  });
  const locked = path.join(s.home, 'runs', 'x_locked', 'events.jsonl');
  await chmod(locked, 0o000);
  try {
    const r = await runBin(s.env, ['quota', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).usedToday, 1);
    assert.match(r.stderr, /^quota: .*x_locked.*\n$/);
  } finally {
    await chmod(locked, 0o600);
  }
});

test('quota：服务器说不能取但没给时间 → 「现在不能取号」', async () => {
  const s = await setup({ offpeak: { failRoute: { availability: { status: 200, body: { code: 0, msg: 'success', data: { can_take_number: false } } } } } });
  const r = await runBin(s.env, ['quota']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'quota: 闲时取号今天本工具已用 0 次（每天约 3 次，App 里用的不计入）；服务器：现在不能取号\n');
});

test('quota：闲时服务地址配错 → 报错退出码 1，不发请求', async () => {
  const s = await setup();
  const r = await runBin({ ...s.env, ZCODE_EXECUTOR_OFFPEAK_ORIGIN: 'http://example.com' }, ['quota']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^quota: 闲时服务地址必须是 https/);
  assert.deepEqual(s.server.requests, []);
});

test('quota --json：形状 {usedToday, estimatedDailyLimit, canTakeNumber, nextTakeAt, state, reason}', async () => {
  const s = await setup();
  const r = await runBin(s.env, ['quota', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    usedToday: 0,
    estimatedDailyLimit: 3,
    canTakeNumber: true,
    nextTakeAt: null,
    state: 'ok',
    reason: null,
  });
  await assertZeroCostAndSecretFree(s, r);
});

test('quota：凭据里没有 JWT → 不适用，退出码 0，不联网', async () => {
  const s = await setup({ credentials: {} });
  const r = await runBin(s.env, ['quota', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.state, 'not-applicable');
  assert.equal(out.canTakeNumber, null);
  assert.match(out.reason, /zcodejwttoken/);
  assert.deepEqual(s.server.requests, []);

  const human = await runBin(s.env, ['quota']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /^quota: 闲时取号今天本工具已用 0 次（每天约 3 次，App 里用的不计入）；服务器：不适用（.+）\n$/);
  await assertZeroCostAndSecretFree(s, human);
});

test('quota：闲时服务 503 → 暂时不可用，退出码 0', async () => {
  const s = await setup({ offpeak: { failRoute: { availability: { status: 503 } } } });
  const r = await runBin(s.env, ['quota', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.state, 'unavailable');
  assert.equal(out.canTakeNumber, null);
  assert.match(out.reason, /503/);

  const human = await runBin(s.env, ['quota']);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /；服务器：暂时不可用（.*503.*）\n$/);
  await assertZeroCostAndSecretFree(s, human);
});

test('quota：资格接口 404 → 接口变了，退出码 1', async () => {
  const s = await setup({ offpeak: { failRoute: { availability: { status: 404 } } } });
  const r = await runBin(s.env, ['quota', '--json']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.state, 'changed');
  assert.match(out.reason, /404/);

  const human = await runBin(s.env, ['quota']);
  assert.equal(human.status, 1);
  assert.match(human.stdout, /；服务器：接口变了（.*404.*）\n$/);
  await assertZeroCostAndSecretFree(s, human);
});
