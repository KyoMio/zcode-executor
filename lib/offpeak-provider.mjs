// 本文件负责：闲时投递（decisions D20）在协议层要的 provider 与参数形状——闲时 provider id 与模型表
// （offPeakProviderId / offPeakModelIds）、provider/updateAccountConfig 的内置版本号与授权配置
// （formatBuiltinRevision / builtinRevision / buildOffPeakAccountConfig）、闲时回合 session/send 的额外参数
// （buildOffPeakSendParams）。除 builtinRevision 读内置文件外都是纯函数。
// 不负责：发请求（会话层 lib/session.mjs 的 send 接 extraParams）、取号与结算（工作流层的闲时服务器客户端）、
// 凭据解密（lib/credentials.mjs）、普通 provider 表（lib/providers.mjs）。
// 被依赖方：工作流层 runner 的闲时部分、doctor。只依赖 lib/errors.mjs、lib/scrub.mjs。
//
// 安全边界（RULES §8，AGENTS.md 硬约束）：buildOffPeakSendParams 的结果里有 JWT 与 plan key（requestAuth），
// 只能进 JSON-RPC 参数；调用方必须把这两个值放进 Session 与 AppServerClient.spawn 的 secrets，落盘与转发时按值抹掉。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ExecutorError } from './errors.mjs';
import { MIN_SECRET_LENGTH } from './scrub.mjs';

const OFFPEAK_FAMILIES = new Set(['zai', 'bigmodel']);
// 闲时回合里不许模型自己再建定时或闲时任务（App 发闲时回合时同样加这两个，verified.md「闲时任务探针」2026-09-27）
const OFFPEAK_DENIED_TOOLS = ['CronCreate', 'OffPeakCreate'];

/** 纯函数：账号族 → 内置文件里的闲时隐藏条目 id。族不是 zai / bigmodel 抛 ExecutorError(2)。 */
export function offPeakProviderId(family) {
  if (!OFFPEAK_FAMILIES.has(family)) {
    throw new ExecutorError(`不认识的账号族 ${family}，闲时投递只支持 zai 与 bigmodel。确认 ZCode App 登录的是智谱账号`, 2);
  }
  return `account:${family}-offpeak-idle-plan`;
}

/**
 * 纯函数：内置配置里该族闲时条目的 builtinModelIds（闲时模型表）。没有条目、没有模型表，
 * 或 providerRules 不是数组（App 改了文件格式）都返回 null，交给调用方报「接口变了」。
 */
export function offPeakModelIds(builtinConfig, family) {
  const providerId = offPeakProviderId(family);
  const rules = builtinConfig?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return null;
  return rules.find((r) => r?.providerId === providerId)?.config?.builtinModelIds ?? null;
}

/**
 * 纯函数：内置文件 revision + 路径 → updateAccountConfig 的 basedOnZCodeBuiltinRevision。
 * verified.md「闲时任务探针」2026-09-27：CLI 算的是 sha256(path.resolve(内置文件路径))——哈希路径字符串，不是文件内容；
 * 不等就静默忽略整份账号配置。路径必须和 app-server 子进程读的那个一致（lib/appserver.mjs 的
 * builtinProviderConfigPath 返回绝对路径，子进程环境变量里的也是它）。
 */
export function formatBuiltinRevision(revision, builtinPath) {
  const hash = createHash('sha256').update(path.resolve(builtinPath)).digest('hex');
  return `zcode-builtin:${revision}:${hash}`;
}

/** 读内置文件的顶层 revision 拼成 basedOnZCodeBuiltinRevision。读不到、不是 JSON、没有 revision 抛 ExecutorError(2)。 */
export function builtinRevision(builtinPath) {
  let revision;
  try {
    revision = JSON.parse(readFileSync(builtinPath, 'utf8'))?.revision;
  } catch (err) {
    throw new ExecutorError(`内置 provider 文件读不了或不是合法 JSON：${builtinPath}：${err.message}。确认 ZCode App 安装完整`, 2);
  }
  if (revision == null) {
    throw new ExecutorError(`内置 provider 文件没有顶层 revision：${builtinPath}。App 的文件格式可能变了，跑 zcode-executor doctor --offpeak 确认`, 2);
  }
  return formatBuiltinRevision(revision, builtinPath);
}

/**
 * 纯函数：provider/updateAccountConfig 的参数——把默认 entitled:false 的闲时条目标成可用
 * （参数形状 verified.md「闲时任务探针」2026-09-27 App 3.14.1 真机跑通）。
 * 回执形状 {receivedRevision, providerCount, status: 'received'|'unchanged'}（出处：ZCode 3.14.1 zcode.cjs 源码，schema DBi）。
 * 回执核对不了版本号：receivedRevision 永远原样返回请求里的 revision，basedOnZCodeBuiltinRevision 算错时
 * 回执照样是 received，真实表现是之后的回合报 provider 找不到。同一毫秒重复推送（revision 相同）回执
 * 可能是 unchanged，调用方不能当失败。
 */
export function buildOffPeakAccountConfig({ family, basedOnZCodeBuiltinRevision, now = Date.now() }) {
  const providerId = offPeakProviderId(family);
  if (!basedOnZCodeBuiltinRevision) {
    throw new ExecutorError('缺内置文件版本号（basedOnZCodeBuiltinRevision），CLI 会静默忽略整份账号配置。先用 builtinRevision() 算出来', 2);
  }
  return {
    revision: `zcode-executor-offpeak:${now}`,
    basedOnZCodeBuiltinRevision,
    providers: { [providerId]: { access: { type: 'zhipu-account', entitled: true } } },
    states: { [providerId]: { availability: 'available', entitled: true, current: true } },
  };
}

/**
 * 纯函数：闲时回合的 session/send 在 {sessionId, content} 之外要多带的参数
 * （verified.md「闲时任务探针」2026-09-27 App 3.14.1 端到端跑通的形状）。
 * reasoningLevel 为空不带 options（同 providers.mjs 的 buildModelSelection）。toolDenylist 在调用方列表上
 * 追加 CronCreate、OffPeakCreate 并去重。缺号、缺凭据、runType 不对，或 JWT / plan key 短于
 * MIN_SECRET_LENGTH（短到 scrubValues 不抹，落盘就漏）抛 ExecutorError(2)。
 */
export function buildOffPeakSendParams({ family, modelId, reasoningLevel, jwt, planKey, ticketId, offPeakId, runType = 'init', toolDenylist = [] }) {
  const providerId = offPeakProviderId(family);
  if (runType !== 'init' && runType !== 'resume') {
    throw new ExecutorError(`闲时回合的 runType 只能是 init 或 resume，收到 ${runType}`, 2);
  }
  for (const [name, value] of Object.entries({ modelId, jwt, planKey, ticketId, offPeakId })) {
    if (!value) throw new ExecutorError(`闲时回合缺 ${name}，发不出去。先取号并确认 ZCode App 已登录`, 2);
  }
  for (const [name, value] of Object.entries({ jwt, planKey })) {
    if (String(value).length < MIN_SECRET_LENGTH) {
      throw new ExecutorError(`闲时回合的 ${name} 不到 ${MIN_SECRET_LENGTH} 个字符，不像真凭据，也没法在落盘时抹掉。确认 ZCode App 登录状态`, 2);
    }
  }
  const modelSelection = { providerId, modelId };
  if (reasoningLevel) modelSelection.options = { reasoningLevel };
  return {
    modelSelection,
    modelExecution: {
      selectionScope: 'execution',
      memoryExtraction: 'skip',
      requestAuth: {
        apiKey: jwt,
        headers: { Authorization: `Bearer ${jwt}`, 'X-Coding-Plan-Api-Key': planKey, 'X-Off-Peak-Ticket-ID': ticketId },
      },
      subagents: { foregroundModel: 'submission', background: 'deny' },
    },
    offPeakTaskId: offPeakId,
    offPeakRunType: runType,
    toolDenylist: [...new Set([...toolDenylist, ...OFFPEAK_DENIED_TOOLS])],
  };
}
