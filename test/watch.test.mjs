// test/watch.test.mjs —— watch 子命令的行为测试（SPEC-watch-pane D）：起 node bin/zcode-executor
// watch 子进程（ZCODE_EXECUTOR_HOME 指 mkdtemp 临时目录，轮询/去抖经环境变量调快），
// 按行收 stdout 等想要的行出现；不碰协议层，不花额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killAll, waitFor } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'zcode-executor');
const dirs = [];
const watchPids = [];
test.after(async () => {
  killAll(watchPids);
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const T = (n) => `2026-10-02T00:0${n}:00Z`;
const DEAD_PID = 999999999; // 照 run.test.mjs 的造法：肯定不存在的 pid
const SEND = { type: 'executor.send', at: T(0), text: '干活', task: null };
const delta = (text) => ({ type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: `${text}\n` } });
const SESSION_FILES = { state: 'state.json', last: 'last.json', pending: 'pending.json', offpeak: 'offpeak.json', lock: 'lock', events: 'events.jsonl' };
const EXITED_STATE = { sessionId: 's', pid: DEAD_PID, phase: 'exited', startedAt: T(0), updatedAt: T(0), current: null };
const EXITED_LAST = (endedAt) => ({ outcome: 'done', lastText: null, startedAt: T(0), endedAt, task: null });

async function makeHome(entries = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-watch-home-'));
  dirs.push(home);
  await writeFile(path.join(home, 'sessions.json'), JSON.stringify({ sessions: entries }));
  return home;
}

const entryOf = (id) => ({ id, sessionId: null, title: 't', cwd: null });

/** 造 runs/<id>/ 下的文件；events 是事件数组（逐行 JSON），字符串值原样写（造坏 JSON 用）。 */
async function makeSession(home, id, files = {}) {
  const dir = path.join(home, 'runs', id);
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (content === undefined) continue;
    const target = path.join(dir, SESSION_FILES[name] ?? name);
    if (name === 'events') {
      await writeFile(target, content.map((e) => `${JSON.stringify(e)}\n`).join(''));
    } else if (typeof content === 'string') {
      await writeFile(target, content);
    } else {
      await writeFile(target, JSON.stringify(content));
    }
  }
  return dir;
}

const exitedSession = (id, endedAt = T(1)) => ({
  [id]: entryOf(id),
  __files: async (home) => makeSession(home, id, { state: { ...EXITED_STATE, sessionId: id }, last: EXITED_LAST(endedAt) }),
});

/**
 * 起 watch 子进程：按行收 stdout、stderr，waitForLine 等想要的行出现（带超时，先查已有的行）。
 * 返回 { child, lines, stderrLines, exited, waitForLine }；exited 是退出码的 Promise。
 */
function startWatch(home, { json = true, cwd } = {}) {
  const child = spawn(process.execPath, [BIN, 'watch', ...(json ? ['--json'] : [])], {
    cwd: cwd ?? home, // hello 的 repo 按进程 cwd 的所属仓库算
    env: {
      ...process.env,
      ZCODE_EXECUTOR_HOME: home,
      ZCODE_EXECUTOR_WATCH_POLL_MS: '50',
      ZCODE_EXECUTOR_WATCH_IDLE_MS: '100',
      ZCODE_EXECUTOR_WATCH_DEBOUNCE_MS: '150',
    },
    stdio: ['ignore', 'pipe', 'pipe'], // mod 起子进程时 stdin 一开始就是关的，watch 也不看它
  });
  watchPids.push(child.pid);
  const lines = [];
  const stderrLines = [];
  const waiters = [];
  let outBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    outBuf += chunk;
    let idx;
    while ((idx = outBuf.indexOf('\n')) !== -1) {
      const line = outBuf.slice(0, idx);
      outBuf = outBuf.slice(idx + 1);
      if (!line) continue;
      lines.push(line);
      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch {
        // 人读行不是 JSON
      }
      for (const w of [...waiters]) {
        let hit = false;
        try {
          hit = w.test(obj, line);
        } catch {
          hit = false; // 判定抛错当不匹配
        }
        if (hit) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve({ obj, line });
        }
      }
    }
  });
  let errBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errBuf += chunk;
    let idx;
    while ((idx = errBuf.indexOf('\n')) !== -1) {
      stderrLines.push(errBuf.slice(0, idx));
      errBuf = errBuf.slice(idx + 1);
    }
  });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const waitForLine = (matches, { timeoutMs = 5000 } = {}) => {
    const parse = (line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    };
    for (const line of lines) {
      const obj = parse(line);
      if (matches(obj, line)) return Promise.resolve({ obj, line });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error(`waitForLine 超时（${timeoutMs}ms）。已有 ${lines.length} 行，末尾：${lines.slice(-4).join(' | ').slice(0, 500)}`));
      }, timeoutMs);
      timer.unref(); // 等到行了就 clearTimeout；没等到也不让这个计时器拖住进程
      const waiter = {
        test: matches,
        resolve: (hit) => {
          clearTimeout(timer);
          resolve(hit);
        },
      };
      waiters.push(waiter);
    });
  };
  return { child, lines, stderrLines, exited, waitForLine };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** promise 与超时赛跑：谁先到算谁，赢的一方清掉计时器，不给事件循环留尾巴（RULES §3）。 */
function withinTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

// ---------- 输出的骨架 ----------

test('watch --json：第一行 hello（带启动目录的所属仓库）、首轮每会话一行、然后 synced', async (t) => {
  const workParent = await mkdtemp(path.join(os.tmpdir(), 'zcode-watch-cwd-'));
  dirs.push(workParent);
  const repo = path.join(workParent, 'repo');
  execFileSync('git', ['init', '--quiet', repo]);
  const repoReal = realpathSync(repo); // macOS /var → /private/var
  const home = await makeHome({ x_00000001: entryOf('x_00000001'), x_00000002: entryOf('x_00000002') });
  await makeSession(home, 'x_00000001', { state: { ...EXITED_STATE, sessionId: 'x_00000001' }, last: EXITED_LAST(T(1)) });
  await makeSession(home, 'x_00000002', { state: { ...EXITED_STATE, sessionId: 'x_00000002' }, last: EXITED_LAST(T(1)) });
  const w = startWatch(home, { cwd: repoReal });
  const hello = await w.waitForLine((o) => o?.type === 'hello');
  assert.equal(hello.obj.repo, repoReal); // cwd 就是主仓库时 repo 是它自己
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000001');
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000002');
  const synced = await w.waitForLine((o) => o?.type === 'synced');
  assert.ok(w.lines.indexOf(hello.line) < w.lines.indexOf(synced.line));
  assert.equal(JSON.parse(w.lines[0]).type, 'hello'); // hello 是第一行
});

// ---------- 空闲会话 ----------

test('watch --json：空闲会话改 last.json 出新行；重写同样内容不出新行', async (t) => {
  const home = await makeHome({ x_00000001: entryOf('x_00000001') });
  const lastPath = path.join(home, 'runs', 'x_00000001', 'last.json');
  await makeSession(home, 'x_00000001', { state: { ...EXITED_STATE, sessionId: 'x_00000001' }, last: EXITED_LAST(T(1)) });
  const w = startWatch(home);
  await w.waitForLine((o) => o?.type === 'synced');
  const afterSync = w.lines.length;
  const next = { ...EXITED_LAST(T(2)) };
  await writeFile(lastPath, JSON.stringify(next));
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000001' && o.session.lastEndedAt === T(2));
  const afterChange = w.lines.length;
  await writeFile(lastPath, JSON.stringify(next)); // 同样内容再写一遍：指纹变了、快照没变
  await sleep(400); // 给几轮轮询的机会
  assert.equal(w.lines.length, afterChange); // 没有新行
  assert.ok(afterChange > afterSync);
});

// ---------- 进行中会话 ----------

const runningSession = (home, id, extraEvents = []) =>
  makeSession(home, id, {
    lock: { pid: process.pid }, // 活 pid：测试进程自己
    state: { sessionId: id, pid: process.pid, phase: 'running', startedAt: T(0), updatedAt: T(0), current: null },
    events: [SEND, delta('第一行'), ...extraEvents],
  });

test('watch --json：进行中会话追加事件出新快照，reply 变了', async (t) => {
  const home = await makeHome({ x_00000002: entryOf('x_00000002') });
  const eventsPath = path.join(home, 'runs', 'x_00000002', 'events.jsonl');
  await runningSession(home, 'x_00000002');
  const w = startWatch(home);
  await w.waitForLine((o) => o?.type === 'synced');
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000002' && JSON.stringify(o.session.reply) === JSON.stringify(['第一行']));
  await appendFile(eventsPath, `${JSON.stringify(delta('第二行'))}\n`);
  await w.waitForLine(
    (o) => o?.type === 'session' && o.session.id === 'x_00000002' && JSON.stringify(o.session.reply) === JSON.stringify(['第一行', '第二行']),
  );
});

test('watch --json：去抖窗口内连写三次，同一会话只出一到两行且最后一行最新', async (t) => {
  const home = await makeHome({ x_00000003: entryOf('x_00000003') });
  const eventsPath = path.join(home, 'runs', 'x_00000003', 'events.jsonl');
  await runningSession(home, 'x_00000003');
  const w = startWatch(home);
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000003'); // 首轮那行
  const baseline = w.lines.length;
  for (const text of ['快1', '快2', '快3']) {
    await appendFile(eventsPath, `${JSON.stringify(delta(text))}\n`);
    await sleep(40); // 150ms 的去抖窗口内连写三次
  }
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000003' && o.session.reply.at(-1) === '快3');
  await sleep(300); // 等可能还没到点的输出都出来
  const burst = w.lines.slice(baseline).filter((l) => l.includes('"x_00000003"'));
  assert.ok(burst.length >= 1 && burst.length <= 2, `去抖失效：出了 ${burst.length} 行`);
  assert.equal(JSON.parse(burst.at(-1)).session.reply.at(-1), '快3'); // 最后一行是最新内容
});

// ---------- 登记簿增删 ----------

test('watch --json：登记簿删会话出 removed，加会话出它的快照', async (t) => {
  const home = await makeHome({ x_00000004: entryOf('x_00000004'), x_00000005: entryOf('x_00000005') });
  await makeSession(home, 'x_00000004', { state: { ...EXITED_STATE, sessionId: 'x_00000004' }, last: EXITED_LAST(T(1)) });
  await makeSession(home, 'x_00000005', { state: { ...EXITED_STATE, sessionId: 'x_00000005' }, last: EXITED_LAST(T(1)) });
  const w = startWatch(home);
  await w.waitForLine((o) => o?.type === 'synced');
  await writeFile(path.join(home, 'sessions.json'), JSON.stringify({ sessions: { x_00000004: entryOf('x_00000004') } }));
  await w.waitForLine((o) => o?.type === 'removed' && o.id === 'x_00000005');
  await makeSession(home, 'x_00000006', { state: { ...EXITED_STATE, sessionId: 'x_00000006' }, last: EXITED_LAST(T(1)) });
  await writeFile(
    path.join(home, 'sessions.json'),
    JSON.stringify({ sessions: { x_00000004: entryOf('x_00000004'), x_00000006: entryOf('x_00000006') } }),
  );
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000006');
});

// ---------- stale ----------

test('watch --json：state 写 running 而 lock 里是已退出的 pid → phase stale', async (t) => {
  const home = await makeHome({ x_00000007: entryOf('x_00000007') });
  const w = startWatch(home);
  await w.waitForLine((o) => o?.type === 'synced');
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((resolve) => dead.once('exit', resolve)); // 先等它退干净，pid 才是死的
  await makeSession(home, 'x_00000007', {
    lock: { pid: dead.pid },
    state: { sessionId: 'x_00000007', pid: dead.pid, phase: 'running', startedAt: T(0), updatedAt: T(2), current: null },
  });
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000007' && o.session.phase === 'stale');
});

// ---------- 出错与退出 ----------

test('watch --json：登记簿坏 JSON 先打 stderr 不退出，持续坏下去约 10 轮后以 1 退出', async (t) => {
  const home = await makeHome({ x_00000001: entryOf('x_00000001') });
  await makeSession(home, 'x_00000001', { state: { ...EXITED_STATE, sessionId: 'x_00000001' }, last: EXITED_LAST(T(1)) });
  const w = startWatch(home);
  await w.waitForLine((o) => o?.type === 'synced');
  await writeFile(path.join(home, 'sessions.json'), '{broken');
  await waitFor(() => (w.stderrLines.some((l) => l.startsWith('watch:')) ? w.stderrLines : undefined));
  const early = await withinTimeout(w.exited, 250, 'alive');
  assert.equal(early, 'alive'); // 第一轮读坏不退出
  const code = await withinTimeout(w.exited, 8000, 'timeout');
  assert.equal(code, 1); // 持续坏下去：10 轮后以 1 退出
});

test('watch --json：启动时登记簿就是坏的 → 不发 synced，以 1 退出', async (t) => {
  const home = await makeHome();
  await writeFile(path.join(home, 'sessions.json'), '{broken');
  const w = startWatch(home);
  const code = await withinTimeout(w.exited, 8000, 'timeout');
  assert.equal(code, 1);
  assert.equal(w.lines.some((l) => l.includes('"synced"')), false); // 首轮没读成：synced 永远不发
});

test('watch --json：读端关闭后触发一次变化，进程以 0 退出（EPIPE）', async (t) => {
  const home = await makeHome({ x_00000001: entryOf('x_00000001') });
  const lastPath = path.join(home, 'runs', 'x_00000001', 'last.json');
  await makeSession(home, 'x_00000001', { state: { ...EXITED_STATE, sessionId: 'x_00000001' }, last: EXITED_LAST(T(1)) });
  const w = startWatch(home);
  await w.waitForLine((o) => o?.type === 'synced');
  w.child.stdout.destroy();
  await writeFile(lastPath, JSON.stringify(EXITED_LAST(T(3)))); // 触发一次变化，写已断的管道
  const code = await withinTimeout(w.exited, 5000, 'timeout');
  assert.equal(code, 0);
});

// ---------- 快照内容 ----------

test('watch --json：会话在运行期间结束，reply 保留事件里算好的那几行', async (t) => {
  const home = await makeHome({ x_00000008: entryOf('x_00000008') });
  const dir = path.join(home, 'runs', 'x_00000008');
  await runningSession(home, 'x_00000008');
  const w = startWatch(home);
  await w.waitForLine((o) => o?.type === 'synced');
  await appendFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(delta('第二行'))}\n`);
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000008' && o.session.reply.at(-1) === '第二行');
  // 回合结束：state 改 exited、写 last.json——lastText 与事件里的回复不同
  await writeFile(path.join(dir, 'state.json'), JSON.stringify({ sessionId: 'x_00000008', pid: DEAD_PID, phase: 'exited', startedAt: T(0), updatedAt: T(2), current: null }));
  await writeFile(path.join(dir, 'last.json'), JSON.stringify({ outcome: 'done', lastText: '拼接成一条的尾巴', startedAt: T(0), endedAt: T(2), task: null }));
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000008' && o.session.phase === 'exited');
  const finalLine = w.lines.filter((l) => l.includes('"x_00000008"')).at(-1);
  const finalSnap = JSON.parse(finalLine).session;
  assert.deepEqual(finalSnap.reply, ['第一行', '第二行']); // 保留事件里的回复，不回退 lastText
  assert.equal(finalSnap.lastEndOutcome, 'done'); // SPEC 新增字段：结束结果
});

test('watch --json：有 pending.json 的会话快照 phase 是 pending', async (t) => {
  const home = await makeHome({ x_00000009: entryOf('x_00000009') });
  await makeSession(home, 'x_00000009', {
    lock: { pid: process.pid },
    state: { sessionId: 'x_00000009', pid: process.pid, phase: 'running', startedAt: T(0), updatedAt: T(0), current: null },
    pending: { kind: 'permission', requestId: 'req_1', at: T(1), stage: 'hard', why: '越界', toolName: 'Write', input: { file_path: 'x' }, reason: '副作用', options: [] },
  });
  const w = startWatch(home);
  await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_00000009' && o.session.phase === 'pending');
});

test('watch --json：hello.repo 与同仓库会话快照的 repo 相等（真 git 仓库）', async (t) => {
  const workParent = await mkdtemp(path.join(os.tmpdir(), 'zcode-watch-repo-'));
  dirs.push(workParent);
  const repo = path.join(workParent, 'repo');
  execFileSync('git', ['init', '--quiet', repo]);
  const repoReal = realpathSync(repo);
  const home = await makeHome({ x_0000000a: { id: 'x_0000000a', sessionId: null, title: 't', cwd: repoReal } });
  await makeSession(home, 'x_0000000a', { state: { ...EXITED_STATE, sessionId: 'x_0000000a' }, last: EXITED_LAST(T(1)) });
  const w = startWatch(home, { cwd: repoReal });
  const hello = await w.waitForLine((o) => o?.type === 'hello');
  const snap = await w.waitForLine((o) => o?.type === 'session' && o.session.id === 'x_0000000a');
  assert.equal(hello.obj.repo, repoReal);
  assert.equal(snap.obj.session.repo, repoReal); // 会话所属仓库与 hello 同一口径（都是真实路径）
});

// ---------- 人读输出 ----------

test('watch 不带 --json：人读文字变化才出新行，不含 JSON', async (t) => {
  const home = await makeHome({ x_00000001: entryOf('x_00000001') });
  const dir = path.join(home, 'runs', 'x_00000001');
  await makeSession(home, 'x_00000001', {}); // 没有任何状态文件：首轮是「空闲」
  const w = startWatch(home, { json: false });
  const first = await w.waitForLine((o, line) => line.startsWith('x_00000001'));
  assert.ok(first.line.includes('空闲'), `首轮该是空闲：${first.line}`);
  // 阶段从 idle 变 exited：人读文字确实变了，必须出新行
  await makeSession(home, 'x_00000001', {
    state: { ...EXITED_STATE, sessionId: 'x_00000001' },
    last: EXITED_LAST(T(1)),
  });
  const next = await w.waitForLine((o, line) => line.startsWith('x_00000001') && line.includes('已结束'));
  assert.notEqual(next.line, first.line);
  assert.ok(w.lines.every((l) => !l.trimStart().startsWith('{')), '人读模式不该有 JSON 行');
  assert.ok(w.lines.every((l) => !l.includes('"type"')));
});
