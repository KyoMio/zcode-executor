// 本文件负责：闸门自保的文本判据（审计 D2）——命令原文有没有指向本工具的数据目录（stateRefIn），
// 有没有调本工具的 CLI（cliCallIn），以及一个已解析的绝对路径在不在数据目录的管控面里（inControlPlane）。
// 为什么要有：执行端 ZCode 与 runner 是同一个用户，它写 answer.json、或者直接跑
// `zcode-executor approve`，文件权限和属主校验一概挡不住；人工闸门是「模型审批只产出放行或转人工」
// 能成立的前提（decisions D3），所以这两样不交给模型判，机械转人工。
// 不负责：解析 shell。这里只认直白的写法——字面路径、`~`、`$HOME`、`$PWD`、相对的 `..`、CLI 名后跟
// 子命令；拼变量、编码、先写脚本再跑这类绕法认不出来，仍归模型审批与人（decisions D23 记了这条边界）。
// 也不负责路径的符号链接解析（hard.mjs 解析好递进来）与命中后的挂起（lib/gate.mjs）。
// 被依赖方：同层 hard.mjs。只依赖 node:path。

import path from 'node:path';

/** 命中时挂在这条 hard 规则名下（rules.mjs：让后续操作不再经过这道闸门）。 */
export const SELF_GUARD_RULE_ID = 'self-modify-approval';

// 数据目录里唯一放行的一块：默认的执行副本根（config.mjs 的 allowedRoots 缺省值 <home>/worktrees）。
// 执行端在自己的执行副本里干活，命令带着这一段绝对路径是日常，拦它就是误报海。
const WORKTREES_DIR = 'worktrees';
// 外壳 lib/cli/common.mjs 的 COMMANDS 加内部的 _runner。闸门层不能 import 外壳，这里另记一份，
// test/review.test.mjs 有用例钉着两边一致。
export const CLI_SUBCOMMANDS = [
  'doctor', 'models', 'list', 'new', 'send', 'follow', 'status', 'cancel', 'approve', 'deny', 'answer', 'quota', 'watch', '_runner',
];
// CLI 名（前面不是名字字符，所以 .zcode-executor 这个目录名、my-zcode-executor 都不算；带路径、带 @版本 都算）
// 后面隔着 gap 跟一个子命令。子命令后面不能再接名字字符：`grep zcode-executor status.md`、
// `git clone …/zcode-executor new-dir` 不算调用。
const cliCallPattern = (gap) => new RegExp(
  `(?:^|[^A-Za-z0-9_.\\-])(zcode-executor(?:@[\\w.\\-]+)?(?:${gap})+(?:${CLI_SUBCOMMANDS.join('|')}))(?![\\w.\\-/])`,
);
// shell 里换行是下一条命令（`cd zcode-executor` 的下一行以 status= 开头不是调用），反斜杠续行才算同一条
const CLI_CALL_SHELL = cliCallPattern('[ \\t\'"]|\\\\\\r?\\n');
// js 工具里是 spawn('zcode-executor', ['approve', …]) 的写法，参数之间隔着逗号、方括号、换行
const CLI_CALL_CODE = cliCallPattern('[\\s\'",[\\]]');
const NAME_CHAR = /[A-Za-z0-9_.\-]/;
// 一段路径写到哪为止：空白、引号和 shell 的分隔符。`$`、反引号、反斜杠也停，但停在它们上面说明后面还有
// 运行时才知道的内容，这种路径不给豁免
const PATH_REST = /^[^\s'"`;&|<>()$\\,:=]*/;
const TOKEN_SPLIT = /[\s'"`;&|<>()=,:]+/;
const SNIPPET_MAX = 200;

const unique = (list) => [...new Set(list)];
const clip = (text) => (text.length > SNIPPET_MAX ? `${text.slice(0, SNIPPET_MAX)}…` : text);

/**
 * 管控面：数据目录的几种写法（配置里的、解析符号链接后的）与执行副本的几种写法。
 * realpathOf 由 hard.mjs 给（照内核逐段解析）；home 是用户家目录，展开 `~` 与 `$HOME` 用。
 */
export function controlPlaneZone({ stateDir, cwd, home, realpathOf }) {
  const stateAbs = path.resolve(stateDir);
  const cwdAbs = path.resolve(cwd);
  return {
    states: unique([stateAbs, realpathOf(stateAbs)]),
    cwds: unique([cwdAbs, realpathOf(cwdAbs)]),
    cwd: cwdAbs,
    home,
  };
}

/** child 在 parent 之下时返回相对的各段（就是 parent 自己返回空数组），不在返回 null。大小写不敏感，见 inControlPlane。 */
function segmentsUnder(child, parent) {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  if (c === p) return [];
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  if (!c.startsWith(prefix)) return null;
  return child.slice(prefix.length).split(path.sep).filter((s) => s !== '');
}

/**
 * 绝对路径（已归一）在不在管控面里：在数据目录之下，又不在放行的两块里——默认执行副本根 worktrees/，
 * 以及本会话的执行副本（它在数据目录里面时；反过来执行副本把数据目录包在里面的，不算放行）。
 * 数据目录的比对不分大小写：macOS 默认的文件系统不分，`~/.ZCODE-EXECUTOR` 是同一个地方；
 * 分大小写的系统上多拦一个不存在的目录，无妨。放行的两块按原样比，宁可少放。
 */
export function inControlPlane(absPath, zone) {
  for (const state of zone.states) {
    const rest = segmentsUnder(absPath, state);
    if (rest === null) continue;
    if (rest[0] === WORKTREES_DIR) continue;
    const ownCopy = zone.cwds.some((cwd) => {
      const cwdRest = segmentsUnder(cwd, state);
      if (cwdRest === null || cwdRest.length === 0) return false;
      return absPath === cwd || absPath.startsWith(cwd + path.sep);
    });
    if (ownCopy) continue;
    return true;
  }
  return false;
}

/** 把 shell 里指家目录、当前目录、数据目录的几种直白写法换成绝对路径，后面按字面找。 */
function expandShellPaths(text, zone) {
  return text
    .replace(/\$\{ZCODE_EXECUTOR_HOME\}|\$ZCODE_EXECUTOR_HOME(?![A-Za-z0-9_])/g, () => zone.states[0])
    .replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, () => zone.home)
    .replace(/\$\{PWD\}|\$PWD(?![A-Za-z0-9_])/g, () => zone.cwd)
    .replace(/(^|[\s'"`;&|<>()=,:])~(?=$|[/\s'"`;&|<>()])/g, (_, lead) => `${lead}${zone.home}`);
}

/**
 * 命令原文里指向管控面的那一段；没有返回 undefined。两遍：
 * ① 按字面找数据目录的绝对路径（`~`、`$HOME` 已展开）。贴在选项后面（`-o/…/answer.json`）、带引号、
 *   带空格都找得到；落在更长路径中间的（`/mnt<数据目录>` 这种）不算，留给 ②。
 * ② 逐词按执行副本根做词法解析，认相对写法（执行副本默认就在数据目录里，`../../runs/…` 两步就到）。
 */
export function stateRefIn(text, zone) {
  const expanded = expandShellPaths(text, zone);
  const lower = expanded.toLowerCase();
  for (const state of zone.states) {
    const needle = state.toLowerCase();
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if (end < expanded.length && NAME_CHAR.test(expanded[end])) continue; // .zcode-executor-old 是另一个目录
      const lead = /[^\s'"`;&|<>()=,:]*$/.exec(expanded.slice(0, at))[0];
      if (lead.includes('/')) continue; // 更长路径的中段
      const rest = PATH_REST.exec(expanded.slice(end))[0];
      const stop = expanded[end + rest.length];
      const settled = stop !== '$' && stop !== '`' && stop !== '\\' && !rest.includes('..');
      if (settled && !inControlPlane(path.resolve(`${state}${rest}`), zone)) continue;
      return clip(expanded.slice(at, end + rest.length));
    }
  }
  for (const token of expanded.split(TOKEN_SPLIT)) {
    if (token !== '..' && !token.includes('/')) continue;
    if (inControlPlane(path.resolve(zone.cwd, token), zone)) return clip(token);
  }
  return undefined;
}

/**
 * 原文里调本工具 CLI 的那一段（`zcode-executor approve` 这样）；没有返回 undefined。
 * code 为真按 js 工具的代码认（参数之间可以隔逗号、方括号、换行），否则按 shell 命令认。
 */
export function cliCallIn(text, { code = false } = {}) {
  const match = (code ? CLI_CALL_CODE : CLI_CALL_SHELL).exec(text);
  return match === null ? undefined : clip(match[1]);
}
