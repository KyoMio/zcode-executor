// runner 与 send 的行为测试（T2.3/T2.3b）：全部对 test/mock-appserver.mjs 跑，子进程跑 bin，
// ZCODE_EXECUTOR_HOME 指向临时目录。runner 是 detached 的：每个用例一开头就 t.after 登记
// （评审 T2.3b 第 10 条），结束时统一 SIGKILL lock/日志里找到的 runner 与 mock，不留孤儿。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, readRecord, killAll, waitFor } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'zcode-executor');
const dirs = [];
const runnerPids = [];
const mockPids = [];
test.after(async () => {
  killAll(runnerPids);
  killAll(mockPids);
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const ZCODE_CONFIG = {
  provider: {
    'builtin:bigmodel': {
      kind: 'anthropic',
      options: { apiKey: 'sk-test-plain' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': {},
      },
    },
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      options: { apiKey: 'sk-test-plan' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': {},
      },
    },
  },
};

// 造环境：mock + 临时家目录（白名单指到 git 仓库）+ new 一条会话
async function setupSend(t, { script, deny } = {}) {
  // 评审 T2.3b 第 10 条：用例开头就登记清理，不等断言后手动补
  t.after(() => {
    killAll(runnerPids);
    killAll(mockPids);
  });
  const mock = await startMock({ script });
  dirs.push(mock.dir);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-run-home-'));
  dirs.push(home);
  const workParent = await mkdtemp(path.join(os.tmpdir(), 'zcode-run-work-'));
  dirs.push(workParent);
  const repo = path.join(workParent, 'repo');
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedRoots: [workParent], review: { enabled: false } })); // T3.2：这组测的是挂起管线本身，模型审批关掉（开了会自动放行）
  const zcodeConfigDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-run-zconfig-'));
  dirs.push(zcodeConfigDir);
  const zcodeConfigPath = path.join(zcodeConfigDir, 'config.json');
  await writeFile(zcodeConfigPath, JSON.stringify(ZCODE_CONFIG));
  const env = {
    ...process.env,
    ZCODE_BIN: mock.zcodePath,
    ZCODE_EXECUTOR_HOME: home,
    ZCODE_CONFIG_PATH: zcodeConfigPath,
    ...mock.env,
  };
  const newArgs = ['new', '--cwd', repo, '--tier', 'strong', '--json'];
  if (deny) newArgs.push('--deny', deny);
  const created = spawnSync(process.execPath, [BIN, ...newArgs], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  assert.equal(created.status, 0, `new 失败：${created.stderr}`);
  const entry = JSON.parse(created.stdout);
  return { mock, home, env, entry, runsDir: path.join(home, 'runs', entry.id), scriptPath: mock.env.MOCK_APPSERVER_SCRIPT, recordPath: mock.env.MOCK_APPSERVER_RECORD };
}

function runBin(env, args, { input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, timeout: 120_000, input });
}

/** runner 常是 detached 的：把 lock 里的 runner pid 和 runner.log 里的 mock pid 记进全局，after() 杀。 */
function trackRunnerPids(runsDir) {
  try {
    const { pid } = JSON.parse(readFileSync(path.join(runsDir, 'lock'), 'utf8'));
    if (Number.isInteger(pid)) runnerPids.push(pid);
  } catch {
    // 锁已经没了：runner 正常退出了
  }
  try {
    const log = readFileSync(path.join(runsDir, 'runner.log'), 'utf8');
    for (const m of log.matchAll(/mock: started version=\S+ pid=(\d+)/g)) mockPids.push(Number(m[1]));
  } catch {
    // 还没起 mock
  }
}

const readEvents = (runsDir) => {
  try {
    return readFileSync(path.join(runsDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return []; // runner 还没建 events.jsonl：waitFor 轮询的前提
  }
};

test('send --wait：completed 全链路（退出码 0、last/events/队列/锁/登记簿）', async (t) => {
  const env = await setupSend(t);
  const run = runBin(env.env, ['send', env.entry.id, '干活', '--wait', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const last = JSON.parse(run.stdout);
  assert.equal(last.outcome, 'done');
  assert.equal(last.text, '干活');

  const lastFile = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8'));
  assert.equal(lastFile.outcome, 'done');
  const events = readEvents(env.runsDir).map((e) => e.type);
  assert.ok(events.includes('executor.send'));
  assert.ok(events.includes('turn.completed'));
  assert.ok(events.includes('executor.result'));
  const queueDir = path.join(env.runsDir, 'queue');
  assert.deepEqual(await readdir(queueDir).then((f) => f.filter((x) => x.endsWith('.json'))), []); // 队列空
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true)); // runner 结算后才退出删锁，等它
  const registry = JSON.parse(await readFile(path.join(env.home, 'sessions.json'), 'utf8'));
  assert.equal(registry.sessions[env.entry.id].lastOutcome, 'done'); // 登记簿更新
});

test('send --wait：剧本 hang + --timeout 1 → 退出码 3，mock 收到 session/stop', async (t) => {
  const env = await setupSend(t, { script: { turns: [{ hang: true }] } });
  const run = runBin(env.env, ['send', env.entry.id, '慢活', '--wait', '--timeout', '1']);
  assert.equal(run.status, 3, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8'));
  assert.equal(last.outcome, 'timeout');
  assert.ok(readRecord(env.mock.env.MOCK_APPSERVER_RECORD).some((m) => m.method === 'session/stop'));
});

test('send：--timeout 非正整数 → 退出码 1（评审 T2.3b 第 8 条）', async (t) => {
  const env = await setupSend(t);
  for (const bad of ['0', 'abc']) {
    const run = runBin(env.env, ['send', env.entry.id, '干活', '--timeout', bad]);
    assert.equal(run.status, 1, `stderr: ${run.stderr}`);
    assert.match(run.stderr, /--timeout/);
  }
});

test('send --wait：剧本 fail → 退出码 4，reason 带出来', async (t) => {
  const env = await setupSend(t, { script: { turns: [{ fail: { code: 'boom', message: '炸了' } }] } });
  const run = runBin(env.env, ['send', env.entry.id, '会炸的活', '--wait']);
  assert.equal(run.status, 4, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  assert.match(run.stdout, /failed/);
  assert.match(run.stdout, /炸了/);
  const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8'));
  assert.equal(last.outcome, 'failed');
});

test('send --wait：审批挂起 → 5 且 runner 活着；带 requestId 的 answer → 继续到 done', async (t) => {
  const env = await setupSend(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'hello.txt' }, reason: '有副作用' } }] },
  });
  const run = runBin(env.env, ['send', env.entry.id, '写文件', '--wait']);
  assert.equal(run.status, 5, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  assert.match(run.stdout, /挂起·审批/);
  assert.match(run.stdout, /Write/);
  const pending = JSON.parse(await readFile(path.join(env.runsDir, 'pending.json'), 'utf8'));
  assert.equal(pending.toolName, 'Write');
  // runner 先写 pending.json 再改 state.phase（pending.mjs runPending 的顺序），send --wait 看到前者就退 5，
  // 所以这里等一下后者，不然在慢机器（CI）上会撞上中间态 running
  await waitFor(async () => {
    const state = JSON.parse(await readFile(path.join(env.runsDir, 'state.json'), 'utf8'));
    return state.phase === 'pending' ? state : undefined;
  });
  assert.ok(readFileSync(path.join(env.runsDir, 'lock'), 'utf8').length > 0, 'runner 还活着（锁还在）');
  trackRunnerPids(env.runsDir);

  // 答案必须带 pending 的 requestId（评审 T2.3b 第 2 条）
  await writeFile(path.join(env.runsDir, 'answer.json'), JSON.stringify({ decision: 'allow', requestId: pending.requestId }));
  await waitFor(
    async () => {
      const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8').catch(() => '{}'));
      return last.outcome === 'done' ? last : undefined;
    },
    { timeoutMs: 15000 },
  );
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), false); // 应答后 pending 删除
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true)); // 队列空 runner 退出
  assert.equal(existsSync(path.join(env.runsDir, 'answer.json')), false); // 消费掉的答案文件也删了
});

test('陈年 answer.json：无 requestId 不被答；带正确 requestId 才被答（评审 T2.3b 第 2 条）', async (t) => {
  const env = await setupSend(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'hello.txt' }, reason: '有副作用' } }] },
  });
  // 预先放一个陈年答案（无 requestId）：runner 启动时清掉，挂起不能被它自动放行
  await mkdir(env.runsDir, { recursive: true });
  await writeFile(path.join(env.runsDir, 'answer.json'), JSON.stringify({ decision: 'allow' }));
  const run = runBin(env.env, ['send', env.entry.id, '写文件', '--wait']);
  assert.equal(run.status, 5, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), true);
  // 再放一个 requestId 对不上的：丢弃并留 stderr，挂起保持
  await writeFile(path.join(env.runsDir, 'answer.json'), JSON.stringify({ decision: 'allow', requestId: 'req_wrong' }));
  await waitFor(async () => {
    const log = await readFile(path.join(env.runsDir, 'runner.log'), 'utf8').catch(() => '');
    return /requestId 对不上/.test(log) ? log : undefined;
  });
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), true); // 还挂着
  const pending = JSON.parse(await readFile(path.join(env.runsDir, 'pending.json'), 'utf8'));
  trackRunnerPids(env.runsDir);
  await writeFile(path.join(env.runsDir, 'answer.json'), JSON.stringify({ decision: 'allow', requestId: pending.requestId }));
  await waitFor(
    async () => {
      const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8').catch(() => '{}'));
      return last.outcome === 'done' ? last : undefined;
    },
    { timeoutMs: 15000 },
  );
});

test('已挂起的会话 send --wait 立刻 5，不比时间（评审 T2.3b 第 3 条）', async (t) => {
  const env = await setupSend(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'hello.txt' }, reason: '有副作用' } }] },
  });
  const first = runBin(env.env, ['send', env.entry.id, '先来的']);
  assert.equal(first.status, 0, first.stderr);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  await new Promise((resolve) => setTimeout(resolve, 3000)); // 挂起 3 秒后
  const started = Date.now();
  const second = runBin(env.env, ['send', env.entry.id, '后来的', '--wait']);
  const elapsed = Date.now() - started;
  assert.equal(second.status, 5, `stdout: ${second.stdout} stderr: ${second.stderr}`);
  assert.ok(elapsed < 2000, `--wait 应立刻返回，实际 ${elapsed}ms`); // 不等 runner，也不被 3 秒间隔拖住
  trackRunnerPids(env.runsDir);
});

test('连发两条不 --wait：队列按时间戳顺序投递，两条都进 events', async (t) => {
  const env = await setupSend(t);
  const a = runBin(env.env, ['send', env.entry.id, '第一件']);
  const b = runBin(env.env, ['send', env.entry.id, '第二件']);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  assert.match(a.stdout, /已排队，runner pid \d+/);
  await waitFor(async () => {
    const events = readEvents(env.runsDir).filter((e) => e.type === 'executor.result');
    return events.length >= 2 ? events : undefined;
  });
  const sends = readEvents(env.runsDir).filter((e) => e.type === 'executor.send');
  assert.deepEqual(sends.map((e) => e.text), ['第一件', '第二件']); // 顺序正确
  const queueFiles = await readdir(path.join(env.runsDir, 'queue'));
  assert.equal(queueFiles.filter((f) => f.endsWith('.json')).length, 0);
  trackRunnerPids(env.runsDir);
});

test('_runner：已有活 runner → 退出码 2；死 pid 的陈年锁 → 新 runner 覆盖', async (t) => {
  const env = await setupSend(t, { script: { turns: [{ hang: true }] } });
  const first = runBin(env.env, ['send', env.entry.id, '占住 runner 的活']);
  assert.equal(first.status, 0, first.stderr);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'lock')) ? true : undefined));
  trackRunnerPids(env.runsDir); // 这个 runner 最后要靠 after() 杀
  const second = runBin(env.env, ['_runner', env.entry.id]);
  assert.equal(second.status, 2, `stderr: ${second.stderr}`);
  assert.match(second.stderr, /已有 runner/);

  // 杀掉活 runner（留下死锁与未消费的队列项），写一个死 pid 的锁，新 runner 应当覆盖锁、
  // 重投队列里那一条并正常退出。先把剧本换成能完成的：新 runner 起来时读到的是新剧本
  const deadLock = JSON.parse(readFileSync(path.join(env.runsDir, 'lock'), 'utf8'));
  try {
    process.kill(deadLock.pid, 'SIGKILL');
  } catch {
    // 已经死了
  }
  await waitFor(async () => {
    try {
      process.kill(deadLock.pid, 0);
      return undefined; // 还没死透
    } catch {
      return true;
    }
  });
  assert.equal((await readdir(path.join(env.runsDir, 'queue'))).length, 1); // 崩溃的 runner 没消费
  await writeFile(env.scriptPath, JSON.stringify({ turns: [{}] }));
  await writeFile(path.join(env.runsDir, 'lock'), JSON.stringify({ pid: 999999999, startedAt: '2026-01-01T00:00:00Z' }));
  const third = runBin(env.env, ['_runner', env.entry.id]);
  assert.equal(third.status, 0, `stderr: ${third.stderr}`); // 覆盖陈年锁，重投后队列空正常退出
  assert.equal(existsSync(path.join(env.runsDir, 'lock')), false);
  const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8'));
  assert.equal(last.outcome, 'done'); // 崩溃前留下的投递被重投完成
});

test('同时起两个 _runner：恰好一个成功一个退 2（linkSync 锁，评审 T2.3b 第 4 条）', async (t) => {
  const env = await setupSend(t, { script: { turns: [{ hang: true }] } });
  // 直接往队列放一条带 1 秒超时的投递：赢家处理到 timeout 后退出，输家立刻退 2
  const { enqueue } = await import('../lib/queue.mjs');
  enqueue(env.home, env.entry.id, { text: '恰好一个赢', timeoutSec: 1 });
  const children = ['A', 'B'].map(() =>
    spawn(process.execPath, [BIN, '_runner', env.entry.id], { env: env.env, stdio: 'ignore' }),
  );
  const codes = await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          child.on('close', (code) => resolve(code));
        }),
    ),
  );
  trackRunnerPids(env.runsDir);
  assert.deepEqual(codes.slice().sort(), [0, 2]); // 恰一个成功一个退 2
  const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8'));
  assert.equal(last.outcome, 'timeout'); // 赢家把投递跑完（hang + 1s 超时）
});

test('剧本 exitAfter:send → last exited 且队列文件保留；改剧本重投成功', async (t) => {
  const env = await setupSend(t, { script: { exitAfter: 'session/send' } });
  const run = runBin(env.env, ['send', env.entry.id, '一次性的活', '--wait', '--json']);
  assert.equal(run.status, 4, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  const last = JSON.parse(run.stdout);
  assert.equal(last.outcome, 'exited');
  const queueFiles = await readdir(path.join(env.runsDir, 'queue'));
  assert.equal(queueFiles.filter((f) => f.endsWith('.json')).length, 1); // 未消费，留给下个 runner
  trackRunnerPids(env.runsDir);

  // 换剧本：新起的 runner 读到的是新剧本，旧投递重投成功
  await writeFile(env.scriptPath, JSON.stringify({ turns: [{}] }));
  const retry = runBin(env.env, ['send', env.entry.id, '再来一次', '--wait', '--json']);
  assert.equal(retry.status, 0, `stderr: ${retry.stderr}`);
  assert.equal(JSON.parse(retry.stdout).outcome, 'done');
  const left = await readdir(path.join(env.runsDir, 'queue'));
  assert.equal(left.filter((f) => f.endsWith('.json')).length, 0); // 重投后队列清空
});

test('投递重投超过 2 次 → 按 failed 丢弃并清队列（评审 T2.3b 第 9 条）', async (t) => {
  const env = await setupSend(t, { script: { exitAfter: 'session/send' } }); // 剧本一直是坏剧本
  // 第一次入队（attempts 1）：exited，队列文件保留
  const first = runBin(env.env, ['send', env.entry.id, '投一次', '--wait', '--json']);
  assert.equal(first.status, 4);
  assert.equal(JSON.parse(first.stdout).outcome, 'exited');
  // 直接 _runner 重投（attempts 2）：还是 exited，文件保留
  const second = runBin(env.env, ['_runner', env.entry.id]);
  assert.equal(second.status, 0, second.stderr);
  // 第三次取出（attempts 3 > 2）：不再投递，按 failed 丢弃，队列清空
  const third = runBin(env.env, ['_runner', env.entry.id]);
  assert.equal(third.status, 0, third.stderr); // runner 正常收场
  const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8'));
  assert.equal(last.outcome, 'failed');
  assert.match(last.reason, /重投 2 次/);
  const left = await readdir(path.join(env.runsDir, 'queue'));
  assert.equal(left.filter((f) => f.endsWith('.json')).length, 0);
  const failedEvents = readEvents(env.runsDir).filter((e) => e.type === 'executor.result' && e.outcome === 'failed');
  assert.equal(failedEvents.length, 1); // failed 也写了事件
  trackRunnerPids(env.runsDir);
});

test('runner 阶段方法集合：推了 provider 表且排在 resume 前（评审 T2.3b 第 1 条）', async (t) => {
  const env = await setupSend(t);
  const run = runBin(env.env, ['send', env.entry.id, '干活', '--wait', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const methods = readRecord(env.mock.env.MOCK_APPSERVER_RECORD).map((m) => m.method).filter(Boolean);
  const runnerStart = methods.lastIndexOf('workspace/updateProviderRegistry'); // runner 推表那一次
  assert.ok(runnerStart >= 0);
  const runnerMethods = methods.slice(runnerStart);
  assert.deepEqual([...new Set(runnerMethods)].sort(), [
    'session/close',
    'session/create',
    'session/send',
    'session/subscribe',
    'workspace/updateProviderRegistry',
  ]); // 首投走 create 路径：没有 resume（第二次 send 才 resume，见 D13 专用用例）
});

test('runner 启动白名单复查：登记簿 cwd 改到白名单外 → _runner 退 2 且锁删掉（评审 T2.3b 第 10 条）', async (t) => {
  const env = await setupSend(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'zcode-run-outside-')); // 存在但在白名单外
  dirs.push(outside);
  const registryPath = path.join(env.home, 'sessions.json');
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  registry.sessions[env.entry.id].cwd = outside;
  await writeFile(registryPath, JSON.stringify(registry));
  const run = runBin(env.env, ['_runner', env.entry.id]);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /不在白名单/);
  assert.equal(existsSync(path.join(env.runsDir, 'lock')), false); // 锁清掉了
  const state = JSON.parse(await readFile(path.join(env.runsDir, 'state.json'), 'utf8'));
  assert.equal(state.phase, 'exited'); // state 写了 exited 带 error（T2.3b 第 14 条）
  assert.match(state.error, /白名单/);
});

test('runner.log 不含明文密钥（评审 T2.3b 第 10 条）', async (t) => {
  const env = await setupSend(t);
  const run = runBin(env.env, ['send', env.entry.id, '干活', '--wait', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const log = await readFile(path.join(env.runsDir, 'runner.log'), 'utf8');
  assert.ok(log.length > 0); // 日志确实有内容
  assert.equal(log.includes('sk-test-plain'), false);
  assert.equal(log.includes('sk-test-plan'), false);
});

test('send --task：不存在退出码 1；存在则队列项、state.current、last 都是绝对路径', async (t) => {
  const env = await setupSend(t, { script: { turns: [{ hang: true }] } });
  const missing = runBin(env.env, ['send', env.entry.id, '干活', '--task', '/nonexistent/task.md']);
  assert.equal(missing.status, 1, `stderr: ${missing.stderr}`);
  assert.match(missing.stderr, /--task 文件不存在/);

  const taskAbs = path.join(env.home, '任务单.md');
  await writeFile(taskAbs, '# 任务');
  const run = runBin(env.env, ['send', env.entry.id, '按任务单干活', '--task', taskAbs, '--timeout', '1']);
  assert.equal(run.status, 0, run.stderr); // 不带 --wait 立刻返回
  // hang 期间队列项还在（投递中不删），里面的 task 是绝对路径
  await waitFor(async () => {
    const files = (await readdir(path.join(env.runsDir, 'queue'))).filter((f) => f.endsWith('.json'));
    return files.length > 0 ? files : undefined;
  }).catch(() => {}); // 消费很快的话这里就不强求了
  await waitFor(async () => {
    const state = JSON.parse(await readFile(path.join(env.runsDir, 'state.json'), 'utf8').catch(() => '{}'));
    return state.current ? state : undefined;
  });
  const state = JSON.parse(await readFile(path.join(env.runsDir, 'state.json'), 'utf8'));
  assert.equal(state.current.task, taskAbs);
  trackRunnerPids(env.runsDir);
  await waitFor(
    async () => {
      const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8').catch(() => '{}'));
      return last.outcome === 'timeout' ? last : undefined;
    },
    { timeoutMs: 15000 }, // 1s 超时 + 5s stop 宽限 + 启动开销，5s 默认等不到
  );
  const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8'));
  assert.equal(last.task, taskAbs); // last.json 也带绝对路径
});

test('send：会话不在登记簿 → 退出码 2', async (t) => {
  const env = await setupSend(t);
  const run = runBin(env.env, ['send', 'sess_missing', '干活']);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /不在登记簿/);
});

test('send：正文 - 从 stdin 读', async (t) => {
  const env = await setupSend(t);
  const run = runBin(env.env, ['send', env.entry.id, '-', '--wait', '--json'], { input: '来自 stdin 的投递' });
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const last = JSON.parse(run.stdout);
  assert.equal(last.text, '来自 stdin 的投递');
});

// ---------- D13：new 不建会话，runner 先 create 后 resume（T2.4b） ----------

test('D13：首次 send 建 zcode 会话——create 带登记簿的 runtimeModel/thoughtLevel/toolDenylist', async (t) => {
  const env = await setupSend(t, { script: {}, deny: 'WebSearch' });
  const run = runBin(env.env, ['send', env.entry.id, '首投', '--wait', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  // 登记簿写回了 zcode 的 sessionId
  const registry = JSON.parse(await readFile(path.join(env.home, 'sessions.json'), 'utf8'));
  const entry = registry.sessions[env.entry.id];
  assert.match(entry.sessionId, /^sess_/);
  // mock 记录的 create：runtimeModel / thoughtLevel / toolDenylist 都从登记簿带下来
  const create = readRecord(env.recordPath).filter((m) => m.method === 'session/create');
  assert.equal(create.length, 1);
  const p = create[0].params;
  assert.equal(p.runtimeModel.model.modelId, entry.modelId);
  assert.equal(p.runtimeModel.model.providerId, entry.provider);
  assert.equal(p.runtimeModel.provider.providerId, entry.provider);
  assert.deepEqual(p.toolDenylist, ['WebSearch']);
  assert.equal(p.thoughtLevel, 'high');
});

test('D13：第二次 send 走 resume，不再 create', async (t) => {
  const env = await setupSend(t, { script: {} });
  const a = runBin(env.env, ['send', env.entry.id, '第一投', '--wait']);
  assert.equal(a.status, 0, a.stderr);
  // 等第一个 runner 退出（队列空就退，锁随之删）：第二投才会起新 runner 走 resume；
  // 慢机器上 runner 还没退就投第二条，会走同一连接，没有 resume
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true));
  const b = runBin(env.env, ['send', env.entry.id, '第二投', '--wait']);
  assert.equal(b.status, 0, b.stderr);
  const methods = readRecord(env.recordPath).map((m) => m.method).filter(Boolean);
  assert.equal(methods.filter((m) => m === 'session/create').length, 1); // 只有第一次 create
  assert.ok(methods.filter((m) => m === 'session/resume').length >= 1); // 第二次 resume
});

test('D13：resume 报 Session not found → 记 executor.recreated、重新 create、登记簿写回新 id', async (t) => {
  const env = await setupSend(t, { script: {} });
  const first = runBin(env.env, ['send', env.entry.id, '第一投', '--wait', '--json']);
  assert.equal(first.status, 0, first.stderr);
  const oldSessionId = JSON.parse(await readFile(path.join(env.home, 'sessions.json'), 'utf8')).sessions[env.entry.id].sessionId;

  // 换剧本：resume 一律报 Session not found（create 照常成功）
  await writeFile(env.scriptPath, JSON.stringify({
    errors: { 'session/resume': { code: -32000, message: 'Session not found' } },
  }));
  const run = runBin(env.env, ['send', env.entry.id, '丢了重来', '--wait', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const recreated = readEvents(env.runsDir).find((e) => e.type === 'executor.recreated');
  assert.ok(recreated, 'events 里要有 executor.recreated');
  assert.equal(recreated.oldSessionId, oldSessionId);
  const registry = JSON.parse(await readFile(path.join(env.home, 'sessions.json'), 'utf8'));
  const newSessionId = registry.sessions[env.entry.id].sessionId;
  assert.match(newSessionId, /^sess_/);
  assert.notEqual(newSessionId, oldSessionId); // 写回了新 id
  const creates = readRecord(env.recordPath).filter((m) => m.method === 'session/create');
  assert.ok(creates.length >= 2); // 重建时又 create 了一次
});

test('T2.4b：resume 其它错误 → runner 退出、state exited、send --wait 2 秒内退 4、无残留', async (t) => {
  const env = await setupSend(t, { script: {} });
  const first = runBin(env.env, ['send', env.entry.id, '第一投', '--wait', '--json']);
  assert.equal(first.status, 0, first.stderr);
  trackRunnerPids(env.runsDir);

  await writeFile(env.scriptPath, JSON.stringify({
    errors: { 'session/resume': { code: -32000, message: '数据库锁住了' } },
  }));
  const started = Date.now();
  const run = runBin(env.env, ['send', env.entry.id, '第二投', '--wait', '--json']);
  const elapsed = Date.now() - started;
  assert.equal(run.status, 4, `stdout: ${run.stdout} stderr: ${run.stderr}`);
  assert.ok(elapsed < 2000, `应 2 秒内退 4，实际 ${elapsed}ms`);
  const out = JSON.parse(run.stdout);
  assert.equal(out.kind, 'runner-gone');
  assert.match(out.reason, /数据库锁住了/);
  const state = JSON.parse(await readFile(path.join(env.runsDir, 'state.json'), 'utf8'));
  assert.equal(state.phase, 'exited');
  assert.match(state.error, /数据库锁住了/);
  // runner 进程确实退出了（无残留）
  await waitFor(async () => {
    try {
      process.kill(state.pid, 0);
      return undefined;
    } catch {
      return true;
    }
  });
});
