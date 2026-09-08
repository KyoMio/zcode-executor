// 本文件负责：闸门的三段编排——createGate 把机械红线（review/hard.mjs）、模型审批
// （review/run.mjs 的两段）与挂起（pending.mjs）按固定顺序接起来，审批请求与提问
// 都从这里走：红线命中或判不下来 → 挂起等人工；模型放行 → 自动应答 allow。
// 不负责：模型怎么调（Complete 由 runner 经 lib/review/complete.mjs 造好传入）、
// 意图与 priorActions 的收集（工作流层 lib/intent.mjs，经 getIntent/getPriorActions 注入）、
// pending.json 的读写细节（pending.mjs）。
// 被依赖方：lib/run.mjs 的 runner 接线（工作流 → 闸门，RULES §1 允许的方向）。
// 依赖：同层 lib/pending.mjs、闸门层 lib/review/*；不 import 工作流层（run/registry/config/cli）。
//
// 安全边界（RULES §8）：这里唯一自动应答给 zcode 的是 review 的 allow（且以 options 里有
// allow_once 为前提，见 ②）；deny 在 review 层就已映射成 ask，本文件没有把 deny 应答出去的分支。
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createPendingGate, hasAllowOnce } from './pending.mjs';
import { checkHardRules } from './review/hard.mjs';
import { createReview, commandTextOf } from './review/run.mjs';
import { gatherEvidence } from './review/evidence.mjs';

// 与 SPEC「闸门」一致：projectDoc 是 cwd 下 AGENTS.md / CLAUDE.md 截 4000 字后的内容。
// 放闸门层自读而不放 lib/intent.mjs（工作流层）——闸门不能反向 import 工作流层（T3.2 验收）。
const PROJECT_DOC_FILES = ['AGENTS.md', 'CLAUDE.md'];
const PROJECT_DOC_MAX = 4000;

function projectDocOf(cwd) {
  const parts = [];
  for (const name of PROJECT_DOC_FILES) {
    try {
      parts.push(readFileSync(path.join(cwd, name), 'utf8'));
    } catch {
      // 没有这份文档就跳过：多数执行副本不会有
    }
  }
  if (parts.length === 0) return undefined;
  const joined = parts.join('\n\n');
  return joined.length <= PROJECT_DOC_MAX ? joined : `${joined.slice(0, PROJECT_DOC_MAX)}…`;
}

// 意图与 priorActions 的收集器是 runner 注入的，读文件出错不该炸掉闸门——记一行 stderr 按空处理
function safeList(fn, what) {
  try {
    return fn?.() ?? [];
  } catch (err) {
    process.stderr.write(`gate: 取${what}失败，按空处理：${err?.message ?? err}\n`);
    return [];
  }
}

/**
 * 造闸门。complete 缺省（review.enabled:false 或模型算不出来）时模型审批整段跳过，
 * 除红线外一律挂起——故障时默认安全（PRD 用户故事 19）。
 *
 * @param {object} opts
 * @param {string} opts.cwd 执行副本根（红线判界与 workspaceRoot）
 * @param {object} opts.config 插件配置（environment / sensitive 进提示词，review 开关）
 * @param {string} opts.pendingPath runs/<id>/pending.json
 * @param {(pending) => void} opts.onPending 挂起落盘后的回调（runner 用它装 answer 轮询）
 * @param {({system, user, maxTokens}) => Promise<string>|undefined} opts.complete 模型调用
 * @param {object} opts.evidenceProbe 证据探针（nodeProbe()，测试给假探针）
 * @param {() => Array<{source:'task'|'send'|'steer', text:string}>} opts.getIntent 意图条目，按时间序
 *   （lib/intent.mjs 的 gatherIntent；任务单全保留，send/steer 只留最近 10 条）
 * @param {() => string[]} opts.getPriorActions 本回合已执行的工具调用摘要
 * @param {(event) => void} opts.appendEvent 事件落盘（executor.gate 各段结果）
 */
export function createGate({ cwd, config, pendingPath, onPending, complete, evidenceProbe, getIntent, getPriorActions, appendEvent }) {
  const pendingGate = createPendingGate({ pendingPath, onPending });
  const review = complete
    ? createReview(complete, {
      fastMaxTokens: config?.review?.fastMaxTokens,
      slowMaxTokens: config?.review?.slowMaxTokens,
    })
    : null;
  // 「会话之前就存在」的界限：闸门建好的时刻（一条连接一个闸门）。权宜：跨连接的陈旧回合
  // 会被算成「会话期间」改过；真机复核 del-preexisting 的判断准头时再改成登记簿的 createdAt。
  const startedAtMs = Date.now();

  async function permission(params) {
    // 整段兜底（T3.2b 评审）：闸门自己出错（探针炸了、读文档炸了……）时挂起转人工，
    // 不能把异常应答成 -32603 让回合死掉——故障时默认安全（PRD 用户故事 19）
    try {
      return await gatePermission(params);
    } catch (err) {
      const reason = `闸门内部错误，转人工：${err?.message ?? err}`;
      process.stderr.write(`gate: ${reason}\n`);
      try {
        appendEvent({ type: 'executor.gate', stage: 'gate-error', decision: 'ask', reason });
      } catch (eventErr) {
        // 事件写不进去也不能吞掉原始错误，stderr 已有一行可查
        process.stderr.write(`gate: gate-error 事件落盘失败：${eventErr?.message ?? eventErr}\n`);
      }
      return pendingGate.handlers.permission({ ...params, stage: 'gate-error', why: reason });
    }
  }

  async function gatePermission(params) {
    // ① 机械红线：带路径参数的工具越出执行副本。命中即挂起，不进模型审批（PRD 第 6 节）
    const hard = checkHardRules({ toolName: params.toolName, input: params.input }, { cwd });
    if (hard.hit) {
      // 事件统一用 reason（T3.2b）；红线段的 why 只留在 pending.json 里
      appendEvent({ type: 'executor.gate', stage: 'hard', decision: 'ask', ruleId: hard.ruleId, reason: hard.why });
      return pendingGate.handlers.permission({ ...params, stage: 'hard', ruleId: hard.ruleId, why: hard.why });
    }
    // ② 放行的前提是 options 里真有 allow_once（RULES §8、pending.mjs 的 hasAllowOnce）；没有就连模型审批都不用跑——放不出来
    if (!hasAllowOnce(params)) {
      const reason = 'options 里没有 allow_once，不存在自动放行，转人工';
      appendEvent({ type: 'executor.gate', stage: 'no-allow-option', decision: 'ask', reason });
      return pendingGate.handlers.permission({ ...params, stage: 'no-allow-option', why: reason });
    }
    // ③ 模型审批（两段）。complete 没给 = 审批不可用，一律转人工
    if (!review) {
      const reason = '模型审批不可用（review.enabled:false 或没算出可用模型），转人工';
      appendEvent({ type: 'executor.gate', stage: 'review-disabled', decision: 'ask', reason });
      return pendingGate.handlers.permission({ ...params, stage: 'review-disabled', why: reason });
    }
    const ctx = {
      intent: safeList(getIntent, '意图'),
      priorActions: safeList(getPriorActions, '工具调用摘要'),
      environment: config?.environment ?? [],
      sensitive: config?.sensitive ?? [],
      evidence: gatherEvidence({
        command: commandTextOf(params.input),
        args: params.input,
        workspaceRoot: cwd,
        sessionStartedAt: startedAtMs,
        home: os.homedir(),
        probe: evidenceProbe,
      }),
      projectDoc: projectDocOf(cwd),
    };
    const result = await review({ toolName: params.toolName, args: params.input, workspaceRoot: cwd }, ctx);
    if (result.decision === 'allow') {
      appendEvent({ type: 'executor.gate', stage: result.stage, decision: 'allow', reason: result.reason });
      return { decision: 'allow' };
    }
    appendEvent({
      type: 'executor.gate',
      stage: result.stage,
      decision: 'ask',
      reason: result.reason,
      ...(result.ruleId !== undefined ? { ruleId: result.ruleId } : {}),
    });
    return pendingGate.handlers.permission({
      ...params,
      stage: result.stage,
      why: result.reason,
      ...(result.ruleId !== undefined ? { ruleId: result.ruleId } : {}),
    });
  }

  async function question(params) {
    // 提问不进红线与模型审批（D7）：直接挂起，Claude 先答，答不了再问人。
    // 整段兜底与 permission 同款（T2.9 第 3 条）：出错也落 gate-error 事件后仍挂起，
    // 不把异常应答出去让回合死掉——故障时默认安全（PRD 用户故事 19）
    try {
      appendEvent({ type: 'executor.gate', stage: 'question', decision: 'ask', reason: '等人' });
      return pendingGate.handlers.question(params);
    } catch (err) {
      const reason = `闸门内部错误，转人工：${err?.message ?? err}`;
      process.stderr.write(`gate: ${reason}\n`);
      try {
        appendEvent({ type: 'executor.gate', stage: 'gate-error', decision: 'ask', reason });
      } catch (eventErr) {
        // 事件写不进去也不能吞掉原始错误，stderr 已有一行可查
        process.stderr.write(`gate: gate-error 事件落盘失败：${eventErr?.message ?? eventErr}\n`);
      }
      return pendingGate.handlers.question({ ...params, stage: 'gate-error', why: reason });
    }
  }

  return {
    handlers: { permission, question },
    answer: pendingGate.answer,
    current: pendingGate.current,
  };
}
