# dsh-plugin/ — DSH 侧插件

DSH（DeepSeek Harness）半边把本仓库的 CLI 接进 DSH：派单教学（SKILL.md + system prompt 公告）
+ 官方右侧栏「zcode 任务」观察面板（约 1 秒自刷、零额度、只看不答）。

**插件定义在仓库根**：根 `package.json` 的 `dsh` 字段 + 根 `cordis.patch.yml`（行 id `zcode-executor`），
npm 包 `zcode-executor` 本身就是 DSH 插件——桌面端插件页按包名安装，App 自动登记 bundle，
不用 `link:`、不用手改 profile 配置。npm tarball 经根 `files` 带 `cordis.patch.yml` 与
`dsh-plugin/lib`（构建产物）；peer 依赖全部 optional，CLI 全局安装仍保持零依赖
（DSH 侧运行时由宿主供给）。`test/dsh-manifest.test.mjs` 守卫这份定义不漂移。

`dsh-plugin/` 只是**源码与构建产物**（TypeScript + pnpm 独立包），2026-10-11 用 `git subtree`
从独立仓库（Gitea `kyomio/dsh-zcode-executor`）并入，完整历史保留；旧仓库冻结。
与 CLI 的**唯一耦合面**是 `zcode-executor watch --json` 的 NDJSON 行协议。

## 目录速览

| 路径 | 内容 |
| --- | --- |
| `dsh-plugin/src/` | TypeScript 源码：index（cordis 插件入口）、routes（NDJSON 流路由）、watch-process、bridge（zen-remote 插件桥）、skill-link（`~/.dsh/skills` 软链）、client/（React 面板） |
| `dsh-plugin/lib/` | 构建产物（tsc + `build-client.mjs` 内联打包），**入库**、随 npm 包发布 |
| `dsh-plugin/skills/zcode-executor/` | 只有一条 SKILL.md **软链**指向根 `skills/zcode-executor/SKILL.md`（单一事实源；npm 打包跳过软链，运行时由 skill-link 回退到根 skills/——两种布局都覆盖） |
| `dsh-plugin/test/` | 112 个用例，全部用桩数据，不建 DSH 会话、不花 token |
| `dsh-plugin/SPEC.md` / `README.md` | 规格全文（含测试决定与边界）/ 安装与架构 |
| 根 `cordis.patch.yml` | bundle 注册补丁（**定义在根，不在 dsh-plugin/**） |

## 开发与测试

```sh
cd dsh-plugin
pnpm install        # peer/dev 依赖
npm run build       # tsc 两套 tsconfig + build-client.mjs；产物 lib/ 入库
npm run verify      # 只类型检查
node --test test    # 112 个用例（根目录 npm test 不含它——插件要 pnpm 依赖，保持根测试零依赖）
```

改插件代码后要重启 DSH 桌面端才生效；`npm run preview` 起本地面板预览（mockup 数据）。

## 发版

无独立版本号：随主包走 `npm version` + tag → `publish.yml` 发 npm，插件代码跟着 tarball 走。
改插件后记得 `npm run build`（lib 入库），`test/dsh-manifest.test.mjs` 会核对构建产物存在。

## 同步上游

旧仓库已冻结；若别处对插件有更新，用 subtree 拉入：

```sh
git subtree pull --prefix=dsh-plugin <旧仓库路径或 remote> main
```
