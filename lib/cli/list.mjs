// lib/cli/list.mjs —— list 子命令（外壳层）：读登记簿，逐条给 phase（与 status 同一套判定）。
// 显示本地 id 与 sessionId 两列（D13）。只读文件，不碰协议。
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { phaseOf, runsDirOf } from '../runs.mjs';
import { loadRegistry } from '../registry.mjs';
import { parseFlags, readPendingChecked } from './common.mjs';

export async function run(argv) {
  const flags = parseFlags(argv, { value: ['--project'], boolean: ['--json'] });
  const { json, project } = flags;
  const config = loadConfig();
  let entries = Object.values(loadRegistry(config.home).sessions);
  if (project !== undefined) {
    // cwd 兜空串：登记簿是手写坏了一条也不该把整个 list 炸掉（T2.9 第 10 条）
    entries = entries.filter((e) => String(e.cwd ?? '').includes(project) || String(e.title ?? '').includes(project));
  }
  const rows = entries.map((e) => ({
    id: e.id,
    sessionId: e.sessionId ?? null,
    phase: phaseOf(config.home, e.id),
    title: String(e.title ?? ''),
    cwd: String(e.cwd ?? ''),
    lastOutcome: e.lastOutcome ?? null,
  }));
  if (json) {
    console.log(JSON.stringify({ sessions: rows }));
    return;
  }
  if (rows.length === 0) {
    console.log(project ? `list: 没有匹配「${project}」的会话` : 'list: 登记簿是空的');
    return;
  }
  for (const r of rows) {
    const e = entries.find((x) => x.id === r.id) ?? {};
    const last = r.lastOutcome ? `（上次: ${r.lastOutcome}）` : '';
    const zcode = r.sessionId ? `zcode: ${r.sessionId}` : 'zcode 会话未建';
    // 等级与模型落进人读行（T2.7 第 1 条，PRD 第 4 节 list 一行说的「等级」）；--json 字段不动
    const tierModel = `${e.tier ?? '?'} ${e.provider ?? '?'}/${e.modelId ?? '?'}`;
    // 挂起的行末尾带「挂起: 工具名」（T2.8 第 3 条）；提问没有工具名，写「提问」。
    // 挂起刚好在 phaseOf 之后被消费掉（读到 null）就不加，别谎报
    let pendingNote = '';
    if (r.phase === 'pending') {
      const p = readPendingChecked(path.join(runsDirOf(config.home, r.id), 'pending.json'));
      if (p) pendingNote = ` 挂起: ${p.toolName ?? '提问'}`;
    }
    console.log(`${r.id} [${r.phase}] ${r.title || '（无标题）'} — ${r.cwd} ${tierModel} ${zcode}${last}${pendingNote}`);
  }
}
