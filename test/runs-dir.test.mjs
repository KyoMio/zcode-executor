// test/runs-dir.test.mjs —— ensureRunsDir 收紧目录的用例（审计 D5 + 评审意见：收不紧不拦投递，但要说一声）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureRunsDir } from '../lib/runs.mjs';

const dirs = [];
test.after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test('ensureRunsDir：收紧成功时 runs/ 与会话目录都是 0700，不出警告', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcx-runsdir-'));
  dirs.push(home);
  const warnings = [];
  const dir = ensureRunsDir(home, 's1', { onWarn: (m) => warnings.push(m) });
  assert.equal(dir, path.join(home, 'runs', 's1'));
  if (process.platform !== 'win32') {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.dirname(dir))).mode & 0o777, 0o700);
  }
  assert.deepEqual(warnings, []);
});

test('ensureRunsDir：chmod 失败不抛、照常返回目录，但每个收不紧的目录记一行警告（不静默）', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zcx-runsdir-'));
  dirs.push(home);
  const warnings = [];
  const chmod = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
  const dir = ensureRunsDir(home, 's2', { onWarn: (m) => warnings.push(m), chmod });
  assert.equal(dir, path.join(home, 'runs', 's2'));
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((m) => m.includes('EPERM')), warnings.join(' | '));
  assert.ok(warnings.some((m) => m.endsWith(path.join(home, 'runs'))));
  assert.ok(warnings.some((m) => m.endsWith(dir)));
});
