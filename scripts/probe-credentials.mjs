// 本文件负责：线 C（docs/PLAN-v4.md T6.8）的零 token 真机探针——本机的密钥派生能不能解开
// ~/.zcode/v2/credentials.json 里我们要用的四个键。只打印键名、解密成功与否、明文长度；
// 永不打印任何值（RULES §8）。只读，不写任何文件，不联网。
// 用法：node scripts/probe-credentials.mjs [--json]
// 解密算法与 ZCode 开源源码（apps/zcode-cli/packages/adapters/src/auth/credential-cipher.ts，
// 2026-09-21 核实）逐行等价：AES-256-GCM，值形如 enc:v1:<iv>.<tag>.<密文>（base64url），
// 密钥 sha256(ZCODE_CREDENTIAL_SECRET 或 "zcode-credential-fallback:<platform>:<homedir>:<username>")。
import { readFileSync } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PREFIX = 'enc:v1:';
const json = process.argv.includes('--json');

function credentialsPath(env = process.env) {
  const base = env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir();
  return path.join(base, '.zcode', 'v2', 'credentials.json');
}

function deriveKey(env = process.env) {
  const configured = env.ZCODE_CREDENTIAL_SECRET?.trim();
  let username = 'unknown';
  try {
    username = os.userInfo().username;
  } catch {
    // 沙箱里可能拿不到用户名，与 CLI 的兜底一致
  }
  const secret = configured || `zcode-credential-fallback:${os.platform()}:${os.homedir()}:${username}`;
  return { key: createHash('sha256').update(secret).digest(), source: configured ? 'ZCODE_CREDENTIAL_SECRET' : 'fallback(platform:homedir:username)' };
}

function decrypt(value, key) {
  if (!value.startsWith(PREFIX)) return value;
  const parts = value.slice(PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('密文格式不对（不是三段）');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== 12) throw new Error(`iv 长度不对：${iv.length}`);
  if (tag.length !== 16) throw new Error(`authTag 长度不对：${tag.length}`);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

const out = { path: credentialsPath(), keySource: null, keys: [], checks: [] };
const say = (line) => {
  if (!json) console.log(line);
};

let data;
try {
  data = JSON.parse(readFileSync(out.path, 'utf8'));
} catch (err) {
  out.error = `读不到凭据文件：${err.message}`;
  say(`probe-credentials: ${out.error}`);
  if (json) console.log(JSON.stringify(out));
  process.exit(1);
}
const { key, source } = deriveKey();
out.keySource = source;
say(`凭据文件：${out.path}`);
say(`密钥来源：${source}`);
say(`键名（${Object.keys(data).length} 个，只列名字）：`);
for (const k of Object.keys(data)) {
  const enc = String(data[k]).startsWith(PREFIX);
  out.keys.push({ key: k, encrypted: enc });
  say(`  ${k}  ${enc ? '[enc:v1]' : '[明文]'}`);
}

// 只解这四类键；打印「成功/失败 + 明文长度」，永不打印明文
const check = (label, k, describe) => {
  if (!(k in data)) {
    out.checks.push({ label, key: k, present: false });
    say(`${label}：缺键 ${k}`);
    return null;
  }
  try {
    const plain = decrypt(String(data[k]), key);
    const extra = describe ? describe(plain) : {};
    out.checks.push({ label, key: k, present: true, ok: true, length: plain.length, ...extra });
    say(`${label}：解密成功，长度 ${plain.length}${extra.note ? `，${extra.note}` : ''}`);
    return plain;
  } catch (err) {
    out.checks.push({ label, key: k, present: true, ok: false, error: err.message });
    say(`${label}：解密失败（${err.message}）`);
    return null;
  }
};

const family = check('active_provider', 'oauth:active_provider', (v) => ({ note: `值=${v === 'zai' || v === 'bigmodel' ? v : '（不是 zai/bigmodel）'}`, value: v === 'zai' || v === 'bigmodel' ? v : null }));
if (family === 'zai' || family === 'bigmodel') {
  const info = check('user_info', `oauth:${family}:user_info`, (v) => {
    try {
      const o = JSON.parse(v);
      return { note: `字段 ${Object.keys(o).join(',')}，id ${o.id !== undefined ? '在' : '缺'}`, hasId: o.id !== undefined };
    } catch {
      return { note: '不是 JSON', hasId: false };
    }
  });
  let id = null;
  try {
    id = info ? JSON.parse(info).id : null;
  } catch {
    // 上面已报
  }
  if (id !== null && id !== undefined) {
    const enc = encodeURIComponent(String(id));
    for (const plan of ['individual', 'team']) {
      check(`${plan}-coding-plan api-key`, `account-provider:coding-plan:account:${family}-${plan}-coding-plan:account:${enc}:api-key`, (v) => ({ note: `含点号 ${v.includes('.') ? '是' : '否'}` }));
    }
  }
}
out.ok = out.checks.filter((c) => c.present).every((c) => c.ok) && out.checks.some((c) => c.label.endsWith('api-key') && c.ok);
say(out.ok ? '结论：本机密钥派生能解开，线 C 可以接。' : '结论：有键解不开或没有 coding-plan key，见上面各行。');
if (json) console.log(JSON.stringify(out));
process.exitCode = out.ok ? 0 : 1;
