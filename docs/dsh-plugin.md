# dsh-plugin/ — DSH 侧插件

`dsh-plugin/` 是 **dsh-zcode-executor**（DSH 插件）的源码，2026-10-11 用 `git subtree` 从独立仓库
（Gitea `kyomio/dsh-zcode-executor`）并入本仓库，完整历史保留。旧仓库仍在、仍可推送，但已冻结——
后续改动只在本仓库做。

它做的事：把本仓库的 CLI 接进 DSH（DeepSeek Harness）——

1. **派单教学**：SKILL.md 软链进 `~/.dsh/skills/` + system prompt 短公告，教 DSH 智能体走完整派单流程。
2. **观察面板**：官方右侧栏「zcode 任务」tab，实时显示各条 zcode 会话（挂起/执行中/已结束），
   约 1 秒自刷、零额度。面板只看不答，审批分流按 skill 的应答安全条件。

与主仓 CLI 的**唯一耦合面**是 `zcode-executor watch --json` 的 NDJSON 行协议；协议层、闸门、
工作流都不沾。主仓「纯 .mjs、零运行时依赖」的硬约束只管根目录的 `lib/`、`bin/`、
`scripts/`、`test/`，`dsh-plugin/` 是独立的 TypeScript + pnpm 包（peer 依赖 cordis 与 DSH UI 包），
互不影响。

## 目录速览

| 路径 | 内容 |
| --- | --- |
| `src/` | TypeScript 源码：index（cordis 插件入口）、routes（NDJSON 流路由）、watch-process、bridge（zen-remote 插件桥）、client/（React 面板） |
| `lib/` | 构建产物（tsc + `build-client.mjs` 内联打包），**入库** |
| `skills/zcode-executor/` | 派单教学 SKILL.md（运行时软链到 `~/.dsh/skills/`） |
| `cordis.patch.yml` | bundle 注册补丁（行 id `zcode-executor`） |
| `test/` | 112 个用例，全部用桩数据，不建 DSH 会话、不花 token |
| `SPEC.md` / `README.md` | 规格全文（含测试决定与边界）/ 安装与架构 |

## 开发与测试

```sh
cd dsh-plugin
pnpm install        # peer/dev 依赖
npm run build       # tsc 两套 tsconfig + build-client.mjs；产物 lib/ 入库
npm run verify      # 只类型检查
node --test test    # 112 个用例（根目录 npm test 不含它——插件要 pnpm 依赖，保持根测试零依赖）
```

改插件代码后要重启 DSH 桌面端才生效；`npm run preview` 起本地面板预览（mockup 数据）。

## 安装与发版

本机 desktop profile 以 `link:` 安装（详见 `dsh-plugin/README.md` 安装一节），**不发 npm**；
版本号独立演进（并库时 0.2.0），不跟随根 `package.json` 的 `npm version` 流程，也不进
`sync-doc-version.mjs` 的同步清单。

## 同步上游

若旧仓库（或别处）对插件有更新，用 subtree 拉入：

```sh
git subtree pull --prefix=dsh-plugin <旧仓库路径或 remote> main
```
