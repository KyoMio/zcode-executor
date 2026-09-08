// 本文件负责：把审批请求（interaction/requestPermission）和提问（interaction/requestUserInput）
// 变成落盘的挂起（pending.json，形状照 SPEC「闸门」），并提供把人工决定转成 zcode 应答的函数。
// 不负责：闸门的红线与模型审批段（T1.3+）、pending.json 之外的落盘、退出码表。
// 被依赖方：scripts/real-send.mjs、后续 runner/闸门。只依赖 lib/errors.mjs。
//
// 安全边界（RULES §8）：应答只有 allow / deny / accept 文字答案；deny 的 reason 写死
// 「人工拒绝」，这里不存在把别的决定透传给 zcode 的口子。挂起期间连接保持不答（回合停在原地）。
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';

/** 纯读：pendingPath 里的挂起；没有返回 null。 */
export function readPending(pendingPath) {
  try {
    return JSON.parse(readFileSync(pendingPath, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * options 单项的 kind 分两类（真机 2026-09-07 检查点 1 的形状，任务单 T1.3）：
 * allow 类只认 allow_once——allow_always 是「一直允许」，RULES §8 不实现，认了它就开了口子；
 * deny 类认 deny 和 deny_once——真机把拒绝项 kind 记成 deny，协议文档与旧形状是 deny_once。
 * 其余 kind（含缺省）两类都不是。
 */
export function optionClass(option) {
  if (option?.kind === 'allow_once') return 'allow';
  if (option?.kind === 'deny' || option?.kind === 'deny_once') return 'deny';
  return undefined;
}

/** options 里真有 allow 类（allow_once）选项吗（RULES §8 的「可放行」前提）。 */
export function hasAllowOnce(pending) {
  return (pending?.options ?? []).some((o) => optionClass(o) === 'allow');
}

/** 纯函数：'allow' → {decision:'allow'}；'deny' → {decision:'deny', reason:'人工拒绝'}；其它抛错。 */
export function permissionResponse(pending, decision) {
  if (decision === 'allow') {
    // RULES §8：放行的前提是 options 里真有 allow 类（allow_once）选项，没有就不存在「放行」
    if (!hasAllowOnce(pending)) {
      throw new ExecutorError('该审批的 options 里没有 allow_once，无法放行（RULES §8）');
    }
    return { decision: 'allow' };
  }
  // deny 不设前提：应答 {decision:'deny'} 对端对未识别的 optionId 一律当拒绝（verified.md「审批」），
  // 拒绝必须永远可行
  if (decision === 'deny') return { decision: 'deny', reason: '人工拒绝' };
  throw new ExecutorError(`decision 必须是 'allow' 或 'deny'，收到：${JSON.stringify(decision ?? null)}`);
}

/**
 * 纯函数：values 按顺序对应 pending.questions。每个值按 option.value、option.label、
 * 序号（从 1）匹配；多选题（multiSelect）可给数组，答案用 ', ' 拼接；没有 options 的问题
 * 直接用文字。→ {action:'accept', content:{answers:{[question 原文]: 答案}}}。
 * 值对不上抛 ExecutorError（应答形状出处：verified.md「审批」行）。
 */
export function questionResponse(pending, values) {
  const questions = pending?.questions ?? [];
  if (!Array.isArray(values)) {
    throw new ExecutorError('values 必须是数组，按顺序对应每个问题');
  }
  if (values.length !== questions.length) {
    throw new ExecutorError(`共 ${questions.length} 个问题，给了 ${values.length} 个答案`);
  }
  const answers = {};
  questions.forEach((q, index) => {
    answers[q.question] = answerFor(q, values[index], index);
  });
  return { action: 'accept', content: { answers } };
}

function answerFor(question, given, index) {
  const label = `第 ${index + 1} 题「${question.question ?? ''}」`;
  const options = question.options ?? [];
  const one = (value) => {
    if (value === null || value === undefined || value === '') {
      throw new ExecutorError(`${label}：答案不能为空`);
    }
    const text = String(value);
    if (options.length === 0) return text; // 没有 options 的问题直接用文字
    const byValue = options.find((o) => o.value !== undefined && String(o.value) === text);
    // 权宜：按 label 回答，真机核实 zcode 认 label 还是 value；见 verified.md「审批」
    if (byValue) return byValue.label ?? String(byValue.value);
    const byLabel = options.find((o) => o.label !== undefined && o.label === text);
    if (byLabel) return byLabel.label;
    if (/^\d+$/.test(text)) {
      const byIndex = options[Number(text) - 1];
      if (byIndex) return byIndex.label ?? String(byIndex.value ?? text);
    }
    const choices = options.map((o) => o.label ?? o.value).join('、');
    throw new ExecutorError(`${label}对不上答案「${text}」。可选：${choices}`);
  };
  if (Array.isArray(given)) {
    if (!question.multiSelect) {
      throw new ExecutorError(`${label}不是多选题，答案只能给一个`);
    }
    if (given.length === 0) {
      throw new ExecutorError(`${label}：多选答案不能为空`);
    }
    return given.map(one).join(', ');
  }
  return one(given);
}

/**
 * 造一个挂起闸门。handlers.permission / handlers.question 交给 attachSession；
 * 同一时刻只有一个挂起：第二个反向请求来了先排队，等第一个被 answer 再落盘成为当前挂起。
 * answer(response)：{decision:'allow'|'deny'} 或 {values:[...]}，转成 zcode 应答后 resolve
 * 挂起的 Promise 并删 pendingPath；没有挂起时抛 ExecutorError。
 */
export function createPendingGate({ pendingPath, onPending }) {
  let currentEntry = null; // { pending, resolve }
  let tail = Promise.resolve(); // 排队链：串行化挂起

  function writePending(pending) {
    mkdirSync(path.dirname(pendingPath), { recursive: true });
    const tmp = `${pendingPath}.${process.pid}.tmp`; // RULES §6：先写临时文件再 rename，避免读到半截
    writeFileSync(tmp, JSON.stringify(pending) + '\n');
    renameSync(tmp, pendingPath);
  }

  function removePending() {
    try {
      unlinkSync(pendingPath);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }

  // SPEC「闸门」挂起形状：公共字段 + 按类别的 params 透传。
  // T3.2：闸门判定过的段随 params 进来（stage: hard / review-* / no-allow-option，附 why、
  // ruleId）；没带就保持 T1.2 的默认形状（stage:'pending'、why:'等人'），旧调用方不受影响。
  function buildPending(kind, params) {
    const base = {
      kind,
      requestId: params.requestId,
      at: new Date().toISOString(),
      stage: params.stage ?? 'pending',
      why: params.why ?? '等人',
    };
    if (kind === 'permission') {
      // options 原样落盘（真机每项自带 response，即该选项对应的应答原文）。暂不使用：仍按 decision
      // 统一造应答，模型审批落地时再考虑直接回 options 里的 response
      return {
        ...base,
        ...(params.ruleId !== undefined ? { ruleId: params.ruleId } : {}),
        toolName: params.toolName,
        input: params.input,
        reason: params.reason,
        options: params.options,
      };
    }
    return { ...base, questions: params.questions };
  }

  async function runPending(kind, params) {
    const pending = buildPending(kind, params);
    // 顺序不能变（T1.2b 第 4 条）：先建 Promise 并登记 currentEntry，再写盘、再调 onPending——
    // onPending 里同步 answer() 时 currentEntry 已就位，不会死锁
    let resolveEntry;
    const waitAnswer = new Promise((resolve) => {
      resolveEntry = resolve;
      currentEntry = { pending, resolve: resolveEntry };
    });
    writePending(pending);
    onPending?.(pending);
    const answer = await waitAnswer;
    removePending(); // 删 pending 只留这一处：answer 只 resolve，文件统一在这里清
    return answer;
  }

  function enqueue(kind, params) {
    const p = tail.then(() => runPending(kind, params));
    tail = p.catch(() => {}); // 前一个挂起被拒绝不能毒死排队的后面那个
    return p;
  }

  const handlers = {
    permission: (params) => enqueue('permission', params),
    question: (params) => enqueue('question', params),
  };

  function answer(response) {
    if (!currentEntry) {
      throw new ExecutorError('当前没有挂起的审批或提问，answer() 无处可去');
    }
    const { pending, resolve } = currentEntry;
    let zcodeAnswer;
    if (pending.kind === 'permission') {
      zcodeAnswer = permissionResponse(pending, response?.decision);
    } else if (response?.action === 'decline') {
      // 拒答（cancel 用，T2.4）：形状照 verified.md「审批」行的 {action:"decline", reason}
      zcodeAnswer = { action: 'decline', reason: typeof response.reason === 'string' ? response.reason : '已取消' };
    } else {
      zcodeAnswer = questionResponse(pending, response?.values);
    }
    currentEntry = null; // 文件由 runPending 在 resolve 之后统一删除
    resolve(zcodeAnswer);
    return zcodeAnswer;
  }

  return {
    handlers,
    answer,
    current: () => readPending(pendingPath),
  };
}
