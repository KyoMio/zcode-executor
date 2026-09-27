// 本文件负责：闲时内部接口的健康检查（工作流层，SPEC-offpeak F，decisions D20）——doctor 第 ⑤ 项与
// `doctor --offpeak` 共用的 runOffPeakCheck。按凭据 → 内置条目 → 服务器约定 → 全链路四层依次查，遇到第一个
// 不符的层就停，结论归成四态：ok / changed（App 的内部接口变了）/ unavailable（暂时不可用）/ not-applicable（不适用）。
// 全程零额度：服务器层只查资格和用假号查排位，不取号；全链路层用假号发一回合，请求在服务器侧就被拒（3104）。
// 不负责：排版与退出码（lib/cli/doctor.mjs）、取号与 runner 的闲时部分、凭据解密细节（lib/credentials.mjs）。
// 和谁打交道：lib/credentials.mjs、lib/offpeak.mjs（服务器客户端）、lib/models.mjs（普通 provider 的选法同 doctor ③）、
// 协议层 lib/appserver.mjs、lib/session.mjs、lib/providers.mjs、lib/offpeak-provider.mjs。要起 app-server，所以不放外壳。
//
// 真机事实（verified.md 闲时任务探针（2026-09-27），App 3.14.1）：假号 1000000000000000000 查排位回 not_found；
// 推好授权后用它发闲时回合，turn.failed、code '3104'（off-peak ticket is invalid），CLI stderr 打一段 ProviderBusinessError；
// 没推授权或版本号算错时 code 是 provider_not_found；deferred 会话一发回合就留进 CLI 的会话库。
//
// 安全边界（RULES §8）：JWT 与 key 只进服务器请求头、JSON-RPC 参数与 secrets 抹除名单；返回值里的文案与转打的 zcode stderr
// 都按值抹过。临时目录（事件与会话 cwd）与个人 provider 文件在 finally 里删。
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
// 期望值照 SPEC-offpeak F 的表；接口前缀 /api/v1/off-peak 见 verified.md 闲时任务探针（2026-09-27）「服务器与鉴权」行
const OFFPEAK_BASE_URL = 'https://zcode.z.ai/api/v1/off-peak/anthropic';
const CHECK_OFFPEAK_ID = 'offpeak-doctor-check';
const CHECK_TITLE = 'zcode-executor doctor 闲时自检';
const CHECK_TEXT = 'Reply with exactly: ok';
const TURN_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const STDERR_TAIL = 50;
const EXPECT_CHAIN = `假号 ${FAKE_TICKET} 的闲时回合以 turn.failed 结束，错误码 3104`;
// 权宜：CLI 的 toolDenylist 按确切工具名比对，没有「禁用全部」的写法（zcode.cjs 3.14.1 源码），这里列出源码里注册的
// 内置工具名，未验证；App 加了新工具要补。假号回合在模型请求前就被拒，本来也跑不到工具，这是第二道保险
const SELF_CHECK_DENIED_TOOLS = [
  'Agent', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoRead', 'TodoWrite', 'Skill',
  'CronCreate', 'CronDelete', 'CronList', 'CronUpdate', 'OffPeakCreate', 'OffPeakList', 'SendMessage', 'Workflow',
];
// 暂时性失败的判据。权宜：取值出自 zcode.cjs 3.14.1 源码，未验证——turn.failed 的 payload.error.attribution.reason
// 取 CLI 失败原因表的值，其中这几个是 CLI 自己会退避重试的（限流、过载、5xx、网络、超时、闲时排队）；
// error.code 的 model_rate_limited / model_request_timeout 是 CLI 模型错误码表里限流与超时两项。真机撞见别的再补
const TRANSIENT_REASONS = new Set([
  'rate_limited', 'provider_overloaded', 'server_error', 'network_error', 'timeout', 'stream_idle_timeout', 'stale_connection', 'offpeak_queued',
]);
const TRANSIENT_CODES = new Set(['model_rate_limited', 'model_request_timeout']);

/**
 * 从 zcode.cjs 位置推 App 版本：<App>.app/Contents/Resources/glm/zcode.cjs → <App>.app/Contents/Info.plist。推不出来返回 null。
 * 权宜：布局与 CFBundleShortVersionString 是 2026-09-27 本机 App 3.14.1 看到的，未记进 verified.md；只影响提示行。
 */
function appVersionOf(zcodePath) {
  try {
    const plist = readFileSync(path.resolve(path.dirname(zcodePath), '../../Info.plist'), 'utf8');
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null;
  } catch {
    return null; // 不是 macOS 的 App 布局（Linux、ZCODE_BIN 指别处）：版本未知，只影响提示行
  }
}

const changed = (layer, expected, actual, logid = null) => ({ state: 'changed', layer, expected, actual, logid });

// 对端明确拒了：JSON-RPC 错误的 details 带 data 键（lib/appserver.mjs 的响应配对）；超时、进程退出的 details 没有
const isRpcRejection = (err) => err instanceof ExecutorError && err.details !== null && typeof err.details === 'object' && 'data' in err.details;

/**
 * 跑一遍闲时自检。opts 全部可注入（测试用）：env（缺省 process.env，定位 zcode、内置文件、凭据、闲时服务地址都按它）、
 * zcodePath、fetchImpl、origin、credentialsPath、config（插件配置，普通 provider 的选法同 doctor ③）、turnTimeoutMs、
 * writeStderr（全链路结论不是 ok 时转打 zcode 子进程 stderr 用，缺省写本进程 stderr）、
 * throwOnBadOrigin（缺省 true：闲时服务地址不合法直接抛 ExecutorError；false 时归 unavailable，不带参数的 doctor 用）。
 * 返回 { state, layer, expected, actual, reason, logid, appVersion, verifiedAppVersion }；state 为 ok 时 layer 为 null，
 * changed 时 expected / actual 写明期望与实际，unavailable / not-applicable 时 reason 写原因。
 */
export async function runOffPeakCheck(opts = {}) {
  const { env = process.env, zcodePath, writeStderr = (line) => process.stderr.write(`${line}\n`) } = opts;
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
  const result = await check({ ...opts, env, zcode, zcodeError, writeStderr });
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

async function check(opts) {
  const { env, zcode, zcodeError, fetchImpl, origin, credentialsPath, throwOnBadOrigin = true } = opts;
  // 1. 凭据：readOffPeakAuth 的 kind 就是结论
  const auth = readOffPeakAuth({ credentialsPath, env });
  if (auth.error) {
    if (auth.kind === 'changed') return changed('credentials', '凭据文件能解出 JWT 与个人版 Coding Plan key', auth.error);
    return { state: auth.kind, layer: 'credentials', reason: auth.error };
  }
  // 没装 App：闲时本来就用不了
  if (!zcode) return { state: 'not-applicable', layer: 'builtin', reason: `没装 ZCode App：${zcodeError}` };

  // 2. 内置条目。zcode 在而内置文件不在，是 App 换了目录布局
  let builtinPath;
  try {
    builtinPath = builtinProviderConfigPath(zcode, { builtinFile: env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '' });
  } catch (err) {
    if (!(err instanceof ExecutorError)) throw err;
    return changed('builtin', 'zcode.cjs 旁边的 ../config/provider/zcode-builtin.json 存在', err.message);
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
  let server;
  try {
    server = createOffPeakClient({ origin, auth, fetchImpl, env });
  } catch (err) {
    // 地址不合法是用户配置错，不是接口状态；不带参数的 doctor 不让它打断 ①–④ 的输出
    if (throwOnBadOrigin || !(err instanceof ExecutorError)) throw err;
    return { state: 'unavailable', layer: 'server', reason: `闲时服务地址配置错误：${err.message}` };
  }
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

  // 4. 全链路。没见过的失败重跑一次，仍不符才算接口变了（SPEC-offpeak F「补充分类」）
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
      toolDenylist: SELF_CHECK_DENIED_TOOLS,
    });
  } catch (err) {
    if (!(err instanceof ExecutorError)) throw err;
    return changed('credentials', '凭据文件解出的 JWT 与 key 形状正常', err.message); // 太短一类，App 的凭据格式可能变了
  }
  const chainOpts = { ...opts, auth, builtin, builtinPath, sendParams };
  let attempt = await runChain(chainOpts);
  if (attempt.retry) attempt = await runChain(chainOpts);
  const { result, stderrLines } = attempt;
  const final = attempt.retry ? changed('chain', EXPECT_CHAIN, `${result.actual}（重跑一次仍然这样）`) : result;
  // zcode 的 stderr 结论是 ok 时丢弃：假号回合的 ProviderBusinessError 一打几十行，挂在 cron 上天天发邮件
  if (final.state !== 'ok') for (const line of stderrLines.slice(-STDERR_TAIL)) opts.writeStderr(line);
  return final;
}

/** 回合结局 → 结论；retry:true 表示没见过的失败，要重跑一次全链路。 */
function classifyTurn(turn, secrets) {
  if (turn.outcome === 'failed' && turn.errorCode === '3104') return { result: { state: 'ok' } };
  if (turn.outcome === 'timeout') return { result: { state: 'unavailable', layer: 'chain', reason: `闲时自检回合没结束就超时了：${turn.reason}` } };
  if (turn.outcome === 'exited') return { result: { state: 'unavailable', layer: 'chain', reason: turn.reason } };
  const actual = `outcome ${turn.outcome}，错误码 ${turn.errorCode ?? '无'}${turn.errorReason ? `，原因 ${turn.errorReason}` : ''}`
    + `${turn.reason ? `：${scrubValues(turn.reason, secrets)}` : ''}`;
  const code = turn.errorCode ?? '';
  if (turn.outcome === 'done' || code === 'provider_not_found' || (/^31\d\d$/.test(code) && code !== '3105')) {
    return { result: changed('chain', EXPECT_CHAIN, actual) };
  }
  if (turn.outcome === 'failed' && (code === '3105' || TRANSIENT_CODES.has(code) || TRANSIENT_REASONS.has(turn.errorReason))) {
    return { result: { state: 'unavailable', layer: 'chain', reason: `闲时自检回合遇到暂时性失败（${actual}）` } };
  }
  return { result: changed('chain', EXPECT_CHAIN, actual), retry: true };
}

/**
 * 全链路跑一次：普通 provider 起 app-server → 推授权 → deferred 会话 → 假号发一回合 → 改标题 → close。
 * 返回 { result, retry?, stderrLines }；stderrLines 是这次 zcode 子进程的 stderr（已按 secrets 抹过），由调用方决定打不打。
 */
async function runChain({ env, zcode, config, credentialsPath, turnTimeoutMs = TURN_TIMEOUT_MS, auth, builtin, builtinPath, sendParams }) {
  const stderrLines = [];
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'zcode-executor-offpeak-check-'));
  let providerFile = null;
  let client = null;
  let sessionId = null;
  let secrets = [auth.jwt, auth.planKey];
  const done = (outcome) => ({ ...outcome, result: scrubResult(outcome.result, secrets), stderrLines });
  try {
    const resolved = await resolveModels({ config, configPath: env.ZCODE_CONFIG_PATH, env, zcodePath: zcode, credentialsPath });
    const { provider } = resolved;
    const fast = resolved.fast ?? resolved.strong; // registry 已滤掉没有模型的 provider，两档不会同时为空
    const level = reasoningLevelFor(thoughtLevelFor(fast, 'high'), provider.models.find((m) => m.modelId === fast.ref.modelId));
    secrets = [...secrets, ...resolved.registry.providers.map((p) => p.apiKey?.value).filter(Boolean)];
    providerFile = writePersonalProviderFile(provider);
    client = await AppServerClient.spawn({
      cwd: tempDir,
      zcodePath: zcode,
      env,
      secrets,
      personalProviderFile: providerFile.path,
      providerAuth: (id) => (id === EXECUTOR_PROVIDER_ID ? provider.apiKey?.value : undefined),
      onStderr: (line) => stderrLines.push(line), // 客户端转交前已按 secrets 抹过
    });

    const accountConfig = buildOffPeakAccountConfig({ family: auth.family, basedOnZCodeBuiltinRevision: formatBuiltinRevision(builtin.revision, builtinPath) });
    let reply;
    try {
      reply = await client.request('provider/updateAccountConfig', accountConfig, { timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (err) {
      if (!isRpcRejection(err)) throw err;
      return done({ result: changed('chain', 'provider/updateAccountConfig 被接受', `被拒：${err.message}`) });
    }
    // 回执 revision 永远回显请求的（offpeak-provider.mjs），对不上说明回执约定变了；版本号算错要看下面的回合
    if (reply?.receivedRevision !== accountConfig.revision) {
      return done({ result: changed('chain', `updateAccountConfig 回执 receivedRevision 为 ${accountConfig.revision}`, `回执 ${JSON.stringify(reply)}`) });
    }

    const workspace = { workspacePath: tempDir, workspaceKey: tempDir };
    const created = await client.request(
      'session/create',
      { workspace, mode: 'build', persistence: 'deferred', titleGenerationEnabled: false, model: buildModelSelection(provider, fast.ref.modelId, level), thoughtLevel: level },
      { timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (typeof created?.session?.sessionId !== 'string') {
      return done({ result: changed('chain', 'session/create 回 {session:{sessionId}}', `回的是 ${JSON.stringify(created)?.slice(0, 300)}，拿不到 sessionId`) });
    }
    sessionId = created.session.sessionId;
    const session = await attachSession({ client, sessionId, cwd: tempDir, eventsPath: path.join(tempDir, 'events.jsonl'), resume: false, secrets });
    let turn;
    try {
      turn = await session.send(CHECK_TEXT, { timeoutMs: turnTimeoutMs, extraParams: sendParams });
    } catch (err) {
      if (!isRpcRejection(err)) throw err;
      return done({ result: changed('chain', EXPECT_CHAIN, `session/send 被拒：${err.message}`) });
    }
    // 权宜：每跑一次全链路，zcode 命令行的会话库里多一条自检会话（verified.md 闲时任务探针（2026-09-27）：deferred 会话
    // 发过回合就持久化，v4 deleteSession 只关不删；App 任务列表看不到）。起个好认的标题；嫌多时改成复用同一条自检会话。
    // renameSession 出自 zcode.cjs 3.14.1 源码（调 setCustomSessionTitle），未验证；改名失败不影响结论
    try {
      await client.command(sessionId, 'renameSession', { title: CHECK_TITLE }, { timeoutMs: 5000 });
    } catch (err) {
      stderrLines.push(`doctor: 自检会话改标题失败：${err.message}`);
    }
    return done(classifyTurn(turn, secrets));
  } catch (err) {
    if (!(err instanceof ExecutorError)) throw err;
    // 选不出普通 provider、起不来 app-server、建会话被拒或超时、中途退出：doctor ②③ 会另报，这里只说暂时做不了
    return done({ result: { state: 'unavailable', layer: 'chain', reason: err.message } });
  } finally {
    if (client && sessionId !== null) {
      try {
        await client.request('session/close', { sessionId }, { timeoutMs: 5000 });
      } catch {
        // 收场尽力而为：进程下一步就关
      }
    }
    if (client) await client.close();
    providerFile?.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// 结论里的文案按值抹掉凭据（对端拒绝的原话、回合 reason 都可能回显参数）
function scrubResult(result, secrets) {
  const out = { ...result };
  for (const k of ['expected', 'actual', 'reason']) {
    if (typeof out[k] === 'string') out[k] = scrubValues(out[k], secrets);
  }
  return out;
}
