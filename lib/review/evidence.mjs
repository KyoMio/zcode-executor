// 本文件负责：给模型审批查事实——EvidenceProbe 探针的形状与 nodeProbe（Node 实现）、
// gatherEvidence（把「目标是否早已存在」「工作区脏不脏」「ssh 主机别名对不对」查成 facts）。
// 这一层不做判断，只报事实：有些事模型只能猜，harness 一查就知道，规则里那些
// 「不适用于」全靠这里的事实才有依据。
// 不负责：把事实塞进提示词（lib/review/prompt.mjs 的 ctx.evidence）、判定本身（T3.2 的 gate）。
// 被依赖方：lib/gate.mjs（用 nodeProbe 或测试假探针喂 gatherEvidence，再把 facts 给 prompt）、
// 同层 hard.mjs（共用 ~ 展开）。
// 来源：作者先前的 TypeScript 审批原型（同作者，无第三方许可证事宜），手工去类型。
//   改动见下方「改：」标记。

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * 探针（原 EvidenceProbe，形状照原样）。抽象出来是为了可测（测试里用假探针），
 * 也为了把「只读、不改任何东西」这件事钉死：
 * - exists(path)：路径存在吗。
 * - mtimeMs(path)：修改时间（毫秒）；取不到返回 undefined。
 * - gitQuery(cwd, args)：在某个目录跑一条只读 git 查询，返回 stdout；失败返回 undefined。
 * - readText(path, maxBytes)：读一小段文本文件；失败返回 undefined。
 */

/**
 * 基于 node fs 的探针实现。**只读**——任何一个方法都不许改动任何东西。
 * 查不到就返回 undefined / false：探针只报事实，查不到意味着「没有这条事实」，
 * 不是错误，所以这里的吞异常是契约的一部分，不是疏忽。
 * 改：原版是常量对象 evidence-node.ts，这里改成工厂函数 nodeProbe()（任务单定的形状）。
 */
export function nodeProbe() {
  return {
    exists(p) {
      try { return existsSync(p); } catch { return false; }
    },
    mtimeMs(p) {
      try { return statSync(p).mtimeMs; } catch { return undefined; }
    },
    gitQuery(cwd, args) {
      try {
        // 只允许只读子命令，防止这一层变成执行通道。gatherEvidence 自己只用 status，
        // 白名单按最小够用收窄，remote 也去掉（T3.1b）。
        const sub = args[0];
        if (sub === undefined || !['status', 'log', 'diff', 'rev-parse'].includes(sub)) {
          return undefined;
        }
        return execFileSync('git', ['-C', cwd, ...args], {
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 3000,
          maxBuffer: 1024 * 1024,
        }).toString();
      } catch { return undefined; }
    },
    readText(p, maxBytes) {
      try { return readFileSync(p, 'utf8').slice(0, maxBytes); } catch { return undefined; }
    },
  };
}

/**
 * gatherEvidence 的输入。command 是命令类工具的命令原文（别的工具为空串）；
 * args 是待判操作的参数；workspaceRoot 是执行副本 cwd；
 * sessionStartedAt 是本次会话开始时间（毫秒），比它早的文件就算会话之前就存在的。
 */

/** 命令里像路径的片段。够查就行，不求全。 */
function pathsIn(command) {
  const raw = command.match(/(?:^|[\s='"])((?:~|\.{1,2})?\/[\w.@+\-/]{2,}|~\/[\w.@+\-/]*)/g) ?? [];
  return raw
    .map((m) => m.replace(/^[\s='"]+/, ''))
    .filter((p, i, a) => a.indexOf(p) === i)
    .slice(0, 6);
}

/** `~` / `~/…` 按家目录展开；其余原样。同层 hard.mjs 与本文件共用一份（T2.9 第 10 条）。 */
export function expandTildePath(p, home) {
  if (p === '~') return home;
  return p.startsWith('~/') ? `${home}/${p.slice(2)}` : p;
}

const expand = expandTildePath;

/** 有删除或覆盖动作吗——只有这时才值得去查「目标是不是早就存在」。 */
const DESTRUCTIVE = /(^|[\s;&|(])(rm|rmdir|unlink|shred|mv)([\s;&|)]|$)|(^|\s)>(?!>)/;
/** 会丢弃未提交改动的 git 动作。 */
const GIT_DISCARD = /git\s+(reset\s+--hard|checkout\s+--|restore\s+\.|clean\s+-[a-z]*f|stash\s+(drop|clear))/;

/** 查事实，返回 { facts: string[] }，facts 逐条直接进提示词。 */
export function gatherEvidence(input) {
  const facts = [];
  const { command, workspaceRoot, probe, home, sessionStartedAt } = input;

  // 目标是不是会话之前就存在的——del-preexisting 的「不适用于」全靠它。
  const target = typeof input.args?.file_path === 'string'
    ? [input.args.file_path]
    : DESTRUCTIVE.test(command) ? pathsIn(command) : [];
  for (const raw of target) {
    const path = expand(raw, home);
    if (!probe.exists(path)) {
      facts.push(`\`${raw}\` 目前不存在（所以不是「删除既有文件」，是新建或删一个不存在的东西）`);
      continue;
    }
    const mtime = probe.mtimeMs(path);
    if (mtime === undefined) continue;
    facts.push(mtime < sessionStartedAt
      ? `\`${raw}\` 在本次会话开始前就存在（最后修改于会话之前）`
      : `\`${raw}\` 是本次会话期间创建或修改的`);
  }

  // 工作区脏不脏——git-discard-uncommitted 的「不适用于」靠它。
  if (workspaceRoot !== undefined && GIT_DISCARD.test(command)) {
    const status = probe.gitQuery(workspaceRoot, ['status', '--porcelain']);
    if (status !== undefined) {
      const lines = status.split('\n').filter((l) => l.trim() !== '');
      facts.push(lines.length === 0
        ? '工作区当前没有未提交改动（这次丢弃不会丢掉任何东西）'
        : `工作区当前有 ${lines.length} 处未提交改动，这次操作会丢掉它们`);
    }
  }

  // 远程主机在不在 ssh config 里——用户口中的别名能不能对上。
  const sshHost = /(?:^|[\s;&|(])ssh\s+(?:-\S+\s+(?:\S+\s+)?)*([^\s;&|-][^\s;&|]*)/.exec(command)?.[1];
  if (sshHost !== undefined) {
    const host = sshHost.split('@').pop()?.split(':')[0];
    const config = probe.readText(`${home}/.ssh/config`, 20_000);
    if (host !== undefined && config !== undefined) {
      const known = new RegExp(`^\\s*Host\\s+.*\\b${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'im').test(config);
      facts.push(known
        ? `\`${host}\` 是 ssh config 里已配置的主机别名`
        : `\`${host}\` 不在 ssh config 里（可能是 IP、临时地址、或别处定义的别名）`);
    }
  }

  return { facts };
}
