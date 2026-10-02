// lib/cli/watch.mjs —— watch 子命令（外壳层，SPEC-watch-pane D）：只读、常驻，盯登记簿里所有
// 会话，某条的快照有变化就输出一次完整快照；观察面板 mod（hooks/register.mjs）唯一的数据来源。
// 快照内容与事件读取归 lib/snapshot.mjs，所属仓库 repo 用 common.mjs 的 repoOf 现算（带缓存）。
// 不负责：快照字段、面板的过滤与渲染；不写任何文件，不碰协议层，不花额度。
// 退出（都以 0 退，不打堆栈）：读的一方断开（stdout EPIPE）、父进程没了（ppid 变 1，被
// init/launchd 收养）、SIGTERM/SIGINT。不靠 stdin——mod 起子进程时 stdin 一开始就是关的。
// 出错：单条会话读文件出错只跳过这条（stderr 一行 watch: <id> <原因>）；登记簿连续 10 轮
// 读不出以 1 退出（RULES §5：1 是起不来）。
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadConfig } from '../config.mjs';
import { loadRegistry } from '../registry.mjs';
import { readState, runsDirOf } from '../runs.mjs';
import { createTurnReader, snapshotOf } from '../snapshot.mjs';
import { parseFlags, repoOf, worktreeStatus } from './common.mjs';

const pollMs = Number(process.env.ZCODE_EXECUTOR_WATCH_POLL_MS) || 200;
const idleMs = Number(process.env.ZCODE_EXECUTOR_WATCH_IDLE_MS) || 2000;
const debounceMs = Number(process.env.ZCODE_EXECUTOR_WATCH_DEBOUNCE_MS) || 300;
const REGISTRY_MAX_FAILURES = 10;
const PHASE_TEXT = {
  running: '执行中',
  pending: '挂起',
  stale: '执行进程已中断',
  idle: '空闲',
  exited: '已结束',
};

/** 文件指纹：大小 + 修改时间；读不到（没建/被删）算一种固定值。 */
function fileSig(filePath) {
  try {
    const s = statSync(filePath);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

const filesSig = (home, id, names) => names.map((n) => fileSig(path.join(runsDirOf(home, id), n))).join('|');

/** 进行中判定（SPEC D）：state.json 的 phase 是 running/pending，或有 pending.json；读不到就当不在进行中。 */
function isActive(home, id) {
  const dir = runsDirOf(home, id);
  if (existsSync(path.join(dir, 'pending.json'))) return true;
  const state = readState(home, id); // 容错读：坏 JSON / 没有都返回 null
  return state?.phase === 'running' || state?.phase === 'pending';
}

/** 人读摘要一行（SPEC D 的例：x_af149b61 执行中 T4-board-display ▸ Edit src/board/CardFlow.tsx）。 */
function humanLine(snap) {
  const phaseText = PHASE_TEXT[snap.phase] ?? snap.phase;
  const task = snap.task ? ` ${path.basename(snap.task, path.extname(snap.task))}` : '';
  const tool = snap.activeTool ? ` ▸ ${snap.activeTool.toolName}${snap.activeTool.summary ? ` ${snap.activeTool.summary}` : ''}` : '';
  return `${snap.id} ${phaseText}${task}${tool}`;
}

export async function run(argv) {
  const { json } = parseFlags(argv, { boolean: ['--json'] });
  const home = loadConfig().home;
  const registryPath = path.join(home, 'sessions.json');

  let alive = true;
  const exitNow = (code) => {
    alive = false;
    process.exit(code); // 常驻进程：直接退，不等句柄（stdout 已断时挂着也没意义）
  };
  process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE') exitNow(0); // 读的一方走了
    else throw err;
  });
  process.on('SIGTERM', () => exitNow(0));
  process.on('SIGINT', () => exitNow(0));

  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

  const sessions = new Map(); // id → { entry, json, lastSentAt, pendingSnap, reader, running, finalEvents, filesSig, idleCheckedAt }
  let firstRound = true;
  let registrySig = null; // 上次见过的 sessions.json 指纹
  let registryBroken = false; // 上次读坏了：指纹比对不可信，之后每轮都重试
  let registryFailures = 0;

  if (json) write({ type: 'hello', repo: worktreeStatus(process.cwd()).repo });

  const emit = (st, snap, shown) => {
    st.shown = shown;
    st.lastSentAt = Date.now();
    if (json) write({ type: 'session', session: snap });
    else process.stdout.write(`${shown}\n`);
  };

  const round = () => {
    if (process.ppid === 1) exitNow(0); // 父进程没了（被 init/launchd 收养）

    // ① 登记簿：指纹变了才重读；上次读坏了就每轮重试，连续 10 轮失败以 1 退出
    let entries = null;
    try {
      const sig = fileSig(registryPath);
      if (registryBroken || sig !== registrySig) {
        // null 或没有字符串 id 的条目跳过：坏一条不能让整个循环炸掉
        entries = Object.values(loadRegistry(home).sessions).filter((e) => e && typeof e.id === 'string');
        registrySig = sig;
        registryBroken = false;
        registryFailures = 0;
      }
    } catch (err) {
      registryFailures += 1;
      registryBroken = true;
      console.error(`watch: 登记簿读不出来（${err?.message ?? err}）`);
      if (registryFailures >= REGISTRY_MAX_FAILURES) {
        console.error(`watch: 登记簿连续 ${REGISTRY_MAX_FAILURES} 轮读不出来，退出`);
        exitNow(1);
      }
    }

    if (entries) {
      for (const id of [...sessions.keys()]) {
        if (!entries.some((e) => e.id === id)) {
          sessions.delete(id); // 读取器与攒着的输出一起释放（长回合的事件数组不小）
          if (json) write({ type: 'removed', id });
        }
      }
      for (const e of entries) {
        const st = sessions.get(e.id);
        if (st) {
          if (JSON.stringify(st.entry) !== JSON.stringify(e)) {
            // entry 内容变了（比如 lastOutcome 改了）：清指纹、归零空闲比对时间，下一轮重算
            st.entry = e;
            st.filesSig = null;
            st.idleCheckedAt = 0;
          }
        } else {
          sessions.set(e.id, { entry: e, shown: null, lastSentAt: 0, pendingSnap: null, reader: null, running: false, finalEvents: null, filesSig: null, idleCheckedAt: 0 });
        }
      }
    }

    // ② 去抖到点的先输出：窗口里攒的最新那份
    const nowMs = Date.now();
    for (const st of sessions.values()) {
      if (st.pendingSnap && nowMs - st.lastSentAt >= debounceMs) {
        emit(st, st.pendingSnap.snap, st.pendingSnap.shown);
        st.pendingSnap = null;
      }
    }

    // ③ 每条会话算快照
    for (const st of sessions.values()) {
      const id = st.entry.id;
      try {
        const now = Date.now();
        const active = isActive(home, id);
        let justEnded = false;
        if (active) {
          st.running = true;
        } else if (st.running) {
          justEnded = true; // 上轮还在跑：这轮把结束时的事件读完整，回复才算得全
          st.running = false;
        } else {
          // 一直闲着：到点才比对四个文件的指纹，没变不算变化
          if (now - st.idleCheckedAt < idleMs) continue;
          st.idleCheckedAt = now;
          const sig = filesSig(home, id, ['state.json', 'last.json', 'pending.json', 'offpeak.json']);
          if (sig === st.filesSig) continue;
          st.filesSig = sig;
        }

        // 事件只读进行中的（文件最大 121MB）；会话结束后保留最后一次读到的，回复不回退
        let turnEvents;
        if (active || justEnded) {
          st.reader ??= createTurnReader(path.join(runsDirOf(home, id), 'events.jsonl'));
          turnEvents = st.reader.read().events;
          st.finalEvents = turnEvents;
        } else {
          turnEvents = st.finalEvents; // 从没跑过的会话是 null：reply 回退 lastText（SPEC D）
        }

        const snap = snapshotOf({ home, entry: st.entry, repo: repoOf(st.entry), turnEvents });
        const shown = json ? JSON.stringify(snap) : humanLine(snap); // 人读模式按那行文字去重，快照里的时间戳变了但文字没变不打
        if (shown === st.shown) {
          st.pendingSnap = null; // 和已输出的相同：去抖里挂着的过期快照也作废
          continue; // 内容没变不输出
        }
        if (firstRound || now - st.lastSentAt >= debounceMs) {
          emit(st, snap, shown); // 首轮不去抖
        } else {
          st.pendingSnap = { snap, shown }; // 窗口没到：先记下，到点输出最新的
        }
      } catch (err) {
        console.error(`watch: ${id} ${err?.message ?? err}`); // 这一条本轮跳过，别拖垮整个 watch
      }
    }

    if (firstRound && !registryBroken) {
      // 登记簿成功读过才算首轮完结：一直坏着就一直不发 synced——下游 mod 把
      // 「synced 之前结束」当起不来（只提示一次），「synced 之后结束」才当断开重起
      firstRound = false;
      if (json) write({ type: 'synced' });
    }
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (alive) {
    round();
    if (!alive) break;
    await sleep(pollMs);
  }
}
