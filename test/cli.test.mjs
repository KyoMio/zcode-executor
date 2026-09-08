// bin/zcode-executor 的行为测试：doctor、models、new 三条子命令，全部对 test/mock-appserver.mjs 跑
// （ZCODE_BIN 指向 mock，ZCODE_EXECUTOR_HOME 指向临时目录，ZCODE_CONFIG_PATH 注入 zcode 配置），
// 不发 session/send，不花额度（new 只 create + close）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, readRecord, killAll } from './helpers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'zcode-executor');
const dirs = [];
const runnerPids = [];
const mockPids = [];
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// 模拟本机 zcode 配置：两个启用的 provider（同名模型并存）+ 一个禁用的；
// Flash 照真机带思考等级 variants（T2.2b 第 8 条）
const ZCODE_CONFIG = {
  provider: {
    'builtin:bigmodel': {
      kind: 'anthropic',
      options: { apiKey: 'sk-test-plain' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': { name: 'GLM 5.3 Flash', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
      },
    },
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      options: { apiKey: 'sk-test-plan' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': { name: 'GLM 5.3 Flash', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
      },
    },
    'disabled-plan': { kind: 'anthropic', enabled: false, options: {}, models: { M: {} } },
  },
};

// 写一份模拟本机的 zcode 配置，返回路径
async function writeZcodeConfig() {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-cli-zconfig-'));
  dirs.push(configDir);
  const configPath = path.join(configDir, 'config.json');
  await writeFile(configPath, JSON.stringify(ZCODE_CONFIG));
  return configPath;
}

// 起 mock、准备家目录与 zcode 配置，spawnSync 跑 CLI；version 经 startMock 注入（T2.1b 第 11 条），
// mock 环境变量整包用 ...mock.env
async function runCli(args, { version, configPath } = {}) {
  const mock = await startMock({ version });
  dirs.push(mock.dir);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-cli-home-'));
  dirs.push(home);
  const zcodeConfigPath = configPath ?? (await writeZcodeConfig());
  const env = {
    ...process.env,
    ZCODE_BIN: mock.zcodePath,
    ZCODE_EXECUTOR_HOME: home,
    ZCODE_CONFIG_PATH: zcodeConfigPath,
    ...mock.env,
  };
  const run = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env, timeout: 60_000 });
  return { run, zcodeConfigPath, recordPath: mock.env.MOCK_APPSERVER_RECORD };
}

// ---------- new（T2.2）----------

// 准备 new 的环境：家目录（config.json 里 allowedRoots 含 workParent）+ 白名单内的 git 仓库 +
// 注入的 zcode 配置（不碰真机 ~/.zcode）。worktree:true 时用 git worktree add 造一个真 worktree；
// script 透传给 mock 剧本
async function setupNew({ worktree = false, script } = {}) {
  const mock = await startMock({ script });
  dirs.push(mock.dir);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-new-home-'));
  dirs.push(home);
  const workParent = await mkdtemp(path.join(os.tmpdir(), 'zcode-new-work-'));
  dirs.push(workParent);
  const repo = path.join(workParent, 'repo');
  execFileSync('git', ['init', '--quiet', repo]);
  const git = (args, cwd = repo) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
  git(['commit', '--allow-empty', '--quiet', '-m', 'init']);
  let cwd = repo;
  if (worktree) {
    cwd = path.join(workParent, 'wt');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '--quiet', cwd]);
  }
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedRoots: [workParent] }));
  const zcodeConfigPath = await writeZcodeConfig();
  return { mock, home, workParent, cwd, zcodeConfigPath, recordPath: mock.env.MOCK_APPSERVER_RECORD };
}

function runNew({ mock, home, zcodeConfigPath }, args) {
  const env = {
    ...process.env,
    ZCODE_BIN: mock.zcodePath,
    ZCODE_EXECUTOR_HOME: home,
    ZCODE_CONFIG_PATH: zcodeConfigPath,
    ...mock.env,
  };
  return spawnSync(process.execPath, [BIN, 'new', ...args], { encoding: 'utf8', env, timeout: 60_000 });
}

test('new：白名单外退出码 2，stderr 列出允许的根目录', async () => {
  const env = await setupNew();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'zcode-outside-')); // 真实存在但不在白名单里
  dirs.push(outside);
  const run = runNew(env, ['--cwd', outside]);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /不在白名单/);
  assert.match(run.stderr, /允许的根目录/);
  assert.ok(run.stderr.includes(env.workParent));
  // 不存在的 cwd 是退出码 1（T2.2b 第 1 条：先查存在再查白名单）
  const missing = runNew(env, ['--cwd', '/nonexistent/xyz']);
  assert.equal(missing.status, 1, missing.stderr);
  assert.match(missing.stderr, /cwd 不存在/);
});

test('new：白名单内通过，本地 id、sessionId 为 null、--json 与登记簿一致（D13）', async (t) => {
  const env = await setupNew();
  t.after(() => {
    killAll(runnerPids);
    killAll(mockPids);
  });
  const run = runNew(env, ['--cwd', env.cwd, '--title', 't', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const entry = JSON.parse(run.stdout);
  assert.match(entry.id, /^x_[0-9a-f]{8}$/); // 本地派单 id（D13）
  assert.equal(entry.sessionId, null); // new 不建 zcode 会话
  assert.equal(entry.cwd, realpathSync(env.cwd)); // 登记簿存 realpath 后的路径（T2.2b 第 1 条）
  assert.equal(entry.title, 't');
  assert.equal(entry.provider, 'builtin:bigmodel-coding-plan'); // D6：无 preferred 时选 coding-plan
  // mock 的 model.current 是第一个 provider 的 GLM-5.3，不属于选中的 provider → 按规则落到 fast
  assert.equal(entry.modelId, 'GLM-5.3-Flash');
  assert.equal(entry.tier, 'fast');
  assert.equal(entry.thoughtLevel, 'high'); // Flash 照真机带 low/high/max，登记给 runner 用（T2.2b 第 8 条）
  assert.equal(entry.lastOutcome, null);
  assert.deepEqual(entry.toolDenylist, null);
  // mock 记录里没有 session/create：new 不再建会话（D13 用例）
  assert.equal(readRecord(env.recordPath).some((m) => m.method === 'session/create'), false);
  // 与登记簿一致（键是本地 id）
  const registry = JSON.parse(await readFile(path.join(env.home, 'sessions.json'), 'utf8'));
  assert.deepEqual(registry.sessions[entry.id], entry);
});

test('new：非 worktree 只警告不拒；worktree 时 isWorktree:true', async () => {
  const plain = await setupNew();
  const run = runNew(plain, ['--cwd', plain.cwd, '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /new: cwd 不是 worktree，照常建/);
  assert.equal(JSON.parse(run.stdout).isWorktree, false);

  const wt = await setupNew({ worktree: true });
  const runWt = runNew(wt, ['--cwd', wt.cwd, '--json']);
  assert.equal(runWt.status, 0, `stderr: ${runWt.stderr}`);
  assert.doesNotMatch(runWt.stderr, /不是 worktree/);
  assert.equal(JSON.parse(runWt.stdout).isWorktree, true);
});

test('new：--tier fast 选 flash，--tier strong 选非 flash', async () => {
  const env = await setupNew();
  const fast = runNew(env, ['--cwd', env.cwd, '--tier', 'fast', '--json']);
  assert.equal(fast.status, 0, `stderr: ${fast.stderr}`);
  assert.equal(JSON.parse(fast.stdout).modelId, 'GLM-5.3-Flash');
  const strong = runNew(env, ['--cwd', env.cwd, '--tier', 'strong', '--json']);
  assert.equal(strong.status, 0, `stderr: ${strong.stderr}`);
  assert.equal(JSON.parse(strong.stdout).modelId, 'GLM-5.3');
});

test('new：不给 tier 且 current 属于该 provider → 用 current（剧本 models 覆盖）', async () => {
  const env = await setupNew({
    script: {
      models: [
        {
          ref: { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-5.3' },
          label: 'GLM 5.3',
          reasoning: { enabled: true, levels: [{ value: 'low' }, { value: 'high' }, { value: 'max' }], defaultLevel: 'max' },
        },
      ],
    },
  });
  const run = runNew(env, ['--cwd', env.cwd, '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const entry = JSON.parse(run.stdout);
  assert.equal(entry.modelId, 'GLM-5.3'); // current 属于该 provider，直接用它
  assert.equal(entry.tier, 'strong');
});

test('new：--thought 显式不合法 → 退 2 并列出档位；合法则登记给 runner（D13）', async () => {
  const env = await setupNew();
  const ok = runNew(env, ['--cwd', env.cwd, '--tier', 'strong', '--thought', 'max', '--json']);
  assert.equal(ok.status, 0, `stderr: ${ok.stderr}`);
  assert.equal(JSON.parse(ok.stdout).thoughtLevel, 'max'); // 登记簿记录，create 由 runner 发起

  const bad = runNew(env, ['--cwd', env.cwd, '--tier', 'strong', '--thought', 'nope']);
  assert.equal(bad.status, 2, `stderr: ${bad.stderr}`);
  assert.match(bad.stderr, /nope/);
  assert.match(bad.stderr, /low、high、max/); // 列出合法档位
});

test('new：模型没有 high 时登记 thoughtLevel 为 null，runner 不传该键（剧本 models 覆盖）', async () => {
  const env = await setupNew({
    script: {
      models: [
        {
          ref: { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-5.3' },
          label: 'GLM 5.3',
          reasoning: { enabled: true, levels: [{ value: 'low' }] },
        },
      ],
    },
  });
  const run = runNew(env, ['--cwd', env.cwd, '--tier', 'strong', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.equal(JSON.parse(run.stdout).thoughtLevel, null); // 档位里没有 high：登记为 null
});

test('new：--deny 空格分隔成数组登记（create 由 runner 带下去，见 run.test D13 用例）', async () => {
  const env = await setupNew();
  const run = runNew(env, ['--cwd', env.cwd, '--deny', 'WebSearch Bash', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.deepEqual(JSON.parse(run.stdout).toolDenylist, ['WebSearch', 'Bash']);
});

test('new：不建 zcode 会话（D13）——只有 resolveModels 的推表与 readState，无 create/send', async (t) => {
  const env = await setupNew();
  t.after(() => {
    killAll(runnerPids);
    killAll(mockPids);
  });
  const run = runNew(env, ['--cwd', env.cwd, '--tier', 'fast', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const methods = readRecord(env.recordPath).map((m) => m.method).filter(Boolean);
  assert.deepEqual([...new Set(methods)].sort(), ['workspace/readState', 'workspace/updateProviderRegistry']);
  assert.equal(methods.includes('session/create'), false); // D13：new 不建会话
  assert.equal(methods.includes('session/send'), false); // 零 token：绝不 send
});

test('new：两次 new 登记簿两条', async () => {
  const env = await setupNew();
  const a = runNew(env, ['--cwd', env.cwd, '--title', '第一单', '--json']);
  const b = runNew(env, ['--cwd', env.cwd, '--title', '第二单', '--json']);
  assert.equal(a.status, 0, `stderr: ${a.stderr}`);
  assert.equal(b.status, 0, `stderr: ${b.stderr}`);
  const registry = JSON.parse(await readFile(path.join(env.home, 'sessions.json'), 'utf8'));
  assert.equal(Object.keys(registry.sessions).length, 2);
  assert.deepEqual(
    Object.values(registry.sessions).map((s) => s.title).sort(),
    ['第一单', '第二单'],
  );
});

test('new：--provider 不存在退出码 2（显式指定不静默回落）', async () => {
  const env = await setupNew();
  const run = runNew(env, ['--cwd', env.cwd, '--provider', 'no-such-plan']);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /no-such-plan/);
});

test('new：人读输出一行本地 id 开头（D13）', async () => {
  const env = await setupNew();
  const run = runNew(env, ['--cwd', env.cwd, '--title', 't']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.match(run.stdout.trim(), /^new: x_[0-9a-f]{8} \S+\/\S+ 思考 \S+ \S/);
});

test('doctor：mock 版本低于门槛 → 退出码 1，stderr 说明', async () => {
  const { run } = await runCli(['doctor'], { version: '0.9.9' });
  assert.equal(run.status, 1, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /0\.9\.9/);
  assert.match(run.stderr, /0\.14\.8/);
});

test('doctor：正常 → 退出码 0，--json 里有 provider 与 tiers', async () => {
  const { run, zcodeConfigPath } = await runCli(['doctor', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.zcode.ok, true);
  assert.equal(out.zcode.version, '0.16.5');
  assert.equal(out.config.ok, true);
  assert.equal(out.config.providerCount, 2); // 禁用的 provider 被过滤
  assert.equal(out.config.path, zcodeConfigPath);
  assert.equal(out.handshake.ok, true);
  assert.equal(out.handshake.providerId, 'builtin:bigmodel-coding-plan'); // D6 优先级选中 coding-plan
  assert.deepEqual(out.handshake.tiers.fast, {
    providerId: 'builtin:bigmodel-coding-plan',
    modelId: 'GLM-5.3-Flash',
    label: 'GLM 5.3 Flash',
  });
  assert.equal(out.handshake.tiers.strong.modelId, 'GLM-5.3');
  assert.deepEqual(out.handshake.warnings, []);
});

test('doctor：人读输出三步各一行', async () => {
  const { run } = await runCli(['doctor']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const lines = run.stdout.split('\n').filter((l) => l.trim());
  assert.deepEqual(
    lines.map((l) => l.slice(0, 9)),
    ['doctor ① ', 'doctor ② ', 'doctor ③ '],
  );
  assert.match(lines[2], /builtin:bigmodel-coding-plan/);
});

test('doctor：zcode config 读不到 → 退出码 1，stderr 报路径，第三步跳过', async () => {
  const missing = path.join(os.tmpdir(), `zcode-nonexistent-${Date.now()}.json`);
  const { run } = await runCli(['doctor', '--json'], { configPath: missing });
  assert.equal(run.status, 1, `stderr: ${run.stderr}`);
  const out = JSON.parse(run.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.config.ok, false);
  assert.equal(out.handshake.skipped, true);
  assert.match(run.stderr, /nonexistent/);
});

test('models：--json 含每个模型的 tier，coding-plan 的 provider 标 selected', async () => {
  const { run } = await runCli(['models', '--json']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  const out = JSON.parse(run.stdout);
  assert.equal(out.selectedProvider, 'builtin:bigmodel-coding-plan');
  assert.equal(out.providers.length, 2);
  const plan = out.providers.find((p) => p.providerId === 'builtin:bigmodel-coding-plan');
  const big = out.providers.find((p) => p.providerId === 'builtin:bigmodel');
  assert.equal(plan.selected, true);
  assert.equal(big.selected, false);
  const strong = plan.models.find((m) => m.modelId === 'GLM-5.3');
  assert.deepEqual(strong.tier, 'strong');
  assert.deepEqual(strong.thoughtLevels, ['low', 'high', 'max']);
  const flash = plan.models.find((m) => m.modelId === 'GLM-5.3-Flash');
  assert.deepEqual(flash.tier, 'fast');
  assert.deepEqual(flash.thoughtLevels, ['low', 'high', 'max']); // Flash 照真机带思考等级（T2.2b 第 8 条）
  assert.equal(strong.disabledReason, null);
});

test('models：人读输出分组列出，选中的 provider 带 ✓，模型带 ★ 标记', async () => {
  const { run } = await runCli(['models']);
  assert.equal(run.status, 0, `stderr: ${run.stderr}`);
  assert.match(run.stdout, /builtin:bigmodel-coding-plan ✓/);
  assert.match(run.stdout, /builtin:bigmodel\n/);
  assert.match(run.stdout, /★fast\s+GLM-5\.3-Flash/);
  assert.match(run.stdout, /★strong\s+GLM-5\.3\s+GLM 5\.3\s+思考等级: low\/high\/max/);
});

test('doctor 与 models 零 token：mock 只收到推表与 readState（评审 T2.1b 第 5 条）', async () => {
  const a = await runCli(['doctor', '--json']);
  assert.equal(a.run.status, 0, `stderr: ${a.run.stderr}`);
  const b = await runCli(['models', '--json']);
  assert.equal(b.run.status, 0, `stderr: ${b.run.stderr}`);
  for (const { recordPath } of [a, b]) {
    const methods = [...new Set(readRecord(recordPath).map((m) => m.method).filter(Boolean))].sort();
    assert.deepEqual(methods, ['workspace/readState', 'workspace/updateProviderRegistry']);
    const all = readRecord(recordPath).map((m) => m.method);
    assert.equal(all.includes('session/create'), false);
    assert.equal(all.includes('session/send'), false);
  }
});

test('未知子命令：退出码 1 并列出可用命令', () => {
  const run = spawnSync(process.execPath, [BIN, 'bogus'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /不认识的命令 bogus/);
  assert.match(run.stderr, /doctor、models/);
});

// ---------- T2.2b：白名单 realpath、并发登记簿、参数校验 ----------

test('new：兄弟目录不误伤——<parent>/x 在白名单，<parent>/x-evil 退出码 2', async () => {
  const mock = await startMock({});
  dirs.push(mock.dir);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-t22b-home-'));
  dirs.push(home);
  const parent = await mkdtemp(path.join(os.tmpdir(), 'zcode-t22b-parent-'));
  dirs.push(parent);
  for (const name of ['x', 'x-evil']) {
    const repo = path.join(parent, name);
    execFileSync('git', ['init', '--quiet', repo]);
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'i'], { cwd: repo });
  }
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedRoots: [path.join(parent, 'x')] }));
  const env = { ...process.env, ZCODE_BIN: mock.zcodePath, ZCODE_EXECUTOR_HOME: home, ZCODE_CONFIG_PATH: await writeZcodeConfig(), ...mock.env };
  const good = spawnSync(process.execPath, [BIN, 'new', '--cwd', path.join(parent, 'x'), '--json'], { encoding: 'utf8', env, timeout: 60_000 });
  assert.equal(good.status, 0, good.stderr); // <parent>/x 本身放行
  const evil = spawnSync(process.execPath, [BIN, 'new', '--cwd', path.join(parent, 'x-evil'), '--json'], { encoding: 'utf8', env, timeout: 60_000 });
  assert.equal(evil.status, 2, evil.stderr); // 前缀相同但没有分隔符边界：拒
  assert.match(evil.stderr, /不在白名单/);
});

test('new：白名单内的符号链接解析到外部 → 退出码 2（评审 T2.2b 第 2 条）', async () => {
  const mock = await startMock({});
  dirs.push(mock.dir);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-t22b-home-'));
  dirs.push(home);
  const workParent = await mkdtemp(path.join(os.tmpdir(), 'zcode-t22b-work-'));
  dirs.push(workParent);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'zcode-t22b-outside-'));
  dirs.push(outside);
  execFileSync('git', ['init', '--quiet', path.join(outside, 'repo')]);
  const link = path.join(workParent, 'link');
  await symlink(outside, link); // 白名单里放一个指向外部仓库的符号链接
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedRoots: [workParent] }));
  const env = { ...process.env, ZCODE_BIN: mock.zcodePath, ZCODE_EXECUTOR_HOME: home, ZCODE_CONFIG_PATH: await writeZcodeConfig(), ...mock.env };
  const run = spawnSync(process.execPath, [BIN, 'new', '--cwd', path.join(link, 'repo')], { encoding: 'utf8', env, timeout: 60_000 });
  assert.equal(run.status, 2, run.stderr); // realpath 之后指向外部：拒
  assert.match(run.stderr, /不在白名单/);
});

test('new：/tmp 与 /private/tmp 两种写法都通（realpath 归一，评审 T2.2b 第 1 条）', { skip: process.platform === 'win32' && '验的是 /tmp 这类符号链接的归一，Windows 没有 /tmp' }, async () => {
  const mock = await startMock({});
  dirs.push(mock.dir);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-t22b-home-'));
  dirs.push(home);
  // /tmp 在 macOS 上是 /private/tmp 的符号链接：白名单用符号链接写法，cwd 用解析后写法
  const workDir = await mkdtemp('/tmp/zcode-t22b-XXXX');
  dirs.push(workDir);
  for (const name of ['repo', 'repo2']) {
    execFileSync('git', ['init', '--quiet', path.join(workDir, name)]);
  }
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedRoots: [workDir] })); // /tmp/... 形式
  const env = { ...process.env, ZCODE_BIN: mock.zcodePath, ZCODE_EXECUTOR_HOME: home, ZCODE_CONFIG_PATH: await writeZcodeConfig(), ...mock.env };
  const viaReal = spawnSync(
    process.execPath,
    [BIN, 'new', '--cwd', realpathSync(path.join(workDir, 'repo'))], // /private/tmp/... 形式
    { encoding: 'utf8', env, timeout: 60_000 },
  );
  assert.equal(viaReal.status, 0, viaReal.stderr);
  const viaSym = spawnSync(process.execPath, [BIN, 'new', '--cwd', path.join(workDir, 'repo2')], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  assert.equal(viaSym.status, 0, viaSym.stderr); // 反过来 /tmp 形式的 cwd 也要通
});

test('new：--tier 非法 → 退出码 2（PRD 表，评审 T2.2b 第 7 条）', async () => {
  const env = await setupNew();
  const run = runNew(env, ['--cwd', env.cwd, '--tier', 'turbo']);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /只能是 fast 或 strong/);
});

test('new：--provider 给错 → 退出码 2 且不起任何子进程（评审 T2.2b 第 6 条）', async () => {
  const env = await setupNew();
  const run = runNew(env, ['--cwd', env.cwd, '--provider', 'no-such-plan']);
  assert.equal(run.status, 2, `stderr: ${run.stderr}`);
  assert.match(run.stderr, /no-such-plan/);
  assert.deepEqual(readRecord(env.mock.env.MOCK_APPSERVER_RECORD), []); // mock 没被起过
});

test('new：四个并发 new → 登记簿四条都在（评审 T2.2b 第 3 条）', async () => {
  const mock = await startMock({});
  dirs.push(mock.dir);
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcode-t22b-home-'));
  dirs.push(home);
  const workParent = await mkdtemp(path.join(os.tmpdir(), 'zcode-t22b-work-'));
  dirs.push(workParent);
  const repos = [];
  for (const name of ['a', 'b', 'c', 'd']) {
    const repo = path.join(workParent, name);
    execFileSync('git', ['init', '--quiet', repo]);
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '--quiet', '-m', 'i'], { cwd: repo });
    repos.push(repo);
  }
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedRoots: [workParent] }));
  const env = { ...process.env, ZCODE_BIN: mock.zcodePath, ZCODE_EXECUTOR_HOME: home, ZCODE_CONFIG_PATH: await writeZcodeConfig(), ...mock.env };
  const children = repos.map((repo, i) =>
    spawn(process.execPath, [BIN, 'new', '--cwd', repo, '--title', `并发${i}`, '--json'], { env }).on('close', () => {}),
  );
  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve) => {
          child.on('close', resolve);
        }),
    ),
  );
  const registry = JSON.parse(await readFile(path.join(home, 'sessions.json'), 'utf8'));
  const entries = Object.values(registry.sessions);
  assert.equal(entries.length, 4); // 一条都不少
  assert.deepEqual(
    entries.map((e) => e.title).sort(),
    ['并发0', '并发1', '并发2', '并发3'],
  );
});

// ---------- T2.6 ----------

test('普通 Error（非 ExecutorError）→ 退 1、一行 stderr；ZCODE_EXECUTOR_DEBUG=1 才打堆栈（T2.6 第 2 条）', async () => {
  const plain = spawnSync(process.execPath, [BIN, 'doctor'], {
    encoding: 'utf8',
    env: { ...process.env, ZCODE_EXECUTOR_TEST_THROW: '故意的普通错误' },
    timeout: 60_000,
  });
  assert.equal(plain.status, 1, `stdout: ${plain.stdout} stderr: ${plain.stderr}`);
  assert.match(plain.stderr, /^doctor: 故意的普通错误\n$/m); // 一行 message，没有堆栈
  assert.doesNotMatch(plain.stderr, / at /);

  const debug = spawnSync(process.execPath, [BIN, 'doctor'], {
    encoding: 'utf8',
    env: { ...process.env, ZCODE_EXECUTOR_TEST_THROW: '故意的普通错误', ZCODE_EXECUTOR_DEBUG: '1' },
    timeout: 60_000,
  });
  assert.equal(debug.status, 1);
  assert.match(debug.stderr, / at /); // 排障时才给堆栈
});
