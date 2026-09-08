// test/mock-appserver.mjs —— stdio 上说 app-server 协议的假进程（整个项目的测试接缝）。
// 由剧本 JSON 驱动，收到的每条消息追加到记录文件（MOCK_APPSERVER_RECORD，一行一条 JSON），
// apiKey 值写盘前抹成 "[REDACTED]"（T1.3b 第 6 条，RULES §8 永不落盘）。
// 日志一律 stderr（`mock: ` 前缀）。stdin EOF 后退出码 0。信封无 jsonrpc 字段；未知方法回 -32601。
// 目标是「真机行为的复刻」：每个默认返回形状旁注明出处（verified.md / 探针实测日期）。
// 不负责：模拟客户端（那边是 lib/appserver.mjs）、性能或时序的真实复刻（sleep 都是假等待）、
// 参数的全量 schema 校验（只校验测试用得到的字段）。
//
// 环境变量：
//   MOCK_APPSERVER_SCRIPT  剧本 JSON 路径（字段全可选，见下）；
//                          给了但读不出/JSON 坏 → stderr 一行 + exit(1)
//   MOCK_APPSERVER_RECORD  记录文件路径，每条收到的消息一行 JSON
//   MOCK_APPSERVER_VERSION --version 打印的版本，默认 0.16.5
//
// 剧本字段（全可选）：
//   errors:            { 方法名: {code, message, data?} }  某方法直接回错误
//   exitAfter:         方法名                              处理完这个方法就 process.exit(3)
//   junkStdoutLine:    "…"                                 应答第一个请求前往 stdout 打一行非 JSON
//   hangMethods:       [方法名]                            这些方法收到后不应答（测请求超时）
//   ignoreEof:         true                                stdin EOF 不退出（测 close 的 SIGKILL 路径）
//   registryRequired:  false                               关掉「没推 provider 表就拒 create」
//   resendIntervalMs:  1000                                反向请求未答时的重发间隔
//   models:            [...]                               覆盖 readState/create settings 的模型列表
//                                                          （形状同 registry 的 models 元素）
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
//                                                         文本（T3.2），用完就循环最后一条
//   generateTextErrors: { "<第 n 次调用>": {code, message} }  那一次调用直接回错误（1 起）
//   generateTextDelayMs: 0                                  每次 generateText 延后多少毫秒再应答
//                                                         （配 review.timeoutMs 测超时取消）
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const version = process.env.MOCK_APPSERVER_VERSION ?? '0.16.5';

if (process.argv.includes('--version')) {
  console.log(version);
  process.exit(0);
}

const log = (msg) => process.stderr.write(`mock: ${msg}\n`);
// T1.3b 第 6 条：写记录前把见过的 apiKey 值抹成 "[REDACTED]"（默认开启，RULES §8 永不落盘）。
// 值只从收到的 updateProviderRegistry / session/create 参数里收集，替换按整个带引号的 JSON
// 字符串做，记录行保持可 JSON.parse。
const secretValues = new Set();
function collectSecrets(msg) {
  if (msg?.method === 'workspace/updateProviderRegistry') {
    for (const p of msg.params?.registry?.providers ?? []) {
      if (p?.apiKey?.value) secretValues.add(p.apiKey.value);
    }
  }
  if (msg?.method === 'session/create') {
    const v = msg.params?.runtimeModel?.provider?.apiKey?.value;
    if (v) secretValues.add(v);
  }
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
  registry: null, // 最近一次推的 provider 表
  workspace: undefined, // 最近一次见到的 workspace
  sessions: [],
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
  }
  if (!ok) log(`应答形状不对 ${method}: ${json}`);
}

// ---------- 默认形状 ----------
// verified.md「直连探针实测」2026-09-07：推表前 readState 的 modelCatalog/settings 形状
function unconfiguredReadState() {
  return {
    modelCatalog: { available: [], providers: [], revision: 0 },
    settings: {
      mode: { current: 'build' },
      model: {
        available: [],
        current: { modelId: 'missing-model', providerId: 'zcode-unconfigured' },
        lastUsed: { modelId: 'missing-model', providerId: 'zcode-unconfigured' },
      },
      permission: { mode: 'build' },
      thoughtLevel: { available: [], enabled: false },
    },
    workspace: state.workspace,
  };
}

function modelLevels(models) {
  const levels = [];
  for (const m of models ?? []) {
    for (const l of m.reasoning?.levels ?? []) {
      if (!levels.some((x) => x.value === l.value)) levels.push({ value: l.value, label: l.label ?? l.value });
    }
  }
  return levels;
}

// 思考等级的可选值与默认值来源：script.models 优先，否则 registry 第一个 provider 的 models。
// T0.3c 第 9 条：models 覆盖时思考等级从各条目的 reasoning.levels 取，不再清空
function thoughtLevelSource() {
  if (script.models) return script.models;
  return state.registry?.providers?.[0]?.models ?? [];
}

// verified.md「直连探针实测」T0.2b 行 + 响应形状（T0.3 抓取）行：推表后每 provider 每 model 一条
function availableModels() {
  if (script.models) return script.models;
  const out = [];
  for (const p of state.registry?.providers ?? []) {
    for (const m of p.models ?? []) {
      out.push({
        contextWindow: m.contextWindow ?? 1_000_000,
        label: m.label ?? m.modelId,
        maxOutputTokens: m.maxOutputTokens ?? 128_000,
        providerLabel: p.label ?? p.providerId,
        reasoning: m.reasoning ?? { enabled: false, levels: [] },
        ref: { modelId: m.modelId, providerId: p.providerId },
      });
    }
  }
  return out;
}

// T0.2b 探针（2026-09-07）：create/readState 的 settings 形状；thoughtLevel 非法值静默忽略。
// requestedModel 是 create 的 runtimeModel 指定的 model ref：带了就把 model.current 回显成它（任务单 T1.3）
function buildSettings(requestedThoughtLevel, requestedModel) {
  const available = availableModels();
  const first = available[0];
  const source = thoughtLevelSource();
  const levels = modelLevels(source);
  // 默认思考等级取 defaultLevel（真机回显 max，探针 2026-09-07），没有才退第一档
  const defaultLevel = source.find((m) => m.reasoning?.defaultLevel)?.reasoning?.defaultLevel ?? levels[0]?.value ?? 'max';
  const wanted = requestedThoughtLevel;
  const thoughtCurrent = wanted !== undefined && levels.some((l) => l.value === wanted) ? wanted : defaultLevel;
  const unconfigured = { modelId: 'missing-model', providerId: 'zcode-unconfigured' };
  return {
    appliedProviderRevision: state.registry?.revision,
    mode: { current: 'build' },
    model: {
      available,
      current: requestedModel ? { ...requestedModel } : first ? { ...first.ref } : { ...unconfigured },
      lastUsed: first ? { ...first.ref } : { ...unconfigured },
    },
    permission: { mode: 'build' },
    thoughtLevel: {
      available: levels,
      current: thoughtCurrent,
      defaultLevel,
      enabled: levels.length > 0,
    },
  };
}

function buildReadState() {
  if (!state.registry) return unconfiguredReadState();
  const settings = buildSettings();
  const providers = (state.registry.providers ?? []).map((p) => ({ ...p, updatedAt: Date.now() }));
  return {
    // T0.2b 探针：modelCatalog 带 available/providers/revision/providerRevision
    modelCatalog: {
      available: script.models ?? settings.model.available,
      providers,
      revision: 1,
      providerRevision: state.registry.revision,
    },
    settings,
    workspace: state.workspace,
  };
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
    case 'workspace/updateProviderRegistry': {
      // T0.3c 第 11 条，出处 verified.md「provider 表」行「schema 要求 ≥1」。错误文案自造（未抓真机原文）
      const bad = Object.entries(params.registry?.providers ?? []).find(([, p]) => (p?.models ?? []).length === 0);
      if (bad) {
        respondError(id, -32602, `Invalid params — registry provider ${bad[1]?.providerId ?? bad[0]} has no models`);
        break;
      }
      state.registry = params.registry ?? null;
      // verified.md「直连探针实测」响应形状（T0.3 抓取）行
      respond(id, {
        appliedProviderRevision: state.registry?.revision,
        providerCount: state.registry?.providers?.length ?? 0,
        status: 'applied',
        workspace: params.workspace,
        workspaceState: buildReadState(),
      });
      break;
    }
    case 'session/create': {
      if (!state.registry && script.registryRequired !== false) {
        // verified.md「直连探针实测」T0.2 行：没推表 create 被拒，消息原文与 data.code 照抄
        respondError(
          id,
          -32603,
          'Model config is missing. Create ~/.zcode/cli/config.json with an explicit model provider before running ZCode.',
          { name: 'ModelProtocolError', code: 'model_config_missing' },
        );
        break;
      }
      const sessionId = `sess_${randomUUID()}`;
      const now = Date.now();
      const first = availableModels()[0];
      const session = {
        // verified.md「响应形状（T0.3 抓取）」行只记了键名清单；createdAt/traceId/sessionKind/
        // status/target 等键的取值细节未归档，先按自造对待，真机抓到原文再回来核
        createdAt: now,
        mode: params.mode ?? 'build',
        model: first ? { ...first.ref } : { modelId: 'missing-model', providerId: 'zcode-unconfigured' },
        traceId: `trace_${randomUUID()}`,
        sessionId,
        sessionKind: 'interactive',
        status: 'idle',
        target: null,
        title: '',
        updatedAt: now,
        workspace: params.workspace,
      };
      state.sessions.push(session);
      // verified.md「requestRuntimePreferences 时序」行：应答之后才发，params 带 sessionId 和 scope。
      // runtimeModel（D11）带上时把 settings.model.current 回显成它指定的 model ref
      const settings = buildSettings(params.thoughtLevel, params.runtimeModel?.model);
      respond(id, { session, settings });
      void askServer('session/requestRuntimePreferences', { sessionId, scope: 'runtime-materialization' }).then((answer) => {
        log(`runtimePreferences answered: ${JSON.stringify(answer)}`);
      });
      break;
    }
    case 'workspace/readState': {
      respond(id, buildReadState());
      break;
    }
    case 'workspace/generateText': {
      // T3.2：按调用次序回剧本的 replies（用完循环最后一条）；参数形状照 verified.md
      // 「workspace/generateText」行（result 带 text，usage 自造）。收到的请求本身已进记录文件
      // （messages / modelRef / querySource 都在），测试从记录断言。
      state.generateTextCount += 1;
      const callNo = state.generateTextCount;
      const scriptedError = script.generateTextErrors?.[String(callNo)];
      if (scriptedError) {
        respondError(id, scriptedError.code ?? -32000, scriptedError.message ?? 'generateText failed');
        break;
      }
      void (async () => {
        if (script.generateTextDelayMs) await sleep(script.generateTextDelayMs);
        const replies = script.generateText?.replies ?? [];
        const text = replies.length === 0 ? 'Y' : replies[Math.min(callNo - 1, replies.length - 1)];
        respond(id, {
          text,
          modelRef: params.modelRef ?? null,
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
      // verified.md「响应形状（T0.3 抓取）」行：{sessions: [session 对象]}，不是裸数组
      respond(id, { sessions: state.sessions });
      break;
    }
    case 'session/close': {
      state.sessions = state.sessions.filter((s) => s.sessionId !== params.sessionId);
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
