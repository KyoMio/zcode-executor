// lib/cli/follow.mjs —— follow 子命令（外壳层）：只读跟看 runs/<id>/ 的文件，等结果或挂起。
// 不持有协议连接、不取消任何东西；--timeout 到点只是旁观者离开（T2.4）。
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { livePidOf, readLast, readState, runsDirOf, tailEvents } from '../runs.mjs';
import { getSession } from '../registry.mjs';
import { createStreamPrinter, EXIT_BY_OUTCOME, parseFlags, printPendingRuleNote, printTurnSummary, readPendingChecked, summarizeTurn } from './common.mjs';

const POLL_MS = 200;
const RUNNER_APPEAR_GRACE_MS = 2000; // 新 runner 从 spawn 到建锁的宽限，期间不判「没了」

export async function run(argv) {
  const flags = parseFlags(argv, { boolean: ['--json', '--stream'], value: ['--timeout'] });
  const id = flags.positional[0];
  const { json, stream, timeout } = flags;
  if (id === undefined) throw new ExecutorError('缺会话 id。用法：follow <id> [--timeout 秒] [--stream] [--json]', 1);
  let timeoutSec;
  if (timeout !== undefined) {
    timeoutSec = Number(timeout);
    if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
      throw new ExecutorError(`--timeout 要正整数秒，收到：${timeout}`, 1);
    }
  }
  const config = loadConfig();
  getSession(config.home, id); // 不在登记簿 → 抛 2

  const dir = runsDirOf(config.home, id);
  const lastPath = path.join(dir, 'last.json');
  const pendingPath = path.join(dir, 'pending.json');
  const lastBaseline = existsSync(lastPath) ? statSync(lastPath).mtimeMs : -1;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let streamOffset = tailEvents(config.home, id, { fromOffset: 0 }).nextOffset;
  const printer = createStreamPrinter();
  const deadline = timeoutSec !== undefined ? Date.now() + timeoutSec * 1000 : null;
  // --json 的 sessionId 取登记簿里 zcode 的 sess_，没有为 null（T2.4d 第 6 条，与 list 一致）；
  // 输出时现读：跟看期间 runner 可能刚 session/create 写回
  const zcodeId = () => getSession(config.home, id).sessionId ?? null;

  let runnerSeenAlive = false;
  for (;;) {
    // --stream 只调一次 tailEvents 并整段放进 if (stream)（评审 T2.4c 第 6 条）；
    // 喂流要在 last 检查之前，否则最后一批事件会跟着 return 一起丢掉
    if (stream) {
      const tail = tailEvents(config.home, id, { fromOffset: streamOffset });
      printer.feed(tail.events);
      streamOffset = tail.nextOffset;
    }
    const mtime = existsSync(lastPath) ? statSync(lastPath).mtimeMs : -1;
    const pid = livePidOf(config.home, id);
    if (pid) runnerSeenAlive = true;
    if (mtime > lastBaseline) {
      const last = readLast(config.home, id);
      printer.flush();
      if (json) {
        console.log(JSON.stringify({ kind: 'last', id, sessionId: zcodeId(), summary: summarizeTurn(config.home, id), ...last }));
      } else {
        console.log(`follow: ${last.outcome}${last.reason ? `（${last.reason}）` : ''}`);
        const text500 = (last.lastText ?? '').slice(0, 500); // 原样打印，多段之间保留换行（T2.8 第 1 条）
        if (text500) console.log(text500);
        console.log('');
        printTurnSummary(config.home, id);
      }
      process.exitCode = EXIT_BY_OUTCOME[last.outcome] ?? 4;
      return;
    }
    // runner 启动失败：state exited（比 follow 启动新）且没有新 last → 4（T2.4b 第 3 条）。
    // 与 send 的同一出口统一，不比 current（T2.4d 第 8 条）：有 current 也是「runner 没了没结果」
    const state = readState(config.home, id);
    if (state?.phase === 'exited' && Date.parse(state.updatedAt) >= startedMs) {
      printer.flush();
      if (json) {
        console.log(JSON.stringify({ kind: 'runner-gone', id, sessionId: zcodeId(), outcome: 'exited', reason: state.error ?? 'runner 没了，没有新结果', lastText: null, usage: null, startedAt: null, endedAt: null, text: null, task: null }));
      } else {
        console.log('follow: runner 没了，也没有新结果');
      }
      process.exitCode = 4;
      return;
    }
    const pending = readPendingChecked(pendingPath); // 容错读，坏 JSON 报中文（T2.4c 第 1 条、T2.6b 第 9 条）
    if (pending) {
      printer.flush();
      if (json) {
        console.log(JSON.stringify({ id, sessionId: zcodeId(), ...pending }));
      } else if (pending.kind === 'question') {
        for (const q of pending.questions ?? []) {
          const options = (q.options ?? []).map((o) => o.label ?? o.value).join('、');
          console.log(`follow: 挂起·提问：${q.question}${options ? `（可选：${options}）` : ''}`);
        }
      } else {
        console.log(`follow: 挂起·审批：${pending.toolName} ${JSON.stringify(pending.input ?? {})} —— ${pending.reason ?? '无理由'}`);
        printPendingRuleNote(pending); // 带规则 id 时把原文带出来（T2.9 第 6 条）
      }
      process.exitCode = 5;
      return;
    }
    if (deadline !== null && Date.now() > deadline) {
      // 旁观者到点走了：不发 session/stop、不写任何文件，回合照跑（T2.4）
      printer.flush();
      if (json) {
        console.log(JSON.stringify({ kind: 'follow-timeout', id, sessionId: zcodeId(), outcome: 'timeout', reason: `follow --timeout ${timeoutSec} 秒到点，未取消任何东西`, lastText: null, usage: null, startedAt, endedAt: null, text: null, task: null }));
      } else {
        console.log(`follow: 旁观超时（${timeoutSec} 秒）到点。没有取消任何东西，回合还在跑，可再 follow 接着看`);
      }
      process.exitCode = 3;
      return;
    }
    // runner 没了：见过活 runner 之后 pid 消失（起过但没了）；或宽限期内从未出现（没起过，T2.4c 第 11 条）
    const aliveNow = livePidOf(config.home, id) !== null;
    if (aliveNow) runnerSeenAlive = true;
    const graceOver = Date.now() - startedMs > RUNNER_APPEAR_GRACE_MS;
    if (!aliveNow && (runnerSeenAlive || graceOver)) {
      printer.flush();
      const reason = runnerSeenAlive ? 'runner 没了，也没有新结果' : 'runner 从未起过（该会话还没有投递记录）';
      if (json) {
        console.log(JSON.stringify({ kind: 'runner-gone', id, sessionId: zcodeId(), outcome: 'exited', reason, lastText: null, usage: null, startedAt: null, endedAt: null, text: null, task: null }));
      } else {
        console.log(`follow: ${reason}`);
      }
      process.exitCode = 4;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
