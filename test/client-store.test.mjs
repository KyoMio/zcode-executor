// src/client/store.ts 的测试：node:http 桩服务器（stream 端点可吐行 / 可中途断开 / 可拒连，
// snapshot 端点吐固定 JSON），计时全部注入小值（pollMs=20 / retryMs=30）。
// 断言只看外部行为——喂行 / 断流 → store 状态出；不碰真 DSH、不建会话、不花 token。
// routes.ts 一并 import 只为路由常量防漂移断言（node 测试环境引 node:* 没问题，客户端不引）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSnapshotStore, STREAM_PATH, SNAPSHOT_PATH, REPO_PATH, unbridgedMessageOf } from '../src/client/store.ts';
import { STREAM_ROUTE, SNAPSHOT_ROUTE, REPO_ROUTE } from '../src/routes.ts';

const POLL_MS = 20;
const RETRY_MS = 30;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, label, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${label}`);
    await sleep(4);
  }
}

/** 一条 stream 连接的句柄：send 吐一行 NDJSON，cut 中途掐断（res.destroy）。 */

/**
 * 桩服务器。onStream(ctx, url) 每条 stream 连接调一次（ctx 存进 ctxs 供测试后续推行，
 * 连接关闭时移除；url 是完整请求 URL，PB-6 的 sessionId 参数断言用）；snapshot() 每次
 * 轮询请求现算 { status, headers?, body }。返回 baseUrl、命中计数 hits（stream/snapshot）、
 * 存活连接 ctxs、两类请求的 URL 账目 urls 与 close()。
 */
async function startStub({ onStream, snapshot }) {
  const hits = { stream: 0, snapshot: 0 };
  const urls = { stream: [], snapshot: [] };
  const ctxs = [];
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://stub');
    if (pathname === '/zcode-executor/stream') {
      hits.stream += 1;
      urls.stream.push(req.url);
      // 200 头 lazy 到第一行数据才写：rejectUnbridged 要回 503，先写头就撞 ERR_HTTP_HEADERS_SENT
      let headed = false;
      const ensureHead = () => {
        if (!headed && !res.headersSent) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          headed = true;
        }
      };
      const ctx = {
        send: (line) => {
          ensureHead();
          res.write(`${JSON.stringify(line)}\n`);
        },
        // 绕过 JSON.stringify 原样写：测跨 chunk 的半行（字符串或 UTF-8 字节块）
        sendRaw: (chunk) => {
          ensureHead();
          res.write(chunk);
        },
        cut: () => res.destroy(),
        // PB-6：子客户端拦截层回「未桥接」（503 + x-zen-remote: unbridged + reason 体）
        rejectUnbridged: (reason) => {
          res.writeHead(503, { 'Content-Type': 'application/json', 'x-zen-remote': 'unbridged' });
          res.end(JSON.stringify({ ok: false, error: { code: 'zr-plugin-unbridged', reason, plugin: 'dsh-zcode-executor' } }));
        },
      };
      ctxs.push(ctx);
      res.on('close', () => {
        const at = ctxs.indexOf(ctx);
        if (at !== -1) ctxs.splice(at, 1);
      });
      onStream(ctx, req.url);
      return;
    }
    if (pathname === '/zcode-executor/snapshot') {
      hits.snapshot += 1;
      urls.snapshot.push(req.url);
      // snapshot() 可返回 Promise（测试 hold 响应控制放行时机）也可同步返回，统一走 then
      void Promise.resolve(snapshot()).then(({ status, headers, body }) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    hits,
    urls,
    ctxs,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 路由连接回放的等价形状：connection live + hello + 表 + synced（src/routes.ts stream 处理器同款）。 */
const replay = (...sessions) => (ctx) => {
  ctx.send({ type: 'connection', link: 'live', message: null });
  ctx.send({ type: 'hello', repo: null });
  for (const session of sessions) ctx.send({ type: 'session', session });
  ctx.send({ type: 'synced' });
};

const liveSnapshot = (table) => () => ({ status: 200, body: { link: 'live', message: null, synced: true, table } });

test('流式全链路：connection/hello/session/synced 逐行进状态，后续 session/removed 跟进', async () => {
  const stub = await startStub({
    onStream: replay({ id: 'a', repo: '/r', phase: 'running' }),
    snapshot: liveSnapshot({}),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    const seen = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getState()));
    store.start();
    await waitFor(() => store.getState().synced && store.getState().table.a, '首轮同步');
    const same = store.getState();
    assert.equal(same.link, 'live');
    assert.equal(same.table.a.phase, 'running');
    assert.equal(store.getState(), same); // useSyncExternalStore：不变则同引用
    assert.ok(seen.length > 0);

    stub.ctxs[0].send({ type: 'session', session: { id: 'a', repo: '/r', phase: 'idle', lastOutcome: 'done' } });
    await waitFor(() => store.getState().table.a?.phase === 'idle', 'session 更新');
    stub.ctxs[0].send({ type: 'removed', id: 'a' });
    await waitFor(() => store.getState().table.a === undefined, 'removed 删行');

    assert.deepEqual(stub.hits.snapshot, 0); // 流健康时绝不轮询

    unsubscribe();
    const calls = seen.length;
    stub.ctxs[0].send({ type: 'session', session: { id: 'b', repo: '/r', phase: 'running' } });
    await waitFor(() => store.getState().table.b !== undefined, '退订后状态仍前进');
    assert.equal(seen.length, calls); // 退订后不再通知
  } finally {
    store.stop();
    await stub.close();
  }
});

test('一行 JSON 拆成两次写到达：跨 chunk 的半行攒齐后照常解析', async () => {
  const stub = await startStub({
    onStream: (ctx) => {
      ctx.send({ type: 'connection', link: 'live', message: null });
      ctx.send({ type: 'hello', repo: null });
      void (async () => {
        const line = `${JSON.stringify({ type: 'session', session: { id: 'a', repo: '/r', phase: 'running' } })}\n`;
        const at = Math.floor(line.length / 2); // 切点落在行中间（全 ASCII，按字符切即按字节切）
        ctx.sendRaw(line.slice(0, at));
        await sleep(10); // 隔开两次写，让客户端收到两个独立 chunk（stub-watch.mjs 同款）
        ctx.sendRaw(line.slice(at));
        ctx.send({ type: 'synced' });
      })();
    },
    snapshot: liveSnapshot({}),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().synced && store.getState().table.a, '拆成两半的一行攒齐解析进表');
    assert.equal(store.getState().table.a.phase, 'running');
  } finally {
    store.stop();
    await stub.close();
  }
});

test('含中文的行按 UTF-8 字节半切：跨 chunk 边界的多字节字符不坏（对齐服务端 watch-process 同款用例）', async () => {
  // 切点落在「中」字的三个字节中间：先到 1 个字节、再到剩下 2 个
  const splitAt = Buffer.byteLength('{"type":"session","session":{"id":"', 'utf8') + 1;
  const stub = await startStub({
    onStream: (ctx) => {
      ctx.send({ type: 'connection', link: 'live', message: null });
      ctx.send({ type: 'hello', repo: null });
      void (async () => {
        const line = Buffer.from(
          `${JSON.stringify({ type: 'session', session: { id: '中文会话', phase: 'running' } })}\n`,
          'utf8',
        );
        ctx.sendRaw(line.subarray(0, splitAt));
        await sleep(10);
        ctx.sendRaw(line.subarray(splitAt));
        ctx.send({ type: 'synced' });
      })();
    },
    snapshot: liveSnapshot({}),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().synced && store.getState().table['中文会话'], '半切的中文行照常解析进表');
    assert.equal(store.getState().table['中文会话'].phase, 'running'); // 不是乱码，照常进表
    assert.ok(!JSON.stringify(store.getState()).includes('\uFFFD')); // 整个状态里没有替换字符 U+FFFD
  } finally {
    store.stop();
    await stub.close();
  }
});

test('connection 行驱动连接态：failed 与 message 都进状态', async () => {
  const stub = await startStub({
    onStream: (ctx) => {
      ctx.send({ type: 'connection', link: 'failed', message: '启动 watch 失败：ENOENT' });
    },
    snapshot: liveSnapshot({}),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().link === 'failed', 'failed 进状态');
    assert.equal(store.getState().message, '启动 watch 失败：ENOENT');
  } finally {
    store.stop();
    await stub.close();
  }
});

test('connection 行 link 非法：整行零副作用（message 也不更新）', async () => {
  const stub = await startStub({
    onStream: (ctx) => {
      ctx.send({ type: 'connection', link: 'live', message: null });
      ctx.send({ type: 'connection', link: '未知态', message: '坏行想写的话' });
    },
    snapshot: liveSnapshot({}),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().link === 'live', '合法行照常进状态');
    await sleep(POLL_MS * 2); // 给坏行的处理留时间
    assert.equal(store.getState().link, 'live'); // link 没被带偏
    assert.equal(store.getState().message, null); // 坏行的 message 没被存
  } finally {
    store.stop();
    await stub.close();
  }
});

test('断流退化为轮询且状态仍前进（snapshot 可见），流恢复后停轮询', async () => {
  let connections = 0;
  let liveCtx = null;
  const stub = await startStub({
    onStream: (ctx) => {
      connections += 1;
      if (connections === 1) {
        replay({ id: 'a', repo: '/r', phase: 'running' })(ctx);
        ctx.cut(); // 首轮回放完中途掐断
        return;
      }
      liveCtx = ctx;
      replay({ id: 'c', repo: '/r', phase: 'running' })(ctx); // 重连后的健康回放
    },
    snapshot: liveSnapshot({ a: { id: 'a', repo: '/r', phase: 'idle' }, b: { id: 'b', repo: '/r', phase: 'running' } }),
  });
  // 这个用例的 retryMs 特意拉大：退化轮询要能跑出多轮，才观察得到「轮询在前进、恢复后停」
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: 120, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().table.b, '断流后轮询拿到 snapshot 的 b');
    assert.equal(store.getState().synced, true); // snapshot 喂归约器等价路径
    await waitFor(() => stub.hits.snapshot >= 2, '确实在按节奏轮询');
    await waitFor(() => store.getState().table.c, '流恢复重放拿到 c');
    assert.ok(stub.hits.snapshot >= 2);
    const frozen = stub.hits.snapshot;
    liveCtx.send({ type: 'session', session: { id: 'c', repo: '/r', phase: 'idle' } });
    await waitFor(() => store.getState().table.c?.phase === 'idle', '恢复后的流行进状态');
    await sleep(POLL_MS * 4);
    assert.equal(stub.hits.snapshot, frozen); // 流恢复后停轮询（安全网在本用例关着）
  } finally {
    store.stop();
    await stub.close();
  }
});

test('安全网轮询：流连着但不再吐行（宿主缓冲形态），低频 snapshot 把中途回复带进来', async () => {
  // 2026-10-07 真机形态：流 fetch 正常、首轮回放能到，中途增量行疑似被传输层攒住——流没断
  // （link 保持 live、退化轮询不启动），面板就此停格。安全网在流活着时也按 safetyPollMs 拉
  // snapshot：流正常时与服务端一致等于空转，被缓冲时保证状态 ≤ 间隔必达。
  const stub = await startStub({
    onStream: replay({ id: 'a', repo: '/r', phase: 'running', replyMarkdown: '' }),
    snapshot: liveSnapshot({ a: { id: 'a', repo: '/r', phase: 'running', replyMarkdown: '中途输出第一段。' } }),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: POLL_MS });
  try {
    store.start();
    await waitFor(() => store.getState().synced, '首轮同步');
    assert.equal(store.getState().table.a?.replyMarkdown, '');
    // 流连着但不送行（模拟缓冲）：安全网把 snapshot 里的中途回复带进来
    await waitFor(() => store.getState().table.a?.replyMarkdown === '中途输出第一段。', '安全网轮询带回中途回复');
    assert.equal(store.getState().link, 'live'); // 全程没断流，不进 down
    assert.ok(stub.hits.snapshot >= 1);
  } finally {
    store.stop();
    await stub.close();
  }
});

test('在途的轮询响应在流恢复后被丢弃：晚到的旧全量不得倒拨流上已有的新状态', async () => {
  let streamAttempts = 0;
  let snapshotCalls = 0;
  let release = null; // 放行被 hold 的首轮 snapshot 响应
  const staleSnapshot = {
    status: 200,
    body: { link: 'live', message: null, synced: true, table: { a: { id: 'a', repo: '/r', phase: 'running' } } },
  };
  const stub = await startStub({
    onStream: (ctx) => {
      streamAttempts += 1;
      if (streamAttempts === 1) {
        replay({ id: 'a', repo: '/r', phase: 'running' })(ctx);
        setTimeout(() => ctx.cut(), 10); // 回放先冲到客户端再掐断，进轮询兜底
        return;
      }
      replay({ id: 'b', repo: '/r', phase: 'idle' })(ctx); // 恢复后的健康回放：新表只有 b
    },
    snapshot: () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) {
        return new Promise((resolve) => { release = () => resolve(staleSnapshot); }); // 首轮故意 hold
      }
      return { status: 503, body: {} };
    },
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().table.a, '流首轮的 a 进表');
    await waitFor(() => stub.hits.snapshot >= 1 && release !== null, '断流进轮询，首轮响应被 hold 在途');
    await waitFor(() => store.getState().table.b && store.getState().synced, '流恢复并回放完新表（轮询响应仍在途）');
    const frozen = store.getState();
    assert.equal(frozen.table.a, undefined); // 恢复后的新表里没有 a

    release(); // 此刻放行：晚到的旧全量（表里只有 a）
    await sleep(POLL_MS * 3); // 给丢弃路径留时间走完；守卫若失效，旧全量会在这里换掉状态
    assert.equal(store.getState(), frozen); // 表不回退：引用都没换（在途响应被丢弃）
    assert.equal(store.getState().table.b.phase, 'idle');
    assert.equal(store.getState().table.a, undefined);
    assert.equal(store.getState().synced, true);
  } finally {
    store.stop();
    await stub.close();
  }
});

test('snapshot 回放是整表换血：流时期已存在的行不在 snapshot 表里时被移除（removed 语义的等价路径）', async () => {
  const stub = await startStub({
    onStream: (ctx) => {
      ctx.send({ type: 'connection', link: 'live', message: null });
      ctx.send({ type: 'hello', repo: null });
      ctx.send({ type: 'session', session: { id: 'a', repo: '/r', phase: 'running' } });
      ctx.send({ type: 'synced' });
      setTimeout(() => ctx.cut(), 10); // 首轮同步先冲到客户端再掐断，进轮询兜底
    },
    snapshot: liveSnapshot({ b: { id: 'b', repo: '/r', phase: 'idle' } }), // 全量里只有 b：a 已结束
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().table.a, '流时期的 a 在表');
    await waitFor(
      () => store.getState().synced && store.getState().table.b && !store.getState().table.a,
      'snapshot 换血：a 移除、b 进表',
    );
    assert.deepEqual(Object.keys(store.getState().table), ['b']);
    assert.equal(store.getState().synced, true);
  } finally {
    store.stop();
    await stub.close();
  }
});

test('流一直拒连：纯轮询驱动全链路；snapshot 也不可达时合成 down，恢复后轮询带回', async () => {
  let snap = liveSnapshot({ a: { id: 'a', repo: '/r', phase: 'running' } })();
  const stub = await startStub({
    onStream: (ctx) => ctx.cut(),
    snapshot: () => snap,
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().synced && store.getState().table.a, '纯轮询走完 hello+表+synced 等价路径');
    assert.equal(store.getState().link, 'live');

    snap = { status: 503, body: { ok: false } };
    await waitFor(() => store.getState().link === 'down', 'snapshot 不可达合成 down');
    assert.equal(store.getState().synced, false); // 归约器语义：down 回到未同步
    assert.ok(store.getState().table.a); // 旧表保留

    snap = liveSnapshot({ a: { id: 'a', repo: '/r', phase: 'idle' } })();
    await waitFor(() => store.getState().synced && store.getState().link === 'live', '恢复后轮询带回同步');
    assert.equal(store.getState().table.a.phase, 'idle');
  } finally {
    store.stop();
    await stub.close();
  }
});

test('setScopeRepo：只改状态里的 scopeRepo，不触发任何取数', async () => {
  const stub = await startStub({
    onStream: replay({ id: 'a', repo: '/r', phase: 'running' }),
    snapshot: liveSnapshot({}),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().synced, '同步');
    const hits = { ...stub.hits };
    store.setScopeRepo('/r');
    assert.equal(store.getState().scopeRepo, '/r');
    store.setScopeRepo(null);
    assert.equal(store.getState().scopeRepo, null);
    await sleep(POLL_MS * 4 + RETRY_MS * 2);
    assert.deepEqual(stub.hits, hits); // 没重连、没轮询：过滤由消费方做，store 只存
  } finally {
    store.stop();
    await stub.close();
  }
});

test('stop：断流连接、停定时器，请求与状态冻结；start 从头再连', async () => {
  const stub = await startStub({
    onStream: replay({ id: 'a', repo: '/r', phase: 'running' }),
    snapshot: liveSnapshot({}),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().synced, '首轮同步');
    store.stop();
    await waitFor(() => stub.ctxs.length === 0, '桩侧流连接被关掉（AbortController 生效）');
    const hitsAtStop = { ...stub.hits };
    const stateAtStop = store.getState();
    await sleep(RETRY_MS * 3 + POLL_MS * 5);
    assert.deepEqual(stub.hits, hitsAtStop); // 无重连、无轮询：没有遗留定时器
    assert.equal(store.getState(), stateAtStop); // 状态冻结（引用不变）

    store.start();
    store.start(); // 重复 start 不多连
    await waitFor(() => stub.hits.stream === hitsAtStop.stream + 1, '从头再连一次流');
    stub.ctxs.at(-1).send({ type: 'session', session: { id: 'z', repo: '/r', phase: 'running' } });
    await waitFor(() => store.getState().table.z, '重启后的行进状态');
  } finally {
    store.stop();
    await stub.close();
  }
});

test('stop 也能停在轮询态：轮询与流重试都停干净', async () => {
  const stub = await startStub({
    onStream: (ctx) => ctx.cut(),
    snapshot: liveSnapshot({ a: { id: 'a', repo: '/r', phase: 'running' } }),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => stub.hits.snapshot >= 1, '进入轮询');
    store.stop();
    const hitsAtStop = { ...stub.hits };
    const stateAtStop = store.getState();
    await sleep(RETRY_MS * 3 + POLL_MS * 5);
    assert.deepEqual(stub.hits, hitsAtStop); // 轮询与重试定时器都没了
    assert.equal(store.getState(), stateAtStop);
  } finally {
    store.stop();
    await stub.close();
  }
});

test('createSnapshotStore：pollMs / retryMs / firstResponseMs 非正数构造即抛清晰错误', () => {
  assert.throws(() => createSnapshotStore({ baseUrl: '', pollMs: 0 }), /pollMs/);
  assert.throws(() => createSnapshotStore({ baseUrl: '', pollMs: -20 }), /pollMs/);
  assert.throws(() => createSnapshotStore({ baseUrl: '', retryMs: 0 }), /retryMs/);
  assert.throws(() => createSnapshotStore({ baseUrl: '', retryMs: Number.NaN }), /retryMs/);
  assert.throws(() => createSnapshotStore({ baseUrl: '', firstResponseMs: 0 }), /firstResponseMs/);
  assert.throws(() => createSnapshotStore({ baseUrl: '', firstResponseMs: -1 }), /firstResponseMs/);
});

test('路由常量两处复制不漂移：store 的 PATH 与 routes.ts 的 ROUTE 逐一相等', () => {
  assert.equal(STREAM_PATH, STREAM_ROUTE);
  assert.equal(SNAPSHOT_PATH, SNAPSHOT_ROUTE);
  assert.equal(REPO_PATH, REPO_ROUTE);
});

test('stream 收下 TCP 不回：首响应超时按连接失败退化进轮询，重试的流恢复后停轮询', async () => {
  // T4 移交⑤：服务器 accept 之后不写响应头，fetch 永久挂起——修这题之前流会永远挂着、
  // 轮询永不启动。桩首轮什么都不回，注入 40ms 的首响应超时。
  // retryMs 特意拉大：轮询要先跑出可见的一轮，才观察得到「挂起的流不再阻塞兜底」。
  let attempts = 0;
  let liveCtx = null;
  const stub = await startStub({
    onStream: (ctx) => {
      attempts += 1;
      if (attempts === 1) return; // 收下连接什么都不写：客户端 fetch 挂起（靶子）
      liveCtx = ctx;
      replay({ id: 'a', repo: '/r', phase: 'running' })(ctx); // 重试的流：健康回放
    },
    snapshot: liveSnapshot({ s: { id: 's', repo: '/r', phase: 'running' } }),
  });
  const store = createSnapshotStore({
    baseUrl: stub.baseUrl,
    pollMs: POLL_MS,
    retryMs: 120,
    firstResponseMs: 40,
  });
  try {
    store.start();
    await waitFor(() => stub.hits.snapshot >= 1, '流还挂着，超时已把轮询兜底发动');
    await waitFor(() => store.getState().table.s, '轮询拿到全量（挂起的流不再阻塞兜底）');
    await waitFor(() => store.getState().table.a, '重试的流恢复并回放（重试确实发生）');
    const frozen = stub.hits.snapshot;
    liveCtx.send({ type: 'session', session: { id: 'a', repo: '/r', phase: 'idle' } });
    await waitFor(() => store.getState().table.a?.phase === 'idle', '恢复后的流行进状态');
    await sleep(POLL_MS * 4);
    assert.equal(stub.hits.snapshot, frozen); // 流恢复后停轮询
  } finally {
    store.stop();
    await stub.close();
  }
});

test('snapshot 收下 TCP 不回：首轮超时合成 down，下一轮轮询拿到响应即恢复', async () => {
  let snapshotCalls = 0;
  const stub = await startStub({
    onStream: (ctx) => ctx.cut(), // 流一直连不上：全程靠轮询兜底
    snapshot: () => {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return new Promise(() => {}); // 首轮 hold 住不回（永不 resolve）
      return liveSnapshot({ a: { id: 'a', repo: '/r', phase: 'running' } })();
    },
  });
  // down 的窗口只有一轮 pollMs：订阅记下连接态轨迹，恢复后回头断言它出现过
  const links = [];
  const store = createSnapshotStore({
    baseUrl: stub.baseUrl,
    pollMs: POLL_MS,
    retryMs: RETRY_MS,
    firstResponseMs: 40,
  });
  const unsubscribe = store.subscribe(() => links.push(store.getState().link));
  try {
    store.start();
    await waitFor(() => store.getState().link === 'live' && store.getState().synced, '下一轮拿到响应恢复');
    assert.ok(snapshotCalls >= 2, '超时不吞轮询节奏：下一轮照常排');
    assert.ok(links.includes('down'), '首轮超时按连接失败合成过 down');
    assert.ok(store.getState().table.a);
  } finally {
    unsubscribe();
    store.stop();
    await stub.close();
  }
});

test('连 snapshot 都不可达时：服务端已报 failed 的态不被合成的 down 覆盖（⑥：起不来的诊断优先）', async () => {
  const stub = await startStub({
    onStream: (ctx) => {
      ctx.send({ type: 'connection', link: 'failed', message: '启动 watch 失败：ENOENT' });
      setTimeout(() => ctx.cut(), 10); // 报完 failed 再断流，进轮询兜底
    },
    snapshot: () => ({ status: 503, body: {} }), // transport 层也彻底不可达
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().link === 'failed', '服务端报的 failed 先进状态');
    const failedMessage = store.getState().message;
    assert.match(failedMessage, /启动 watch 失败/);
    await sleep(POLL_MS * 6); // 给若干轮不可达的轮询留时间
    assert.equal(store.getState().link, 'failed'); // 合成的 down 不得覆盖 failed
    assert.equal(store.getState().message, failedMessage);
  } finally {
    store.stop();
    await stub.close();
  }
});

for (const status of [401, 403]) {
  test(`snapshot 回 ${status}（admit 拒绝）：message 说清鉴权问题，不再说「连接中断」；重新放行后自动恢复`, async () => {
    let denied = true;
    const stub = await startStub({
      onStream: (ctx) => ctx.cut(), // 流一直连不上：401/403 只能从轮询看到
      snapshot: () =>
        denied ? { status, body: { ok: false, error: { code: status === 401 ? 'unauthorized' : 'forbidden' } } } : liveSnapshot({ a: { id: 'a', repo: '/r', phase: 'running' } })(),
    });
    const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
    try {
      store.start();
      await waitFor(() => store.getState().message !== null, '鉴权拒绝的 message 进状态');
      assert.equal(store.getState().link, 'down'); // 横幅位置不变（连接态仍是断开）
      assert.match(store.getState().message, /无权访问/);
      assert.ok(!/连接中断/.test(store.getState().message), '不再拿「连接中断」误导排障');
      denied = false; // 用户重新登录后服务端不再拒
      await waitFor(() => store.getState().link === 'live' && store.getState().synced, '放行后下一轮轮询自动恢复');
      assert.ok(store.getState().table.a);
    } finally {
      store.stop();
      await stub.close();
    }
  });
}

// ---- PB-6：会话「侧」（本机 / 远程主服务端）与未桥接 503 ----

test('setSession 侧变化（本机→远程）：关旧流、清空面板数据、按新侧重开且请求带 sessionId', async () => {
  const seenUrls = [];
  const stub = await startStub({
    onStream: (ctx, url) => {
      seenUrls.push(url);
      replay({ id: 'a', repo: '/r', phase: 'running' })(ctx);
    },
    snapshot: liveSnapshot({}),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().synced && store.getState().table.a, '本机侧首轮同步');
    store.setSession('zr~abc12345~sess_remote'); // 切到远程会话：本机表对远程侧是错的
    assert.equal(store.getState().table.a, undefined); // 同步清屏（旧侧数据不残留）
    assert.equal(store.getState().link, 'starting');
    await waitFor(() => stub.hits.stream === 2, '侧变化重开流');
    await waitFor(() => store.getState().synced && store.getState().table.a, '新侧重新同步');
    assert.ok(seenUrls.at(-1).includes('sessionId=zr~abc12345~sess_remote'), `请求应带虚拟 id（URL 规范化后 ~ 字面），实际 ${seenUrls.at(-1)}`); // 由桥改道
  } finally {
    store.stop();
    await stub.close();
  }
});

test('setSession 同侧换会话不重开流（数据是整机的）；后续请求改用新参数', async () => {
  let snapshotQuery = null;
  const stub = await startStub({
    onStream: replay({ id: 'a', repo: '/r', phase: 'running' }),
    snapshot: liveSnapshot({ b: { id: 'b', repo: '/r', phase: 'idle' } }),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().synced, '本机侧首轮同步');
    store.setSession('zr~abc12345~s1'); // 本机 → A 机：侧变化，重开一次
    await waitFor(() => stub.hits.stream === 2 && store.getState().synced, '切到 A 机重开并同步');
    store.setSession('zr~abc12345~s2'); // 同机换会话：数据是整机的，流不动
    await sleep(POLL_MS * 2);
    assert.equal(stub.hits.stream, 2); // 没有第三次连接
    // 让流断一次，断言兜底轮询用的是新会话参数
    stub.ctxs[0].cut();
    await waitFor(() => stub.hits.snapshot >= 1, '断流进轮询');
    snapshotQuery = stub.urls.snapshot.at(-1);
    assert.ok(snapshotQuery.includes('sessionId=zr~abc12345~s2'), `轮询应带新会话参数，实际 ${snapshotQuery}`);
  } finally {
    store.stop();
    await stub.close();
  }
});

test('setSession 不同 serverId 重开；远程切回本机重开且请求不带 sessionId', async () => {
  const stub = await startStub({
    onStream: replay({ id: 'a', repo: '/r', phase: 'running' }),
    snapshot: liveSnapshot({}),
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: RETRY_MS, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().synced, '首轮同步');
    store.setSession('zr~abc12345~s1');
    await waitFor(() => stub.hits.stream === 2 && store.getState().synced, '切到主机 A：重开');
    store.setSession('zr~def67890~s1');
    await waitFor(() => stub.hits.stream === 3 && store.getState().synced, '切到主机 B：另一台，重开');
    store.setSession(null); // 切回本机（无主会话）
    await waitFor(() => stub.hits.stream === 4 && store.getState().synced, '回本机：重开');
    assert.ok(!stub.urls.stream.at(-1).includes('sessionId='), '本机请求不带 sessionId');
    // 同侧（本机）再 setSession null：不重开
    store.setSession(null);
    await sleep(POLL_MS * 2);
    assert.equal(stub.hits.stream, 4);
  } finally {
    store.stop();
    await stub.close();
  }
});

test('503 未桥接（流与轮询都回）：面板显示原因、不退化为本机数据、重试节奏放宽', async () => {
  let snapshotCalls = 0;
  let bridged = false; // 模拟主服务端主人中途同意
  const stamps = [];
  const unbridged = () => ({
    status: 503,
    headers: { 'x-zen-remote': 'unbridged' },
    body: { ok: false, error: { code: 'zr-plugin-unbridged', reason: 'consent-off', plugin: 'dsh-zcode-executor' } },
  });
  const stub = await startStub({
    onStream: (ctx) => (bridged ? replay({ id: 'a', repo: '/r', phase: 'running' })(ctx) : ctx.rejectUnbridged('consent-off')),
    snapshot: () => {
      snapshotCalls += 1;
      stamps.push(Date.now());
      if (!bridged) return unbridged();
      return liveSnapshot({ a: { id: 'a', repo: '/r', phase: 'idle' } })();
    },
  });
  const store = createSnapshotStore({
    baseUrl: stub.baseUrl,
    pollMs: POLL_MS,
    retryMs: RETRY_MS,
    safetyPollMs: 0,
    unbridgedRetryMs: 80, // 生产默认 5000；测试注入小值驱动
  });
  try {
    store.start();
    store.setSession('zr~abc12345~sess_remote'); // 远程会话里的未桥接（流重连后带参数再拒）
    await waitFor(() => stub.hits.stream >= 2, '远程侧重开后再拒');
    await waitFor(() => store.getState().message !== null, '未桥接原因进面板');
    assert.equal(store.getState().link, 'down'); // 横幅位置不变
    assert.match(store.getState().message, /未允许转发整机数据/);
    const snapAtDown = stub.hits.snapshot;
    await sleep(200); // 若还是 pollMs=20 的节奏，这段会攒下 ~10 轮；80ms 节奏只应 2-3 轮
    const pollsDuringDown = stub.hits.snapshot - snapAtDown;
    assert.ok(pollsDuringDown <= 4, `未桥接期间轮询应放宽节奏，200ms 内轮询了 ${pollsDuringDown} 次`);
    if (stamps.length >= 2) {
      const gap = stamps.at(-1) - stamps.at(-2);
      assert.ok(gap >= 60, `相邻两轮间隔应接近 unbridgedRetryMs(80ms)，实测 ${gap}ms`);
    }
    // 关键：不退化为本机数据——未桥接期间每个请求仍带着远程会话参数，等桥恢复自动接上
    for (const url of stub.urls.snapshot) {
      assert.ok(url.includes('sessionId=zr~'), `未桥接期间请求仍带 sessionId，实际 ${url}`);
    }
    bridged = true; // 桥上了：流重试或下一轮轮询任一先到都该恢复
    await waitFor(() => store.getState().link === 'live' && store.getState().synced, '桥恢复后自动接上');
    assert.equal(store.getState().message, null); // 恢复后横幅清掉
    assert.ok(store.getState().table.a);
  } finally {
    store.stop();
    await stub.close();
  }
});

test('503 未桥接：体读不出 reason 时按 unknown 走「其他」文案；各 reason 的文案对表', async () => {
  const stub = await startStub({
    onStream: (ctx) => ctx.rejectUnbridged('declaration-mismatch'), // 体里有 reason（非专名 → 其他文案）
    snapshot: () => ({ status: 503, headers: { 'x-zen-remote': 'unbridged' }, body: 'not json' }), // 体不是 JSON → unknown
  });
  const store = createSnapshotStore({ baseUrl: stub.baseUrl, pollMs: POLL_MS, retryMs: 5_000, safetyPollMs: 0 });
  try {
    store.start();
    await waitFor(() => store.getState().message !== null, '未桥接原因进面板');
    assert.match(store.getState().message, /插件桥未桥接，原因：declaration-mismatch/, '非专名 reason 附原文');
  } finally {
    store.stop();
    await stub.close();
  }
});

test('unbridgedMessageOf：四类专名文案 + 其他附 reason 原文', () => {
  assert.match(unbridgedMessageOf('not-on-server'), /未安装同版本/);
  assert.match(unbridgedMessageOf('version-mismatch'), /未安装同版本/);
  assert.match(unbridgedMessageOf('consent-off'), /未允许转发整机数据/);
  assert.match(unbridgedMessageOf('offline'), /中继离线/);
  assert.match(unbridgedMessageOf('server-too-old'), /版本过旧/);
  assert.match(unbridgedMessageOf('weird-reason'), /weird-reason/); // 其他：附原文
  assert.match(unbridgedMessageOf('not-shared'), /not-shared/);
});

test('createSnapshotStore：unbridgedRetryMs 非正数构造即抛清晰错误', () => {
  assert.throws(() => createSnapshotStore({ baseUrl: '', unbridgedRetryMs: 0 }), /unbridgedRetryMs/);
  assert.throws(() => createSnapshotStore({ baseUrl: '', unbridgedRetryMs: -5 }), /unbridgedRetryMs/);
});
