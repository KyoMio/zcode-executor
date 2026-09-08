// lib/cli/common.mjs —— 外壳各子命令共用的助手（T2.3b 第 12 条拆分）：
// 参数解析、USAGE 与实现清单、版本比较、配置提醒打印、worktree 检测、--stream 打印、
// approve/deny/answer 共用的挂起读取与应答回执。
// 不 import 协议层；runs 目录与锁的判断走 lib/runs，登记簿走 lib/registry。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ExecutorError } from '../errors.mjs';
import { livePidOf, runsDirOf, tailEvents } from '../runs.mjs';
// RULES §1 例外：外壳可以直接用闸门层的纯函数（readPending 等），不经工作流层转调（T2.6b 第 7 条）
import { readPending } from '../pending.mjs';
import { ruleById } from '../review/rules.mjs';
import { getSession } from '../registry.mjs';

export const MIN_ZCODE_VERSION = '0.14.8'; // PRD 第 4 节 doctor 版本门槛
export const COMMANDS = ['doctor', 'models', 'list', 'new', 'send', 'follow', 'status', 'cancel', 'approve', 'deny', 'answer'];
/** 结算 outcome → 退出码（PRD 第 4 节）。send/follow 共用一份，别再各写各的（T2.9 第 5 条）。 */
export const EXIT_BY_OUTCOME = { done: 0, timeout: 3, failed: 4, exited: 4, cancelled: 4 };
export const USAGE = `用法：zcode-executor <命令> [参数]
命令：${COMMANDS.join('、')}（所有命令支持 --json，_runner 为内部命令）
send：send <id> <正文|-> [--task 文件] [--wait] [--timeout 秒] [--steer] [--stream] [--json]
follow：follow <id> [--timeout 秒] [--stream] [--json]
status：status <id> [--tools N] [--json]
cancel：cancel <id>
approve/deny：approve|deny <id> [--json]
answer：answer <id> [--] <值…> [--json]（值以 -- 开头的先用 -- 分隔；多选一个参数逗号分隔）`;

/** 版本字符串 a < b（按点分数字逐段比较，缺的段按 0）。 */
export function versionLt(a, b) {
  const nums = (s) => String(s).split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pa = nums(a);
  const pb = nums(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

export function parseFlags(argv, { value = [], boolean = [] } = {}) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a); // 位置参数（如 send 的 id 与正文、'-' 表示 stdin）
      continue;
    }
    if (boolean.includes(a)) {
      flags[a.slice(2)] = true;
      continue;
    }
    if (value.includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new ExecutorError(`参数 ${a} 后缺一个值`, 1);
      flags[a.slice(2)] = v;
      continue;
    }
    throw new ExecutorError(`不认识的参数 ${a}`, 1);
  }
  flags.positional = positional;
  return flags;
}

/** loadConfig 的配置提醒（未知键等）统一在这里打，一行一条。 */
export function sayConfigWarnings(cmd, config) {
  for (const w of config?.warnings ?? []) console.error(`${cmd}: 警告：${w}`);
}

/** readState 模型条目瘦身成 {providerId, modelId, label}，供 --json 与人读行用。 */
export function slimModel(model) {
  if (!model?.ref) return null;
  return { providerId: model.ref.providerId, modelId: model.ref.modelId, label: model.label ?? model.ref.modelId };
}

/** git -C cwd rev-parse --git-dir --git-common-dir：两者不同才是 worktree；不是 git 仓库按非 worktree。 */
export function worktreeStatus(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'], // git 的原生报错不漏到我们的 stderr（T2.2b 第 5 条）
    });
    const [gitDir, commonDir] = out.trim().split('\n').map((l) => l.trim());
    const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(dir, p));
    return { isWorktree: Boolean(gitDir && commonDir) && abs(gitDir) !== abs(commonDir) };
  } catch {
    return { isWorktree: false }; // 不是 git 仓库（或 git 不可用）：只警告不拒
  }
}

/**
 * --stream 的 stderr 打印器（send --stream 与 follow --stream 共用，T2.4）：
 * model.streaming 的 text_delta 拼接按行刷（前缀 stream:），tool.updated 打 toolName kind。
 */
export function createStreamPrinter() {
  let buffer = '';
  return {
    feed(events) {
      for (const ev of events) {
        if (ev.type === 'model.streaming' && ev.payload?.kind === 'text_delta') {
          buffer += ev.payload?.delta ?? '';
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            console.error(`stream: ${buffer.slice(0, idx)}`);
            buffer = buffer.slice(idx + 1);
          }
        } else if (ev.type === 'tool.updated') {
          console.error(`stream: ${ev.payload?.toolName ?? '?'} ${ev.payload?.kind ?? ''}`.trimEnd());
        }
      }
    },
    flush() {
      if (buffer) {
        console.error(`stream: ${buffer}`);
        buffer = '';
      }
    },
  };
}

/**
 * approve/deny/answer 共用的挂起读取（T2.5）：会话必须在登记簿（否则 2）、必须有挂起
 * （否则 2「当前没有挂起」）、runner 必须活着（否则 2「runner 没了」，且不写 answer.json）。
 * 返回 { dir, pendingPath, answerPath, pending, pendingKind, entry }，entry 是登记簿项
 * （T2.6b 第 1 条：--json 的 sessionId 从这里取 zcode 的 sess_）。
 */
export function requirePending(config, id) {
  const entry = getSession(config.home, id); // 不在登记簿 → 2
  const dir = runsDirOf(config.home, id);
  const pendingPath = path.join(dir, 'pending.json');
  const answerPath = path.join(dir, 'answer.json');
  // readPending：ENOENT 返回 null（没有挂起）；坏 JSON 抛错 → 包装成中文 2（评审 T2.5b 第 3 条）
  let pending;
  try {
    pending = readPending(pendingPath);
  } catch (err) {
    throw new ExecutorError(`pending.json 读不出来，用 status 看或重新 send：${err?.message ?? err}`, 2);
  }
  if (!pending) {
    throw new ExecutorError('当前没有挂起，用 status 看现在什么状态。approve/deny/answer 只在有审批或提问挂起时可用', 2);
  }
  if (!livePidOf(config.home, id)) {
    throw new ExecutorError('runner 没了，pending 已失效，重新 send 一条再处理', 2);
  }
  return { dir, pendingPath, answerPath, pending, pendingKind: pending.kind, entry };
}

/** status/send/follow/cancel 四条只读命令共用的挂起读取：坏 JSON 报中文，不裸崩（T2.6b 第 9 条）。 */
export function readPendingChecked(pendingPath) {
  try {
    return readPending(pendingPath);
  } catch (err) {
    throw new ExecutorError(`pending.json 解析失败（${err?.message ?? err}）。删掉这个文件或重新 send 一条`, 1);
  }
}

/**
 * 人读挂起行下面的规则原文（T2.9 第 6 条）：pending.json 带 ruleId 时按 id 还原措辞，
 * 人看挂起时不用再去查规则表。ruleById 是闸门层纯函数，按 RULES §1 的同一例外直连。
 */
export function printPendingRuleNote(pending) {
  const rule = pending?.ruleId ? ruleById(pending.ruleId) : null;
  if (rule) console.log(`    规则 ${rule.id}：${rule.blocks ?? rule.allows ?? ''}`);
}

/**
 * 等应答被 runner 消费并收集回执事件（评审 T2.5b 第 1/5 条）：
 * 按 requestId 判——pending.json 消失、或挂起的 requestId 换成了新的（同一回合接了第二个挂起）
 * 都算已消费；同时在 events.jsonl 里找该 requestId 的 executor.* 回执事件。
 * events 只在循环外读一次拿 offset，之后每圈只读增量（T2.6b 第 5 条），别整文件反复扫。
 * 返回 { applied, event }：applied=false 表示等到超时挂起都没被消费（如实报，别谎报成功）。
 */
export async function waitAnswerOutcome({ config, id, requestId, pendingPath, timeoutMs }) {
  // 测试可用环境变量把 5 秒等尾压短（T2.6b 第 10 条）；正常使用仍是 5 秒
  const waitMs = (timeoutMs ?? Number(process.env.ZCODE_EXECUTOR_ANSWER_WAIT_MS)) || 5000;
  const deadline = Date.now() + waitMs;
  let offset = tailEvents(config.home, id, { fromOffset: 0 }).nextOffset;
  for (;;) {
    const pending = readPendingChecked(pendingPath); // 坏 JSON 报中文，不裸崩（T2.9 第 10 条）
    // tailEvents 容错读：坏 JSON 行跳过；events.jsonl 里还有 {method, params} 形状的
    // 通知行（真机 process/mcpTelemetry 等，T2.6 第 1 条），没有 type，不能当回执去 match
    const { events, nextOffset } = tailEvents(config.home, id, { fromOffset: offset });
    offset = nextOffset;
    const event =
      [...events]
        .reverse()
        .find((e) => typeof e.type === 'string' && e.type.startsWith('executor.') && e.requestId === requestId) ?? null;
    // 回执事件在 runner 里先于删 pending.json 落盘，看到它也算已消费——
    // 否则慢机器上会撞上「事件在、文件还没删」的中间态而谎报 false
    const consumed = !pending || pending.requestId !== requestId || event !== null;
    if (consumed) return { applied: true, event };
    if (Date.now() >= deadline) return { applied: false, event: null };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']); // input.file_path 带目标路径的工具

/**
 * 本回合摘要（T2.8 第 1 条）：最近一条 executor.send 之后的 executor.gate 与 tool.updated 统计。
 * gate 计数：allow/ask 按 decision，hard/fast/slow 按 stage（review-fast / review-slow）。
 * 文件：Write/Edit 系工具 input.file_path 的 basename，去重最多 10 个；tool.updated 省略 input
 * （inputOmitted:true）时用 permission.requested 事件里的 input 兜底——真机里它在 tool.updated
 * 之后才到（verified.md「事件流」），所以先收集后回填。bashCount：Bash 调用条数，按 toolCallId
 * 去重（scheduled/started 是同一次调用，result/batch 行没有 toolName 不算）。
 */
export function summarizeTurn(home, id) {
  const { events } = tailEvents(home, id, { fromOffset: 0 });
  const lastSend = events.map((e) => e.type).lastIndexOf('executor.send');
  const turn = lastSend === -1 ? [] : events.slice(lastSend + 1);
  const gate = { allow: 0, ask: 0, hard: 0, fast: 0, slow: 0 };
  const calls = new Map(); // toolCallId → {toolName, input, omitted}
  const requestedByTool = new Map(); // toolName → [input]（permission.requested 兜底用）
  for (const e of turn) {
    if (e.type === 'executor.gate') {
      if (e.decision === 'allow') gate.allow += 1;
      if (e.decision === 'ask') gate.ask += 1;
      if (e.stage === 'hard') gate.hard += 1;
      if (e.stage === 'review-fast') gate.fast += 1;
      if (e.stage === 'review-slow') gate.slow += 1;
      continue;
    }
    if (e.type === 'permission.requested') {
      const toolName = e.payload?.toolName;
      if (toolName && e.payload?.input !== undefined) {
        const list = requestedByTool.get(toolName) ?? [];
        list.push(e.payload.input);
        requestedByTool.set(toolName, list);
      }
      continue;
    }
    if (e.type !== 'tool.updated') continue;
    const p = e.payload ?? {};
    if (p.kind !== 'scheduled' && p.kind !== 'started') continue;
    const callId = p.toolCallId ?? `${p.toolName ?? '?'}:${calls.size}`; // 没有 id 的每行按一次调用
    const call = calls.get(callId) ?? { toolName: null, input: undefined, omitted: false };
    call.toolName = call.toolName ?? p.toolName ?? null;
    if (p.input !== undefined) call.input = p.input;
    if (p.inputOmitted === true) call.omitted = true;
    calls.set(callId, call);
  }
  const files = [];
  const seenFiles = new Set();
  let bashCount = 0;
  for (const call of calls.values()) {
    if (call.input === undefined && call.omitted) {
      // 先用同名工具的兜底，存完了才借别的工具的队列
      const own = call.toolName ? requestedByTool.get(call.toolName) : null;
      const list = own?.length ? own : [...requestedByTool.values()].find((l) => l.length > 0);
      if (list?.length) call.input = list.shift();
    }
    if (call.toolName === 'Bash') bashCount += 1;
    const filePath = PATH_TOOLS.has(call.toolName) ? call.input?.file_path : undefined;
    if (typeof filePath === 'string' && files.length < 10 && !seenFiles.has(path.basename(filePath))) {
      seenFiles.add(path.basename(filePath));
      files.push(path.basename(filePath));
    }
  }
  return { gate, files, bashCount };
}

/** send/follow 结束时人读的两块摘要（T2.8 第 1 条）。 */
export function printTurnSummary(home, id) {
  const s = summarizeTurn(home, id);
  const files = s.files.length > 0 ? s.files.join('、') : '无文件改动';
  console.log(`闸门：放行 ${s.gate.allow} 次（红线挂起 ${s.gate.hard}、快筛 ${s.gate.fast}、慢判 ${s.gate.slow}、转人工 ${s.gate.ask}）`);
  console.log(`改动：${files}；Bash ${s.bashCount} 条`);
}
