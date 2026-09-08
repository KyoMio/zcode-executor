// 本文件负责：模型审批的两段流程——createReview(complete, options) 返回
// review(action, ctx)：快筛只回 pass/flag（一个 token 的钱），flag 才进慢判复核。
// 不负责：模型怎么调（Complete 由调用方给，见 lib/review/complete.mjs）、闸门编排与挂起
//   （lib/gate.mjs）、证据收集（闸门查好放进 ctx，任务单 T3.2 ③）、
//   规则与提示词的数据（rules.mjs / prompt.mjs / parse.mjs / evidence.mjs）。
// 被依赖方：lib/gate.mjs、scripts/real-review.mjs。
// 来源：作者先前的 TypeScript 审批原型（同作者，无第三方许可证事宜），手工去类型。
//   改动见下方「改：」标记。
import { RULES, ALLOWANCES } from './rules.mjs';
import { STAGE1_INSTRUCTION, STAGE2_INSTRUCTION, actionPrompt, systemPrompt } from './prompt.mjs';
import { parseFast, parseSlow } from './parse.mjs';

/** 失败原因的可读形式。截断，避免把整个响应体塞进日志（照搬 run.ts）。 */
function errorText(e) {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 300);
  return String(e).slice(0, 300);
}

/** 从工具参数里取命令原文；不是命令类工具就返回空串（照搬 run.ts，闸门查证据也用）。 */
export function commandTextOf(args) {
  if (args === null || typeof args !== 'object') return '';
  const value = args.command;
  return typeof value === 'string' ? value : '';
}

/**
 * 组装两段判定器。
 * 改（相对 run.ts 的 createJudge）：
 * - 改名 createReview；只保留 gate 侧语义（guard 模式不搬，本项目没有那个场景）。
 * - 结果键叫 decision 不叫 verdict；stage 取 review-fast / review-slow / review-failed
 *   （SPEC 闸门事件的段名）。
 * - **永不返回 deny**（RULES §8）：慢判 deny 一律映射 ask；解析不出、调用失败也是 ask。
 *   拒绝只能由人做。
 * - 探针从 options 里拿掉：证据由闸门（lib/gate.mjs）查好放进 ctx.evidence，两段共用同一份，
 *   这里不再重复查。
 *
 * @param {({system, user, maxTokens}) => Promise<string>} complete 模型调用，抛错视为判不下来
 * @param {object} [options]
 * @param {readonly object[]} [options.rules] 缺省 rules.mjs 的 RULES
 * @param {readonly object[]} [options.allowances] 缺省 rules.mjs 的 ALLOWANCES
 * @param {number} [options.fastMaxTokens] 阶段一输出上限，缺省 300。改：原版 16（阶段一只要
 *   一个字符），但思考内容也算输出，16 会把正文挤成空串→每次都走慢判反而更贵（T3.2b 评审）；
 *   可用 config.review.fastMaxTokens 配
 * @param {number} [options.slowMaxTokens] 阶段二输出上限，缺省 2000。改：原版 600，真机上模型
 *   把额度花在逐条推理上、结论行没写到就被截断 → parseSlow 失败转人工
 *   （verified.md「模型审批慢判被截断」）；可用 config.review.slowMaxTokens 配（T3.3）
 * @returns {(action, ctx) => Promise<{decision:'allow'|'ask', stage, reason?, ruleId?}>}
 */
export function createReview(complete, options = {}) {
  const rules = options.rules ?? RULES;
  const allowances = options.allowances ?? ALLOWANCES;
  const fastMaxTokens = options.fastMaxTokens ?? 300;
  const slowMaxTokens = options.slowMaxTokens ?? 2000;

  return async function review(action, ctx) {
    // 两段共用同一段系统提示词 + 同一段操作描述，只换末尾指令，好吃到提供方的前缀缓存
    const system = systemPrompt(rules, ctx, allowances);
    const body = actionPrompt(action, ctx);

    let fastText;
    try {
      fastText = await complete({
        system,
        user: `${body}\n\n---\n\n${STAGE1_INSTRUCTION}`,
        maxTokens: fastMaxTokens,
      });
    } catch (e) {
      // 判不下来就退人工，但原因要留下——吞了异常连「为什么」都看不出（run.ts 决策 0006 同款）
      return { decision: 'ask', stage: 'review-failed', reason: errorText(e) };
    }

    if (parseFast(fastText) === 'pass') {
      return { decision: 'allow', stage: 'review-fast', reason: `快筛通过（模型回 ${fastText.trim().slice(0, 20)}）` };
    }
    // 阶段一只负责挑出「可能超范围」的，纠偏全靠阶段二，这里不做任何判断

    let slowText;
    try {
      slowText = await complete({
        system,
        user: `${body}\n\n---\n\n${STAGE2_INSTRUCTION}`,
        maxTokens: slowMaxTokens,
      });
    } catch (e) {
      return { decision: 'ask', stage: 'review-failed', reason: errorText(e) };
    }

    const parsed = parseSlow(slowText);
    if (parsed === undefined) {
      // 复核跑了但结论行读不出来——不猜，转人工。把模型末尾带出来，不然看不出是没按格式答还是别的
      const tail = slowText.trim().replace(/\s+/g, ' ').slice(-220);
      return { decision: 'ask', stage: 'review-failed', reason: `结论行解析失败，模型末尾: ${tail}` };
    }

    // 拒绝必须引用一条**真实存在**的规则 id（parseSlow 只认格式，认不出真假——
    // 没附 id 的它在解析层就降成 ask 了）。编了个表里没有的 id 同样不构成拒绝——转人工而不是放行
    const cited = parsed.ruleId !== undefined && rules.some((r) => r.id === parsed.ruleId);
    if (parsed.decision === 'deny') {
      if (!cited) {
        return {
          decision: 'ask',
          stage: 'review-slow',
          reason: `拒绝引用的规则 ${parsed.ruleId} 不在规则表里，转人工${parsed.reason === undefined ? '' : `：${parsed.reason}`}`,
        };
      }
      // RULES §8：模型审批只产出放行或转人工。deny 带着引用映射成 ask，ruleId 留给事件与挂起
      return { decision: 'ask', stage: 'review-slow', reason: parsed.reason, ruleId: parsed.ruleId };
    }
    if (parsed.decision === 'ask') {
      // parseSlow 把「说不出规则的拒绝」降级成了 ask，理由带前缀，原样透传
      return { decision: 'ask', stage: 'review-slow', reason: parsed.reason };
    }
    return {
      decision: 'allow',
      stage: 'review-slow',
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    };
  };
}
