// 本文件负责：start plan 投递（decisions D21）在协议层要的 provider 与参数形状——start plan 的
// provider id 与模型表（startPlanProviderId / startPlanModelIds）、provider/updateAccountConfig 的
// 授权配置（buildStartPlanAccountConfig，basedOnZCodeBuiltinRevision 算法复用闲时的
// lib/offpeak-provider.mjs）、start plan 回合 session/send 的额外参数（buildStartPlanSendParams）。
// 全是纯函数。不负责：凭据解密（lib/credentials.mjs）、反向请求 requestProviderRuntimeHeaders
// 的应答（lib/appserver.mjs 的 providerAuth 钩子，runner 侧接 lib/startplan-run.mjs）、发请求。
// 被依赖方：工作流层的 lib/startplan-send.mjs 与 lib/startplan-run.mjs。只依赖 lib/errors.mjs、
// lib/offpeak-provider.mjs。
//
// 与闲时的分工（D21，2026-09-29 对照 App 3.14.1 的 zcode.cjs 与 app.asar）：闲时回合的鉴权内联在
// send 参数里（CLI 只对 mode "off-peak" 认它）；start plan 的鉴权由宿主应答反向请求
// interaction/requestProviderRuntimeHeaders 给出（{apiKey: <JWT>}，无额外头），所以这里的 send
// 参数里没有 requestAuth。modelExecution.selectionScope 必须是 "execution"（send 参数 schema 的
// 必填字面量）：没有它逐回合的 modelSelection 可能落成会话当前模型，之后的普通投递会跟着走
// start plan 而且拿不到 JWT。
import { ExecutorError } from './errors.mjs';

const START_PLAN_FAMILIES = new Set(['zai', 'bigmodel']);

/** 纯函数：账号族 → 内置文件里的 start plan 条目 id。族不是 zai / bigmodel 抛 ExecutorError(2)。 */
export function startPlanProviderId(family) {
  if (!START_PLAN_FAMILIES.has(family)) {
    throw new ExecutorError(`不认识的账号族 ${family}，start plan 投递只支持 zai 与 bigmodel。确认 ZCode App 登录的是智谱账号`, 2);
  }
  return `account:${family}-start-plan`;
}

/**
 * 纯函数：内置配置里该族 start plan 条目的 builtinModelIds（start plan 模型表）。没有条目、没有模型表，
 * 或 providerRules 不是数组（App 改了文件格式）都返回 null，交给调用方报「接口变了」。
 */
export function startPlanModelIds(builtinConfig, family) {
  const providerId = startPlanProviderId(family);
  const rules = builtinConfig?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return null;
  return rules.find((r) => r?.providerId === providerId)?.config?.builtinModelIds ?? null;
}

/**
 * 纯函数：provider/updateAccountConfig 的参数——把内置文件里默认 entitled 的 start plan 条目标成可用
 * （形状与闲时授权一致，verified.md「闲时任务探针」2026-09-27 同款机制；revision 前缀换成
 * start plan 自己的，CLI 原样回显）。basedOnZCodeBuiltinRevision 缺抛 ExecutorError(2)——算错时
 * CLI 静默忽略整份配置，回执照样 received，真实表现是回合报 provider 找不到。
 */
export function buildStartPlanAccountConfig({ family, basedOnZCodeBuiltinRevision, now = Date.now() }) {
  const providerId = startPlanProviderId(family);
  if (!basedOnZCodeBuiltinRevision) {
    throw new ExecutorError('缺内置文件版本号（basedOnZCodeBuiltinRevision），CLI 会静默忽略整份账号配置。先用 offpeak-provider.mjs 的 builtinRevision() 算出来', 2);
  }
  return {
    revision: `zcode-executor-start-plan:${now}`,
    basedOnZCodeBuiltinRevision,
    providers: { [providerId]: { access: { type: 'zhipu-account', entitled: true } } },
    states: { [providerId]: { availability: 'available', entitled: true, current: true } },
  };
}

/**
 * 纯函数：start plan 回合的 session/send 在 {sessionId, content} 之外要多带的参数。
 * 不带 requestAuth（D21：start plan 的鉴权走反向请求，send 参数里的 requestAuth 只有 off-peak
 * mode 认）；toolDenylist 照会话原样，不加闲时那两个禁用工具。modelId 必填；reasoningLevel 为空
 * 不带 options（同 providers.mjs 的 buildModelSelection）。
 */
export function buildStartPlanSendParams({ family, modelId, reasoningLevel }) {
  const providerId = startPlanProviderId(family);
  if (!modelId) throw new ExecutorError('start plan 回合缺 modelId，发不出去。会话登记里应该有', 2);
  const modelSelection = { providerId, modelId };
  if (reasoningLevel) modelSelection.options = { reasoningLevel };
  return {
    modelSelection,
    modelExecution: { selectionScope: 'execution', memoryExtraction: 'skip' },
  };
}
