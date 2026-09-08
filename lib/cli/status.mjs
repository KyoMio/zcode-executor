// lib/cli/status.mjs —— status 子命令（外壳层）：只读 runs/<id>/ 与登记簿的快照，
// 不阻塞、不花 token。phase 判定用 lib/runs 的 phaseOf（T2.4）。
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ExecutorError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { phaseOf, readLast, readState, runsDirOf, tailEvents } from '../runs.mjs';
import { getSession } from '../registry.mjs';
import { parseFlags, readPendingChecked } from './common.mjs';

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
  // toolCallId → scheduled/started 行（带 toolName 与 input）：result/batch 行自己不带 toolName，
  // 靠它反查（T2.8 第 2 条）；反查不到也没有自带 toolName 的行直接跳过
  const scheduledById = new Map();
  for (const e of events) {
    if (e.type !== 'tool.updated') continue;
    const p = e.payload ?? {};
    if (p.toolName && (p.kind === 'scheduled' || p.kind === 'started') && p.toolCallId !== undefined) {
      scheduledById.set(p.toolCallId, p);
    }
  }
  const PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']); // 带目标路径的工具，显示 basename
  const tools = events
    .filter((e) => e.type === 'tool.updated')
    .map((e) => {
      const p = e.payload ?? {};
      const known = p.toolCallId !== undefined ? scheduledById.get(p.toolCallId) : undefined;
      const toolName = p.toolName ?? known?.toolName ?? null;
      if (!toolName) return null;
      const filePath = PATH_TOOLS.has(toolName) ? (p.input?.file_path ?? known?.input?.file_path ?? null) : null;
      return { toolName, kind: p.kind ?? null, file: filePath ? path.basename(filePath) : null };
    })
    .filter(Boolean)
    .slice(-toolCount);
  const completed = [...events].reverse().find((e) => e.type === 'turn.completed');
  const totalTokens = completed?.payload?.usage?.totalTokens ?? null;

  const current = state?.current
    ? { text: String(state.current.text ?? '').slice(0, 80), task: state.current.task ?? null }
    : null;
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
        pending: pendingSummary,
        last: lastSummary,
        totalTokens,
      }),
    );
    return;
  }
  const lines = [
    `status: ${id}`,
    `  phase=${phase}  cwd=${entry.cwd}`,
  ];
  if (current) lines.push(`  当前: ${current.text}${current.task ? `（任务单 ${current.task}）` : ''}`);
  if (tools.length > 0) {
    // 带路径的工具显示 Write(x.md)（basename），其余显示工具名与 kind（T2.8 第 2 条）
    lines.push(`  最近工具: ${tools.map((t) => `${t.toolName}(${t.file ?? t.kind ?? '?'})`).join('、')}`);
  }
  lines.push(`  队列: ${queue} 条`);
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
  console.log(lines.join('\n'));
}
