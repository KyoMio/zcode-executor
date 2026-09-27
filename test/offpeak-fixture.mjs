// 闲时投递集成测试的公共夹具（test/offpeak-send.test.mjs 与 test/offpeak-retake.test.mjs 共用）：
// 造环境（mock app-server + mock 闲时服务器 + 家目录 + new 一条会话）、异步跑 bin、登记与清理后台进程、
// 读落盘文件、泄密检查、用文件布置现场。只服务测试；不碰真网络、不读真实 ~/.zcode。
// ZCODE_EXECUTOR_OFFPEAK_ORIGIN 指向本进程里的 mock 闲时服务器，ZCODE_EXECUTOR_OFFPEAK_POLL_MS 压短轮询，
// ZCODE_EXECUTOR_OFFPEAK_SETTLE_RETRY_MS 压短结算重试间隔，ZCODE_DATA_BASE_DIR 指进夹具。
// CLI 必须异步起（spawn 而非 spawnSync）：send 当场取号，mock 闲时服务器跑在本进程的事件循环里，同步等子进程会卡死。
// runner 是 detached 的：setup 给每个用例挂 t.after 杀进程，测试文件末尾 test.after(cleanupAll) 再统一收尾。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptForTest, killAll, startMock, waitFor } from './helpers.mjs';
import { startMockOffPeak } from './mock-offpeak.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin', 'zcode-executor');
const dirs = [];
const servers = [];
const runnerPids = [];
const mockPids = [];

// 测试用 JWT：够长（scrubValues 只抹 ≥ 8 字符的值），和别的字符串不重叠
export const TEST_JWT = 'offpeak-send-jwt-header.offpeak-send-jwt-payload.offpeak-send-jwt-signature';

// legacy config.json：闲时模型表里的 GLM-5.3 系，外加一个不在表里的模型（测前置条件）
export const ZCODE_CONFIG = {
  provider: {
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      options: { apiKey: 'sk-offpeak-test-plan' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': {},
      },
    },
    'builtin:other': {
      kind: 'anthropic',
      options: { apiKey: 'sk-offpeak-test-other' },
      models: { 'GLM-4.6': { name: 'GLM 4.6' } },
    },
  },
};

/** 每个测试文件末尾 test.after(cleanupAll)：杀 runner 与 mock、关 mock 闲时服务器、删临时目录。 */
export async function cleanupAll() {
  killAll(runnerPids);
  killAll(mockPids);
  for (const s of servers) await s.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
}

// 造环境：mock app-server（带账号凭据夹具与 JWT）+ mock 闲时服务器 + 家目录（白名单指到 git 仓库）+ new 一条会话
export async function setup(t, { script, offpeak = {}, credentials = { jwt: TEST_JWT }, provider = 'builtin:bigmodel-coding-plan', envExtra = {} } = {}) {
  t.after(() => {
    killAll(runnerPids);
    killAll(mockPids);
  });
  const mock = await startMock({ script, credentials });
  dirs.push(mock.dir);
  const server = await startMockOffPeak({ jwt: TEST_JWT, planKey: mock.accountKeys.individual ?? 'unused-plan-key', readyDelayMs: 50, ...offpeak });
  servers.push(server);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-offpeak-home-'));
  const workParent = await mkdtemp(path.join(os.tmpdir(), 'zcode-offpeak-work-'));
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'zcode-offpeak-tmp-'));
  dirs.push(home, workParent, tmp);
  const repo = path.join(workParent, 'repo');
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedRoots: [workParent], review: { enabled: false } }));
  const zcodeConfigPath = path.join(home, 'zcode-config.json');
  await writeFile(zcodeConfigPath, JSON.stringify(ZCODE_CONFIG));
  const env = {
    ...process.env,
    ZCODE_BIN: mock.zcodePath,
    ZCODE_EXECUTOR_HOME: home,
    ZCODE_CONFIG_PATH: zcodeConfigPath,
    ZCODE_EXECUTOR_OFFPEAK_ORIGIN: server.origin,
    ZCODE_EXECUTOR_OFFPEAK_POLL_MS: '100',
    ZCODE_EXECUTOR_OFFPEAK_SETTLE_RETRY_MS: '20',
    ZCODE_EXECUTOR_NO_CAFFEINATE: '1',
    TMPDIR: tmp, // runner 的个人 provider 文件落这里，收场后应当是空的
    ...mock.env,
    ...envExtra,
  };
  // new 不碰闲时服务器，可以同步跑
  const created = spawnSync(process.execPath, [BIN, 'new', '--cwd', repo, '--provider', provider, '--tier', 'strong', '--json'], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  assert.equal(created.status, 0, `new 失败：${created.stderr}`);
  const entry = JSON.parse(created.stdout);
  const runsDir = path.join(home, 'runs', entry.id);
  return { mock, server, home, env, entry, tmp, runsDir, zcodeConfigPath, recordPath: mock.env.MOCK_APPSERVER_RECORD };
}

/** 异步跑 bin，返回 {status, stdout, stderr}。 */
export async function runBin(env, args) {
  const child = spawn(process.execPath, [BIN, ...args], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const status = await new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return { status, stdout, stderr };
}

/** runner 与 mock 的 pid 记进全局，after() 杀；返回 {runnerPid, mockPids}。 */
export function trackPids(runsDir) {
  const found = { runnerPid: null, mockPids: [] };
  for (const file of ['lock', 'state.json']) {
    try {
      const { pid } = JSON.parse(readFileSync(path.join(runsDir, file), 'utf8'));
      if (Number.isInteger(pid)) {
        runnerPids.push(pid);
        found.runnerPid = pid;
      }
    } catch {
      // 还没有或已经删了
    }
  }
  try {
    const log = readFileSync(path.join(runsDir, 'runner.log'), 'utf8');
    for (const m of log.matchAll(/mock: started version=\S+ pid=(\d+)/g)) {
      mockPids.push(Number(m[1]));
      found.mockPids.push(Number(m[1]));
    }
  } catch {
    // 还没起 mock
  }
  return found;
}

export const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const readEvents = (runsDir) => {
  try {
    return readFileSync(path.join(runsDir, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
export const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

export async function allFileText(dir) {
  let text = '';
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += await readFile(path.join(entry.parentPath ?? entry.path, entry.name), 'utf8');
  }
  return text;
}

/** 等 runner 收场：锁没了、state 是 exited，而且进程真的退了（删锁到进程退出之间还有一小段）。 */
export async function waitRunnerGone(runsDir) {
  // state.json 可能还没写（runner 刚起）：读不到就接着等
  const state = () => (existsSync(path.join(runsDir, 'state.json')) ? readJson(path.join(runsDir, 'state.json')) : null);
  await waitFor(() => !existsSync(path.join(runsDir, 'lock')) && state()?.phase === 'exited');
  const { pid } = state();
  await waitFor(() => !isAlive(pid));
}

/**
 * 泄密检查：runs 目录全部文件（含 runner.log、events、offpeak.json、state、last、queue）、输出、mock 记录里
 * 都查不到 JWT 与 key。extraSecrets：用例中途换上的凭据（比如重新登录后的新 JWT）。
 */
export async function assertNoSecrets(s, outputs = [], extraSecrets = []) {
  const secrets = [TEST_JWT, s.mock.accountKeys.individual, s.mock.accountKeys.team, ...extraSecrets].filter(Boolean);
  const texts = [...outputs, await allFileText(s.runsDir), existsSync(s.recordPath) ? readFileSync(s.recordPath, 'utf8') : ''];
  for (const secret of secrets) for (const text of texts) assert.equal(text.includes(secret), false, '不能有 JWT 或 key');
}

/** 直接向 mock 闲时服务器取一个号（布置现场用，不经过 send）；返回 data。 */
export async function takeTicket(s, offPeakId) {
  const res = await fetch(`${s.server.origin}/api/v1/off-peak/ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TEST_JWT}`, 'x-coding-plan-api-key': s.mock.accountKeys.individual, 'content-type': 'application/json' },
    body: JSON.stringify({ task_id: offPeakId }),
  });
  return (await res.json()).data;
}

/** 用文件布置现场：offpeak.json（给了才写）与按顺序排好的队列项。 */
export async function lay(s, { offpeak, queue }) {
  await mkdir(path.join(s.runsDir, 'queue'), { recursive: true });
  if (offpeak) await writeFile(path.join(s.runsDir, 'offpeak.json'), JSON.stringify(offpeak));
  for (const [i, item] of queue.entries()) {
    const file = path.join(s.runsDir, 'queue', `2026-01-01T00-00-00.000Z-${i + 1}-lay${i}.json`);
    await writeFile(file, JSON.stringify({ task: null, timeoutSec: null, steer: false, queuedAt: new Date().toISOString(), ...item }));
  }
}

/** 像 send 那样后台起 runner（stdout/stderr 进 runner.log），pid 登记给 after() 杀。 */
export async function startRunner(s) {
  await mkdir(s.runsDir, { recursive: true });
  const fd = openSync(path.join(s.runsDir, 'runner.log'), 'a');
  const child = spawn(process.execPath, [BIN, '_runner', s.entry.id], { env: s.env, detached: true, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  child.unref();
  runnerPids.push(child.pid);
  return child.pid;
}

export const offPeakJson = (offPeakId, ticketId, extra = {}) => ({
  offPeakId, ticketId, ticketCount: 1, phase: 'queued', position: 1, readyDeadline: null, activeDeadline: null,
  settledAt: null, settleError: null, updatedAt: new Date().toISOString(), ...extra,
});
export const settleRequests = (s) => s.server.requests.filter((q) => q.path.endsWith('/settle'));
export const takeRequests = (s) => s.server.requests.filter((q) => q.method === 'POST' && q.path === '/api/v1/off-peak/ticket');
export const runnerLog = (s) => (existsSync(path.join(s.runsDir, 'runner.log')) ? readFileSync(path.join(s.runsDir, 'runner.log'), 'utf8') : '');

/** 把夹具凭据文件里的 JWT 换成新值（模拟用户在 App 里重新登录）；先写临时文件再 rename，runner 读不到半截。 */
export async function replaceJwt(s, jwt) {
  const entries = JSON.parse(await readFile(s.mock.credentialsPath, 'utf8'));
  entries.zcodejwttoken = encryptForTest(jwt);
  const tmp = `${s.mock.credentialsPath}.tmp`;
  await writeFile(tmp, JSON.stringify(entries), { mode: 0o600 });
  await rename(tmp, s.mock.credentialsPath);
}
