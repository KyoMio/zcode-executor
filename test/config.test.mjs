// lib/config.mjs 的行为测试：家目录解析、配置合并与校验、原子落盘。
// 全部用临时目录，不读真机 ~/.zcode-executor，不碰 zcode 的配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutorError } from '../lib/errors.mjs';
import { resolveHome, loadConfig, writeJsonAtomic } from '../lib/config.mjs';

const tmp = async (prefix) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

// after() 兜底：就算某个用例在 try 之前就炸了，临时目录也在这里清掉（T2.9 第 10 条）
const dirs = [];
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

test('resolveHome：默认 ~/.zcode-executor，ZCODE_EXECUTOR_HOME 覆盖且 ~ 展开、相对转绝对', () => {
  const saved = process.env.ZCODE_EXECUTOR_HOME;
  try {
    delete process.env.ZCODE_EXECUTOR_HOME;
    assert.equal(resolveHome(), path.join(os.homedir(), '.zcode-executor'));
    process.env.ZCODE_EXECUTOR_HOME = '~/xyz-executor-home';
    assert.equal(resolveHome(), path.join(os.homedir(), 'xyz-executor-home'));
    process.env.ZCODE_EXECUTOR_HOME = 'relative/dir';
    assert.equal(resolveHome(), path.resolve('relative/dir'));
  } finally {
    if (saved === undefined) delete process.env.ZCODE_EXECUTOR_HOME;
    else process.env.ZCODE_EXECUTOR_HOME = saved;
  }
});

test('loadConfig：没有配置文件时全默认', async () => {
  const home = await tmp('zcode-config-test-');
  try {
    const config = loadConfig(home);
    assert.equal(config.home, home);
    assert.deepEqual(config.allowedRoots, [path.join(home, 'worktrees')]);
    assert.equal(config.waitTimeoutSec, 1800);
    assert.equal(config.preferredProvider, undefined);
    assert.deepEqual(config.tiers, {});
    assert.deepEqual(config.environment, []);
    assert.deepEqual(config.sensitive, []);
    assert.deepEqual(config.warnings, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('loadConfig：tiers.fast/strong 非字符串抛 ExecutorError(1)（评审 T2.1b 第 6 条）', async () => {
  const home = await tmp('zcode-config-test-');
  try {
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ tiers: { fast: 123 } }));
    assert.throws(() => loadConfig(home), (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.equal(err.exitCode, 1);
      assert.match(err.message, /tiers\.fast/);
      return true;
    });
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ tiers: { strong: '' } }));
    assert.throws(() => loadConfig(home), (err) => err instanceof ExecutorError && err.exitCode === 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('loadConfig：顶层不认识的键收进 warnings，不抛错（评审 T2.1b 第 6 条）', async () => {
  const home = await tmp('zcode-config-test-');
  try {
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ tierss: { fast: 'X' }, waitTimeoutSec: 30 }));
    const config = loadConfig(home);
    assert.equal(config.waitTimeoutSec, 30); // 认识的键照常生效
    assert.equal(config.tierss, undefined);
    assert.deepEqual(config.warnings, [`配置里有不认识的键 tierss（已忽略），检查是否拼错：${path.join(home, 'config.json')}`]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('loadConfig：有文件时合并；allowedRoots 的 ~ 展开成绝对路径', async () => {
  const home = await tmp('zcode-config-test-');
  try {
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({
        allowedRoots: ['~/wt', '/abs/root'],
        waitTimeoutSec: 60,
        preferredProvider: 'my-plan',
        tiers: { fast: 'GLM-5.3' },
        environment: ['env note'], // 自由文字，不做 ~ 展开
        sensitive: ['~/secrets'],
      }),
    );
    const config = loadConfig(home);
    // path.resolve 后比：Windows 上 '/abs/root' 会补上当前盘符（D:\abs\root），POSIX 上原样
    assert.deepEqual(config.allowedRoots, [path.join(os.homedir(), 'wt'), path.resolve('/abs/root')]);
    assert.equal(config.waitTimeoutSec, 60);
    assert.equal(config.preferredProvider, 'my-plan');
    assert.deepEqual(config.tiers, { fast: 'GLM-5.3' });
    assert.deepEqual(config.environment, ['env note']);
    assert.deepEqual(config.sensitive, ['~/secrets']);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('loadConfig：坏 JSON 抛 ExecutorError(1) 且报出文件路径', async () => {
  const home = await tmp('zcode-config-test-');
  try {
    await writeFile(path.join(home, 'config.json'), '{not json');
    assert.throws(() => loadConfig(home), (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.equal(err.exitCode, 1);
      assert.ok(err.message.includes(path.join(home, 'config.json')));
      return true;
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('writeJsonAtomic：写出的文件可读回；目录不存在自动建；不残留临时文件', async () => {
  const dir = await tmp('zcode-config-test-');
  try {
    const nested = path.join(dir, 'a', 'b', 'sessions.json');
    writeJsonAtomic(nested, { hello: 'world', n: 1 });
    assert.deepEqual(JSON.parse(await readFile(nested, 'utf8')), { hello: 'world', n: 1 });
    const leftovers = (await readdir(path.dirname(nested))).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadConfig：review.slowMaxTokens 校验——正数收下、非法抛 ExecutorError(1)', async () => {
  const home = await tmp('zcode-config-test-');
  try {
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ review: { slowMaxTokens: 1500 } }));
    const config = loadConfig(home);
    assert.equal(config.review.slowMaxTokens, 1500); // T3.3：慢判预算可配

    await writeFile(path.join(home, 'config.json'), JSON.stringify({ review: { slowMaxTokens: 0 } }));
    assert.throws(() => loadConfig(home), ExecutorError);
    await writeFile(path.join(home, 'config.json'), JSON.stringify({ review: { slowMaxTokens: 'abc' } }));
    assert.throws(() => loadConfig(home), ExecutorError);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
