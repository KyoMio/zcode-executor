// doctor 第 ⑤ 项与 doctor --offpeak（闲时内部接口自检，SPEC-offpeak F）的行为测试。
// 全部对 test/mock-appserver.mjs 与 test/mock-offpeak.mjs 跑：ZCODE_EXECUTOR_OFFPEAK_ORIGIN 指向本进程里的
// mock 闲时服务器，ZCODE_DATA_BASE_DIR 指进夹具，不碰真网络、不读真实 ~/.zcode、不花额度。
// CLI 必须异步起（spawn 而非 spawnSync）：mock 闲时服务器跑在本进程的事件循环里，同步等子进程会把它卡死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_PROVIDER_FIXTURE, readRecord, startMock } from './helpers.mjs';
import { startMockOffPeak } from './mock-offpeak.mjs';
import { runOffPeakCheck } from '../lib/offpeak-check.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'zcode-executor');
const dirs = [];
const servers = [];
test.after(async () => {
  for (const s of servers) await s.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// 测试用凭据：够长（scrubValues 只抹 ≥ 8 字符的值），和别的字符串不重叠
const TEST_JWT = 'doctor-jwt-header.doctor-jwt-payload.doctor-jwt-signature';
const FAKE_TICKET = '1000000000000000000';

// 只有 credentials.json 的账号型来源（legacy config.json 故意指向不存在的文件），③ 与全链路层都用账号型 provider
// envOverrides：值为 undefined 的键从子进程环境里删掉
async function runDoctor(args, { credentials = { jwt: TEST_JWT }, script, appVersion = '3.14.1', offpeak = {}, builtin, envOverrides = {} } = {}) {
  const mock = await startMock({ script, credentials, appVersion });
  dirs.push(mock.dir);
  if (builtin !== undefined) await writeFile(mock.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, JSON.stringify(builtin));
  const server = await startMockOffPeak({ jwt: TEST_JWT, planKey: mock.accountKeys.individual ?? 'unused-plan-key', ...offpeak });
  servers.push(server);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-doctor5-home-'));
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'zcode-doctor5-tmp-'));
  dirs.push(home, tmp);
  const env = {
    ...process.env,
    ZCODE_BIN: mock.zcodePath,
    ZCODE_EXECUTOR_HOME: home,
    ZCODE_CONFIG_PATH: path.join(home, 'no-such-config.json'),
    ZCODE_EXECUTOR_OFFPEAK_ORIGIN: server.origin,
    TMPDIR: tmp, // 个人 provider 文件与事件临时目录都落这里，跑完应当是空的
    ...mock.env,
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const child = spawn(process.execPath, [BIN, ...args], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const status = await new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return { status, stdout, stderr, mock, server, home, tmp };
}

// 目录下所有文件的内容拼起来（查凭据有没有落盘）
async function allFileText(dir) {
  let text = '';
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += await readFile(path.join(entry.parentPath ?? entry.path, entry.name), 'utf8');
  }
  return text;
}

// 通用收尾检查：临时目录清空、mock 子进程没留下、输出与落盘里查不到 JWT 与 key
async function assertCleanAndSecretFree(r) {
  assert.deepEqual(await readdir(r.tmp), [], '个人 provider 文件与事件临时目录都该删掉');
  const ps = execFileSync('ps', ['-Ao', 'command'], { encoding: 'utf8' });
  assert.equal(ps.includes(r.mock.dir), false, 'app-server 子进程应已收场');
  const secrets = [TEST_JWT, r.mock.accountKeys.individual, r.mock.accountKeys.team].filter(Boolean);
  const texts = [r.stdout, r.stderr, await allFileText(r.home), await readFile(r.mock.recordPath, 'utf8').catch(() => '')];
  for (const secret of secrets) {
    for (const text of texts) assert.equal(text.includes(secret), false, '输出、落盘与 mock 记录里不能有 JWT 或 key');
  }
}

const withoutRule = (providerId) => ({
  ...BUILTIN_PROVIDER_FIXTURE,
  config: {
    ...BUILTIN_PROVIDER_FIXTURE.config,
    providerConfigRules: {
      providerRules: BUILTIN_PROVIDER_FIXTURE.config.providerConfigRules.providerRules.filter((r) => r.providerId !== providerId),
    },
  },
});

test('doctor --offpeak --json：四层都符合 → ok，退出码 0，形状 {ok, offpeak}，零额度全链路走过一遍', async () => {
  const r = await runDoctor(['doctor', '--offpeak', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const out = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(out).sort(), ['offpeak', 'ok']);
  assert.equal(out.ok, true);
  assert.deepEqual(out.offpeak, {
    state: 'ok',
    layer: null,
    expected: null,
    actual: null,
    reason: null,
    logid: null,
    appVersion: '3.14.1',
    verifiedAppVersion: '3.14.1',
  });
  assert.equal(r.stderr, '', '结论 ok 时 zcode 子进程的 stderr 丢弃，stderr 必须为空');
  // 服务器约定层：查资格 + 假号查排位，不取号
  assert.deepEqual(r.server.requests.map((q) => q.path), ['/api/v1/off-peak/ticket/availability', '/api/v1/off-peak/ticket/status']);
  assert.deepEqual(r.server.requests[1].body, { ticket_ids: [FAKE_TICKET] });
  // 全链路层：推授权 → deferred 会话 → 假号发一回合 → close；--offpeak 不跑 ③ 的握手
  const record = readRecord(r.mock.recordPath);
  const methods = record.map((m) => m.method).filter(Boolean);
  assert.deepEqual(methods.filter((m) => m !== 'session/subscribe'), ['provider/updateAccountConfig', 'session/create', 'session/send', 'v4/command', 'session/close']);
  assert.equal(record.find((m) => m.method === 'session/create').params.persistence, 'deferred');
  const sent = record.find((m) => m.method === 'session/send').params;
  assert.equal(sent.modelSelection.providerId, 'account:bigmodel-offpeak-idle-plan');
  assert.equal(sent.modelSelection.modelId, 'GLM-5.3');
  assert.equal(sent.offPeakTaskId, 'offpeak-doctor-check');
  assert.equal(sent.modelExecution.requestAuth.headers['X-Off-Peak-Ticket-ID'], FAKE_TICKET);
  // 自检回合禁掉全部工具（CLI 的 toolDenylist 只认确切名字，列全常用工具），提示词只要求回复 ok
  for (const tool of ['Bash', 'Write', 'Edit', 'Read', 'Agent', 'WebFetch', 'CronCreate', 'OffPeakCreate']) {
    assert.ok(sent.toolDenylist.includes(tool), tool);
  }
  assert.match(sent.content, /\bok\b/);
  // 自检会话起一个好认的标题（v4 renameSession）
  const rename = record.find((m) => m.method === 'v4/command' && m.params.type === 'renameSession');
  assert.equal(rename.params.payload.title, 'zcode-executor doctor 闲时自检');
  await assertCleanAndSecretFree(r);
});

test('doctor --offpeak 人读：只有 ⑤ 一行「正常」', async () => {
  const r = await runDoctor(['doctor', '--offpeak']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'doctor ⑤ 闲时：正常\n');
});

test('内置文件里闲时条目被删 → 接口变了（内置条目），退出码 1', async () => {
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { builtin: withoutRule('account:bigmodel-offpeak-idle-plan') });
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.offpeak.state, 'changed');
  assert.equal(out.offpeak.layer, 'builtin');
  assert.match(out.offpeak.expected, /account:bigmodel-offpeak-idle-plan/);
  assert.equal(r.server.requests.length, 0, '前一层不符就停，不再问服务器');

  const plain = await runDoctor(['doctor', '--offpeak'], { builtin: withoutRule('account:bigmodel-offpeak-idle-plan') });
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /^doctor ⑤ 闲时：接口变了（内置条目：期望 .+，实际 .+）\n$/);
});

test('闲时条目的 baseUrl 变了 → 接口变了（内置条目），期望与实际都写明', async () => {
  const builtin = structuredClone(BUILTIN_PROVIDER_FIXTURE);
  builtin.config.providerConfigRules.providerRules.find((p) => p.providerId === 'account:bigmodel-offpeak-idle-plan').config.api.baseUrl = 'https://zcode.z.ai/api/v2/idle';
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { builtin });
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'changed');
  assert.equal(out.offpeak.layer, 'builtin');
  assert.match(out.offpeak.expected, /https:\/\/zcode\.z\.ai\/api\/v1\/off-peak\/anthropic/);
  assert.match(out.offpeak.actual, /api\/v2\/idle/);
});

test('服务器查排位回的假号状态不是 not_found → 接口变了（服务器约定），带 logid', async () => {
  const offpeak = {
    failRoute: {
      status: { status: 200, body: { code: 0, logid: 'log-status-shape', data: { tickets: [{ ticket_id: FAKE_TICKET, state: 'queued' }] } } },
    },
  };
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { offpeak });
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'changed');
  assert.equal(out.offpeak.layer, 'server');
  assert.match(out.offpeak.expected, /not_found/);
  assert.match(out.offpeak.actual, /queued/);
  assert.equal(out.offpeak.logid, 'log-status-shape');
  assert.equal(readRecord(r.mock.recordPath).length, 0, '服务器层不符就不起 app-server');

  const plain = await runDoctor(['doctor', '--offpeak'], { offpeak });
  assert.match(plain.stdout, /^doctor ⑤ 闲时：接口变了（服务器约定：期望 .+，实际 .+，logid log-status-shape）\n$/);
});

test('服务器回的返回形状不对（tickets 不是数组）→ 接口变了（服务器约定）', async () => {
  const offpeak = { failRoute: { status: { status: 200, body: { code: 0, data: { tickets: 'nope' } } } } };
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { offpeak });
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'changed');
  assert.equal(out.offpeak.layer, 'server');
  assert.match(out.offpeak.logid, /^mock-log-/);
});

test('全链路授权没生效（CLI 用的内置版本号对不上）→ 回合报 provider_not_found → 接口变了（全链路），退出码 1', async () => {
  // 剧本让 mock 眼里的内置 revision 和文件里的不同：模拟 CLI 用的是另一版内置配置（如 CDN 刷新过的活动副本）
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { script: { builtinRevision: 'cdn-refreshed-2' } });
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'changed');
  assert.equal(out.offpeak.layer, 'chain');
  assert.match(out.offpeak.expected, /3104/);
  assert.match(out.offpeak.actual, /provider_not_found/);
  await assertCleanAndSecretFree(r);
});

test('全链路回合的错误码不是 3104 → 接口变了（全链路），actual 写明实际错误码', async () => {
  const script = { offPeakTurnError: { code: '3001', message: 'parameter error' } };
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { script });
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'changed');
  assert.equal(out.offpeak.layer, 'chain');
  assert.match(out.offpeak.actual, /3001/);
});

test('推授权被 app-server 拒 → 接口变了（全链路）', async () => {
  const script = { errors: { 'provider/updateAccountConfig': { code: -32602, message: 'Invalid params', data: { details: ['revision: unknown key'] } } } };
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { script });
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'changed');
  assert.equal(out.offpeak.layer, 'chain');
  assert.match(out.offpeak.actual, /Invalid params/);
  await assertCleanAndSecretFree(r);
});

test('闲时服务器回 503 → 暂时不可用，退出码 0，stderr 另有一行警告', async () => {
  const offpeak = { failRoute: { availability: { status: 503 } } };
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { offpeak });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.offpeak.state, 'unavailable');
  assert.equal(out.offpeak.layer, 'server');
  assert.match(out.offpeak.reason, /503/);
  assert.match(r.stderr, /^doctor: 警告：闲时.+$/m);

  const plain = await runDoctor(['doctor', '--offpeak'], { offpeak });
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /^doctor ⑤ 闲时：暂时不可用（.*503.*）\n$/);
});

test('没有 JWT（没在 App 里用账号登录）→ 不适用，退出码 0，不问服务器', async () => {
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { credentials: {} });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'not-applicable');
  assert.equal(out.offpeak.layer, 'credentials');
  assert.match(out.offpeak.reason, /zcodejwttoken/);
  assert.equal(r.server.requests.length, 0);

  const plain = await runDoctor(['doctor', '--offpeak'], { credentials: {} });
  assert.match(plain.stdout, /^doctor ⑤ 闲时：不适用（.+）\n$/);
});

test('只有团队版 key → 不适用（团队版暂不支持）', async () => {
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { credentials: { individual: false, team: true, jwt: TEST_JWT } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'not-applicable');
  assert.match(out.offpeak.reason, /团队版/);
});

test('App 版本不是 3.14.1 → stderr 多一行提示，不影响结论；推不出版本报「未知」', async () => {
  const older = await runDoctor(['doctor', '--offpeak', '--json'], { appVersion: '3.13.0' });
  assert.equal(older.status, 0, older.stderr);
  const out = JSON.parse(older.stdout);
  assert.equal(out.offpeak.state, 'ok');
  assert.equal(out.offpeak.appVersion, '3.13.0');
  assert.match(older.stderr, /^doctor: 闲时路径只在 App 3\.14\.1 上真机验证过（当前 3\.13\.0）$/m);

  const unknown = await runDoctor(['doctor', '--offpeak', '--json'], { appVersion: null });
  assert.equal(JSON.parse(unknown.stdout).offpeak.appVersion, null);
  assert.match(unknown.stderr, /^doctor: 闲时路径只在 App 3\.14\.1 上真机验证过（当前 未知）$/m);
});

test('不带参数的 doctor：①–④ 之后多一行 ⑤，--json 多 offpeak 对象', async () => {
  const r = await runDoctor(['doctor']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.match(lines[0], /^doctor ① /);
  assert.equal(lines.at(-1), 'doctor ⑤ 闲时：正常');
  assert.match(lines.at(-2), /^doctor ④ /);

  const json = await runDoctor(['doctor', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const out = JSON.parse(json.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.handshake.ok, true);
  assert.equal(out.offpeak.state, 'ok');
  await assertCleanAndSecretFree(json);
});

test('不带参数的 doctor：⑤ 接口变了 → 退出码 1；⑤ 不适用或暂时不可用不改原有结论', async () => {
  const changed = await runDoctor(['doctor', '--json'], { builtin: withoutRule('account:bigmodel-offpeak-idle-plan') });
  assert.equal(changed.status, 1, changed.stderr);
  const out = JSON.parse(changed.stdout);
  assert.equal(out.handshake.ok, true);
  assert.equal(out.offpeak.state, 'changed');
  assert.equal(out.ok, false);

  const na = await runDoctor(['doctor', '--json'], { credentials: { jwt: undefined } });
  assert.equal(na.status, 0, na.stderr);
  assert.equal(JSON.parse(na.stdout).offpeak.state, 'not-applicable');

  const down = await runDoctor(['doctor'], { offpeak: { failRoute: { availability: { status: 503 } } } });
  assert.equal(down.status, 0, down.stderr);
  assert.match(down.stdout, /doctor ⑤ 闲时：暂时不可用/);
});

test('全链路结论不是 ok 时才打印 zcode 子进程的 stderr（按 secrets 抹过，最多 50 行）', async () => {
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { script: { builtinRevision: 'cdn-refreshed-2' } });
  assert.equal(JSON.parse(r.stdout).offpeak.state, 'changed');
  const zcodeLines = r.stderr.split('\n').filter((l) => l.startsWith('zcode: '));
  assert.ok(zcodeLines.length > 0, r.stderr);
  assert.ok(zcodeLines.length <= 50);
  await assertCleanAndSecretFree(r);
});

test('推授权被拒的原话里带着凭据 → actual 按 secrets 抹掉', async () => {
  const script = { errors: { 'provider/updateAccountConfig': { code: -32602, message: `bad token ${TEST_JWT}` } } };
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { script });
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'changed');
  assert.match(out.offpeak.actual, /bad token <redacted>/);
  await assertCleanAndSecretFree(r);
});

test('结论是不适用时不打「只在 3.14.1 上验证过」的提示', async () => {
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { credentials: {}, appVersion: '3.13.0' });
  assert.equal(JSON.parse(r.stdout).offpeak.state, 'not-applicable');
  assert.doesNotMatch(r.stderr, /真机验证过/);
});

test('zcode 找不到（没装 ZCode App）→ 不适用', async () => {
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { envOverrides: { ZCODE_BIN: '/nonexistent/zcode.cjs' } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'not-applicable');
  assert.match(out.offpeak.reason, /zcode/);
  assert.equal(r.server.requests.length, 0);
});

test('zcode 在、内置文件不在（App 换了目录布局）→ 接口变了（内置条目）', async () => {
  const r = await runDoctor(['doctor', '--offpeak', '--json'], { envOverrides: { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: undefined } });
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.offpeak.state, 'changed');
  assert.equal(out.offpeak.layer, 'builtin');
});

test('闲时服务地址不合法：不带参数的 doctor 报 ⑤ 暂时不可用并照常输出 --json；--offpeak 直接报错', async () => {
  const envOverrides = { ZCODE_EXECUTOR_OFFPEAK_ORIGIN: 'http://example.com' };
  const plain = await runDoctor(['doctor', '--json'], { envOverrides });
  assert.equal(plain.status, 0, plain.stderr);
  const out = JSON.parse(plain.stdout);
  assert.equal(out.handshake.ok, true);
  assert.equal(out.offpeak.state, 'unavailable');
  assert.match(out.offpeak.reason, /ZCODE_EXECUTOR_OFFPEAK_ORIGIN/);

  const only = await runDoctor(['doctor', '--offpeak', '--json'], { envOverrides });
  assert.equal(only.status, 1);
  assert.equal(only.stdout, '');
  assert.match(only.stderr, /^doctor: 闲时服务地址必须是 https/m);
});

// ---------- 直接调 runOffPeakCheck：暂时性失败、重跑、形状不对（SPEC-offpeak F「补充分类」） ----------

// 在临时 TMPDIR 里跑一次 runOffPeakCheck，返回结果、mock 与 TMPDIR 里剩下的东西。
// 本文件的用例依次跑（node:test 同文件默认不并发），临时改 process.env.TMPDIR 不会串
async function directCheck({ script, zcodePath, turnTimeoutMs } = {}) {
  const mock = await startMock({ script, credentials: { jwt: TEST_JWT }, appVersion: '3.14.1' });
  dirs.push(mock.dir);
  const server = await startMockOffPeak({ jwt: TEST_JWT, planKey: mock.accountKeys.individual });
  servers.push(server);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'zcode-doctor5-direct-'));
  dirs.push(tmp);
  const env = { ...process.env, ...mock.env, ZCODE_BIN: mock.zcodePath, ZCODE_CONFIG_PATH: path.join(tmp, 'no-such-config.json'), ZCODE_EXECUTOR_OFFPEAK_ORIGIN: server.origin };
  const stderrLines = [];
  const savedTmp = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  let result;
  try {
    result = await runOffPeakCheck({ env, zcodePath, turnTimeoutMs, writeStderr: (line) => stderrLines.push(line) });
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
  }
  const sends = readRecord(mock.recordPath).filter((m) => m.method === 'session/send');
  return { result, mock, sends, leftovers: await readdir(tmp), stderrLines };
}

test('直接调：回合在 turnTimeoutMs 内没结束 → 暂时不可用', async () => {
  const r = await directCheck({ script: { offPeakTurnError: false, turns: [{ hang: true }] }, turnTimeoutMs: 300 });
  assert.equal(r.result.state, 'unavailable');
  assert.equal(r.result.layer, 'chain');
  assert.match(r.result.reason, /没结束/);
  assert.deepEqual(r.leftovers, []);
});

test('直接调：回合中 app-server 退出 → 暂时不可用', async () => {
  const r = await directCheck({ script: { exitAfter: 'session/send' } });
  assert.equal(r.result.state, 'unavailable');
  assert.deepEqual(r.leftovers, []);
});

test('直接调：session/create 被拒 → 暂时不可用', async () => {
  const r = await directCheck({ script: { errors: { 'session/create': { code: -32603, message: 'Provider Registry 中不存在 Model' } } } });
  assert.equal(r.result.state, 'unavailable');
  assert.match(r.result.reason, /session\/create/);
  assert.deepEqual(r.leftovers, []);
});

test('直接调：app-server 拉起来就退出 → 暂时不可用（进程退出不当成对端拒绝）', async () => {
  const dead = await mkdtemp(path.join(os.tmpdir(), 'zcode-doctor5-dead-'));
  dirs.push(dead);
  const zcodePath = path.join(dead, 'zcode.mjs');
  await writeFile(zcodePath, 'process.exit(1);\n');
  const r = await directCheck({ zcodePath });
  assert.equal(r.result.state, 'unavailable');
  assert.equal(r.result.layer, 'chain');
  assert.deepEqual(r.leftovers, []);
});

test('直接调：create 返回形状不对（拿不到 sessionId）→ 接口变了', async () => {
  const r = await directCheck({ script: { sessionCreateResult: { settings: {} } } });
  assert.equal(r.result.state, 'changed');
  assert.equal(r.result.layer, 'chain');
  assert.match(r.result.actual, /sessionId/);
  assert.deepEqual(r.leftovers, []);
});

test('直接调：暂时性错误（attribution.reason rate_limited）→ 暂时不可用，不重跑', async () => {
  const script = { offPeakTurnError: { code: 'model_rate_limited', message: 'too many requests', attribution: { source: 'provider', reason: 'rate_limited' } } };
  const r = await directCheck({ script });
  assert.equal(r.result.state, 'unavailable');
  assert.equal(r.sends.length, 1);
  assert.deepEqual(r.leftovers, []);
});

test('直接调：3105（闲时还在排队）→ 暂时不可用', async () => {
  const r = await directCheck({ script: { offPeakTurnError: { code: '3105', message: 'queued' } } });
  assert.equal(r.result.state, 'unavailable');
  assert.equal(r.sends.length, 1);
});

test('直接调：3104/3105 以外的 31xx、回合反而成功 → 接口变了，不重跑', async () => {
  const expired = await directCheck({ script: { offPeakTurnError: { code: '3102', message: 'off-peak-ticket-expired: x' } } });
  assert.equal(expired.result.state, 'changed');
  assert.equal(expired.sends.length, 1);
  const done = await directCheck({ script: { offPeakTurnError: false } });
  assert.equal(done.result.state, 'changed');
  assert.match(done.result.actual, /done/);
  assert.equal(done.sends.length, 1);
  assert.deepEqual(done.leftovers, []);
});

test('直接调：没见过的失败先重跑一次，第二次符合 → 正常', async () => {
  const r = await directCheck({ script: { offPeakTurnErrors: [{ code: 'something_new', message: 'huh' }] } });
  assert.equal(r.result.state, 'ok');
  assert.equal(r.sends.length, 2);
  assert.deepEqual(r.stderrLines, [], 'ok 时两次全链路的 zcode stderr 都丢弃');
  assert.deepEqual(r.leftovers, []);
});

test('直接调：没见过的失败重跑一次仍不符 → 接口变了，打印最后一次的 zcode stderr', async () => {
  const r = await directCheck({ script: { offPeakTurnError: { code: 'something_new', message: 'huh' } } });
  assert.equal(r.result.state, 'changed');
  assert.match(r.result.actual, /something_new/);
  assert.equal(r.sends.length, 2);
  assert.ok(r.stderrLines.length > 0 && r.stderrLines.length <= 50);
  assert.deepEqual(r.leftovers, []);
});
