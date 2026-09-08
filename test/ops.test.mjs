// follow / status / cancel / list / steer / stream 的行为测试（T2.4）：
// 全部对 test/mock-appserver.mjs 跑，子进程跑 bin，不发真 session/send，不花额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
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

const envFor = (home, mock, zcodeConfigPath) => ({
  ...process.env,
  ZCODE_BIN: mock.zcodePath,
  ZCODE_EXECUTOR_HOME: home,
  ZCODE_CONFIG_PATH: zcodeConfigPath,
  ZCODE_EXECUTOR_CANCEL_GRACE_MS: '600', // 压短 cancel 宽限（T2.6b 第 10 条）
  ...mock.env,
});

// 造环境：mock + 临时家目录（白名单指到 git 仓库）+ new 一条会话
async function setupOps(t, { script, title = 't' } = {}) {
  t.after(() => {
    killAll(runnerPids);
    killAll(mockPids);
  });
  const mock = await startMock({ script });
  dirs.push(mock.dir);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-ops-home-'));
  dirs.push(home);
  const workParent = await mkdtemp(path.join(os.tmpdir(), 'zcode-ops-work-'));
  dirs.push(workParent);
  const repo = path.join(workParent, 'repo');
  execFileSync('git', ['init', '--quiet', repo]);
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'init'], { cwd: repo });
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedRoots: [workParent], review: { enabled: false } })); // T3.2：这组测的是挂起管线本身，模型审批关掉（开了会自动放行）
  const zcodeConfigDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-ops-zconfig-'));
  dirs.push(zcodeConfigDir);
  const zcodeConfigPath = path.join(zcodeConfigDir, 'config.json');
  await writeFile(zcodeConfigPath, JSON.stringify(ZCODE_CONFIG));
  const env = envFor(home, mock, zcodeConfigPath);
  const created = spawnSync(process.execPath, [BIN, 'new', '--cwd', repo, '--title', title, '--tier', 'strong', '--json'], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  assert.equal(created.status, 0, `new 失败：${created.stderr}`);
  const entry = JSON.parse(created.stdout);
  return {
    mock,
    home,
    env,
    entry,
    runsDir: path.join(home, 'runs', entry.id),
    recordPath: mock.env.MOCK_APPSERVER_RECORD,
  };
}

function trackRunnerPids(runsDir) {
  try {
    const { pid } = JSON.parse(readFileSync(path.join(runsDir, 'lock'), 'utf8'));
    if (Number.isInteger(pid)) runnerPids.push(pid);
  } catch {
    // 锁已经没了
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
    return [];
  }
};

// ---------- follow ----------

test('follow：后台 send 后 follow 等到 done，退出码 0', async (t) => {
  const env = await setupOps(t, {
    // 回合拖 3 秒，保证 follow 起来时投递还在进行中（不受负载下的调度抖动影响）
    script: { turns: [{ events: [
      { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'x' }, delayMs: 1500 },
      { type: 'tool.updated', payload: { toolName: 'Write', kind: 'started' }, delayMs: 1500 },
    ] } ] },
  });
  const queued = runBin(env.env, ['send', env.entry.id, '后台的活']);
  assert.equal(queued.status, 0, queued.stderr);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'lock')) ? true : undefined)); // runner 已接管
  const follow = runBin(env.env, ['follow', env.entry.id, '--json']);
  assert.equal(follow.status, 0, `stderr: ${follow.stderr}`);
  const last = JSON.parse(follow.stdout);
  assert.equal(last.kind, 'last');
  assert.equal(last.outcome, 'done');
});

test('follow：剧本 hang + --timeout 1 → 3，且 mock 记录里没有 session/stop（旁观者不取消）', async (t) => {
  const env = await setupOps(t, { script: { turns: [{ hang: true }] } });
  runBin(env.env, ['send', env.entry.id, '挂着的活']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'lock')) ? true : undefined));
  const started = Date.now();
  const follow = runBin(env.env, ['follow', env.entry.id, '--timeout', '1']);
  assert.equal(follow.status, 3, `stderr: ${follow.stderr}`);
  assert.ok(Date.now() - started >= 900); // 真的等了 1 秒
  assert.match(follow.stdout, /没有取消任何东西/);
  assert.equal(readRecord(env.recordPath).some((m) => m.method === 'session/stop'), false);
  trackRunnerPids(env.runsDir);
});

test('follow：runner 被 SIGKILL → 退出码 4「runner 没了」', async (t) => {
  const env = await setupOps(t, { script: { turns: [{ hang: true }] } });
  runBin(env.env, ['send', env.entry.id, '要被杀的活']);
  // 等 state.json 写成 running 再杀：只等 lock 就杀，state 可能还没落盘，死后判不出 stale
  await waitFor(async () => {
    try { return JSON.parse(readFileSync(path.join(env.runsDir, 'state.json'), 'utf8')).phase === 'running' ? true : undefined; }
    catch { return undefined; }
  });
  trackRunnerPids(env.runsDir);
  const { pid } = JSON.parse(readFileSync(path.join(env.runsDir, 'lock'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await waitFor(async () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  });
  const follow = runBin(env.env, ['follow', env.entry.id, '--json']);
  assert.equal(follow.status, 4, `stderr: ${follow.stderr}`);
  const out = JSON.parse(follow.stdout);
  assert.equal(out.kind, 'runner-gone');
  assert.equal(out.outcome, 'exited');
});

// ---------- status ----------

test('status：running / pending / idle 三态与 --json 字段恒定', async (t) => {
  // running：hang 剧本 + 后台投递
  const running = await setupOps(t, { script: { turns: [{ hang: true }], events: undefined } });
  running.scriptFix = null;
  runBin(running.env, ['send', running.entry.id, '在跑的活']);
  await waitFor(async () => {
    const s = runBin(running.env, ['status', running.entry.id, '--json']);
    const out = JSON.parse(s.stdout);
    // phase 在 runner 起来时就是 running，current 要等投递取出队列才有，等两者都齐
    return out.phase === 'running' && out.current ? out : undefined;
  });
  const runningStatus = JSON.parse(runBin(running.env, ['status', running.entry.id, '--json']).stdout);
  assert.equal(runningStatus.phase, 'running');
  assert.match(runningStatus.current.text, /在跑的活/);
  trackRunnerPids(running.runsDir);

  // pending：审批剧本
  const pending = await setupOps(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(pending.env, ['send', pending.entry.id, '要批的活']);
  await waitFor(async () => (existsSync(path.join(pending.runsDir, 'pending.json')) ? true : undefined));
  const pendingStatus = JSON.parse(runBin(pending.env, ['status', pending.entry.id, '--json']).stdout);
  assert.equal(pendingStatus.phase, 'pending');
  assert.equal(pendingStatus.pending.kind, 'permission');
  assert.equal(pendingStatus.pending.toolName, 'Write');
  trackRunnerPids(pending.runsDir);

  // idle：从未跑过 runner 的新会话（无 state.json → idle）
  const idle = await setupOps(t);
  const idleStatus = JSON.parse(runBin(idle.env, ['status', idle.entry.id, '--json']).stdout);
  assert.equal(idleStatus.phase, 'idle');

  // exited：跑完一条之后（runner 正常退出）
  runBin(idle.env, ['send', idle.entry.id, '跑完的活', '--wait']);
  // --wait 在结算后返回，runner 随后才 close 连接、写 exited、删锁：等它
  const exitedStatus = await waitFor(async () => {
    const out = JSON.parse(runBin(idle.env, ['status', idle.entry.id, '--json']).stdout);
    return out.phase === 'exited' ? out : undefined;
  });
  assert.equal(exitedStatus.phase, 'exited');
  assert.equal(exitedStatus.last.outcome, 'done');
  // --json 字段恒定
  assert.deepEqual(Object.keys(exitedStatus).sort(), Object.keys(runningStatus).sort());
});

test('status：runner 死了 state 残留 running → stale', async (t) => {
  const env = await setupOps(t, { script: { turns: [{ hang: true }] } });
  runBin(env.env, ['send', env.entry.id, '要被杀的活']);
  // 等 state.json 写成 running 再杀：只等 lock 就杀，state 可能还没落盘，死后判不出 stale
  await waitFor(async () => {
    try { return JSON.parse(readFileSync(path.join(env.runsDir, 'state.json'), 'utf8')).phase === 'running' ? true : undefined; }
    catch { return undefined; }
  });
  trackRunnerPids(env.runsDir);
  const { pid } = JSON.parse(readFileSync(path.join(env.runsDir, 'lock'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await waitFor(async () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  });
  const out = JSON.parse(runBin(env.env, ['status', env.entry.id, '--json']).stdout);
  assert.equal(out.phase, 'stale');
});

test('status：--tools 取最近工具调用，上下文占用来自 turn.completed', async (t) => {
  const env = await setupOps(t, {
    script: {
      turns: [
        {
          events: [
            { type: 'tool.updated', payload: { toolName: 'Write', kind: 'started' } },
            { type: 'tool.updated', payload: { toolName: 'Bash', kind: 'started' } },
          ],
        },
      ],
    },
  });
  runBin(env.env, ['send', env.entry.id, '带工具的活', '--wait']);
  const out = JSON.parse(runBin(env.env, ['status', env.entry.id, '--tools', '1', '--json']).stdout);
  assert.equal(out.tools.length, 1);
  assert.equal(out.tools[0].toolName, 'Bash'); // 最近 1 条
  assert.equal(typeof out.totalTokens, 'number');
  const human = runBin(env.env, ['status', env.entry.id]);
  assert.match(human.stdout, /最近工具: Write\(started\)、Bash\(started\)/); // 不传 --tools 默认 5 条
  assert.match(human.stdout, /上下文: \d+ tokens/);
});

// ---------- cancel ----------

test('cancel：回合进行中 cancel → mock 收到 session/stop，last 结算 cancelled，events 有 executor.cancel', async (t) => {
  const env = await setupOps(t, { script: { turns: [{ hang: true }] } });
  const queued = runBin(env.env, ['send', env.entry.id, '要取消的活']);
  assert.equal(queued.status, 0, queued.stderr);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'lock')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  // 等回合真的开始（executor.send 落盘）再 cancel：cancel 会清空队列，落在 runner 取队列之前
  // 就没有回合可停，session/stop 永远不会来（CI 慢机器上复现过）
  await waitFor(async () => (readEvents(env.runsDir).some((e) => e.type === 'executor.send') ? true : undefined));
  const cancel = runBin(env.env, ['cancel', env.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /已通知 runner/);
  // runner 的回合内轮询 500ms 一次，见到 cancel 文件才发 session/stop：轮询等它出现
  await waitFor(async () => {
    const stop = readRecord(env.recordPath).some((m) => m.method === 'session/stop');
    return stop ? stop : undefined;
  });
  // 剧本 hang 且没给 --timeout：只有 cancel 能让回合停。宽限过后 runner 断开连接，
  // 回合按 cancelled 结算，runner 随后退出（T2.4d 第 2 条；宽限经环境变量压短）
  await waitFor(
    async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true),
    { timeoutMs: 20000 },
  );
  const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8'));
  assert.equal(last.outcome, 'cancelled');
  assert.equal(last.reason, '已被 cancel 叫停');
  const queueLeft = await readdir(path.join(env.runsDir, 'queue'));
  assert.equal(queueLeft.filter((f) => f.endsWith('.json')).length, 0); // 队列清空
  assert.ok(readEvents(env.runsDir).some((e) => e.type === 'executor.cancel')); // events 有 executor.cancel
});

test('cancel：挂起中 cancel → mock 收到 deny 应答（评审要求验证 deny 通路）', async (t) => {
  const env = await setupOps(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '要取消的审批']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const cancel = runBin(env.env, ['cancel', env.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  await waitFor(async () => {
    const answers = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined);
    const deny = answers.find((m) => m.result?.decision === 'deny');
    return deny ? deny : undefined;
  });
  // deny 之后回合继续结算，runner 随后退出
  await waitFor(
    async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true),
    { timeoutMs: 20000 },
  );
});

test('cancel：提问挂起中 cancel → mock 收到 {action:decline} 拒答（T2.4d 第 4 条）', async (t) => {
  const env = await setupOps(t, {
    script: {
      turns: [{ question: { questions: [{ question: '继续吗？', options: [{ value: 'yes', label: '继续' }, { value: 'no', label: '停' }] }] } }],
    },
  });
  runBin(env.env, ['send', env.entry.id, '要取消的提问']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const cancel = runBin(env.env, ['cancel', env.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  // 提问没法替人写答案，cancel 不写 answer.json；回合内观察点见 pending 就放手，由挂起轮询
  // 消费 cancel 文件并替人 decline——收不到 decline 就是观察点抢了 cancel 文件
  await waitFor(async () => {
    const answers = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined);
    const decline = answers.find((m) => m.result?.action === 'decline');
    return decline ? decline : undefined;
  });
  // 拒答之后回合照常结算，runner 随后退出
  await waitFor(
    async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true),
    { timeoutMs: 20000 },
  );
});

test('cancel：会话不在登记簿 → 退出码 2', async (t) => {
  const env = await setupOps(t);
  const run = runBin(env.env, ['cancel', 'sess_missing']);
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /不在登记簿/);
});

// ---------- list ----------

test('list：两条会话都列出，--project 过滤，phase 用同一套判定', async (t) => {
  const env = await setupOps(t, { title: '第一单' });
  // 第二条会话：同一个 home，另一个仓库
  const repo2 = path.join(path.dirname(env.entry.cwd), 'repo2');
  execFileSync('git', ['init', '--quiet', repo2]);
  const created = spawnSync(process.execPath, [BIN, 'new', '--cwd', repo2, '--title', 'special-第二单', '--json'], {
    encoding: 'utf8',
    env: env.env,
    timeout: 60_000,
  });
  assert.equal(created.status, 0, created.stderr);
  const list = runBin(env.env, ['list', '--json']);
  assert.equal(list.status, 0, list.stderr);
  const out = JSON.parse(list.stdout);
  assert.equal(out.sessions.length, 2);
  assert.deepEqual(out.sessions.map((s) => s.phase), ['idle', 'idle']);
  const filtered = runBin(env.env, ['list', '--project', 'special', '--json']);
  const filteredOut = JSON.parse(filtered.stdout);
  assert.equal(filteredOut.sessions.length, 1);
  assert.equal(filteredOut.sessions[0].title, 'special-第二单');
  const human = runBin(env.env, ['list']);
  assert.match(human.stdout, /\[idle\] 第一单/);
  // 人读行带等级与模型（T2.7 第 1 条）
  assert.match(human.stdout, /第一单 — \S+ strong builtin:bigmodel-coding-plan\/GLM-5\.3 zcode 会话未建/);
});

// ---------- steer 与 stream ----------

const LONG_TURN = {
  turns: [
    {
      events: [1, 2, 3, 4, 5].map((i) => ({ type: 'model.streaming', payload: { kind: 'text_delta', delta: `第${i}段` }, delayMs: 600 })),
    },
  ],
};

test('steer：回合进行中 --steer → 第二条 session/send 在第一回合结束之前', async (t) => {
  const env = await setupOps(t, { script: LONG_TURN });
  const first = runBin(env.env, ['send', env.entry.id, '主投递']);
  assert.equal(first.status, 0, first.stderr);
  await new Promise((resolve) => setTimeout(resolve, 800)); // 让回合先跑起来
  const steer = runBin(env.env, ['send', env.entry.id, '插句话', '--steer']);
  assert.equal(steer.status, 0, steer.stderr);
  await waitFor(async () => {
    const events = readEvents(env.runsDir).filter((e) => e.type === 'executor.result');
    return events.length >= 1 ? events : undefined;
  });
  const sends = readRecord(env.recordPath).filter((m) => m.method === 'session/send');
  assert.equal(sends.length, 2); // 主投递 + steer（都是 session/send）
  assert.ok(sends.some((m) => m.params?.content === '插句话'));
  // 评审 T2.4c 第 4 条：executor.steer 必须在该回合 executor.result 之前（steer 分支坏掉此断言即红）
  const types = readEvents(env.runsDir).map((e) => e.type);
  // T2.4d 第 3 条：先断言 steer 事件真的存在再比大小——否则两边 indexOf 都 -1 时比较假绿
  assert.ok(types.indexOf('executor.steer') >= 0, `events 里没有 executor.steer：${types.join('、')}`);
  assert.ok(types.indexOf('executor.steer') < types.indexOf('executor.result'));
  trackRunnerPids(env.runsDir);
});

test('steer：回合不在进行中时按普通投递处理', async (t) => {
  const env = await setupOps(t);
  const run = runBin(env.env, ['send', env.entry.id, '插话当主投递', '--steer', '--wait', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const last = JSON.parse(run.stdout);
  assert.equal(last.outcome, 'done');
  assert.equal(last.text, '插话当主投递');
});

test('stream：send --wait --stream 的 stderr 有 stream: 行且含 text_delta 内容', async (t) => {
  const env = await setupOps(t, {
    script: {
      turns: [
        {
          events: [
            { type: 'model.streaming', payload: { kind: 'text_delta', delta: '你好' }, delayMs: 50 },
            { type: 'model.streaming', payload: { kind: 'text_delta', delta: '流世界' }, delayMs: 50 },
            { type: 'tool.updated', payload: { toolName: 'Write', kind: 'started' } },
          ],
        },
      ],
    },
  });
  const run = runBin(env.env, ['send', env.entry.id, '看流的活', '--wait', '--stream']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /stream: 你好流世界/); // delta 拼接按行刷
  assert.match(run.stderr, /stream: Write started/);
});

function runBin(env, args, { input } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, timeout: 120_000, input });
}

// ---------- T2.4c 补充用例 ----------

test('follow：撞上挂起 → 退出码 5（readPending 容错，评审 T2.4c 第 1 条）', async (t) => {
  const env = await setupOps(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '要批的活']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const follow = runBin(env.env, ['follow', env.entry.id, '--json']);
  assert.equal(follow.status, 5, `stderr: ${follow.stderr}`);
  assert.equal(JSON.parse(follow.stdout).kind, 'permission');
});

test('follow --stream：stderr 出现 stream: 行（评审 T2.4c 第 10 条）', async (t) => {
  const env = await setupOps(t, {
    script: { turns: [{ events: [
      { type: 'model.streaming', payload: { kind: 'text_delta', delta: '流式输出' }, delayMs: 300 },
      { type: 'tool.updated', payload: { toolName: 'Bash', kind: 'started' }, delayMs: 300 },
    ] } ] },
  });
  runBin(env.env, ['send', env.entry.id, '看流']);
  const follow = runBin(env.env, ['follow', env.entry.id, '--stream']);
  assert.equal(follow.status, 0, `stderr: ${follow.stderr}`);
  assert.match(follow.stderr, /stream: 流式输出/);
  assert.match(follow.stderr, /stream: Bash started/);
});

// Windows 上 kill('SIGTERM') 直接终止进程，Node 的处理器不跑，收尾（写 state、删锁）也就不发生——
// 这是真实差距不是测试问题，记在 verified.md「跨平台」一节。
test('SIGTERM：runner 收到后 state exited、lock 删除、进程退出（评审 T2.4c 第 10 条）', { skip: process.platform === 'win32' && 'Windows 收不到 SIGTERM，优雅收尾不成立（已知差距）' }, async (t) => {
  const env = await setupOps(t, { script: { turns: [{ hang: true }] } });
  const { enqueue } = await import('../lib/queue.mjs');
  enqueue(env.home, env.entry.id, { text: '会被 SIGTERM 打断的投递' });
  const runner = spawn(process.execPath, [BIN, '_runner', env.entry.id], {
    env: env.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  runnerPids.push(runner.pid);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'lock')) ? true : undefined));
  runner.kill('SIGTERM');
  const code = await new Promise((resolve) => runner.on('exit', (c) => resolve(c)));
  assert.equal(code, 0);
  const state = JSON.parse(await readFile(path.join(env.runsDir, 'state.json'), 'utf8'));
  assert.equal(state.phase, 'exited');
  assert.match(state.reason, /SIGTERM/);
  assert.equal(existsSync(path.join(env.runsDir, 'lock')), false);
});

test('cancel：runner 死了但 pending 还在 → 清理 pending 与 answer（评审 T2.4c 第 10 条）', async (t) => {
  const env = await setupOps(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '挂着等死的活']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const { pid } = JSON.parse(readFileSync(path.join(env.runsDir, 'lock'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await waitFor(async () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  });
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), true); // 死前挂起还在
  const cancel = runBin(env.env, ['cancel', env.entry.id]);
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /runner 已不在/);
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), false); // 清理掉了
  assert.equal(existsSync(path.join(env.runsDir, 'answer.json')), false);
});

test('phaseOf：挂起中 runner 死了 → stale 而不是 pending（评审 T2.4c 第 7 条）', async (t) => {
  const env = await setupOps(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '挂着等死的活']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const { pid } = JSON.parse(readFileSync(path.join(env.runsDir, 'lock'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await waitFor(async () => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  });
  const out = JSON.parse(runBin(env.env, ['status', env.entry.id, '--json']).stdout);
  assert.equal(out.phase, 'stale'); // 挂起没人消费了：不能谎报 pending
});

test('send：入队前清掉陈年 stop/cancel 标记，新 runner 正常投递（评审 T2.4c 第 8 条）', async (t) => {
  const env = await setupOps(t);
  await mkdir(env.runsDir, { recursive: true });
  const stopFile = path.join(env.runsDir, 'stop');
  const cancelFile = path.join(env.runsDir, 'cancel');
  await writeFile(stopFile, '{}');
  await writeFile(cancelFile, '{}');
  const run = runBin(env.env, ['send', env.entry.id, '陈年标记不该拦住新投递', '--wait', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.equal(JSON.parse(run.stdout).outcome, 'done'); // 若陈年标记没清，runner 会立即停且不投递
  assert.equal(existsSync(stopFile), false);
  assert.equal(existsSync(cancelFile), false);
});

test('--json：send/status 的 id 是本地 id、sessionId 是登记簿里的 sess_（T2.4d 第 6 条）', async (t) => {
  const env = await setupOps(t);
  const run = runBin(env.env, ['send', env.entry.id, '看字段的活', '--wait', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const last = JSON.parse(run.stdout);
  assert.equal(last.id, env.entry.id); // 本地 id
  const registry = JSON.parse(await readFile(path.join(env.home, 'sessions.json'), 'utf8'));
  assert.match(registry.sessions[env.entry.id].sessionId, /^sess_/); // 首回合后 zcode id 已写回
  assert.equal(last.sessionId, registry.sessions[env.entry.id].sessionId); // --json 里是 zcode 的 sess_
  const status = JSON.parse(runBin(env.env, ['status', env.entry.id, '--json']).stdout);
  assert.equal(status.id, env.entry.id);
  assert.equal(status.sessionId, registry.sessions[env.entry.id].sessionId);
});

test('同一回合两次挂起：send --wait 5 → approve → follow 再 5（新 requestId）→ approve → done（T2.6 第 3 条）', async (t) => {
  const env = await setupOps(t, {
    script: {
      turns: [
        {
          // 真机 build 档观察（2026-09-08 检查点 2）：Write 之后又 git -C 跑 Bash，连挂两次
          permissions: [
            { toolName: 'Write', input: { file_path: 'hello.txt' }, reason: '写文件' },
            { toolName: 'Bash', input: { command: 'git -C /tmp status' }, reason: '跑命令' },
          ],
        },
      ],
    },
  });
  const first = runBin(env.env, ['send', env.entry.id, '连挂两次的活', '--wait', '--json']);
  assert.equal(first.status, 5, `stderr: ${first.stderr}`);
  const pending1 = JSON.parse(first.stdout);
  assert.equal(pending1.kind, 'permission');
  trackRunnerPids(env.runsDir);

  const approve1 = runBin(env.env, ['approve', env.entry.id, '--json']);
  assert.equal(approve1.status, 0, approve1.stderr);
  assert.equal(JSON.parse(approve1.stdout).applied, true);
  const requestId1 = JSON.parse(approve1.stdout).requestId;
  assert.equal(requestId1, pending1.requestId);

  const second = runBin(env.env, ['follow', env.entry.id, '--json']);
  assert.equal(second.status, 5, `stderr: ${second.stderr}`);
  const pending2 = JSON.parse(second.stdout);
  assert.equal(pending2.kind, 'permission');
  assert.notEqual(pending2.requestId, requestId1); // 第二次挂起是新 requestId

  const approve2 = runBin(env.env, ['approve', env.entry.id, '--json']);
  assert.equal(approve2.status, 0, approve2.stderr);
  const approve2Out = JSON.parse(approve2.stdout);
  assert.equal(approve2Out.applied, true);
  assert.equal(approve2Out.requestId, pending2.requestId);

  // 第二次放行后回合结算为 done。不等最终 follow：follow 只报「新」结果（PRD），而 runner
  // 消费完应答后几毫秒内就写完 last.json 退出，串行起的 follow 只会撞 runner-gone
  await waitFor(
    async () => {
      const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8').catch(() => '{}'));
      return last.outcome === 'done' ? last : undefined;
    },
    { timeoutMs: 15000 },
  );
  // mock 记录里两次审批请求都得到了 allow 应答
  const allows = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined && m.result?.decision === 'allow');
  assert.equal(allows.length, 2);
});

// ---------- T2.6b ----------

test('挂起卡住回归：回合超时结算后 pending.json 清掉、status 为 exited（T2.6b 第 3 条）', async (t) => {
  const env = await setupOps(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  // send --wait 撞上挂起立刻退 5；队列项里的 --timeout 2 让 runner 在 2 秒后把回合结算成 timeout
  const run = runBin(env.env, ['send', env.entry.id, '挂着超时的活', '--timeout', '2', '--wait', '--json']);
  assert.equal(run.status, 5, `stderr: ${run.stderr}`);
  assert.equal(JSON.parse(run.stdout).kind, 'permission');
  trackRunnerPids(env.runsDir);
  // 回合结束后挂起必须被清掉：残留会让观察点永远让路、status 谎报 pending、send --wait 立刻 5
  await waitFor(
    async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true),
    { timeoutMs: 20000 }, // 2 秒超时 + session 层 5 秒停止宽限
  );
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), false);
  const out = JSON.parse(runBin(env.env, ['status', env.entry.id, '--json']).stdout);
  assert.equal(out.phase, 'exited');
  const last = JSON.parse(await readFile(path.join(env.runsDir, 'last.json'), 'utf8'));
  assert.equal(last.outcome, 'timeout');
});

test('cancel 在挂起出现前被回合内观察点抢走 → 挂起轮询凭 cancelSeen 仍替人 decline（T2.6b 第 4 条真断言）', async (t) => {
  const env = await setupOps(t, {
    script: {
      turns: [
        {
          // 先拖 1.5 秒再发提问：给 cancel 文件留出「被回合内观察点先消费」的时间窗
          events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: '想' }, delayMs: 1500 }],
          question: { questions: [{ question: '继续吗？', options: [{ value: 'yes', label: '继续' }, { value: 'no', label: '停' }] }] },
        },
      ],
    },
  });
  // 这条用例要 runner 在挂起出现后还活着：单独把宽限放宽到 4 秒，别让宽限断开抢在提问之前
  const queued = runBin({ ...env.env, ZCODE_EXECUTOR_CANCEL_GRACE_MS: '4000' }, ['send', env.entry.id, '要取消的提问']);
  assert.equal(queued.status, 0, queued.stderr);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'lock')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  await waitFor(async () => (readEvents(env.runsDir).some((e) => e.type === 'executor.send') ? true : undefined));
  const cancel = runBin(env.env, ['cancel', env.entry.id]); // 落在提问挂起出现之前
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(existsSync(path.join(env.runsDir, 'pending.json')), false);
  // 回合内观察点 500ms 一轮会先吃掉 cancel 文件并置 cancelSeen；随后提问挂起出现，
  // 挂起轮询必须凭 cancelSeen 替人 decline——没有这条通路 mock 就收不到拒答（删掉挂起
  // 让路那行、旧代码下此用例必红）
  await waitFor(
    async () => {
      const answers = readRecord(env.recordPath).filter((m) => m.id !== undefined && m.method === undefined);
      return answers.find((m) => m.result?.action === 'decline') ?? undefined;
    },
    { timeoutMs: 15000 },
  );
  const decline = readRecord(env.recordPath)
    .filter((m) => m.id !== undefined && m.method === undefined)
    .find((m) => m.result?.action === 'decline');
  assert.equal(decline.result.reason, '任务已取消');
  // 事件也带 decline 标记（T2.6b 第 2 条）
  const denyEvent = readEvents(env.runsDir).find((e) => e.type === 'executor.deny' && e.decline === true);
  assert.ok(denyEvent, 'events 里要有带 decline:true 的 executor.deny');
  assert.equal(denyEvent.reason, '任务已取消');
  await waitFor(
    async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true),
    { timeoutMs: 20000 },
  );
});

// ---------- T2.8 ----------

test('结束摘要：闸门计数与文件/Bash 统计进人读输出（T2.8 第 1 条）', async (t) => {
  const env = await setupOps(t, {
    script: {
      turns: [
        {
          // 应答后留 1.5 秒时间窗：等挂起被消费后再起 follow，它能赶上本回合的 last（T2.8）
          permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' },
          completeDelayMs: 1500,
        },
      ],
    },
  });
  runBin(env.env, ['send', env.entry.id, '带闸门的活']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  // 挂起期间补本回合的合成事件：runner 的闸门已真实写了一条 review-disabled ask，
  // 再补红线挂起、快筛放行、慢判放行、慢判转人工，以及带 toolCallId/input 的工具事件
  const lines = [
    { type: 'executor.gate', stage: 'hard', decision: 'ask', ruleId: 'r1', reason: '越界' },
    { type: 'executor.gate', stage: 'review-fast', decision: 'allow', reason: '快筛过' },
    { type: 'executor.gate', stage: 'review-slow', decision: 'allow', reason: '慢判过' },
    { type: 'executor.gate', stage: 'review-slow', decision: 'ask', reason: '判不下' },
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Write', kind: 'scheduled', input: { file_path: 'src/a.ts' } } },
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Write', kind: 'started', input: { file_path: 'src/a.ts' } } },
    { type: 'tool.updated', payload: { toolCallId: 't1', kind: 'result' } },
    { type: 'tool.updated', payload: { toolCallId: 't2', toolName: 'Write', kind: 'scheduled', inputOmitted: true } },
    { type: 'permission.requested', payload: { toolName: 'Write', input: { file_path: 'src/b.ts' } } },
    { type: 'tool.updated', payload: { toolCallId: 't3', toolName: 'Edit', kind: 'scheduled', input: { file_path: 'src/a.ts' } } },
    { type: 'tool.updated', payload: { toolCallId: 't4', toolName: 'Bash', kind: 'scheduled', input: { command: 'ls' } } },
    { type: 'tool.updated', payload: { toolCallId: 't4', toolName: 'Bash', kind: 'started', input: { command: 'ls' } } },
    { type: 'tool.updated', payload: { toolCallId: 't5', toolName: 'Bash', kind: 'scheduled', input: { command: 'git status' } } },
    { type: 'tool.updated', payload: { kind: 'batch' } },
  ];
  await appendFile(path.join(env.runsDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const pending = JSON.parse(await readFile(path.join(env.runsDir, 'pending.json'), 'utf8'));
  await writeFile(path.join(env.runsDir, 'answer.json'), JSON.stringify({ requestId: pending.requestId, decision: 'allow' }));
  // 等挂起被消费（pending 消失）再起 follow：有 completeDelayMs 的时间窗，赶得上本回合的 last
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? undefined : true));
  const follow = runBin(env.env, ['follow', env.entry.id]);
  assert.equal(follow.status, 0, `stderr: ${follow.stderr}`);
  // allow = 快筛 1 + 慢判 1；ask = 真实 review-disabled 1 + 红线 1 + 慢判 1
  assert.match(follow.stdout, /闸门：放行 2 次（红线挂起 1、快筛 1、慢判 2、转人工 3）/);
  // a.ts 由 Write/Edit 共用去重、b.ts 来自 inputOmitted 的兜底；Bash t4 两次是同一次调用
  assert.match(follow.stdout, /改动：a\.ts、b\.ts；Bash 2 条/);
});

test('结束摘要 --json：文件去重且最多 10 个（T2.8 第 1 条）', async (t) => {
  const env = await setupOps(t, {
    script: { turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'x' }, delayMs: 800 }] }] },
  });
  runBin(env.env, ['send', env.entry.id, '一堆文件']);
  await waitFor(async () => (readEvents(env.runsDir).some((e) => e.type === 'executor.send') ? true : undefined));
  trackRunnerPids(env.runsDir);
  const lines = [];
  for (let i = 0; i < 12; i++) {
    lines.push({ type: 'tool.updated', payload: { toolCallId: `w${i}`, toolName: 'Write', kind: 'scheduled', input: { file_path: `src/f${i}.ts` } } });
  }
  lines.push({ type: 'tool.updated', payload: { toolCallId: 'dup', toolName: 'Edit', kind: 'scheduled', input: { file_path: 'src/f3.ts' } } });
  await appendFile(path.join(env.runsDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const follow = runBin(env.env, ['follow', env.entry.id, '--json']);
  assert.equal(follow.status, 0, `stderr: ${follow.stderr}`);
  const out = JSON.parse(follow.stdout);
  assert.equal(out.outcome, 'done');
  assert.equal(out.summary.files.length, 10); // 上限 10 个
  assert.deepEqual(out.summary.files.slice(0, 4), ['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts']);
  assert.ok(out.summary.files.every((f, i, a) => a.indexOf(f) === i)); // 去重
  assert.equal(out.summary.bashCount, 0);
  assert.deepEqual(out.summary.gate, { allow: 0, ask: 0, hard: 0, fast: 0, slow: 0 }); // 没进闸门全是 0
});

test('结束摘要：inputOmitted 用 permission.requested 的 input 兜底（T2.8 第 1 条）', async (t) => {
  const env = await setupOps(t, {
    script: { turns: [{ events: [{ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'x' }, delayMs: 800 }] }] },
  });
  runBin(env.env, ['send', env.entry.id, '省略 input 的活']);
  await waitFor(async () => (readEvents(env.runsDir).some((e) => e.type === 'executor.send') ? true : undefined));
  trackRunnerPids(env.runsDir);
  const lines = [
    // permission.requested 在 tool.updated 之后才到（verified.md「事件流」），兜底必须第二遍回填
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Write', kind: 'scheduled', inputOmitted: true } },
    { type: 'permission.requested', payload: { toolName: 'Write', input: { file_path: 'docs/fallback.md' } } },
    { type: 'tool.updated', payload: { toolCallId: 't2', toolName: 'Bash', kind: 'scheduled', inputOmitted: true } },
  ];
  await appendFile(path.join(env.runsDir, 'events.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const follow = runBin(env.env, ['follow', env.entry.id, '--json']);
  assert.equal(follow.status, 0, `stderr: ${follow.stderr}`);
  const out = JSON.parse(follow.stdout);
  assert.deepEqual(out.summary.files, ['fallback.md']); // 兜底拿到了真路径
  assert.equal(out.summary.bashCount, 1); // Bash 省略 input 也照样计数
});

test('status 最近工具：batch/result 跳过、toolCallId 反查、路径显示 basename（T2.8 第 2 条）', async (t) => {
  const env = await setupOps(t, {
    script: {
      turns: [
        {
          events: [
            { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Write', kind: 'scheduled', input: { file_path: 'docs/deep/x.md' } } },
            { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Write', kind: 'started', input: { file_path: 'docs/deep/x.md' } } },
            { type: 'tool.updated', payload: { toolCallId: 't1', kind: 'result' } },
            { type: 'tool.updated', payload: { kind: 'batch' } },
            { type: 'tool.updated', payload: { toolCallId: 't2', toolName: 'Bash', kind: 'scheduled', input: { command: 'ls' } } },
          ],
        },
      ],
    },
  });
  runBin(env.env, ['send', env.entry.id, '看最近工具', '--wait']);
  const out = JSON.parse(runBin(env.env, ['status', env.entry.id, '--tools', '5', '--json']).stdout);
  assert.deepEqual(out.tools, [
    { toolName: 'Write', kind: 'scheduled', file: 'x.md' },
    { toolName: 'Write', kind: 'started', file: 'x.md' },
    { toolName: 'Write', kind: 'result', file: 'x.md' }, // result 行没有 toolName，靠 toolCallId 反查
    { toolName: 'Bash', kind: 'scheduled', file: null }, // batch 行没有 toolCallId，直接跳过
  ]);
  const human = runBin(env.env, ['status', env.entry.id]);
  assert.match(human.stdout, /最近工具: Write\(x\.md\)、Write\(x\.md\)、Write\(x\.md\)、Bash\(scheduled\)/);
});

test('list：pending 行末尾带「挂起: 工具名」（T2.8 第 3 条）', async (t) => {
  const env = await setupOps(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: 'x' }, reason: '副作用' } }] },
  });
  runBin(env.env, ['send', env.entry.id, '挂着看 list']);
  await waitFor(async () => (existsSync(path.join(env.runsDir, 'pending.json')) ? true : undefined));
  trackRunnerPids(env.runsDir);
  const human = runBin(env.env, ['list']);
  assert.match(human.stdout, /\[pending\] .* 挂起: Write$/m);
  const listed = runBin(env.env, ['list', '--json']);
  assert.equal(JSON.parse(listed.stdout).sessions[0].phase, 'pending'); // --json 字段不动
  const pending = JSON.parse(await readFile(path.join(env.runsDir, 'pending.json'), 'utf8'));
  await writeFile(path.join(env.runsDir, 'answer.json'), JSON.stringify({ requestId: pending.requestId, decision: 'allow' }));
  await waitFor(
    async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true),
    { timeoutMs: 20000 },
  );
});

test('挂起人读输出带规则原文（T2.9 第 6 条）', async (t) => {
  const env = await setupOps(t, {
    script: { turns: [{ permission: { toolName: 'Write', input: { file_path: '/tmp/outside.txt' }, reason: '越界写' } }] },
  });
  // file_path 指在执行副本（repo）之外：红线命中，pending.json 带 ruleId
  const run = runBin(env.env, ['send', env.entry.id, '越界的活', '--wait']);
  assert.equal(run.status, 5, run.stderr);
  assert.match(run.stdout, /挂起·审批：Write/);
  assert.match(run.stdout, /规则 outside-worktree：/); // 规则原文被带出来
  assert.match(run.stdout, /一律转人工/);
  trackRunnerPids(env.runsDir);
  const pending = JSON.parse(await readFile(path.join(env.runsDir, 'pending.json'), 'utf8'));
  assert.equal(pending.ruleId, 'outside-worktree');
  await writeFile(path.join(env.runsDir, 'answer.json'), JSON.stringify({ requestId: pending.requestId, decision: 'deny' }));
  await waitFor(
    async () => (existsSync(path.join(env.runsDir, 'lock')) ? undefined : true),
    { timeoutMs: 20000 },
  );
});
