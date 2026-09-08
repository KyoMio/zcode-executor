// 本文件负责：runs/<本地 id>/ 目录的布局与文件原语——路径（runsDirOf）、纯读（readJsonOrNull、
// readState、readLast）、runner 存活判断（livePidOf）、phase 判定（phaseOf，status/list 共用）、
// 事件尾读（tailEvents，--stream 与 status 共用）、容错删除（removeFileIfExists）、
// 事件追加（appendEvent）、锁的原子创建（tryLinkLock）。从 lib/run.mjs 拆出（T2.7 第 5 条）。
// 不负责：队列（归 lib/queue.mjs）、runner 的一生（归 lib/run.mjs）、退出码表与命令行解析。
// 被依赖方：lib/run.mjs、lib/queue.mjs、lib/cli 的各子命令。只依赖 lib/errors.mjs。
import { appendFileSync, closeSync, existsSync, linkSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';

/** 纯读一个 JSON 文件：不存在或半截都返回 null；写入侧全部走原子落盘。 */
export function readJsonOrNull(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** <home>/runs/<sessionId> 目录。 */
export function runsDirOf(home, sessionId) {
  return path.join(home, 'runs', sessionId);
}

/** 读 lock 里的 pid：进程活着返回 pid，死了/没有锁/内容坏的返回 null。 */
export function livePidOf(home, sessionId) {
  const lock = readJsonOrNull(path.join(runsDirOf(home, sessionId), 'lock'));
  const pid = lock?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    return err?.code === 'EPERM' ? pid : null; // EPERM = 存在但不是我们的，也算活着
  }
}

/** 纯读 runs/<id>/state.json；没有返回 null。 */
export function readState(home, sessionId) {
  return readJsonOrNull(path.join(runsDirOf(home, sessionId), 'state.json'));
}

/** 纯读 runs/<id>/last.json；没有返回 null。 */
export function readLast(home, sessionId) {
  return readJsonOrNull(path.join(runsDirOf(home, sessionId), 'last.json'));
}

/**
 * 会话 phase 判定（status 与 list 共用，T2.4）：pending.json 在 → pending；
 * state 说 running/pending 而 pid 死了 → stale；没有 state → idle；其余按 state.phase。
 */
export function phaseOf(home, sessionId) {
  const dir = runsDirOf(home, sessionId);
  if (existsSync(path.join(dir, 'pending.json'))) {
    // 挂起也一样看 pid：runner 死了挂起就没人消费了，报 stale（T2.4c 第 7 条）
    return livePidOf(home, sessionId) ? 'pending' : 'stale';
  }
  const state = readState(home, sessionId);
  if (!state) return 'idle';
  if (state.phase === 'running' || state.phase === 'pending') {
    return livePidOf(home, sessionId) ? 'running' : 'stale';
  }
  return state.phase;
}

/**
 * 从字节偏移读 events.jsonl 的新增完整行（--stream 与 status 共用，T2.4）。
 * 返回 { events, nextOffset }：nextOffset 指向下一个没读到的字节（半截行留给下次）。
 */
export function tailEvents(home, sessionId, opts = {}) {
  return tailEventsFromFile(path.join(runsDirOf(home, sessionId), 'events.jsonl'), opts);
}

/** 同 tailEvents，但直接给 events.jsonl 的路径（intent.mjs 只拿得到路径，T2.9 第 10 条）。 */
export function tailEventsFromFile(filePath, { fromOffset = 0 } = {}) {
  let size;
  try {
    size = statSync(filePath).size; // 先比大小，没长出增量就直接返回
  } catch {
    return { events: [], nextOffset: fromOffset };
  }
  if (size <= fromOffset) return { events: [], nextOffset: fromOffset };
  const len = size - fromOffset;
  const buf = Buffer.alloc(len);
  let bytesRead;
  try {
    const fd = openSync(filePath, 'r');
    try {
      bytesRead = readSync(fd, buf, 0, len, fromOffset); // 带 position 只读增量
    } finally {
      closeSync(fd);
    }
  } catch {
    return { events: [], nextOffset: fromOffset };
  }
  const text = buf.subarray(0, bytesRead).toString('utf8');
  const cut = text.lastIndexOf('\n');
  if (cut === -1) return { events: [], nextOffset: fromOffset }; // 半截行：等下次
  const events = text
    .slice(0, cut)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l); // 坏 JSON 行跳过，不拖垮整段
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { events, nextOffset: fromOffset + Buffer.byteLength(text.slice(0, cut + 1), 'utf8') };
}

/** 容错删除：文件不存在不报错。runner 与外壳所有「删掉它」的语义都走这里（T2.4c 第 2 条）。 */
export function removeFileIfExists(filePath) {
  try {
    unlinkSync(filePath);
  } catch {
    // 已没了
  }
}

/** 追加一条事件进 events.jsonl（RULES §6：只追加，一行一个对象）。 */
export function appendEvent(eventsPath, event) {
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`);
}

/**
 * 锁的原子创建（评审 T2.3b 第 4 条）：写临时文件再 linkSync 成 lock——linkSync 目标已存在即
 * EEXIST，判定无竞态窗口。成功后读回确认 pid 是自己的。
 */
export function tryLinkLock(lockPath) {
  const tmp = path.join(path.dirname(lockPath), `.lock-${process.pid}-${randomUUID().slice(0, 8)}`);
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    linkSync(tmp, lockPath);
  } catch (err) {
    unlinkSync(tmp);
    if (err?.code !== 'EEXIST') throw err;
    return false;
  }
  unlinkSync(tmp);
  const got = readJsonOrNull(lockPath);
  if (got?.pid !== process.pid) {
    removeFileIfExists(lockPath);
    throw new ExecutorError(`lock 内容异常（pid ${got?.pid ?? '未知'}），并发被破坏，退出重试`, 2);
  }
  return true;
}
