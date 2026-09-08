// test/helpers.mjs —— 起 mock、等条件、收尾杀进程的公共函数（T0.3）。
// 只服务测试；不负责协议行为（那是 mock-appserver.mjs 的事）。
// T0.3c 第 5 条：startMock 不再写 process.env，env 由调用方经 AppServerClient.spawn 的
// env 选项传给子进程——这是并发用例（队列、锁）的前提。
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MOCK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-appserver.mjs');

/**
 * 写剧本到临时目录，返回可直接交给 AppServerClient.spawn 的 zcodePath 和 env。
 *
 * @param {object} opts
 * @param {object} [opts.script] 剧本对象（字段见 mock-appserver.mjs 文件头）
 * @param {string} [opts.record] 记录文件路径；缺省放临时目录里
 * @param {string} [opts.version] MOCK_APPSERVER_VERSION
 * @returns {Promise<{zcodePath: string, env: object, recordPath: string, dir: string, cleanup: () => Promise<void>}>}
 */
export async function startMock({ script, record, version } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-mock-'));
  const scriptPath = path.join(dir, 'script.json');
  await writeFile(scriptPath, JSON.stringify(script ?? {}));
  const recordPath = record ?? path.join(dir, 'record.jsonl');
  const env = {
    MOCK_APPSERVER_SCRIPT: scriptPath,
    MOCK_APPSERVER_RECORD: recordPath,
    ...(version ? { MOCK_APPSERVER_VERSION: version } : {}),
  };
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(dir, { recursive: true, force: true });
  };
  return { zcodePath: MOCK_PATH, env, recordPath, dir, cleanup };
}

/** 轮询直到 fn 返回真值；返回那个值，超时抛错（带上最后一次的值方便排障）。 */
// 默认 20 秒：这是上限不是断言，CI 的两核机器上 runner 拉起 mock 再走到轮询点就要好几秒；
// 要断言「多久之内」的用例自己传短的 timeoutMs
export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value;
  for (;;) {
    value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor 超时（${timeoutMs}ms），最后结果：${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 记录文件 → 消息数组（一行一条 JSON）。文件还不存在（ENOENT）返回空数组；
 * 最后一行 JSON 解析失败视为半截写入丢掉；其余异常照常抛（T0.3c 第 7 条）。
 */
export function readRecord(recordPath) {
  let raw;
  try {
    raw = readFileSync(recordPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const out = [];
  lines.forEach((line, index) => {
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      if (index === lines.length - 1) return; // 最后一行可能是写了一半的，丢掉
      throw err;
    }
  });
  return out;
}

/** after() 用：SIGKILL 一组 pid，已死的忽略。 */
export function killAll(pids) {
  for (const pid of pids ?? []) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退了，忽略
    }
  }
  pids.length = 0;
}
