// lib/cli/runner.mjs —— _runner 内部子命令（外壳层）：detached runner 的入口。
// stdout/stderr 的去向由父进程决定（重定向到 runs/<id>/runner.log）。
// 不 import 协议层：runner 的一生在 lib/run。
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from '../errors.mjs';
import { loadConfig } from '../config.mjs';
import { runSession } from '../run.mjs';

export async function run(argv) {
  const id = argv[0];
  if (!id) throw new ExecutorError('_runner 缺会话 id', 1);
  const config = loadConfig();
  try {
    await runSession({ home: config.home, config, sessionId: path.basename(id) });
  } catch (err) {
    // 评审 T2.4b 第 3 条：runner 出错必须退出。runSession 已写 state exited 并删锁，
    // 这里收口进程——否则残留句柄把进程吊住，send --wait 会因 pid 活着永远等
    console.error(`_runner: ${err?.message ?? err}`);
    process.exit(err instanceof ExecutorError ? err.exitCode ?? 1 : 1);
  }
}
