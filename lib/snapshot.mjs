// lib/snapshot.mjs —— 会话快照（SPEC-watch-pane D，工作流层）：读一条会话的 state/last/pending/
// offpeak 与本回合事件，拼出 watch 要的快照对象；另带本回合事件读取器（首次从文件尾倒找回合起点，
// 之后按字节偏移只读新增，事件文件可达百 MB，不能整读）。纯读，不写任何文件，不碰协议层。
// 不负责：输出格式、轮询、去抖、退出（归外壳层的 watch 子命令文件）；所属仓库 repo 的计算
//（归外壳层 repoOf——本文件不跨层 import 外壳，由调用方算好传进来）。
// 事件形状出处：executor.send 由 lib/run.mjs 落盘，type 恒为第一个键，行首定位只靠它；
// executor.gate / executor.result 写成 { at, ...event }，第一个键是 at；zcode 原样落盘的
// model.streaming 等行第一个键是 deliveryKind——预筛按子串匹配，键序无关。
// tool.updated / model.streaming / permission.requested 的形状按 verified.md 2026-10-02
//（App 3.14.1）；pending.json 的提问题干字段是 question（lib/pending.mjs questionResponse）。
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { phaseFromState, readJsonOrNull, readLast, readState, runsDirOf } from './runs.mjs';
import { readOffPeak } from './offpeak-send.mjs';
import { markdownTail, parseTurn, pendingSummary, turnEvents as afterLastSend } from './tool-summary.mjs';

const BLOCK = 64 * 1024; // 倒找回合起点按块来；增量读用 READ_CHUNK，整文件读进内存吃不消（本机最大 121MB）
const READ_CHUNK = 4 * 1024 * 1024; // 读取器按块循环读：单回合文件可上百 MB，整段进内存峰值还要翻倍
const NL = 0x0a;
const SEND_MARKER = Buffer.from('{"type":"executor.send"', 'utf8'); // 只有 executor.send 保证 type 是第一个键（lib/run.mjs），行首定位才靠得住
// 解析前先按字符串筛（SPEC D）：遥测行占九成以上，含这些串的行才值得 JSON.parse；
// executor 那条不带尾引号，才能罩住 executor.send / gate / result / offpeak.*
const INTERESTING = ['"type":"model.streaming"', '"type":"tool.updated"', '"type":"executor.', '"type":"permission.requested"'];

function peekByte(fd, position) {
  const one = Buffer.alloc(1);
  return readSync(fd, one, 0, 1, position) === 1 ? one[0] : -1;
}

/** 从偏移 s 起的行是否以 send 标记开头；标记跨块边界时把块外缺的字节从文件里读来拼上。 */
function lineMatchesSend(fd, blockStart, buf, s) {
  for (let i = 0; i < SEND_MARKER.length; i++) {
    const pos = s + i;
    if (pos < buf.length) {
      if (buf[pos] !== SEND_MARKER[i]) return false;
      continue;
    }
    const one = Buffer.alloc(1);
    if (readSync(fd, one, 0, 1, blockStart + pos) !== 1 || one[0] !== SEND_MARKER[i]) return false;
  }
  return true;
}

/**
 * 从文件尾往前按 64KB 一块读，找最后一行以 {"type":"executor.send" 开头的行，返回那行的起始
 * 字节偏移（行首 = 文件第一个字节，或前一个字节是换行）；找不到或文件不存在返回 0。
 * 只读不整读：块内按字节找行首，标记跨块边界时拼块外字节判断（lineMatchesSend）。
 */
export function findTurnStart(filePath) {
  let size;
  try {
    size = statSync(filePath).size;
  } catch {
    return 0; // 文件不存在：回合没开始过
  }
  const fd = openSync(filePath, 'r');
  try {
    let blockEnd = size;
    while (blockEnd > 0) {
      const blockStart = Math.max(0, blockEnd - BLOCK);
      const buf = Buffer.alloc(blockEnd - blockStart);
      let filled = 0;
      while (filled < buf.length) {
        const n = readSync(fd, buf, filled, buf.length - filled, blockStart + filled);
        if (n <= 0) break; // 读到文件被截的残尾：就当前能读到的判
        filled += n;
      }
      // 块内从右往左查行首：每个换行之后都是新行；块首本身是行首时看前一个字节
      for (let p = buf.length - 1; p >= 0; p--) {
        if (buf[p] !== NL) continue;
        const s = p + 1;
        if (s < buf.length && lineMatchesSend(fd, blockStart, buf, s)) return blockStart + s;
      }
      const headIsLineStart = blockStart === 0 || peekByte(fd, blockStart - 1) === NL;
      if (headIsLineStart && lineMatchesSend(fd, blockStart, buf, 0)) return blockStart;
      blockEnd = blockStart;
    }
  } finally {
    closeSync(fd);
  }
  return 0; // 没有 send：从文件头读，下游用 W1 的 turnEvents（没有 send 就是空回合）
}

/**
 * 本回合事件读取器（SPEC D「读取与刷新」）：read() 返回 { events, changed }。
 * 首次从 findTurnStart 的偏移读起；之后只读上次偏移之后的新增完整行（半截行留到下次）；
 * 只解析含 INTERESTING 串的行，坏行跳过；读到新的 executor.send 清空重攒（send 本身留在
 * events 开头，下游用 W1 的 turnEvents 取它之后的事件）。events 是当前回合筛过的全部事件，
 * 不是增量；changed 表示这次有没有读到新行。
 */
export function createTurnReader(eventsPath) {
  let offset = null; // null = 还没首读；文件还没建时不设，等文件出现再做倒找
  let events = [];
  const absorb = (text) => {
    for (const line of text.split('\n')) {
      if (!INTERESTING.some((m) => line.includes(m))) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // 坏行跳过，不拖垮整段
      }
      if (ev?.type === 'executor.send') {
        events = [ev]; // 新回合：清空重来，send 留在开头
      } else {
        events.push(ev);
      }
    }
  };
  return {
    read() {
      let size;
      try {
        size = statSync(eventsPath).size;
      } catch {
        return { events, changed: false }; // 文件不在（回合没开始或会话已删）：手里攒的保持原样
      }
      if (offset !== null && size < offset) {
        offset = null; // 文件被整个换短过：重新倒找回合起点
        events = []; // 旧文件攒的事件一并清掉，快照不能出现已不存在的事件
      }
      if (offset === null) offset = findTurnStart(eventsPath);
      if (size <= offset) return { events, changed: false }; // 没长出增量
      const fd = openSync(eventsPath, 'r');
      let sawLine = false;
      try {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK, size - offset));
        let pos = offset;
        let carry = null; // 上一块带来的半截行，接到下一块
        for (;;) {
          const want = Math.min(chunk.length, size - pos);
          let filled = 0;
          while (filled < want) {
            const n = readSync(fd, chunk, filled, want - filled, pos + filled);
            if (n <= 0) break;
            filled += n;
          }
          if (filled <= 0) break;
          const buf = carry ? Buffer.concat([carry, chunk.subarray(0, filled)]) : chunk.subarray(0, filled);
          const cut = buf.lastIndexOf(NL);
          if (cut === -1) {
            carry = Buffer.from(buf);
          } else {
            absorb(buf.toString('utf8', 0, cut));
            carry = cut + 1 < buf.length ? Buffer.from(buf.subarray(cut + 1)) : null;
            sawLine = true;
          }
          pos += filled;
          if (pos >= size) break;
        }
        offset = pos - (carry?.length ?? 0); // 半截行不算读到：偏移停在它开头，留到下次
      } finally {
        closeSync(fd);
      }
      return { events, changed: sawLine };
    },
  };
}

/** 任务单路径在 cwd 下给相对路径，不在（或 cwd 未知）原样；非字符串与空串按没有。 */
function pathInCwd(cwd, filePath) {
  if (typeof filePath !== 'string' || filePath === '') return null;
  if (!cwd) return filePath;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  const rel = path.relative(cwd, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
  return rel;
}

/** since 的取法（SPEC D 回退表）。taken/retaken 从调用方给的原始事件数组里找（排号阶段它们写在 send 之前）。 */
function sinceOf({ phase, state, last, pending, offpeakQueue, turnEvents }) {
  if (phase === 'pending') return pending?.at ?? null;
  if (phase === 'running') {
    if (offpeakQueue) {
      const taken = [...(turnEvents ?? [])]
        .reverse()
        .find((e) => e?.type === 'executor.offpeak.taken' || e?.type === 'executor.offpeak.retaken');
      return taken?.at ?? state?.startedAt ?? null;
    }
    return state?.current?.startedAt ?? state?.startedAt ?? null;
  }
  if (phase === 'stale') return state?.updatedAt ?? null;
  if (phase === 'exited' || phase === 'idle') {
    // last.endedAt 不早于 state.startedAt 才用（上一回合的结算不该盖住这一回合的开始）
    if (last?.endedAt && (!state?.startedAt || last.endedAt >= state.startedAt)) return last.endedAt;
    return state?.updatedAt ?? null;
  }
  return null;
}

/**
 * 拼一条会话的快照（SPEC D 快照字段表）。entry 是登记簿条目；repo 是调用方算好的所属仓库；
 * turnEvents 是读取器给的事件数组，null 表示这个会话没有读取器（watch 启动时已结束）。
 * state / last 可选：调用方在读事件之前读好传进来（null 也算给了），不给才在这里读。runner 结束
 * 回合按「回合事件都已追加 → 写 last.json → 改 state」的顺序（lib/run.mjs 回合收尾处），先读这两份再读事件，事件只会比它们新，
 * 不会出现「已结束 + 旧回复」的快照。
 * 任何一个文件坏了不让整条快照失败：该字段按「没有」处理（JSON 读取全走容错读）。
 */
export function snapshotOf({ home, entry, repo, turnEvents, state = readState(home, entry?.id), last = readLast(home, entry?.id) }) {
  const id = entry?.id;
  const cwd = String(entry?.cwd ?? '');
  const phase = phaseFromState(home, id, state);
  const pending = readJsonOrNull(path.join(runsDirOf(home, id), 'pending.json'));
  const op = readOffPeak(home, id);
  const offpeakQueue =
    op?.phase === 'queued' || op?.phase === 'ready' ? { phase: op.phase, position: op.position ?? null } : null;
  const slice = afterLastSend(turnEvents ?? []); // events 开头可能带 send 本身，解析认它之后的
  const { calls, reply: turnReply, replyMarkdown: turnReplyMarkdown } = parseTurn(slice, { cwd });

  const running = calls.filter((c) => c.state === 'running');
  const lastRunning = running[running.length - 1];
  // 回合被打断时调用会停在 running，所以 activeTool 只在真跑着的阶段给
  const activeTool = phase === 'running' && lastRunning ? { toolName: lastRunning.toolName, summary: lastRunning.summary } : null;
  const recentTools = calls
    .filter((c) => c.state === 'done')
    .slice(-5)
    .map((c) => ({ toolName: c.toolName, summary: c.summary, ok: c.ok }));

  let pendingDetail = null;
  if (pending?.kind === 'permission') {
    pendingDetail = {
      kind: 'permission',
      toolName: pending.toolName ?? null,
      summary: pendingSummary(pending.toolName, pending.input, cwd),
      reason: pending.reason ?? null,
    };
  } else if (pending?.kind === 'question') {
    const questions = Array.isArray(pending.questions) ? pending.questions : [];
    pendingDetail = { kind: 'question', questionTexts: questions.map((q) => q?.question ?? null) };
  }

  // 没给读取器（watch 启动时已结束）：回复从 last.json 恢复。lastMessageText（最终回复原文，
  // 新字段）优先——lastText 是整回合拼接（中途 + 最终回复无分隔连在一起），面板要的是「最新一条
  // 消息」；旧 last.json 没这字段时回退 lastText，行为与原来一致。多条消息首尾连着，恢复不出
  // 分行，整段算一行。
  const lastText = typeof last?.lastText === 'string' ? last.lastText.trim() : '';
  const lastMessage = typeof last?.lastMessageText === 'string' ? last.lastMessageText.trim() : '';
  const endedReply = lastMessage || lastText;
  const reply = turnEvents != null ? turnReply : endedReply ? [endedReply.slice(-800)] : [];
  // replyMarkdown 走同一分支（SPEC D 快照表）：没有读取器时同样优先最终回复原文
  const replyMarkdown = turnEvents != null ? turnReplyMarkdown : markdownTail(endedReply);

  // 有当前投递只认 current.task（纯文字投递没有任务单，null 就是 null，不回退上一回合的）；
  // 没有当前投递才取 last.task
  const taskSource = state?.current ? state.current.task : last?.task;

  return {
    id,
    sessionId: entry?.sessionId ?? null,
    title: String(entry?.title ?? ''),
    cwd,
    lastOutcome: entry?.lastOutcome ?? null,
    repo,
    phase,
    task: pathInCwd(cwd, taskSource ?? null),
    since: sinceOf({ phase, state, last, pending, offpeakQueue, turnEvents }),
    lastEndOutcome: last?.outcome ?? null, // 「回合结束」提示用它：runner 先写 last.json 后改登记簿的 lastOutcome，登记簿那个会慢一拍
    lastEndedAt: last?.endedAt ?? null,
    reply,
    replyMarkdown,
    activeTool,
    recentTools,
    pendingDetail,
    offpeakQueue,
  };
}
