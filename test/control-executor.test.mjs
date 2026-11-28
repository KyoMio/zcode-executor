// control-executor 的守门与形状测试（ZCE-4）——不真跑 doctor/zero-token/flake（那些是验收证据的活），
// 只钉死几条红线行为：未知子命令指路、live-smoke 无 --confirm-spend 在 spawn 任何东西之前拒绝、
// dry-run 不花钱只出剧本、orphan-check 默认不动手、参数解析拒绝未知旗标。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'scripts', 'control-executor.mjs');

const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], {
  encoding: 'utf8',
  timeout: 60_000,
  ...(env ? { env } : {}),
});

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

test('flake-swarm 参数校验：非正整数拒绝（退出码 2），多余位置参数拒绝', () => {
  const bad = run(['flake-swarm', '--runs', '0', '--json']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /正整数/);
  const nan = run(['flake-swarm', '--runs', 'abc', '--json']);
  assert.equal(nan.status, 2);
});

test('live-smoke 多余位置参数拒绝（`--confirm-spend false` 的 false 不许静默吞掉）', () => {
  const r = run(['live-smoke', '--confirm-spend', 'false', '--json']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /位置参数/);
});

test('全部子命令拒绝位置参数、--timeout 非法值拒绝、concurrency 超上限拒绝', () => {
  for (const args of [
    ['orphan-check', '--cleanup', 'false', '--dry-run'],
    ['doctor', 'extra', '--json'],
    ['zero-token', 'extra', '--json'],
    ['mock-matrix', 'extra', '--json'],
    ['flake-swarm', 'extra', '--json'],
  ]) {
    const r = run(args);
    assert.equal(r.status, 2, `${args.join(' ')} 应退 2，实际 ${r.status}`);
    assert.match(r.stderr, /位置参数/);
  }
  for (const badTimeout of ['abc', '0', '-5', '1.5']) {
    const r = run(['live-smoke', '--confirm-spend', '--timeout', badTimeout, '--dry-run']);
    assert.equal(r.status, 2, `--timeout ${badTimeout} 应退 2，实际 ${r.status}`);
    assert.match(r.stderr, /--timeout/);
  }
  const okDry = run(['live-smoke', '--confirm-spend', '--dry-run', '--json']);
  assert.equal(okDry.status, 0);
  const badConc = run(['flake-swarm', '--concurrency', '99', '--json']);
  assert.equal(badConc.status, 2);
  assert.match(badConc.stderr, /concurrency|1\.\.32/);
});

test('orphan-check 隔离 TMPDIR 行为：>10m 判 orphan 并仅 --cleanup 删除、<10m 判 owned、符号链接跳过且不删目标', { skip: process.platform === 'win32' && '夹具使用 POSIX ps 桩脚本与目录符号链接' }, (t) => {
  const isoRoot = mkdtempSync(path.join(os.tmpdir(), 'zcx-orphan-test-'));
  t.after(() => rmSync(isoRoot, { recursive: true, force: true }));
  const tmpDir = path.join(isoRoot, 'tmp');
  const homeDir = path.join(isoRoot, 'home');
  const targetDir = path.join(isoRoot, 'outside-target');
  const fakeBin = path.join(isoRoot, 'bin');
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(path.join(targetDir, 'keep.txt'), 'must-survive');
  // 隔离系统并发测试/宿主进程干扰，同时验证裸 zcode-executor 仓库路径不会误触发活密钥进程判定
  const fakePs = path.join(fakeBin, 'ps');
  writeFileSync(fakePs, '#!/bin/sh\necho "  99999     1 node /Volumes/MacData/projects/zcode-executor/scripts/check-types.mjs"\n');
  chmodSync(fakePs, 0o755);

  const staleDir = path.join(tmpDir, 'zcode-executor-provider-stale');
  const freshDir = path.join(tmpDir, 'zcode-executor-provider-fresh');
  const linkPath = path.join(tmpDir, 'zcode-executor-provider-link');
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(path.join(staleDir, 'provider.json'), '{}');
  mkdirSync(freshDir, { recursive: true });
  writeFileSync(path.join(freshDir, 'provider.json'), '{}');
  symlinkSync(targetDir, linkPath, 'dir');

  // 把 staleDir 的 mtime 回拨 15 分钟（>10m）
  const staleAt = new Date(Date.now() - 15 * 60_000);
  utimesSync(staleDir, staleAt, staleAt);

  const env = { ...process.env, TMPDIR: tmpDir, ZCODE_EXECUTOR_HOME: homeDir, PATH: `${fakeBin}:${process.env.PATH}` };

  // ① --cleanup --dry-run：stale 判 orphan，fresh 判 owned，link 跳过，全部保留
  const dry = run(['orphan-check', '--cleanup', '--dry-run', '--json'], env);
  assert.equal(dry.status, 0, dry.stderr);
  const dryOut = JSON.parse(dry.stdout);
  assert.equal(dryOut.cleaned, false);
  const staleFinding = dryOut.findings.tempDirs.find((d) => d.path === staleDir);
  const freshFinding = dryOut.findings.tempDirs.find((d) => d.path === freshDir);
  const linkFinding = dryOut.findings.tempDirs.find((d) => d.path === linkPath);
  assert.equal(staleFinding?.ownership, 'orphan');
  assert.equal(freshFinding?.ownership, 'owned');
  assert.equal(linkFinding, undefined);
  assert.equal(existsSync(staleDir), true);
  assert.equal(existsSync(freshDir), true);
  assert.equal(existsSync(path.join(targetDir, 'keep.txt')), true);

  // ② --cleanup：删除 staleDir，保留 freshDir 与 symlink 目标
  const clean = run(['orphan-check', '--cleanup', '--json'], env);
  assert.equal(clean.status, 0, clean.stderr);
  const cleanOut = JSON.parse(clean.stdout);
  assert.equal(cleanOut.cleaned, true);
  assert.equal(existsSync(staleDir), false);
  assert.equal(existsSync(freshDir), true);
  assert.equal(existsSync(path.join(targetDir, 'keep.txt')), true);
});
