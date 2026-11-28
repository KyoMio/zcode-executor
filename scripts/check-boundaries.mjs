// 本文件负责：四层架构边界与安全红线的静态扫描（ZCE-1），纯 Node fs + 语法扫描，零第三方依赖。
// 挂在 npm test 末尾：任何违规直接非零退出，报错必带精确修复指引。
// 检查项：
//   1. 四层依赖方向——hooks/ 不 import lib/；dsh-plugin/src/ 不 import 根 lib/（只走 watch --json）；
//      lib/cli/ 不直连 appserver.mjs；协议层 appserver/session 不反向 import 工作流/闸门层。
//   2. 凭据只读红线——全仓可执行代码禁止对 ~/.zcode/v2 路径做写/删/重命名。
//   3. 临时密钥清理守卫——调用 mkdtemp / writePersonalProviderFile 的文件必须有 try/finally 或 dispose 清理路径。
//   4. 文档测试数防漂移——README 徽章里的测试总数必须与 node --test 静态计数一致。
// 不负责：类型检查（tsconfig.checkjs.json 的事）、运行时行为验证（test/ 的事）。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const violations = [];

function fail(check, file, line, message, fix) {
  violations.push({ check, file: relative(root, file), line, message, fix });
}

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

// ── 检查 1：四层依赖方向 ──
// 外壳（bin/ + lib/cli/ + hooks/ + dsh-plugin/）→ 工作流 → 闸门 → 协议；跨层共用只许 lib/errors.mjs。
const IMPORT_RE = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file) {
  const src = readFileSync(file, 'utf8');
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec !== undefined) out.push({ spec, line: src.slice(0, m.index).split('\n').length });
  }
  return out;
}

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
// ~/.zcode/v2 的 config.json/credentials.json 绝对只读。写操作出现在拼接了 zcode/v2 路径的语句上即违规。
const WRITE_RE = /\b(writeFileSync|writeFile|appendFileSync|appendFile|rmSync|rm\(|unlinkSync|unlink\(|renameSync|rename\()/;
const ZCODE_V2_RE = /\.zcode|zcode\/v2/;
for (const dir of ['bin', 'lib', 'hooks', 'scripts']) {
  for (const file of walk(join(root, dir), ['.mjs', '.js'])) {
    if (file.endsWith('check-boundaries.mjs')) continue; // 本扫描器自身的正则字面量豁免
    for (const [index, line] of linesOf(file).entries()) {
      // 同一行同时出现写操作与 zcode/v2 路径拼接才算命中（读操作不受限；loadZcodeConfig 是只读路径）
      if (WRITE_RE.test(line) && ZCODE_V2_RE.test(line)) {
        fail('凭据只读', file, index + 1,
          '严禁写入/删除/重命名 ~/.zcode/v2 下的配置',
          '请改用 mkdtemp 在 os.tmpdir() 下创建隔离临时文件（0600），并在 finally 中清理。参考 lib/providers.mjs 的 writePersonalProviderFile。');
      }
    }
  }
}

// ── 检查 3：临时密钥清理守卫 ──
// 凡调用 mkdtemp / writePersonalProviderFile 的可执行文件，必须存在 try/finally 或 dispose 清理路径；
// 只调 mkdtemp 且全文无 finally 且无 rm/unlink 的，spawn/网络异常时密钥文件必泄漏。
const TEMP_TRIGGERS = /\bmkdtemp(Sync)?\s*\(|writePersonalProviderFile\s*\(/;
for (const dir of ['bin', 'lib', 'scripts']) {
  for (const file of walk(join(root, dir), ['.mjs', '.js'])) {
    const src = readFileSync(file, 'utf8');
    if (!TEMP_TRIGGERS.test(src)) continue;
    if (file.endsWith('check-boundaries.mjs')) continue;
    // providers.mjs 是 writePersonalProviderFile 的定义处：它返回 dispose 句柄，清理责任在调用方，豁免
    if (file.endsWith('lib/providers.mjs')) continue;
    const hasFinally = /\bfinally\s*\{/.test(src);
    const hasDispose = /\.dispose\s*\(\s*\)/.test(src);
    const hasCleanupCall = /\brm(Sync)?\s*\(|\bunlink(Sync)?\s*\(/.test(src);
    if (!hasFinally && !(hasDispose && hasCleanupCall === false) && !(hasDispose || hasCleanupCall)) {
      // 三种合格形态：① try/finally；② 调 .dispose()；③ 直接 rm/unlink（脚本一次性路径）
      fail('临时密钥清理', file, 1,
        '该文件创建了临时密钥文件/目录，但找不到 try/finally、.dispose() 或 rm/unlink 清理路径',
        'spawn/网络异常时临时密钥文件会残留在 os.tmpdir()。把清理语句放进 try { ... } finally { ... } 块（参考 lib/offpeak-check.mjs），或确认调用方 dispose 句柄（参考 lib/run.mjs）。');
    } else if (!hasFinally && !hasDispose && hasCleanupCall) {
      // 有 rm/unlink 但不在 finally 里：正常路径能删，异常路径照样泄漏
      fail('临时密钥清理', file, 1,
        '该文件的 rm/unlink 清理不在 finally 块内，异常路径会泄漏临时密钥文件',
        '把 rm/unlink 挪进 try { ... } finally { ... }，保证 spawn 失败、网络异常、进程被取消时都执行清理。');
    }
  }
}

// ── 检查 4：文档测试数防漂移 ──
// README 徽章 tests-NNN 必须与 test/*.test.mjs 里的 test( 静态计数一致；多算了 skip/fixture 会误报，
// 所以这里数的是 test( 与 test.skip( 的总和（跳过也是用例），子测试按文件粒度近似。
function countTests() {
  let total = 0;
  const dir = join(root, 'test');
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.test.mjs')) continue;
    const src = readFileSync(join(dir, entry), 'utf8');
    for (const m of src.matchAll(/(?:^|\s)(?:test|it)(?:\.skip|\.todo)?\s*\(/g)) total += 1;
  }
  return total;
}
const actual = countTests();
for (const readme of ['README.md', 'README.zh-CN.md']) {
  const file = join(root, readme);
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  // 无数字徽章（tests-passing）= 已消除手工同步债的合规形态，直接过
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

// ── 汇总输出 ──
if (violations.length > 0) {
  console.error(`check-boundaries: ${violations.length} 处违规\n`);
  for (const v of violations) {
    console.error(`✗ [${v.check}] ${v.file}:${v.line}`);
    console.error(`  违规: ${v.message}`);
    console.error(`  修复: ${v.fix}\n`);
  }
  process.exit(1);
}
console.log(`check-boundaries: 四层边界 / 凭据只读 / 临时密钥清理 / 文档测试数（${actual}）全部通过`);
