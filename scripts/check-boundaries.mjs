// 本文件负责：四层架构边界与安全红线的静态扫描（ZCE-1 / ZCE-7），纯 Node fs + 词法/语法扫描，零第三方依赖。
// 挂在 npm test 末尾：任何违规直接非零退出，报错必带精确修复指引。
// 检查项：
//   1. 四层依赖方向——hooks/ 不 import lib/；dsh-plugin/src/ 不 import 根 lib/（只走 watch --json）；
//      lib/cli/ 不直连 appserver.mjs；协议层 appserver/session 不反向 import 工作流/闸门层。
//   2. 凭据只读红线——全仓可执行代码禁止对 ~/.zcode/v2 路径做写/删/重命名。
//   3. 临时密钥清理守卫——调用 mkdtemp / writePersonalProviderFile 的文件必须有 try/finally 或 dispose 清理路径。
//   4. 文档测试数防漂移——README 徽章里的测试总数必须与 node --test 静态计数一致。
//   5. 禁止借口注释——lib/、hooks/、dsh-plugin/src/ 的注释中禁止出现 workaround/hack/权宜/临时借口/TODO/FIXME/XXX。
// 不负责：类型检查（tsconfig.checkjs.json 的事）、运行时行为验证（test/ 的事）。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function* walk(dir, exts) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(full, exts);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      yield full;
    }
  }
}

function linesOf(file) {
  return readFileSync(file, 'utf8').split('\n');
}

// ── 词法注释提取（检查 5 共用） ──
// 跳过单引号/双引号字符串、模板字符串（含 ${...} 嵌套）与单行正则字面量，
// 避免把 URL（'https://...'）或字符串里的词语误判成注释。
const REGEX_PRECEDING_WORD = new Set([
  'return', 'throw', 'case', 'typeof', 'void', 'delete', 'await', 'yield', 'in', 'instanceof', 'else', 'do', 'new',
]);
const REGEX_PRECEDING_CHAR = new Set(['(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>']);

function canPrecedingStartRegex(src, slashIdx) {
  let j = slashIdx - 1;
  while (j >= 0 && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j -= 1;
  if (j < 0) return true;
  const ch = src[j];
  // 排除 JSX 闭合标签 `</tag>` 与自闭合标签前，以及 `++`/`--` 后缀
  if (ch === '<' && src[slashIdx + 1] && /[A-Za-z>]/.test(src[slashIdx + 1])) return false;
  if (ch === '+' && src[j - 1] === '+') return false;
  if (ch === '-' && src[j - 1] === '-') return false;
  if (REGEX_PRECEDING_CHAR.has(ch)) return true;
  if (/[A-Za-z0-9_$]/.test(ch)) {
    let k = j;
    while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k -= 1;
    const word = src.slice(k + 1, j + 1);
    return REGEX_PRECEDING_WORD.has(word);
  }
  return false;
}

/**
 * 提取源码中的所有注释行，返回 [{ line, text }]（1-based 行号；块注释按行拆开以便精准报行）。
 *
 * JSX/TSX 感知（ZCE-7/PR#19 回修）：在 JSX 文本区里，撇号是文案不是字符串开头、
 * // 与 /<star> 是文案不是注释——例如 <p>Don't https://example.test/TODO</p>。
 * 只有花括号 { ... } 内部回到 JavaScript 代码区，其中的注释才参与提取。
 * 判定规则（启发式，覆盖本仓排版风格）：
 *  - 代码区里 `<` 后接字母/`>`、且前一个非空白字符属于 JSX 起始上下文
 *    （空白本身、( , [ { = : ; , ! & | ? + - * % ~ < > 或行首）→ JSX 标签；
 *    紧贴标识符的 `<`（泛型 useState<string>、比较 a<b）不当作 JSX。
 *  - JSX 文本区里 `<` 接字母/`/`/`>` 开新标签；`</` 闭合当前层；`/>` 或 `</>` 不增层。
 *  - 文本区里 `{` 进入代码（剥到配对的 `}` 回来）；字符串、模板、正则的既有规则不变。
 * @param {string} src
 * @returns {Array<{ line: number, text: string }>}
 */
export function extractComments(src) {
  const out = [];
  const len = src.length;
  let line = 1;
  let i = 0;
  // 词法模式栈：'code'（顶层或 JSX 花括号/模板 ${} 内部）、'template'、'jsxtext'、'jsxtag'
  const stack = ['code'];
  const braceDepths = [0];
  // JSX 元素嵌套层数；为 0 时弹出最后一个 JSX 模式即回到纯代码
  let jsxDepth = 0;

  const topMode = () => stack[stack.length - 1];
  const inCode = () => topMode() === 'code';
  const inJsx = () => topMode() === 'jsxtext' || topMode() === 'jsxtag';

  // 代码区里 `<` 是否开启 JSX：后随字母或 >，且前文处于表达式起始位置
  const jsxOpenAhead = (idx) => {
    const next = src[idx + 1];
    if (next === undefined) return false;
    if (!/[A-Za-z>]/.test(next)) return false;
    let j = idx - 1;
    while (j >= 0 && (src[j] === ' ' || src[j] === '\t' || src[j] === '\n' || src[j] === '\r')) j -= 1;
    if (j < 0) return true;
    const prev = src[j];
    if (prev === '>' && src[j - 1] === '=') return true; // 箭头 =>
    if ('([{=:;,!&|?+-*%~<>'.includes(prev)) return true;
    if (/[A-Za-z0-9_$]/.test(prev)) {
      // return/throw/case 等关键词之后是表达式起始位置：< 当作 JSX
      let k = j;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k -= 1;
      const word = src.slice(k + 1, j + 1);
      return ['return', 'throw', 'case', 'yield', 'await', 'else', 'do', 'typeof', 'void', 'delete'].includes(word);
    }
    return false;
  };

  while (i < len) {
    const mode = topMode();
    const ch = src[i];

    if (mode === 'template') {
      if (ch === '\\') {
        if (src[i + 1] === '\n') line += 1;
        i += 2;
        continue;
      }
      if (ch === '`') {
        stack.pop();
        braceDepths.pop();
        i += 1;
        continue;
      }
      if (ch === '$' && src[i + 1] === '{') {
        stack.push('code');
        braceDepths.push(0);
        i += 2;
        continue;
      }
      if (ch === '\n') line += 1;
      i += 1;
      continue;
    }

    if (mode === 'jsxtext') {
      if (ch === '\n') {
        line += 1;
        i += 1;
        continue;
      }
      if (ch === '{') {
        // 花括号回到 JavaScript 代码区；其中的注释参与提取
        stack.push('code');
        braceDepths.push(0);
        i += 1;
        continue;
      }
      if (ch === '<') {
        const next = src[i + 1];
        if (next !== undefined && /[A-Za-z/>]/.test(next)) {
          stack.push('jsxtag');
          braceDepths.push(0);
          if (next !== '/') jsxDepth += 1; // </x> 与 </> 是闭合，不新增层
          i += 1;
          continue;
        }
        i += 1;
        continue;
      }
      // 其余一切（撇号、//、URL、TODO 字样……）都是文案，不是代码
      i += 1;
      continue;
    }

    if (mode === 'jsxtag') {
      if (ch === '\n') {
        line += 1;
        i += 1;
        continue;
      }
      if (ch === '{') {
        // 属性里的表达式花括号回到代码区
        stack.push('code');
        braceDepths.push(0);
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"') {
        const quote = ch;
        i += 1;
        while (i < len) {
          if (src[i] === '\n') {
            line += 1;
            i += 1;
            break;
          }
          if (src[i] === quote) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }
      if (ch === '/') {
        if (src[i + 1] === '>') {
          // 自闭合 </x> 之前的 />：这一层不开口
          jsxDepth = Math.max(0, jsxDepth - 1);
          stack.pop();
          braceDepths.pop();
          if (jsxDepth === 0 && topMode() === 'jsxtext') {
            stack.pop();
            braceDepths.pop();
          }
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (ch === '>') {
        const wasClose = isCloseTag(src, i);
        stack.pop();
        braceDepths.pop();
        if (wasClose) {
          // 闭合标签：元素层数配平；归零时连文本区一起退出，回到上级代码模式
          jsxDepth = Math.max(0, jsxDepth - 1);
          if (jsxDepth === 0 && topMode() === 'jsxtext') {
            stack.pop();
            braceDepths.pop();
          }
        } else {
          // 开口标签结束，进入该元素的文本区
          stack.push('jsxtext');
          braceDepths.push(0);
        }
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // ── mode === 'code' ──
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === '<' && jsxOpenAhead(i)) {
      // 进入 JSX 元素（首个标签直接进文本区决策由 jsxtag 的 > 完成）
      jsxDepth += 1;
      stack.push('jsxtag');
      braceDepths.push(0);
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < len) {
        if (src[i] === '\\') {
          if (src[i + 1] === '\n') line += 1;
          i += 2;
          continue;
        }
        if (src[i] === '\n') {
          line += 1;
          i += 1;
          break;
        }
        if (src[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '`') {
      stack.push('template');
      braceDepths.push(0);
      i += 1;
      continue;
    }
    if (ch === '{') {
      braceDepths[braceDepths.length - 1] += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      if (stack.length > 1 && braceDepths[braceDepths.length - 1] === 0) {
        stack.pop();
        braceDepths.pop();
      } else if (braceDepths[braceDepths.length - 1] > 0) {
        braceDepths[braceDepths.length - 1] -= 1;
      }
      i += 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      const startLine = line;
      i += 2;
      const start = i;
      while (i < len && src[i] !== '\n') i += 1;
      out.push({ line: startLine, text: src.slice(start, i) });
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      let curLine = line;
      let segStart = i;
      while (i < len) {
        if (src[i] === '*' && src[i + 1] === '/') {
          out.push({ line: curLine, text: src.slice(segStart, i) });
          i += 2;
          break;
        }
        if (src[i] === '\n') {
          out.push({ line: curLine, text: src.slice(segStart, i) });
          line += 1;
          curLine = line;
          i += 1;
          segStart = i;
          continue;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] !== '>' && canPrecedingStartRegex(src, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < len && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']' && inClass) inClass = false;
        else if (src[j] === '/' && !inClass) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j < len && /[a-z]/i.test(src[j])) j += 1;
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

// 判断位置 gtIdx（某 `>` 处）所属标签是否闭合标签：回扫到配对的 `<`，看其后是否 /。
function isCloseTag(src, gtIdx) {
  let j = gtIdx - 1;
  while (j >= 0 && src[j] !== '<' && src[j] !== '>' && src[j] !== '\n') j -= 1;
  return j >= 0 && src[j] === '<' && src[j + 1] === '/';
}

const EXCUSE_PATTERNS = [
  { label: '英文借口/标记词', re: /\b(?:workaround|workarounds|hack|hacks|kludge|tempfix|hotfix)\b/i },
  { label: '英文待办/标记词', re: /\b(?:TODO|FIXME|XXX)\b/ },
  { label: '「权宜」注释', re: /权宜/ },
  {
    label: '「临时」借口注释',
    re: /临时(?:方案|补丁|做法|处理|绕过|凑合|跳过|先|顶着|保留|禁用|关闭|兼容|修复|改法|解决|措施|妥协|屏蔽|放行|兜底|代码|写死|改一下|一下|hack|workaround)/i,
  },
  {
    label: '「临时」借口注释',
    re: /(?:先|仅|暂时)临时(?!(?:文件|目录|密钥|个人|provider|名|路径|空间|位置|句柄|缓存|副本))/i,
  },
];

/**
 * 扫描单个文件源码中的借口注释（仅检查注释，不误报字符串字面量与合法「临时文件/目录/密钥」域名名词）。
 * @param {string} src
 * @returns {Array<{ line: number, match: string, label: string }>}
 */
export function scanExcuseComments(src) {
  const hits = [];
  for (const c of extractComments(src)) {
    for (const { label, re } of EXCUSE_PATTERNS) {
      const m = re.exec(c.text);
      if (m) {
        hits.push({ line: c.line, match: m[0], label });
        break;
      }
    }
  }
  return hits;
}

const IMPORT_RE = /import\s*['"]([^'"]+)['"]|(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec !== undefined) out.push({ spec, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

/**
 * 在指定仓库根目录下执行全部边界与红线检查，返回 { violations, actual }。
 * @param {string} [root]
 */
export function runBoundaryChecks(root = defaultRoot) {
  const violations = [];
  const fail = (check, file, line, message, fix) => {
    violations.push({ check, file: relative(root, file), line, message, fix });
  };

  // ── 检查 1：四层依赖方向 ──
  // ① hooks/ 不得 import lib/（运行环境无 Node 完整能力，RULES §1）
  for (const file of walk(join(root, 'hooks'), ['.mjs', '.js'])) {
    for (const imp of importsOf(file)) {
      if (/(^|\/)lib\//.test(imp.spec) || imp.spec.startsWith('../lib')) {
        fail('四层边界', file, imp.line,
          `hooks/ 不可导入 ${imp.spec}`,
          'hooks/ 运行环境没有 Node 完整 lib/ 能力。外壳与后端请走 watch --json 行协议；跨层共用常量放 lib/errors.mjs 之外的独立小文件并复制必要逻辑。');
      }
    }
  }

  // ② dsh-plugin/src/ 不得 import 根 lib/（唯一耦合是 watch --json）
  for (const file of walk(join(root, 'dsh-plugin/src'), ['.ts', '.mts', '.js', '.mjs'])) {
    for (const imp of importsOf(file)) {
      if (/^\.\.\/\.\.\/lib\//.test(imp.spec) || /^\.\.\/\.\.\/\.\.\/lib\//.test(imp.spec)) {
        fail('四层边界', file, imp.line,
          `dsh-plugin 不可导入根 lib/（${imp.spec}）`,
          'dsh-plugin 与 CLI 的唯一耦合是 spawn watch --json 行协议。把需要的逻辑搬进 dsh-plugin/src 内，或改成读 watch 输出。');
      }
    }
  }

  // ③ lib/cli/ 不得绕过工作流层直连 appserver.mjs（协议层入口只能经 session.mjs/run.mjs）
  for (const file of walk(join(root, 'lib/cli'), ['.mjs'])) {
    for (const imp of importsOf(file)) {
      if (/appserver\.mjs$/.test(imp.spec)) {
        fail('四层边界', file, imp.line,
          'lib/cli/ 不可直接导入 appserver.mjs（协议层）',
          '外壳层只能经工作流层（lib/run.mjs）或会话层封装（lib/session.mjs）触达协议层。把需要的调用挪进 run.mjs/session.mjs 再从那里导出。');
      }
    }
  }

  // ④ 协议层 appserver.mjs/session.mjs 不得反向 import 工作流/闸门层（只许 errors/scrub 等协议内文件）
  const PROTOCOL_ALLOW = new Set(['./errors.mjs', './scrub.mjs']);
  for (const name of ['lib/appserver.mjs', 'lib/session.mjs']) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    for (const imp of importsOf(file)) {
      if (imp.spec.startsWith('./') && !PROTOCOL_ALLOW.has(imp.spec)) {
        fail('四层边界', file, imp.line,
          `协议层 ${name} 不可反向导入 ${imp.spec}（工作流/闸门/配置层）`,
          '依赖方向只能自上而下：外壳→工作流→闸门→协议。协议层需要的共用物放 lib/errors.mjs 或 lib/scrub.mjs；更上层的逻辑由调用方注入参数，不在协议层 import。');
      }
    }
  }

  // ── 检查 2：凭据只读红线 ──
  const WRITE_RE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|rmSync|rm\(|unlinkSync|unlink\(|renameSync|rename\()/;
  const ZCODE_V2_RE = /\.zcode|zcode\/v2/;
  for (const dir of ['bin', 'lib', 'hooks', 'scripts']) {
    for (const file of walk(join(root, dir), ['.mjs', '.js'])) {
      if (file.endsWith('check-boundaries.mjs')) continue; // 本扫描器自身的正则字面量豁免
      for (const [index, line] of linesOf(file).entries()) {
        if (WRITE_RE.test(line) && ZCODE_V2_RE.test(line)) {
          fail('凭据只读', file, index + 1,
            '严禁写入/删除/重命名 ~/.zcode/v2 下的配置',
            '请改用 mkdtemp 在 os.tmpdir() 下创建隔离临时文件（0600），并在 finally 中清理。参考 lib/providers.mjs 的 writePersonalProviderFile。');
        }
      }
    }
  }

  // ── 检查 3：临时密钥清理守卫 ──
  const TEMP_TRIGGERS = /\bmkdtemp(Sync)?\s*\(|writePersonalProviderFile\s*\(/;
  for (const dir of ['bin', 'lib', 'scripts']) {
    for (const file of walk(join(root, dir), ['.mjs', '.js'])) {
      const src = readFileSync(file, 'utf8');
      if (!TEMP_TRIGGERS.test(src)) continue;
      if (file.endsWith('check-boundaries.mjs')) continue;
      if (file.endsWith('lib/providers.mjs')) continue;
      const hasFinally = /\bfinally\s*\{/.test(src);
      const hasDispose = /\.dispose\s*\(\s*\)/.test(src);
      const hasCleanupCall = /\brm(Sync)?\s*\(|\bunlink(Sync)?\s*\(/.test(src);
      if (!hasFinally && !(hasDispose && hasCleanupCall === false) && !(hasDispose || hasCleanupCall)) {
        fail('临时密钥清理', file, 1,
          '该文件创建了临时密钥文件/目录，但找不到 try/finally、.dispose() 或 rm/unlink 清理路径',
          'spawn/网络异常时临时密钥文件会残留在 os.tmpdir()。把清理语句放进 try { ... } finally { ... } 块（参考 lib/offpeak-check.mjs），或确认调用方 dispose 句柄（参考 lib/run.mjs）。');
      } else if (!hasFinally && !hasDispose && hasCleanupCall) {
        fail('临时密钥清理', file, 1,
          '该文件的 rm/unlink 清理不在 finally 块内，异常路径会泄漏临时密钥文件',
          '把 rm/unlink 挪进 try { ... } finally { ... }，保证 spawn 失败、网络异常、进程被取消时都执行清理。');
      }
    }
  }

  // ── 检查 4：文档测试数防漂移 ──
  function countTests() {
    let total = 0;
    const dir = join(root, 'test');
    if (!existsSync(dir)) return 0;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.test.mjs')) continue;
      const src = readFileSync(join(dir, entry), 'utf8');
      for (const _m of src.matchAll(/(?:^|\s)(?:test|it)(?:\.skip|\.todo)?\s*\(/g)) total += 1;
    }
    return total;
  }
  const actual = countTests();
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const file = join(root, readme);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    if (/tests-passing/.test(src) && !/tests-\d+%20passing/.test(src)) continue;
    const m = /tests-(\d+)%20passing/.exec(src);
    if (m === null) {
      fail('文档测试数', file, 1,
        `${readme} 找不到 tests-NNN%20passing 徽章或无数字 tests-passing 徽章`,
        '要么恢复徽章并保持数字同步，要么删掉手写数字改用无数字徽章（tests-passing），消除手工同步债。');
      continue;
    }
    const documented = Number(m[1]);
    if (documented !== actual) {
      fail('文档测试数', file, 1,
        `${readme} 徽章写 ${documented} passing，实际 test/ 静态计数 ${actual}`,
        `把两份 README 的 tests-${documented}%20passing 改成 tests-${actual}%20passing；或彻底改为不写死数字的徽章（消除手工同步债）。发版脚本 sync-doc-version.mjs 不管这个数字，靠本检查盯防。`);
    }
  }

  // ── 检查 5：禁止借口注释 ──
  for (const dir of ['lib', 'hooks', 'dsh-plugin/src']) {
    for (const file of walk(join(root, dir), ['.mjs', '.js', '.ts', '.tsx'])) {
      const src = readFileSync(file, 'utf8');
      for (const hit of scanExcuseComments(src)) {
        fail('禁止借口注释', file, hit.line,
          `注释包含禁止的${hit.label}：「${hit.match}」`,
          '删除 workaround/hack/临时借口/权宜 注释；若为真实协议或架构取舍请归档至 docs/decisions.md（续编 D 编号）并在必要处仅保留简短决策引用或协议事实；若为缺陷请直接修复根因。');
      }
    }
  }

  return { violations, actual };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const rootArgIdx = process.argv.indexOf('--root');
  const targetRoot = rootArgIdx !== -1 && process.argv[rootArgIdx + 1]
    ? resolve(process.argv[rootArgIdx + 1])
    : defaultRoot;
  const { violations, actual } = runBoundaryChecks(targetRoot);
  if (violations.length > 0) {
    console.error(`check-boundaries: ${violations.length} 处违规\n`);
    for (const v of violations) {
      console.error(`✗ [${v.check}] ${v.file}:${v.line}`);
      console.error(`  违规: ${v.message}`);
      console.error(`  修复: ${v.fix}\n`);
    }
    process.exit(1);
  }
  console.log(`check-boundaries: 四层边界 / 凭据只读 / 临时密钥清理 / 文档测试数（${actual}）/ 禁止借口注释 全部通过`);
}
