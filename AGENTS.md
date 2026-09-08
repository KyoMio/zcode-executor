# AGENTS.md — zcode-executor

Claude Code 插件。Claude 当工头：把一件想清楚的开发任务派给本机 ZCode（GLM），
在 worktree 里隔离执行，用 git diff 和测试客观验收。

**状态（2026-09-08）**：第一版完成，阶段 0 到 4 全部合并 main，`npm test` 298 个用例，真机全流程走通。
术语在 [docs/CONTEXT.md](docs/CONTEXT.md)。本地开发记录（`docs/handoff/`、`docs/tasks/`、`docs/PLAN.md`、`docs/archive/`）不进 GitHub，只在开发机上有；
有它们就从 `docs/handoff/handoff-20260908.md` 接手，没有就从 README 与 docs/PRD.md 开始。

## 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 协议 | `lib/appserver.mjs` `lib/session.mjs` `lib/providers.mjs` `lib/scrub.mjs` | 拉起 `zcode app-server --stdio`，JSON-RPC 请求配对与反向请求路由，会话生命周期，回合结束判定 |
| 工作流 | `lib/config.mjs` `lib/registry.mjs` `lib/models.mjs` `lib/tiers.mjs` `lib/runs.mjs` `lib/queue.mjs` `lib/run.mjs` `lib/intent.mjs` | 配置、登记簿、等级分配、队列与锁、runner 的一生、`runs/<id>/` 落盘 |
| 闸门 | `lib/gate.mjs` `lib/pending.mjs` `lib/review/` | 红线 → 模型审批（`workspace/generateText`）→ 挂起等人 |
| 外壳 | `bin/zcode-executor` `lib/cli/` `skills/zcode-executor/` `templates/` | CLI 与 skill。MCP 外壳按需后加 |

项目只接 zcode，协议层直接说 app-server 的 JSON-RPC，中间没有 ACP。

## 硬约束

- 验证协议先走零 token 路径（握手、create、list、close）。每一次 `session/send` 花真实额度。
- 模型审批只产出放行或转人工；拒绝同样退回人工。人工由 Claude 用 AskUserQuestion 转交。
- 用词照 `CONTEXT.md`：会话、任务单、投递、回合、审批请求、提问、红线、模型审批、挂起、模型等级、思考等级。
- 纯 `.mjs`，零运行时依赖，不加构建。
- `~/.zcode/v2/config.json` 只读：里面有 API key，App 会重写它。
- 从 zcode-acp 搬来的代码保留 Apache-2.0 版权声明，记入 `NOTICE`。
- 排障看 `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`。JSON-RPC 错误的细节在 `error.data.details`，`message` 只有一句概括。

## 发版

版本号只在 `package.json` 里改，其余位置（两份 README 的版本徽章、`.claude-plugin/plugin.json`、
`.codex-plugin/plugin.json`）由 `scripts/sync-doc-version.mjs` 同步，挂在 npm 的 `version` 生命周期脚本上；
`npm test` 里的 `--check` 漏同步就挂。文档里的标记挪了位置要改那个脚本，找不到标记它直接非零退出。

```sh
npm version patch      # 改 package.json + 同步版本号 + 建 commit 和 v* tag
git push --follow-tags # 推 tag 才是触发器
```

`.github/workflows/publish.yml` 按 tag 跑：测试 → tag 与 package.json 版本一致 → `npm publish`
（Trusted Publishing，OIDC 无令牌）→ 建 GitHub Release（`--generate-notes`，提交信息就是 changelog）。
人工配置只有一处：npmjs.com 包设置里登记可信发布者 `kyomio/zcode-executor` + 文件名 `publish.yml`。
`ci.yml` 在推 main 和 PR 时跑测试（Node 22 与 24）。

## 何时读什么

- 要做什么、CLI 长什么样、闸门怎么走 → [docs/PRD.md](docs/PRD.md)；实现与测试决定、用户故事 → [docs/SPEC.md](docs/SPEC.md)
- 写代码前 → [docs/RULES.md](docs/RULES.md)（风格、注释、输出、落盘、测试、提交）
- 现在做到哪、下一件是什么 → `docs/PLAN.md`（本地记录，不进仓库）
- 接手开发、看背景 → `docs/handoff/handoff-20260908.md`（本地记录，不进仓库）
- 改插件清单、marketplace、安装方式 → 记忆库里「Claude 插件 marketplace 规范」（`search_memories`），官方页面 code.claude.com/docs/en/plugins-reference
- 写协议层，或碰到 app-server 的方法、事件、反向请求 → [docs/reference/zcode-app-server-protocol.md](docs/reference/zcode-app-server-protocol.md)，再对照 [docs/verified.md](docs/verified.md) 里的本机实测
- 想改定位、换协议、放宽审批、改名 → 先读 [docs/decisions.md](docs/decisions.md) 里的理由
- 需要参考实现 → docs/decisions.md D2 提到的 zcode-acp（`npm pack zcode-acp-server`）
