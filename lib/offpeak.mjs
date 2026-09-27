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
const MAX_STATUS_IDS = 100; // App 客户端同样截到 100（batchStatus）
const DOCTOR_HINT = '闲时接口可能变了，跑 zcode-executor doctor --offpeak 确认';

/** 面向人的步骤名；details.step 用英文方法名。 */
const STEP_NAMES = { availability: '查资格', take: '取号', status: '查排位', settle: '结算' };

/**
 * 建一个闲时服务器客户端。
 * @param {object} options
 * @param {string} [options.origin] 缺省取 env.ZCODE_EXECUTOR_OFFPEAK_ORIGIN，再缺省 https://zcode.z.ai
 * @param {{jwt: string, planKey: string}} options.auth readOffPeakAuth 的结果
 * @param {typeof fetch} [options.fetchImpl]
 * @param {number} [options.timeoutMs=10000] 每个请求的超时
 * @param {object} [options.env]
 */
export function createOffPeakClient({ origin, auth, fetchImpl = fetch, timeoutMs = 10000, env = process.env }) {
  const base = (origin || env.ZCODE_EXECUTOR_OFFPEAK_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '') + API_PREFIX;
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
      serverMsg: envelope.msg ?? envelope.message,
    };

    // 业务码优先于 HTTP 状态：3103 真机配 429，3101 的 HTTP 状态没见过
    if (bizCode === 3101) throw fail(step, 'not-applicable', '这个账号没有闲时资格（需要 Coding Plan 订阅）', info);
    if (bizCode === 3103) {
      const at = envelope.data?.next_take_at ?? envelope.next_take_at;
      const nextTakeAt = typeof at === 'number' ? at : undefined;
      const when = nextTakeAt === undefined ? '稍后' : `${new Date(nextTakeAt).toLocaleString()} 以后`;
      throw fail(step, 'quota', `闲时额度用完了，${when}可再取`, { ...info, nextTakeAt });
    }
    if (res.status >= 500) throw fail(step, 'unavailable', `闲时服务暂时不可用（HTTP ${res.status}），稍后重试`, info);
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
  const pollMs = (s) => (typeof s === 'number' && s >= 0 ? s * 1000 : DEFAULT_POLL_MS);
  const optional = (name, v) => (v === undefined || v === null ? {} : { [name]: v });

  return {
    /** GET /ticket/availability → { canTakeNumber, nextTakeAt? } */
    async availability() {
      const { data, info } = await request('availability', 'GET', '/ticket/availability');
      if (!isObject(data) || typeof data.can_take_number !== 'boolean') {
        throw shapeError('availability', 'data.can_take_number 应是布尔值', info);
      }
      return { canTakeNumber: data.can_take_number, ...optional('nextTakeAt', data.next_take_at) };
    },

    /** POST /ticket {task_id} → { ticketId, state, position, nextPollMs, readyDeadline? } */
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

    /** POST /ticket/status {ticket_ids}（最多 100 个）→ { nextPollMs, tickets: [...] } */
    async status(ticketIds) {
      const { data, info } = await request('status', 'POST', '/ticket/status', { ticket_ids: ticketIds.slice(0, MAX_STATUS_IDS) });
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

    /** POST /ticket/<id>/settle → { state, settledAt? } */
    async settle(ticketId) {
      const { data, info } = await request('settle', 'POST', `/ticket/${encodeURIComponent(ticketId)}/settle`);
      if (!isObject(data) || typeof data.state !== 'string') throw shapeError('settle', 'data.state 应是字符串', info);
      return { state: data.state, ...optional('settledAt', data.settled_at) };
    },
  };
}
