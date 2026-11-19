// lib/credentials.mjs 的行为测试（T6-C）：凭据值的加解密、密钥派生、coding plan 四个键的读取规则。
// 全部用临时目录与测试自造的密钥（ZCODE_CREDENTIAL_SECRET 固定测试值），不碰真实 ~/.zcode（RULES §9）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  defaultCredentialsPath,
  decryptCredentialValue,
  deriveCredentialKey,
  readCodingPlanKeys,
  readOffPeakAuth,
  readStartPlanAuth,
} from '../lib/credentials.mjs';

const dirs = [];
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// 测试固定密钥：派生不依赖运行机器（任务单：测试里的 ZCODE_CREDENTIAL_SECRET 固定成测试值）
const SECRET = 'zcode-executor-test-credential-secret';
const KEY = deriveCredentialKey({ env: { ZCODE_CREDENTIAL_SECRET: SECRET } });

/** 用自造密钥加密成 enc:v1:<iv>.<tag>.<密文> 的形状（与 App 写盘的格式一致，三段 base64url）。 */
function encrypt(plain, key = KEY) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const b64u = (buf) => buf.toString('base64url');
  return `enc:v1:${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(data)}`;
}

const ACCOUNT_ID = '10086';
const individualKey = () => `account-key-individual-${randomBytes(4).toString('hex')}`;
const teamKey = () => `account-key-team-${randomBytes(4).toString('hex')}`;

/** enc:v2 夹具的加密端：照 App 3.18 的形状 enc:v2:<源>:<sha256(key)前24位hex>:<iv>.<tag>.<密文>。 */
function encryptV2(plain, { source, key }) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const b64u = (buf) => buf.toString('base64url');
  const fp = createHash('sha256').update(key).digest('hex').slice(0, 24);
  return `enc:v2:${source}:${fp}:${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(data)}`;
}

/** 写一份 credentials.json 夹具；entries 的值是明文，needEnc 的键会被加密。 */
async function writeCredentials(entries, { encryptKeys = Object.keys(entries) } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-cred-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'credentials.json');
  const out = {};
  for (const [k, v] of Object.entries(entries)) {
    out[k] = encryptKeys.includes(k) ? encrypt(v) : v;
  }
  await writeFile(file, JSON.stringify(out));
  return file;
}

/** 四个键齐全的标准夹具（family/accountId 可换），多余键用来验「只读四个键」。 */
function fullEntries({ family = 'bigmodel', accountId = ACCOUNT_ID } = {}) {
  const encoded = encodeURIComponent(accountId);
  return {
    'oauth:active_provider': family,
    [`oauth:${family}:user_info`]: JSON.stringify({ id: accountId, username: 'u', displayName: 'd', rawProfile: {} }),
    [`account-provider:coding-plan:account:${family}-individual-coding-plan:account:${encoded}:api-key`]: individualKey(),
    [`account-provider:coding-plan:account:${family}-team-coding-plan:account:${encoded}:api-key`]: teamKey(),
    // 别的键带坏密文也不该被碰到：实现若解了全表，这里就会炸
    [`oauth:${family}:access_token`]: 'enc:v1:garbage',
    'zcodejwttoken': 'enc:v1:garbage',
  };
}

// ---------- decryptCredentialValue ----------

test('credentials：加密→解密 roundtrip（enc:v1: 三段 base64url，AES-256-GCM）', () => {
  const plain = 'sk-account-roundtrip-1234567890';
  assert.equal(decryptCredentialValue(encrypt(plain), KEY), plain);
});

test('credentials：不带 enc:v1: 前缀的值按明文原样返回', () => {
  assert.equal(decryptCredentialValue('plain-value', KEY), 'plain-value');
  assert.equal(decryptCredentialValue('', KEY), '');
});

test('credentials：密钥不匹配 → 抛 Error，message 不含密文也不含明文', () => {
  const plain = 'sk-mismatch-secret-value';
  const sealed = encrypt(plain, deriveCredentialKey({ env: { ZCODE_CREDENTIAL_SECRET: '另一个密钥' } }));
  assert.throws(() => decryptCredentialValue(sealed, KEY), (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message.includes(sealed), false);
    assert.equal(err.message.includes(plain), false);
    return true;
  });
});

test('credentials：格式不对（段数、iv/tag 长度）→ 抛 Error，message 不含密文', () => {
  const sealed = encrypt('some-plaintext-value');
  const [, body] = sealed.split('enc:v1:');
  const [iv, tag, data] = body.split('.');
  const bad = {
    '段数不对': `enc:v1:${iv}.${tag}`,
    'iv 太短': `enc:v1:${iv.slice(0, 8)}.${tag}.${data}`,
    'tag 太短': `enc:v1:${iv}.${tag.slice(0, 12)}.${data}`,
    '不是 base64url': 'enc:v1:!!!.!!!.!!!',
  };
  for (const [name, value] of Object.entries(bad)) {
    assert.throws(() => decryptCredentialValue(value, KEY), (err) => {
      assert.ok(err instanceof Error, name);
      assert.equal(err.message.includes(value), false, name);
      return true;
    }, name);
  }
});

test('credentials：env 未 trim 的密钥也能解 enc:v1（App 3.18 的候选表第一把是 env 原样）', () => {
  // App 3.18 起对 enc:v1 按 [env 原样、env trim、平台派生] 依序试；之前只认 trim 后一把
  const untrimmedKey = createHash('sha256').update('  secret-with-spaces  ', 'utf8').digest();
  const sealed = encrypt('plain-for-untrimmed', untrimmedKey);
  assert.equal(decryptCredentialValue(sealed, deriveCredentialKey({ env: { ZCODE_CREDENTIAL_SECRET: '  secret-with-spaces  ' } })), 'plain-for-untrimmed');
});

test('credentials：其它 enc:<版本> 前缀不当明文 → 抛「不认得」（issue #6 误报的根因）', () => {
  for (const v of ['enc:v3:whatever', 'enc:garbage', 'enc:v2malformed']) {
    assert.throws(() => decryptCredentialValue(v, KEY), /不认得/);
  }
  // v2 结构对但调用方没给凭据上下文：也明确报错，不再静默当明文
  assert.throws(() => decryptCredentialValue('enc:v2:os:0123456789abcdef01234567:AAAA.BBBB.CCCC', KEY), /凭据文件上下文/);
});

// ---------- enc:v2（App 3.18 起；issue #6） ----------

test('credentials：enc:v2:os roundtrip —— os 源密钥是指纹匹配的 32 字节随机数', () => {
  const osKey = randomBytes(32);
  const plain = 'sk-os-source-value-12345';
  const sealed = encryptV2(plain, { source: 'os', key: osKey });
  const ctx = { credentialsFile: '/nonexistent/credentials.json', osSecret: osKey.toString('base64url'), env: {} };
  assert.equal(decryptCredentialValue(sealed, ctx), plain);
});

test('credentials：enc:v2:env roundtrip —— env 源密钥 = sha256(managed secret)', () => {
  const secret = 'managed-secret-for-env-source-12345678';
  const plain = 'sk-env-source-value';
  const sealed = encryptV2(plain, { source: 'env', key: createHash('sha256').update(secret, 'utf8').digest() });
  const ctx = { credentialsFile: '/nonexistent/credentials.json', env: { ZCODE_CREDENTIAL_SECRET: secret } };
  assert.equal(decryptCredentialValue(sealed, ctx), plain);
});

test('credentials：enc:v2 密钥指纹对不上 → 报解不开，不换源', () => {
  const sealed = encryptV2('x', { source: 'os', key: randomBytes(32) });
  const ctx = { credentialsFile: '/nonexistent/credentials.json', osSecret: randomBytes(32).toString('base64url'), env: {} };
  assert.throws(() => decryptCredentialValue(sealed, ctx), /指纹/);
});

test('credentials：enc:v2 结构不对 / 源不认得 → 格式错误', () => {
  const ctx = { credentialsFile: '/nonexistent/credentials.json', osSecret: randomBytes(32).toString('base64url'), env: {} };
  for (const v of [
    'enc:v2:os:nothex0123456789abcdef:AAAA.BBBB.CCCC', // 指纹非 hex
    'enc:v2:bogus:0123456789abcdef01234567:AAAA.BBBB.CCCC', // 源不认得
    'enc:v2:os:0123456789abcdef01234567', // 缺段
    'enc:v2::0123456789abcdef01234567:AAAA.BBBB.CCCC', // 空源
  ]) {
    assert.throws(() => decryptCredentialValue(v, ctx), /格式不对/);
  }
});

test('credentials：enc:v2:os 的密钥形状不对 → 存储不可用（unavailable）', () => {
  const sealed = encryptV2('x', { source: 'os', key: randomBytes(32) });
  const ctx = { credentialsFile: '/nonexistent/credentials.json', osSecret: 'too-short', env: {} };
  assert.throws(() => decryptCredentialValue(sealed, ctx), /形状不对/);
});

test('credentials：enc:v2:env 的 managed secret 找不到 → 存储不可用（unavailable）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-cred-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'credentials.json');
  const sealed = encryptV2('zai', { source: 'env', key: randomBytes(32) });
  await writeFile(file, JSON.stringify({ 'oauth:active_provider': sealed }));
  const out = readCodingPlanKeys({ credentialsPath: file, env: {} });
  assert.equal(out?.kind, 'unavailable');
  assert.match(out.error, /受管密钥/);
});

test('credentials：credential-source 钉了非 os 的值 → 整份凭据按不可用处理（照 App 口径）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-cred-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'credentials.json');
  await writeFile(file, JSON.stringify({ 'oauth:active_provider': 'zai' }));
  await writeFile(path.join(dir, 'credential-source'), 'env\n');
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out?.kind, 'unavailable');
  assert.match(out.error, /credential-source/);
});

test('credentials：enc:v2:os 整链路 —— credentials.json + 注入钥匙串密钥能读出 family', async () => {
  const osKey = randomBytes(32);
  const entries = fullEntries({ family: 'zai' });
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-cred-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'credentials.json');
  const out = {};
  for (const [k, v] of Object.entries(entries)) out[k] = encryptV2(v, { source: 'os', key: osKey });
  await writeFile(file, JSON.stringify(out));
  const res = readCodingPlanKeys({ credentialsPath: file, env: {}, osSecret: osKey.toString('base64url') });
  assert.equal(res.family, 'zai');
  assert.equal(res.accountId, ACCOUNT_ID);
  assert.ok(res.plans.individual);
});

// ---------- deriveCredentialKey / defaultCredentialsPath ----------

test('credentials：ZCODE_CREDENTIAL_SECRET 优先于平台派生（env 原样取 sha256，32 字节）', () => {
  // App 3.18 起候选表第一把是 env 原样（不 trim）：deriveCredentialKey 返回的就是它
  const key = deriveCredentialKey({ env: { ZCODE_CREDENTIAL_SECRET: `  ${SECRET}  ` } });
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.length, 32);
  assert.deepEqual(key, createHash('sha256').update(`  ${SECRET}  `, 'utf8').digest());
  // 空白串在 App 口径里也是真值：第一把候选是 sha256('   ')，平台派生仍进候选表兜底
  const blank = deriveCredentialKey({
    env: { ZCODE_CREDENTIAL_SECRET: '   ' },
    platform: 'darwin',
    homedir: '/Users/t',
    username: 't',
  });
  assert.deepEqual(blank, createHash('sha256').update('   ', 'utf8').digest());
});

test('credentials：无环境变量时按 zcode-credential-fallback:<platform>:<homedir>:<username> 派生', () => {
  const key = deriveCredentialKey({ env: {}, platform: 'linux', homedir: '/home/t', username: 't' });
  const expected = createHash('sha256').update('zcode-credential-fallback:linux:/home/t:t', 'utf8').digest();
  assert.deepEqual(key, expected);
});

test('credentials：defaultCredentialsPath 落在 ZCODE_DATA_BASE_DIR 或 home 下的 .zcode/v2', () => {
  assert.equal(
    defaultCredentialsPath({ ZCODE_DATA_BASE_DIR: '/tmp/fixture-data' }),
    path.join('/tmp/fixture-data', '.zcode', 'v2', 'credentials.json'),
  );
  const noBase = defaultCredentialsPath({ ZCODE_DATA_BASE_DIR: '' });
  assert.ok(noBase.startsWith(os.homedir()));
  assert.equal(path.relative(os.homedir(), noBase), path.join('.zcode', 'v2', 'credentials.json'));
});

// ---------- readCodingPlanKeys ----------

test('credentials：文件不存在返回 null', async () => {
  const file = path.join(os.tmpdir(), `zcode-cred-none-${Date.now()}.json`);
  assert.equal(readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } }), null);
});

test('credentials：坏 JSON 返回 {error}（中文原因），不抛', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-cred-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'credentials.json');
  await writeFile(file, '{not json');
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.ok(out && typeof out.error === 'string' && out.error.length > 0);
  assert.equal('family' in out, false);
});

test('credentials：解不开（密钥不对）返回 {error}，error 里没有密文', async () => {
  const file = await writeCredentials(fullEntries(), {
    encryptKeys: ['oauth:active_provider'], // 只加密 active_provider，用默认 KEY
  });
  // 上面加密用的就是 KEY，换一把钥匙去读：active_provider 应解不开
  const out = readCodingPlanKeys({
    credentialsPath: file,
    env: { ZCODE_CREDENTIAL_SECRET: 'wrong-secret-entirely' },
  });
  assert.ok(out?.error, '应返回 error');
  assert.match(out.error, /解不开|解密/);
});

test('credentials：缺 oauth:active_provider 返回 {error}', async () => {
  const entries = fullEntries();
  delete entries['oauth:active_provider'];
  const file = await writeCredentials(entries);
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.ok(out?.error);
  assert.match(out.error, /active_provider/);
});

test('credentials：user_info 缺 id 返回 {error}', async () => {
  const entries = fullEntries();
  entries['oauth:bigmodel:user_info'] = JSON.stringify({ username: 'no-id-here' });
  const file = await writeCredentials(entries);
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.ok(out?.error);
  assert.match(out.error, /id/);
});

test('credentials：zai user_info 是 rawProfile（id 在 user_id）→ 兜底取 user_id 拼 key（issue #6，App 3.17.2）', async () => {
  const accountId = 'zai-user-77';
  const entries = fullEntries({ family: 'zai', accountId });
  entries['oauth:zai:user_info'] = JSON.stringify({ user_id: accountId, name: 'someone', email: 'a@b.c', avatar: 'https://x/y.png' });
  const file = await writeCredentials(entries);
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.family, 'zai');
  assert.equal(out.accountId, accountId);
  assert.ok(out.plans.individual);
});

test('credentials：zai user_info 里 id 与 user_id 都缺 → 仍报没有账号 id', async () => {
  const entries = fullEntries({ family: 'zai' });
  entries['oauth:zai:user_info'] = JSON.stringify({ name: 'no-id-at-all' });
  const file = await writeCredentials(entries);
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.ok(out?.error);
  assert.match(out.error, /账号 id/);
});

test('credentials：bigmodel user_info 缺 id 时不看 user_id（兜底只给 zai）', async () => {
  const entries = fullEntries();
  entries['oauth:bigmodel:user_info'] = JSON.stringify({ user_id: 'should-not-count' });
  const file = await writeCredentials(entries);
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.ok(out?.error);
  assert.match(out.error, /账号 id/);
});

test('credentials：四个键齐全 → family/accountId/plans 两把 key 都在，别的键不碰', async () => {
  const entries = fullEntries();
  const file = await writeCredentials(entries);
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.deepEqual(Object.keys(out).sort(), ['accountId', 'family', 'plans']);
  assert.equal(out.family, 'bigmodel');
  assert.equal(out.accountId, ACCOUNT_ID);
  assert.equal(out.plans.individual, entries['account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:10086:api-key']);
  assert.equal(out.plans.team, entries['account-provider:coding-plan:account:bigmodel-team-coding-plan:account:10086:api-key']);
});

test('credentials：只有个人版 key → team 缺省（plans 里没有 team）', async () => {
  const entries = fullEntries();
  delete entries['account-provider:coding-plan:account:bigmodel-team-coding-plan:account:10086:api-key'];
  const file = await writeCredentials(entries);
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.family, 'bigmodel');
  assert.equal('team' in out.plans, false);
  assert.ok(out.plans.individual);
});

test('credentials：两把 key 都没有 → plans 是空对象但 family/accountId 还在', async () => {
  const entries = {
    'oauth:active_provider': 'zai',
    'oauth:zai:user_info': JSON.stringify({ id: '42' }),
  };
  const file = await writeCredentials(entries);
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.deepEqual(out, { family: 'zai', accountId: '42', plans: {} });
});

test('credentials：无前缀的明文值也认（App 未来某天写明文）', async () => {
  const entries = fullEntries({ family: 'bigmodel' });
  // 全部按明文写
  const file = await writeCredentials(entries, { encryptKeys: [] });
  const out = readCodingPlanKeys({ credentialsPath: file, env: {} });
  assert.equal(out.family, 'bigmodel');
  assert.ok(out.plans.individual);
  assert.ok(out.plans.team);
});

// ---------- T6-C-fix 第 4、5 条 ----------

test('credentials：active_provider 解出别的值 → error 不带解出来的值（T6-C-fix 第 4 条）', async () => {
  const odd = 'weird-family-not-zai-nor-bigmodel';
  const file = await writeCredentials({ 'oauth:active_provider': odd });
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.ok(out?.error);
  assert.match(out.error, /不是 zai 或 bigmodel/);
  assert.equal(out.error.includes(odd), false); // 解出来的值一律不进面向人的文案
});

test('credentials：api-key 解出来不是字符串（如明文数字）→ 当那一档没有 key（T6-C-fix 第 5 条）', async () => {
  const entries = fullEntries();
  // 个人版存成了明文数字：照旧解密（无前缀原样返回），但非字符串当没有——
  // 否则它进 secrets 抹除名单会让按值替换静默失效
  const numericKey = 'account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:10086:api-key';
  entries[numericKey] = 42;
  const file = await writeCredentials(entries, { encryptKeys: Object.keys(entries).filter((k) => k !== numericKey) });
  const out = readCodingPlanKeys({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.error, undefined);
  assert.equal(out.family, 'bigmodel');
  assert.equal('individual' in out.plans, false);
  assert.ok(out.plans.team); // 字符串那把照常
});

// ---------- readOffPeakAuth（闲时投递，decisions D20：只多解 zcodejwttoken） ----------

const TEST_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjoxfQ.test-jwt-signature';

/** 闲时夹具：四个键加一把 JWT；个人版 / 团队版 key 可去掉。 */
function offPeakEntries({ family = 'bigmodel', individual = true, team = true } = {}) {
  const entries = fullEntries({ family });
  entries.zcodejwttoken = TEST_JWT;
  if (!individual) delete entries[`account-provider:coding-plan:account:${family}-individual-coding-plan:account:10086:api-key`];
  if (!team) delete entries[`account-provider:coding-plan:account:${family}-team-coding-plan:account:10086:api-key`];
  return entries;
}

test('闲时凭据：JWT 与个人版 key 都在 → 返回 family、jwt、planKey（个人版）', async () => {
  const entries = offPeakEntries({ family: 'zai' });
  const file = await writeCredentials(entries);
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.deepEqual(out, {
    family: 'zai',
    jwt: TEST_JWT,
    planKey: entries['account-provider:coding-plan:account:zai-individual-coding-plan:account:10086:api-key'],
  });
});

test('闲时凭据：别的键是解不开的坏值也不影响——只比 D19 多读 zcodejwttoken 一个键', async () => {
  const entries = offPeakEntries();
  entries['oauth:bigmodel:access_token'] = 'enc:v1:garbage'; // 不加密写进去，谁去解谁就炸
  const file = await writeCredentials(entries, {
    encryptKeys: Object.keys(entries).filter((k) => k !== 'oauth:bigmodel:access_token'),
  });
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.error, undefined);
  assert.equal(out.jwt, TEST_JWT);
});

test('闲时凭据：凭据文件不存在 → not-applicable，说没用账号登录', () => {
  const file = path.join(os.tmpdir(), `zcode-cred-none-${Date.now()}.json`);
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'not-applicable');
  assert.match(out.error, /登录/);
});

test('闲时凭据：没有 zcodejwttoken → not-applicable，说没用账号登录', async () => {
  const entries = offPeakEntries();
  delete entries.zcodejwttoken;
  const file = await writeCredentials(entries);
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'not-applicable');
  assert.match(out.error, /登录/);
});

test('闲时凭据：没有账号信息（active_provider）→ not-applicable', async () => {
  const entries = offPeakEntries();
  delete entries['oauth:active_provider'];
  const file = await writeCredentials(entries);
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'not-applicable');
  assert.match(out.error, /登录/);
});

test('闲时凭据：只有团队版 key → not-applicable「团队版暂不支持闲时投递」', async () => {
  const file = await writeCredentials(offPeakEntries({ individual: false }));
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'not-applicable');
  assert.match(out.error, /团队版暂不支持闲时投递/);
});

test('闲时凭据：两把 key 都没有 → not-applicable', async () => {
  const file = await writeCredentials(offPeakEntries({ individual: false, team: false }));
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'not-applicable');
  assert.ok(out.error);
});

test('闲时凭据：JWT 解不开 → changed，error 里没有密文', async () => {
  const entries = offPeakEntries();
  const sealed = encrypt(TEST_JWT, deriveCredentialKey({ env: { ZCODE_CREDENTIAL_SECRET: '另一个密钥' } }));
  entries.zcodejwttoken = sealed;
  const file = await writeCredentials(entries, { encryptKeys: Object.keys(entries).filter((k) => k !== 'zcodejwttoken') });
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'changed');
  assert.match(out.error, /zcodejwttoken/);
  assert.equal(out.error.includes(sealed), false);
});

test('闲时凭据：凭据文件不是合法 JSON → changed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-cred-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'credentials.json');
  await writeFile(file, '{not json');
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'changed');
});

test('闲时凭据：user_info 解出来不是 JSON → changed', async () => {
  const entries = offPeakEntries();
  entries['oauth:bigmodel:user_info'] = 'not-json';
  const file = await writeCredentials(entries);
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'changed');
});

test('闲时凭据：失败时返回值里查不到 JWT 与 key', async () => {
  const entries = offPeakEntries({ individual: false });
  const file = await writeCredentials(entries);
  const out = readOffPeakAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  const teamValue = entries['account-provider:coding-plan:account:bigmodel-team-coding-plan:account:10086:api-key'];
  assert.ok(out.error);
  assert.equal(JSON.stringify(out).includes(TEST_JWT), false);
  assert.equal(JSON.stringify(out).includes(teamValue), false);
});

// ---------- readStartPlanAuth（start plan 投递，decisions D21：只要 active_provider 与 JWT） ----------

test('start plan 凭据：active_provider 与 JWT 都在 → 返回 family、jwt；user_info 与 coding plan key 缺席也能读', async () => {
  const file = await writeCredentials({ 'oauth:active_provider': 'bigmodel', zcodejwttoken: TEST_JWT });
  const out = readStartPlanAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.deepEqual(out, { family: 'bigmodel', jwt: TEST_JWT });
});

test('start plan 凭据：zai 族照常读', async () => {
  const file = await writeCredentials({ 'oauth:active_provider': 'zai', zcodejwttoken: TEST_JWT });
  const out = readStartPlanAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.deepEqual(out, { family: 'zai', jwt: TEST_JWT });
});

test('start plan 凭据：凭据文件不存在 → not-applicable，说没用账号登录', () => {
  const file = path.join(os.tmpdir(), `zcode-cred-none-${Date.now()}.json`);
  const out = readStartPlanAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'not-applicable');
  assert.match(out.error, /登录/);
});

test('start plan 凭据：没有 active_provider → not-applicable', async () => {
  const file = await writeCredentials({ zcodejwttoken: TEST_JWT });
  const out = readStartPlanAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'not-applicable');
  assert.match(out.error, /oauth:active_provider/);
});

test('start plan 凭据：active_provider 不是 zai 或 bigmodel → changed，error 不回显值', async () => {
  const file = await writeCredentials({ 'oauth:active_provider': 'other-family', zcodejwttoken: TEST_JWT });
  const out = readStartPlanAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'changed');
  assert.equal(JSON.stringify(out).includes('other-family'), false);
});

test('start plan 凭据：没有 zcodejwttoken → not-applicable', async () => {
  const file = await writeCredentials({ 'oauth:active_provider': 'bigmodel' });
  const out = readStartPlanAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'not-applicable');
  assert.match(out.error, /zcodejwttoken/);
});

test('start plan 凭据：JWT 解不开 → changed，error 里没有密文', async () => {
  const sealed = encrypt(TEST_JWT, deriveCredentialKey({ env: { ZCODE_CREDENTIAL_SECRET: '另一个密钥' } }));
  const file = await writeCredentials(
    { 'oauth:active_provider': 'bigmodel', zcodejwttoken: sealed },
    { encryptKeys: ['oauth:active_provider'] }, // zcodejwttoken 原样写入，别再包一层加密
  );
  const out = readStartPlanAuth({ credentialsPath: file, env: { ZCODE_CREDENTIAL_SECRET: SECRET } });
  assert.equal(out.kind, 'changed');
  assert.equal(JSON.stringify(out).includes(sealed), false);
});
