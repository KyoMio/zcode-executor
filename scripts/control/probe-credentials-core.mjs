// scripts/control/probe-credentials-core.mjs —— 凭据键只读探针核心（ZCE-4）。
// 复用 lib/credentials.mjs（支持 enc:v2:os / enc:v2:env / enc:v1 / zai user_id），
// 仅做只读 readFileSync 列键与加密形态分类（enc:v2 / enc:v1 / plaintext），
// 永不打印或返回任何明文凭据值或解密后的 API key。
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { defaultCredentialsPath, readCodingPlanKeys } from '../../lib/credentials.mjs';

function classifyEncryptionTag(value) {
  if (typeof value !== 'string') return 'non-string';
  if (value.startsWith('enc:v2:')) return 'enc:v2';
  if (value.startsWith('enc:v1:')) return 'enc:v1';
  if (value.startsWith('enc:')) return 'enc:unknown';
  return 'plaintext';
}

/**
 * 只读探测 credentials.json 与 coding-plan 4 键可读性。
 * 返回：{ path, keys, family, plans, checks, ok, error?, kind? }，绝不含任何密钥明文。
 */
export function probeCredentials({ credentialsPath, env = process.env, osSecret, key, platform } = {}) {
  const credPath = credentialsPath ?? defaultCredentialsPath(env);
  let raw;
  try {
    raw = readFileSync(credPath, 'utf8');
  } catch (err) {
    const missing = err?.code === 'ENOENT';
    return {
      path: credPath,
      keys: [],
      family: null,
      plans: [],
      checks: [],
      ok: false,
      error: missing ? `credentials.json 不存在：${credPath}` : `读不到凭据文件：${err.message}`,
      kind: missing ? 'not-applicable' : 'unavailable',
    };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return {
      path: credPath,
      keys: [],
      family: null,
      plans: [],
      checks: [],
      ok: false,
      error: `credentials.json 不是合法 JSON：${credPath}`,
      kind: 'changed',
    };
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return {
      path: credPath,
      keys: [],
      family: null,
      plans: [],
      checks: [],
      ok: false,
      error: 'credentials.json 的形状不对：应是 { "<键>": "<值>" } 的平面对象',
      kind: 'changed',
    };
  }

  const keys = Object.keys(data).map((k) => {
    const tag = classifyEncryptionTag(data[k]);
    return { key: k, tag, encrypted: tag.startsWith('enc:') };
  });

  const res = readCodingPlanKeys({ credentialsPath: credPath, env, osSecret, key, platform });
  if (res === null) {
    return {
      path: credPath,
      keys,
      family: null,
      plans: [],
      checks: [],
      ok: false,
      error: `credentials.json 不存在：${credPath}`,
      kind: 'not-applicable',
    };
  }
  if (res.error) {
    return {
      path: credPath,
      keys,
      family: null,
      plans: [],
      checks: [],
      ok: false,
      error: res.error,
      kind: res.kind ?? 'changed',
    };
  }

  // plans 只保留档名（'individual' / 'team'），绝不放 key 值或长度以外的敏感内容
  const plans = Object.keys(res.plans ?? {});
  const checks = [
    { label: 'active_provider', key: 'oauth:active_provider', present: true, ok: true, value: res.family },
    { label: 'user_info', key: `oauth:${res.family}:user_info`, present: true, ok: true, hasId: true },
    ...(['individual', 'team'].map((plan) => {
      const k = `account-provider:coding-plan:account:${res.family}-${plan}-coding-plan:account:${encodeURIComponent(res.accountId)}:api-key`;
      const present = Object.prototype.hasOwnProperty.call(res.plans ?? {}, plan);
      return { label: `${plan}-coding-plan api-key`, key: k, present, ok: present };
    })),
  ];

  const ok = plans.length > 0;
  return {
    path: credPath,
    keys,
    family: res.family,
    plans,
    checks,
    ok,
    ...(ok ? {} : { error: 'credentials.json 里未找到可用的 coding-plan api-key', kind: 'not-applicable' }),
  };
}

export function formatProbeCredentialsHuman(result) {
  const lines = [`凭据文件：${result.path}`];
  if (result.keys.length > 0) {
    lines.push(`键名（${result.keys.length} 个，只列名字与加密标记）：`);
    for (const k of result.keys) {
      lines.push(`  ${k.key}  [${k.tag}]`);
    }
  }
  if (result.family) lines.push(`active_provider：${result.family}`);
  if (result.plans.length > 0) lines.push(`coding-plan 档位：${result.plans.join('、')}`);
  lines.push(result.ok ? '结论：本机凭据可解，账号型 coding-plan 可用。' : `结论：${result.error ?? '凭据不可用'}`);
  return lines.join('\n');
}
