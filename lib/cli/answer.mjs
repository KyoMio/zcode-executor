// lib/cli/answer.mjs —— answer 子命令（外壳层）：应答当前挂起的提问。
// 值的匹配与校验直接调 lib/pending.mjs 的 questionResponse——runner 消费 answer.json 时
// 走的就是同一份规则（gate.answer → questionResponse），外壳直接复用它保证两侧判定
// 永远一致，而不是抄一份正则。校验通过才写 answer.json（带 requestId）。不 import 协议层。
import { ExecutorError } from '../errors.mjs';
import { loadConfig, writeJsonAtomic } from '../config.mjs';
import { questionResponse } from '../pending.mjs';
import { parseFlags, requirePending, waitAnswerOutcome } from './common.mjs';

export async function run(argv) {
  // `--` 分隔（评审 T2.5b 第 8 条）：让以 -- 开头的自由文本值能传进来。
  // 第一个 `--` 之前按旗标解析，之后全部是值
  const sep = argv.indexOf('--');
  const flagPart = sep === -1 ? argv : argv.slice(0, sep);
  const valuePart = sep === -1 ? [] : argv.slice(sep + 1);
  const flags = parseFlags(flagPart, { boolean: ['--json'] });
  const id = flags.positional[0];
  const { json } = flags;
  if (id === undefined) throw new ExecutorError('缺会话 id。用法：answer <id> <值…> [--json]', 1);

  const config = loadConfig();
  const { pendingPath, answerPath, pending, pendingKind, entry } = requirePending(config, id);
  if (pendingKind !== 'question') {
    throw new ExecutorError('当前挂起是审批，用 approve 放行或 deny 拒绝', 2);
  }
  const questions = pending.questions ?? [];
  const raw = [...flags.positional.slice(1), ...valuePart];
  if (raw.length !== questions.length) {
    const wanted = questions
      .map((q, i) => {
        const multi = q.multiSelect ? '（多选逗号分隔）' : '';
        const options = (q.options ?? []).map((o) => o.label ?? o.value).join('、');
        return `第 ${i + 1} 题「${q.question ?? ''}」${multi}${options ? `：可选 ${options}` : '（自由文本）'}`;
      })
      .join('；');
    throw new ExecutorError(`共 ${questions.length} 个问题，收到 ${raw.length} 个值。${wanted}`, 2);
  }
  // 权宜：多选题只能在一个参数里用逗号分隔，值本身含逗号会被误拆；要精确就改用重复参数
  const values = questions.map((q, i) => {
    const v = raw[i];
    if (q.multiSelect && String(v).includes(',')) return String(v).split(',').map((x) => x.trim()).filter(Boolean);
    return v;
  });

  // 先本地校验（与 runner 的 gate.answer 同一规则）：对不上退 2 并列出可选项，不写 answer.json
  try {
    questionResponse(pending, values);
  } catch (err) {
    throw new ExecutorError(err?.message ?? String(err), 2);
  }

  const requestId = pending.requestId;
  writeJsonAtomic(answerPath, { requestId, values });
  const { applied, event } = await waitAnswerOutcome({ config, id, requestId, pendingPath });

  if (json) {
    // id 本地 id、sessionId 登记簿里 zcode 的 sess_（可 null），与 list/status 一致（T2.6b 第 1 条）
    console.log(JSON.stringify({ id, sessionId: entry.sessionId ?? null, requestId, kind: 'answer', applied, pendingKind, eventType: event?.type ?? null }));
    return;
  }
  if (applied) console.log('answer: 已应答，回合继续');
  else console.log('answer: 已写应答，还没看到 runner 记事件');
}
