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
async function runDoctor(args, { credentials = { jwt: TEST_JWT }, script, appVersion = '3.14.1', offpeak = {}, builtin } = {}) {
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
  assert.doesNotMatch(r.stderr, /真机验证过/);
  // 服务器约定层：查资格 + 假号查排位，不取号
  assert.deepEqual(r.server.requests.map((q) => q.path), ['/api/v1/off-peak/ticket/availability', '/api/v1/off-peak/ticket/status']);
  assert.deepEqual(r.server.requests[1].body, { ticket_ids: [FAKE_TICKET] });
  // 全链路层：推授权 → deferred 会话 → 假号发一回合 → close；--offpeak 不跑 ③ 的握手
  const record = readRecord(r.mock.recordPath);
  const methods = record.map((m) => m.method).filter(Boolean);
  assert.deepEqual(methods.filter((m) => m !== 'session/subscribe'), ['provider/updateAccountConfig', 'session/create', 'session/send', 'session/close']);
  assert.equal(record.find((m) => m.method === 'session/create').params.persistence, 'deferred');
  const sent = record.find((m) => m.method === 'session/send').params;
  assert.equal(sent.modelSelection.providerId, 'account:bigmodel-offpeak-idle-plan');
  assert.equal(sent.modelSelection.modelId, 'GLM-5.3');
  assert.equal(sent.offPeakTaskId, 'offpeak-doctor-check');
  assert.equal(sent.modelExecution.requestAuth.headers['X-Off-Peak-Ticket-ID'], FAKE_TICKET);
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
