// lib/cli/deny.mjs —— deny 子命令（外壳层）：拒绝当前挂起（审批或提问都可）。
// 只写 answer.json（带 requestId），消费与回合推进在 runner。不 import 协议层。
import { ExecutorError } from '../errors.mjs';
import { loadConfig, writeJsonAtomic } from '../config.mjs';
import { parseFlags, requirePending, waitAnswerOutcome } from './common.mjs';

export async function run(argv) {
  const flags = parseFlags(argv, { boolean: ['--json'] });
  const id = flags.positional[0];
  const { json } = flags;
  if (id === undefined) throw new ExecutorError('缺会话 id。用法：deny <id> [--json]', 1);

  const config = loadConfig();
  const { pendingPath, answerPath, pending, pendingKind, entry } = requirePending(config, id);
  const requestId = pending.requestId;
  // 审批答 deny；提问写 decline 标记，runner 回 {action:'decline', reason:'人工拒答'}
  // （decline 应答形状出处：verified.md「审批」）
  const answer = pendingKind === 'question' ? { requestId, decline: true } : { requestId, decision: 'deny' };
  writeJsonAtomic(answerPath, answer);
  const { applied, event } = await waitAnswerOutcome({ config, id, requestId, pendingPath });

  if (json) {
    // id 本地 id、sessionId 登记簿里 zcode 的 sess_（可 null），与 list/status 一致（T2.6b 第 1 条）
    console.log(JSON.stringify({ id, sessionId: entry.sessionId ?? null, requestId, kind: 'deny', applied, pendingKind, eventType: event?.type ?? null }));
    return;
  }
  if (applied) console.log('deny: 已拒绝，回合继续');
  else console.log('deny: 已写应答，还没看到 runner 记事件');
}
