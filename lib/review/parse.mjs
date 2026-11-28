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
 * 解析阶段一：只认独立成词的 Y / N（也认 yes / no），全文只出现 Y 才算 pass。
 *
 * 模型偶尔会多话（"Y"、"Y。"、"答案是 Y"）。答案前后可以有标点、引号、中文，但不能挨着字母数字——
 * 改（审计 D8）：原先取全文第一个 y/n 字符，模型先写一句推理时「They are…」里的 y 就成了放行。
 * 一个都没有、或者 Y 和 N 都出现（"可能是 Y 也可能是 N"），当 N——**默认落到更谨慎的那边**，
 * 让阶段二去纠。
 */
export function parseFast(text) {
  const answers = new Set();
  for (const match of String(text ?? '').matchAll(/(?<![A-Za-z0-9_])(?:YES|NO|Y|N)(?![A-Za-z0-9_])/gi)) {
    answers.add(match[0][0].toUpperCase());
  }
  return answers.size === 1 && answers.has('Y') ? 'pass' : 'flag';
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

// 结论标签的中英文变体（ZCE-3）：模型换提示词措辞或输出语言时常见的等价写法。
// 仍要求显式标签或独立结论行——推理过程里随口出现的 allow/deny 不算结论。
const LABEL_RE = '(?:结论|結論|判定|裁决|裁決|决定|決定|conclusion|verdict|decision)';

// 结论词表（R1-5）：英文 allow/deny/ask 之外认中文整词——**允许** 这类输出曾解析为 null。
// 中文词按完整词匹配（\b 对中文无效，用前后否定环视排除贴连字母数字与中文延伸词：
// 「允许范围内」「拒绝了」都不是结论）。归一到 allow/deny/ask 三值。
const WORD_RE = '(allow|deny|ask|允许|放行|拒绝|转人工)';

function normalizeWord(word) {
  const w = String(word).toLowerCase();
  if (w === 'allow' || word === '允许' || word === '放行') return 'allow';
  if (w === 'deny' || word === '拒绝') return 'deny';
  if (w === 'ask' || word === '转人工') return 'ask';
  return w;
}

/** 去掉行内 Markdown 装饰：列表符号、加粗、行内代码、引用符。只影响格式字符，不动文字内容。 */
function stripMarkdown(line) {
  let out = String(line).trim();
  out = out.replace(/^(?:[-*+]|\d+[.)])\s+/, ''); // 列表符号 "- " / "1. "
  out = out.replace(/^>\s*/, ''); // 引用符
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1'); // **加粗**
  out = out.replace(/__([^_]+)__/g, '$1'); // __加粗__
  out = out.replace(/`([^`]+)`/g, '$1'); // `行内代码`
  return out.trim();
}

/** 一行结论行 → {word, ruleId, reason}；不是结论行返回 undefined。ruleId 的 'none' 归一成 undefined。 */
function parseConclusionLine(line) {
  const plain = stripMarkdown(line);
  // 结论词后必须跟空白/分隔符/行尾（(?![A-Za-z0-9])）：否则「结论: ALLOWED」里的 allow 前缀会被误吞（ZCE-3 回归）
  const m = new RegExp(`^${LABEL_RE}\\s*[:：]\\s*${WORD_RE}(?![A-Za-z0-9\\u4e00-\\u9fff])(?:\\s+([A-Za-z0-9_-]+))?([^\\n]*)$`, 'i').exec(plain);
  if (m === null) return undefined;
  let ruleId = m[2];
  const rest = m[3] ?? '';
  if (ruleId !== undefined && ruleId.toLowerCase() === 'none') ruleId = undefined;
  let reason;
  // 旧格式键值（规则: xxx / 理由: xxx）出现在同一行里也认；中英文标签与竖线分隔都行
  if (ruleId === undefined) {
    const ruleM = /(?:规则|rule)\s*[:：]\s*([A-Za-z0-9_-]+)/i.exec(rest);
    if (ruleM !== null && ruleM[1].toLowerCase() !== 'none') ruleId = ruleM[1];
  }
  const reasonM = /(?:理由|reason)\s*[:：]\s*(.*)$/i.exec(rest);
  if (reasonM !== null) reason = reasonM[1].trim().replace(/^[|｜]\s*/, '');
  return { word: normalizeWord(m[1]), ruleId, reason };
}

/** 结论行之后第一段非空文字当理由（新格式：理由放后面）；开头带「理由:」也认。后续又出现结论行标签的跳过——那是格式漂移的第二条结论，不是理由。 */
function nextReasonLine(lines, start) {
  const labelHead = new RegExp(`^${LABEL_RE}\\s*[:：]`, 'i');
  for (let i = start; i < lines.length; i++) {
    const trimmed = stripMarkdown(lines[i]);
    if (trimmed === '') continue;
    if (labelHead.test(trimmed)) continue; // 下一条结论行不是理由（多条结论并存的畸形输出）
    const m = /^(?:理由|reason)\s*[:：]\s*/i.exec(trimmed);
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

/**
 * 裁决候选行预处理（R2-2）：在选首行/兼容行/末行之前统一排除两类行——
 *  ① 引用行（> 开头）：那是转述别人的格式或结论，永远不是本模型的裁决；
 *  ② 围栏代码块内部（``` 或 ~~~ 开闭之间）：格式示例/文档引用，同样不是裁决。
 * 加粗/行内代码/列表前缀的兼容不受影响（那些是排版装饰不是引用）。
 * 返回 { lines, quoteExcluded, fenceExcluded }——排除计数供调用方审计。
 */
/**
 * 判断一行是否围栏边界（CommonMark 语义，R3-2）：
 * 行首至多 3 空格缩进，紧跟至少 3 个相同反引号或波浪号。
 * 返回 { ch, len, rest } 或 null。rest 是围栏符号之后的行内容（信息串/尾巴）。
 */
function fenceMark(line) {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  return { ch: m[1][0], len: m[1].length, rest: line.slice(m[0].length) };
}

function candidateLines(text) {
  const raw = String(text ?? '').split('\n');
  const lines = [];
  // CommonMark 围栏规则：开栏记字符与长度；闭栏须同字符、长度不小于开栏、且末尾仅空白——
  // 栏内出现的较短或另一种符号的分隔符只是内容，绝不能翻转开关（R3-2：示例里的
  // ``` 或 ~~~ 曾把四反引号围栏提前关掉，围栏外的正式裁决被吞/示例文本被当裁决）。
  // 另外 CommonMark 规定反引号围栏的信息串不能再含反引号，含则整行不算开栏（按普通文本）。
  let fence = null; // { ch, len } | null
  let quoteExcluded = 0;
  let fenceExcluded = 0;
  for (const line of raw) {
    const mark = fenceMark(line);
    if (fence === null) {
      if (mark !== null && !(mark.ch === '`' && mark.rest.includes('`'))) {
        fence = { ch: mark.ch, len: mark.len };
        fenceExcluded += 1; // 开栏行本身不算候选
        continue;
      }
    } else {
      if (mark !== null && mark.ch === fence.ch && mark.len >= fence.len && /^\s*$/.test(mark.rest)) {
        fence = null;
        fenceExcluded += 1; // 闭栏行本身不算候选
        continue;
      }
      fenceExcluded += 1; // 栏内一切内容（含较短/另一种分隔符）都不是裁决候选
      continue;
    }
    if (/^\s*>/.test(line)) {
      quoteExcluded += 1;
      continue;
    }
    lines.push(line);
  }
  return { lines, quoteExcluded, fenceExcluded };
}

export function parseSlow(text) {
  const { lines } = candidateLines(text);
  // ① 新格式：第一行就是结论行
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    const first = parseConclusionLine(lines[i]);
    if (first === undefined) break; // 首行不是结论行：交给旧格式兜底
    return toResult(first.word, first.ruleId, first.reason ?? nextReasonLine(lines, i + 1));
  }
  // ② 兜底（兼容旧输出，R1-5 加固）：逐行扫描，只认**行首**就是结论标签的独立裁决行——
  // 正文/引用/举例里出现的「结论: allow」是复述不是裁决，一律不算（曾因此误放行）。
  // 取最后一个独立裁决行；理由照旧从同一行或下一行非空文字取。
  let lastIdx = -1;
  let lastParsed = null;
  for (let i = 0; i < lines.length; i++) {
    // 引用行（> 开头）一律不算裁决——那是转述别人的格式或结论（R1-5：曾因此误放行）
    if (/^\s*>/.test(lines[i])) continue;
    const parsed = parseConclusionLine(lines[i]);
    if (parsed !== undefined) {
      lastIdx = i;
      lastParsed = parsed;
    }
  }
  if (lastParsed !== null) {
    return toResult(lastParsed.word, lastParsed.ruleId, lastParsed.reason ?? nextReasonLine(lines, lastIdx + 1));
  }
  // ③ 最终兜底（ZCE-3）：最后一行非空行**整行**只有一个结论词（剥 Markdown 后）——
  // 模型忘记写「结论:」标签时的常见收尾。整行匹配是硬条件：推理过程里顺口出现的
  // allow/deny 不算结论，宁可解析不出降级 ask，也不猜。
  const nonEmpty = lines.map(stripMarkdown).filter((l) => l !== '');
  const lastLine = nonEmpty[nonEmpty.length - 1];
  const bare = new RegExp(`^${WORD_RE}\\s*[。.!！]?$`, 'i').exec(lastLine ?? '');
  if (bare !== null) return toResult(normalizeWord(bare[1]), undefined, undefined);
  return undefined;
}
