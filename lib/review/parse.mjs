// 本文件负责：模型审批两阶段输出的解析——parseFast（阶段一 Y/N → 'pass'|'flag'）、
// parseSlow（阶段二结论行 → { decision:'allow'|'deny'|'ask', ruleId?, reason? } 或 undefined）。
// 不负责：调用模型与两阶段编排（原 createJudge 依赖 Complete 与会话事实，T3.2 再接）；
// 校验拒绝所引的规则 id 是否真在规则表里（本文件不 import rules.mjs，由 gate 做）。
// 被依赖方：lib/gate.mjs。
// 不变量（RULES §8）：parseSlow 可能返回 deny，gate 拿到 deny 必须映射成 ask——
// 模型审批只产出放行或转人工，代码里不存在把 deny 应答给 zcode 的分支。
// 来源：作者先前的 TypeScript 审批原型（同作者，无第三方许可证事宜），手工去类型。
//   改动见下方「改：」标记。

/**
 * 解析阶段一：只认第一个有意义的字符。
 *
 * 模型偶尔会多话（"Y"、"Y。"、"答案是 Y"）。宽松取第一个 Y/N，
 * 两者都没有就当 N——**默认落到更谨慎的那边**，让阶段二去纠。
 */
export function parseFast(text) {
  const match = /[YN]/i.exec(text);
  if (match === null) return 'flag';
  return match[0].toUpperCase() === 'Y' ? 'pass' : 'flag';
}

/**
 * 解析阶段二。
 *
 * 新格式（T3.3）：**第一行就是结论行**——`结论: allow` / `结论: ask` / `结论: deny <规则 id>`，
 * 理由另起一行。真机教训：结论放最后一行时推理一长就被截断，结论行没写出来整次判定作废，
 * 所以提示词要求先给结论，解析也先看第一行。
 *
 * 兼容旧输出：首行不是结论行时（模型先写了一段推理、结论在末行），全文扫**最后一个**
 * 结论行取——推理过程里复述格式或举例的那些不是结论。
 * 解析不出来返回 undefined，调用方据此落到 ask（转人工）——绝不猜。
 *
 * 改（相对原版 run.ts 的 parseSlow）：
 * - 返回对象的键叫 decision 不叫 verdict（CONTEXT.md 用词）。
 * - 结论词除了 allow / deny 也认 ask：模型直接回「转人工」时干净落 ask。
 * - deny 而说不出命中的规则 id（没有、写 none、或新格式里没跟 id）→ ask：说不出撞了
 *   哪条就不构成拒绝；降级出的 ask 在 reason 前加「拒绝未附规则 id，转人工：」标明来路。
 */

/** 一行结论行 → {word, ruleId, reason}；不是结论行返回 undefined。ruleId 的 'none' 归一成 undefined。 */
function parseConclusionLine(line) {
  const m = /^\s*结论\s*[:：]\s*(allow|deny|ask)(?:\s+([A-Za-z0-9_-]+))?([^\n]*)$/i.exec(line);
  if (m === null) return undefined;
  let ruleId = m[2];
  const rest = m[3] ?? '';
  if (ruleId !== undefined && ruleId.toLowerCase() === 'none') ruleId = undefined;
  let reason;
  // 旧格式键值（规则: xxx / 理由: xxx）出现在同一行里也认
  if (ruleId === undefined) {
    const ruleM = /规则\s*[:：]\s*([A-Za-z0-9_-]+)/i.exec(rest);
    if (ruleM !== null && ruleM[1].toLowerCase() !== 'none') ruleId = ruleM[1];
  }
  const reasonM = /理由\s*[:：]\s*(.*)$/i.exec(rest);
  if (reasonM !== null) reason = reasonM[1].trim();
  return { word: m[1].toLowerCase(), ruleId, reason };
}

/** 结论行之后第一段非空文字当理由（新格式：理由放后面）；开头带「理由:」也认。 */
function nextReasonLine(lines, start) {
  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    const m = /^理由\s*[:：]\s*/i.exec(trimmed);
    return (m === null ? trimmed : trimmed.slice(m[0].length)).trim();
  }
  return undefined;
}

function toResult(word, ruleId, reason) {
  const id = ruleId !== undefined && String(ruleId).toLowerCase() !== 'none' ? ruleId : undefined;
  if (word === 'deny' && id === undefined) {
    return {
      decision: 'ask',
      // 说不出撞了哪条就不构成拒绝，降级为 ask；前缀标明这一票是降级出来的。
      reason: `拒绝未附规则 id，转人工：${reason ?? ''}`,
    };
  }
  return {
    decision: word,
    ...(id === undefined ? {} : { ruleId: id }),
    ...(reason === undefined || reason === '' ? {} : { reason }),
  };
}

export function parseSlow(text) {
  const lines = String(text ?? '').split('\n');
  // ① 新格式：第一行就是结论行
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const first = parseConclusionLine(lines[i]);
    if (first === undefined) break; // 首行不是结论行：交给旧格式兜底
    return toResult(first.word, first.ruleId, first.reason ?? nextReasonLine(lines, i + 1));
  }
  // ② 兜底（兼容旧输出）：全文扫最后一个结论行
  const re = /结论\s*[:：]\s*(allow|deny|ask)(?:[^\n]*?规则\s*[:：]\s*([A-Za-z0-9_-]+))?(?:[^\n]*?理由\s*[:：]\s*([^\n]*))?/gi;
  let last = null;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m;
  if (last === null) return undefined;
  return toResult(last[1].toLowerCase(), last[2], last[3]?.trim());
}
