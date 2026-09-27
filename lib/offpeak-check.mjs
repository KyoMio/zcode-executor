// 本文件负责：闲时内部接口的健康检查（工作流层，SPEC-offpeak F，decisions D20）——doctor 第 ⑤ 项与
// `doctor --offpeak` 共用的 runOffPeakCheck。按凭据 → 内置条目 → 服务器约定 → 全链路四层依次查，遇到第一个
// 不符的层就停，结论归成四态：ok / changed（App 的内部接口变了）/ unavailable（暂时不可用）/ not-applicable（不适用）。
// 全程零额度：服务器层只查资格和用假号查排位，不取号；全链路层用假号发一回合，真机上请求在服务器侧就被拒（3104）。
// 不负责：排版与退出码（lib/cli/doctor.mjs）、取号与 runner 的闲时部分、凭据解密细节（lib/credentials.mjs）。
// 和谁打交道：lib/credentials.mjs、lib/offpeak.mjs（服务器客户端）、lib/models.mjs（普通 provider 的选法同 doctor ③）、
// 协议层 lib/appserver.mjs、lib/session.mjs、lib/providers.mjs、lib/offpeak-provider.mjs。要起 app-server，所以不放外壳。
//
// 真机事实（verified.md「闲时任务探针」2026-09-27，App 3.14.1）：假号 1000000000000000000 查排位回 not_found，
// 用它发闲时回合以 turn.failed 结束、code '3104'（off-peak ticket is invalid）；授权没推上或版本号算错时
// code 是 provider_not_found。App 版本在 <App>.app/Contents/Info.plist 的 CFBundleShortVersionString。
//
// 安全边界（RULES §8）：JWT 与 key 只进服务器请求头、JSON-RPC 参数与 secrets 抹除名单；返回值里的文案都来自
// 已按值抹过的错误或本文件自己拼的字符串，不含凭据。临时目录（事件与会话 cwd）与个人 provider 文件在 finally 里删。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { AppServerClient, builtinProviderConfigPath, findZcode } from './appserver.mjs';
import { attachSession } from './session.mjs';
import { buildAccountModelElement, buildModelSelection, EXECUTOR_PROVIDER_ID, writePersonalProviderFile } from './providers.mjs';
import { buildOffPeakAccountConfig, buildOffPeakSendParams, formatBuiltinRevision, offPeakProviderId } from './offpeak-provider.mjs';
import { readOffPeakAuth } from './credentials.mjs';
import { createOffPeakClient } from './offpeak.mjs';
import { resolveModels } from './models.mjs';
import { scrubValues } from './scrub.mjs';
import { reasoningLevelFor, thoughtLevelFor } from './tiers.mjs';
import { ExecutorError } from './errors.mjs';

/** 闲时路径真机验证过的 App 版本；doctor 在别的版本上多打一行提示。 */
export const OFFPEAK_VERIFIED_APP = '3.14.1';

const FAKE_TICKET = '1000000000000000000';
const OFFPEAK_BASE_URL = 'https://zcode.z.ai/api/v1/off-peak/anthropic';
const CHECK_OFFPEAK_ID = 'offpeak-doctor-check';
const TURN_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const EXPECT_CHAIN = `假号 ${FAKE_TICKET} 的闲时回合以 turn.failed 结束，错误码 3104`;

/** 从 zcode.cjs 位置推 App 版本：<App>.app/Contents/Resources/glm/zcode.cjs → <App>.app/Contents/Info.plist。推不出来返回 null。 */
function appVersionOf(zcodePath) {
  try {
    const plist = readFileSync(path.resolve(path.dirname(zcodePath), '../../Info.plist'), 'utf8');
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null; // 不是 macOS 的 App 布局（Linux、ZCODE_BIN 指别处）：版本未知，只影响提示行
  }
}

const changed = (layer, expected, actual, logid = null) => ({ state: 'changed', layer, expected, actual, logid });

// JSON-RPC 错误（对端明确拒了）details 里有 code；超时、进程退出没有——前者算接口变了，后者算暂时不可用
const isRpcRejection = (err) => err instanceof ExecutorError && err.details?.code !== undefined;

/**
 * 跑一遍闲时自检。opts 全部可注入（测试用）：env（缺省 process.env，定位 zcode、内置文件、凭据、闲时服务地址都按它）、
 * zcodePath、fetchImpl、origin、credentialsPath、config（插件配置，普通 provider 的选法同 doctor ③）、turnTimeoutMs。
 * 返回 { state, layer, expected, actual, reason, logid, appVersion, verifiedAppVersion }；state 为 ok 时 layer 为 null，
 * changed 时 expected / actual 写明期望与实际，unavailable / not-applicable 时 reason 写原因。
 * 闲时服务地址不合法（不是 https 也不是本机回环）照样抛 ExecutorError：那是用户配置错，不是接口状态。
 */
export async function runOffPeakCheck(opts = {}) {
  const { env = process.env, zcodePath } = opts;
  let zcode = zcodePath ?? null;
  let zcodeError = null;
  if (!zcode) {
    try {
      zcode = findZcode({ zcodeBin: env.ZCODE_BIN || '' }); // '' 不回落 process.env：env 是唯一来源
    } catch (err) {
      if (!(err instanceof ExecutorError)) throw err;
      zcodeError = err.message;
    }
  }
  const result = await check({ ...opts, env, zcode, zcodeError });
  return {
    layer: null,
    expected: null,
    actual: null,
    reason: null,
    logid: null,
    ...result,
    appVersion: zcode ? appVersionOf(zcode) : null,
    verifiedAppVersion: OFFPEAK_VERIFIED_APP,
  };
}

async function check({ env, zcode, zcodeError, fetchImpl, origin, credentialsPath, config, turnTimeoutMs = TURN_TIMEOUT_MS }) {
  // 1. 凭据：readOffPeakAuth 的 kind 就是结论
  const auth = readOffPeakAuth({ credentialsPath, env });
  if (auth.error) {
    if (auth.kind === 'changed') return changed('credentials', '凭据文件能解出 JWT 与个人版 Coding Plan key', auth.error);
    return { state: auth.kind, layer: 'credentials', reason: auth.error };
  }

  // 2. 内置条目
  const builtinFile = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '';
  if (!builtinFile && !zcode) return { state: 'unavailable', layer: 'builtin', reason: zcodeError };
  let builtinPath;
  try {
    builtinPath = builtinProviderConfigPath(zcode, { builtinFile });
  } catch (err) {
    if (!(err instanceof ExecutorError)) throw err;
    return { state: 'unavailable', layer: 'builtin', reason: err.message }; // doctor ① 另报
  }
  let builtin;
  try {
    builtin = JSON.parse(readFileSync(builtinPath, 'utf8'));
  } catch (err) {
    return changed('builtin', `内置 provider 文件是合法 JSON（${builtinPath}）`, err.message);
  }
  const providerId = offPeakProviderId(auth.family);
  const expectEntry = `${providerId} 存在，access.mode 为 off-peak，api.baseUrl 为 ${OFFPEAK_BASE_URL}，builtinModelIds 非空`;
  const rules = builtin?.config?.providerConfigRules?.providerRules;
  const rule = Array.isArray(rules) ? rules.find((r) => r?.providerId === providerId) : undefined;
  if (!rule) return changed('builtin', expectEntry, `内置文件里没有 ${providerId}（${builtinPath}）`);
  const modelIds = rule.config?.builtinModelIds;
  if (rule.config?.access?.mode !== 'off-peak' || rule.config?.api?.baseUrl !== OFFPEAK_BASE_URL || !Array.isArray(modelIds) || modelIds.length === 0) {
    const actual = `access.mode=${JSON.stringify(rule.config?.access?.mode)}，api.baseUrl=${JSON.stringify(rule.config?.api?.baseUrl)}，builtinModelIds=${JSON.stringify(modelIds)}`;
    return changed('builtin', expectEntry, actual);
  }
  if (builtin.revision == null) return changed('builtin', '内置文件有顶层 revision（闲时授权的版本号靠它）', `没有 revision（${builtinPath}）`);

  // 3. 服务器约定：查资格 + 假号查排位。quota 说明约定照旧，只是额度用完，按符合处理
  const server = createOffPeakClient({ origin, auth, fetchImpl, env });
  const fromClientError = (err, expected) => {
    const kind = err?.details?.kind;
    if (kind === undefined) throw err;
    if (kind === 'quota') return null;
    const logid = err.details.logid ?? null;
    if (kind === 'changed') return changed('server', expected, err.message, logid);
    return { state: kind, layer: 'server', reason: err.message, logid };
  };
  try {
    await server.availability();
  } catch (err) {
    const r = fromClientError(err, 'GET /ticket/availability 回 {code:0, data.can_take_number 为布尔值}');
    if (r) return r;
  }
  const expectStatus = `POST /ticket/status 查假号 ${FAKE_TICKET}，state 为 not_found`;
  try {
    const status = await server.status([FAKE_TICKET]);
    const ticket = status.tickets.find((t) => t.ticketId === FAKE_TICKET);
    if (ticket?.state !== 'not_found') {
      return changed('server', expectStatus, ticket ? `state 为 ${ticket.state}` : '返回里没有这个号', status.logid ?? null);
    }
  } catch (err) {
    const r = fromClientError(err, expectStatus);
    if (r) return r;
  }

  // 4. 全链路：普通 provider 起 app-server → 推授权 → deferred 会话 → 假号发一回合 → 期望 3104
  const offPeakModel = buildAccountModelElement(modelIds[0], builtin.config?.modelConfigRules?.modelRules ?? []);
  let sendParams;
  try {
    sendParams = buildOffPeakSendParams({
      family: auth.family,
      modelId: offPeakModel.modelId,
      reasoningLevel: offPeakModel.reasoning?.defaultLevel,
      jwt: auth.jwt,
      planKey: auth.planKey,
      ticketId: FAKE_TICKET,
      offPeakId: CHECK_OFFPEAK_ID,
    });
  } catch (err) {
    if (!(err instanceof ExecutorError)) throw err;
    return changed('credentials', '凭据文件解出的 JWT 与 key 形状正常', err.message); // 太短一类，App 的凭据格式可能变了
  }
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'zcode-executor-offpeak-check-'));
  let providerFile = null;
  let client = null;
  let sessionId = null;
  let secrets = [auth.jwt, auth.planKey];
  try {
    const resolved = await resolveModels({ config, configPath: env.ZCODE_CONFIG_PATH, env, zcodePath: zcode ?? undefined, credentialsPath });
    const { provider } = resolved;
    const fast = resolved.fast ?? resolved.strong; // registry 已滤掉没有模型的 provider，两档不会同时为空
    const level = reasoningLevelFor(thoughtLevelFor(fast, 'high'), provider.models.find((m) => m.modelId === fast.ref.modelId));
    secrets = [...secrets, ...resolved.registry.providers.map((p) => p.apiKey?.value).filter(Boolean)];
    providerFile = writePersonalProviderFile(provider);
    client = await AppServerClient.spawn({
      cwd: tempDir,
      zcodePath: zcode ?? undefined,
      env,
      secrets,
      personalProviderFile: providerFile.path,
      providerAuth: (id) => (id === EXECUTOR_PROVIDER_ID ? provider.apiKey?.value : undefined),
    });

    const accountConfig = buildOffPeakAccountConfig({ family: auth.family, basedOnZCodeBuiltinRevision: formatBuiltinRevision(builtin.revision, builtinPath) });
    let reply;
    try {
      reply = await client.request('provider/updateAccountConfig', accountConfig, { timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (err) {
      if (!isRpcRejection(err)) throw err;
      return changed('chain', 'provider/updateAccountConfig 被接受', `被拒：${err.message}`);
    }
    // 回执 revision 永远回显请求的（offpeak-provider.mjs），对不上说明回执约定变了；版本号算错要看下面的回合
    if (reply?.receivedRevision !== accountConfig.revision) {
      return changed('chain', `updateAccountConfig 回执 receivedRevision 为 ${accountConfig.revision}`, `回执 ${JSON.stringify(reply)}`);
    }

    const workspace = { workspacePath: tempDir, workspaceKey: tempDir };
    const created = await client.request(
      'session/create',
      { workspace, mode: 'build', persistence: 'deferred', titleGenerationEnabled: false, model: buildModelSelection(provider, fast.ref.modelId, level), thoughtLevel: level },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    sessionId = created.session.sessionId;
    const session = await attachSession({ client, sessionId, cwd: tempDir, eventsPath: path.join(tempDir, 'events.jsonl'), resume: false, secrets });
    let turn;
    try {
      turn = await session.send('zcode-executor doctor 闲时自检', { timeoutMs: turnTimeoutMs, extraParams: sendParams });
    } catch (err) {
      if (!isRpcRejection(err)) throw err;
      return changed('chain', EXPECT_CHAIN, `session/send 被拒：${err.message}`); // send 已按 secrets 抹过
    }
    if (turn.outcome === 'failed' && turn.errorCode === '3104') return { state: 'ok' };
    if (turn.outcome === 'timeout') return { state: 'unavailable', layer: 'chain', reason: `闲时自检回合 ${turnTimeoutMs / 1000} 秒内没结束` };
    if (turn.outcome === 'exited') return { state: 'unavailable', layer: 'chain', reason: turn.reason };
    const actual = `outcome ${turn.outcome}，错误码 ${turn.errorCode ?? '无'}${turn.reason ? `：${scrubValues(turn.reason, secrets)}` : ''}`;
    return changed('chain', EXPECT_CHAIN, actual);
  } catch (err) {
    if (!(err instanceof ExecutorError)) throw err;
    // 选不出普通 provider、起不来 app-server、建会话失败、请求超时：doctor ②③ 会另报，这里只说暂时做不了
    return { state: 'unavailable', layer: 'chain', reason: scrubValues(err.message, secrets) };
  } finally {
    if (client && sessionId !== null) {
      try {
        await client.request('session/close', { sessionId }, { timeoutMs: 5000 });
      } catch {
        // 收场尽力而为：deferred 会话不留记录，进程下一步就关
      }
    }
    if (client) await client.close();
    providerFile?.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  }
}
