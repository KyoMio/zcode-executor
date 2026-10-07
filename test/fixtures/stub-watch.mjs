#!/usr/bin/env node
// 可控的 `zcode-executor watch --json` 桩（watch-process.test.mjs 用）：argv 照真协议收
// `watch --json`（原样忽略），行为由环境变量驱动——
//   STUB_PLAN  JSON 计划文件的路径。计划有两种形状：
//              步骤数组（每轮运行都照它演）或 { runs: [步骤数组, …] }（第 n 轮用第 n 个，
//              超出的轮次沿用最后一个）。步骤：{ line: 对象或 JSON 字符串 }（吐一行 NDJSON）、
//              { raw: 文本 }（原样吐一行，不保证是 JSON）、{ halfLine: 对象或文本, splitAt?: 字节 }
//              （把一行按 UTF-8 字节切成两半分两次 write，测解码跨 chunk 的边界）、
//              { delayMs: n }（等待）、{ stderr: 文本 }（写 stderr）、{ exitCode: n }（退出）；
//              步骤走完就挂着不退（照真 watch 常驻），直到 SIGTERM/SIGINT。
//   STUB_RUN_FILE   每轮开始追加一行 "1"——测试用它数「起过几次进程」。
//   STUB_EXIT_FILE  收到 SIGTERM/SIGINT 写一行 "bye"——测试用它确认进程真的死了。
// 没给 STUB_PLAN 就演最小真机首轮：hello → session → synced，然后常驻。
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

// 第几轮由 run 标记文件自己数：追加前已有的行数就是本轮序号（0 起），不靠外部传
const runIndex = (() => {
  const file = process.env.STUB_RUN_FILE;
  if (!file) return 0;
  let before = 0;
  try { before = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length; } catch {}
  try { appendFileSync(file, '1\n'); } catch {}
  return before;
})();

const plan = (() => {
  try {
    const raw = JSON.parse(readFileSync(process.env.STUB_PLAN, 'utf8'));
    return Array.isArray(raw) ? { runs: [raw] } : raw;
  } catch {
    return { runs: [[{ line: { type: 'hello', repo: null } }, { line: { type: 'session', session: { id: 'stub_00000001', phase: 'idle' } } }, { line: { type: 'synced' } }]] };
  }
})();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function perform(steps) {
  for (const step of steps) {
    if (step.line !== undefined) {
      process.stdout.write(`${typeof step.line === 'string' ? step.line : JSON.stringify(step.line)}\n`);
    } else if (step.halfLine !== undefined) {
      const text = `${typeof step.halfLine === 'string' ? step.halfLine : JSON.stringify(step.halfLine)}\n`;
      const buf = Buffer.from(text, 'utf8');
      const at = Math.min(step.splitAt ?? Math.floor(buf.length / 2), buf.length - 1);
      process.stdout.write(buf.subarray(0, at));
      await sleep(10); // 隔开两次 write，让父进程收到两个独立的 data 事件
      process.stdout.write(buf.subarray(at));
    } else if (step.raw !== undefined) {
      process.stdout.write(`${step.raw}\n`);
    } else if (step.stderr !== undefined) {
      process.stderr.write(`${step.stderr}\n`);
    } else if (step.delayMs !== undefined) {
      await sleep(step.delayMs);
    } else if (step.exitCode !== undefined) {
      process.exit(step.exitCode);
    }
  }
}

void perform(plan.runs[Math.min(runIndex, plan.runs.length - 1)] ?? []);

const die = () => {
  if (process.env.STUB_EXIT_FILE) {
    try { appendFileSync(process.env.STUB_EXIT_FILE, 'bye\n'); } catch {}
  }
  process.exit(0);
};
process.on('SIGTERM', die);
process.on('SIGINT', die);
process.stdout.on('error', (err) => { if (err?.code === 'EPIPE') process.exit(0); else throw err; });
