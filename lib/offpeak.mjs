// 本文件负责：闲时服务器客户端（工作流层，decisions D20）——对 `<origin>/api/v1/off-peak` 的查资格、取号、
// 查排位、结算四个请求，校验返回形状，把失败归成四类（unavailable / not-applicable / quota / changed）。
// 不负责：凭据从哪来（lib/credentials.mjs 的 readOffPeakAuth）、等号就绪的轮询节奏与重取号（runner 的闲时部分）、
// 闲时回合本身（走 app-server 的官方闲时 provider，协议层）、退出码之外的打印。
// 和谁打交道：全局 fetch（可注入），lib/errors.mjs，lib/scrub.mjs（按值抹掉凭据）。
//
// 真机事实（verified.md「闲时任务探针」2026-09-27，App 3.14.1）：生产 origin https://zcode.z.ai；
// 头 authorization: Bearer <JWT> + x-coding-plan-api-key；成功回 {code:0, msg, data, logid}；
// 3101 没资格、3103 额度用完（带 next_take_at，毫秒）；已过期的号 settle 仍回 200、state 原样 expired。
//
// 安全边界（RULES §8，D20）：JWT 与 key 只进请求头；错误 message 与 details 里的服务器原话、网络错误原文
// 都先按值抹掉这两样再用。
import { ExecutorError } from './errors.mjs';
import { scrubValues } from './scrub.mjs';

const DEFAULT_ORIGIN = 'https://zcode.z.ai';
const API_PREFIX = '/api/v1/off-peak';
const DEFAULT_POLL_MS = 60000;
const MIN_POLL_MS = 1000; // 服务器回 0 或负数时别把轮询变成空转
const MAX_STATUS_IDS = 100; // App 客户端同样最多 100 个（batchStatus）
const DOCTOR_HINT = '闲时接口可能变了，跑 zcode-executor doctor --offpeak 确认';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 面向人的步骤名；details.step 用英文方法名。 */
const STEP_NAMES = { availability: '查资格', take: '取号', status: '查排位', settle: '结算' };

/**
 * origin 只收 https，或本机回环地址上的 http（测试的 mock）：请求头里有 JWT 与 key，
 * 不能因为一个环境变量就发到明文的任意地址。
 */
function checkOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ExecutorError(`闲时服务地址不是合法 URL：${raw}。应是 https 地址或本机回环地址上的 http，检查 ZCODE_EXECUTOR_OFFPEAK_ORIGIN`, 1);
  }
  if (url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
    return url.origin;
  }
  throw new ExecutorError(
    `闲时服务地址必须是 https，或本机回环地址（127.0.0.1、localhost、[::1]）上的 http，实际是 ${url.origin}：请求头带登录凭据，不能明文发往别处。检查 ZCODE_EXECUTOR_OFFPEAK_ORIGIN`,
    1,
  );
}

/**
 * 服务器时间戳统一成毫秒。权宜：真机只见过 ready_deadline 等是毫秒，next_take_at 的单位没验过；
 * 小于 1e12（2001 年以前的毫秒数）的按秒换算，真机撞见 3103 时核对一次再定。
 */
function toMs(v) {
  if (typeof v !== 'number') return undefined;
  return v < 1e12 ? v * 1000 : v;
}

/**
 * 建一个闲时服务器客户端。返回值里的时间 readyDeadline、activeDeadline、nextTakeAt、settledAt
 * 都是毫秒时间戳（Unix epoch）；nextPollMs 是毫秒间隔。
 * @param {object} options
 * @param {string} [options.origin] 缺省取 env.ZCODE_EXECUTOR_OFFPEAK_ORIGIN，再缺省 https://zcode.z.ai；
 *   必须是 https 或本机回环的 http，否则抛 ExecutorError（退出码 1）
 * @param {{jwt: string, planKey: string}} options.auth readOffPeakAuth 的结果
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs=10000] 每个请求的超时
 * @param {object} [options.env]
 */
export function createOffPeakClient({ origin, auth, fetchImpl = fetch, timeoutMs = 10000, env = process.env }) {
  const base = checkOrigin(origin || env.ZCODE_EXECUTOR_OFFPEAK_ORIGIN || DEFAULT_ORIGIN) + API_PREFIX;
  const secrets = [auth.jwt, auth.planKey];
  const scrub = (text) => scrubValues(String(text ?? ''), secrets);

  function fail(step, kind, reason, extra = {}) {
    const notes = [];
    if (extra.serverMsg) notes.push(`服务器：${scrub(extra.serverMsg)}`);
    if (extra.logid) notes.push(`logid ${scrub(extra.logid)}`);
    const suffix = notes.length ? `（${notes.join('，')}）` : '';
    const hint = kind === 'changed' ? `。${DOCTOR_HINT}` : '';
    // 退出码 2：取号失败在 send 里是前置条件不满足（SPEC-offpeak A.2）
    return new ExecutorError(`闲时${STEP_NAMES[step]}失败：${reason}${suffix}${hint}`, 2, {
      kind,
      step,
      bizCode: extra.bizCode,
      httpStatus: extra.httpStatus,
      logid: extra.logid === undefined ? undefined : scrub(extra.logid),
      ...(extra.nextTakeAt !== undefined ? { nextTakeAt: extra.nextTakeAt } : {}),
    });
  }

  /** 发一个请求，返回 code 为 0 时的 data；其余情况按分类规则抛 ExecutorError。 */
  async function request(step, method, route, body) {
    const headers = { authorization: `Bearer ${auth.jwt}`, 'x-coding-plan-api-key': auth.planKey };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    let text;
    try {
      res = await fetchImpl(base + route, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // 不跟随重定向：跨源跟随会把 x-coding-plan-api-key 带到别的主机（评审实测）
        redirect: 'manual',
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const reason = controller.signal.aborted
        ? `请求超时（${timeoutMs} 毫秒）`
        : `连不上闲时服务（${scrub(err?.cause?.message ?? err?.message)}）`;
      throw fail(step, 'unavailable', `${reason}，稍后重试`);
    } finally {
      clearTimeout(timer);
    }

    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined; // 不是 JSON：下面按 HTTP 状态或「形状不对」归类
    }
    const envelope = json !== null && typeof json === 'object' && !Array.isArray(json) ? json : {};
    const bizCode = typeof envelope.code === 'number' ? envelope.code : undefined;
    const info = {
      bizCode,
      httpStatus: res.status,
      logid: typeof envelope.logid === 'string' ? envelope.logid : undefined,
      // 只收字符串：对象之类的原话进文案要么是 [object Object]，要么把结构整个倒出来
      serverMsg: [envelope.msg, envelope.message].find((m) => typeof m === 'string'),
    };

    if (res.status >= 300 && res.status < 400) {
      throw fail(step, 'changed', `服务器要求重定向（HTTP ${res.status}），为了不把凭据带到别处，没有跟随`, info);
    }
    // 业务码优先于 HTTP 状态：3103 真机配 429，3101 的 HTTP 状态没见过
    if (bizCode === 3101) throw fail(step, 'not-applicable', '这个账号没有闲时资格（需要 Coding Plan 订阅）', info);
    if (bizCode === 3103) {
      const nextTakeAt = toMs(envelope.data?.next_take_at ?? envelope.next_take_at);
      const when = nextTakeAt === undefined ? '稍后' : `${new Date(nextTakeAt).toLocaleString()} 以后`;
      throw fail(step, 'quota', `闲时额度用完了，${when}可再取`, { ...info, nextTakeAt });
    }
    if (res.status >= 500 || res.status === 429) {
      throw fail(step, 'unavailable', `闲时服务暂时不可用（HTTP ${res.status}），稍后重试`, info);
    }
    if (res.status === 401 || res.status === 403) {
      throw fail(step, 'not-applicable', `鉴权被拒（HTTP ${res.status}）：ZCode 的登录凭据失效了，在 ZCode App 里重新登录`, info);
    }
    if (res.status === 404) throw fail(step, 'changed', '接口不存在（HTTP 404）', info);
    if (json === undefined || bizCode === undefined) throw fail(step, 'changed', `返回的不是约定的 {code, data} 形状，HTTP ${res.status}`, info);
    if (bizCode !== 0) throw fail(step, 'changed', `服务器回了没见过的业务码 ${bizCode}，HTTP ${res.status}`, info);
    if (!res.ok) throw fail(step, 'changed', `业务码是 0 但 HTTP 状态是 ${res.status}`, info);
    return { data: envelope.data, info };
  }

  const shapeError = (step, what, info) => fail(step, 'changed', `返回形状不对：${what}`, info);
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const pollMs = (s) => (typeof s === 'number' ? Math.max(MIN_POLL_MS, s * 1000) : DEFAULT_POLL_MS);
  const optional = (name, v) => (v === undefined || v === null ? {} : { [name]: v });

  return {
    /** GET /ticket/availability → { canTakeNumber, nextTakeAt?（毫秒时间戳） } */
    async availability() {
      const { data, info } = await request('availability', 'GET', '/ticket/availability');
      if (!isObject(data) || typeof data.can_take_number !== 'boolean') {
        throw shapeError('availability', 'data.can_take_number 应是布尔值', info);
      }
      return { canTakeNumber: data.can_take_number, ...optional('nextTakeAt', toMs(data.next_take_at)) };
    },

    /** POST /ticket {task_id} → { ticketId, state, position, nextPollMs, readyDeadline?（毫秒时间戳） } */
    async take(offPeakId) {
      const { data, info } = await request('take', 'POST', '/ticket', { task_id: offPeakId });
      if (!isObject(data) || typeof data.ticket_id !== 'string' || typeof data.state !== 'string') {
        throw shapeError('take', 'data.ticket_id 与 data.state 应是字符串', info);
      }
      return {
        ticketId: data.ticket_id,
        state: data.state,
        position: data.position ?? null,
        nextPollMs: pollMs(data.next_poll_after),
        ...optional('readyDeadline', data.ready_deadline),
      };
    },

    /**
     * POST /ticket/status {ticket_ids} → { nextPollMs, tickets: [{ ticketId, state, position, readyDeadline?, activeDeadline? }] }
     * （两个截止时间都是毫秒时间戳）。一次最多 100 个号，超过是调用方的用法错，抛 ExecutorError（退出码 1）。
     */
    async status(ticketIds) {
      if (ticketIds.length > MAX_STATUS_IDS) {
        throw new ExecutorError(`闲时查排位一次最多 ${MAX_STATUS_IDS} 个号，这次给了 ${ticketIds.length} 个：分批查`, 1, { step: 'status' });
      }
      const { data, info } = await request('status', 'POST', '/ticket/status', { ticket_ids: ticketIds });
      const list = data?.tickets;
      if (!isObject(data) || !Array.isArray(list) || !list.every((t) => isObject(t) && typeof t.ticket_id === 'string' && typeof t.state === 'string')) {
        throw shapeError('status', 'data.tickets 应是 {ticket_id, state} 的数组', info);
      }
      return {
        nextPollMs: pollMs(data.next_poll_after),
        tickets: list.map((t) => ({
          ticketId: t.ticket_id,
          state: t.state,
          position: t.position ?? null,
          ...optional('readyDeadline', t.ready_deadline),
          ...optional('activeDeadline', t.active_deadline),
        })),
      };
    },

    /** POST /ticket/<id>/settle → { state, settledAt?（毫秒时间戳） } */
    async settle(ticketId) {
      const { data, info } = await request('settle', 'POST', `/ticket/${encodeURIComponent(ticketId)}/settle`);
      if (!isObject(data) || typeof data.state !== 'string') throw shapeError('settle', 'data.state 应是字符串', info);
      return { state: data.state, ...optional('settledAt', data.settled_at) };
    },
  };
}
