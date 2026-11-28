# zcode-executor Feature Map

五份子文档按功能域切分。**先按任务选一份读，不要五份全读**——每份都自足，包含该域的命令、行为契约与 Gotchas（踩坑记录，源自真机核实与真实 bug）。

| 文档 | 覆盖 | 什么时候读 |
| --- | --- | --- |
| [01-basic-dispatch.md](01-basic-dispatch.md) | `new / send / follow / status / cancel`、worktree 白名单 | 派单、返工、看状态、停任务 |
| [02-permission-gate-and-jev.md](02-permission-gate-and-jev.md) | build 档红线、三级模型审批、Jev 前筛、`approve/deny/answer` | 处理挂起（退出码 5）、配审批链 |
| [03-offpeak-and-startplan.md](03-offpeak-and-startplan.md) | 闲时投递、Start Plan JWT、quota | 用户选闲时算力、排查投递失败 |
| [04-watch-pane-and-dsh-plugin.md](04-watch-pane-and-dsh-plugin.md) | `watch --json` 行协议、Claude Code hooks、DSH 插件 | 接观察面板、写 hooks、改插件 |
| [05-credentials-and-providers.md](05-credentials-and-providers.md) | credentials.json 解密、provider 多来源优先级 | 凭据解不开、provider 选错、零 token 探针 |

另：统一验证 CLI 是 `scripts/control-executor.mjs`（doctor / zero-token / mock-matrix / orphan-check / live-smoke / flake-swarm），验收与排障入口；旧的 `probe*.mjs`/`real-*.mjs` 已收口为兼容层。

## 全域 Gotchas（任何一份之前先记住这三条）

1. **ZCode 报错的真身在 `error.data.details`**——顶层 message 经常只有套话，details 里才有方法名、错误码和原因。排障第一步永远是展开 details。
2. **`--steer` 必须等 `events.jsonl` 出现首个工具边界后再注入**——回合刚起就插话，app-server 还没进执行循环，steer 会静默丢失或报拒绝。
3. **`hooks/`（Claude Code mod）不能依赖完整 Node 环境**——只可用 stdio 单行 JSON 通信，绝对禁止 import 根 `lib/`（静态扫描红线，违反即构建失败）。
