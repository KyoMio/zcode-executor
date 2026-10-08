// 本文件负责：runs/<本地 id>/ 目录的布局与文件原语——路径（runsDirOf）、纯读（readJsonOrNull、
// readState、readLast）、runner 存活判断（livePidOf）、phase 判定（phaseOf / phaseFromState，status/list/watch 共用）、
// 事件尾读（tailEvents，--stream 与 status 共用）、容错删除（removeFileIfExists）、
// 事件追加（appendEvent）、没开跑就终局的落盘（writeEndedLast）、锁的原子创建（tryLinkLock）、目录的建立与收紧（ensureRunsDir）、
// 任务单快照（snapshotTask / readTaskSnapshot，审计 D3）。从 lib/run.mjs 拆出（T2.7 第 5 条）。
// 不负责：队列（归 lib/queue.mjs）、runner 的一生（归 lib/run.mjs）、退出码表与命令行解析。
// 被依赖方：lib/run.mjs、lib/offpeak-send.mjs、lib/offpeak-run.mjs、lib/queue.mjs、lib/cli 的各子命令。只依赖 lib/errors.mjs 与 lib/config.mjs（原子写）。
import { appendFileSync, chmodSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, writeFileAtomic, writeJsonAtomic } from './config.mjs';

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

/**
 * 建好 <home>/runs/<sessionId> 并把它和 <home>/runs 收紧成只给当前用户（审计 D5），返回会话目录。
 * 新建的目录直接是 0700；chmod 是给旧版本留下的 0755 目录补的——里面早先落的 0644 文件也就没人进得来了。
 * 数据目录的根不动：默认的执行副本根 worktrees/ 也在它下面，别的用户（容器里的构建用户之类）可能要穿过它。
 */
export function ensureRunsDir(home, sessionId) {
  const dir = runsDirOf(home, sessionId);
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  for (const each of [path.dirname(dir), dir]) {
    try {
      chmodSync(each, PRIVATE_DIR_MODE);
    } catch {
      // 收不紧（目录不归当前用户之类）不拦投递：这层只是纵深，文件本身仍按 0600 落盘
    }
  }
  return dir;
}

const TASKS_DIR = 'tasks';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const sha256Of = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * 把任务单此刻的内容存进 <dir>/tasks/<sha256>.md，返回这个 sha256（审计 D3）。
 * 任务单照 skill 的要求放在执行副本里，执行端改得动；审批拿它当「用户说过的话」，所以依据要在投递那一刻
 * 留底、留在执行副本之外，之后只认这份（readTaskSnapshot）。执行端读的仍是原文件，不受影响。
 * 读不了抛 ExecutorError(1)。
 */
export function snapshotTask(dir, taskPath) {
  let content;
  try {
    content = readFileSync(taskPath);
  } catch (err) {
    throw new ExecutorError(`--task 文件读不了：${taskPath}：${err.message}`, 1);
  }
  const sha256 = sha256Of(content);
  const tasksDir = path.join(dir, TASKS_DIR);
  mkdirSync(tasksDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // 每次都重写：同名文件若被人动过，这里把它恢复成与名字相符的内容
  writeFileAtomic(path.join(tasksDir, `${sha256}.md`), content);
  return sha256;
}

/**
 * 读任务单快照的全文。sha256 不是 64 位十六进制、文件不在、内容与 sha256 对不上都返回 null——
 * 调用方（lib/intent.mjs）据此不把它当审批依据，不回头去读原文件。
 */
export function readTaskSnapshot(dir, sha256) {
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return null;
  let content;
  try {
    content = readFileSync(path.join(dir, TASKS_DIR, `${sha256}.md`));
  } catch {
    return null;
  }
  return sha256Of(content) === sha256 ? content.toString('utf8') : null;
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
  return phaseFromState(home, sessionId, readState(home, sessionId));
}

/** 同 phaseOf，但 state 由调用方读好传进来：watch 一轮只读一次 state，phase 与其他字段同源。 */
export function phaseFromState(home, sessionId, state) {
  if (existsSync(path.join(runsDirOf(home, sessionId), 'pending.json'))) {
    // 挂起也一样看 pid：runner 死了挂起就没人消费了，报 stale（T2.4c 第 7 条）
    return livePidOf(home, sessionId) ? 'pending' : 'stale';
  }
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
  appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, { mode: PRIVATE_FILE_MODE }); // mode 只在新建时生效
}

/**
 * 投递没开跑（或回合已不在 runner 手里）就终局时的落盘：last.json（与普通回合结算同形状，lastText/lastMessageText/usage/startedAt 为 null）
 * 加一条 executor.result。outcome 缺省 failed；闲时投递排号中被 cancel 是 cancelled。登记簿的 lastOutcome 与出队归调用方。
 */
export function writeEndedLast(dir, { reason, text, task, outcome = 'failed' }) {
  const at = new Date().toISOString();
  writeJsonAtomic(path.join(dir, 'last.json'), {
    kind: 'last', outcome, reason, lastText: null, lastMessageText: null, usage: null, startedAt: null, endedAt: at, text: text ?? '', task: task ?? null,
  });
  appendEvent(path.join(dir, 'events.jsonl'), { type: 'executor.result', at, outcome, reason });
}

/**
 * 锁的原子创建（评审 T2.3b 第 4 条）：写临时文件再 linkSync 成 lock——linkSync 目标已存在即
 * EEXIST，判定无竞态窗口。成功后读回确认 pid 是自己的。
 */
export function tryLinkLock(lockPath) {
  const tmp = path.join(path.dirname(lockPath), `.lock-${process.pid}-${randomUUID().slice(0, 8)}`);
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx', mode: PRIVATE_FILE_MODE });
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
