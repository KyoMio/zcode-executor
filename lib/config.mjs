// 本文件负责：zcode-executor 自己的数据目录与配置——resolveHome / loadConfig / writeJsonAtomic。
// 不负责：zcode 的 ~/.zcode/v2/config.json（那是 lib/providers.mjs 的事，只读）；
// 登记簿与 runs/ 的落盘形状；配置在命令里怎么用。
// 被依赖方：bin/zcode-executor 与后续工作流层。只依赖 lib/errors.mjs。
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';

const DEFAULT_WAIT_TIMEOUT_SEC = 1800;

/** '~' 开头的路径展开到用户家目录；其余原样。 */
function expandTilde(p) {
  if (p === '~') return os.homedir();
  if (typeof p === 'string' && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 数据目录：ZCODE_EXECUTOR_HOME 或 ~/.zcode-executor，返回绝对路径（~ 展开、相对按 cwd 解析）。 */
export function resolveHome() {
  const raw = process.env.ZCODE_EXECUTOR_HOME || '~/.zcode-executor';
  return path.resolve(expandTilde(raw));
}

function toStringArray(value, field, configPath) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    throw new ExecutorError(`配置 ${field} 必须是字符串数组：${configPath}`, 1);
  }
  return [...value];
}

/**
 * 读 <home>/config.json，没有就全默认。返回：
 * { home, allowedRoots:[<home>/worktrees], waitTimeoutSec:1800, preferredProvider:undefined,
 *   tiers:{}, environment:[], sensitive:[], warnings:[] }。
 * allowedRoots 的 ~ 展开并解析成绝对路径；坏 JSON / 类型不对抛 ExecutorError(1) 并说明文件路径；
 * 顶层不认识的键收进 warnings（调用方打印），不抛错。
 * 字段见 SPEC「工作流层」，都是可选的。
 */
export function loadConfig(home = resolveHome()) {
  const absHome = path.resolve(expandTilde(home));
  const configPath = path.join(absHome, 'config.json');
  const config = {
    home: absHome,
    allowedRoots: [path.join(absHome, 'worktrees')],
    waitTimeoutSec: DEFAULT_WAIT_TIMEOUT_SEC,
    preferredProvider: undefined,
    tiers: {},
    environment: [],
    sensitive: [],
    // T3.2：模型审批。enabled:false 时红线仍判、其余一律挂起；model 覆盖 fast 档的 modelId；
    // thought 进 modelRef.variant；timeoutMs 是一次 generateText 的上限；fastMaxTokens 是快筛
    // 的输出预算（缺省 300，T3.2b——太小会把正文挤成空串，反而次次走慢判）；slowMaxTokens 是
    // 慢判预算（缺省 2000，T3.3——600 真机上被逐条推理挤到结论行没写出来）。
    review: {
      enabled: true,
      model: undefined,
      thought: 'low',
      fastMaxTokens: undefined,
      slowMaxTokens: undefined,
      timeoutMs: undefined,
    },
    warnings: [], // 评审 T2.1b 第 6 条：顶层不认识的键收进来，抛错归抛错、提醒归提醒
  };
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return config; // 没有配置文件就用全默认，不算错
    throw new ExecutorError(`读不了配置 ${configPath}：${err.message}`, 1);
  }
  let given;
  try {
    given = JSON.parse(raw);
  } catch {
    throw new ExecutorError(`配置不是合法 JSON：${configPath}。修好这个文件，或删掉它改用全默认`, 1);
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given)) {
    throw new ExecutorError(`配置必须是 JSON 对象：${configPath}`, 1);
  }
  if (given.allowedRoots !== undefined) {
    config.allowedRoots = toStringArray(given.allowedRoots, 'allowedRoots', configPath).map((p) =>
      path.resolve(expandTilde(p)),
    );
  }
  if (given.waitTimeoutSec !== undefined) {
    const n = Number(given.waitTimeoutSec);
    if (!Number.isFinite(n) || n <= 0) {
      throw new ExecutorError(`配置 waitTimeoutSec 必须是正数：${configPath}，收到 ${JSON.stringify(given.waitTimeoutSec)}`, 1);
    }
    config.waitTimeoutSec = n;
  }
  if (given.preferredProvider !== undefined) {
    if (typeof given.preferredProvider !== 'string') {
      throw new ExecutorError(`配置 preferredProvider 必须是字符串：${configPath}`, 1);
    }
    config.preferredProvider = given.preferredProvider;
  }
  if (given.tiers !== undefined) {
    if (given.tiers === null || typeof given.tiers !== 'object' || Array.isArray(given.tiers)) {
      throw new ExecutorError(`配置 tiers 必须是对象（{fast, strong}）：${configPath}`, 1);
    }
    // 评审 T2.1b 第 6 条：tiers 的值是 modelId，必须是字符串
    for (const tier of ['fast', 'strong']) {
      const id = given.tiers[tier];
      if (id !== undefined && (typeof id !== 'string' || id === '')) {
        throw new ExecutorError(`配置 tiers.${tier} 必须是非空字符串（modelId）：${configPath}，收到 ${JSON.stringify(id)}`, 1);
      }
    }
    config.tiers = { ...given.tiers };
  }
  // environment / sensitive 是给模型审批提示词用的自由文字，不做 ~ 展开
  config.environment = toStringArray(given.environment, 'environment', configPath);
  config.sensitive = toStringArray(given.sensitive, 'sensitive', configPath);
  if (given.review !== undefined) {
    if (given.review === null || typeof given.review !== 'object' || Array.isArray(given.review)) {
      throw new ExecutorError(`配置 review 必须是对象（{enabled, model, thought, fastMaxTokens, slowMaxTokens, timeoutMs}）：${configPath}`, 1);
    }
    const review = given.review;
    if (review.enabled !== undefined) {
      if (typeof review.enabled !== 'boolean') {
        throw new ExecutorError(`配置 review.enabled 必须是布尔值：${configPath}，收到 ${JSON.stringify(review.enabled)}`, 1);
      }
      config.review.enabled = review.enabled;
    }
    if (review.model !== undefined) {
      if (typeof review.model !== 'string' || review.model === '') {
        throw new ExecutorError(`配置 review.model 必须是非空字符串（modelId）：${configPath}，收到 ${JSON.stringify(review.model)}`, 1);
      }
      config.review.model = review.model;
    }
    if (review.thought !== undefined) {
      if (typeof review.thought !== 'string' || review.thought === '') {
        throw new ExecutorError(`配置 review.thought 必须是非空字符串：${configPath}，收到 ${JSON.stringify(review.thought)}`, 1);
      }
      config.review.thought = review.thought;
    }
    if (review.fastMaxTokens !== undefined) {
      const n = Number(review.fastMaxTokens);
      if (!Number.isFinite(n) || n <= 0) {
        throw new ExecutorError(`配置 review.fastMaxTokens 必须是正数：${configPath}，收到 ${JSON.stringify(review.fastMaxTokens)}`, 1);
      }
      config.review.fastMaxTokens = n;
    }
    if (review.slowMaxTokens !== undefined) {
      const n = Number(review.slowMaxTokens);
      if (!Number.isFinite(n) || n <= 0) {
        throw new ExecutorError(`配置 review.slowMaxTokens 必须是正数：${configPath}，收到 ${JSON.stringify(review.slowMaxTokens)}`, 1);
      }
      config.review.slowMaxTokens = n;
    }
    if (review.timeoutMs !== undefined) {
      const n = Number(review.timeoutMs);
      if (!Number.isFinite(n) || n <= 0) {
        throw new ExecutorError(`配置 review.timeoutMs 必须是正数：${configPath}，收到 ${JSON.stringify(review.timeoutMs)}`, 1);
      }
      config.review.timeoutMs = n;
    }
    for (const key of Object.keys(review)) {
      if (!['enabled', 'model', 'thought', 'fastMaxTokens', 'slowMaxTokens', 'timeoutMs'].includes(key)) {
        config.warnings.push(`配置 review 里有不认识的键 ${key}（已忽略），检查是否拼错：${configPath}`);
      }
    }
  }
  // 评审 T2.1b 第 6 条：顶层不认识的键不静默忽略，提醒调用方（可能是拼错字）
  const KNOWN_KEYS = new Set(['allowedRoots', 'waitTimeoutSec', 'preferredProvider', 'tiers', 'environment', 'sensitive', 'review']);
  for (const key of Object.keys(given)) {
    if (!KNOWN_KEYS.has(key)) config.warnings.push(`配置里有不认识的键 ${key}（已忽略），检查是否拼错：${configPath}`);
  }
  return config;
}

/** 临时文件 + rename 落盘（RULES §6），目录不存在就建；失败清掉半截临时文件再抛（T2.1b 第 11 条）。 */
export function writeJsonAtomic(filePath, obj) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件本来就没写成，清理目标已达成
    }
    throw err;
  }
}

/**
 * cwd 在 allowedRoots 哪个根之下（前缀比对补分隔符）；命中返回该根，否则 null。
 * 只对已解析过的路径做前缀比对；解析归 resolveWhitelist。
 */
export function allowedRootFor(allowedRoots, cwd) {
  return (
    (allowedRoots ?? []).find((root) => cwd === root || cwd.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) ??
    null
  );
}

/**
 * 白名单比较前的解析（评审 T2.2b 第 1 条）：cwd 与每个 allowedRoot 都做 realpathSync——
 * macOS /tmp 是 /private/tmp 的符号链接，两边写法都要能过；不存在的 allowedRoot 跳过。
 * cwd 必须已存在（调用方先查目录存在，不存在时按自己的退出码报）。
 * 返回 { cwd: 解析后的 cwd, roots: [存在的根解析后列表] }。
 */
export function resolveWhitelist(allowedRoots, cwd) {
  const roots = [];
  for (const root of allowedRoots ?? []) {
    try {
      roots.push(realpathSync(root));
    } catch {
      // 不存在的根跳过：配了还没建的目录不算白名单
    }
  }
  return { cwd: realpathSync(cwd), roots };
}

/** cwd 存在且是目录的检查；返回 { ok: true } 或 { ok: false, reason }（bin 按自己的退出码报）。 */
export function checkDirExists(cwd) {
  try {
    return statSync(cwd).isDirectory() ? { ok: true } : { ok: false, reason: `cwd 不是目录：${cwd}` };
  } catch {
    return { ok: false, reason: `cwd 不存在：${cwd}` };
  }
}
