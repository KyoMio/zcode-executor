// 本文件负责：模型审批的两路素材（工作流层，T3.2 的并行注意指定放这里）——
// gatherIntent：本会话的意图条目 {source:'task'|'send'|'steer', text}，按时间序（T3.2b 加
// steer、加来源）；任务单全保留，投递/插话只留最近 10 条。
// gatherPriorActions：本回合（最近一条 executor.send 之后）tool.updated 里 kind 为
// scheduled/started 的 toolName 列表，最多 30 条。都是纯读，不改任何文件。
// 不负责：projectDoc（AGENTS.md/CLAUDE.md 由闸门层自读——闸门不能反向 import 工作流层）、
// 事件的产生与落盘、意图的截断与渲染（lib/review/prompt.mjs）。
// 被依赖方：lib/run.mjs 的 runner 接线（getIntent / getPriorActions）。
// 依赖 node:path、node:process、lib/runs.mjs（事件容错读走同一份 tailEvents，T2.9 第 10 条；任务单快照）。
import path from 'node:path';
import process from 'node:process';
import { readTaskSnapshot, tailEventsFromFile } from './runs.mjs';

const MAX_PRIOR_ACTIONS = 30;
const MAX_RECENT_TURNS = 10; // 投递/插话意图只留最近 10 条（T2.3b）；任务单不受此限

// events.jsonl 纯读：文件还没建、坏行都按没有处理——素材缺一段只是判得糙些，不能炸闸门
const readEvents = (eventsPath) => tailEventsFromFile(eventsPath, { fromOffset: 0 }).events;

/**
 * 意图条目（按时间序）：
 * - executor.send → {source:'send', text: 正文}，其后紧跟它的任务单 {source:'task', text: 全文}。
 *   全文只从入队时留的快照读（events.jsonl 同目录的 tasks/<taskSha256>.md，审计 D3），不读事件里的
 *   task 路径：那个文件在执行副本里，执行端改得动，现读它等于让执行端自己写「用户说过的话」。
 *   没有快照（旧版本落的事件）、快照读不到或对不上哈希就跳过并记一行 stderr——少一段依据只会让审批
 *   更常转人工；
 * - executor.steer → {source:'steer', text: 插话正文}（T3.2b 起也进意图）。
 * 总量（T3.2b）：任务单全保留；send/steer 只留最近 MAX_RECENT_TURNS 条——插话越多上下文越贵，
 * 而任务单是契约，不能因为条数被挤掉。
 */
export function gatherIntent(eventsPath) {
  const entries = [];
  const runDir = path.dirname(eventsPath);
  for (const event of readEvents(eventsPath)) {
    if (event.type === 'executor.send') {
      entries.push({ source: 'send', text: event.text ?? '' });
      if (!event.task) continue;
      const snapshot = readTaskSnapshot(runDir, event.taskSha256);
      if (snapshot === null) {
        process.stderr.write(`intent: 任务单 ${event.task} 没有可用的快照（旧版本落的事件，或快照缺失、被改过），不作审批依据\n`);
      } else {
        entries.push({ source: 'task', text: snapshot });
      }
      continue;
    }
    if (event.type === 'executor.steer') {
      entries.push({ source: 'steer', text: event.text ?? '' });
    }
  }
  const conversational = entries.filter((e) => e.source !== 'task');
  const keep = new Set(conversational.slice(-MAX_RECENT_TURNS));
  return entries.filter((e) => e.source === 'task' || keep.has(e));
}

/**
 * 本回合已执行的工具调用摘要：最近一条 executor.send 之后的事件才算本回合
 * （executor.send 在投递时落盘，回合由它触发）；tool.updated 的 scheduled/started 两条带
 * toolName（verified.md「第一次真机投递」事件流行），result/batch 不带也不需要。
 */
export function gatherPriorActions(eventsPath) {
  const events = readEvents(eventsPath);
  const types = events.map((e) => e.type);
  const lastSend = types.lastIndexOf('executor.send');
  if (lastSend === -1) return [];
  const names = [];
  for (const event of events.slice(lastSend + 1)) {
    if (event.type !== 'tool.updated') continue;
    const kind = event.payload?.kind;
    if (kind !== 'scheduled' && kind !== 'started') continue;
    if (event.payload?.toolName) names.push(event.payload.toolName);
    if (names.length >= MAX_PRIOR_ACTIONS) break;
  }
  return names;
}
