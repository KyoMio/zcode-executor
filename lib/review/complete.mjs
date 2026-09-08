// 本文件负责：把 workspace/generateText 包成模型审批用的 Complete 函数——
// createComplete({ client, workspace, modelRef, ... }) 返回 async ({ system, user }) => text。
// 参数形状出处：docs/verified.md「workspace/generateText」行（params 带 workspace、modelRef、
// messages（至少一个）、querySource（必填）、maxOutputTokens?、operationId?；思考等级走 modelRef.variant）。
// 不负责：两段流程与输出解析（lib/review/run.mjs）、闸门编排（lib/gate.mjs）、退出码（协议层
//   不定退出码，RULES §1：错误只带 details，不带退出码）。
// 被依赖方：lib/run.mjs 的 runner 接线、scripts/real-review.mjs。
// 超时语义（RULES §3、§7）：到点先发 workspace/cancelGenerateText 再抛，错误信息带方法名。
import { randomUUID } from 'node:crypto';
import { ExecutorError } from '../errors.mjs';

const CANCEL_TIMEOUT_MS = 5000;

/**
 * @param {object} opts
 * @param {object} opts.client AppServerClient
 * @param {object} opts.workspace {workspacePath, workspaceKey}
 * @param {object} opts.modelRef {providerId, modelId, variant?}
 * @param {string} [opts.querySource] 缺省 'zcode-executor.review'（真机已核，verified.md 2026-09-08）
 * @param {number} [opts.maxOutputTokens] 该次调用不指定 maxTokens 时的缺省，800（阶段二推理加一行结论够用）
 * @param {number} [opts.timeoutMs] 缺省 60_000
 * @param {(raw: {text, usage, durationMs, maxOutputTokens}) => void} [opts.onRaw] 每次调用
 *   结束的原文与用量（real-review 打印用；Complete 本身仍只返回 text）
 * @returns {({system: string, user: string, maxTokens?: number}) => Promise<string>}
 */
export function createComplete({
  client,
  workspace,
  modelRef,
  querySource = 'zcode-executor.review',
  maxOutputTokens = 800,
  timeoutMs = 60_000,
  onRaw,
} = {}) {
  // maxTokens 由两段流程传（快筛/慢判预算不同，T3.2b）；不传用缺省
  return async function complete({ system, user, maxTokens } = {}) {
    const operationId = `review_${randomUUID()}`; // 整串 UUID（T3.2b），日志里好对上 cancel
    const budget = maxTokens ?? maxOutputTokens;
    const params = {
      workspace,
      modelRef,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      querySource,
      maxOutputTokens: budget,
      operationId,
    };
    const startedAt = Date.now();
    // 客户端自己的超时给 5 秒余量：到点先由这里的竞态发 cancel，再抛——
    // 直接用客户端超时就抢不到「先取消」这一步了
    const request = client.request('workspace/generateText', params, { timeoutMs: timeoutMs + CANCEL_TIMEOUT_MS });
    request.catch(() => {}); // 超时/取消后迟到的兑现或拒绝都没人等了，别变成 unhandled
    let timer;
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('complete-timeout')), timeoutMs);
    });
    try {
      const result = await Promise.race([request, timedOut]);
      if (typeof result?.text !== 'string') {
        throw new ExecutorError('generateText 结果里没有 text 字段，没法解析模型审批的结论', {
          method: 'workspace/generateText',
          result: result ?? null,
        });
      }
      onRaw?.({
        text: result.text,
        usage: result.usage ?? null,
        durationMs: Date.now() - startedAt,
        maxOutputTokens: budget,
      });
      return result.text;
    } catch (err) {
      if (err?.message === 'complete-timeout') {
        // 到点先取消再抛（任务单）；取消发不出去（进程已死）也只能这样，错误照样抛
        try {
          await client.request('workspace/cancelGenerateText', { operationId }, { timeoutMs: CANCEL_TIMEOUT_MS });
        } catch {
          // 取消失败不掩盖原始超时
        }
        throw new ExecutorError(`等待 workspace/generateText 结果超时（${timeoutMs}ms），已发 workspace/cancelGenerateText`, {
          method: 'workspace/generateText',
          operationId,
          timeoutMs,
        });
      }
      if (err instanceof ExecutorError) throw err;
      throw new ExecutorError(`调用 workspace/generateText 失败：${err?.message ?? err}`, {
        method: 'workspace/generateText',
        operationId,
      });
    } finally {
      clearTimeout(timer);
    }
  };
}
