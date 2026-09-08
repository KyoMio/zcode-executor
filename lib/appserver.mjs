// 本文件负责：zcode app-server 的 JSON-RPC 客户端——拉起子进程、按 id 配对请求、
// 反向请求去重与自动应答、通知转发、子进程收场；另有 zcode 二进制的定位与版本探查
// （findZcode / zcodeVersion）和 doctor、models 用的「推表 + readState」最小编排（readModelState）。
// 不负责：会话生命周期（session/create 等的调用时机），那是 lib/session.mjs 和上层的事；
// 也不负责日志落盘。被工作流层调用，只依赖 lib/errors.mjs 和 lib/scrub.mjs（T0.3b 复核 B）。
// 协议事实见 docs/reference/zcode-app-server-protocol.md 与 docs/verified.md（2026-09-07）。
//
// 来源：部分逻辑移植自 zcode-acp-server 0.17.1（Apache-2.0，William Wang，
// https://github.com/william0wang/zcode-acp），见 NOTICE：
//   dist/backend/client.js —— 子进程拉起、读循环分流、请求配对、stdin 错误兜底
//   dist/backend/resolve.js —— zcode.cjs 位置解析
//   dist/handlers/server-requests.js —— 反向请求按 requestId 去重
// 改动处在行内标「改：」。
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';
import { scrubValues } from './scrub.mjs';

// verified.md「直连探针实测」2026-09-07：这个反向请求在 create 成功之后才到，params 带
// sessionId 和 scope:"runtime-materialization"，是会话物化的一步；不能等它，也不该等它。
// 内置默认应答保留（zcode-acp 对它回这三个 false，client.js 同款）。
const RUNTIME_PREFERENCES_METHOD = 'session/requestRuntimePreferences';
const DEFAULT_RUNTIME_PREFERENCES = Object.freeze({
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: false,
});

// 改：只留 macOS 的两处候选路径（本机真机是 macOS）；跨平台需求出现时再从
// zcode-acp resolve.js 的 bundledZcodeCandidates() 补全 Windows/Linux 路径。
function zcodeCandidates() {
  return [
    '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    path.join(os.homedir(), 'Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
  ];
}

/**
 * 返回 zcode.cjs 绝对路径：先看 ZCODE_BIN，再看 ZCode App 资源目录；找不到抛 ExecutorError。
 * zcodeBin 可显式传入（测试用，免改全局环境变量，T2.7 第 2 条）；缺省读环境变量。
 */
export function findZcode({ zcodeBin = process.env.ZCODE_BIN } = {}) {
  if (zcodeBin) {
    const resolved = path.resolve(zcodeBin);
    if (!existsSync(resolved)) {
      throw new ExecutorError(
        `ZCODE_BIN 指向的文件不存在：${resolved}。改成 zcode.cjs 的绝对路径，或删掉这个环境变量改用默认位置`,
      );
    }
    return resolved;
  }
  for (const candidate of zcodeCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new ExecutorError(
    '找不到 zcode.cjs：默认位置没有 ZCode App。设环境变量 ZCODE_BIN 指向 zcode.cjs 绝对路径',
  );
}

/**
 * 跑 `node zcode.cjs --version` 返回版本字符串。环境与 spawn 相同（NO_COLOR、
 * ELECTRON_RUN_AS_NODE、无 ZCODE_MODEL，verified.md 2026-09-07）；带超时（RULES §3）。
 * 拉不起、超时、非零退出、空输出都抛 ExecutorError。
 */
export function zcodeVersion(zcodePath = findZcode(), { timeoutMs = 15_000 } = {}) {
  const env = { ...process.env, NO_COLOR: '1', ELECTRON_RUN_AS_NODE: '1' };
  delete env.ZCODE_MODEL;
  try {
    const out = execFileSync(process.execPath, [zcodePath, '--version'], {
      env,
      timeout: timeoutMs,
      encoding: 'utf8',
    });
    const version = String(out).trim();
    if (!version) throw new Error('--version 没有输出');
    return version;
  } catch (err) {
    // 评审 T2.1b 第 8 条：子进程 stderr 截 500 字进 details，排障不用再去翻日志
    const stderr = String(err?.stderr ?? '').slice(0, 500);
    throw new ExecutorError(
      `跑 zcode --version 失败（${zcodePath}）：${err.message}。确认该文件是 zcode.cjs 且能用 node 直接执行`,
      { zcode: zcodePath, stderr: stderr || null },
    );
  }
}

/**
 * doctor / models 的最小编排：spawn → 推 provider 表 → workspace/readState → 收场，
 * 返回 readState 的 result。不 create、不 send（零 token）；cwd 只当子进程与 workspace 路径，
 * 探针实测普通目录即可（verified.md「直连探针实测」）。
 */
export async function readModelState({ registry, cwd = os.tmpdir(), timeoutMs = 20_000, zcodePath, env } = {}) {
  // 评审 T2.1b 第 2 条：协议层不定退出码（RULES §1、errors 第 7 条），退出码归外壳层定
  if (!registry?.providers?.length) {
    throw new ExecutorError('provider 表是空的，没法推给 app-server。确认 ~/.zcode/v2/config.json 里有启用的 provider');
  }
  const secrets = registry.providers.map((p) => p.apiKey?.value).filter(Boolean);
  const workspace = { workspacePath: cwd, workspaceKey: cwd };
  const client = await AppServerClient.spawn({ cwd, secrets, zcodePath, env });
  try {
    await client.request('workspace/updateProviderRegistry', { workspace, registry }, { timeoutMs });
    return await client.request('workspace/readState', { workspace }, { timeoutMs });
  } finally {
    await client.close({ timeoutMs: 5000 });
  }
}

/**
 * 按信封里 id / method 的有无给消息分类（纯函数，不碰进程）：
 * id+method 反向请求；id 无 method 响应；method 无 id 通知；都不是 invalid。
 */
export function classify(msg) {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return 'invalid';
  const hasId = msg.id !== undefined;
  const hasMethod = msg.method !== undefined;
  if (hasId && hasMethod) return 'request';
  if (hasId) return 'response';
  if (hasMethod) return 'notification';
  return 'invalid';
}

/**
 * 一个客户端管一个 app-server 子进程。
 * - request() 返回的 Promise 按 id 配对；对端 error、超时、子进程退出都 reject ExecutorError，
 *   details 里带 error.data（JSON-RPC 错误的有用信息在 data.details）。
 * - 反向请求交给 onServerRequest：同一 params.requestId 只回调一次（verified.md「app-server 协议」
 *   表「反向请求」一行：未答的反向请求每秒重发一次，同一 requestId、信封 id 每次不同；
 *   经 zcode-acp 0.17.1 实测并对照其 server-requests.js），出结果后对记录过的每个信封 id
 *   都应答，之后再来重发用缓存应答；回调抛错则对所有 id 回 respondError。
 * - session/requestRuntimePreferences 没被处理器接住时，回内置默认值。
 */
export class AppServerClient {
  #proc;
  #opts;
  #pending = new Map();
  // 去重键 → {ids: 信封 id 列表, settled, result, error}。重发换信封 id 也要应答（评审第 2 条）。
  #serverRequests = new Map();
  // 改：请求 id 从一百万起步，避开 app-server 反向请求的低段 id，防止两边 id 撞车被误判成响应。
  #nextId = 1_000_000;
  #requestTimeoutMs;
  #exitInfo = null;
  #exitedPromise;
  #exitedResolve;
  #closeStarted = false;

  /**
   * @param {object} opts
   * @param {string} [opts.zcodePath] zcode.cjs 绝对路径；缺省走 findZcode()
   * @param {string} opts.cwd 子进程与 workspace 的 cwd
   * @param {number} [opts.requestTimeoutMs] request() 的默认超时，30000
   * @param {object} [opts.env] 追加进子进程环境（与 process.env 合并，同名覆盖）；
   *   无论何时都加 NO_COLOR=1、ELECTRON_RUN_AS_NODE=1、删 ZCODE_MODEL（T0.3c 第 5 条，并发 mock 的前提）
   * @param {string[]} [opts.secrets] 要从本进程 stderr 转发里抹掉的密钥值（如 registry 里的 apiKey）
   * @param {(req: {id, method, params}) => (object|Promise<object>|undefined)} [opts.onServerRequest]
   * @param {(n: {method, params}) => void} [opts.onNotification] 每条通知都调，不过滤
   * @param {(line: string) => void} [opts.onStderr] 子进程 stderr 与异常 stdout 行；缺省写本进程 stderr
   */
  static async spawn(opts = {}) {
    const {
      zcodePath,
      cwd,
      requestTimeoutMs = 30_000,
      env: extraEnv,
      secrets = [],
      onServerRequest,
      onNotification,
      onStderr,
    } = opts;
    const zcode = zcodePath ?? findZcode();
    // verified.md 2026-09-07：NO_COLOR=1、ELECTRON_RUN_AS_NODE=1，删掉 ZCODE_MODEL（coder-mcp-bridge 同款）
    const env = { ...process.env, ...extraEnv, NO_COLOR: '1', ELECTRON_RUN_AS_NODE: '1' };
    delete env.ZCODE_MODEL;
    const proc = spawn(process.execPath, [zcode, 'app-server', '--stdio'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // 自成进程组，收场超时可整组 SIGKILL，不留 zcode 的孤儿子进程（搬自 client.js）
    });
    const client = new AppServerClient(proc, { requestTimeoutMs, secrets, onServerRequest, onNotification, onStderr });
    // spawn 失败（execPath 拉不起来）走异步 'error' 事件，不会同步抛
    const spawned = once(proc, 'spawn');
    const failed = once(proc, 'error').then(([err]) => {
      throw err;
    });
    failed.catch(() => {}); // 落选分支的 rejection 不许变成 unhandled
    try {
      await Promise.race([spawned, failed]);
    } catch (err) {
      throw new ExecutorError(
        `拉起 zcode app-server 失败：${err.message}。确认 ZCode App 已安装，或设 ZCODE_BIN 指向 zcode.cjs`,
        { zcode },
      );
    }
    return client;
    // 权宜：就绪判定只等 spawn/'error' 事件。zcodePath 指向坏文件时进程会秒退，
    // 要等第一个 request 才报错；探针稳定后若真机出现挂死，再升级成就绪握手。
  }

  constructor(proc, opts) {
    this.#proc = proc;
    this.#opts = opts;
    this.#requestTimeoutMs = opts.requestTimeoutMs;
    this.#exitedPromise = new Promise((resolve) => {
      this.#exitedResolve = resolve;
    });
    createInterface({ input: proc.stdout }).on('line', (line) => this.#onLine(line));
    createInterface({ input: proc.stderr }).on('line', (line) => this.#note(`zcode: ${line}`));
    // stdin 写入失败（EPIPE）是异步 'error' 事件，不接住会崩掉本进程（搬自 client.js）
    proc.stdin?.on('error', (err) => this.#note(`appserver: stdin 写入失败：${err.message}`));
    proc.on('error', (err) => this.#settleExit(null, null, err));
    proc.on('exit', (code, signal) => this.#settleExit(code, signal, null));
  }

  /** Promise<{code, signal}>：子进程退出时兑现。 */
  get exited() {
    return this.#exitedPromise;
  }

  get pid() {
    return this.#proc.pid;
  }

  /**
   * 整体替换 spawn 时给的反向请求 / 通知处理器（attachSession 接管路由用）；
   * 没传的字段置为 undefined。去重、缓存应答等机制不受影响，换的只是回调。
   */
  setHandlers(handlers = {}) {
    this.#opts.onServerRequest = handlers.onServerRequest;
    this.#opts.onNotification = handlers.onNotification;
  }

  /**
   * 发请求并等 result。timeoutMs 缺省用 spawn 时的 requestTimeoutMs。
   * @returns {Promise<object>}
   */
  request(method, params, { timeoutMs } = {}) {
    if (this.#exitInfo) return Promise.reject(this.#deadError(method));
    const limit = timeoutMs ?? this.#requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      // 先发后登记：响应只可能在之后的事件循环里到，不会漏配对
      if (!this.#send({ id, method, params: params ?? {} })) {
        reject(new ExecutorError(`连接已关闭，请求 ${method} 没送出去。子进程可能正在收场，重新拉起再试`, { method }));
        return;
      }
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new ExecutorError(
            `等待 ${method} 结果超时（${limit}ms）。zcode 可能挂死了：重试，或查 ~/.zcode/cli/log/ 的日志`,
            { method, timeoutMs: limit },
          ),
        );
      }, limit);
      this.#pending.set(id, { resolve, reject, timer, method });
    });
  }

  /** 发通知（无 id，无响应）。 */
  notify(method, params) {
    this.#send({ method, params: params ?? {} });
  }

  /** 应答反向请求。 */
  respond(id, result) {
    this.#send({ id, result });
  }

  /** 以错误应答反向请求。 */
  respondError(id, { code, message }) {
    this.#send({ id, error: { code, message } });
  }

  /**
   * 收场：stdin EOF 让 app-server 自己退（verified.md 2026-09-07：EOF 后退出码 0）；
   * 超时对进程组 SIGKILL。返回 {code, signal}。
   */
  async close({ timeoutMs = 5000 } = {}) {
    if (this.#exitInfo) return this.#exitInfo;
    if (!this.#closeStarted) {
      this.#closeStarted = true;
      try {
        this.#proc.stdin.end();
      } catch {
        // stdin 已经没了，收场目标不变
      }
    }
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const info = await Promise.race([this.#exitedPromise, timeout]);
    clearTimeout(timer); // 评审第 1 条：不等烧完定时器，拿到结果立刻撤
    if (info) return info;
    this.#note('appserver: 收场超时，对进程组 SIGKILL');
    try {
      process.kill(-this.#proc.pid, 'SIGKILL');
    } catch {
      try {
        this.#proc.kill('SIGKILL');
      } catch {
        // 进程已经退了
      }
      // 权宜：进程组信号仅 POSIX 可用，非 POSIX 退回单进程 kill；真机是 macOS，够用
    }
    return this.#exitedPromise;
  }

  // ---------- 内部 ----------

  #onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return; // 空行无信息，跳过
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      this.#note(`zcode: stdout 出现非 JSON 行，已忽略：${trimmed.slice(0, 200)}`);
      return;
    }
    const kind = classify(msg);
    if (kind === 'response') this.#resolvePending(msg);
    else if (kind === 'request') this.#onServerRequest(msg);
    else if (kind === 'notification') this.#opts.onNotification?.({ method: msg.method, params: msg.params });
    else this.#note(`zcode: 出现无法分类的消息，已忽略：${trimmed.slice(0, 200)}`);
  }

  #onServerRequest(msg) {
    const params = msg.params ?? {};
    // verified.md「app-server 协议」表「反向请求」一行（经 zcode-acp 实测 + 其 server-requests.js）：
    // 未答的反向请求每秒重发一次，同一 requestId、信封 id 每次不同
    // 改（T0.3b 复核 D）：没有 requestId 时的退路键不用信封 id——那会把每次重发都当新请求、
    // 处理器反复跑。没有 requestId 的反向请求只见过 requestRuntimePreferences（秒回），
    // 按「方法|会话」聚合足够；真冒出别的无 requestId 方法，自然会落进同一键一起等。
    const dedupKey = params.requestId !== undefined ? params.requestId : `${msg.method}|${params.sessionId ?? ''}`;
    let entry = this.#serverRequests.get(dedupKey);
    if (entry) {
      if (entry.settled) {
        this.#replyEntry(msg.id, entry); // 处理器只跑一次，重发用缓存应答
      } else {
        entry.ids.push(msg.id); // 还没出结果：记下这个信封 id，出结果时一起应答
        // RULES §7 例外（T1.1b 第 12 条）：挂起可能长期无答，信封 id 只保留最近 5 个，
        // 更早的重发不再补答，防长时间挂起里 ids 无界增长
        if (entry.ids.length > 5) entry.ids.shift();
      }
      return;
    }
    entry = { ids: [msg.id], settled: false, result: undefined, error: undefined };
    this.#serverRequests.set(dedupKey, entry);
    // 权宜：去重表不清理。requestId 只增不减，单进程生命期内内存可忽略；真机出现复用 requestId 再加过期。
    void this.#dispatchServerRequest(msg, entry);
  }

  async #dispatchServerRequest(msg, entry) {
    const handler = this.#opts.onServerRequest;
    let answer;
    let thrown = null;
    if (handler) {
      try {
        answer = await handler({ id: msg.id, method: msg.method, params: msg.params ?? {} });
      } catch (err) {
        thrown = err;
      }
    }
    if (thrown !== null) {
      entry.error = { code: -32603, message: `处理反向请求 ${msg.method} 失败：${thrown.message}` };
    } else if (answer !== undefined) {
      entry.result = answer;
    } else if (msg.method === RUNTIME_PREFERENCES_METHOD) {
      entry.result = DEFAULT_RUNTIME_PREFERENCES;
    } else {
      // 改：没被接住的反向请求回错误而不是装没看见——不回话 zcode 每秒重发一次（verified.md 2026-09-07）
      this.#note(`appserver: 没有处理器的反向请求：${msg.method}`);
      entry.error = { code: -32601, message: `no handler for ${msg.method}` };
    }
    entry.settled = true;
    for (const id of entry.ids) this.#replyEntry(id, entry);
  }

  #replyEntry(id, entry) {
    if (entry.error !== undefined) this.respondError(id, entry.error);
    else this.respond(id, entry.result);
  }

  #resolvePending(msg) {
    const entry = this.#pending.get(msg.id);
    if (!entry) return; // 超时后迟到的响应，没人等了，丢弃
    clearTimeout(entry.timer);
    this.#pending.delete(msg.id);
    if (msg.error !== undefined) {
      const e = msg.error;
      entry.reject(
        new ExecutorError(`${entry.method} 被拒绝：${e.message ?? '未知错误'}`, {
          method: entry.method,
          code: e.code,
          data: e.data,
        }),
      );
    } else {
      entry.resolve(msg.result);
    }
  }

  #settleExit(code, signal, spawnErr) {
    if (this.#exitInfo) return;
    this.#exitInfo = { code, signal };
    const reason = spawnErr
      ? `zcode app-server 拉起失败：${spawnErr.message}`
      : `zcode app-server 已退出（code=${code}，signal=${signal ?? 'null'}）`;
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ExecutorError(`${reason}，请求 ${entry.method} 没有等到结果`, { method: entry.method }));
    }
    this.#pending.clear();
    this.#exitedResolve(this.#exitInfo);
  }

  #deadError(method) {
    const { code, signal } = this.#exitInfo;
    return new ExecutorError(`zcode app-server 已不在运行（code=${code}，signal=${signal ?? 'null'}），请求 ${method} 没有送到`, {
      method,
      code,
      signal,
    });
  }

  #send(obj) {
    const stdin = this.#proc.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      this.#note('appserver: stdin 已关闭，消息发不出去');
      return false;
    }
    stdin.write(JSON.stringify(obj) + '\n'); // 写失败的 EPIPE 由 stdin 的 error 监听兜住
    return true;
  }

  #note(line) {
    // 评审第 5 条：stderr 转发可能带出密钥值，先按调用方给的 secrets 抹一遍
    const clean = scrubValues(line, this.#opts.secrets ?? []);
    if (this.#opts.onStderr) this.#opts.onStderr(clean);
    else process.stderr.write(`${clean}\n`);
  }
}
