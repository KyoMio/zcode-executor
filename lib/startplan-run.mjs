// 本文件负责：runner 的 start plan 部分（decisions D21）——createStartPlanRunner：
// 队列头是 start plan 项时读一次凭据（peek，给 secrets 与 providerAuth 用）、
// 推 provider/updateAccountConfig 并拼 send 额外参数（prepareSend）。
// 不负责：send --start-plan 的前置检查（lib/startplan-send.mjs）、命令行解析与打印（lib/cli/send.mjs）、
// runner 的其余一生（lib/run.mjs 只在几处调这里）、授权配置与 send 参数的形状（协议层 lib/startplan-provider.mjs）、
// 凭据解密（lib/credentials.mjs）。start plan 没有号：没有等号、重取与结算（那是闲时的事，lib/offpeak-run.mjs）。
// 和谁打交道：lib/run.mjs（调用方）、lib/credentials.mjs、lib/startplan-provider.mjs、lib/offpeak-send.mjs
// （复用 builtinPathFor）、lib/queue.mjs、lib/runs.mjs、lib/registry.mjs、lib/tiers.mjs。
//
// 安全边界（RULES §8，D21）：JWT 只进内存、providerAuth 的 JSON-RPC 应答与 secrets 抹除名单
// （secrets() 交给 AppServerClient.spawn 与 attachSession）；事件、错误文案、任何落盘文件里都不带。
// JWT 不进 send 参数——start plan 的鉴权由宿主应答反向请求 interaction/requestProviderRuntimeHeaders。
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';
import { readStartPlanAuth } from './credentials.mjs';
import { buildStartPlanAccountConfig, buildStartPlanSendParams } from './startplan-provider.mjs';
import { builtinPathFor } from './offpeak-send.mjs';
import { builtinRevision } from './offpeak-provider.mjs';
import { nextQueueFile } from './queue.mjs';
import { appendEvent, readJsonOrNull, removeFileIfExists, runsDirOf, writeEndedLast } from './runs.mjs';
import { updateSession } from './registry.mjs';
import { reasoningLevelFor } from './tiers.mjs';

const REQUEST_TIMEOUT_MS = 20_000;

const now = () => new Date().toISOString();

/**
 * runner 的 start plan 部分（decisions D21）。每个 runner 建一个；run.mjs 在外层拉连接前 peek 一次队列头，
 * 是 start plan 项就把 JWT 放进这条连接的 secrets 与 providerAuth（按 providerId 答
 * {headersApplied:true, requestAuth:{apiKey:<JWT>}}，形状出处：App 宿主
 * createAccountProviderRequestAuthService.resolveCurrent 2026-09-29 对照）。普通队列项不经过这里的任何方法。
 */
export function createStartPlanRunner({ home, sessionId, env = process.env }) {
  const dir = runsDirOf(home, sessionId);
  const eventsPath = path.join(dir, 'events.jsonl');
  let auth = null; // peek 之后：{family, jwt, providerId} 或 {providerId, error}（凭据在 send 前置检查后又消失了）
  const event = (type, extra) => appendEvent(eventsPath, { type, at: now(), ...extra });

  /** start plan 项按 failed 结束（同 lib/offpeak-run.mjs 的 end/fail：写 last.json、事件、登记簿，出队）。 */
  async function fail(queueFile, item, reason) {
    writeEndedLast(dir, { outcome: 'failed', reason, text: item.text, task: item.task });
    updateSession(home, sessionId, { lastOutcome: 'failed' });
    appendEvent(eventsPath, { type: 'executor.result', at: now(), outcome: 'failed', reason });
    removeFileIfExists(queueFile);
  }

  return {
    /**
     * 外层拉连接前调（run.mjs）：队列头是 start plan 项就读一次凭据。返回是否需要 start plan 接线。
     * 凭据读不出也照记（error）：连接照起，这条投递在 prepareSend 按 failed 结束，报错说清怎么办。
     * 权宜：凭据这个 runner 只读一次，后面排到的 start plan 项沿用——App 里重登换 JWT 要等下个连接；
     * JWT 没有已知的过期时间（decisions D20），够用。
     */
    peek(queueDir) {
      if (auth) return true;
      const head = existsSync(queueDir) ? nextQueueFile(queueDir) : null;
      const item = head ? readJsonOrNull(head) : null;
      const providerId = item?.startPlan?.providerId;
      if (!providerId) return false;
      const a = readStartPlanAuth({ env });
      auth = a.error ? { providerId, error: a.error } : { family: a.family, jwt: a.jwt, providerId };
      return true;
    },

    /** peek 读到的 JWT（没有为空数组）：交给 AppServerClient.spawn 与 attachSession 抹密。 */
    secrets() {
      return auth?.jwt ? [auth.jwt] : [];
    },

    /**
     * 客户端答反向请求 requestProviderRuntimeHeaders 的钩子（lib/appserver.mjs 的 providerAuth）：
     * 只认 peek 时的那个 start plan providerId，答 {apiKey: <JWT>}；其余 providerId 返回 undefined
     * （调用方对 undefined 回 headersApplied:false，回合立刻失败而不是等满 180 秒）。
     */
    providerAuth(providerId) {
      return auth?.jwt && providerId === auth.providerId ? auth.jwt : undefined;
    },

    /**
     * 连接起好后、session/send 之前：推 provider/updateAccountConfig 把内置 start plan 条目标成可用，
     * 拼 send 额外参数（modelSelection 逐回合改道 + execution 作用域）。记 executor.startplan.started。
     * 推送报错或回执 revision 对不上时这条按 failed 结束并出队，返回 null（回执 unchanged 不算失败）。
     */
    async prepareSend({ client, item, entry, providerObj, queueFile }) {
      if (!auth || auth.error || !item.startPlan || item.startPlan.providerId !== auth.providerId) {
        const why = auth?.error
          ? `start plan 凭据读不了：${auth.error}`
          : `队列项的 start plan 投递 ${item.startPlan?.providerId ?? '(缺 providerId)'} 与连接鉴权对不上，这条不跑`;
        await fail(queueFile, item, why);
        return null;
      }
      let extraParams;
      try {
        const accountConfig = buildStartPlanAccountConfig({ family: auth.family, basedOnZCodeBuiltinRevision: builtinRevision(builtinPathFor(env)) });
        const reply = await client.request('provider/updateAccountConfig', accountConfig, { timeoutMs: REQUEST_TIMEOUT_MS });
        if (reply?.receivedRevision !== accountConfig.revision) {
          throw new ExecutorError(`provider/updateAccountConfig 回执对不上：${JSON.stringify(reply)}`, 2);
        }
        extraParams = buildStartPlanSendParams({
          family: auth.family,
          modelId: entry.modelId,
          // 与普通投递建会话时同一算法（lib/run.mjs）
          reasoningLevel: reasoningLevelFor(entry.thoughtLevel, providerObj.models.find((m) => m.modelId === entry.modelId)),
        });
      } catch (err) {
        if (!(err instanceof ExecutorError)) throw err;
        await fail(queueFile, item, `start plan 授权没推成：${err.message}`);
        return null;
      }
      event('executor.startplan.started', { providerId: auth.providerId });
      return { extraParams };
    },
  };
}
