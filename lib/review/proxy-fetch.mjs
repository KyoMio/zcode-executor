// 本文件负责：Jev 快筛的代理传输——按配置的 http(s) 代理地址建 CONNECT 隧道，把请求发出去，
// 包成 jev.mjs fetchImpl seam 需要的最小 Response（status/ok/headers.get/json/body.cancel）。
// 不负责：代理地址的配置校验（lib/config.mjs）、deadline 与重试（jev.mjs 自带）。
// 为什么不用 NODE_USE_ENV_PROXY：它只在进程启动时解析 env（undici 官方文档，Node ≥22.21 才有），
// 运行中设置无效；detached runner 的 env 继承不可靠（与 D15 的 key 同理走 config.json，D24），且
// 代理 env 若经 spawn 传下去会漏给 app-server 子进程，改变派单主链路的网络行为。
// 零依赖约束（RULES §1）排除 undici ProxyAgent，故用 stdlib 自实现：http.request 发 CONNECT、
// tls.connect 在隧道上套目标 TLS、http(s).request 的 createConnection 接管隧道 socket。
// 权宜：Jev 目标恒为 https://api.typesafe.ai；socks 代理不支持，需要时再加。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';

const abortError = () => Object.assign(new Error('Jev 代理中断'), { name: 'AbortError' });

/**
 * 校验代理地址并返回 URL；非法抛 TypeError。配置层的 ExecutorError 版本在 lib/config.mjs，
 * 这里兜底独立调用方。错误里不携带原值：代理地址可含用户名密码（RULES §8 一类字符串不回显）。
 */
export function parseProxyUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError('Jev 代理地址必须是非空白字符串');
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new TypeError('Jev 代理地址不是合法 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`Jev 代理地址只支持 http:// 或 https://，收到 ${parsed.protocol}`);
  }
  return parsed;
}

// 等 socket 的就绪事件（'connect'/'secureConnect'）；signal 触发时带错误销毁，让等待立刻
// 以 AbortError 收场而不是挂到 deadline 之外。once 在 'error' 时自动 reject，destroy(err) 保证发 error。
async function settled(socket, event, signal) {
  if (!signal) {
    await once(socket, event);
    return;
  }
  const ready = once(socket, event);
  const fire = () => socket.destroy(abortError());
  if (signal.aborted) fire();
  else signal.addEventListener('abort', fire, { once: true });
  try {
    await ready;
  } finally {
    signal.removeEventListener('abort', fire);
  }
}

// ① 连代理本身（http 代理走 TCP，https 代理先 TLS）→ ② CONNECT 打洞（借 http.request
// 管响应解析，2xx 才发 'connect' 事件给隧道 socket）→ ③ 目标是 https 时在隧道上套目标 TLS。
// createConnection 没有 agent 时按 tunnel-agent 同款手法直接接管连接（同 tick 内交回 req，
// socket 错误无缝隙漏给 runner）。
async function tunnel(proxy, target, signal) {
  const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
  if (signal?.aborted) throw abortError();

  const proxySocket = proxy.protocol === 'https:'
    ? tls.connect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
    : net.connect({ host: proxy.hostname, port: proxyPort });
  try {
    await settled(proxySocket, proxy.protocol === 'https:' ? 'secureConnect' : 'connect', signal);
  } catch (err) {
    proxySocket.destroy();
    throw err;
  }

  const connectHeaders = { host: `${target.hostname}:${targetPort}` };
  if (proxy.username !== '' || proxy.password !== '') {
    const credentials = Buffer.from(
      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
    ).toString('base64');
    connectHeaders['proxy-authorization'] = `Basic ${credentials}`;
  }
  const connectReq = http.request({
    host: proxy.hostname,
    port: proxyPort,
    method: 'CONNECT',
    path: `${target.hostname}:${targetPort}`,
    headers: connectHeaders,
    setHost: false, // Host 已在上面手写：CONNECT 的 Host 是目标地址
    createConnection: () => proxySocket,
  });
  connectReq.end();
  // 实测（2026-10-28，Node 22.22.3）：CONNECT 的非 2xx 应答也走 'connect' 事件（statusCode 带回
  // 407 之类），不是 'response'；且 node 随即关掉该连接。判成败必须看状态码，不能只看 socket 在不在。
  const handshake = await Promise.race([
    once(connectReq, 'connect').then(([res, socket]) => ({ res, socket })),
    once(connectReq, 'response').then(([res]) => ({ res, socket: undefined })),
  ]);
  const connectStatus = handshake.res.statusCode ?? 0;
  if (handshake.socket === undefined || connectStatus < 200 || connectStatus >= 300) {
    // 三种失败归一销毁：'connect' 事件带非 2xx（node 已自关）、'response' 事件（socket 可能还开着）
    handshake.res.destroy?.();
    handshake.socket?.destroy();
    proxySocket.destroy();
    throw new Error(`代理拒绝 CONNECT：HTTP ${connectStatus}`);
  }
  if (target.protocol !== 'https:') return handshake.socket;

  const secure = tls.connect({ socket: handshake.socket, servername: target.hostname });
  try {
    await settled(secure, 'secureConnect', signal);
  } catch (err) {
    secure.destroy();
    throw err;
  }
  return secure;
}

// 包成 jev.mjs 需要的最小 Response：不做流式，整包读进内存（Jev 请求与响应都是几 KB）。
function toResponse(res, connection) {
  const headers = new Map();
  for (const [name, value] of Object.entries(res.headers)) {
    headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value ?? ''));
  }
  const text = new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    // 半截响应按 AbortError 归类，jev.mjs 记 deadline_exceeded 而不是 invalid_response
    res.on('aborted', () => reject(abortError()));
    res.on('error', reject);
  });
  // cancel 后 text 会 reject：若没人调 json()（jev 的错误路径只 cancel 不读正文），这个
  // reject 不能变成 runner 里的 unhandledRejection；挂上静默处理器，json() 照常拿到同一个拒绝。
  text.catch(() => {});
  // runner 是常驻进程：响应关闭（读完或取消）后把隧道关掉，不留半开连接
  res.on('close', () => connection.destroy());
  return {
    status: res.statusCode ?? 0,
    ok: res.statusCode >= 200 && res.statusCode < 300,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    json: async () => JSON.parse(await text),
    body: { cancel: async () => { res.destroy(); } },
  };
}

/** 构造走 HTTP 代理的 fetchImpl；proxyUrl 非法直接抛。每次调用一条新隧道（不重连复用）。 */
export function createProxyFetch(proxyUrl) {
  const proxy = parseProxyUrl(proxyUrl);
  return async function proxiedFetch(url, init = {}) {
    const target = new URL(String(url));
    const connection = await tunnel(proxy, target, init.signal);
    const headers = { ...init.headers };
    if (typeof init.body === 'string' && !('content-length' in headers) && !('Content-Length' in headers)) {
      headers['content-length'] = String(Buffer.byteLength(init.body));
    }
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request(String(target), {
      method: init.method ?? 'GET',
      headers,
      createConnection: () => connection,
      signal: init.signal, // ClientRequest 原生支持：abort 即销毁并抛 AbortError
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
    const [res] = await once(req, 'response');
    return toResponse(res, connection);
  };
}
