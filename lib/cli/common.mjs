// lib/cli/common.mjs —— 外壳各子命令共用的助手（T2.3b 第 12 条拆分）：
// 参数解析、USAGE 与实现清单、配置提醒打印、worktree 检测、--stream 打印、
// approve/deny/answer 共用的挂起读取与应答回执、status/follow/send 共用的闲时投递人读行（offPeakLines）。
// 3.12 起没有版本门槛了（`--version` 在 3.11 与 3.12 都打 0.16.5，verified.md「3.12.2 直连探针实测」 2026-09-18），
// doctor 改看内置 provider 文件在不在，版本比较随之删掉。
// 不 import 协议层；runs 目录与锁的判断走 lib/runs，登记簿走 lib/registry。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ExecutorError } from '../errors.mjs';
import { livePidOf, runsDirOf, tailEvents } from '../runs.mjs';
import { PATH_TOOLS, parseTurn, turnEvents } from '../tool-summary.mjs';
// RULES §1 例外：外壳可以直接用闸门层的纯函数（readPending 等），不经工作流层转调（T2.6b 第 7 条）
import { readPending } from '../pending.mjs';
import { ruleById } from '../review/rules.mjs';
import { getSession } from '../registry.mjs';
import { BUSY_PHASES, MAX_TICKETS, offPeakBusy, offPeakResumable, readOffPeak, resumeHint } from '../offpeak-send.mjs';
import { formatLocalTime } from '../offpeak.mjs';

export const COMMANDS = ['doctor', 'models', 'list', 'new', 'send', 'follow', 'status', 'cancel', 'approve', 'deny', 'answer', 'quota'];
/** 结算 outcome → 退出码（PRD 第 4 节）。send/follow 共用一份，别再各写各的（T2.9 第 5 条）。 */
export const EXIT_BY_OUTCOME = { done: 0, timeout: 3, failed: 4, exited: 4, cancelled: 4 };
export const USAGE = `用法：zcode-executor <命令> [参数]
命令：${COMMANDS.join('、')}（所有命令支持 --json，_runner 为内部命令）
doctor：doctor [--offpeak] [--json]（--offpeak 只跑第 ⑤ 项闲时接口自检）
quota：quota [--json]（今天本工具取过几次闲时号、服务器现在能不能取；零额度）
send：send <id> <正文|-> [--task 文件] [--wait] [--timeout 秒] [--steer | --offpeak] [--stream] [--json]；send <id> --offpeak --resume 接着跑没收尾的闲时投递
follow：follow <id> [--timeout 秒] [--stream] [--json]
status：status <id> [--tools N] [--json]
cancel：cancel <id>
approve/deny：approve|deny <id> [--json]
answer：answer <id> [--] <值…> [--json]（值以 -- 开头的先用 -- 分隔；多选一个参数逗号分隔）`;

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

/** 模型条目（settings.model.available 形状）瘦身成 {providerId, modelId, label}，供 --json 与人读行用。 */
export function slimModel(model) {
  if (!model?.ref) return null;
  return { providerId: model.ref.providerId, modelId: model.ref.modelId, label: model.label ?? model.ref.modelId };
}

/**
 * git -C cwd rev-parse --git-dir --git-common-dir：两者不同才是 worktree；不是 git 仓库按非 worktree。
 * repoRoot 是原仓库（主工作区）根：common dir 叫 .git 时取它的上一级；非 worktree 或裸仓库为 null。
 */
export function worktreeStatus(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--git-dir', '--git-common-dir'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'], // git 的原生报错不漏到我们的 stderr（T2.2b 第 5 条）
    });
    const [gitDir, commonDir] = out.trim().split('\n').map((l) => l.trim());
    const abs = (p) => (path.isAbsolute(p) ? p : path.resolve(dir, p));
    const isWorktree = Boolean(gitDir && commonDir) && abs(gitDir) !== abs(commonDir);
    const repoRoot = isWorktree && path.basename(abs(commonDir)) === '.git' ? path.dirname(abs(commonDir)) : null;
    return { isWorktree, repoRoot };
  } catch {
    return { isWorktree: false, repoRoot: null }; // 不是 git 仓库（或 git 不可用）：只警告不拒
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

/**
 * 本回合摘要（T2.8 第 1 条）：最近一条 executor.send 之后的 executor.gate 与工具调用统计。
 * 调用解析共用 lib/tool-summary.mjs 的 parseTurn（SPEC-watch-pane A/B），这里只算 send/follow
 * 要输出的三样。gate 计数：allow/ask 按 decision，hard/fast/slow 按 stage（review-fast / review-slow）。
 * files：Write/Edit 系工具 input.file_path 的 basename，去重最多 10 个；bashCount：Bash 调用条数。
 */
export function summarizeTurn(home, id) {
  const { events } = tailEvents(home, id, { fromOffset: 0 });
  const turn = turnEvents(events);
  const gate = { allow: 0, ask: 0, hard: 0, fast: 0, slow: 0 };
  for (const e of turn) {
    if (e.type !== 'executor.gate') continue;
    if (e.decision === 'allow') gate.allow += 1;
    if (e.decision === 'ask') gate.ask += 1;
    if (e.stage === 'hard') gate.hard += 1;
    if (e.stage === 'review-fast') gate.fast += 1;
    if (e.stage === 'review-slow') gate.slow += 1;
  }
  const { calls } = parseTurn(turn);
  const files = [];
  const seenFiles = new Set();
  let bashCount = 0;
  for (const call of calls) {
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

/** 排号中的那一行（不带前缀），phase 不是 queued / ready 返回 null。send --stream 每次轮询打它。 */
export function offPeakQueueLine(op) {
  const ticket = `号 ${op?.ticketId}，第 ${op?.ticketCount ?? 1}/${MAX_TICKETS} 个号`;
  if (op?.phase === 'queued') return `闲时：排第 ${op.position ?? '?'} 位（${ticket}）`;
  if (op?.phase === 'ready') return `闲时：号已就绪，等开跑（${ticket}）`;
  return null;
}

/**
 * 闲时投递期间 status / follow 多出的人读行（SPEC-offpeak E），不带缩进与前缀；没有要说的返回空数组。
 * 闲时投递占着会话时（offPeakBusy）排号中 / 运行中一行，runner 已不在再一行说怎么恢复；没人在处理的孤儿记录一行；
 * 号没结算成一行。
 */
export function offPeakLines(home, id) {
  const op = readOffPeak(home, id);
  if (!op) return [];
  const lines = [];
  const busy = offPeakBusy(home, id);
  const queueLine = busy ? offPeakQueueLine(op) : null;
  if (queueLine) lines.push(queueLine);
  if (busy && op.phase === 'running') {
    const deadline = op.activeDeadline ? `最晚 ${formatLocalTime(op.activeDeadline)} 截止` : '截止时间未知';
    lines.push(`闲时：运行中（号 ${op.ticketId}，${deadline}）`);
  }
  if (busy && !livePidOf(home, id)) {
    const resumable = offPeakResumable(home, id);
    lines.push(`闲时：${resumable.reason ? `号 ${op.ticketId} 没收尾，runner 已不在：cancel 会结算它` : resumeHint(id, resumable.offPeakId)}`);
  } else if (!busy && BUSY_PHASES.has(op.phase)) {
    lines.push(`闲时：号 ${op.ticketId} 没收尾，也没有 runner 在处理：cancel 或下一次 send 会结算它`);
  }
  const unsettled = (op.unsettledTickets ?? []).map((u) => u.ticketId);
  if (unsettled.length > 0) lines.push(`闲时：号 ${unsettled.join('、')} 未结算`);
  return lines;
}
