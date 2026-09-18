// test/mock-appserver.mjs —— stdio 上说 app-server 协议的假进程（整个项目的测试接缝）。
// 由剧本 JSON 驱动，收到的每条消息追加到记录文件（MOCK_APPSERVER_RECORD，一行一条 JSON），
// apiKey 值写盘前抹成 "[REDACTED]"（T1.3b 第 6 条，RULES §8 永不落盘）。
// 日志一律 stderr（`mock: ` 前缀）。stdin EOF 后退出码 0。信封无 jsonrpc 字段；未知方法回 -32601。
// 目标是「真机行为的复刻」：每个默认返回形状旁注明出处（verified.md / verified.md / 探针实测日期）。
// 复刻的是 ZCode App 3.12.2 的 app-server（verified.md「3.12.2 直连探针实测」与 docs/reference/zcode-app-server-protocol.md「3.12.2 变化」，2026-09-18）：provider 表不再由
// 客户端推，而是启动时从两个环境变量指的文件读；session/create 用 model、generateText 用 selection；
// 每次模型请求前先向客户端要一次 provider 运行时头（interaction/requestProviderRuntimeHeaders）。
// 不负责：模拟客户端（那边是 lib/appserver.mjs）、性能或时序的真实复刻（sleep 都是假等待）、
// 参数的全量 schema 校验（只校验测试用得到的字段）。
//
// 环境变量：
//   ZCODE_BUILTIN_PROVIDER_CONFIG_FILE   内置 provider 配置路径。缺失或文件不存在 → stderr 打真机
//                                        原文「无法定位 CLI ZCode Built-in Provider Config：…」并 exit(1)
//                                        （verified.md「3.12.2 直连探针实测」表第 1 行）。内容不读
//   ZCODE_PERSONAL_PROVIDER_CONFIG_FILE  个人 provider 文件路径（形状见 docs/reference/zcode-app-server-protocol.md「3.12.2 变化」）。
//                                        模型表从这里来：providerRules[*].providerId ×
//                                        config.personalModelIds；config.access.apiKey 计入抹密值。
//                                        缺失或读不出 → 表为空（不退出；真机默认读
//                                        ~/.zcode/v2/provider_config.json，本机那份就是空表）
//   MOCK_APPSERVER_SCRIPT  剧本 JSON 路径（字段全可选，见下）；
//                          给了但读不出/JSON 坏 → stderr 一行 + exit(1)
//   MOCK_APPSERVER_RECORD  记录文件路径，每条收到的消息一行 JSON
//   MOCK_APPSERVER_VERSION --version 打印的版本，默认 0.16.5（3.12.2 真机仍打 0.16.5，版本号区分不了新旧）
//
// 剧本字段（全可选）：
//   errors:            { 方法名: {code, message, data?} }  某方法直接回错误
//   exitAfter:         方法名                              处理完这个方法就 process.exit(3)
//   junkStdoutLine:    "…"                                 应答第一个请求前往 stdout 打一行非 JSON
//   hangMethods:       [方法名]                            这些方法收到后不应答（测请求超时）
//   ignoreEof:         true                                stdin EOF 不退出（测 close 的 SIGKILL 路径）
//   resendIntervalMs:  1000                                反向请求未答时的重发间隔
//   models:            [...]                               整体覆盖 create settings.model.available
//                                                          （形状同真机条目：{ref:{providerId,modelId},
//                                                          label?, reasoning?:{levels,defaultLevel}}）；
//                                                          create/generateText 的模型存在性也按它查
//   serverRequests:    [{method, params}]                  启动后主动发这些反向请求
//   serverRequestsDelayMs: 0                               这些请求延后多少毫秒再发（留时间给 attach）
//   strayEvents:       [{sessionId, type?, params?, method?}]  回合结束后发的事件通知；
//                                                          method 缺省 session/event，sessionId 可指别人的，params 透传
//   turns:             [{ events, permission, permissions, question, hang, fail }]
//                                                          第 n 次 session/send 用第 n 个 turn
//     events:     [{type, payload, delayMs?}]              turn.started 之后依次推的 session/event
//     permission: {toolName, input, reason, options?}     发 interaction/requestPermission 并等应答；
//     permissions: [同上, …]                              一回合连续多次挂起（T2.6 真机形状），依序发
//     question:   {questions, schema?, toolCallId?}       发 interaction/requestUserInput 并等应答；
//                                                         schema/toolCallId 透传，可造 ExitPlanMode 形状
//     completeDelayMs: 800                                    应答之后到 completed 之间睡多少毫秒（T2.8）
//     hang:       true                                    不再推任何事件
//     fail:       {code, message}                         推 turn.failed（payload.error）
//     都没有                                              最后推 turn.completed
//   generateText:      { replies: [文本…] }                workspace/generateText 按调用顺序回这些
//                                                         文本（T3.2），用完就循环最后一条；
//                                                         应答前先发 requestProviderRuntimeHeaders
//   generateTextErrors: { "<第 n 次调用>": {code, message} }  那一次调用直接回错误（1 起）
//   generateTextDelayMs: 0                                  每次 generateText 延后多少毫秒再应答
//                                                         （配 review.timeoutMs 测超时取消）
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const version = process.env.MOCK_APPSERVER_VERSION ?? '0.16.5';

if (process.argv.includes('--version')) {
  console.log(version);
  process.exit(0);
}

// verified.md「3.12.2 直连探针实测」表第 1 行（2026-09-18）：新 CLI 启动时自己找内置 provider 配置，只看 zcode.cjs 同目录的
// provider/ 和往上五级的 config/provider/（打包后算成根目录 /config/…），找不到打这句就退。
// 环境变量给了就原样采用。stderr 原文照抄（客户端转发时再加 zcode: 前缀）
const builtinFile = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
if (!builtinFile || !existsSync(builtinFile)) {
  const beside = path.join(path.dirname(process.argv[1]), 'provider', 'zcode-builtin.json');
  process.stderr.write(`无法定位 CLI ZCode Built-in Provider Config：${beside}, /config/provider/zcode-builtin.json\n`);
  process.exit(1);
}

const log = (msg) => process.stderr.write(`mock: ${msg}\n`);
// T1.3b 第 6 条：写记录前把见过的 apiKey 值抹成 "[REDACTED]"（默认开启，RULES §8 永不落盘）。
// 值来自个人文件的 access.apiKey（启动时读）和客户端答 requestProviderRuntimeHeaders 时给的
// requestAuth.apiKey；替换按整个带引号的 JSON 字符串做，记录行保持可 JSON.parse。
const secretValues = new Set();
function collectSecrets(msg) {
  const v = msg?.result?.requestAuth?.apiKey;
  if (v) secretValues.add(v);
}

// docs/reference/zcode-app-server-protocol.md「3.12.2 变化」：模型表 = 个人文件里每条 providerRules 的 providerId × personalModelIds。
// 读不出按空表（真机默认个人文件 ~/.zcode/v2/provider_config.json 就是 providerRules: []）
const personalProviders = [];
try {
  const personal = JSON.parse(readFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8'));
  for (const rule of personal?.config?.providerConfigRules?.providerRules ?? []) {
    personalProviders.push({ providerId: rule.providerId, modelIds: rule.config?.personalModelIds ?? [] });
    if (rule.config?.access?.apiKey) secretValues.add(rule.config.access.apiKey);
  }
} catch {
  // 缺失或读不出 = 空表，走到 create 时按「Provider Registry 中不存在 Model」拒
}
function redactSecretValues(text) {
  let out = text;
  for (const s of secretValues) out = out.split(JSON.stringify(s)).join('"[REDACTED]"');
  return out;
}
const record = (msg) => {
  const file = process.env.MOCK_APPSERVER_RECORD;
  if (!file) return;
  try {
    appendFileSync(file, `${redactSecretValues(JSON.stringify(msg))}\n`);
  } catch {
    // 记录文件写不了不影响协议行为，只在 stderr 提一句
    log(`record 写入失败：${file}`);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// T0.3c 第 3 条：剧本路径给了但读不出来，不能再静默变全默认——那会让测试测的是默认行为还以为在测剧本
let script = {};
if (process.env.MOCK_APPSERVER_SCRIPT) {
  try {
    script = JSON.parse(readFileSync(process.env.MOCK_APPSERVER_SCRIPT, 'utf8'));
  } catch (err) {
    log(`剧本读不出来 ${process.env.MOCK_APPSERVER_SCRIPT}：${err.message}`);
    process.exit(1);
  }
}

const RESEND_MS = script.resendIntervalMs ?? 1000;
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const respond = (id, result) => send({ id, result });
const respondError = (id, code, message, data) => {
  const error = data === undefined ? { code, message } : { code, message, data };
  send({ id, error });
};

// ---------- 状态 ----------
let nextId = 1;
let junkSent = false;
const state = {
  workspace: undefined, // 最近一次见到的 workspace
  sessions: [],
  deferredIds: new Set(), // persistence:'deferred' 建的会话：真机 session/list 不列（探针 2026-09-18）
  seq: 0, // session/event 单调序号
  sendCount: 0, // 第 n 个跑回合的 session/send 用第 n 个 turn（steer 不占）
  activeTurn: false, // 回合进行中：再收到的 session/send 按 steer 排队，不跑新回合
  generateTextCount: 0, // 第 n 次 workspace/generateText（T3.2：剧本按次序回，错误按次序插）
};
const pendingAnswers = new Map(); // 信封 id → 反向请求条目（存引用，见 askServer）

// ---------- 反向请求（未答每 RESEND_MS 重发，同一 requestId、新信封 id） ----------
// verified.md「app-server 协议」表「反向请求」一行（经 zcode-acp 实测 + server-requests.js）：
// 未答的反向请求每秒重发一次，同一 requestId、信封 id 每次不同
function askServer(method, params) {
  return new Promise((resolve) => {
    // 剧本给了 requestId 就用它（T1.2 排队用例要按 requestId 认请求），否则自己编
    const requestId = params.requestId ?? `mock_${nextId}`;
    // T0.3c 第 1 条：pendingAnswers 必须存同一个 entry 的引用。之前每次 fire 展开快照，
    // 快照里的 timer 是旧的，应答后 clearTimeout 清不掉真正的重发定时器，导致无限重发。
    const entry = { method, timer: null, done: false, validateAndResolve: null };
    const fire = () => {
      if (entry.done) return;
      const envelopeId = nextId++;
      pendingAnswers.set(envelopeId, entry);
      // 发出去的反向请求不进记录文件（那只记收到的），打 stderr 供测试计数
      log(`server-request ${method} envelope=${envelopeId} requestId=${requestId}`);
      send({ id: envelopeId, method, params: { ...params, requestId } });
      entry.timer = setTimeout(fire, RESEND_MS);
    };
    entry.validateAndResolve = (result) => {
      entry.done = true;
      clearTimeout(entry.timer);
      validateAnswer(method, result);
      resolve(result);
    };
    fire();
  });
}

function onAnswerMessage(msg) {
  const entry = pendingAnswers.get(msg.id);
  if (!entry || entry.done) return; // 迟到的重复应答，没人等了
  pendingAnswers.delete(msg.id);
  entry.validateAndResolve(msg.result);
}

// T0.3c 第 13 条，出处 verified.md「app-server 协议」表「审批」一行。形状不对只 warn 不拒收：
// mock 的职责是复刻真机的等待行为，应答内容合法性是调用方的测试断言
function validateAnswer(method, result) {
  const json = JSON.stringify(result ?? null);
  let ok = true;
  if (method === 'interaction/requestPermission') {
    ok = !!result && (result.decision === 'allow' || result.decision === 'deny');
  } else if (method === 'interaction/requestUserInput') {
    const accept = result?.action === 'accept' && result?.content != null && 'answers' in result.content;
    const decline = result?.action === 'decline' && typeof result.reason === 'string';
    ok = accept || decline;
  } else if (method === RUNTIME_HEADERS_METHOD) {
    ok = typeof result?.headersApplied === 'boolean';
  }
  if (!ok) log(`应答形状不对 ${method}: ${json}`);
}

// ---------- 默认形状 ----------
const RUNTIME_HEADERS_METHOD = 'interaction/requestProviderRuntimeHeaders';
const HEADERS_NOT_APPLIED = 'Provider runtime headers were not applied before model request attempt.';

// 真机 3.12.2 探针 2026-09-18：个人文件里的模型在 settings.model.available 里每条长这样——
// label 就是 modelId，providerLabel 就是 providerId，contextWindow 1000000、maxOutputTokens 128000，
// reasoning.levels 固定 low/high/max、defaultLevel max（GLM 5.3 系列），另有 properties（输入输出能力，
// 这里省略，没人用）。剧本 models 给了就整体覆盖
function availableModels() {
  if (script.models) return script.models;
  const out = [];
  for (const p of personalProviders) {
    for (const modelId of p.modelIds) {
      out.push({
        ref: { providerId: p.providerId, modelId },
        label: modelId,
        providerLabel: p.providerId,
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        reasoning: {
          levels: [
            { value: 'low', label: 'low' },
            { value: 'high', label: 'high' },
            { value: 'max', label: 'max' },
          ],
          defaultLevel: 'max',
        },
      });
    }
  }
  return out;
}

const findModel = (ref) =>
  availableModels().find((m) => m.ref.providerId === ref?.providerId && m.ref.modelId === ref?.modelId);

function modelLevels(models) {
  const levels = [];
  for (const m of models ?? []) {
    for (const l of m.reasoning?.levels ?? []) {
      if (!levels.some((x) => x.value === l.value)) levels.push({ value: l.value, label: l.label ?? l.value });
    }
  }
  return levels;
}

// 真机 3.12.2 探针 2026-09-18：create 的 settings 形状。
// - 带 model：model.current 回显 {providerId, modelId}，只有顶层 thoughtLevel 也给了才附
//   options.reasoningLevel（model.options 里的档位不回显）；thoughtLevel.current 同样只认顶层参数，
//   没给就没有这个键。
// - 不带 model：用表里第一个模型，档位取顶层 thoughtLevel，没给取 defaultLevel（max），两处都有值。
// - thoughtLevel 只有 available / current / enabled 三个键（3.11 的 defaultLevel 没了）。
// - 表为空又没给 model：current 缺失（verified.md「3.12.2 直连探针实测」「mock 复刻依据」「current 为空」）
function buildSettings(requestedThoughtLevel, requestedModel) {
  const available = availableModels();
  const levels = modelLevels(available);
  const defaultLevel = available[0]?.reasoning?.defaultLevel ?? levels[0]?.value;
  const chosen = requestedModel ? { providerId: requestedModel.providerId, modelId: requestedModel.modelId } : available[0]?.ref;
  const level = requestedThoughtLevel ?? (requestedModel ? undefined : defaultLevel);
  const current = chosen ? { ...chosen, ...(level ? { options: { reasoningLevel: level } } : {}) } : undefined;
  const settings = {
    mode: { current: 'build' },
    model: {
      available,
      current,
      lastUsed: chosen ? { ...chosen } : undefined,
    },
    permission: { mode: 'build' },
    thoughtLevel: {
      available: levels,
      current: level,
      enabled: levels.length > 0,
    },
  };
  if (current === undefined) delete settings.model.current;
  if (settings.model.lastUsed === undefined) delete settings.model.lastUsed;
  if (level === undefined) delete settings.thoughtLevel.current;
  return settings;
}

// verified.md「3.12.2 直连探针实测」表第 5 行（2026-09-18，宿主模式 headers port 无条件 shouldRefreshBeforeModelRequest）：
// 每次模型请求前向客户端要一次 provider 运行时头，等 {headersApplied, requestAuth?, errorMessage?}
// （zcode.cjs 里的应答 schema：headersApplied:true 必带 requestAuth:{apiKey?, headers?}，false 可带 errorMessage）。
// 未答按 RESEND_MS 重发（和其它反向请求一样走 askServer），真机是 180 秒超时，这里不复刻超时。
// params 形状照 docs/reference/zcode-app-server-protocol.md「3.12.2 变化」（从 zcode.cjs 3.12.2 源码读出，
// 待检查点 5 真机核；真机 schema 里 sessionId 必填，generateText 那条路用的是什么 sessionId 要等
// real-review 才知道，这里先不带）。客户端只依赖 providerId 与 requestId（去重键），其余字段是复刻不是契约。
// 返回 null 表示头应用上了；否则返回失败原因——zcode.cjs 用 errorMessage ?? 那句固定原文
async function requestRuntimeHeaders({ sessionId, modelSelection }) {
  const params = {
    requestId: `${sessionId ?? 'workspace'}:provider-runtime-headers:${randomUUID()}`,
    workspace: state.workspace,
    modelSelection,
    providerId: modelSelection.providerId,
    reason: 'model-request',
  };
  if (sessionId !== undefined) params.sessionId = sessionId;
  const answer = await askServer(RUNTIME_HEADERS_METHOD, params);
  // 只记 headersApplied，不把整个应答打到 stderr：requestAuth.apiKey 不该出现在任何日志里
  log(`runtimeHeaders answered: headersApplied=${answer?.headersApplied}`);
  if (answer?.headersApplied === true) return null;
  return typeof answer?.errorMessage === 'string' ? answer.errorMessage : HEADERS_NOT_APPLIED;
}

// ---------- 回合（剧本 turns） ----------
async function runTurn(sessionId) {
  const turn = script.turns?.[state.sendCount] ?? {};
  state.sendCount += 1;
  const ev = (type, payload) => {
    state.seq += 1;
    // docs/reference/zcode-app-server-protocol.md「Event Types」：session/event 通知形状
    send({ method: 'session/event', params: { sessionId, seq: state.seq, type, payload: payload ?? {} } });
  };
  ev('turn.started', {});
  // 会话的模型：create 时记下的；resume 进来的会话 mock 没建过，退到表里第一个（权宜：resume 不校验会话存在）
  const model = state.sessions.find((s) => s.sessionId === sessionId)?.model ?? availableModels()[0]?.ref
    ?? { providerId: 'zcode-unconfigured', modelId: 'missing-model' };
  const headersError = await requestRuntimeHeaders({ sessionId, modelSelection: model });
  if (headersError !== null) {
    // 层 5 的失败面：客户端没给可用的头，模型请求发不出去。payload.error.message 照 generateText 那条路
    // （errorMessage ?? 固定原文）；回合这条路真机没抓过（要花额度），code 也没有，先只带 message
    ev('turn.failed', { error: { message: headersError } });
    return;
  }
  for (const e of turn.events ?? []) {
    if (e.delayMs) await sleep(e.delayMs);
    ev(e.type, e.payload);
  }
  // T2.6 第 3 条：真机 build 档一回合会连续两次挂起（Write 后又 Bash/git），permissions 数组
  // 依序发；旧剧本字段 permission 等价于一项的数组
  for (const permission of turn.permissions ?? (turn.permission ? [turn.permission] : [])) {
    const answer = await askServer('interaction/requestPermission', {
      sessionId,
      toolCallId: `tool_${randomUUID().slice(0, 8)}`,
      toolName: permission.toolName,
      input: permission.input,
      reason: permission.reason,
      // 三项 options 及各自 response 照真机原文（verified.md「第一次真机投递」2026-09-07）：
      // allow_project 的 rules[].ruleContent 照工件取 input.file_path 或 input.command。
      // name 字段真机原文未记，自造（T0.3c 可选项）
      options: permission.options ?? [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once', response: { decision: 'allow', reason: 'Approved once' } },
        {
          optionId: 'allow_project',
          name: 'Always allow in this project',
          kind: 'allow_always',
          response: {
            decision: 'allow',
            permissionUpdates: [
              {
                behavior: 'allow',
                rules: [
                  { toolName: permission.toolName, ruleContent: permission.input?.file_path ?? permission.input?.command },
                ],
                type: 'addRules',
              },
            ],
            reason: 'Approved for this project',
          },
        },
        { optionId: 'deny', name: 'Deny', kind: 'deny', response: { decision: 'deny', reason: 'Denied' } },
      ],
    });
    log(`permission answered: ${JSON.stringify(answer)}`);
  }
  if (turn.question) {
    const params = { sessionId, questions: turn.question.questions };
    if (turn.question.schema !== undefined) params.schema = turn.question.schema; // T0.3c 第 12 条：透传可造 ExitPlanMode 形状
    if (turn.question.toolCallId !== undefined) params.toolCallId = turn.question.toolCallId;
    const answer = await askServer('interaction/requestUserInput', params);
    log(`question answered: ${JSON.stringify(answer)}`);
  }
  // T2.8：应答之后到 completed 之间留时间窗，让测试能在「挂起已消费、回合未结束」时起 follow
  if (turn.completeDelayMs) await sleep(turn.completeDelayMs);
  if (turn.hang) {
    log('turn hang：不再推任何事件');
    return;
  }
  if (turn.fail) {
    // docs/reference/zcode-app-server-protocol.md「turn.failed」：payload.error
    ev('turn.failed', { error: turn.fail });
    return;
  }
  ev('turn.completed', { resultType: 'success', usage: { totalTokens: 0 } });
  for (const stray of script.strayEvents ?? []) {
    state.seq += 1;
    const params = { sessionId: stray.sessionId, seq: state.seq, ...(stray.params ?? {}) };
    if (stray.type) params.type = stray.type;
    send({ method: stray.method ?? 'session/event', params });
  }
}

// ---------- 方法分发 ----------
function afterHandled(method) {
  if (script.exitAfter === method) {
    log(`exitAfter ${method}：process.exit(3)`);
    process.exit(3);
  }
}

function handleRequest(msg) {
  const { id, method } = msg;
  const params = msg.params ?? {};
  state.workspace = params.workspace ?? state.workspace;
  if (script.junkStdoutLine && !junkSent) {
    junkSent = true;
    process.stdout.write(`${script.junkStdoutLine}\n`);
  }
  const scriptedError = script.errors?.[method];
  if (scriptedError) {
    respondError(id, scriptedError.code, scriptedError.message, scriptedError.data);
    afterHandled(method);
    return;
  }
  if (script.hangMethods?.includes(method)) {
    log(`hang ${method}：不应答`);
    return;
  }

  switch (method) {
    case 'session/create': {
      // verified.md「3.12.2 直连探针实测」表第 3 行（2026-09-18）：strict schema，runtimeModel 没了；原文照抄
      if ('runtimeModel' in params) {
        respondError(id, -32602, 'Invalid params — (root): Unrecognized key: "runtimeModel"', { name: 'ZodError' });
        break;
      }
      const wanted = params.model;
      if (wanted) {
        const found = findModel(wanted);
        if (!found) {
          respondError(id, -32603, `Provider Registry 中不存在 Model: ${wanted.providerId}/${wanted.modelId}`, { name: 'ModelProtocolError' });
          break;
        }
        if (!wanted.options?.reasoningLevel) {
          respondError(id, -32603, `Reasoning level is required for ${wanted.providerId}/${wanted.modelId}`, { name: 'ModelProtocolError' });
          break;
        }
      }
      const settings = buildSettings(params.thoughtLevel, wanted);
      const sessionId = `sess_${randomUUID()}`;
      const now = Date.now();
      const session = {
        // 真机 3.12.2 探针 2026-09-18：session 对象的键就这些；model 是 {providerId, modelId}（不带 options）。
        // 响应里另有 messages/projection/protocol/runtime/slashCommands/todos/todoGroups，没人用，不复刻
        createdAt: now,
        mode: params.mode ?? 'build',
        model: settings.model.current
          ? { providerId: settings.model.current.providerId, modelId: settings.model.current.modelId }
          : { modelId: 'missing-model', providerId: 'zcode-unconfigured' },
        traceId: randomUUID(),
        sessionId,
        sessionKind: 'interactive',
        status: 'idle',
        target: null,
        title: '',
        updatedAt: now,
        workspace: params.workspace,
      };
      state.sessions.push(session);
      if (params.persistence === 'deferred') state.deferredIds.add(sessionId);
      // verified.md「requestRuntimePreferences 时序」行：应答之后才发，params 带 sessionId 和 scope
      respond(id, { session, settings });
      void askServer('session/requestRuntimePreferences', { sessionId, scope: 'runtime-materialization' }).then((answer) => {
        log(`runtimePreferences answered: ${JSON.stringify(answer)}`);
      });
      break;
    }
    case 'workspace/generateText': {
      // verified.md「3.12.2 直连探针实测」表第 4 行（2026-09-18）：modelRef 改名 selection，strict schema；原文照抄
      if ('modelRef' in params) {
        respondError(id, -32602, 'Invalid params — selection: Invalid input: expected object, received undefined; (root): Unrecognized key: "modelRef"', { name: 'ZodError' });
        break;
      }
      if (!params.selection || typeof params.selection !== 'object') {
        respondError(id, -32602, 'Invalid params — selection: Invalid input: expected object, received undefined', { name: 'ZodError' });
        break;
      }
      if (!findModel(params.selection)) {
        respondError(id, -32603, `Provider Registry 中不存在 Model: ${params.selection.providerId}/${params.selection.modelId}`, { name: 'ModelProtocolError' });
        break;
      }
      // T3.2：按调用次序回剧本的 replies（用完循环最后一条）；result 带 text 与回显的 selection，
      // finishReason/usage 自造。收到的请求本身已进记录文件（messages / selection / querySource 都在）
      state.generateTextCount += 1;
      const callNo = state.generateTextCount;
      const scriptedError = script.generateTextErrors?.[String(callNo)];
      if (scriptedError) {
        respondError(id, scriptedError.code ?? -32000, scriptedError.message ?? 'generateText failed');
        break;
      }
      void (async () => {
        const selection = params.selection;
        const headersError = await requestRuntimeHeaders({ modelSelection: { providerId: selection.providerId, modelId: selection.modelId } });
        if (headersError !== null) {
          // verified.md「3.12.2 直连探针实测」表第 5 行：头没应用上，模型请求以 -32031 失败，message 是客户端的 errorMessage，
          // 没给才是那句固定原文（code、原文与取舍都出自 zcode.cjs）
          respondError(id, -32031, headersError);
          return;
        }
        if (script.generateTextDelayMs) await sleep(script.generateTextDelayMs);
        const replies = script.generateText?.replies ?? [];
        const text = replies.length === 0 ? 'Y' : replies[Math.min(callNo - 1, replies.length - 1)];
        respond(id, {
          text,
          selection,
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        });
      })();
      break;
    }
    case 'workspace/cancelGenerateText': {
      // 出处 verified.md：cancelGenerateText 参数 {operationId}。应答形状自造（未抓真机原文）
      respond(id, { operationId: params.operationId ?? null, cancelled: true });
      break;
    }
    case 'session/resume': {
      // 权宜：resume 的响应形状未验（协议文档只记了请求），测试只需要它成功并回显 sessionId
      respond(id, { session: { sessionId: params.sessionId } });
      break;
    }
    case 'session/stop': {
      // 出处：docs/reference/zcode-app-server-protocol.md「session/stop」一节（fire-and-forget 通知，无应答）。
      //       真机上 stop 会不会推结束事件未验，mock 不推
      log(`session/stop 收到（sessionId=${params.sessionId ?? 'none'}）`);
      if (id !== undefined) respond(id, {});
      break;
    }
    case 'session/list': {
      // verified.md「响应形状（T0.3 抓取）」行：{sessions: [session 对象]}，不是裸数组。
      // deferred 建的会话不在列（真机探针 2026-09-18：create(deferred) 后 list 为空）
      respond(id, { sessions: state.sessions.filter((s) => !state.deferredIds.has(s.sessionId)) });
      break;
    }
    case 'session/close': {
      state.sessions = state.sessions.filter((s) => s.sessionId !== params.sessionId);
      state.deferredIds.delete(params.sessionId);
      // verified.md「直连探针实测」推表之后（T0.2b）行：close 回 {closed:true}
      respond(id, { closed: true });
      break;
    }
    case 'session/subscribe': {
      // verified.md「响应形状（T0.3 抓取）」行：必须带 deliveryKind。错误文案自造（未抓真机原文）
      const kinds = ['desktop-continuous', 'web-remote-replayable'];
      if (!kinds.includes(params.deliveryKind)) {
        respondError(id, -32602, `Invalid params — deliveryKind: expected one of ${kinds.map((k) => `"${k}"`).join('|')}`);
        break;
      }
      respond(id, { eventSeq: state.seq, snapshot: {} }); // snapshot 真机不是空对象，这里简化
      break;
    }
    case 'session/send': {
      // 权宜：{accepted:true} 形状未验，真机跑过第一个回合后回来核
      respond(id, { accepted: true });
      if (script.exitAfter === method) {
        // 「处理完」= 回完话。要先退再跑回合：回合是同步推事件的，晚了 exited 就永远赢不了
        log(`exitAfter ${method}：process.exit(3)`);
        process.exit(3);
      }
      if (state.activeTurn) {
        // verified.md：回合进行中再发一条会被当作 steer 输入排队——不是新回合
        log(`steer 排队（sessionId=${params.sessionId ?? 'none'}）`);
      } else {
        state.activeTurn = true;
        void runTurn(params.sessionId).then(() => {
          state.activeTurn = false;
        });
      }
      break;
    }
    default: {
      // 3.12.2 真机原文（2026-09-18）：被删的 workspace/updateProviderRegistry、workspace/readState
      // 也走这句，和未知方法一样
      respondError(id, -32601, `Method not found: ${method}`);
    }
  }
  afterHandled(method);
}

// ---------- 主循环 ----------
if (script.serverRequests?.length) {
  setTimeout(() => {
    for (const r of script.serverRequests) {
      void askServer(r.method, r.params ?? {}).then((answer) => log(`serverRequest ${r.method} answered: ${JSON.stringify(answer)}`));
    }
  }, script.serverRequestsDelayMs ?? 0);
}

log(`started version=${version} pid=${process.pid}`);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    log('收到非 JSON 行，忽略');
    return;
  }
  collectSecrets(msg); // 必须在写记录前收集，这一条消息里的 key 才抹得掉
  record(msg); // 收到的每条消息（请求、通知、应答）都进记录文件
  if (msg.id !== undefined && msg.method === undefined) {
    onAnswerMessage(msg);
    return;
  }
  if (msg.method !== undefined) {
    handleRequest(msg);
  }
});
rl.on('close', () => {
  if (script.ignoreEof) {
    log('ignoreEof：收到 stdin EOF 不退出');
    return; // 常驻句柄在下面挂着，进程等 SIGKILL
  }
  process.exit(0);
});
// T0.3c 第 8 条：只在 ignoreEof 时挂常驻句柄——EOF 后不退出、等 SIGKILL 用；
// 正常路径 EOF 直接 exit(0)，不该被定时器拖住
if (script.ignoreEof) {
  setInterval(() => {}, 60_000);
}
