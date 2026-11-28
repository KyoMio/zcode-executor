// control-executor 的守门与形状测试（ZCE-4）——不真跑 doctor/zero-token/flake（那些是验收证据的活），
// 只钉死几条红线行为：未知子命令指路、live-smoke 无 --confirm-spend 在 spawn 任何东西之前拒绝、
// dry-run 不花钱只出剧本、orphan-check 默认不动手、参数解析拒绝未知旗标。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'control-executor.mjs');

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000 });

test('未知子命令：退出码 1，stderr 列出可用子命令（指路式）', () => {
  const r = run(['no-such-command']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /doctor/);
  assert.match(r.stderr, /flake-swarm/);
});

test('live-smoke 不带 --confirm-spend：退出码 2 且绝不 spawn（输出指向下一步）', () => {
  const r = run(['live-smoke', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--confirm-spend/);
  assert.match(r.stderr, /zero-token/); // 指路：零额度替代
});

test('live-smoke --confirm-spend --dry-run：只出剧本不花钱，退出码 0', () => {
  const r = run(['live-smoke', '--confirm-spend', '--dry-run', '--json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.ok(Array.isArray(out.plan) && out.plan.length >= 3);
});

test('orphan-check 不带 --cleanup：只报告不清理（cleaned=false）', () => {
  const r = run(['orphan-check', '--json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.cleaned, false);
  assert.ok(Array.isArray(out.findings.processes));
});

test('orphan-check --cleanup --dry-run 并存：dry-run 赢（不动手）', () => {
  const r = run(['orphan-check', '--cleanup', '--dry-run', '--json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.cleaned, false);
});

test('未知旗标：退出码 2 且报出可用旗标清单', () => {
  const r = run(['doctor', '--bogus-flag']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--json/);
});

test('flake-swarm 参数形状：--runs/--concurrency 解析进结果', () => {
  // 不真跑测试套件——用 runs=0 验证参数解析与空报告形状
  const r = run(['flake-swarm', '--runs', '0', '--concurrency', '1', '--json']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.runs, 0);
  assert.equal(out.concurrency, 1);
});
