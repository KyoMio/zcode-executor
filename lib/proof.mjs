// 本文件负责：Proof Manifest 与断点续跑的工作流原语——
// 采集执行端的结构化证据（.executor-proof.json 优先，最终回复的 ```executor-proof 块兜底）落盘 runs/<id>/proof.json；
// 归档 .executor-checkpoint.md 进 runs/<id>/checkpoint.md；工作区改动探测（git status --porcelain）；
// 超时/取消回合的续跑命令生成、proofSummary 摘要与 investigate 止损提示。
// 不负责：证据本身的真伪核验（那是审查端的事），这里只如实搬运与脱敏。
// 被依赖方：lib/run.mjs（回合结算）、lib/cli/status.mjs 与 lib/cli/common.mjs（摘要输出）。
// 只依赖 lib/scrub.mjs（按值脱敏）与 Node 内置：工作流层内部模块，不反向依赖外壳。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { scrubValues } from './scrub.mjs';
import { writeFileAtomic, writeJsonAtomic } from './config.mjs';

// 执行端写证据与检查点的约定文件名（工作区根，不进 git 提交——任务模板要求提交前清理）
export const PROOF_FILE_NAME = '.executor-proof.json';
export const CHECKPOINT_FILE_NAME = '.executor-checkpoint.md';

// investigate 类任务的超时止损阈值：运行这么久还没结算，提示上游用 --steer 退回汇报。
// 测试可经环境变量压短，正常 900 秒
export const INVESTIGATE_STOP_LOSS_SEC = Number(process.env.ZCODE_EXECUTOR_INVESTIGATE_STOP_LOSS_SEC) || 900;

const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];

/** 大写键名原样是环境变量注入的语义；git 钩子里带的 GIT_DIR 等会压过 -C，一律摘掉（与 cli/common 同一防线）。 */
function gitEnv() {
  const env = { ...process.env };
  for (const key of GIT_LOCATION_ENV) delete env[key];
  return env;
}

/**
 * 工作区有没有未提交改动：git status --porcelain 非空即算（未跟踪文件也算）。
 * 不是 git 仓库、git 不可用、目录已删除都按 false——续跑提示宁缺毋错，不编造改动。
 */
export function worktreeHasChanges(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain'], {
      env: gitEnv(),
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() !== '';
  } catch {
    return false;
  }
}

/** shell 单引号包裹（路径里罕见的单引号按 '\'' 折叠），让续跑命令可以整行复制进终端。 */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** 深度按值脱敏：复制结构，只把字符串值里的密钥抹掉。键名形状不动（证据要能对账）。 */
function scrubDeep(value, secrets) {
  if (typeof value === 'string') return scrubValues(value, secrets);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, secrets));
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, secrets);
    return out;
  }
  return value;
}

/** 形状体检：commands 必须是数组、每项带字符串 cmd 与整数 exitCode。不合格的逐项剔除，宁缺毋错。 */
function normalizeProof(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Array.isArray(raw.commands)) return null;
  const commands = [];
  for (const item of raw.commands) {
    if (item === null || typeof item !== 'object') continue;
    if (typeof item.cmd !== 'string' || item.cmd.trim() === '') continue;
    if (!Number.isInteger(item.exitCode)) continue;
    commands.push({
      cmd: item.cmd.slice(0, 500),
      exitCode: item.exitCode,
      summary: typeof item.summary === 'string' ? item.summary.slice(0, 500) : '',
    });
  }
  return {
    commands,
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.filter((a) => typeof a === 'string').slice(0, 50) : [],
    unverified: Array.isArray(raw.unverified) ? raw.unverified.filter((u) => typeof u === 'string').slice(0, 50) : [],
    prematureStop: raw.prematureStop === true,
  };
}

/** 解析 .executor-proof.json 的内容：坏 JSON、形状不符都返回 null（不写进 proof.json，不算有证据）。 */
export function parseProofText(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizeProof(raw);
}

/**
 * 从最终回复原文兜底提取证据块：找最后一个 ```executor-proof ... ``` 围栏，
 * 只取围栏里的 JSON。没有这个块、块里是坏 JSON 都返回 null。
 * 兜底存在的意义：执行端忘了写工作区文件时，回复正文里的块也能留下证据。
 */
export function parseProofFromMessage(messageText) {
  if (typeof messageText !== 'string' || messageText === '') return null;
  const fence = /```executor-proof\s*\n([\s\S]*?)```/g;
  let found = null;
  for (const match of messageText.matchAll(fence)) found = match[1];
  if (found === null) return null;
  return parseProofText(found);
}

/**
 * 回合结算时采集证据并落盘 runs/<id>/proof.json：
 * 工作区 .executor-proof.json 优先（执行端的主通道）；没有就从最终回复的
 * ```executor-proof 块兜底提取。两处都没有、或内容不合格式：删除残留 proof.json 返回 null——
 * 上一回合的证据绝不能冒充本回合的（误用旧证据比没证据更糟）。
 * 落盘前按值脱敏（密钥值不进任何 runs 文件，与 pending.json 同一红线）。
 * 任何文件/解析异常都不外抛：证据采集失败不能砸掉回合结算本身。
 */
/**
 * 回合开始时的证据文件基线快照：记录工作区 .executor-proof.json 是否存在、
 * 内容与 stat 指纹。结算时文件指纹与基线完全一致 = 不是本轮写的，不认领——
 * 执行端可能只是没清理上一回合的文件，旧证据绝不能冒充本轮的。
 */
export function snapshotProofFile(cwd) {
  try {
    const file = path.join(cwd, PROOF_FILE_NAME);
    const st = statSync(file);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, content: readFileSync(file, 'utf8') };
  } catch {
    return { exists: false };
  }
}

/** 文件相对基线有没有变化：不存在↔存在、inode/大小/mtime 或内容任一不同都算本轮动过。 */
function proofFileChanged(cwd, baseline) {
  const file = path.join(cwd, PROOF_FILE_NAME);
  let st = null;
  try {
    st = statSync(file);
  } catch {
    return baseline?.exists === true ? 'removed' : null; // 本来就没有且现在也没有：没变化
  }
  if (!baseline?.exists) return 'created';
  if (st.ino !== baseline.ino || st.size !== baseline.size || st.mtimeMs !== baseline.mtimeMs) return 'modified';
  let content = null;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return 'unreadable';
  }
  return content !== baseline.content ? 'modified' : null;
}

export function collectProof({ cwd, dir, messageText, secrets, baseline }) {
  try {
    const proofPath = path.join(dir, 'proof.json');
    let proof = null;
    let source = null;
    // 工作区文件必须相对回合开始时的基线有变化才认领——指纹一致的旧文件跳过。
    // baseline 未传（单元测试/直调）时按宽松语义：文件在就认领；runner 永远显式传快照
    const changed = baseline === undefined ? (existsSync(path.join(cwd, PROOF_FILE_NAME)) ? 'unknown-baseline' : null) : proofFileChanged(cwd, baseline);
    if (changed && changed !== 'removed') {
      const file = path.join(cwd, PROOF_FILE_NAME);
      try {
        proof = parseProofText(readFileSync(file, 'utf8'));
        source = proof ? 'workspace-file' : null;
      } catch {
        proof = null; // 读不了：走消息兜底
      }
    }
    if (!proof) {
      proof = parseProofFromMessage(messageText);
      source = proof ? 'message-fence' : null;
    }
    if (!proof) {
      try {
        unlinkSync(proofPath); // 上一回合的残留必须清掉：旧证据冒充新证据比没证据更糟
      } catch { /* 不存在或目录没了：清理失败不影响结算（读者对坏 JSON/空文件按 null 处理） */ }
      return null;
    }
    const scrubbed = scrubDeep(proof, secrets);
    writeJsonAtomic(proofPath, { ...scrubbed, source, collectedAt: new Date().toISOString() });
    return scrubbed;
  } catch {
    return null;
  }
}

/**
 * 归档工作区的 .executor-checkpoint.md 到 runs/<id>/checkpoint.md。
 * 工作区里没有就返回 null（不删 runs 里已有的：上一回合的断点在续跑前仍有价值）。
 * 失败不外抛。
 */
export function archiveCheckpoint({ cwd, dir, secrets }) {
  try {
    const src = path.join(cwd, CHECKPOINT_FILE_NAME);
    if (!existsSync(src)) return null;
    const dst = path.join(dir, 'checkpoint.md');
    // 与 proof.json 同一红线——按值脱敏后才进长期记录，0600 私有权限原子写入。
    // 源文件只读（readFileSync），绝不复制后再改：copyFileSync 会把原文（含未脱敏敏感值）
    // 完整落进 runs/，等于防护开了个旁路
    const text = scrubValues(readFileSync(src, 'utf8'), secrets ?? []);
    writeFileAtomic(dst, text);
    return dst;
  } catch {
    return null;
  }
}

/**
 * 超时/取消回合的续跑命令：只有工作区确有改动或有断点文件才值得给——
 * 啥都没有的回合从头再来比重读断点更干净。
 * 返回可直接整行复制的 shell 命令；不满足条件返回 null。
 */
export function resumeHintFor({ sessionId, task, checkpointPath, hasChanges }) {
  if (!hasChanges && !checkpointPath) return null;
  const readWhat = checkpointPath ? `先读 ${checkpointPath}` : '先查 git status';
  const instruction = `${readWhat}，从断点继续完成剩余工作，不要重复已完成步骤。`;
  const parts = ['zcode-executor', 'send', sessionId, shQuote(instruction)];
  if (typeof task === 'string' && task !== '') parts.push('--task', shQuote(task));
  return parts.join(' ');
}

/** 读 proof.json 并折算成上游一眼能判的摘要；没有文件或坏 JSON 返回 null。 */
export function proofSummaryOf(dir) {
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, 'proof.json'), 'utf8'));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.commands)) return null;
  return {
    commands: raw.commands.length,
    failed: raw.commands.filter((c) => Number.isInteger(c?.exitCode) && c.exitCode !== 0).length,
    artifacts: Array.isArray(raw.artifacts) ? raw.artifacts.length : 0,
    unverified: Array.isArray(raw.unverified) ? raw.unverified.length : 0,
    prematureStop: raw.prematureStop === true,
  };
}

/**
 * investigate 止损提示：任务类型是 investigate、回合还在跑且已超止损阈值时，
 * 给上游工头一条可直接复制的 --steer 命令，注入「停止继续打补丁，改写最小复现脚本并汇报现状」。
 * 阈值按 state.current.startedAt 算（真实等待时长，不是墙上时钟差的一眼估）。
 * 非 investigate、还在阈值内、state 不全都返回 null。
 */
export function investigateSteerHint({ state, sessionId, nowMs = Date.now(), thresholdSec = INVESTIGATE_STOP_LOSS_SEC }) {
  const current = state?.current;
  if (!current || current.taskType !== 'investigate') return null;
  const startedMs = Date.parse(current.startedAt ?? '');
  if (!Number.isFinite(startedMs)) return null;
  const elapsedSec = Math.floor((nowMs - startedMs) / 1000);
  if (elapsedSec < thresholdSec) return null;
  const command = `zcode-executor send ${sessionId} ${shQuote('排查已超时未结算。停止继续打补丁：改写最小复现/证伪脚本，汇报当前根因假设与已排除项。')} --steer`;
  return { taskType: 'investigate', elapsedSec, thresholdSec, command };
}
