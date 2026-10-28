// proxy-fetch 的传输合同测试：本地 socket 假代理 + 本地 http 目标服务器，不碰真实网络（RULES §9）。
// 目标一律 http://（隧道内不再套 TLS）：https 目标的 tls.connect 握手需要证书，零依赖下无法在
// 测试里自签，那段握手按代码评审覆盖，是已知未测路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { createProxyFetch, parseProxyUrl } from '../lib/review/proxy-fetch.mjs';

// 跟踪 server 接受的连接与假代理主动发出的上游连接，t.after 统一销毁再 close，不留挂起句柄
function trackSockets(server) {
  const sockets = new Set();
  server._sockets = sockets;
  server.track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    return socket;
  };
  server.on('connection', (socket) => server.track(socket));
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function closeAll(t, ...servers) {
  t.after(() => Promise.all(servers.map((server) =>
    new Promise((resolve) => {
      for (const socket of server._sockets) socket.destroy();
      server.close(() => resolve());
    }),
  )));
}

// 假代理：记下 CONNECT 原文，答 200 后把隧道两头对接。CONNECT 小报文测试环境单包到达，不做拼包。
function fakeProxy(seen, respond = 'HTTP/1.1 200 Connection established\r\n\r\n') {
  const server = trackSockets(net.createServer((socket) => {
    socket.once('data', (chunk) => {
      seen.connect = chunk.toString('latin1');
      if (!respond.startsWith('HTTP/1.1 2')) {
        socket.end(respond); // 拒绝路径写完就关，不留半开连接挡住 closeAll
        return;
      }
      socket.write(respond);
      const upstream = server.track(net.connect(seen.targetPort, '127.0.0.1'));
      socket.pipe(upstream);
      upstream.pipe(socket);
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
  }));
  return server;
}

// 假目标：记下方法与请求体，按 responder 应答
function fakeTarget(seen, responder) {
  return trackSockets(http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      seen.method = req.method;
      seen.url = req.url;
      seen.headers = req.headers;
      seen.body = Buffer.concat(chunks).toString('utf8');
      responder(req, res);
    });
  }));
}

test('parseProxyUrl：只接受 http/https，socks、非 URL 与空白拒绝且不回显原值', () => {
  assert.equal(parseProxyUrl('http://127.0.0.1:8080').protocol, 'http:');
  assert.equal(parseProxyUrl(' https://proxy.example ').protocol, 'https:');
  for (const bad of ['socks5://user:pass@127.0.0.1:1080', '::::', '  ', 123]) {
    assert.throws(() => parseProxyUrl(bad), (err) => {
      assert.ok(err instanceof TypeError);
      assert.equal(err.message.includes('pass'), false);
      return true;
    });
  }
});

test('createProxyFetch：CONNECT 隧道往返，状态/头/JSON 与目标侧方法、路径、请求体一致', async (t) => {
  const seen = {};
  const target = fakeTarget(seen, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'X-Typesafe-Request-Id': 'req_proxy_1' });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxy = fakeProxy(seen);
  await listen(target);
  await listen(proxy);
  closeAll(t, target, proxy);
  seen.targetPort = target.address().port;

  const fetchImpl = createProxyFetch(`http://127.0.0.1:${proxy.address().port}`);
  const response = await fetchImpl(`http://127.0.0.1:${seen.targetPort}/v1/systemone`, {
    method: 'POST',
    headers: { authorization: 'Bearer jev_test_secret', 'content-type': 'application/json' },
    body: '{"a":1}',
    signal: new AbortController().signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.ok, true);
  assert.equal(response.headers.get('x-typesafe-request-id'), 'req_proxy_1'); // 头名大小写不敏感
  assert.equal(response.headers.get('not-there'), null);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, '/v1/systemone');
  assert.equal(seen.headers.authorization, 'Bearer jev_test_secret');
  assert.equal(seen.body, '{"a":1}');
  assert.match(seen.connect, /^CONNECT 127\.0\.0\.1:\d+ HTTP\/1\.1\r\n/);
  await response.body.cancel(); // 已读完再 cancel 不抛错、不挂起
});

test('createProxyFetch：代理地址带用户名密码时 CONNECT 带 Proxy-Authorization', async (t) => {
  const seen = {};
  const target = fakeTarget(seen, (_req, res) => res.end('{}'));
  const proxy = fakeProxy(seen);
  await listen(target);
  await listen(proxy);
  closeAll(t, target, proxy);
  seen.targetPort = target.address().port;

  const fetchImpl = createProxyFetch(`http://user:p%40ss@127.0.0.1:${proxy.address().port}`);
  const response = await fetchImpl(`http://127.0.0.1:${seen.targetPort}/x`, { method: 'GET' });
  assert.equal(response.ok, true);
  const expected = Buffer.from('user:p@ss').toString('base64'); // URL 里的 %40 解回 @ 再编码
  // 头名大小写不敏感，值（base64）必须原样匹配
  const authLine = seen.connect.split('\r\n').find((line) => line.toLowerCase().startsWith('proxy-authorization:'));
  assert.equal(authLine, `proxy-authorization: Basic ${expected}`);
  await response.body.cancel();
});

test('createProxyFetch：代理拒绝 CONNECT（407）时抛错且不碰目标', async (t) => {
  const seen = {};
  const target = fakeTarget(seen, (_req, res) => res.end('{}'));
  const proxy = fakeProxy(seen, 'HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n');
  await listen(target);
  await listen(proxy);
  closeAll(t, target, proxy);
  seen.targetPort = target.address().port;

  const fetchImpl = createProxyFetch(`http://127.0.0.1:${proxy.address().port}`);
  await assert.rejects(fetchImpl(`http://127.0.0.1:${seen.targetPort}/x`, { method: 'GET' }), /407/);
  assert.equal(seen.method, undefined);
});

test('createProxyFetch：代理连不上时按网络错误抛错（jev 归类 network_error 后重试）', async () => {
  // 找一个没在监听的端口：先监听拿到空口再立刻关掉
  const probe = net.createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(() => resolve()));
  const fetchImpl = createProxyFetch(`http://127.0.0.1:${port}`);
  await assert.rejects(fetchImpl('http://127.0.0.1:1/x', { method: 'GET' }));
});

test('createProxyFetch：jev.mjs 的 fake Response 形状（ok/status/headers.get/json/body.cancel）全部满足', async (t) => {
  // 与 test/jev.test.mjs 里 makeScreen 的 fake response 逐字段对齐，防止两边的 seam 悄悄分叉
  const seen = {};
  const target = fakeTarget(seen, (_req, res) => res.end(JSON.stringify({ model: 'jev-1.13.0' })));
  const proxy = fakeProxy(seen);
  await listen(target);
  await listen(proxy);
  closeAll(t, target, proxy);
  seen.targetPort = target.address().port;

  const fetchImpl = createProxyFetch(`http://127.0.0.1:${proxy.address().port}`);
  const response = await fetchImpl(`http://127.0.0.1:${seen.targetPort}/v1/systemone`, { method: 'POST', body: '{}' });
  assert.equal(typeof response.ok, 'boolean');
  assert.equal(typeof response.status, 'number');
  assert.equal(typeof response.headers.get, 'function');
  assert.equal(typeof response.json, 'function');
  assert.equal(typeof response.body.cancel, 'function');
  assert.deepEqual(await response.json(), { model: 'jev-1.13.0' });
});
