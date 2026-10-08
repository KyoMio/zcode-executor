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
import os from 'node:os';
import process from 'node:process';

// 审计 D6：探针在执行副本里跑 git，而执行副本的 .git/config 与 .gitattributes 执行端改得动——
// core.fsmonitor、外部 diff、textconv、钩子、filter 驱动都能让一条「只读」的 git 把它指定的程序跑起来。
// 探针是 runner 自己的进程，跑起来的东西不经闸门。所以这些口子一律在命令行上关掉（-c 压过仓库配置）：
// --no-optional-locks 让 status 不回写索引（也就不触发 post-index-change 钩子）；filter 驱动见 filterOverrides。
// 关不掉的：子模块自己的配置（status 会进已检出的子模块再跑一遍 git，那边的 filter 驱动名这里列不到），
// decisions D23 记了这条。git 本来就不保证在不可信的仓库配置下安全，这里只是把已知的开关关上。
const GIT_SAFE_OPTIONS = [
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', `core.hooksPath=${os.devNull}`,
  '-c', 'log.showSignature=false', // 开着的话 git log 会去跑 gpg.program
];
// 会出 diff 的两个子命令另加：不调外部 diff 程序、不跑 textconv
const GIT_DIFF_SAFE_OPTIONS = ['--no-ext-diff', '--no-textconv'];
// 与 lib/cli/common.mjs 的 worktreeStatus 同一张表（闸门层不 import 外壳，另记一份）：这些变量压过 -C，
// 带着它们查到的是别的仓库（2026-10-02 实测）
const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];

// 环境里带进来的 -c（GIT_CONFIG_PARAMETERS、GIT_CONFIG_COUNT）也清掉：它们压得过下面 filterOverrides 的置空
const GIT_INHERITED_CONFIG_ENV = ['GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT'];
const GIT_PROBE_EXEC = { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, maxBuffer: 1024 * 1024 };

function gitProbeEnv() {
  const env = { ...process.env };
  for (const key of [...GIT_LOCATION_ENV, ...GIT_INHERITED_CONFIG_ENV, 'GIT_EXTERNAL_DIFF']) delete env[key];
  return env;
}

/**
 * 把仓库配置里的 filter 驱动逐个置空，返回要并进环境的 GIT_CONFIG_* 变量。
 * filter.<名字>.clean / smudge / process：.gitattributes 一指，git 比对文件内容前就把它跑起来（status、
 * diff 都会；2026-10-08 git 2.54.0 实测）。名字是仓库自己起的，没法用固定的 -c 关，所以先把定义了命令的
 * 驱动名列出来（读配置不执行任何东西）再逐个盖掉：process 置成空串后 clean / smudge 不再被采用，空串本身
 * 也不执行。走环境变量不走 -c，是因为驱动名里可以有等号，-c 的 name=value 写法表达不了。
 * 列不出来（超时、不是仓库）原样抛出——调用方不查了，返回 undefined。
 */
function filterOverrides(cwd, env) {
  let listed;
  try {
    listed = execFileSync(
      'git',
      ['-C', cwd, 'config', '-z', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'],
      { ...GIT_PROBE_EXEC, env },
    ).toString();
  } catch (err) {
    if (err?.status === 1) return {}; // 一个匹配的键都没有时 git config 退 1
    throw err;
  }
  const names = [...new Set(listed.split('\0').filter(Boolean).map((key) => key.slice('filter.'.length, key.lastIndexOf('.'))))];
  const pairs = names.flatMap((name) => [
    [`filter.${name}.process`, ''],
    [`filter.${name}.clean`, ''],
    [`filter.${name}.smudge`, ''],
    [`filter.${name}.required`, 'false'], // required 的驱动没跑成 git 会报错退出，探针就查不到事实了
  ]);
  const overrides = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([key, value], i) => {
    overrides[`GIT_CONFIG_KEY_${i}`] = key;
    overrides[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return overrides;
}

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
        const diffSafe = sub === 'diff' || sub === 'log' ? GIT_DIFF_SAFE_OPTIONS : [];
        const env = gitProbeEnv();
        return execFileSync('git', ['-C', cwd, ...GIT_SAFE_OPTIONS, sub, ...diffSafe, ...args.slice(1)], {
          ...GIT_PROBE_EXEC,
          env: { ...env, ...filterOverrides(cwd, env) },
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
