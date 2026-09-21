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

// ---------- deriveCredentialKey / defaultCredentialsPath ----------

test('credentials：ZCODE_CREDENTIAL_SECRET 优先于平台派生（trim 后取 sha256，32 字节）', () => {
  const key = deriveCredentialKey({ env: { ZCODE_CREDENTIAL_SECRET: `  ${SECRET}  ` } });
  assert.ok(Buffer.isBuffer(key));
  assert.equal(key.length, 32);
  assert.deepEqual(key, createHash('sha256').update(SECRET, 'utf8').digest());
  // 空白串视为没设，回落到平台派生
  const fallback = deriveCredentialKey({
    env: { ZCODE_CREDENTIAL_SECRET: '   ' },
    platform: 'darwin',
    homedir: '/Users/t',
    username: 't',
  });
  assert.deepEqual(fallback, createHash('sha256').update('zcode-credential-fallback:darwin:/Users/t:t', 'utf8').digest());
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
