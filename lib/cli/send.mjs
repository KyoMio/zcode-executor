// lib/cli/send.mjs —— send 子命令（外壳层）：入队 → 没有活着的 runner 就 detached 起一个 →
// 不带 --wait 立刻返回；--wait 轮询 runs/<id>/ 的文件（不持有协议连接）。
// 不 import 协议层；入队走 lib/queue，runs 文件走 lib/runs，登记簿走 lib/registry。
import { existsSync, openSync, closeSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { enqueue } from '../queue.mjs';
import { livePidOf, readLast, readState, removeFileIfExists, runsDirOf, tailEvents } from '../runs.mjs';
import { getSession } from '../registry.mjs';
import { createStreamPrinter, EXIT_BY_OUTCOME, parseFlags, printPendingRuleNote, printTurnSummary, readPendingChecked, summarizeTurn } from './common.mjs';

const WAIT_POLL_MS = 200;

export async function run(argv) {
  // send <id> <正文|-> [flags]：parseFlags 把非旗标参数收进 positional（id、正文）
  const flags = parseFlags(argv, { value: ['--task', '--timeout'], boolean: ['--wait', '--json', '--steer', '--stream'] });
  const positional = flags.positional;
  const id = positional[0];
  const text = positional[1];
  const { json, task, wait, timeout, steer, stream } = flags;

  if (id === undefined) throw new ExecutorError('缺会话 id。用法：send <id> <正文|-> [--task 文件] [--wait]', 1);
  const config = loadConfig();
  getSession(config.home, id); // 不在登记簿 → 抛 2
  if (text === undefined) throw new ExecutorError('缺投递正文。用法：send <id> <正文|->；正文写 - 从 stdin 读', 1);
  let body = text;
  if (body === '-') body = readFileSync(0, 'utf8'); // stdin：测试与长文本用
  if (body.trim() === '') throw new ExecutorError('投递正文是空的', 1);
  let taskPath = null;
  if (task !== undefined) {
    taskPath = path.resolve(task);
    if (!existsSync(taskPath)) throw new ExecutorError(`--task 文件不存在：${taskPath}`, 1);
  }
  // --timeout 校验（评审 T2.3b 第 8 条）：秒数必须是非负整数，非法按用法错退 1
  let timeoutSec;
  if (timeout !== undefined) {
    timeoutSec = Number(timeout);
    if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
      throw new ExecutorError(`--timeout 要正整数秒，收到：${timeout}`, 1);
    }
  }

  const dir = runsDirOf(config.home, id);
  const lastPath = path.join(dir, 'last.json');
  const pendingPath = path.join(dir, 'pending.json');
  // --wait 判「新结果」的基线：入队前的 mtimeMs，无文件记 -1（评审 T2.3b 第 5 条，不用墙上时钟）
  const lastBaseline = existsSync(lastPath) ? statSync(lastPath).mtimeMs : -1;
  const t0 = Date.now(); // state exited 出口的时效基线（T2.4b 第 3 条）
  // --stream 的起点：当前 events.jsonl 末尾（只打本次投递之后的新增，T2.4）
  let streamOffset = stream ? tailEvents(config.home, id, { fromOffset: 0 }).nextOffset : 0;
  const printer = stream ? createStreamPrinter() : null;
  // --json 的 sessionId 取登记簿里 zcode 的 sess_，没有为 null（T2.4d 第 6 条，与 list 一致）；
  // 输出时现读：--wait 期间 runner 可能刚 session/create 写回
  const zcodeId = () => getSession(config.home, id).sessionId ?? null;

  // 陈年 stop/cancel 标记先清掉，否则新起的 runner 会立刻停（评审 T2.4c 第 8 条）
  removeFileIfExists(path.join(dir, 'stop'));
  removeFileIfExists(path.join(dir, 'cancel'));
  enqueue(config.home, id, { text: body, task: taskPath, timeoutSec, steer: Boolean(steer) });

  let spawned = false;
  let pid = livePidOf(config.home, id);
  if (!pid) {
    // runner 一律后台（任务单 T2.3 设计定案）：挂起时连接必须由 runner 保持不答
    const logFd = openSync(path.join(dir, 'runner.log'), 'a');
    const child = spawn(process.execPath, [path.resolve(process.argv[1]), '_runner', id], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref(); // 注意 unref() 不返回 this，不能链式赋值
    closeSync(logFd);
    spawned = true;
    pid = child.pid;
  }

  if (!wait) {
    const queued = readdirSync(path.join(dir, 'queue')).filter((f) => f.endsWith('.json')).length;
    if (json) {
      console.log(JSON.stringify({ id, sessionId: zcodeId(), queued, spawned, pid }));
    } else {
      console.log(`send: 已排队，runner pid ${pid}`);
    }
    return;
  }

  // --wait 轮询三出口
  for (;;) {
    if (stream) {
      const tail = tailEvents(config.home, id, { fromOffset: streamOffset });
      printer.feed(tail.events);
      streamOffset = tail.nextOffset;
    }
    const mtime = existsSync(lastPath) ? statSync(lastPath).mtimeMs : -1;
    if (mtime > lastBaseline) {
      const last = readLast(config.home, id);
      printer?.flush();
      if (json) {
        console.log(JSON.stringify({ kind: 'last', id, sessionId: zcodeId(), summary: summarizeTurn(config.home, id), ...nulls(last) }));
      } else {
        console.log(`send: ${last.outcome}${last.reason ? `（${last.reason}）` : ''}`);
        const text500 = (last.lastText ?? '').slice(0, 500); // 原样打印，多段之间保留换行（T2.8 第 1 条）
        if (text500) console.log(text500);
        console.log('');
        printTurnSummary(config.home, id);
      }
      process.exitCode = EXIT_BY_OUTCOME[last.outcome] ?? 4;
      return;
    }
    // runner 启动阶段失败：state 写了 exited（updatedAt 比投递新）却没有新 last → 4（T2.4b 第 3 条）
    const state = readState(config.home, id);
    if (state?.phase === 'exited' && Date.parse(state.updatedAt) >= t0) {
      const reason = state.error ?? 'runner 启动失败';
      if (json) {
        console.log(JSON.stringify({ kind: 'runner-gone', id, sessionId: zcodeId(), outcome: 'exited', reason, lastText: null, usage: null, startedAt: null, endedAt: null, text: body, task: taskPath }));
      } else {
        console.log(`send: runner 没了（${reason}）`);
      }
      process.exitCode = 4;
      return;
    }
    // 挂起不过期：pending.json 在就是挂起，直接 5（评审 T2.3b 第 3 条，不比时间）
    const pending = readPendingChecked(pendingPath); // 坏 JSON 报中文（T2.6b 第 9 条）
    if (pending) {
      if (json) {
        console.log(JSON.stringify({ id, sessionId: zcodeId(), ...pending }));
      } else if (pending.kind === 'question') {
        for (const q of pending.questions ?? []) {
          const options = (q.options ?? []).map((o) => o.label ?? o.value).join('、');
          console.log(`send: 挂起·提问：${q.question}${options ? `（可选：${options}）` : ''}`);
        }
      } else {
        const input = JSON.stringify(pending.input ?? {});
        console.log(`send: 挂起·审批：${pending.toolName} ${input} —— ${pending.reason ?? '无理由'}`);
        printPendingRuleNote(pending); // 带规则 id 时把原文带出来（T2.9 第 6 条）
      }
      process.exitCode = 5;
      return;
    }
    // 已知的这个 runner 死了且没有新 last：重投无门，按回合异常算
    let alive = false;
    if (pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (!alive) {
      // --json 出口与 last.json 同形状，缺的填 null，kind 区分（评审 T2.3b 第 11 条）
      const gone = {
        kind: 'runner-gone',
        id,
        sessionId: zcodeId(),
        outcome: 'exited',
        reason: `runner 没了（pid ${pid}）`,
        lastText: null,
        usage: null,
        startedAt: null,
        endedAt: null,
        text: body,
        task: taskPath,
      };
      if (json) console.log(JSON.stringify(gone));
      else console.log(`send: runner 没了（pid ${pid}），队列里还有没投完的投递，再 send 一次会重起 runner`);
      process.exitCode = 4;
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}

/** last.json 同形状补全：缺的字段填 null。 */
function nulls(last) {
  return {
    outcome: last?.outcome ?? null,
    reason: last?.reason ?? null,
    lastText: last?.lastText ?? null,
    usage: last?.usage ?? null,
    startedAt: last?.startedAt ?? null,
    endedAt: last?.endedAt ?? null,
    text: last?.text ?? null,
    task: last?.task ?? null,
  };
}
