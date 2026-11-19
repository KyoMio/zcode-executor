// 本文件负责：读 ~/.zcode/v2/credentials.json 里账号型 coding plan 的平台 API key（T6-C，decisions D19）
// 与闲时投递要的 JWT（decisions D20）——凭据值的解密（decryptCredentialValue）、解密密钥的派生
// （deriveCredentialKey）、默认路径（defaultCredentialsPath）、「只读四个键」的读取规则（readCodingPlanKeys）
// 和闲时鉴权（readOffPeakAuth：四个键之外只多解 zcodejwttoken）、start plan 鉴权（readStartPlanAuth，
// decisions D21：只要 active_provider 与 zcodejwttoken）。
// 不负责：provider 表的构造与合并（lib/providers.mjs 调这里）、闲时服务器请求（lib/offpeak.mjs）、
// 个人 provider 文件的写入、任何写盘——credentials.json 只读不写，钥匙串与 credential-secret 文件也只读。
// 只依赖 node 内置模块（os 源在 macOS 上另走系统的 security 命令读钥匙串，不是依赖包）。
//
// 2026-09-21 对照 ZCode 源码（3.14.0，用户本机 3.12.2 核对过文件格式）：
// - credentials.json 是平面 JSON { "<键>": "<值>" }，值形如 enc:v1:<iv>.<tag>.<密文>（三段 base64url），
//   AES-256-GCM，iv 12 字节、authTag 16 字节；密钥 = sha256(secret)；
//   secret = ZCODE_CREDENTIAL_SECRET（trim 后非空才算）或 zcode-credential-fallback:<platform>:<homedir>:<username>。
//   不带 enc: 前缀的值按明文原样用（真机探针见 verified.md「凭据文件探针」2026-09-21）。
// - 读取范围是 D19 的四个键加 D20 的一个键（其它键是 App 的私有实现，一律不读不解）：
//   oauth:active_provider（解出 "zai" 或 "bigmodel"）、oauth:<family>:user_info（JSON，取 id；
//   zai 族 App 3.17.2 起存 rawProfile，id 在 user_id 字段，见下方兜底）、
//   个人版与团队版两把 account-provider:coding-plan:account:<family>-<plan>-coding-plan:account:<encodeURIComponent(id)>:api-key；
//   闲时投递另解 zcodejwttoken（同一套 AES-GCM，verified.md「闲时任务探针」2026-09-27）。
//
// 2026-11-19 对照 3.18.2 的 app.asar（issue #6，App 3.18 起凭据加密改版）：
// - 新格式 enc:v2:<源>:<密钥指纹>:<iv>.<tag>.<密文>：AES-256-GCM 与三段 base64url 不变，
//   指纹 = sha256(密钥) hex 的前 24 个字符，源是 os 或 env。
// - os 源：密钥是 32 字节随机数以 base64url 存系统钥匙串（service "ZCode Credential Encryption"，
//   account = sha256(凭据文件 resolve 后绝对路径) hex）。macOS 上靠 security 命令读；
//   Windows/Linux 上 App 走 @napi-rs/keyring（DPAPI / Secret Service），本插件没有等价物，报「不支持」。
// - env 源：密钥 = sha256(managed secret)，managed secret 取 ZCODE_CREDENTIAL_SECRET（trim 后非空），
//   或 ZCODE_CREDENTIAL_SECRET_FILE 指到的文件，或凭据文件旁边的 credential-secret（32–4096 字节）。
// - v1 兜底微调：App 现在对 enc:v1 按 [env 原样、env trim、平台派生] 三把候选密钥依序试解，照抄。
// - credential-source 钉源文件：内容为 "os\n" 才算钉到 os；钉了别的值时 App 连解密都拒绝，照抄（os 源）。
// - 其它 enc:<未知版本> 前缀不再按明文放行，直接报「格式不认得」——v0.6.2 之前会把 enc:v2 的密文
//   当明文比较，误报成「oauth:active_provider 不是 zai 或 bigmodel」（issue #6 的误报就是这么来的）。
//
// 安全边界（RULES §6、§8）：解出的 key 与 config.json 的 apiKey 同一待遇——只进临时个人 provider 文件
// （D14）与 secrets 抹除名单，不进日志、事件、异常 message 和任何面向人的输出；JWT 只进内存、secrets 抹除名单
// 与 JSON-RPC / HTTP 请求（D20）。error 文案只说哪个键出了什么问题，不带密文也不带解出来的值；
// managed secret 与钥匙串读到的密钥同样不进任何文案。
import { createDecipheriv, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENC_V1_PREFIX = 'enc:v1:';
const ENC_V2_PREFIX = 'enc:v2:';
const ENC_PREFIX = 'enc:';

/** 只解这四个键；键名是 App 的私有实现，改了就读不到，读不到就明确报错（D19）。 */
const ACTIVE_PROVIDER_KEY = 'oauth:active_provider';
const userInfoKey = (family) => `oauth:${family}:user_info`;
const planApiKey = (family, plan, accountId) =>
  `account-provider:coding-plan:account:${family}-${plan}-coding-plan:account:${encodeURIComponent(accountId)}:api-key`;
/** D20 放开的唯一一个额外键：闲时服务器只认这个 JWT。 */
const JWT_KEY = 'zcodejwttoken';

/** App 3.18 起 enc:v2 os 源的钥匙串条目（service / account 计算方式照抄 createSystemCredentialCipher）。 */
const OS_KEYCHAIN_SERVICE = 'ZCode Credential Encryption';
/** credential-source 钉到 os 的合法内容（含换行）；钉了别的值时 App 拒解，照抄。 */
const CREDENTIAL_SOURCE_OS = 'os\n';
/** managed secret 的合法长度（App resolveManagedSecret 的上下界）。 */
const MANAGED_SECRET_MIN = 32;
const MANAGED_SECRET_MAX = 4096;
/** 读钥匙串的最长等待：security 弹系统授权框时人会去点，超时就当读不到。 */
const KEYCHAIN_TIMEOUT_MS = 120_000;

/** 系统凭据存储不可用（钥匙串读不到、managed secret 文件不合规等）→ kind 归 unavailable。 */
function unavailableError(message) {
  const err = new Error(message);
  err.code = 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE';
  return err;
}

/**
 * 派生 enc:v1 的解密密钥候选表：sha256(secret)，每把 32 字节。
 * App 3.18 起按 [env 原样、env trim、平台派生] 依序试，照抄——旧实现只认 trim 后一把，
 * 个别环境（env 值带空格、App 用未 trim 串写入）会解不开。
 * platform/homedir/username 可注入（测试不依赖运行机器）。返回值只含第一把（候选[0]），
 * 保持旧调用方的单密钥语义；要候选表用 deriveCredentialKeyCandidates。
 */
export function deriveCredentialKey({
  env = process.env,
  platform = os.platform(),
  homedir = os.homedir(),
  username = os.userInfo().username,
} = {}) {
  return deriveCredentialKeyCandidates({ env, platform, homedir, username })[0];
}

/** enc:v1 的候选密钥表：[sha256(env 原样), sha256(env trim), sha256(平台派生)] 去重后。 */
function deriveCredentialKeyCandidates({
  env = process.env,
  platform = os.platform(),
  homedir = os.homedir(),
  username = os.userInfo().username,
} = {}) {
  const fallback = `zcode-credential-fallback:${platform}:${homedir}:${username}`;
  const raw = env.ZCODE_CREDENTIAL_SECRET;
  const secrets = [raw || fallback, raw?.trim() || fallback, fallback];
  return [...new Set(secrets)].map((s) => createHash('sha256').update(s, 'utf8').digest());
}

/** sha256(密钥) hex 的前 24 字符，就是 enc:v2 里写的密钥指纹。 */
function keyFingerprint(key) {
  return createHash('sha256').update(key).digest('hex').slice(0, 24);
}

/** AES-256-GCM 解三段 base64url 的载荷（v1 去掉前缀后、v2 的第三段共用）。失败归两类：格式 / 解不开。 */
function gcmOpen(payload, key) {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) {
    throw new Error('加密凭据格式不对：应为 <iv>.<tag>.<密文> 三段 base64url');
  }
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64url'));
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

/** 与 credentials.json 同目录的 credential-source 钉源文件；不存在 → null；读失败抛 unavailable。 */
function readCredentialSourcePin(credentialsFile) {
  try {
    return readFileSync(path.join(path.dirname(credentialsFile), 'credential-source'), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw unavailableError(`credential-source 读不了（${err.code || err.message}）`);
  }
}

/**
 * enc:v2 env 源的 managed secret（App resolveManagedSecret）：
 * ZCODE_CREDENTIAL_SECRET（trim 后非空）> ZCODE_CREDENTIAL_SECRET_FILE 指向的文件 >
 * 凭据文件旁边的 credential-secret。两个来源同设、文件不合规（不是普通文件、
 * 非 Windows 上组/他人有权限、内容不在 32–4096 字节）都归「存储不可用」。没有 → null。
 */
function resolveManagedSecret({ env, credentialsFile, platform = os.platform() }) {
  // App resolveManagedSecret 用原始值判存在（不 trim）：空白串也算设了，直接拿去派密钥
  if (env.ZCODE_CREDENTIAL_SECRET && env.ZCODE_CREDENTIAL_SECRET_FILE) {
    throw unavailableError('ZCODE_CREDENTIAL_SECRET 与 ZCODE_CREDENTIAL_SECRET_FILE 同设了：App 不允许两个受管密钥来源并存，去掉一个');
  }
  if (env.ZCODE_CREDENTIAL_SECRET) return env.ZCODE_CREDENTIAL_SECRET;
  const fileEnv = env.ZCODE_CREDENTIAL_SECRET_FILE?.trim();
  const file = fileEnv || path.join(path.dirname(credentialsFile), 'credential-secret');
  let st;
  try {
    st = statSync(file);
  } catch (err) {
    if (err?.code === 'ENOENT' && !fileEnv) return null;
    throw unavailableError(`受管密钥文件读不了：${fileEnv || 'credential-secret'}（${err.code || err.message}）`);
  }
  if (!st.isFile() || (platform !== 'win32' && (st.mode & 0o077) !== 0)) {
    throw unavailableError('受管密钥文件不合规：必须是普通文件，且除属主外不能有任何权限位（chmod 600）');
  }
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (err) {
    throw unavailableError(`受管密钥文件读不了（${err.code || err.message}）`);
  }
  const len = Buffer.byteLength(content, 'utf8');
  if (len < MANAGED_SECRET_MIN || len > MANAGED_SECRET_MAX) {
    throw unavailableError(`受管密钥文件长度不合规：应为 ${MANAGED_SECRET_MIN}–${MANAGED_SECRET_MAX} 字节`);
  }
  return content;
}

/**
 * enc:v2 os 源的密钥：App 用 @napi-rs/keyring 存 32 字节随机数（base64url）在系统钥匙串，
 * service "ZCode Credential Encryption"，account = sha256(resolve 后的凭据文件路径) hex。
 * macOS 上用系统自带的 security 命令读；其它平台没有等价物，明确报「不支持」。
 * 返回值是原始 32 字节密钥（不再过 sha256）。读不到、被拒绝、超时都归「存储不可用」。
 */
function readOsKeySync({ credentialsFile, osSecret, platform = os.platform() }) {
  if (typeof osSecret === 'function' || typeof osSecret === 'string') {
    const v = typeof osSecret === 'function' ? osSecret({ credentialsFile }) : osSecret;
    return decodeOsSecret(v);
  }
  if (platform !== 'darwin') {
    throw unavailableError('enc:v2 的 os 源密钥在系统凭据存储里：本插件目前只有 macOS 上能用 security 命令读出来，Windows/Linux 暂无等价实现');
  }
  const account = createHash('sha256').update(path.resolve(credentialsFile), 'utf8').digest('hex');
  let out;
  try {
    out = execFileSync('security', ['find-generic-password', '-s', OS_KEYCHAIN_SERVICE, '-a', account, '-w'], {
      encoding: 'utf8',
      timeout: KEYCHAIN_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (err?.killed || err?.signal === 'SIGTERM' || /timed out/i.test(String(err?.message))) {
      throw unavailableError('读系统钥匙串超时：可能在等钥匙串授权弹窗，重试或先解锁钥匙串');
    }
    throw unavailableError('系统钥匙串里的凭据密钥读不到：第一次读会弹「是否允许访问」，选「始终允许」；被拒绝过就到钥匙串访问里改回允许');
  }
  return decodeOsSecret(out);
}

/** os 源密钥字符串 → 32 字节密钥；形状不对（非 43 字符 base64url / 非 32 字节）归「存储不可用」。 */
function decodeOsSecret(secret) {
  const trimmed = typeof secret === 'string' ? secret.trim() : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(trimmed)) {
    throw unavailableError('系统凭据存储里的密钥形状不对：应是 43 字符 base64url（32 字节）');
  }
  const key = Buffer.from(trimmed, 'base64url');
  if (key.length !== 32) {
    throw unavailableError('系统凭据存储里的密钥长度不对：应解码出 32 字节');
  }
  return key;
}

/**
 * 解一个 enc:v2 值。格式：<源>:<密钥指纹>:<载荷>；源只认 os 与 env。
 * 解析按值自带的源走：env → sha256(managed secret)，os → 钥匙串原始密钥；
 * 指纹对不上 = 密钥不对，归解不开。ctx 由 openCredentials 注入（credentialsFile/env/osSecret/platform）。
 */
function decryptV2(body, ctx) {
  const parts = body.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('加密凭据格式不对：enc:v2 应为 enc:v2:<源>:<指纹>:<密文> 三段');
  }
  const [source, fingerprint, payload] = parts;
  if (source !== 'os' && source !== 'env') {
    throw new Error('加密凭据格式不对：enc:v2 的密钥源只认 os 或 env');
  }
  if (!/^[a-f0-9]{24}$/.test(fingerprint)) {
    throw new Error('加密凭据格式不对：enc:v2 的密钥指纹应是 24 个 hex 字符');
  }
  const key = source === 'os'
    ? readOsKeySync(ctx)
    : (() => {
        const secret = resolveManagedSecret(ctx);
        if (secret === null) {
          throw unavailableError('enc:v2:env: 的受管密钥找不到：设 ZCODE_CREDENTIAL_SECRET，或准备 ZCODE_CREDENTIAL_SECRET_FILE / 凭据旁的 credential-secret');
        }
        return createHash('sha256').update(secret, 'utf8').digest();
      })();
  if (keyFingerprint(key) !== fingerprint) {
    throw new Error('凭据解不开（密钥指纹对不上）：解出的密钥不是加密用的那把');
  }
  return gcmOpen(payload, key);
}

/**
 * 解一个凭据值。keyOrCtx 兼容两种调用：直接给密钥（Buffer 或候选表，只解 enc:v1），
 * 或 openCredentials 注入的 { keys, credentialsFile, env, osSecret, platform }（v1/v2 都走这里）。
 * 明文（无 enc: 前缀）原样返回；enc:v1 → 候选表依序试；enc:v2 → 按源取密钥；
 * 其它 enc:<版本> 一律报「不认得」（不再当明文，issue #6 的误报根因）。
 */
export function decryptCredentialValue(value, keyOrCtx) {
  if (typeof value !== 'string' || !value.startsWith(ENC_PREFIX)) return value;
  const ctx = Buffer.isBuffer(keyOrCtx) || Array.isArray(keyOrCtx)
    ? { keys: Array.isArray(keyOrCtx) ? keyOrCtx : [keyOrCtx] }
    : keyOrCtx;
  if (value.startsWith(ENC_V1_PREFIX)) {
    const payload = value.slice(ENC_V1_PREFIX.length);
    const keys = ctx?.keys ?? [];
    // 格式错误只报一次；密钥挨个试，全挂才报解不开（照 App createLegacyCipher 的语义）
    let lastErr;
    for (const key of keys) {
      try {
        return gcmOpen(payload, key);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('凭据解不开')) {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error('凭据解不开：没有可用的解密密钥');
  }
  if (value.startsWith(ENC_V2_PREFIX)) {
    if (!ctx?.credentialsFile) {
      throw new Error('enc:v2 需要凭据文件上下文才能取密钥：调用方应走 readCodingPlanKeys / readOffPeakAuth / readStartPlanAuth');
    }
    return decryptV2(value.slice(ENC_V2_PREFIX.length), ctx);
  }
  throw new Error('加密凭据格式不认得：值带 enc: 前缀但不是 v1/v2，凭据格式可能比本插件新，先升级 zcode-executor 再看看');
}

/**
 * 打开凭据文件，返回按需解密的 read(键)。三态同 readCodingPlanKeys：文件不存在 → null；
 * 出问题 → { error, kind }；成功 → { read }。read 解不开时抛 Error（message 带键名、不带密文）。
 * 可注入：key（v1 单密钥）、osSecret（v2 os 源密钥字符串或 () => string，测试用）、platform。
 */
function openCredentials({ credentialsPath, env = process.env, key, osSecret, platform } = {}) {
  const file = credentialsPath ?? defaultCredentialsPath(env);
  let raw;
  // credential-source 钉了非 os 的值时 App 拒绝一切解密（pin 检查在共享的取密钥路径上），照抄
  let pin;
  try {
    pin = readCredentialSourcePin(file);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), kind: 'unavailable' };
  }
  if (pin !== null && pin !== CREDENTIAL_SOURCE_OS) {
    return { error: 'credential-source 钉的密钥来源不是 os：App 此时会拒绝解密所有凭据，照它的口径报不可用', kind: 'unavailable' };
  }
  const keys = key !== undefined
    ? [key]
    : deriveCredentialKeyCandidates({ env, platform: platform ?? os.platform() });
  const ctx = { keys, credentialsFile: file, env, osSecret, platform };
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    // 权限一类的读失败不是 App 改了格式，归「暂时不可用」
    return { error: `credentials.json 读不了：${err.message}`, kind: 'unavailable' };
  }
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    return { error: `credentials.json 不是合法 JSON：${file}。文件可能被 ZCode App 正在重写，稍后重试`, kind: 'changed' };
  }
  if (values === null || typeof values !== 'object' || Array.isArray(values)) {
    return { error: 'credentials.json 的形状不对：应是 { "<键>": "<值>" } 的平面对象', kind: 'changed' };
  }
  const read = (k) => {
    if (!(k in values)) return undefined; // 键不存在不算错（那一档 key 就是没有）
    let v;
    try {
      v = decryptCredentialValue(values[k], ctx);
    } catch (err) {
      // 补上键名再抛：哪个键解不开说清楚，键名不是秘密，密文留在原地不进 message
      const e = new Error(`键 ${k}：${err instanceof Error ? err.message : String(err)}`);
      if (err?.code === 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE') e.code = err.code;
      throw e;
    }
    // 解出来不是字符串当没有（T6-C-fix 第 5 条）：非字符串的 key 进 secrets 抹除名单会让
    // scrubValues 的按值替换静默失效，从源头就不收
    return typeof v === 'string' ? v : undefined;
  };
  return { read };
}

/** 从 read 里读四个键；解不开照样抛（调用方统一接住归 changed / unavailable）。 */
function planKeysFrom(read) {
  const active = read(ACTIVE_PROVIDER_KEY);
  if (active === undefined) {
    return { error: `credentials.json 里没有 ${ACTIVE_PROVIDER_KEY}：还没在 ZCode App 里用账号登录`, kind: 'not-applicable' };
  }
  if (active !== 'zai' && active !== 'bigmodel') {
    // 解出来的值一律不进面向人的文案（T6-C-fix 第 4 条）
    return { error: 'oauth:active_provider 不是 zai 或 bigmodel，账号型 coding plan 没法接', kind: 'changed' };
  }
  const family = active;
  const userInfoRaw = read(userInfoKey(family));
  if (userInfoRaw === undefined) {
    return { error: `credentials.json 里没有 oauth:${family}:user_info，账号信息不完整。重登一次 ZCode App 试试`, kind: 'not-applicable' };
  }
  let userInfo;
  try {
    userInfo = JSON.parse(userInfoRaw);
  } catch {
    return { error: `oauth:${family}:user_info 解出来不是合法 JSON`, kind: 'changed' };
  }
  // App 3.17.2 起 zai 族写的 user_info 是 rawProfile（账号 id 字段叫 user_id），不再是规范化形状；
  // App 读回时只在 zai 族兜底映射 user_id → id（app.asar toOAuthUserProfileFromRawZaiUser 2026-11-16 对照，
  // issue #6）。bigmodel 族仍存规范化形状，顶层 id 照旧。
  const accountId = userInfo?.id
    ?? (family === 'zai' && typeof userInfo?.user_id === 'string' ? userInfo.user_id : undefined);
  if (accountId === undefined || accountId === null || accountId === '') {
    return { error: `oauth:${family}:user_info 里没有账号 id，账号型 coding plan 的 key 键名拼不出来`, kind: 'not-applicable' };
  }
  const plans = {};
  for (const plan of ['individual', 'team']) {
    const v = read(planApiKey(family, plan, String(accountId)));
    if (v) plans[plan] = v;
  }
  return { family, accountId: String(accountId), plans };
}

/** read 抛的按 code 分档：系统存储不可用归 unavailable，其余（解不开、格式不对）归 changed。 */
function decryptFailure(err) {
  const kind = err?.code === 'CREDENTIAL_SECURE_STORAGE_UNAVAILABLE' ? 'unavailable' : 'changed';
  return { error: err instanceof Error ? err.message : String(err), kind };
}

/**
 * 读账号型 coding plan 的四个键。返回三态：
 * - 文件不存在 → null（没在 App 里登录过，正常状态）；
 * - 出问题 → { error: '<中文原因>', kind }（不抛，让调用方记 warning / doctor 报「不可用」；
 *   kind 是 not-applicable / changed / unavailable，闲时自检按它分档）；
 * - 成功 → { family, accountId, plans: { individual?: string, team?: string } }，
 *   两把 key 都没有时 plans 是空对象；key 的值只出现在 plans 里。
 * credentialsPath / env / key / osSecret / platform 都可注入（测试用），env 缺省 process.env。
 */
export function readCodingPlanKeys(options = {}) {
  const creds = openCredentials(options);
  if (!creds || creds.error) return creds;
  try {
    return planKeysFrom(creds.read);
  } catch (err) {
    return decryptFailure(err);
  }
}

/**
 * 读 start plan 投递的鉴权（D21）：只要 oauth:active_provider（定族）与 zcodejwttoken（凭据）。
 * start plan 不用 coding plan key——宿主给 start-plan provider 的 requestAuth 只有 JWT
 * （App 宿主 createAccountProviderRequestAuthService.resolveCurrent 2026-09-29 对照），所以
 * user_info 与两把 plan key 缺席照样能读，readCodingPlanKeys 那套要求这里全不适用。
 * 成功 → { family, jwt }；失败 → { error, kind }，kind 同 readOffPeakAuth；文件不存在 → null。
 * 文案里永远没有 JWT 的值。参数同 readCodingPlanKeys。
 */
export function readStartPlanAuth(options = {}) {
  const creds = openCredentials(options);
  if (!creds) {
    return { error: '没找到 ZCode 凭据文件：没在 ZCode App 里用账号登录。先在 App 里登录 Start Plan 账号', kind: 'not-applicable' };
  }
  if (creds.error) return creds;
  try {
    const family = creds.read(ACTIVE_PROVIDER_KEY);
    if (family === undefined) {
      return { error: `credentials.json 里没有 ${ACTIVE_PROVIDER_KEY}：还没在 ZCode App 里用账号登录`, kind: 'not-applicable' };
    }
    if (family !== 'zai' && family !== 'bigmodel') {
      // 解出来的值一律不进面向人的文案
      return { error: 'oauth:active_provider 不是 zai 或 bigmodel，start plan 投递没法接', kind: 'changed' };
    }
    const jwt = creds.read(JWT_KEY);
    if (!jwt) {
      return { error: `凭据文件里没有 ${JWT_KEY}：没在 ZCode App 里用账号登录。重登一次 App 试试`, kind: 'not-applicable' };
    }
    return { family, jwt };
  } catch (err) {
    return decryptFailure(err);
  }
}

/**
 * 读闲时投递的鉴权（D20）：四个键之外只多解 zcodejwttoken。
 * 成功 → { family, jwt, planKey }（planKey 是个人版 key）；
 * 失败 → { error: '<中文原因，说清怎么办>', kind }，kind 为 not-applicable（没登录、团队版、没 key）
 * 或 changed（解不开、格式不对，App 的凭据格式可能变了）或 unavailable（文件读不了、
 * 系统凭据存储不可用——v2 os 源的钥匙串读不到也走这档）。
 * 文案里永远没有 JWT 与 key 的值。参数同 readCodingPlanKeys。
 */
export function readOffPeakAuth(options = {}) {
  const creds = openCredentials(options);
  if (!creds) {
    return { error: '没找到 ZCode 凭据文件：没在 ZCode App 里用账号登录。先在 App 里登录 Coding Plan 账号', kind: 'not-applicable' };
  }
  if (creds.error) return creds;
  try {
    const keys = planKeysFrom(creds.read);
    if (keys.error) return keys;
    if (!keys.plans.individual) {
      return keys.plans.team
        ? { error: '只找到团队版 Coding Plan key：团队版暂不支持闲时投递', kind: 'not-applicable' }
        : { error: '凭据文件里没有 Coding Plan key：闲时投递需要个人版 Coding Plan 订阅，在 ZCode App 里用订阅账号登录', kind: 'not-applicable' };
    }
    const jwt = creds.read(JWT_KEY);
    if (!jwt) {
      return { error: `凭据文件里没有 ${JWT_KEY}：没在 ZCode App 里用账号登录。重登一次 App 试试`, kind: 'not-applicable' };
    }
    return { family: keys.family, jwt, planKey: keys.plans.individual };
  } catch (err) {
    return decryptFailure(err);
  }
}
