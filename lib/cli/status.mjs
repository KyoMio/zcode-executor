// lib/cli/status.mjs —— status 子命令（外壳层）：只读 runs/<id>/ 与登记簿的快照，
// 不阻塞、不花 token。phase 判定用 lib/runs 的 phaseOf（T2.4）；工具调用的合并与摘要
// 共用 lib/tool-summary.mjs（SPEC-watch-pane B）。
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ExecutorError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { phaseOf, readLast, readState, runsDirOf, tailEvents } from '../runs.mjs';
import { getSession } from '../registry.mjs';
import { PATH_TOOLS, parseTurn, toolSummary } from '../tool-summary.mjs';
import { offPeakLines, parseFlags, readPendingChecked } from './common.mjs';
import { readOffPeak } from '../offpeak-send.mjs';

export async function run(argv) {
  const flags = parseFlags(argv, { value: ['--tools'], boolean: ['--json'] });
  const id = flags.positional[0];
  const { json, tools: toolsN } = flags;
  if (id === undefined) throw new ExecutorError('缺会话 id。用法：status <id> [--tools N] [--json]', 1);
  let toolCount = 5;
  if (toolsN !== undefined) {
    toolCount = Number(toolsN);
    if (!Number.isInteger(toolCount) || toolCount <= 0) {
      throw new ExecutorError(`--tools 要正整数，收到：${toolsN}`, 1);
    }
  }
  const config = loadConfig();
  const entry = getSession(config.home, id); // 不在登记簿 → 抛 2

  const dir = runsDirOf(config.home, id);
  const phase = phaseOf(config.home, id);
  const state = readState(config.home, id);
  const last = readLast(config.home, id);
  const pending = readPendingChecked(path.join(dir, 'pending.json')); // 坏 JSON 报中文（T2.6b 第 9 条）
  const queue = existsSync(path.join(dir, 'queue'))
    ? readdirSync(path.join(dir, 'queue')).filter((f) => f.endsWith('.json')).length
    : 0;
  const events = tailEvents(config.home, id, { fromOffset: 0 }).events;
  // 调用合并共用 lib/tool-summary.mjs（SPEC-watch-pane B）：取材范围照旧是整份事件（不限本回合），
  // 合并出每次调用后再回到事件行上取。result/batch 行没有 toolName，靠 toolCallId 反查；
  // 反查不到也没有自带 toolName 的行直接跳过。没有 id 的行用行自己的 input（与旧行为一致）
  const { calls } = parseTurn(events, { cwd: entry.cwd });
  const callById = new Map();
  for (const call of calls) {
    if (call.toolCallId !== null) callById.set(call.toolCallId, call);
  }
  const tools = events
    .filter((e) => e.type === 'tool.updated')
    .map((e) => {
      const p = e.payload ?? {};
      const call = p.toolCallId !== undefined ? callById.get(p.toolCallId) : undefined;
      const toolName = p.toolName ?? call?.toolName ?? null;
      if (!toolName) return null;
      // file 仍只给 Write/Edit 系的 basename（含义不变）；参数用合并后的 input，3.12+ 形状下也有值；
      // file_path 是模型生成的参数，非字符串当没有
      const input = call ? call.input : p.input;
      const filePath = PATH_TOOLS.has(toolName) && typeof input?.file_path === 'string' ? input.file_path : null;
      return {
        toolName,
        kind: p.kind ?? null,
        file: filePath ? path.basename(filePath) : null,
        summary: toolSummary(toolName, input, entry.cwd),
      };
    })
    .filter(Boolean)
    .slice(-toolCount);
  const completed = [...events].reverse().find((e) => e.type === 'turn.completed');
  const totalTokens = completed?.payload?.usage?.totalTokens ?? null;

  const current = state?.current
    ? { text: String(state.current.text ?? '').slice(0, 80), task: state.current.task ?? null }
    : null;
  // 插话路径可用性（2026-09-21 对照 ZCode 源码：3.12.2 起回合中 session/send 直接被拒 -32010，
  // runner 插话失败时记在这里）：非空说明插话不可用，status 要如实显示；截 200 字防原因过长刷屏
  const steerUnavailable = state?.steerUnavailable ? String(state.steerUnavailable).slice(0, 200) : null;
  const pendingSummary = pending
    ? pending.kind === 'question'
      ? { kind: 'question', questions: (pending.questions ?? []).length }
      : { kind: 'permission', toolName: pending.toolName ?? null, reason: pending.reason ?? null }
    : null;
  const lastSummary = last ? { outcome: last.outcome ?? null, reason: last.reason ?? null, endedAt: last.endedAt ?? null } : null;

  if (json) {
    // id 是本地派单 id，sessionId 是 zcode 的 sess_（首回合前为 null），与 list 一致（T2.4d 第 6 条）
    console.log(
      JSON.stringify({
        id,
        sessionId: entry.sessionId ?? null,
        phase,
        cwd: entry.cwd,
        current,
        tools,
        queue,
        steerUnavailable,
        pending: pendingSummary,
        last: lastSummary,
        totalTokens,
        offpeak: readOffPeak(config.home, id), // offpeak.json 原样（不含凭据），没有闲时投递为 null（SPEC-offpeak E）
      }),
    );
    return;
  }
  const lines = [
    `status: ${id}`,
    `  phase=${phase}  cwd=${entry.cwd}`,
  ];
  if (current) lines.push(`  当前: ${current.text}${current.task ? `（任务单 ${current.task}）` : ''}`);
  if (calls.length > 0) {
    // 人读的最近工具按调用去重（SPEC-watch-pane B）：一次调用一项，带摘要写 工具名(摘要)，没有只写工具名
    const recent = calls
      .slice(-toolCount)
      .map((c) => (c.summary ? `${c.toolName}(${c.summary})` : c.toolName ?? '?'))
      .join('、');
    lines.push(`  最近工具: ${recent}`);
  }
  lines.push(`  队列: ${queue} 条`);
  // 只在本回合还跑着时提示：标记随回合开始就重置，旧回合残留的标记不该吓到人（--json 字段照旧原样给）
  if (steerUnavailable && state?.phase === 'running') lines.push(`  插话: 不可用（${steerUnavailable}）`);
  if (pendingSummary) {
    lines.push(
      pendingSummary.kind === 'question'
        ? `  挂起: 提问 ${pendingSummary.questions} 条`
        : `  挂起: 审批 ${pendingSummary.toolName} —— ${pendingSummary.reason ?? '无理由'}`,
    );
  }
  if (lastSummary) {
    lines.push(`  上次: ${lastSummary.outcome}${lastSummary.reason ? `（${lastSummary.reason}）` : ''} @ ${lastSummary.endedAt ?? '?'}`);
  }
  if (totalTokens !== null) lines.push(`  上下文: ${totalTokens} tokens`);
  for (const line of offPeakLines(config.home, id)) lines.push(`  ${line}`);
  console.log(lines.join('\n'));
}
