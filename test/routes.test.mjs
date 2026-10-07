// 三个 HTTP 路由（src/routes.ts）的测试：fake deps 收集 webServer.register 调用、假 admit、
// 假 watch（结构同 WatchProcess），断言只看外部行为——注册了什么、admit 拒没拒、响应写了什么、
// 订阅/退订与连接计数、repo 判定与缓存。真 git 仓用临时目录（git init + worktree），零额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync as realExecFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { createRepoResolver, registerRoutes } from '../src/routes.ts';

const STREAM = '/zcode-executor/stream';
const SNAPSHOT = '/zcode-executor/snapshot';
const REPO = '/zcode-executor/repo';

/** 假响应：记下头、状态码与写出的块；'close' 靠 emit 模拟客户端断开。 */
class FakeRes extends EventEmitter {
  headers = {};
  status = null;
  chunks = [];
  ended = false;
  setHeader(key, value) { this.headers[key.toLowerCase()] = value; }
  writeHead(status) { this.status = status; }
  write(chunk) { this.chunks.push(String(chunk)); return true; }
  end(chunk) { if (chunk !== undefined) this.chunks.push(String(chunk)); this.ended = true; }
  jsonLines() { return this.body().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  body() { return this.chunks.join(''); }
}

const fakeReq = (url) => ({ method: 'GET', url, headers: {} });

/** 假 watch：结构同 WatchProcess，能手动喂行与连接事件，记下订阅与计数。 */
function fakeWatch(snapshot = { link: 'live', message: null, synced: true, table: { a: { id: 'a', phase: 'running' } } }) {
  const listeners = new Set();
  const counts = { add: 0, remove: 0 };
  return {
    watch: {
      getSnapshot: () => snapshot,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      addStreamClient() { counts.add += 1; },
      removeStreamClient() { counts.remove += 1; },
    },
    emitLine: (line) => { for (const fn of listeners) fn({ kind: 'line', line }); },
    emitLink: (link, message = null) => { for (const fn of listeners) fn({ kind: 'link', link, message }); },
    listenerCount: () => listeners.size,
    counts,
  };
}

/** 收集 register 调用（照真 webServer.register 的形状），返回按路径取路由的探针。 */
function mounted({ admit, watch, ...over } = {}) {
  const registered = [];
  registerRoutes({
    register: (route) => { registered.push(route); return () => {}; },
    admit: admit ?? (() => ({ peer: null })),
    watch: watch ?? fakeWatch().watch,
    ...over,
  });
  return { registered, byPath: (p) => registered.find((r) => r.path === p) };
}

/** 临时真 git 仓 + 一个 worktree，返回两者的真实路径。 */
function gitRepo(t) {
  const main = mkdtempSync(path.join(tmpdir(), 'zexec-repo-'));
  const git = (...args) => realExecFileSync('git', ['-C', main, ...args], { stdio: ['ignore', 'ignore', 'ignore'] });
  git('init');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init');
  const wtParent = mkdtempSync(path.join(tmpdir(), 'zexec-wt-'));
  const wt = path.join(wtParent, 'wt');
  git('worktree', 'add', wt, '-b', 'wt');
  t.after(() => {
    rmSync(main, { recursive: true, force: true });
    rmSync(wtParent, { recursive: true, force: true });
  });
  return { main: realpathSync(main), wt: realpathSync(wt) };
}

test('注册三条 exact 路由：stream / snapshot / repo', () => {
  const { registered } = mounted();
  assert.deepEqual(registered.map((r) => r.path).sort(), [REPO, SNAPSHOT, STREAM].sort());
  for (const route of registered) assert.equal(route.kind, 'exact');
  for (const route of registered) assert.equal(typeof route.handler, 'function');
});

test('admit 拒绝：三条路由都原样回 401/403，stream 不计连接数', () => {
  for (const rejection of [401, 403]) {
    const fake = fakeWatch();
    const { byPath } = mounted({ admit: () => ({ rejection }) , watch: fake.watch });
    for (const pathName of [STREAM, SNAPSHOT, REPO]) {
      const res = new FakeRes();
      byPath(pathName).handler(fakeReq(pathName), res);
      assert.equal(res.status, rejection, pathName);
      const body = JSON.parse(res.body());
      assert.equal(body.ok, false);
      assert.equal(body.error.code, rejection === 401 ? 'unauthorized' : 'forbidden');
    }
    assert.deepEqual(fake.counts, { add: 0, remove: 0 }); // 被拒的请求不占连接计数
  }
});

test('method 校验：POST / HEAD 一律 405 + Allow: GET（admit 放行时也拦，zen-remote 同款墙）', () => {
  for (const method of ['POST', 'HEAD']) {
    const fake = fakeWatch();
    const { byPath } = mounted({ watch: fake.watch });
    for (const pathName of [STREAM, SNAPSHOT, REPO]) {
      const res = new FakeRes();
      byPath(pathName).handler({ method, url: pathName, headers: {} }, res);
      assert.equal(res.status, 405, `${method} ${pathName}`);
      assert.equal(res.headers.allow, 'GET', `${method} ${pathName}`);
      const body = JSON.parse(res.body());
      assert.equal(body.ok, false);
      assert.equal(body.error.code, 'method-not-allowed');
      assert.equal(body.error.message, 'Use GET');
    }
    assert.deepEqual(fake.counts, { add: 0, remove: 0 }); // method 墙挡下的请求不算流连接
  }
});

test('stream：连接即写当前连接态；已同步时补一轮 hello+表+synced 让新客户端直接拿到全量', () => {
  const fake = fakeWatch(); // 默认快照 synced:true、表里有 a
  const { byPath } = mounted({ watch: fake.watch });
  const res = new FakeRes();
  byPath(STREAM).handler(fakeReq(STREAM), res);
  const lines = res.jsonLines();
  assert.deepEqual(lines[0], { type: 'connection', link: 'live', message: null });
  assert.deepEqual(lines[1], { type: 'hello', repo: null });
  assert.deepEqual(lines[2], { type: 'session', session: { id: 'a', phase: 'running' } });
  assert.deepEqual(lines[3], { type: 'synced' });
  assert.equal(res.headers['content-type'], 'application/x-ndjson; charset=utf-8');
  assert.deepEqual(fake.counts, { add: 1, remove: 0 });
});

test('stream：未同步时不补基线，只报连接态', () => {
  const fake = fakeWatch({ link: 'starting', message: null, synced: false, table: {} });
  const { byPath } = mounted({ watch: fake.watch });
  const res = new FakeRes();
  byPath(STREAM).handler(fakeReq(STREAM), res);
  assert.deepEqual(res.jsonLines(), [{ type: 'connection', link: 'starting', message: null }]);
});

test('stream：订阅到的行原样转发，连接事件转成 connection 行', () => {
  const fake = fakeWatch();
  const { byPath } = mounted({ watch: fake.watch });
  const res = new FakeRes();
  byPath(STREAM).handler(fakeReq(STREAM), res);
  const before = res.chunks.length;
  fake.emitLine({ type: 'session', session: { id: 'a', phase: 'pending' } });
  fake.emitLink('down', '实时连接中断，5 秒后重连');
  const lines = res.jsonLines().slice(before);
  assert.deepEqual(lines[0], { type: 'session', session: { id: 'a', phase: 'pending' } });
  assert.deepEqual(lines[1], { type: 'connection', link: 'down', message: '实时连接中断，5 秒后重连' });
});

test('stream：响应关闭即退订并归还连接计数', () => {
  const fake = fakeWatch();
  const { byPath } = mounted({ watch: fake.watch });
  const res = new FakeRes();
  byPath(STREAM).handler(fakeReq(STREAM), res);
  assert.equal(fake.listenerCount(), 1);
  res.emit('close');
  assert.equal(fake.listenerCount(), 0);
  assert.deepEqual(fake.counts, { add: 1, remove: 1 });
  const before = res.chunks.length; // 初始 replay 的行不算：退订后喂的行不再写出
  fake.emitLine({ type: 'synced' });
  assert.equal(res.chunks.length, before);
});

test('snapshot：一次性全量（连接态 + 快照表），JSON 响应', () => {
  const snapshot = { link: 'down', message: '实时连接中断，5 秒后重连', synced: false, table: { a: { id: 'a' } } };
  const { byPath } = mounted({ watch: fakeWatch(snapshot).watch });
  const res = new FakeRes();
  byPath(SNAPSHOT).handler(fakeReq(SNAPSHOT), res);
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /^application\/json/);
  assert.deepEqual(JSON.parse(res.body()), snapshot);
});

test('repo：主仓与它的 worktree 都判回主仓根（git 共同数据目录规则）', (t) => {
  const { main, wt } = gitRepo(t);
  const { byPath } = mounted();
  const ask = (cwd) => {
    const res = new FakeRes();
    byPath(REPO).handler(fakeReq(`${REPO}?cwd=${encodeURIComponent(cwd)}`), res);
    return JSON.parse(res.body()).repo;
  };
  assert.equal(ask(main), main);
  assert.equal(ask(wt), main);
});

test('repo：非 git 目录、不存在的路径、非绝对路径、缺参都回 { repo: null }', (t) => {
  const plain = mkdtempSync(path.join(tmpdir(), 'zexec-plain-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  const { byPath } = mounted();
  const ask = (query) => {
    const res = new FakeRes();
    byPath(REPO).handler(fakeReq(`${REPO}${query}`), res);
    assert.equal(res.status, 200);
    return JSON.parse(res.body()).repo;
  };
  assert.equal(ask(`?cwd=${encodeURIComponent(plain)}`), null); // 目录在但不是 git 仓
  assert.equal(ask(`?cwd=${encodeURIComponent(path.join(plain, 'missing'))}`), null);
  assert.equal(ask('?cwd=relative/path'), null);
  assert.equal(ask(''), null);
});

test('repo：同一 cwd 只调一次 git（进程内缓存），git 失败不缓存', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zexec-cache-'));
  mkdirSync(path.join(dir, '.git')); // fake git 回 '.git'，真实路径换算后得存在才能 realpath
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let calls = 0;
  const execFileSync = () => {
    calls += 1;
    return '.git\n';
  };
  const resolver = createRepoResolver({ execFileSync });
  // common dir 叫 .git 时取它的上一级（仓库根），照 zcode-executor 的口径
  assert.equal(resolver.resolve(dir), realpathSync(dir));
  assert.equal(resolver.resolve(dir), realpathSync(dir));
  assert.equal(calls, 1);
  const failing = createRepoResolver({ execFileSync: () => { calls += 1; throw new Error('git 炸了'); } });
  assert.equal(failing.resolve(dir), null);
  assert.equal(failing.resolve(dir), null); // null 不缓存：git 一时出错不该永久记成无仓库
  assert.equal(calls, 3);
});
