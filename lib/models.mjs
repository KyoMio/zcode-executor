// 本文件负责：工作流层的「模型侧」编排——resolveModels 把读 zcode 配置、选 provider、推表读回
// 模型清单、分档串成一个稳定调用，doctor / models / new 共用；zcodeInfo 转手 findZcode 与
// zcodeVersion，让外壳不直接 import 协议层（评审 T2.1b 第 3 条）。
// 不负责：建会话（session/create 的编排）、登记簿、退出码表。
// 被依赖方：bin/zcode-executor、后续 send / runner。
// 只依赖 lib/appserver.mjs、lib/providers.mjs、lib/tiers.mjs、lib/errors.mjs；
// ZCODE_CONFIG_PATH 只在这里读一次。
import process from 'node:process';
import { findZcode, readModelState, zcodeVersion } from './appserver.mjs';
import { DEFAULT_CONFIG_PATH, pickProvider, readProviderRegistry } from './providers.mjs';
import { assignTiers, thoughtLevelFor } from './tiers.mjs';
import { ExecutorError } from './errors.mjs';

/**
 * 零 token 拿到「选定 provider 下的模型与分档」。步骤：读 registry → pickProvider
 * （providerId 优先，其次 config.preferredProvider）→ readModelState（推表 + readState）→
 * 该 provider 的条目 → assignTiers(config.tiers)。
 * 返回 { configPath, providerCount, provider, registry, available（该 provider 的条目）,
 * all（全部条目，供 models 按 provider 分组）, fast, strong, current（readState 的 model.current）,
 * warnings }。warnings 是给人看的中文字符串数组：配置 tiers 指的模型不存在或被禁用、
 * preferredProvider 不在表里、某档为空。打印与否归调用方。env 原样透传给子进程（测试注入用）。
 */
export async function resolveModels({ config, configPath, providerId, zcodePath, env } = {}) {
  const path = configPath ?? process.env.ZCODE_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  const registry = readProviderRegistry(path);
  const wanted = providerId ?? config?.preferredProvider;
  const provider = pickProvider(registry, { preferredProvider: wanted });
  const state = await readModelState({ registry, zcodePath, env });
  const all = state?.settings?.model?.available ?? [];
  const { fast, strong, all: tagged } = assignTiers(
    all.filter((m) => m?.ref?.providerId === provider.providerId),
    { tiers: config?.tiers },
  );
  const available = tagged; // 该 provider 的条目，每项带 .tier（new 的登记项要从这里取有效归档）
  const warnings = [];
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
  return {
    configPath: path,
    providerCount: registry.providers.length,
    provider,
    registry,
    available,
    all,
    fast,
    strong,
    current: state?.settings?.model?.current ?? null,
    warnings,
  };
}

/**
 * 读 zcode 的 provider 配置（只读），返回 { configPath, registry }。ZCODE_CONFIG_PATH 在这里
 * 读一次（评审 T2.2b 第 11 条）：bin 不碰这个环境变量，doctor 第 ② 步与 new 的 --provider
 * 预校验都从这里拿。
 */
export function loadZcodeConfig(configPath) {
  const path = configPath ?? process.env.ZCODE_CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
  return { configPath: path, registry: readProviderRegistry(path) };
}

/** findZcode + zcodeVersion 转一手：返回 { path, version }，失败抛协议层的 ExecutorError。 */
export function zcodeInfo({ zcodePath } = {}) {
  const path = zcodePath ?? findZcode();
  return { path, version: zcodeVersion(path) };
}

/**
 * 模型审批的 modelRef（T3.2，放这里是因为要用与派活同一套 assignTiers 规则）：
 * 取登记簿 provider 下 fast 档的模型；配置 review.model 可覆盖 modelId；variant 取
 * thoughtLevelFor(model, review.thought ?? 'low')，模型没有那档就不带 variant
 * （generateText 的思考等级走 modelRef.variant，verified.md）。
 * 纯计算，不碰网络；registry 从 readProviderRegistry 来，models 形状
 * {modelId, label?, reasoning?, disabledReason?} 在这里就地转成 assignTiers 认的条目。
 * 选不出模型抛 ExecutorError（调用方决定降级：runner 记 stderr 后整个跳过模型审批）。
 */
export function resolveReviewModelRef({ registry, providerId, config } = {}) {
  const provider = (registry?.providers ?? []).find((p) => p.providerId === providerId);
  if (!provider) {
    throw new ExecutorError(`provider ${providerId ?? '（空）'} 不在 provider 表里，模型审批没法选模型。检查登记簿或重跑 zcode-executor models`);
  }
  const entries = (provider.models ?? [])
    .filter((m) => m?.modelId)
    .map((m) => ({
      ref: { providerId: provider.providerId, modelId: m.modelId },
      label: m.label,
      reasoning: m.reasoning,
      disabledReason: m.disabledReason,
    }));
  const { fast } = assignTiers(entries, { tiers: config?.tiers });
  let model = fast;
  const wanted = config?.review?.model;
  if (wanted !== undefined) {
    // 改（T3.2b 评审）：registry 的 models 来自 config.json，根本没有 disabledReason 字段，
    // 这里的「未被禁用」过滤是空转——直接按 modelId 找（assignTiers 内部的同款过滤是
    // 与 readState 侧共用的规则，保持原样）
    model = entries.find((m) => m.ref.modelId === wanted) ?? null;
    if (!model) {
      throw new ExecutorError(`配置 review.model 指的模型 ${wanted} 不在 ${providerId} 的可用模型里。换一个 modelId 或删掉这项配置`);
    }
  }
  if (!model) {
    throw new ExecutorError(`${providerId} 下没有 fast 档可用模型，模型审批没法选模型。用配置 review.model 指一个，或 review.enabled:false 关掉自动审批`);
  }
  const variant = thoughtLevelFor(model, config?.review?.thought ?? 'low');
  const modelRef = { providerId: model.ref.providerId, modelId: model.ref.modelId };
  if (variant !== undefined) modelRef.variant = variant;
  return { modelRef, model };
}
