// 本文件负责：跑 tsc -p tsconfig.checkjs.json 并把判定收窄到 ZCE-2 的目标文件——
// 6 个高风险状态文件（gate/pending/run/snapshot/tool-summary/credentials）必须零类型错误。
// 为什么要过滤：tsc 会连传递依赖（appserver/models/offpeak-* 等 checkJs 之前写就的文件）一起报，
// 那些文件的存量问题显现在它们自己头上；它们若真的影响了目标文件的类型推导，
// 错误会显现在目标文件的调用点上——一样被拦。逐文件收紧依赖层是后续工单，不在 ZCE-2 范围。
// 退出码：目标文件有错或 tsc 压根跑不起来 → 1；否则 0。非目标文件的错误计数照实打印，供后续工单参考。
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['lib/gate.mjs', 'lib/pending.mjs', 'lib/run.mjs', 'lib/snapshot.mjs', 'lib/tool-summary.mjs', 'lib/credentials.mjs', 'lib/proof.mjs'];

let output;
let tscFailed = false;
try {
  output = execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.checkjs.json'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  if (err.status === undefined) {
    console.error(`check-types: tsc 没跑起来（${err.message}）。先 npm install（typescript 是 devDependencies，不进运行时）`);
    process.exit(1);
  }
  tscFailed = true;
  output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
}

// R1-6：编译器输出必须能认出是 tsc 诊断——tsc 二进制缺失/损坏时 execFileSync 仍会
// 「跑起来」但输出是 node 的模块错误而不是 error TS 行，lines 为空会误判零错误报绿。
// 编译器没产出任何诊断且退出非零、或输出里出现 node 内部错误字样，都保持失败状态。
const looksLikeCompilerFailure = tscFailed && !/error TS\d+/.test(output);
if (looksLikeCompilerFailure) {
  const tail = output.trim().split('\n').slice(-5).join('\n');
  console.error(`check-types: tsc 退出非零但没有一条 TS 诊断——编译器本身没正常工作（可能 typescript 未安装或损坏）。先 npm install 再重跑。输出尾巴：\n${tail}`);
  process.exit(1);
}

const lines = output.split('\n').filter((l) => /error TS/.test(l));
// R2-4：只有「定位到具体源码文件」的诊断才参与目标/非目标分类——
// 行形如 `lib/xxx.mjs(12,3): error TSxxxx`。全局/项目配置错误（TS5023 拼错配置项）、
// 缺文件（TS6053 指向不存在文件）等没有 `文件(行,列)` 前缀，归类不了就一律保留失败——
// 绝不许配置层错误被计成「传递依赖存量」而放行
// 只有定位到源码文件（.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs）的诊断才算文件诊断——
// 配置文件（tsconfig.checkjs.json 里的 TS5023 报成 `tsconfig.checkjs.json(1,904): error…`
// 同样带位置前缀）不是源码文件，按无法归类处理，不许被计成传递依赖存量放行
const FILE_DIAG_RE = /^\S+\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs|d\.ts)\(\d+,\d+\): error TS\d+/;
const fileDiags = lines.filter((l) => FILE_DIAG_RE.test(l));
const unclassified = lines.filter((l) => !FILE_DIAG_RE.test(l));
if (unclassified.length > 0) {
  console.error(`check-types: ${unclassified.length} 条无法归类到源码文件的 TS 诊断（配置/全局/缺文件类），一律按失败处理\n`);
  for (const line of unclassified.slice(0, 10)) console.error(`  ${line}`);
  console.error('\n修复指引：先修 tsconfig.checkjs.json 本身（配置错误/文件缺失），再重跑 verify');
  process.exit(1);
}
const targetErrors = fileDiags.filter((l) => TARGETS.some((t) => l.startsWith(`${t}(`)));
const otherCount = fileDiags.length - targetErrors.length;

if (targetErrors.length > 0) {
  console.error(`check-types: 目标文件有 ${targetErrors.length} 个类型错误（checkJs 护栏拦截）\n`);
  for (const line of targetErrors) console.error(`  ${line}`);
  console.error('\n修复指引：优先补准 JSDoc（@param/@returns 的真实形状）；Node 风格的确信正确但类型系统表达不了的（如 err.code），用 @type {Error & { code?: string }} 这类窄化断言；不许用 @ts-nocheck 整文件躺平。');
  process.exit(1);
}
if (!tscFailed && lines.length === 0) {
  console.log(`check-types: 目标文件（${TARGETS.length} 个）checkJs 零错误`);
} else {
  console.log(`check-types: 目标文件（${TARGETS.length} 个）checkJs 零错误；传递依赖文件另有 ${otherCount} 个存量错误（不阻断，逐文件收紧是后续工单）`);
}
