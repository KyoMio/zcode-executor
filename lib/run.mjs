// 本文件负责：runner 的一生——拿锁、登记簿与白名单复查、拉连接、挂起轮询、消费队列、
// 结算与收场（runSession，由 bin 的 _runner 子命令经 lib/cli/runner.mjs 调用）。
// 不负责：runs 目录的文件原语与纯读（归 lib/runs.mjs）、队列（归 lib/queue.mjs）、
// 退出码表与命令行解析（那些归 bin，本文件只抛错）、审批答案的产生（approve/deny/answer
// 只写 answer.json，这里只消费）、events 里 zcode 事件的产生（attachSession 落盘）。
// 被依赖方：lib/cli/runner.mjs。依赖 lib 的 config、registry、models、providers、gate、
// intent、pending、session、appserver（工作流 → 协议，向下依赖）。设计定案（T2.3，D12）：
// runner 一律后台，挂起时连接必须由 runner 保持不答，前台 --wait 以 5 返回后不能把连接带走，
// 所以前台永远不当 runner：send 入队 → 没有活着的 runner 就 detached 起一个。
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';
import { allowedRootFor, resolveWhitelist, writeJsonAtomic } from './config.mjs';
import { getSession, updateSession } from './registry.mjs';
import { loadZcodeConfig, resolveReviewModelRef } from './models.mjs';
import { buildRuntimeModel } from './providers.mjs';
import { createGate } from './gate.mjs';
import { createComplete } from './review/complete.mjs';
import { nodeProbe } from './review/evidence.mjs';
import { gatherIntent, gatherPriorActions } from './intent.mjs';
import { attachSession } from './session.mjs';
import { AppServerClient } from './appserver.mjs';
import { appendEvent, livePidOf, readJsonOrNull, removeFileIfExists, runsDirOf, tryLinkLock } from './runs.mjs';
import { bumpAttempts, MAX_ATTEMPTS, nextQueueFile, nextSteerFile } from './queue.mjs';

const ANSWER_POLL_MS = 300; // 任务单：挂起期间每 300ms 看一眼 answer.json
const STEER_POLL_MS = 500;  // 任务单 T2.4：回合进行中每 500ms 看一眼 steer 队列项与 cancel
// cancel 发 stop 后给回合的宽限。测试可用环境变量压短（T2.6b 第 10 条），正常 5 秒（T2.4c 第 3 条）
const CANCEL_GRACE_MS = Number(process.env.ZCODE_EXECUTOR_CANCEL_GRACE_MS) || 5000;

const now = () => new Date().toISOString();

/**
 * runner 的一生（任务单 T2.3 步骤 1–7 + 评审 T2.3b）：清 stop 与陈年 answer →
 * 临时文件 + linkSync 拿锁（活 runner 抛 2，死锁覆盖）→ 登记簿 + 白名单复查（RULES §8）→
 * state.json → spawn → 推 provider 表 → attach（评审 T2.3b 第 1 条）→
 * 挂起时每 300ms 消费 answer.json（requestId 必须与当前挂起一致）→
 * 循环消费队列（消费完才删；exited 保留重投；attempts 超过 2 按 failed 丢弃）→
 * close 之后再看一眼队列，非空回到循环重新拉连接 → phase exited、删 lock。
 * SIGTERM/SIGINT：session/stop 能发就发、phase exited 带 reason、删锁后退出（第 13 条）。
 */
export async function runSession({ home, config, sessionId }) {
  const dir = runsDirOf(home, sessionId);
  const queueDir = path.join(dir, 'queue');
  const lockPath = path.join(dir, 'lock');
  const statePath = path.join(dir, 'state.json');
  const eventsPath = path.join(dir, 'events.jsonl');
  const pendingPath = path.join(dir, 'pending.json');
  const answerPath = path.join(dir, 'answer.json');
  const lastPath = path.join(dir, 'last.json');
  const stopPath = path.join(dir, 'stop');
  const cancelPath = path.join(dir, 'cancel');
  mkdirSync(queueDir, { recursive: true });
  let state = null;
  let signaled = false; // SIGTERM/SIGINT 收尾已开始：state 以 exited+reason 定稿，不再被后续流程覆盖
  const writeState = (patch) => {
    if (signaled) return;
    state = {
      ...(state ?? { sessionId, pid: process.pid, startedAt: now(), current: null }),
      ...patch,
      updatedAt: now(),
    };
    writeJsonAtomic(statePath, state);
  };

  // 13. SIGTERM / SIGINT：能发 session/stop 就发，phase exited 带 reason，删锁后退出。
  //     装在拿锁之前：没装处理器时 SIGTERM 按系统默认直接杀进程，lock 一出现就来的信号
  //     会让 runner 死得不干净（CI 上复现过）
  let lockHeld = false;
  let sessionRef = null;
  let gate = null;
  const onSignal = (signal) => {
    if (signaled) return;
    signaled = true; // writeState 由此定稿：后续流程（投递/挂起轮询）不再改写 state
    try {
      sessionRef?.stop(); // fire-and-forget 通知，能发就发
    } catch {
      // 连接已经没了
    }
    // 终态直接写（writeState 已被 signaled 挡住，这里绕过它落终态）
    state = {
      ...(state ?? { sessionId, pid: process.pid, startedAt: now(), current: null }),
      phase: 'exited',
      reason: `收到 ${signal}，当前投递已发 session/stop`,
      updatedAt: now(),
    };
    if (lockHeld) {
      // 没拿到锁就不碰现场文件（T2.9 第 2 条）：state 和 lock 都是在跑 runner 的
      writeJsonAtomic(statePath, state);
      removeFileIfExists(lockPath);
    }
    setTimeout(() => process.exit(0), 200); // 给 stdin 一点冲刷时间
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));

  const bootAt = Date.now(); // 拿锁之前记下：晚于这一刻写的 stop / cancel 是给本 runner 的，不是陈年残留

  if (!tryLinkLock(lockPath)) {
    const pid = livePidOf(home, sessionId);
    if (pid) {
      throw new ExecutorError(`已有 runner 在跑（pid ${pid}）。要重启用 zcode-executor cancel ${sessionId}`, 2);
    }
    removeFileIfExists(lockPath); // 死 pid 的陈年锁，删掉重来一次
    if (!tryLinkLock(lockPath)) {
      throw new ExecutorError(`lock 争抢失败：另一个 runner 正好在 ${sessionId} 上拿锁`, 2);
    }
  }
  lockHeld = true;

  // 1. 拿到锁之后才清陈年 stop、cancel、pending 与陈年 answer（T2.9 第 2 条：抢锁失败的 runner
  //    不能动在跑 runner 的现场文件）：上次挂起留下的答案不能自动放行这一轮
  //    （T2.3b 第 2 条；pending.json 也属陈年残留，T2.5b 第 4 条）
  //    stop / cancel 只删早于本 runner 启动的：send 之后紧跟 cancel，文件会落在拿锁与清理之间，
  //    无条件删就把这条命令吞了（CI 慢机器上复现过）
  for (const stale of [answerPath, pendingPath]) removeFileIfExists(stale);
  for (const cmd of [stopPath, cancelPath]) {
    try {
      if (statSync(cmd).mtimeMs < bootAt) removeFileIfExists(cmd);
    } catch { /* 不存在 */ }
  }


  const watchers = [];
  let turnWatchers = []; // 当前回合装的挂起轮询；回合结束的 finally 里清空（T2.6b 第 3 条）
  let clientRef = null;      // 当前连接；无论走到哪一步收场都要 close（T2.4c 第 11 条）
  let cancelSeen = false;    // runner 已见过 cancel 文件
  let cancelStopSent = false; // session/stop 只发一次（T2.4c 第 9 条）
  let cancelGraceTimer = null;
  const fireCancelStop = () => {
    cancelSeen = true;
    if (cancelStopSent) return;
    cancelStopSent = true;
    try {
      sessionRef?.stop(); // 能发就发
    } catch {
      // 连接已经没了
    }
    // 发完 stop 就记事件（T2.4d 第 1 条）：follow/status 与用例靠它确认 cancel 已被 runner 消费
    appendEvent(eventsPath, { type: 'executor.cancel', at: now() });
    // 5 秒宽限：到点回合还没结束就强制断开连接，让 session.send 结算（T2.4c 第 3 条）
    cancelGraceTimer = setTimeout(() => {
      try {
        clientRef?.close();
      } catch {
        // 已不在
      }
    }, CANCEL_GRACE_MS);
  };
  try {
    // 2. 登记簿 + 白名单复查（RULES §8），与 new 同一套 realpath 归一（T2.2b 第 1 条，登记簿里存
    //    解析后的 cwd）。纳进锁的 try/finally（T2.4d 第 9 条）：这里抛错锁由 finally 删，不再泄漏。
    //    cwd 已不存在（被删/被移）同样按白名单不过处理（T2.3b 第 14 条：state exited 带 error）
    const entry = getSession(home, sessionId);
    let whitelist;
    try {
      whitelist = resolveWhitelist(config?.allowedRoots, entry.cwd);
    } catch {
      writeState({ phase: 'exited', cwd: entry.cwd, error: `登记簿里的 cwd 不存在或不可访问：${entry.cwd}` });
      throw new ExecutorError(`登记簿里的 cwd 不存在或不可访问：${entry.cwd}`, 2);
    }
    if (!allowedRootFor(whitelist.roots, whitelist.cwd)) {
      // 白名单不过也写 state exited 带 error（T2.3b 第 14 条），锁由 finally 清
      writeState({ phase: 'exited', cwd: entry.cwd, error: `cwd 不在白名单里：${entry.cwd}` });
      throw new ExecutorError(`登记簿里的 cwd 不在白名单里：${entry.cwd}。允许的根目录：${whitelist.roots.join('、')}`, 2);
    }
    writeState({ phase: 'running', cwd: entry.cwd });
    for (;;) {
      // 4. 读 registry（ZCODE_CONFIG_PATH 只在 models.mjs 的 loadZcodeConfig 读一次，T2.9 第 7 条）
      //    → spawn（secrets）→ 推 provider 表（评审 T2.3b 第 1 条）→ 连接会话（D13：
      //    登记簿没有 sessionId 先 create 并写回；有 sessionId 走 resume，Session not found 则重建）
      const { registry } = loadZcodeConfig();
      const secrets = registry.providers.map((p) => p.apiKey?.value).filter(Boolean);
      const workspace = { workspacePath: entry.cwd, workspaceKey: entry.cwd };
      const client = await AppServerClient.spawn({ cwd: entry.cwd, secrets });
      clientRef = client;
      await client.request('workspace/updateProviderRegistry', { workspace, registry }, { timeoutMs: 20_000 });
      // T3.2 闸门接线。模型审批的 Complete 经 workspace/generateText：fast 档模型 +
      // review.thought 档（默认 high）；review.enabled:false 或算不出模型时 complete 不传——
      // 闸门除红线外一律转人工（故障时默认安全）。
      let complete;
      if (config.review?.enabled !== false) {
        try {
          const { modelRef } = resolveReviewModelRef({ registry, providerId: entry.provider, config });
          complete = createComplete({ client, workspace, modelRef, timeoutMs: config.review?.timeoutMs });
        } catch (err) {
          process.stderr.write(`runner: 模型审批不可用，本连接内除红线外一律转人工：${err?.message ?? err}\n`);
        }
      }
      gate = createGate({
        cwd: entry.cwd,
        config,
        pendingPath,
        onPending: (pending) => {
          writeState({ phase: 'pending' });
          // 每次挂起装轮询之前先清掉陈年 answer.json（T2.3b 第 2 条），再开始等新答案
          removeFileIfExists(answerPath);
          const watcher = setInterval(() => {
            // 挂起轮询里也看 cancel（T2.4/T2.6b 第 4 条）：cancelSeen 或文件在场都算——
            // 若 cancel 文件刚被回合内观察点抢走消费，这里靠 cancelSeen 仍替人拒答，
            // 不然挂起没人应、要干等宽限断开。审批答 deny，提问走拒答（decline）
            if (cancelSeen || existsSync(cancelPath)) {
              fireCancelStop();
              removeFileIfExists(cancelPath); // 处理完就删（T2.4c 第 8 条）
              const decline = pending.kind === 'question';
              try {
                gate.answer(decline ? { action: 'decline', reason: '任务已取消' } : { decision: 'deny' });
              } catch (err) {
                process.stderr.write(`runner: cancel 应答挂起失败：${err?.message ?? err}\n`);
                return; // 挂起还挂着，下个 tick 再试
              }
              // 替人拒答也记回执（T2.6b 第 2 条）：approve/deny 撞上 cancel 才能如实报 eventType
              appendEvent(eventsPath, {
                type: 'executor.deny',
                at: now(),
                requestId: pending.requestId,
                reason: '任务已取消',
                ...(decline ? { decline: true } : {}),
              });
              clearInterval(watcher);
              removeFileIfExists(answerPath);
              writeState({ phase: 'running' });
              return;
            }
            const answer = readJsonOrNull(answerPath);
            if (!answer) return;
            // requestId 必须与当前挂起一致，陈年/错位的答案丢弃（T2.3b 第 2 条）
            if (answer.requestId !== pending.requestId) {
              process.stderr.write('runner: answer.json 的 requestId 对不上当前挂起，已丢弃\n');
              removeFileIfExists(answerPath);
              return;
            }
            // deny 对提问写的 decline 标记，翻译成 gate 认的 decline 应答（T2.5）
            const answerForGate = answer.decline === true ? { action: 'decline', reason: '人工拒答' } : answer;
            try {
              gate.answer(answerForGate);
            } catch (err) {
              process.stderr.write(`runner: answer.json 无效，已丢弃：${err?.message ?? err}\n`);
              removeFileIfExists(answerPath);
              return; // 继续等正确的答案
            }
            // 应答事件（T2.5）：approve / deny / answer 各一个，含 requestId 与决定或值
            const eventType =
              answer.decision === 'allow'
                ? 'executor.approve'
                : answer.decision === 'deny' || answer.decline === true
                  ? 'executor.deny'
                  : 'executor.answer';
            appendEvent(eventsPath, {
              type: eventType,
              at: now(),
              requestId: answer.requestId,
              ...(answer.decision !== undefined ? { decision: answer.decision } : {}),
              ...(answer.values !== undefined ? { values: answer.values } : {}),
              ...(answer.decline === true ? { decline: true, reason: '人工拒答' } : {}),
            });
            clearInterval(watcher);
            removeFileIfExists(answerPath);
            writeState({ phase: 'running' });
          }, ANSWER_POLL_MS);
          watchers.push(watcher);
          turnWatchers.push(watcher); // 本回合装的：回合结束时随 finally 一起拆（T2.6b 第 3 条）
        },
        complete,
        evidenceProbe: nodeProbe(),
        getIntent: () => gatherIntent(eventsPath),
        getPriorActions: () => gatherPriorActions(eventsPath),
        appendEvent: (event) => appendEvent(eventsPath, { at: now(), ...event }),
      });
      // D13：登记簿没有 sessionId 先 create 并写回；有 sessionId 走 resume，
      // resume 报 Session not found（会话在 zcode 侧丢了）→ 记 executor.recreated 后重建
      let zcodeSessionId = entry.sessionId ?? null;
      if (zcodeSessionId) {
        try {
          sessionRef = await attachSession({ client, sessionId: zcodeSessionId, cwd: entry.cwd, eventsPath, handlers: gate.handlers });
        } catch (err) {
          if (!/Session not found/i.test(String(err?.message))) throw err;
          appendEvent(eventsPath, { type: 'executor.recreated', at: now(), oldSessionId: zcodeSessionId });
          zcodeSessionId = null;
        }
      }
      if (!zcodeSessionId) {
        const providerObj = registry.providers.find((p) => p.providerId === entry.provider);
        const createParams = {
          workspace,
          mode: 'build',
          persistence: 'immediate',
          titleGenerationEnabled: false,
          runtimeModel: buildRuntimeModel(providerObj, entry.modelId),
        };
        if (entry.thoughtLevel) createParams.thoughtLevel = entry.thoughtLevel;
        if (entry.toolDenylist) createParams.toolDenylist = entry.toolDenylist;
        const created = await client.request('session/create', createParams, { timeoutMs: 20_000 });
        zcodeSessionId = created.session.sessionId;
        updateSession(home, sessionId, { sessionId: zcodeSessionId });
        entry.sessionId = zcodeSessionId;
        sessionRef = await attachSession({ client, sessionId: zcodeSessionId, cwd: entry.cwd, eventsPath, handlers: gate.handlers, resume: false });
      }
      const session = sessionRef;

      // 5. 消费队列。ended 记录为什么停下：empty=队列空（可以重查重投）；exited=子进程死了
      //（留给下个 runner，本 runner 不立刻重试）；stop=收到 stop 标记
      let ended = 'empty';
      for (;;) {
        const queueFile = nextQueueFile(queueDir);
        if (!queueFile) break;
        let item = readJsonOrNull(queueFile) ?? {};
        if (item.steer) {
          // 空闲时拿到的 steer 项按普通投递处理（T2.4）：清掉标记走同一条路
          item.steer = false;
          writeJsonAtomic(queueFile, item);
        }
        item = bumpAttempts(queueFile); // 取出时加一并落盘，崩溃后重投次数不丢（T2.3b 第 9 条）
        if (item.attempts > MAX_ATTEMPTS) {
          // 重投两次都没成：按 failed 结算这条投递，删掉后继续下一条（别让它永远占着队列）
          const last = {
            kind: 'last',
            outcome: 'failed',
            reason: `重投 ${MAX_ATTEMPTS} 次都没能完成（子进程反复退出），这条投递已丢弃`,
            lastText: null,
            usage: null,
            startedAt: null,
            endedAt: now(),
            text: item.text ?? '',
            task: item.task ?? null,
          };
          writeJsonAtomic(lastPath, last);
          appendEvent(eventsPath, { type: 'executor.result', at: now(), outcome: 'failed', reason: last.reason });
          updateSession(home, sessionId, { lastOutcome: 'failed' });
          removeFileIfExists(queueFile);
          continue;
        }
        const text = item.text ?? '';
        const task = item.task ?? null;
        appendEvent(eventsPath, { type: 'executor.send', at: now(), text, task, queueFile: path.basename(queueFile) });
        writeState({ phase: 'running', current: { text, task, startedAt: now() } });
        const timeoutMs = ((item.timeoutSec ?? config?.waitTimeoutSec ?? 1800) || 0) * 1000;
        // 回合进行中每 500ms 两个观察点（T2.4）：cancel 文件 → 发 session/stop，回合结束后
        // 不再取队列；队列里的 steer 项 → 立刻 session.steer 插话并删掉
        const inTurnWatcher = setInterval(() => {
          // 挂起期间整段交给挂起轮询（T2.4d 第 4 条）：cancel 文件由它消费并替人答 deny/decline，
          // 这里不能抢——抢走 cancel 文件挂起就没人应了，回合只能等宽限断开
          if (existsSync(pendingPath)) return;
          if (!cancelSeen && existsSync(cancelPath)) {
            fireCancelStop();
            removeFileIfExists(cancelPath); // 处理完就删（T2.4c 第 8 条）
            return;
          }
          const steer = nextSteerFile(queueDir);
          if (!steer) return;
          // 权宜：先删队列文件再插话，崩溃时这条插话会丢；要 Exactly-once 得改成两阶段占位
          unlinkSync(steer.file);
          appendEvent(eventsPath, { type: 'executor.steer', at: now(), text: steer.item.text ?? '' });
          session.steer(steer.item.text ?? '').catch((err) => {
            process.stderr.write(`runner: steer 失败：${err?.message ?? err}\n`);
          });
        }, STEER_POLL_MS);
        const outcome = await session
          .send(text, { timeoutMs })
          .finally(() => {
            clearInterval(inTurnWatcher);
            // 回合结束了挂起就不该还在（T2.6b 第 3 条）：超时或子进程退出时挂起的 Promise
            // 永不 resolve，pending.json 残留会让回合内观察点永远让路（steer 失灵）、
            // status 谎报 pending、send --wait 立刻退 5。轮询拆掉、文件清掉。
            // 权宜：闸门里这个挂起的 Promise 从此无法 resolve，同一条连接上的后续反向请求
            // 会排在它后面答不出去——runner 回圈重连时是新连接新闸门，不受影响
            for (const w of turnWatchers.splice(0)) clearInterval(w);
            removeFileIfExists(pendingPath);
          });
        // cancel 过的回合按 cancelled 结算（T2.4d 第 1 条），但只覆盖非 done 的 outcome
        // （T2.6b 第 8 条）：回合已正常 completed 时取消来得再快也是 done，不夺走已完成的事实。
        // 底层可能是宽限断开后的 exited、也可能是 turn.terminal，对外只说「已被 cancel 叫停」，
        // 退出码表里 cancelled: 4 由此激活
        const cancelled = cancelSeen && outcome.outcome !== 'done';
        const last = {
          kind: 'last',
          outcome: cancelled ? 'cancelled' : outcome.outcome,
          reason: cancelled ? '已被 cancel 叫停' : outcome.reason,
          lastText: outcome.lastText,
          usage: outcome.usage,
          startedAt: outcome.startedAt,
          endedAt: outcome.endedAt,
          text,
          task,
        };
        writeJsonAtomic(lastPath, last);
        appendEvent(eventsPath, { type: 'executor.result', at: now(), outcome: last.outcome, reason: last.reason });
        updateSession(home, sessionId, { lastOutcome: last.outcome });
        if (last.outcome === 'exited') {
          // 子进程没了：队列文件保留（attempts 已落盘），本 runner 不立刻重试，
          // 留给下个 runner 重投（任务单步骤 7）
          ended = 'exited';
          writeState({ current: null }); // exited 分支也清当前投递（T2.3b 第 14 条）
          break;
        }
        // cancel 过的回合：文件可能已被 cancel 清掉，容错删除；不再取队列（T2.4c 第 2/3 条）
        removeFileIfExists(queueFile);
        writeState({ current: null, phase: cancelSeen ? 'exited' : 'idle' });
        if (existsSync(stopPath) || cancelSeen) {
          ended = 'stop';
          break;
        }
      }

      // 6/7. 收场：close 之后再看一眼队列，非空就回到循环重新拉连接（评审 T2.3b 第 7 条）。
      // 但 ended 是 exited/stop 时不重投：exited 留给下个 runner，stop 是要收摊。
      // exited 之后 client 可能已死，close 抛错属正常收场，兜住不外溢
      try {
        await session.close();
      } catch (err) {
        process.stderr.write(`runner: 收场失败：${err?.message ?? err}\n`);
      }
      sessionRef = null;
      gate = null;
      if (ended !== 'empty' || !nextQueueFile(queueDir)) break;
    }
  } catch (err) {
    writeState({ phase: 'exited', error: String(err?.message ?? err) });
    throw err; // 锁在 finally 里删：等连接真正收场之后再放别人进来（T2.4c 第 11 条）
  } finally {
    for (const w of watchers) clearInterval(w);
    if (cancelGraceTimer) clearTimeout(cancelGraceTimer);
    try {
      await sessionRef?.close();
    } catch (err) {
      process.stderr.write(`runner: 收场失败：${err?.message ?? err}\n`);
    }
    try {
      await clientRef?.close(); // client 无论怎样都收场（T2.4c 第 11 条）
    } catch (err) {
      process.stderr.write(`runner: 连接收场失败：${err?.message ?? err}\n`);
    }
    writeState({ phase: 'exited' });
    removeFileIfExists(lockPath); // 删锁在 close 之后
  }
}
