// 测试目录的聚合入口。Node 22 的 `node --test <目录>` 会把目录当单一模块入口 spawn
//（`node test` → CJS loader 的目录解析：package.json main → index.js），而不是递归搜索
// 里面的 *.test.mjs——没有这个文件时闸门直接 MODULE_NOT_FOUND（2026-10-07 实测 22.22.3）。
// 它动态 import 同目录全部 *.test.mjs：新增测试文件后无需改这里。
// 只在「目录入口」身份下聚合（spawn 的 argv[1] 是 test 目录本身）；无参数的 runner 扫描
// 会把 test/ 下所有 JS 文件各跑一遍，那时 index.js 按普通测试文件空跑（0 用例），
// 避免与两个 *.test.mjs 重复执行（实测不设哨兵会出现 36 = 18×2）。
// glob 跑法（node --test 'test/*.test.mjs'）不经过本文件，不受影响。
import { readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = new URL('.', import.meta.url);
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(here))) {
  for (const f of readdirSync(fileURLToPath(here)).filter((name) => name.endsWith('.test.mjs'))) {
    await import(new URL(f, here).href);
  }
}
