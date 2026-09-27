// send --offpeak 与 runner 闲时部分的行为测试（SPEC-offpeak A、B、E 的正常路径，任务 OP4）：
// 全部对 test/mock-appserver.mjs 与 test/mock-offpeak.mjs 跑——ZCODE_EXECUTOR_OFFPEAK_ORIGIN 指向本进程里的
// mock 闲时服务器，ZCODE_EXECUTOR_OFFPEAK_POLL_MS 压短轮询，ZCODE_DATA_BASE_DIR 指进夹具；不碰真网络、不读真实 ~/.zcode。
// CLI 必须异步起（spawn 而非 spawnSync）：send 当场取号，mock 闲时服务器跑在本进程的事件循环里，同步等子进程会卡死。
// runner 是 detached 的：每个用例开头登记清理，结束时 SIGKILL lock / runner.log 里找到的 runner 与 mock。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killAll, readRecord, startMock, waitFor } from './helpers.mjs';
import { startMockOffPeak } from './mock-offpeak.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'zcode-executor');
const dirs = [];
const servers = [];
const runnerPids = [];
const mockPids = [];
test.after(async () => {
  killAll(runnerPids);
  killAll(mockPids);
  for (const s of servers) await s.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// 测试用 JWT：够长（scrubValues 只抹 ≥ 8 字符的值），和别的字符串不重叠
const TEST_JWT = 'offpeak-send-jwt-header.offpeak-send-jwt-payload.offpeak-send-jwt-signature';

// legacy config.json：闲时模型表里的 GLM-5.3 系，外加一个不在表里的模型（测前置条件）
const ZCODE_CONFIG = {
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

// 造环境：mock app-server（带账号凭据夹具与 JWT）+ mock 闲时服务器 + 家目录（白名单指到 git 仓库）+ new 一条会话
async function setup(t, { script, offpeak = {}, credentials = { jwt: TEST_JWT }, provider = 'builtin:bigmodel-coding-plan' } = {}) {
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
    ZCODE_EXECUTOR_NO_CAFFEINATE: '1',
    TMPDIR: tmp, // runner 的个人 provider 文件落这里，收场后应当是空的
    ...mock.env,
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
  return { mock, server, home, env, entry, tmp, runsDir, recordPath: mock.env.MOCK_APPSERVER_RECORD };
}

/** 异步跑 bin，返回 {status, stdout, stderr}。 */
async function runBin(env, args) {
  const child = spawn(process.execPath, [BIN, ...args], { env });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const status = await new Promise((resolve) => child.on('close', (code) => resolve(code)));
  return { status, stdout, stderr };
}

/** runner 与 mock 的 pid 记进全局，after() 杀；返回 {runnerPid, mockPids}。 */
function trackPids(runsDir) {
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

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readEvents = (runsDir) => {
  try {
    return readFileSync(path.join(runsDir, 'events.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

async function allFileText(dir) {
  let text = '';
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) text += await readFile(path.join(entry.parentPath ?? entry.path, entry.name), 'utf8');
  }
  return text;
}

/** 等 runner 收场：锁没了、state 是 exited。 */
async function waitRunnerGone(runsDir) {
  await waitFor(() => !existsSync(path.join(runsDir, 'lock')) && readJson(path.join(runsDir, 'state.json')).phase === 'exited');
}

// ---------- 前置条件 ----------

test('send --offpeak --steer：用法错，退出码 1，不取号', async (t) => {
  const s = await setup(t);
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak', '--steer']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /--offpeak.*--steer|--steer.*--offpeak/);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：runner 活着 → 退出码 2，说要等会话空闲，不取号', async (t) => {
  const s = await setup(t);
  await mkdir(s.runsDir, { recursive: true });
  await writeFile(path.join(s.runsDir, 'lock'), JSON.stringify({ pid: process.pid })); // 本测试进程当作活着的 runner
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^send: .*空闲/m);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：队列非空 → 退出码 2，不取号', async (t) => {
  const s = await setup(t);
  await mkdir(path.join(s.runsDir, 'queue'), { recursive: true });
  await writeFile(path.join(s.runsDir, 'queue', '2026-01-01T00-00-00.000Z-1-aaaa.json'), JSON.stringify({ text: '排着的', steer: false }));
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /空闲/);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：会话模型不在闲时模型表 → 退出码 2，报模型名', async (t) => {
  const s = await setup(t, { provider: 'builtin:other' });
  assert.equal(s.entry.modelId, 'GLM-4.6');
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /GLM-4\.6/);
  assert.match(r.stderr, /闲时模型/);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：凭据里没有 JWT → 退出码 2，原因原样给', async (t) => {
  const s = await setup(t, { credentials: {} });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /zcodejwttoken/);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：只有团队版 → 退出码 2「团队版暂不支持」', async (t) => {
  const s = await setup(t, { credentials: { jwt: TEST_JWT, individual: false, team: true } });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /团队版暂不支持/);
  assert.equal(s.server.requests.length, 0);
});

test('send --offpeak：取号 3103 → 退出码 2，带本地时间「以后可再取」，不入队不起 runner', async (t) => {
  const s = await setup(t, { offpeak: { quotaExhaustedCount: 1 } });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /额度用完/);
  assert.match(r.stderr, /\d{1,2}:\d{2}:\d{2}.*以后可再取/);
  assert.equal(existsSync(path.join(s.runsDir, 'offpeak.json')), false);
  assert.equal(existsSync(path.join(s.runsDir, 'lock')), false);
  const queued = existsSync(path.join(s.runsDir, 'queue')) ? await readdir(path.join(s.runsDir, 'queue')) : [];
  assert.deepEqual(queued, []);
});

test('send --offpeak：取号 3101 → 退出码 2「没有闲时资格」', async (t) => {
  const s = await setup(t, { offpeak: { eligible: false } });
  const r = await runBin(s.env, ['send', s.entry.id, '活', '--offpeak']);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /没有闲时资格/);
});
