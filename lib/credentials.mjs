// 本文件负责：读 ~/.zcode/v2/credentials.json 里账号型 coding plan 的平台 API key（T6-C，decisions D19）——
// 凭据值的解密（decryptCredentialValue）、解密密钥的派生（deriveCredentialKey）、默认路径
// （defaultCredentialsPath）和「只读四个键」的读取规则（readCodingPlanKeys）。
// 不负责：provider 表的构造与合并（lib/providers.mjs 调这里）、个人 provider 文件的写入、任何写盘——
// credentials.json 只读不写。
// 只依赖 node 内置模块。
//
// 2026-09-21 对照 ZCode 源码（3.14.0，用户本机 3.12.2 核对过文件格式）：
// - credentials.json 是平面 JSON { "<键>": "<值>" }，值形如 enc:v1:<iv>.<tag>.<密文>（三段 base64url），
//   AES-256-GCM，iv 12 字节、authTag 16 字节；密钥 = sha256(secret)；
//   secret = ZCODE_CREDENTIAL_SECRET（trim 后非空才算）或 zcode-credential-fallback:<platform>:<homedir>:<username>。
//   不带 enc:v1: 前缀的值按明文原样用（真机探针见 verified.md「凭据文件探针」2026-09-21）。
// - 只读这四个键（其它键是 App 的私有实现，一律不读不解）：
//   oauth:active_provider（解出 "zai" 或 "bigmodel"）、oauth:<family>:user_info（JSON，取 id）、
//   个人版与团队版两把 account-provider:coding-plan:account:<family>-<plan>-coding-plan:account:<encodeURIComponent(id)>:api-key。
//
// 安全边界（RULES §6、§8）：解出的 key 与 config.json 的 apiKey 同一待遇——只进临时个人 provider 文件
// （D14）与 secrets 抹除名单，不进日志、事件、异常 message 和任何面向人的输出；error 文案只说哪个键
// 出了什么问题，不带密文也不带解出来的值。
import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENC_PREFIX = 'enc:v1:';

/** 只解这四个键；键名是 App 的私有实现，改了就读不到，读不到就明确报错（D19）。 */
const ACTIVE_PROVIDER_KEY = 'oauth:active_provider';
const userInfoKey = (family) => `oauth:${family}:user_info`;
const planApiKey = (family, plan, accountId) =>
  `account-provider:coding-plan:account:${family}-${plan}-coding-plan:account:${encodeURIComponent(accountId)}:api-key`;

/**
 * 派生解密密钥：sha256(secret)，32 字节。secret 优先取 env.ZCODE_CREDENTIAL_SECRET（trim 后非空），
 * 否则用平台派生串。platform/homedir/username 可注入（测试不依赖运行机器）。
 */
export function deriveCredentialKey({
  env = process.env,
  platform = os.platform(),
  homedir = os.homedir(),
  username = os.userInfo().username,
} = {}) {
  const secret = env.ZCODE_CREDENTIAL_SECRET?.trim() || `zcode-credential-fallback:${platform}:${homedir}:${username}`;
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * 解一个凭据值。不带 enc:v1: 前缀的按明文原样返回；格式不对或 GCM 校验失败抛 Error
 * （message 只说出了什么问题，不含密文与明文）。
 */
export function decryptCredentialValue(value, key) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  const parts = value.slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 3) {
    throw new Error('加密凭据格式不对：应为 enc:v1:<iv>.<tag>.<密文> 三段');
  }
  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  const data = Buffer.from(parts[2], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('加密凭据格式不对：iv 应 12 字节、authTag 应 16 字节');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // GCM 校验失败：密钥不匹配或密文被改动，细节（密文）不进 message
    throw new Error('凭据解不开（GCM 校验失败）：解密密钥不匹配或数据被改动');
  }
}

/** 凭据文件默认路径：<ZCODE_DATA_BASE_DIR 或 home>/.zcode/v2/credentials.json。 */
export function defaultCredentialsPath(env = process.env) {
  return path.join(env.ZCODE_DATA_BASE_DIR || os.homedir(), '.zcode', 'v2', 'credentials.json');
}

/**
 * 读账号型 coding plan 的四个键。返回三态：
 * - 文件不存在 → null（没在 App 里登录过，正常状态）；
 * - 出问题 → { error: '<中文原因>' }（不抛，让调用方记 warning / doctor 报「不可用」）；
 * - 成功 → { family, accountId, plans: { individual?: string, team?: string } }，
 *   两把 key 都没有时 plans 是空对象；key 的值只出现在 plans 里。
 * credentialsPath / env / key 都可注入（测试用），env 缺省 process.env，key 缺省按 env 派生。
 */
export function readCodingPlanKeys({ credentialsPath, env = process.env, key } = {}) {
  const file = credentialsPath ?? defaultCredentialsPath(env);
  const credentialKey = key ?? deriveCredentialKey({ env });
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return { error: `credentials.json 读不了：${err.message}` };
  }
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    return { error: `credentials.json 不是合法 JSON：${file}。文件可能被 ZCode App 正在重写，稍后重试` };
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return { error: 'credentials.json 的形状不对：应是 { "<键>": "<值>" } 的平面对象' };
  }
  const read = (k) => {
    if (!(k in values)) return undefined; // 键不存在不算错（那一档 key 就是没有）
    let v;
    try {
      v = decryptCredentialValue(values[k], credentialKey);
    } catch (err) {
      // 补上键名再抛：哪个键解不开说清楚，键名不是秘密，密文留在原地不进 message
      throw new Error(`键 ${k}：${err instanceof Error ? err.message : String(err)}`);
    }
    // 解出来不是字符串当没有（T6-C-fix 第 5 条）：非字符串的 key 进 secrets 抹除名单会让
    // scrubValues 的按值替换静默失效，从源头就不收
    return typeof v === 'string' ? v : undefined;
  };
  try {
    const active = read(ACTIVE_PROVIDER_KEY);
    if (active === undefined) {
      return { error: `credentials.json 里没有 ${ACTIVE_PROVIDER_KEY}：还没在 ZCode App 里用账号登录` };
    }
    if (active !== 'zai' && active !== 'bigmodel') {
      // 解出来的值一律不进面向人的文案（T6-C-fix 第 4 条）
      return { error: 'oauth:active_provider 不是 zai 或 bigmodel，账号型 coding plan 没法接' };
    }
    const family = active;
    const userInfoRaw = read(userInfoKey(family));
    if (userInfoRaw === undefined) {
      return { error: `credentials.json 里没有 oauth:${family}:user_info，账号信息不完整。重登一次 ZCode App 试试` };
    }
    let userInfo;
    try {
      userInfo = JSON.parse(userInfoRaw);
    } catch {
      return { error: `oauth:${family}:user_info 解出来不是合法 JSON` };
    }
    const accountId = userInfo?.id;
    if (accountId === undefined || accountId === null || accountId === '') {
      return { error: `oauth:${family}:user_info 里没有账号 id，账号型 coding plan 的 key 键名拼不出来` };
    }
    const plans = {};
    for (const plan of ['individual', 'team']) {
      const v = read(planApiKey(family, plan, String(accountId)));
      if (v) plans[plan] = v;
    }
    return { family, accountId: String(accountId), plans };
  } catch (err) {
    // 只可能是 decryptCredentialValue 抛的：哪个键解不开说清楚，不带密文
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
