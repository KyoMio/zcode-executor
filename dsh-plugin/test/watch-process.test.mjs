// watch 子进程管理（src/watch-process.ts）的测试。execPath 指向桩脚本 test/fixtures/stub-watch.mjs
//（行为由环境变量 STUB_PLAN / STUB_RUN_FILE / STUB_EXIT_FILE 驱动），断言只看外部行为：
// 行进没进快照表、连接态怎么迁移、进程起过几次/死没死（标记文件）、订阅收到的原样转发。
// 唯一例外是竞态回归用的 childPidForTest（只读探针）：陈旧 exit 清没清新进程，标记文件看不出来。
// 重试间隔走构造参数（毫秒级），测试不真等 5 秒。重起语义的出处：zcode-executor
// hooks/register.mjs keepWatching（synced 前死 = failed 不重试，synced 后死 = down 5 秒重起）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WatchProcess } from '../src/watch-process.ts';

const STUB = fileURLToPath(new URL('./fixtures/stub-watch.mjs', import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await sleep(5);
  }
  throw new Error(`waitFor 超时（${ms}ms）`);
}

/** 备好本轮的桩计划与标记文件，返回数「起过几次 / 死没死」的探针；测试结束清环境变量与目录。 */
function scenario(t, plan) {
  const dir = mkdtempSync(path.join(tmpdir(), 'zexec-watch-'));
  const planFile = path.join(dir, 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan));
  const runFile = path.join(dir, 'runs');
  const exitFile = path.join(dir, 'exits');
  process.env.STUB_PLAN = planFile;
  process.env.STUB_RUN_FILE = runFile;
  process.env.STUB_EXIT_FILE = exitFile;
  t.after(() => {
    delete process.env.STUB_PLAN;
    delete process.env.STUB_RUN_FILE;
    delete process.env.STUB_EXIT_FILE;
    rmSync(dir, { recursive: true, force: true });
  });
  const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length : 0);
  return { runs: () => lines(runFile), exited: () => lines(exitFile) > 0, exitLines: () => lines(exitFile) };
}

function makeWp(t, over = {}) {
  const wp = new WatchProcess({ execPath: STUB, cwd: homedir(), restartMs: 20, ...over });
  t.after(() => wp.dispose());
  return wp;
}

// 一轮「hello → session a → synced → 常驻」的最小计划
const stayUp = [
  { line: { type: 'hello', repo: null } },
  { line: { type: 'session', session: { id: 'a', phase: 'running' } } },
  { line: { type: 'synced' } },
  { delayMs: 10000 },
];

test('桩输出的行原样转发给订阅者、进快照表；synced 后 link=live', async (t) => {
  scenario(t, [
    { line: { type: 'hello', repo: '/repo/app' } },
    { line: { type: 'session', session: { id: 'a', phase: 'running' } } },
    { line: { type: 'session', session: { id: 'b', phase: 'idle' } } },
    { line: { type: 'synced' } },
    { delayMs: 10000 },
  ]);
  const wp = makeWp(t);
  assert.equal(wp.getSnapshot().link, 'starting'); // 没起进程时的初态
  const seen = [];
  wp.subscribe((ev) => seen.push(ev));
  wp.start();
  await waitFor(() => wp.getSnapshot().synced);
  const snap = wp.getSnapshot();
  assert.deepEqual(Object.keys(snap.table).sort(), ['a', 'b']);
  assert.equal(snap.link, 'live');
  const lines = seen.filter((ev) => ev.kind === 'line').map((ev) => ev.line);
  assert.deepEqual(lines[0], { type: 'hello', repo: '/repo/app' }); // 行是原文，没改形状
  assert.ok(lines.some((l) => l.type === 'session' && l.session.id === 'a'));
  assert.deepEqual(seen.filter((ev) => ev.kind === 'link').map((ev) => ev.link), ['starting', 'live']);
});

test('synced 后退出：down 带重连说明，短间隔后重起；重起到 synced 之间旧表保留、新行只作新基线', async (t) => {
  const s = scenario(t, {
    runs: [
      [
        { line: { type: 'hello', repo: null } },
        { line: { type: 'session', session: { id: 'a', phase: 'pending' } } },
        { line: { type: 'synced' } },
        { delayMs: 40 },
        { exitCode: 0 },
      ],
      [
        { line: { type: 'hello', repo: null } },
        { line: { type: 'session', session: { id: 'b', phase: 'running' } } },
        { delayMs: 120 },
        { line: { type: 'synced' } },
        { delayMs: 10000 },
      ],
    ],
  });
  const wp = makeWp(t);
  const links = [];
  wp.subscribe((ev) => { if (ev.kind === 'link') links.push(ev.link); });
  wp.start();
  await waitFor(() => wp.getSnapshot().synced);
  await waitFor(() => wp.getSnapshot().link === 'down');
  assert.match(wp.getSnapshot().message, /实时连接中断/);
  await waitFor(() => wp.getSnapshot().link === 'starting'); // 重起窗口：旧表保留、回到未同步
  assert.equal(wp.getSnapshot().synced, false);
  assert.deepEqual(Object.keys(wp.getSnapshot().table), ['a']);
  await waitFor(() => wp.getSnapshot().synced);
  assert.deepEqual(Object.keys(wp.getSnapshot().table), ['b']); // 新基线整体换上
  assert.equal(wp.getSnapshot().link, 'live');
  assert.ok(s.runs() >= 2);
  assert.ok(links.includes('down'));
});

test('synced 前退出：failed 带起不来的原因与 stderr 尾巴，不重试', async (t) => {
  const s = scenario(t, [{ line: { type: 'hello', repo: null } }, { stderr: '登记簿读不出来' }, { exitCode: 1 }]);
  const wp = makeWp(t);
  wp.start();
  await waitFor(() => wp.getSnapshot().link === 'failed');
  assert.match(wp.getSnapshot().message, /启动 watch 失败/);
  assert.match(wp.getSnapshot().message, /登记簿读不出来/);
  await sleep(80);
  assert.equal(s.runs(), 1); // failed 不重起
});

test('没有任何输出就退出也按 failed 报（原因落到退出码）', async (t) => {
  scenario(t, [{ exitCode: 1 }]);
  const wp = makeWp(t);
  wp.start();
  await waitFor(() => wp.getSnapshot().link === 'failed');
  assert.match(wp.getSnapshot().message, /启动 watch 失败：/);
  assert.match(wp.getSnapshot().message, /退出码 1/);
});

test('execPath 指向不存在的路径：failed、原因可读并提示 execPath 配置，不重试', async (t) => {
  const s = scenario(t, []); // 桩根本不会被起起来
  const wp = makeWp(t, { execPath: '/nonexistent/zcode-executor-xyz' });
  wp.start();
  await waitFor(() => wp.getSnapshot().link === 'failed');
  assert.match(wp.getSnapshot().message, /ENOENT/);
  assert.match(wp.getSnapshot().message, /execPath/);
  await sleep(80);
  assert.equal(s.runs(), 0);
});

test('dispose 杀掉子进程；之后的退出不按断开处理、不重起', async (t) => {
  const s = scenario(t, stayUp);
  const wp = makeWp(t, { restartMs: 20 });
  wp.start();
  await waitFor(() => wp.getSnapshot().synced);
  wp.dispose();
  await waitFor(() => s.exited());
  assert.equal(wp.getSnapshot().link, 'live'); // 主动关停不算断开（插件都在卸载了）
  await sleep(60);
  assert.equal(s.runs(), 1); // 没有重起
});

test('on-demand：没人订阅不起进程；首连起进程；计数归零杀进程且不重起；再连再起', async (t) => {
  const s = scenario(t, stayUp);
  const wp = makeWp(t, { mode: 'on-demand' });
  await sleep(60);
  assert.equal(s.runs(), 0); // 构造不自动起
  wp.addStreamClient();
  await waitFor(() => wp.getSnapshot().synced);
  assert.equal(s.runs(), 1);
  wp.removeStreamClient();
  await waitFor(() => s.exited());
  await sleep(60);
  assert.equal(s.runs(), 1); // 按需停掉不进重起循环
  wp.addStreamClient();
  await waitFor(() => s.runs() >= 2);
  await waitFor(() => wp.getSnapshot().synced);
  assert.equal(wp.getSnapshot().link, 'live');
  wp.removeStreamClient(); // 收尾：让 after 钩子的 dispose 干净
});

test('always：订阅计数的增减不影响进程生死', async (t) => {
  const s = scenario(t, stayUp);
  const wp = makeWp(t, { mode: 'always' });
  wp.start();
  await waitFor(() => wp.getSnapshot().synced);
  wp.addStreamClient();
  wp.removeStreamClient();
  await sleep(80);
  assert.equal(wp.getSnapshot().link, 'live');
  assert.ok(!s.exited());
  assert.equal(s.runs(), 1);
});

test('removed 行：进表删除并原样转发（服务端与客户端归约器是两份实现，各自都得有这条）', async (t) => {
  scenario(t, [
    { line: { type: 'hello', repo: null } },
    { line: { type: 'session', session: { id: 'a', phase: 'running' } } },
    { line: { type: 'session', session: { id: 'b', phase: 'idle' } } },
    { line: { type: 'synced' } },
    { line: { type: 'removed', id: 'a' } },
    { delayMs: 10000 },
  ]);
  const wp = makeWp(t);
  const seen = [];
  wp.subscribe((ev) => seen.push(ev));
  wp.start();
  await waitFor(() => wp.getSnapshot().link === 'live');
  await waitFor(() => !('a' in wp.getSnapshot().table));
  assert.deepEqual(Object.keys(wp.getSnapshot().table), ['b']); // 进表删除
  // applyLine 先改表再转发，表里 a 没了时同一行的事件必然已发出
  const removed = seen.filter((ev) => ev.kind === 'line').map((ev) => ev.line).find((l) => l.type === 'removed');
  assert.deepEqual(removed, { type: 'removed', id: 'a' }); // 原样转发，没改形状
});

test('removed 在未同步阶段：从基线删掉已见过的会话（synced 后表里无该 id），没见过的 id 是无害空操作', async (t) => {
  // 首轮清扫期间会话就结束的真机场景：watch 报了 session 又在 synced 前报 removed。
  // 未同步分支（删 baseline）此前无用例钉住，回归（比如误删成「加进表」）这里会炸。
  scenario(t, [
    { line: { type: 'hello', repo: null } },
    { line: { type: 'session', session: { id: 'a', phase: 'running' } } },
    { line: { type: 'removed', id: 'a' } }, // 已入基线的会话被删：synced 后表里无 a
    { line: { type: 'removed', id: 'zz' } }, // 没见过的 id：空操作，不出现也不炸
    { line: { type: 'session', session: { id: 'c', phase: 'idle' } } },
    { line: { type: 'synced' } },
    { delayMs: 10000 },
  ]);
  const wp = makeWp(t);
  wp.start();
  await waitFor(() => wp.getSnapshot().synced);
  assert.equal(wp.getSnapshot().link, 'live');
  const table = wp.getSnapshot().table;
  assert.ok(!('a' in table), 'removed 未同步删基线：a 不在表里');
  assert.ok(!('zz' in table), '没见过的 id 的 removed 是空操作');
  assert.deepEqual(Object.keys(table), ['c']); // 后续会话照常进基线、synced 换上
});

test('非 JSON 行：跳过、不进流，不影响后面的行', async (t) => {
  scenario(t, [
    { line: { type: 'hello', repo: null } },
    { raw: '这不是 JSON 的一行输出' },
    { line: { type: 'session', session: { id: 'a', phase: 'running' } } },
    { line: { type: 'synced' } },
    { delayMs: 10000 },
  ]);
  const wp = makeWp(t);
  const seen = [];
  wp.subscribe((ev) => seen.push(ev));
  wp.start();
  await waitFor(() => wp.getSnapshot().synced);
  const lines = seen.filter((ev) => ev.kind === 'line').map((ev) => ev.line);
  assert.deepEqual(lines.map((l) => l.type), ['hello', 'session', 'synced']); // 坏行没进流
  assert.deepEqual(Object.keys(wp.getSnapshot().table), ['a']); // 后面的行照常进表
  assert.equal(wp.getSnapshot().link, 'live');
});

test('一行中文按 UTF-8 字节半切、分两次到达：跨 chunk 边界多字节字符不坏', async (t) => {
  // 切点落在「中」字的三个字节中间：先到 1 个字节、再到剩下 2 个
  const splitAt = Buffer.byteLength('{"type":"session","session":{"id":"', 'utf8') + 1;
  scenario(t, [
    { line: { type: 'hello', repo: null } },
    { halfLine: { type: 'session', session: { id: '中文会话', phase: 'running' } }, splitAt },
    { line: { type: 'synced' } },
    { delayMs: 10000 },
  ]);
  const wp = makeWp(t);
  const seen = [];
  wp.subscribe((ev) => seen.push(ev));
  wp.start();
  await waitFor(() => wp.getSnapshot().synced);
  const sess = seen.filter((ev) => ev.kind === 'line').map((ev) => ev.line).find((l) => l.type === 'session');
  assert.equal(sess?.session?.id, '中文会话'); // 不是乱码
  assert.equal(wp.getSnapshot().table['中文会话']?.phase, 'running'); // 键也没坏，照常进表
  assert.ok(!JSON.stringify(seen).includes('\uFFFD')); // 整个流里没有替换字符 U+FFFD
});

test('on-demand：归零后同 tick 重连，旧进程迟到的 exit 不清掉新进程（无孤儿、无双 spawn、能杀干净）', async (t) => {
  const s = scenario(t, stayUp);
  const wp = makeWp(t, { mode: 'on-demand' });
  wp.addStreamClient();
  await waitFor(() => wp.getSnapshot().synced);
  const first = wp.childPidForTest;
  assert.ok(typeof first === 'number');
  // 竞态窗口：同一 tick 内断开又重连（中间不 await）。kill 信号已发出，但旧进程的 exit 事件
  // 要等事件循环下一轮才送达；start() 眼里 this.child 已被 stopForIdle 置空，照常 spawn 新进程。
  wp.removeStreamClient();
  wp.addStreamClient();
  const second = wp.childPidForTest;
  assert.ok(typeof second === 'number' && second !== first); // 新进程已经起来了
  await waitFor(() => s.exitLines() >= 1); // 旧进程真的退了（桩写标记文件先于父进程收到 exit 事件）
  await sleep(50); // 给旧 exit 事件的送达与处理留时间
  assert.equal(wp.childPidForTest, second); // 旧 exit 是陈旧事件：新进程还在（旧代码在这里被清成 null）
  wp.removeStreamClient(); // 收尾断开：这次 stopForIdle 必须杀到新进程
  await waitFor(() => s.exitLines() >= 2);
  await sleep(60);
  assert.equal(s.runs(), 2); // 全程只起过两轮：无双 spawn、孤儿没有再多起一轮
  assert.equal(wp.childPidForTest, null); // 杀干净了
  assert.equal(wp.getSnapshot().link, 'down'); // 按需停掉记 down，且没进重起循环
});
