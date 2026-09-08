// 本文件负责：投递队列——入队（enqueue，写 queue/<ISO 时间戳>-<hrtime>-<随机>.json，文件名
// 排序即投递顺序）与队列侧读取（nextQueueFile、nextSteerFile），以及重投上限（MAX_ATTEMPTS）。
// 从 lib/run.mjs 拆出（T2.7 第 5 条）。
// 不负责：队列项的消费循环与结算（归 lib/run.mjs 的 runner）、runs 目录的其他文件（归 lib/runs.mjs）。
// 被依赖方：bin/zcode-executor（send 入队）、lib/run.mjs（消费循环）。只依赖 lib/config.mjs、lib/runs.mjs。
import { mkdirSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { writeJsonAtomic } from './config.mjs';
import { readJsonOrNull, runsDirOf } from './runs.mjs';

export const MAX_ATTEMPTS = 2; // 队列项最多投递 2 次，再取到就按 failed 丢弃（评审 T2.3b 第 9 条）

/**
 * 写一条投递进 queue/<ISO 时间戳>-<hrtime>-<随机>.json，返回文件路径。
 * 文件名排序即投递顺序；hrtime 保证同毫秒内也有序。冒号保留 —— 权宜：上 Windows 再换。
 */
export function enqueue(home, sessionId, { text, task, timeoutSec, steer = false }) {
  const queueDir = path.join(runsDirOf(home, sessionId), 'queue');
  mkdirSync(queueDir, { recursive: true });
  // 时间戳里的冒号在 Windows 上不能进文件名（实测 ENOENT），换成连字符；
  // ISO 其余部分定长，按文件名排序判先后不受影响。
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const name = `${stamp}-${process.hrtime.bigint()}-${randomUUID().slice(0, 8)}.json`;
  const file = path.join(queueDir, name);
  writeJsonAtomic(file, { text, task: task ?? null, timeoutSec: timeoutSec ?? null, steer, queuedAt: new Date().toISOString() });
  return file;
}

/** 队列里最早一条的路径；空返回 null。文件名是 ISO 时间戳 + hrtime，排序即先后。 */
export function nextQueueFile(queueDir) {
  const entries = readdirSync(queueDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return entries[0] ? path.join(queueDir, entries[0]) : null;
}

/** 取出时把 attempts 加一并落盘，返回该项；崩溃后重投次数不丢（T2.3b 第 9 条）。 */
export function bumpAttempts(file) {
  const item = readJsonOrNull(file) ?? {};
  item.attempts = (item.attempts ?? 0) + 1;
  writeJsonAtomic(file, item);
  return item;
}

/** 队列里最早的 steer 项；没有返回 null。 */
export function nextSteerFile(queueDir) {
  for (const f of readdirSync(queueDir).filter((f) => f.endsWith('.json')).sort()) {
    const file = path.join(queueDir, f);
    const item = readJsonOrNull(file);
    if (item?.steer) return { file, item };
  }
  return null;
}
