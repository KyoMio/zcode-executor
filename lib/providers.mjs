// 本文件负责：从 ~/.zcode/v2/config.json 构造 workspace/updateProviderRegistry 的 provider 表
// （buildRegistry / readProviderRegistry），以及 provider 选择与 session/create 的 runtimeModel
// 构造（pickProvider / buildRuntimeModel，decisions D6、D11）。
// 不负责：发请求（协议层的事）、配置的写入（这个文件永远只读）、输出脱敏（在 lib/scrub.mjs，
// T0.3b 复核 B 把它挪过去让协议层不必依赖本模块）。
//
// 安全边界（RULES §6、§8）：本文件读到的 config 内容——包括 apiKey——只进
// updateProviderRegistry 的请求 params，发给 app-server 子进程；不落盘、不打日志、
// 不进任何面向人的输出。凡是要打印/落盘的数据，先过 lib/scrub.mjs 的 redactSecrets()。
//
// 来源：provider 表构造与 revision 哈希移植自 zcode-acp-server 0.17.1（Apache-2.0，
// William Wang，https://github.com/william0wang/zcode-acp）dist/config/provider-registry.js，
// 见 NOTICE。改动处在行内标「改：」。
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';

// 默认路径导出给外壳报路径用（doctor 第 ② 步只报存在与否和 provider 个数，不打内容）
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'v2', 'config.json');

/** config.json 的 kind → 协议 apiFormat（搬自 provider-registry.js）。 */
function apiFormatForKind(kind) {
  if (!kind) return undefined;
  if (kind.includes('anthropic')) return 'anthropic-messages';
  if (kind.includes('openai')) return 'openai-chat-completions';
  return undefined;
}

/**
 * config.json 的单个 model 条目 → 协议 model 元素（搬自 buildModelElement）。
 * reasoning 不带的话后端会退回 apiFormat 的两档默认思考等级，丢掉真实 variants。
 */
function buildModelElement(modelId, m) {
  const el = { modelId };
  if (m.name) el.label = m.name;
  if (m.limit?.context) el.contextWindow = m.limit.context;
  if (m.limit?.output) el.maxOutputTokens = m.limit.output;
  const variants = m.reasoning?.variants ?? [];
  if (m.reasoning?.enabled && variants.length > 0) {
    const reasoning = { enabled: true, levels: variants.map((v) => ({ value: v, label: v })) };
    if (m.reasoning.defaultVariant) reasoning.defaultLevel = m.reasoning.defaultVariant;
    el.reasoning = reasoning;
  }
  return el;
}

/** config.json 的单个 provider 条目 → 协议 provider 元素（搬自 buildProviderElement）。 */
function buildProviderElement(providerId, p) {
  // models 必须是数组：后端 strict schema 拒绝 config.json 里的对象形状
  const models = Object.entries(p.models ?? {}).map(([modelId, m]) => buildModelElement(modelId, m ?? {}));
  const el = {
    providerId,
    kind: p.kind,
    apiFormat: apiFormatForKind(p.kind),
    baseURL: p.options?.baseURL,
    label: p.name ?? providerId,
    models,
    source: p.source ?? 'custom',
  };
  if (p.options?.apiKeyRequired !== undefined) {
    el.apiKeyRequired = p.options.apiKeyRequired;
  }
  // apiKey 必须是 inline union 形状，裸字符串会被后端 strict schema 拒绝
  if (p.options?.apiKey) {
    el.apiKey = { source: 'inline', value: p.options.apiKey };
  }
  for (const k of Object.keys(el)) {
    if (el[k] === undefined) delete el[k];
  }
  return el;
}

/**
 * 纯函数：config.json 解析后的对象 → {providers, generatedAt, revision}。
 * 改：过滤 enabled === false 和 models 为空的 provider（后端 schema 要求每个
 * provider 至少一个 model，空表会被整体拒绝）；enabled 缺省视为启用。
 * models 是数组（形状不对）同样视为空跳过，打一行 stderr 提醒（评审第 10 条）——
 * 任务单点名要这行警告，是本「纯函数」唯一的副作用出口。
 */
export function buildRegistry(config) {
  const providers = [];
  for (const [providerId, p] of Object.entries(config.provider ?? {})) {
    if (p?.enabled === false) continue;
    if (Array.isArray(p?.models)) {
      process.stderr.write(`providers: provider ${providerId} 的 models 是数组，按缺配置跳过\n`);
      continue;
    }
    if (Object.keys(p?.models ?? {}).length === 0) continue;
    providers.push(buildProviderElement(providerId, p ?? {}));
  }
  const generatedAt = Date.now();
  return { providers, generatedAt, revision: hashRevision(providers) };
}

/** FNV-1a 32 位 → 8 位 hex（搬自 provider-registry.js 的 hashRevision）；便宜的稳定哈希。 */
function fnv1aHex(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 一个 provider 的签名行（评审 T1.3b 第 6 条抽出共用）：providerId/kind/baseURL/models
 *  外加 apiKey 值的短哈希——key 轮换必须改变签名（否则后端会因 revision 相同跳过不应用），
 *  只拼哈希不拼原文，签名里不留密钥。 */
function providerSig(p) {
  return `${p.providerId}|${p.kind ?? ''}|${p.baseURL ?? ''}|${JSON.stringify(p.models ?? [])}|${fnv1aHex(p.apiKey?.value ?? '')}`;
}

/** 稳定短哈希：整张表的 provider 签名行排序后拼接再哈希。 */
function hashRevision(providers) {
  return fnv1aHex(providers.map(providerSig).sort().join('\n'));
}

/**
 * 纯函数：在 registry.providers（已经 buildRegistry 过滤过的）里按 D6 的优先级选一个 provider。
 * preferredProvider 命中优先；否则 id 以 -coding-plan 结尾 > -start-plan 结尾 > 其它；
 * 同级多个取 registry 里靠前的（同名模型在多个 provider 下并存时，readState 的顺序就是依据）。
 * 表里没有可用 provider 抛 ExecutorError(1)。
 */
export function pickProvider(registry, { preferredProvider } = {}) {
  const providers = registry?.providers ?? [];
  if (providers.length === 0) {
    throw new ExecutorError(
      'provider 表是空的：~/.zcode/v2/config.json 里没有可用的 provider（models 为空或 enabled:false 的都已被过滤）。确认 ZCode App 已登录并配好模型',
      1,
    );
  }
  // preferredProvider 不在表里的回落提醒由 resolveModels 的 warnings 统一收（评审 T2.2b 第 6 条）
  const rank = (p) => {
    if (preferredProvider !== undefined && p.providerId === preferredProvider) return 0;
    if (p.providerId.endsWith('-coding-plan')) return 1;
    if (p.providerId.endsWith('-start-plan')) return 2;
    return 3;
  };
  let best = providers[0];
  for (const p of providers) {
    if (rank(p) < rank(best)) best = p;
  }
  return best;
}

/**
 * 纯函数：provider + modelId → session/create 的 runtimeModel（decisions D11：create 不带它，
 * 回合会因 provider 无 key 失败，且默认模型落在 API Key 计费的 provider；resume 不带）。
 * provider 原样透传（含 apiKey 内联）——只进发给子进程的请求 params，不落盘不打印；
 * modelId 不在 provider.models 里抛 ExecutorError(2)。revision 同 buildRegistry 用 fnv 短哈希。
 */
export function buildRuntimeModel(provider, modelId) {
  const models = provider?.models ?? [];
  if (!models.some((m) => m.modelId === modelId)) {
    const known = models.map((m) => m.modelId).join('、') || '（无）';
    throw new ExecutorError(`provider ${provider?.providerId ?? '(缺 providerId)'} 里没有模型 ${modelId}。可选：${known}`, 2);
  }
  // 签名 = provider 签名行再拼上 modelId：模型、端点或 key 任一变化都要换 revision
  const sig = `${providerSig(provider)}|${modelId}`;
  return {
    revision: fnv1aHex(sig),
    generatedAt: Date.now(),
    model: { providerId: provider.providerId, modelId },
    provider,
  };
}

/**
 * 读 v2 config 并构造 registry。默认路径 ~/.zcode/v2/config.json（只读，D10）；
 * 文件不存在或 JSON 坏了抛 ExecutorError(1)。
 */
export function readProviderRegistry(configPath = DEFAULT_CONFIG_PATH) {
  if (!path.isAbsolute(configPath)) {
    configPath = path.resolve(process.cwd(), configPath);
  }
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new ExecutorError(
        `找不到 zcode 配置：${configPath}。确认 ZCode App 已安装并登录过`,
        1,
      );
    }
    throw new ExecutorError(`读不了 zcode 配置 ${configPath}：${err.message}`, 1);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new ExecutorError(`zcode 配置不是合法 JSON：${configPath}。文件可能被 App 正在重写，稍后重试`, 1);
  }
  return buildRegistry(config);
}
