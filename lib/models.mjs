// 本文件负责：工作流层的「模型侧」编排——resolveModels 把读 zcode 配置、选 provider、从 registry
// 本地换算模型清单、分档、（可选的）零 token 握手串成一个稳定调用，doctor / models / new 共用；
// zcodeInfo 转手 findZcode / zcodeVersion / builtinProviderConfigPath，让外壳不直接 import 协议层
// （评审 T2.1b 第 3 条）；resolveReviewSelection 给模型审批选模型。
// 3.12 起没有 workspace/readState 了（verified.md「3.12.2 直连探针实测」表第 2 行，2026-09-18）：模型表本来就是我们自己写进
// 个人 provider 文件的，直接从 config.json 算；握手改成 probeHandshake（create deferred + close）。
// 不负责：建会话（session/create 的编排）、登记簿、退出码表。
// 被依赖方：lib/cli/doctor.mjs、lib/cli/models.mjs、lib/cli/new.mjs、lib/run.mjs。
// 只依赖 lib/appserver.mjs、lib/providers.mjs、lib/tiers.mjs、lib/errors.mjs；
// ZCODE_CONFIG_PATH 只在这里读一次。
import process from 'node:process';
import { builtinProviderConfigPath, findZcode, probeHandshake, zcodeVersion } from './appserver.mjs';
import {
  buildModelSelection,
  DEFAULT_CONFIG_PATH,
  EXECUTOR_PROVIDER_ID,
  pickProvider,
  readProviderRegistry,
  writePersonalProviderFile,
} from './providers.mjs';
import { assignTiers, reasoningLevelFor, thoughtLevelFor } from './tiers.mjs';
import { ExecutorError } from './errors.mjs';

// doctor 第 ② 步要报「选中的 provider 有没有明文 apiKey」，选 provider 的规则只有这一份（D6），
// 外壳不直接 import 协议层，从这里转手
export { pickProvider };

/**
 * registry 的 provider.models 元素 {modelId, label?, contextWindow?, maxOutputTokens?, reasoning?} →
 * 真机 settings.model.available 的条目形状 {ref:{providerId, modelId}, label?, reasoning?, contextWindow?,
 * maxOutputTokens?}（assignTiers / slimModel / models 命令都认这个形状）。ref.providerId 用 config.json
 * 的 id，不是 zcode-executor：登记簿、分组、显示都认 config.json 的 id（D14）。
 */
function availableEntries(provider) {
  return (provider.models ?? [])
    .filter((m) => m?.modelId)
    .map((m) => {
      const entry = { ref: { providerId: provider.providerId, modelId: m.modelId } };
      for (const k of ['label', 'reasoning', 'contextWindow', 'maxOutputTokens']) {
        if (m[k] !== undefined) entry[k] = m[k];
      }
      return entry;
    });
}

/** 个人 provider 文件里只有我们这一条 provider，apiKey 只按这个 id 给（协议层答 requestProviderRuntimeHeaders 用）。 */
function providerAuthFor(provider) {
  return (providerId) => (providerId === EXECUTOR_PROVIDER_ID ? provider.apiKey?.value : undefined);
}

/**
 * 拿到「选定 provider 下的模型与分档」。步骤：读 registry → pickProvider（providerId 优先，其次
 * config.preferredProvider）→ 该 provider 的条目本地换算 → assignTiers(config.tiers) →
 * handshake:true 时再零 token 握手一次（写个人文件 → probeHandshake → 删文件），create 用 fast 档
 * （没有 fast 用 strong），把回来的 settings.model.available 里 zcode-executor 名下的模型和本地清单比对，
 * 个人文件写了但 app-server 没认的进 warnings。
 * 返回 { configPath, providerCount, provider, registry, available（该 provider 的条目，每项带 .tier）,
 * all（全部 provider 的条目，供 models 按 provider 分组）, fast, strong, warnings }。
 * warnings 是给人看的中文字符串数组：来源缺失的提醒（T6-C，排最前）、配置 tiers 指的模型不存在、
 * preferredProvider 不在表里、某档为空、握手对不上。打印与否归调用方。zcodePath / env 原样透传给子进程（测试注入用）。
 */
export async function resolveModels({ config, configPath, providerId, zcodePath, env, handshake = false } = {}) {
  const path = configPath ?? process.env.ZCODE_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  // env 透传给 readProviderRegistry（T6-C：账号型来源按 env 解析 ZCODE_BIN / 内置文件 / ZCODE_DATA_BASE_DIR，
  // 测试注入的 mock 环境就是同一份），握手时再原样传给子进程
  const registry = readProviderRegistry(path, { env });
  const wanted = providerId ?? config?.preferredProvider;
  const provider = pickProvider(registry, { preferredProvider: wanted });
  const all = registry.providers.flatMap(availableEntries);
  const { fast, strong, all: available } = assignTiers(availableEntries(provider), { tiers: config?.tiers });
  // registry.warnings 是来源层的提醒（credentials.json 不存在、config.json 不存在一类），排最前
  const warnings = [...(registry.warnings ?? [])];
  if (wanted !== undefined && !registry.providers.some((p) => p.providerId === wanted)) {
    warnings.push(`provider ${wanted} 不在 provider 表里，已按优先级回落到 ${provider.providerId}`);
  }
  for (const tier of ['fast', 'strong']) {
    const id = config?.tiers?.[tier];
    if (id !== undefined && !available.some((m) => m.ref.modelId === id && !m.disabledReason)) {
      warnings.push(`配置 tiers.${tier} 指的模型 ${id} 不在 ${provider.providerId} 的可用模型里或被禁用，该档按自动规则选`);
    }
  }
  if (!fast) warnings.push('fast 档没有可用模型');
  if (!strong) warnings.push('strong 档没有可用模型');
  if (handshake) {
    // registry 已经滤掉没有模型的 provider，fast 与 strong 不会同时为空
    const probe = fast ?? strong;
    const providerModel = provider.models.find((m) => m.modelId === probe.ref.modelId);
    // 档位照 new + runner 的同一条路：模型有 high 就 high，没有退 defaultLevel 再退 high
    const reasoningLevel = reasoningLevelFor(thoughtLevelFor(probe, 'high'), providerModel);
    const file = writePersonalProviderFile(provider);
    let settings;
    try {
      settings = await probeHandshake({
        personalProviderFile: file.path,
        providerAuth: providerAuthFor(provider),
        model: buildModelSelection(provider, probe.ref.modelId, reasoningLevel),
        thoughtLevel: reasoningLevel,
        zcodePath,
        env,
        secrets: registry.providers.map((p) => p.apiKey?.value).filter(Boolean),
      });
    } finally {
      file.dispose(); // 密钥只落这一个文件（D14），握手成败都删
    }
    const seen = new Set(
      (settings?.model?.available ?? [])
        .filter((m) => m?.ref?.providerId === EXECUTOR_PROVIDER_ID)
        .map((m) => m.ref.modelId),
    );
    for (const m of provider.models) {
      if (!seen.has(m.modelId)) {
        warnings.push(`个人 provider 文件里的模型 ${m.modelId} 没被 app-server 认下（settings.model.available 里没有），config.json 的模型表可能和 App 不一致`);
      }
    }
  }
  return {
    configPath: path,
    providerCount: registry.providers.length,
    provider,
    registry,
    available,
    all,
    fast,
    strong,
    warnings,
  };
}

/**
 * 读 zcode 的 provider 配置（只读），返回 { configPath, registry, warnings }。ZCODE_CONFIG_PATH 在这里
 * 读一次（评审 T2.2b 第 11 条）：bin 不碰这个环境变量，doctor 第 ② 步与 new 的 --provider
 * 预校验都从这里拿。warnings 是 registry.warnings 的转手（T6-C：来源缺失一类的中文提醒，
 * 3.12 起 readProviderRegistry 不再对单来源缺失抛错）。
 */
export function loadZcodeConfig(configPath) {
  const path = configPath ?? process.env.ZCODE_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  const registry = readProviderRegistry(path);
  return { configPath: path, registry, warnings: registry.warnings ?? [] };
}

/**
 * findZcode + zcodeVersion + 内置 provider 文件定位转一手：返回
 * { path, version, builtinConfigPath, builtinConfigError }。找不到 zcode 或 --version 跑不了照旧抛；
 * 内置文件找不到不抛，错误信息放进 builtinConfigError 让 doctor 自己排版——这是「App ≥ 3.12」的判据
 * （`--version` 在 3.11 和 3.12 都打 0.16.5，verified.md「3.12.2 直连探针实测」 2026-09-18）。
 * builtinFile 与 spawn 同一优先级：环境变量 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指了就用它（spawn 会原样
 * 交给子进程，所以这里顺手查它存不存在），没指才从 zcode.cjs 位置推。测试传参免改全局环境变量。
 */
export function zcodeInfo({ zcodePath, builtinFile = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE } = {}) {
  const path = zcodePath ?? findZcode();
  const version = zcodeVersion(path);
  let builtinConfigPath = null;
  let builtinConfigError = null;
  try {
    builtinConfigPath = builtinProviderConfigPath(path, { builtinFile });
  } catch (err) {
    if (!(err instanceof ExecutorError)) throw err;
    builtinConfigError = err.message;
  }
  return { path, version, builtinConfigPath, builtinConfigError };
}

/**
 * 模型审批的 selection（T3.2，放这里是因为要用与派活同一套 assignTiers 规则）：
 * 取登记簿 provider 下 fast 档的模型；配置 review.model 可覆盖 modelId；思考等级取
 * thoughtLevelFor(model, review.thought ?? 'low')，模型没有那档就不带 options
 * （3.12.2 起 generateText 的思考等级走 selection.options.reasoningLevel，verified.md「3.12.2 直连探针实测」表第 4 行）。
 * 纯计算，不碰网络；registry 从 readProviderRegistry 来。
 * 返回 { selection, model }：selection 是 buildModelSelection 的形状（providerId 固定 zcode-executor），
 * model 是 available 形状的条目（ref.providerId 仍是 config.json 的 id）。
 * 选不出模型抛 ExecutorError（调用方决定降级：runner 记 stderr 后整个跳过模型审批）。
 */
export function resolveReviewSelection({ registry, providerId, config } = {}) {
  const provider = (registry?.providers ?? []).find((p) => p.providerId === providerId);
  if (!provider) {
    throw new ExecutorError(`provider ${providerId ?? '（空）'} 不在 provider 表里，模型审批没法选模型。检查登记簿或重跑 zcode-executor models`);
  }
  const entries = availableEntries(provider);
  const { fast } = assignTiers(entries, { tiers: config?.tiers });
  let model = fast;
  const wanted = config?.review?.model;
  if (wanted !== undefined) {
    // registry 的 models 来自 config.json，没有 disabledReason 字段，直接按 modelId 找（T3.2b 评审）
    model = entries.find((m) => m.ref.modelId === wanted) ?? null;
    if (!model) {
      throw new ExecutorError(`配置 review.model 指的模型 ${wanted} 不在 ${providerId} 的可用模型里。换一个 modelId 或删掉这项配置`);
    }
  }
  if (!model) {
    throw new ExecutorError(`${providerId} 下没有 fast 档可用模型，模型审批没法选模型。用配置 review.model 指一个，或 review.enabled:false 关掉自动审批`);
  }
  const reasoningLevel = thoughtLevelFor(model, config?.review?.thought ?? 'low');
  return { selection: buildModelSelection(provider, model.ref.modelId, reasoningLevel), model };
}
