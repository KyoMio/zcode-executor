// 本文件负责：本项目专属的机械红线 checkHardRules，命中一律转人工、不进模型审批。两条：
// ① outside-worktree——带路径参数的工具，路径照内核的走法逐段解析（符号链接就地展开，`..` 作用在
//    链接目标上）后不在执行副本（cwd）之下；写类工具拿不出能判的路径、路径判不了界，同样命中。
// ② self-modify-approval——操作指向闸门自己的数据目录或 CLI。文本判据在同层 self-guard.mjs，
//    这里负责把路径解析好递过去、把两条接成一个入口。
// 不负责：凭据外泄等语义红线（由模型审批按 rules.mjs 的 hard 规则判，T3.2 接入）；
// Bash 等命令类工具的通用路径解析（没法可靠解析，按任务单交模型审批，提示词里写明越界转人工）。
// 被依赖方：lib/gate.mjs（红线段，命中即挂起，不进模型审批）。
// 依赖：node:path、node:fs、node:os、lib/errors.mjs、同层的 rules.mjs（取 OUTSIDE_WORKTREE
//   的 id，T3.1b）、evidence.mjs（~ 展开）、self-guard.mjs；不 import 协议层与工作流层。
// 说明：action.input 与 prompt.mjs / evidence.mjs 里的 args 是同一样东西——待判操作的
// 参数对象。名字不同只是 prompt/evidence 照搬了来源项目的叫法。

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { ExecutorError } from '../errors.mjs';
import { OUTSIDE_WORKTREE } from './rules.mjs';
import { expandTildePath } from './evidence.mjs';
import { SELF_GUARD_RULE_ID, cliCallIn, controlPlaneZone, inControlPlane, stateRefIn } from './self-guard.mjs';

// ZCode 自己归为写文件的工具（App 3.14.4 的 isWriteTool 去掉 Bash，verified.md 2026-10-08），加上旧表里
// 的 MultiEdit、NotebookEdit。它们越界的 why 说「写」；其余带路径键的工具（Read、Glob 这类）说「读」。
// 文案之分不改判定：越界读一样转人工，放不放由人决定（转人工不是拒绝）。
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'ApplyPatch']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path'];
// 命令类工具放原文的键：Bash 的 command、js（Node REPL，权限与 Bash 同级）的 code（verified.md 2026-10-08）
const COMMAND_KEYS = ['command', 'code'];
// 一条路径最多跟这么多次符号链接，超过按成环算（Linux 内核的上限是 40，macOS 是 32）
const MAX_LINK_HOPS = 40;

/**
 * 判一次操作的机械红线。action = { toolName, input }，cwd 是执行副本根，stateDir 是本工具的数据目录
 * （配置里的 home；不给就只判得了「调本工具 CLI」，判不了「碰数据目录」）。
 * cwd 不是非空字符串是调用方的编程错误，抛 ExecutorError（用法错），不静默放行。
 * 命中返回 { hit:true, ruleId, why }，越界的 why 里带解析后的绝对路径；
 * 不命中（包括 Bash 等无路径参数的工具）返回 { hit:false, ruleId:null }，交模型审批。
 */
export function checkHardRules(action, { cwd, stateDir } = {}) {
  if (typeof cwd !== 'string' || cwd === '') {
    throw new ExecutorError(
      'checkHardRules 缺 cwd：机械红线要有执行副本根才能判界，调用方应传登记簿里该会话的 cwd',
      1,
    );
  }
  const toolName = action?.toolName;
  const input = action?.input;
  const home = os.homedir();
  const isWrite = WRITE_TOOLS.has(toolName);
  const outside = (why) => ({ hit: true, ruleId: OUTSIDE_WORKTREE.id, why });

  const rawPaths = pathArgsOf(input);
  if (rawPaths.length === 0 && isWrite) {
    // 审计 D9-④：路径键改了名、或目标写在别处（ApplyPatch 的补丁正文）时红线读不到落点。当成没有可判对象
    // 交给模型，这条红线就悄悄失效了；判不了的写一律停下等人
    return outside(`写类工具 ${toolName} 没给出能判界的路径（只认 ${PATH_KEYS.join(' / ')}），机械红线判不了它写到哪`);
  }

  const landings = [];
  if (rawPaths.length > 0) {
    const cwdAbs = path.resolve(cwd);
    let base;
    try {
      base = resolveLikeKernel(cwdAbs);
    } catch (err) {
      return outside(`执行副本根判不了落在哪（${reasonOf(err)}）：${cwd}`);
    }
    for (const raw of rawPaths) {
      let resolved;
      try {
        // `~` 与 `~/…` 先按 homedir 展开，再判绝对/相对——家目录永远在执行副本之外。
        // 展开与 evidence.mjs 共用同一份（T2.9 第 10 条）
        resolved = landingsOf(expandTildePath(raw, home), cwdAbs);
      } catch (err) {
        // 审计 D1 附带：成环、没权限、把文件当目录穿这些都判不了落点，不能原样当界内放过
        return outside(`路径判不了落在哪（${reasonOf(err)}），不当界内放过：${raw}`);
      }
      const escaped = resolved.find((p) => !isInside(p, base));
      if (escaped !== undefined) return outside(`${isWrite ? '写' : '读'}到执行副本之外：${escaped}`);
      landings.push(...resolved);
    }
  }

  // ② 闸门自保（审计 D2）：执行端与 runner 同一个用户，文件权限挡不住它，只能在这里把话问到人面前
  const guarded = (why) => ({ hit: true, ruleId: SELF_GUARD_RULE_ID, why });
  const zone = typeof stateDir === 'string' && stateDir !== ''
    ? controlPlaneZone({ stateDir, cwd, home, realpathOf: realpathOrSelf })
    : null;
  if (zone) {
    // 正常配置下数据目录在执行副本之外，上面的越界已经拦了；这里兜的是执行副本把数据目录包在里面的配置
    const touched = landings.find((p) => inControlPlane(p, zone));
    if (touched !== undefined) {
      return guarded(`${isWrite ? '写' : '读'}的是 zcode-executor 自己的数据目录（审批挂起与应答、登记簿、配置都在里面）：${touched}`);
    }
  }
  for (const key of COMMAND_KEYS) {
    const text = input?.[key];
    if (typeof text !== 'string' || text === '') continue;
    const ref = zone ? stateRefIn(text, zone) : undefined;
    if (ref !== undefined) {
      return guarded(`命令引用了 zcode-executor 自己的数据目录（审批挂起与应答、登记簿、配置都在里面）：${ref}`);
    }
    const call = cliCallIn(text, { code: key === 'code' });
    if (call !== undefined) {
      return guarded(`命令调用了 zcode-executor 自己的 CLI（审批、投递、会话管理只归上层）：${call}`);
    }
  }
  return { hit: false, ruleId: null };
}

/** input 里能判的路径参数（非空字符串），按 PATH_KEYS 的顺序。 */
function pathArgsOf(input) {
  if (input === null || typeof input !== 'object') return [];
  return PATH_KEYS.map((key) => input[key]).filter((value) => typeof value === 'string' && value !== '');
}

/** resolved 是 base 自己或在它之下（前缀比对补分隔符，兄弟目录 base-evil 不算）。 */
function isInside(resolved, base) {
  return resolved === base || resolved.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

/**
 * 一个路径参数可能的落点。写工具拿到路径后是先做词法归一（Node 的 path.resolve 会把 `link/..` 折叠掉）
 * 还是原样交给内核（`..` 作用在链接目标上），从外面看不出来，所以两种解释都算，调用方要求都在界内。
 * 相对路径接在 cwd 后面，不经 path.resolve——它一折叠，要判的形态就没了。
 */
function landingsOf(candidate, cwdAbs) {
  const raw = path.isAbsolute(candidate) ? candidate : `${cwdAbs}${path.sep}${candidate}`;
  const asKernel = resolveLikeKernel(raw);
  const asFolded = resolveLikeKernel(path.normalize(raw));
  return asKernel === asFolded ? [asKernel] : [asKernel, asFolded];
}

const splitSegments = (p) => p.split(path.sep === '/' ? '/' : /[\\/]/);

/**
 * 把绝对路径照内核的走法逐段解析成真实路径：遇到符号链接就地展开（末段也跟，悬空链接按它指向的地方算），
 * `..` 退到已解析出来的真实父目录。不能用 fs.realpathSync：它的 JS 实现一上来先 path.resolve，
 * 把 `link/..` 词法折叠掉，正是审计 D1 的洞（先折叠再解析，`<执行副本>/link/../x` 看着在界内）。
 * 不存在的段照原样拼上去（新建文件是常态）；其后的 `..` 退回到存在的目录后接着解析——写工具会先把
 * 目录建出来，那时内核就是这么走的。
 * ENOENT 以外的错（ELOOP、EACCES、ENOTDIR……）原样抛出：判不了，由调用方转人工。
 */
function resolveLikeKernel(absPath) {
  const { root } = path.parse(absPath);
  const queue = splitSegments(absPath.slice(root.length));
  let current = root;
  let missingDepth = 0; // current 末尾有几段是不存在的
  let hops = 0;
  while (queue.length > 0) {
    const segment = queue.shift();
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (missingDepth > 0) missingDepth -= 1;
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, segment);
    if (missingDepth > 0) {
      missingDepth += 1;
      current = next;
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(next);
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
      missingDepth = 1;
      current = next;
      continue;
    }
    if (!stat.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) {
      throw Object.assign(new Error(`符号链接跟了 ${MAX_LINK_HOPS} 层还没到头`), { code: 'ELOOP' });
    }
    const target = fs.readlinkSync(next);
    const targetRoot = path.parse(target).root;
    if (targetRoot !== '') current = targetRoot; // 绝对目标从它的根重新走；相对目标接着 current（链接所在目录）走
    queue.unshift(...splitSegments(target.slice(targetRoot.length)));
  }
  return current;
}

/** 给 self-guard 用的真实路径：解析不了就用原样的（那边只是多认一种写法，少一种不影响已有的判定）。 */
function realpathOrSelf(absPath) {
  try {
    return resolveLikeKernel(absPath);
  } catch {
    return absPath;
  }
}

const REASONS = {
  ELOOP: '符号链接成环或层数太多',
  EACCES: '没有权限查看',
  EPERM: '没有权限查看',
  ENOTDIR: '把文件当目录穿',
  ENAMETOOLONG: '路径太长',
};

function reasonOf(err) {
  const code = err?.code;
  return REASONS[code] ? `${code}：${REASONS[code]}` : String(code ?? err?.message ?? err);
}
