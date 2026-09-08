// 本文件负责：登记簿——<home>/sessions.json 的读写（loadRegistry / saveSession / getSession），
// 形状见 SPEC「存储」：{ sessions: { [sessionId]: entry } }，entry 字段见 new 的登记项。
// 不负责：登记簿之外的一切落盘（events / pending / queue 在 runs/<id>/，归后续 runner）、
// 会话的创建本身。被依赖方：bin/zcode-executor（new / list）、后续 runner。
// 依赖 lib/errors.mjs、lib/config.mjs（writeJsonAtomic 原子落盘）。
import { mkdirSync, openSync, readFileSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { ExecutorError } from './errors.mjs';
import { writeJsonAtomic } from './config.mjs';

const SAVE_LOCK_RETRY_MS = 20;
const SAVE_LOCK_TIMEOUT_MS = 5000;
const syncSleep = (ms) => {
  // saveSession 是同步函数（bin 与 runner 都在同步路径上调），同步睡用 Atomics.wait
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** 登记簿文件路径：<home>/sessions.json。 */
export function registryPath(home) {
  return path.join(home, 'sessions.json');
}

/**
 * 读登记簿。文件不存在返回空登记簿 { sessions: {} }（第一次 new 之前是常态，不算错）；
 * 坏 JSON 抛 ExecutorError(1) 并说明文件路径。
 */
export function loadRegistry(home) {
  let raw;
  try {
    raw = readFileSync(registryPath(home), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { sessions: {} };
    throw new ExecutorError(`读不了登记簿 ${registryPath(home)}：${err.message}`, 1);
  }
  let given;
  try {
    given = JSON.parse(raw);
  } catch {
    throw new ExecutorError(`登记簿不是合法 JSON：${registryPath(home)}。修好或删掉这个文件（删掉后旧会话要用 zcode 原生方式找回）`, 1);
  }
  if (given === null || typeof given !== 'object' || Array.isArray(given) || typeof given.sessions !== 'object' || given.sessions === null) {
    throw new ExecutorError(`登记簿形状不对（要有 sessions 对象）：${registryPath(home)}`, 1);
  }
  return given;
}

/**
 * 写入（或覆盖）一条登记项并原子落盘，返回该条目。键是本地派单 id（entry.id，D13），
 * 同 id 覆盖旧条目。读改写全程持 <home>/sessions.lock（评审 T2.2b 第 3 条）：并发 new 都走
 * 读改写，不加锁会互相覆盖丢会话。拿不到锁隔 20ms 重试最多 5 秒， finally 删锁。
 */
export function saveSession(home, entry) {
  mkdirSync(home, { recursive: true });
  const lockPath = path.join(home, 'sessions.lock');
  const deadline = Date.now() + SAVE_LOCK_TIMEOUT_MS;
  let lockFd;
  for (;;) {
    try {
      lockFd = openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        throw new ExecutorError(`等不到登记簿锁（${SAVE_LOCK_TIMEOUT_MS}ms）：${lockPath}。可能有不正常的残留，确认没有并发 new 后删掉它`, 1);
      }
      syncSleep(SAVE_LOCK_RETRY_MS);
    }
  }
  try {
    const registry = loadRegistry(home);
    registry.sessions[entry.id] = entry;
    writeJsonAtomic(registryPath(home), registry);
  } finally {
    closeSync(lockFd);
    try {
      unlinkSync(lockPath);
    } catch {
      // 已没了
    }
  }
  return entry;
}

/** 纯读：按 id 取登记项；不在登记簿里抛 ExecutorError(2)，提示用 list 看有哪些。 */
export function getSession(home, sessionId) {
  const entry = loadRegistry(home).sessions[sessionId];
  if (!entry) {
    throw new ExecutorError(`会话 ${sessionId} 不在登记簿里，用 zcode-executor list 看有哪些`, 2);
  }
  return entry;
}

/**
 * 部分更新一条登记项（如 runner 写 lastOutcome），不在簿里同样抛 2。返回更新后的条目。
 * 同一条目同一时刻只有一个写者（T2.4d 第 9 条）：并发写由 saveSession 的登记簿锁串行化，
 * 调用方（常驻 runner、单发 CLI）各自不会同时改同一条目。
 */
export function updateSession(home, sessionId, patch) {
  return saveSession(home, { ...getSession(home, sessionId), ...patch });
}
