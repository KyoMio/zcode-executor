// 本文件负责：本项目专属的机械红线 checkHardRules——带路径参数的工具，路径解析成绝对路径、
// 按 realpath 归一后不在执行副本（cwd）之下 → 命中 outside-worktree，转人工。
// 不负责：凭据外泄等语义红线（由模型审批按 rules.mjs 的 hard 规则判，T3.2 接入）；
// Bash 等命令类工具的路径解析（没法可靠解析，按任务单交模型审批，提示词里写明越界转人工）。
// 被依赖方：lib/gate.mjs（红线段，命中即挂起，不进模型审批）。
// 依赖：node:path、node:fs、node:os、lib/errors.mjs、同层的 rules.mjs（取 OUTSIDE_WORKTREE
//   的 id，T3.1b）；不 import 协议层与工作流层。
// 说明：action.input 与 prompt.mjs / evidence.mjs 里的 args 是同一样东西——待判操作的
// 参数对象。名字不同只是 prompt/evidence 照搬了来源项目的叫法。

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ExecutorError } from '../errors.mjs';
import { OUTSIDE_WORKTREE } from './rules.mjs';
import { expandTildePath } from './evidence.mjs';

// 任务单点名的四个工具必有路径参数，越界的 why 说「写」；其余带路径键的工具
// （Read、Glob 这类）越界的 why 说「读」。文案之分不改判定：越界读一样转人工，
// 放不放由人决定（转人工不是拒绝）。
const PATH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];

/**
 * 判一次操作的机械红线。action = { toolName, input }，cwd 是执行副本根。
 * cwd 不是非空字符串是调用方的编程错误，抛 ExecutorError（用法错），不静默放行。
 * 命中返回 { hit:true, ruleId, why }，why 里带解析后的绝对路径；
 * 不命中（包括 Bash 等无路径参数的工具）返回 { hit:false, ruleId:null }，交模型审批。
 */
export function checkHardRules(action, { cwd } = {}) {
  if (typeof cwd !== 'string' || cwd === '') {
    throw new ExecutorError(
      'checkHardRules 缺 cwd：机械红线要有执行副本根才能判界，调用方应传登记簿里该会话的 cwd',
      1,
    );
  }
  const outside = firstOutsidePath(action, cwd);
  if (outside !== undefined) {
    const verb = PATH_TOOLS.has(action?.toolName) ? '写' : '读';
    return { hit: true, ruleId: OUTSIDE_WORKTREE.id, why: `${verb}到执行副本之外：${outside}` };
  }
  return { hit: false, ruleId: null };
}

/**
 * 返回第一个解析后越出 cwd 的路径；都在界内或没有可判的路径时返回 undefined。
 * cwd 已由 checkHardRules 校验过。
 */
function firstOutsidePath(action, cwd) {
  const input = action?.input;
  const hasPathKey = input !== null && typeof input === 'object'
    && PATH_KEYS.some((k) => typeof input[k] === 'string' && input[k] !== '');
  if (!hasPathKey) return undefined; // Bash 等无路径参数，或点名工具没给路径：没有可判对象
  const home = os.homedir();
  const base = realpathFlexible(path.resolve(cwd));
  for (const key of PATH_KEYS) {
    const raw = input[key];
    if (typeof raw !== 'string' || raw === '') continue;
    // `~` 与 `~/…` 先按 homedir 展开，再判绝对/相对——家目录永远在执行副本之外。
    // 展开与 evidence.mjs 共用同一份（T2.9 第 10 条）
    const candidate = expandTildePath(raw, home);
    const abs = path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(cwd, candidate);
    const resolved = realpathFlexible(abs);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return resolved;
  }
  return undefined;
}

/**
 * realpath 能解析就解析；目标不存在时向上找最近存在的祖先，把不存在的尾段拼回它的
 * realpath 之后。走符号链接的路径（macOS 的 /tmp → /private/tmp）由此归一，
 * 两种写法才算作同一个地方。
 */
function realpathFlexible(p) {
  const segments = [];
  let current = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...segments);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.join(p, ...segments); // 到根都不存在，原样拼回
      segments.unshift(path.basename(current));
      current = parent;
    }
  }
}
