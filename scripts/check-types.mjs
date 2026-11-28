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

const lines = output.split('\n').filter((l) => /error TS/.test(l));
const targetErrors = lines.filter((l) => TARGETS.some((t) => l.startsWith(`${t}(`)));
const otherCount = lines.length - targetErrors.length;

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
