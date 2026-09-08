// lib/registry.mjs 的行为测试：登记簿读写与查询。全部用临时 home，不读真机 ~/.zcode-executor。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutorError } from '../lib/errors.mjs';
import { loadRegistry, saveSession, getSession } from '../lib/registry.mjs';

const tmp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-registry-test-'));
  dirs.push(dir);
  return dir;
};

// after() 兜底：就算某个用例在 try 之前就炸了，临时目录也在这里清掉（T2.9 第 10 条）
const dirs = [];
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
const ENTRY = {
  id: 'x_test1ab',
  sessionId: 'sess_test-1',
  title: 't',
  cwd: '/tmp/wt',
  isWorktree: true,
  tier: 'fast',
  provider: 'builtin:bigmodel-coding-plan',
  modelId: 'GLM-5.3-Flash',
  thoughtLevel: 'high',
  toolDenylist: null,
  createdAt: '2026-09-08T00:00:00.000Z',
  lastOutcome: null,
};

test('loadRegistry：文件不存在返回空登记簿', async () => {
  const home = await tmp();
  try {
    assert.deepEqual(loadRegistry(home), { sessions: {} });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('saveSession：写入形状齐全可读回；两条 session 两条记录', async () => {
  const home = await tmp();
  try {
    saveSession(home, ENTRY);
    saveSession(home, { ...ENTRY, id: 'x_test2cd', title: '第二单' });
    const registry = JSON.parse(await readFile(path.join(home, 'sessions.json'), 'utf8'));
    assert.deepEqual(registry.sessions['x_test1ab'], ENTRY);
    assert.equal(registry.sessions['x_test2cd'].title, '第二单');
    assert.equal(Object.keys(registry.sessions).length, 2);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('saveSession：同 sessionId 覆盖旧条目', async () => {
  const home = await tmp();
  try {
    saveSession(home, ENTRY);
    saveSession(home, { ...ENTRY, title: '改过的标题' });
    const registry = JSON.parse(await readFile(path.join(home, 'sessions.json'), 'utf8'));
    assert.equal(registry.sessions['x_test1ab'].title, '改过的标题');
    assert.equal(Object.keys(registry.sessions).length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('getSession：存在的返回条目，不存在的抛 ExecutorError(2) 并提示用 list', async () => {
  const home = await tmp();
  try {
    saveSession(home, ENTRY);
    assert.deepEqual(getSession(home, 'x_test1ab'), ENTRY);
    assert.throws(() => getSession(home, 'sess_missing'), (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /list/);
      return true;
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('loadRegistry：坏 JSON 抛 ExecutorError(1) 且带文件路径', async () => {
  const home = await tmp();
  try {
    await writeFile(path.join(home, 'sessions.json'), '{not json');
    assert.throws(() => loadRegistry(home), (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.equal(err.exitCode, 1);
      assert.ok(err.message.includes(path.join(home, 'sessions.json')));
      return true;
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
