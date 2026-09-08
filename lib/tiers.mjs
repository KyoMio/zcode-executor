// 本文件负责：模型等级（fast / strong）的纯函数分配与思考等级校验（SPEC「工作流层」、PRD 第 5 节、D6）。
// 不负责：拿模型清单（readState 归协议层，编排见 lib/models.mjs）、选 provider（lib/providers.mjs
// 的 pickProvider）、配置文件读取。
// 被依赖方：lib/models.mjs、bin/zcode-executor、后续 new 的等级分配。只依赖 lib/errors.mjs。
//
// 输入形状：readState 的 settings.model.available 条目
// { ref:{providerId, modelId}, label?, reasoning?:{levels:[{value,label}]}, disabledReason? }。
// 同一 modelId 在多个 provider 下各有一条：调用方先选定 provider，再把该 provider
// 的条目传进来，本文件不做跨 provider 挑选。

import { ExecutorError } from './errors.mjs';

// SPEC「工作流层」：含这些关键词（不分大小写）的模型归 fast，其余归 strong
const FAST_WORDS = ['flash', 'lite', 'mini', 'air'];

/** 从 id 里解析 x.y 版本号（第一段数字）；解析不出算 0（SPEC：同档多个取版本号最大的）。 */
function versionOf(modelId) {
  const m = String(modelId ?? '').match(/(\d+)(?:\.(\d+))?/);
  if (!m) return [0, 0];
  return [Number(m[1]), m[2] === undefined ? 0 : Number(m[2])];
}

function isNewer(a, b) {
  if (a[0] !== b[0]) return a[0] > b[0];
  return a[1] > b[1];
}

function isFast(model) {
  const hay = `${model?.ref?.modelId ?? ''} ${model?.label ?? ''}`.toLowerCase();
  return FAST_WORDS.some((w) => hay.includes(w));
}

function bestOf(candidates) {
  let best = null;
  for (const m of candidates) {
    if (best === null || isNewer(versionOf(m.ref.modelId), versionOf(best.ref.modelId))) best = m;
  }
  return best;
}

/**
 * 纯函数：把 models 分到 fast / strong 两档。
 * 有 disabledReason 的跳过（不参与任何档，all 里 tier 为 null）；配置 tiers.{fast,strong} 给的是
 * modelId，命中（未被禁用的条目里找）就覆盖自动结果，不让位——两档指向同一模型是允许的
 * （评审 T2.1b 第 1 条：本机每个 provider 只有寥寥几个模型，让位会把另一档弄空）。
 * 返回 { fast: model|null, strong: model|null, all: [{...model, tier}] }，
 * tier 是每个模型的有效归档（配置覆盖后按覆盖结果）；null 只给被禁用的（不参与任何档）。
 */
export function assignTiers(models, { tiers = {} } = {}) {
  const list = (models ?? []).filter((m) => m?.ref?.modelId);
  const kept = list.filter((m) => !m.disabledReason);
  const byId = (id) => kept.find((m) => m.ref.modelId === id) ?? null;
  const fast = byId(tiers.fast) ?? bestOf(kept.filter((m) => isFast(m)));
  const strong = byId(tiers.strong) ?? bestOf(kept.filter((m) => !isFast(m)));
  const tierOf = (m) => {
    if (m.disabledReason) return null;
    if (fast && m.ref.modelId === fast.ref.modelId) return 'fast';
    if (strong && m.ref.modelId === strong.ref.modelId) return 'strong';
    return isFast(m) ? 'fast' : 'strong';
  };
  return { fast, strong, all: list.map((m) => ({ ...m, tier: tierOf(m) })) };
}

/**
 * 纯函数：wanted（默认 high）在该模型的 reasoning.levels 里就返回它；没有且非显式时返回
 * undefined（表示不传，跟模型默认——SPEC「工作流层」，create 对非法值静默忽略，校验必须在
 * 客户端做）；用户显式给了（explicit）而档位里没有就抛 ExecutorError(2) 并列出合法档位。
 */
export function thoughtLevelFor(model, wanted = 'high', { explicit = false } = {}) {
  const levels = model?.reasoning?.levels ?? [];
  if (levels.some((l) => (l?.value ?? l) === wanted)) return wanted;
  if (explicit) {
    const legal = levels.map((l) => l?.value ?? l).join('、') || '（该模型没有任何思考等级）';
    throw new ExecutorError(`思考等级 ${wanted} 不在该模型的合法档位里。可选：${legal}`, 2);
  }
  return undefined;
}
