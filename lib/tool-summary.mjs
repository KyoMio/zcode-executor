// lib/tool-summary.mjs —— 本回合解析（SPEC-watch-pane A，工作流层）：从一段事件里解析出
// 工具调用、参数摘要、成败与回复文字的纯函数，不读文件、不碰协议层、不管 runs 目录。
// status（lib/cli/status.mjs）、summarizeTurn（lib/cli/common.mjs）与快照共用。
// 事件形状出处 verified.md「工具参数位置与 Bash 成败字段」2026-10-02（App 3.14.1）：
// ZCode 3.12 起 tool.updated 的 scheduled 行 inputOmitted:true 不带 input，参数在 model.streaming
// 的 kind:'tool_call' 里；result 行没有 toolName，靠 toolCallId 归并；Bash 退出码非 0 时
// result.success 仍为 true，真实成败在 perf.detail.command（perf 两种位置 payload.perf /
// payload.result.perf 都认，实测是后者）。
import path from 'node:path';

/** input.file_path 带目标路径的工具：status --json 的 file 只认这三个（含义照旧，不含 Read）。 */
export const PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/** 参数摘要里的路径工具比 file 多一个 Read（SPEC A 的表：读到的路径也值得显示）。 */
const SUMMARY_PATH_TOOLS = new Set(['Read', ...PATH_TOOLS]);

const SUMMARY_MAX = 200;
const PENDING_MAX = 2000;

/** 摘要截断：null/undefined 与空串算没有摘要，返回 null；超长截到 max 字。 */
function clip(text, max) {
  if (text === undefined || text === null) return null;
  const s = String(text);
  if (s === '') return null;
  return s.length > max ? s.slice(0, max) : s;
}

/** 路径在 cwd 下给相对路径，不在（或 cwd 未知）就原样。相对路径按 cwd 解析后照常还原。 */
function relativeIfInside(cwd, filePath) {
  if (!cwd) return filePath;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const rel = path.relative(cwd, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
  return rel;
}

/** 一行参数摘要（SPEC A 的表）：Bash 取 command 第一行；四个文件工具取 file_path；Grep/Glob 取 pattern。 */
export function toolSummary(toolName, input, cwd) {
  if (!input || typeof input !== 'object') return null;
  if (toolName === 'Bash') return clip(String(input.command ?? '').split('\n')[0], SUMMARY_MAX);
  // file_path 是模型生成的参数，类型没保证：非字符串当没有（返回 null），不往 path 函数里喂
  if (SUMMARY_PATH_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    return clip(relativeIfInside(cwd, input.file_path), SUMMARY_MAX);
  }
  if (toolName === 'Grep' || toolName === 'Glob') return clip(input.pattern, SUMMARY_MAX);
  return null;
}

/** 挂起用的全文摘要（SPEC A）：Bash 给 command 全文；四个文件工具给路径；其他工具给整个 input 的 JSON。 */
export function pendingSummary(toolName, input, cwd) {
  if (!input || typeof input !== 'object') return null;
  if (toolName === 'Bash') return input.command == null ? null : clip(String(input.command), PENDING_MAX);
  if (SUMMARY_PATH_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    return clip(relativeIfInside(cwd, input.file_path), PENDING_MAX);
  }
  return clip(JSON.stringify(input), PENDING_MAX);
}

/** 回复行（SPEC A）：按消息拼接换行、去空行、只留最后 8 行，总长超 800 字从最前面丢/截。 */
export function replyLines(textDeltas) {
  let text = '';
  let lastId;
  let first = true;
  for (const d of textDeltas ?? []) {
    if (!first && d.assistantMessageId !== lastId) text += '\n';
    text += d.delta ?? '';
    lastId = d.assistantMessageId;
    first = false;
  }
  const lines = text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .slice(-8);
  let total = lines.reduce((n, l) => n + l.length, 0);
  while (total > 800 && lines.length > 0) {
    // 整行丢得下就整行丢；丢不下（丢完会低于 800）才截掉最前一行的开头，保住末尾 800 字
    if (total - lines[0].length >= 800) {
      total -= lines[0].length;
      lines.shift();
    } else {
      lines[0] = lines[0].slice(total - 800);
      total = 800;
    }
  }
  return lines;
}

/**
 * Markdown 尾部截断（SPEC-watch-pane D 快照表 replyMarkdown 行）：先清洗（\r\n 与单独 \r 归一成
 * \n、删掉制表符与换行以外的控制字符含 C1、去首尾空白），不超 maxChars 原样返回；超长从尾部取
 * maxChars 字——截断点已在整行开头就直接开始，否则往后挪到下一个换行之后（找不到就不挪），落在
 * 代理对后半再让一个字，别把一个字劈成两半。被截掉的部分里围栏行（trim 后以 ``` 开头的行）是
 * 奇数个说明截断点落在代码块里，在省略号之后补上最后那个开启围栏行（含语言名）重新打开代码块；
 * 不在代码块里而保留部分第一行以 | 开头（截在表格中间）时，往被截部分里找这张表连续 | 行的开头，
 * 第二行是分隔行才把表头行与分隔行补回来——表格丢了表头就画不成表了。
 */
export function markdownTail(text, { maxChars = 1500 } = {}) {
  const clean = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // \t 与 \n 留着：前者可能是缩进，后者是 Markdown 结构
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.length - maxChars;
  // 截断点已在整行开头（cut 为 0 或左边是 \n）就直接从截断点开始，否则往后挪到下一个换行之后
  const nl = cut === 0 || clean[cut - 1] === '\n' ? -1 : clean.indexOf('\n', cut);
  let start = nl === -1 ? cut : nl + 1; // 整行开头；找不到换行就不挪
  // start 落在代理对后半（0xDC00–0xDFFF）时再让一个字：孤立的半个代理对会显示成乱码
  if (start < clean.length && clean.charCodeAt(start) >= 0xdc00 && clean.charCodeAt(start) <= 0xdfff) start += 1;
  const removedLines = clean.slice(0, start).split('\n');
  if (removedLines[removedLines.length - 1] === '') removedLines.pop(); // 截断点前那个换行留下的空段不算一行
  const fences = removedLines.filter((l) => l.trim().startsWith('```'));
  const inCode = fences.length % 2 === 1;
  const reopen = inCode ? `${fences[fences.length - 1].trim()}\n` : '';
  // 表格只在截断点不在代码块里时补；连续 | 行的再往前一行不是 | 就到头了，那张表的开头就是表头行
  let tableHead = '';
  const keptFirst = clean.slice(start).split('\n')[0].trim();
  if (!inCode && keptFirst.startsWith('|')) {
    let head = removedLines.length;
    while (head > 0 && removedLines[head - 1].trim().startsWith('|')) head--;
    const isSeparator = (l) => /^[\s|:\-]+$/.test(l) && l.includes('-');
    if (head < removedLines.length - 1 && isSeparator(removedLines[head + 1])) {
      tableHead = `${removedLines[head].trim()}\n${removedLines[head + 1].trim()}\n`;
    }
  }
  return `…\n\n${reopen}${tableHead}${clean.slice(start)}`;
}

/**
 * 最新一条消息的 Markdown 原文（SPEC-watch-pane D 快照表 replyMarkdown 行）：面板要按 Markdown
 * 画回复，replyLines 去空行、截 8 行的形状不适合，这里给原文。取最后一个 assistantMessageId
 * 的 delta 按顺序拼接，交给 markdownTail；没有 delta 返回 ''。
 */
export function lastMessageMarkdown(textDeltas, { maxChars = 1500 } = {}) {
  const deltas = textDeltas ?? [];
  if (deltas.length === 0) return '';
  const lastId = deltas[deltas.length - 1].assistantMessageId;
  let text = '';
  for (const d of deltas) {
    if (d.assistantMessageId === lastId) text += d.delta ?? '';
  }
  return markdownTail(text, { maxChars });
}

/** 本回合 = 最后一条 executor.send 之后的事件（summarizeTurn 现有做法）；没有 send 返回空数组。 */
export function turnEvents(events) {
  for (let i = (events?.length ?? 0) - 1; i >= 0; i--) {
    if (events[i]?.type === 'executor.send') return events.slice(i + 1);
  }
  return [];
}

/**
 * 本回合解析（SPEC A）：输入一段事件（要本回合就先过 turnEvents），返回 { calls, reply, replyMarkdown }。
 * calls 按 toolCallId 合并同一次调用的所有行，按出现顺序；没有 toolCallId 的 scheduled/started
 * 行各算一次调用；batch 行不产生调用。参数优先 model.streaming 的 tool_call，其次 tool.updated
 * 自带的 input（旧形状），都没有且被 inputOmitted 过才用 permission.requested 按同名工具兜底。
 * state：done（有 result）/ running（有 started 无 result）/ scheduled；ok 只在 done 时有意义
 * （Bash 看 perf.detail.command，其他看 result.success），没完成为 null。
 */
export function parseTurn(events, { cwd } = {}) {
  const calls = [];
  const byId = new Map(); // toolCallId → 调用（中间形态，最后映射成输出形状）
  const requestedByTool = new Map(); // toolName → [input]：审批输入排队，最后给省略参数的调用回填
  const textDeltas = [];
  const blankCall = (toolCallId) => ({
    toolCallId,
    toolName: null,
    input: undefined,
    omitted: false,
    started: false,
    done: false,
    result: null,
    perf: null,
  });
  const callOf = (toolCallId) => {
    let call = byId.get(toolCallId);
    if (!call) {
      call = blankCall(toolCallId);
      byId.set(toolCallId, call);
      calls.push(call);
    }
    return call;
  };
  for (const e of events ?? []) {
    const p = e?.payload ?? {};
    if (e?.type === 'model.streaming') {
      if (p.kind === 'tool_call' && p.toolCallId !== undefined) {
        const call = callOf(p.toolCallId);
        call.toolName = call.toolName ?? p.toolName ?? null;
        if (p.input !== undefined) call.input = p.input; // 3.12+ 参数的权威来源，盖过 tool.updated 自带的
      } else if (p.kind === 'text_delta') {
        textDeltas.push({ assistantMessageId: p.assistantMessageId, delta: p.delta });
      } // reasoning_delta 等不要
      continue;
    }
    if (e?.type === 'permission.requested') {
      if (p.toolName && p.input !== undefined) {
        const list = requestedByTool.get(p.toolName) ?? [];
        list.push(p.input);
        requestedByTool.set(p.toolName, list);
      }
      continue;
    }
    if (e?.type !== 'tool.updated') continue;
    if (p.kind === 'batch') continue; // 批次行只汇总别的调用的结果，没有自己的 toolCallId
    if (p.kind === 'result') {
      if (p.toolCallId === undefined) continue; // 真机 result 行都带 toolCallId
      const call = callOf(p.toolCallId);
      call.done = true;
      call.result = p.result ?? null;
      call.perf = p.perf ?? p.result?.perf ?? null;
      continue;
    }
    // scheduled / started（旧形状的 result/batch 之外的行都当这两类处理，与 status 原行为一致）
    let call;
    if (p.toolCallId !== undefined) {
      call = callOf(p.toolCallId);
    } else {
      call = blankCall(null); // 没有 toolCallId 的每行各算一次调用
      calls.push(call);
    }
    call.toolName = call.toolName ?? p.toolName ?? null;
    if (p.input !== undefined && call.input === undefined) call.input = p.input; // 旧形状自带 input
    if (p.inputOmitted === true) call.omitted = true;
    if (p.kind === 'started') call.started = true;
  }
  for (const call of calls) {
    if (call.input === undefined && call.omitted) {
      // 沿用 summarizeTurn 的兜底规则：只用同名工具的队列，toolName 都没有才借别家的——
      // 真机 3.14.1（2026-09-22 冒烟）Read 也省略 input 但从不发审批请求，不能让它偷走 Write 的输入
      const own = call.toolName ? requestedByTool.get(call.toolName) : null;
      const list = own?.length ? own : call.toolName ? null : [...requestedByTool.values()].find((l) => l.length > 0);
      if (list?.length) call.input = list.shift();
    }
  }
  return {
    // 查不到工具名的调用（比如只有 result 行、没有 scheduled/started）不输出：三处共用方都只认有名工具
    calls: calls
      .filter((call) => call.toolName)
      .map((call) => ({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        summary: toolSummary(call.toolName, call.input, cwd),
        state: call.done ? 'done' : call.started ? 'running' : 'scheduled',
        ok: okOf(call),
      })),
    reply: replyLines(textDeltas),
    replyMarkdown: lastMessageMarkdown(textDeltas),
  };
}

/** 成败：Bash 看 perf 的 command（退出码非 0 或 status failed 为失败），其他看 result.success；没完成为 null。 */
function okOf(call) {
  if (!call.done) return null;
  const command = call.perf?.detail?.command;
  if (call.toolName === 'Bash' && command) {
    const failed =
      (command.exitCode !== undefined && command.exitCode !== null && command.exitCode !== 0) ||
      command.status === 'failed';
    return !failed && call.result?.success !== false;
  }
  return call.result?.success !== false;
}
