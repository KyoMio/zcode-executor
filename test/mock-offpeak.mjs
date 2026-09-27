// 本文件负责：测试用的闲时服务器（node:http），复刻 zcode.z.ai `/api/v1/off-peak` 的取号、查排位、结算、查资格。
// 不负责：闲时模型请求（`/anthropic/v1/messages`，回合由 mock-appserver 模拟）；任何真网络。
// 和谁打交道：lib/offpeak.mjs 的客户端（测试里用 origin 或 ZCODE_EXECUTOR_OFFPEAK_ORIGIN 指过来）。
//
// 状态机照 ZCode App 3.14.1 自带的开发用模拟网关（app.asar host 进程的 mock gateway）写，
// 响应形状与业务码对照真机（verified.md「闲时任务探针」，2026-09-27）：
// - 取号后 queued，过 readyDelayMs 变 ready；截止时间照真机随时间走、不看有没有人来查：
//   ready_deadline = 取号时间 + readyDelayMs + readyTtlMs（真机约 queued_at + 310 秒），到点未开跑 → expired；
//   active_deadline = 开跑时间 + activeMs（真机 3 小时整），到点 → expired。
//   settle 后 settled（已过期的号 settle 仍回 200、state 原样 expired，真机）；未知票号在 status 里是 not_found。
//   同一个 task_id 再取号，旧号作废（expired）。
// - 结算不存在的号回 200、state settled：照 App mock 网关，真机未验。
// - 成功包成 {code:0, msg:'success', data, logid}；失败 {code, msg, logid}：缺参数 400/3000，
//   额度用完 429/3103 带 data.next_take_at（App mock 网关），没资格 3101（HTTP 状态真机没见过，这里用 400）。
// - 鉴权头 authorization: Bearer <jwt> 与 x-coding-plan-api-key 缺一或不匹配 → 401。
// 请求记录只存方法、路径、body 和鉴权是否正确的布尔值，不存凭据原值。
//
// 失败注入用法（路由名：availability / take / status / settle）：
//   startMockOffPeak({ failRoute: { settle: { status: 500, times: 3 } } })   // 前 3 次结算回 500，之后正常
//   startMockOffPeak({ failRoute: { status: { delayMs: 500 } } })            // 查排位先等 500 毫秒再正常答（测超时）
//   startMockOffPeak({ failRoute: { take: { status: 302, headers: { location: '…' }, body: '' } } })
//   mock.setFailRoute('take', { status: 429, body: { code: 3103, msg: 'limit' } })  // 运行中换上
//   mock.setFailRoute('take', null)                                           // 撤掉，恢复正常
import http from 'node:http';

const PREFIX = '/api/v1/off-peak';

/**
 * 起一个模拟闲时服务器。
 * @param {object} [options]
 * @param {string} [options.jwt] 期望的 JWT（Bearer 后面那段）
 * @param {string} [options.planKey] 期望的 x-coding-plan-api-key
 * @param {boolean} [options.eligible=true] false → 取号回 3101
 * @param {number} [options.quotaExhaustedCount=0] 前 N 次取号回 3103
 * @param {number} [options.readyDelayMs=50] queued → ready 的时间
 * @param {number} [options.readyTtlMs=300000] ready 多久没开跑就 expired（真机约 5 分钟）
 * @param {number} [options.activeMs=10800000] active 最长时间（真机 3 小时）
 * @param {number} [options.nextPollS=1] 回给客户端的 next_poll_after（秒）
 * @param {object} [options.failRoute] 按路由（availability / take / status / settle）强制行为：
 *   { status?, body?, headers?, delayMs?, times? }——delayMs 先等再答；给了 status 就回这个 HTTP 状态、
 *   响应头和 body（body 是字符串原样发，是对象就 JSON；缺省 {code:status, msg:'forced failure'}）；
 *   times 给了就只作用前 N 次请求，之后这条路由恢复正常。
 * @returns {Promise<{origin: string, requests: object[], activate: (ticketId: string) => boolean,
 *   setFailRoute: (route: string, behavior: object|null) => void, close: () => Promise<void>}>}
 */
export async function startMockOffPeak({
  jwt = 'mock-offpeak-jwt-value',
  planKey = 'mock-offpeak-plan-key',
  eligible = true,
  quotaExhaustedCount = 0,
  readyDelayMs = 50,
  readyTtlMs = 300000,
  activeMs = 3 * 60 * 60 * 1000,
  nextPollS = 1,
  failRoute: initialFailRoute = {},
} = {}) {
  // 逐条拷一份：times 计数与 setFailRoute 不改调用方的对象
  const failRoute = Object.fromEntries(Object.entries(initialFailRoute).map(([k, v]) => [k, { ...v }]));
  const tickets = new Map(); // ticketId → { ticketId, taskId, state, takenAt, seq, readyDeadline?, activeDeadline? }
  const byTask = new Map(); // taskId → 最新 ticketId
  const requests = [];
  let quotaLeft = quotaExhaustedCount;
  let seq = 0;
  let logSeq = 0;

  // 按时间推进状态，查询与结算前都先推一次（App mock 网关的 advance）
  function advance(t, now) {
    if (t.state === 'queued' && now - t.takenAt >= readyDelayMs) {
      t.state = 'ready';
      t.readyDeadline = t.takenAt + readyDelayMs + readyTtlMs;
    }
    if (t.state === 'ready' && t.readyDeadline !== undefined && now > t.readyDeadline) t.state = 'expired';
    if (t.state === 'active' && t.activeDeadline !== undefined && now > t.activeDeadline) t.state = 'expired';
  }
  function positionOf(t) {
    let ahead = 0;
    for (const other of tickets.values()) if (other.state === 'queued' && other.seq < t.seq) ahead += 1;
    return ahead + 1;
  }

  function send(res, status, payload, headers = {}) {
    const logid = `mock-log-${++logSeq}`;
    const body = typeof payload === 'string' ? payload : JSON.stringify({ logid, ...payload }); // failRoute 指定的 logid 优先
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body);
  }
  const ok = (res, data) => send(res, 200, { code: 0, msg: 'success', data });

  function routeOf(method, route) {
    if (method === 'GET' && route === '/ticket/availability') return 'availability';
    if (method === 'POST' && route === '/ticket') return 'take';
    if (method === 'POST' && route === '/ticket/status') return 'status';
    if (method === 'POST' && /^\/ticket\/[^/]+\/settle$/.test(route)) return 'settle';
    return null;
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const url = new URL(req.url, 'http://mock');
    const authOk = req.headers.authorization === `Bearer ${jwt}` && req.headers['x-coding-plan-api-key'] === planKey;
    requests.push({
      method: req.method,
      path: url.pathname,
      body,
      authOk,
      hasContentType: req.headers['content-type'] === 'application/json',
    });

    if (!url.pathname.startsWith(PREFIX)) return send(res, 404, { code: 404, msg: 'not found' });
    const route = url.pathname.slice(PREFIX.length);
    const name = routeOf(req.method, route);
    if (!name) return send(res, 404, { code: 404, msg: 'not found' });

    const forced = failRoute[name];
    if (forced?.times !== undefined && --forced.times <= 0) delete failRoute[name]; // 这次是最后一次
    if (forced?.delayMs) await new Promise((r) => setTimeout(r, forced.delayMs));
    if (res.destroyed) return; // 客户端超时先走了
    if (forced?.status) {
      return send(res, forced.status, forced.body ?? { code: forced.status, msg: 'forced failure' }, forced.headers);
    }

    if (!authOk) return send(res, 401, { code: 401, msg: 'unauthorized' });
    const now = Date.now();

    if (name === 'availability') {
      if (!eligible) return send(res, 400, { code: 3101, msg: 'off-peak not eligible' });
      return ok(res, quotaLeft > 0 ? { can_take_number: false, next_take_at: now + 60000 } : { can_take_number: true });
    }

    if (name === 'take') {
      const taskId = body?.task_id;
      if (typeof taskId !== 'string' || !taskId) return send(res, 400, { code: 3000, msg: 'task_id required' });
      if (!eligible) return send(res, 400, { code: 3101, msg: 'off-peak not eligible' });
      if (quotaLeft > 0) {
        quotaLeft -= 1;
        return send(res, 429, { code: 3103, msg: 'free tier limit reached', data: { next_take_at: now + 60000 } });
      }
      const old = tickets.get(byTask.get(taskId));
      if (old && ['queued', 'ready', 'active'].includes(old.state)) old.state = 'expired';
      const t = { ticketId: `mock-ticket-${++seq}`, taskId, state: 'queued', takenAt: now, seq };
      advance(t, now);
      tickets.set(t.ticketId, t);
      byTask.set(taskId, t.ticketId);
      return ok(res, {
        ticket_id: t.ticketId,
        task_id: taskId,
        state: t.state,
        accepted: true,
        position: t.state === 'queued' ? positionOf(t) : null,
        next_poll_after: nextPollS,
        queued_at: now,
        ...(t.readyDeadline ? { ready_deadline: t.readyDeadline } : {}),
      });
    }

    if (name === 'status') {
      if (!Array.isArray(body?.ticket_ids)) return send(res, 400, { code: 3000, msg: 'ticket_ids required' });
      const list = body.ticket_ids.slice(0, 100).map((id) => {
        const t = tickets.get(id);
        if (!t) return { ticket_id: id, state: 'not_found' };
        advance(t, now);
        return {
          ticket_id: t.ticketId,
          task_id: t.taskId,
          state: t.state,
          position: t.state === 'queued' ? positionOf(t) : null,
          ...(t.readyDeadline ? { ready_deadline: t.readyDeadline } : {}),
          ...(t.activeDeadline ? { active_deadline: t.activeDeadline } : {}),
        };
      });
      return ok(res, { next_poll_after: nextPollS, tickets: list });
    }

    // settle
    const ticketId = decodeURIComponent(route.split('/')[2]);
    const t = tickets.get(ticketId);
    if (t) {
      advance(t, now);
      if (t.state !== 'expired') t.state = 'settled';
    }
    return ok(res, { ticket_id: ticketId, state: t?.state ?? 'settled', settled_at: now });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    /** 模拟回合开跑：ready 的号变 active 并给 active_deadline；不是 ready 返回 false。 */
    activate(ticketId) {
      const t = tickets.get(ticketId);
      if (!t) return false;
      const now = Date.now();
      advance(t, now);
      if (t.state !== 'ready') return false;
      t.state = 'active';
      t.activeDeadline = now + activeMs;
      return true;
    },
    /** 运行中设置或替换某条路由的失败行为（形状同 options.failRoute 的一项）；传 null 撤掉。 */
    setFailRoute(route, behavior) {
      if (behavior) failRoute[route] = { ...behavior };
      else delete failRoute[route];
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
