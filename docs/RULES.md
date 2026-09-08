# RULES — 开发规范

> 写代码前读一遍。规则按项目特点定：零依赖的 Node 脚本、一条 stdio 协议、落盘文件当状态、
> 每次真机投递都花钱。有条规则挡了路，先改这份文件再破例。

## 1. 语言与结构

- Node ≥ 22，ESM，文件后缀 `.mjs`。不写 TypeScript，不加构建步骤。
- 零运行时依赖。要加依赖必须先在 decisions.md 写一条理由。测试也不加框架，用 `node --test`。
- 文件按 AGENTS.md 的分层表放：协议层 `lib/appserver.mjs`、`lib/session.mjs`、`lib/providers.mjs`、`lib/scrub.mjs`；
  工作流层 `lib/config.mjs`、`lib/registry.mjs`、`lib/tiers.mjs`、`lib/models.mjs`、`lib/runs.mjs`、`lib/queue.mjs`、`lib/run.mjs`、`lib/intent.mjs`；
  闸门 `lib/gate.mjs`、`lib/pending.mjs`、`lib/review/`；外壳 `bin/`、`lib/cli/`、`skills/`、`templates/`。
  跨层共用的只有 `lib/errors.mjs`（`ExecutorError`）。新文件先想清楚归哪层再建。
- 层间只能向下依赖：外壳 → 工作流 → 协议。闸门由工作流调用，闸门只依赖协议层。协议层不知道
  `runs/` 目录、登记簿、退出码。例外：外壳可以直接用闸门层的**纯函数**（`readPending`、`optionClass`、`questionResponse`），
  为的是 CLI 与 runner 共用同一份匹配规则；不经工作流层转调。
- 一个文件一个职责。文件超过五百行先想拆，不是加。
- 文件名小写连字符；标识符 camelCase；常量 UPPER_SNAKE；只有需要持状态的东西才写 class（协议客户端算一个）。

## 2. 术语

- 代码、输出、文档统一用 [CONTEXT.md](CONTEXT.md) 的词：session、task file、send、turn、permission request、
  question、gate、hard rule、review（模型审批）、pending、tier、thoughtLevel。
- 不要出现 judge、verdict（模型审批的结果叫 review result）、run（会话目录叫 `runs/` 是历史沿用，代码里
  不造 Run 概念）、prompt（指投递用 send，指提示词用 promptText）。
- 面向人的输出写中文；标识符、事件类型、JSON 字段名写英文。

## 3. 代码风格

- 两个空格缩进，单引号，句末分号。行宽不设硬数字，一行说一件事、别让人横向滚动。不引入格式化工具；提交前跑 `node --check`。
- 优先 `export function`，模块顶层不放会产生副作用的语句（读文件、起进程）。
- 不用 `default export`。
- 错误统一一个 `ExecutorError`，带 `exitCode`。抛错信息写中文、说清怎么办（「会话不在登记簿里，用
  `zcode-executor list` 看有哪些」），不写堆栈式短语。
- 不吞错误。捕获了不处理的一律 rethrow；确实要忽略的写一行注释说为什么可以忽略。
- JSON-RPC 错误记 `error.data.details`，`message` 只有一句概括，不够排障。
- 异步一律 `async` / `await`，不混 `.then`。子进程和文件的等待都要有超时。

## 4. 注释

- 每个文件头一段：这个文件负责什么、明确不负责什么、和谁打交道。
- 行内注释写「为什么」，不写「做了什么」。代码本身说得清的不注释。
- 引用真机事实时标出处和日期：`// verified.md 2026-09-07：未答的反向请求每秒重发一次`。
- 从外部搬来的代码在文件头标来源、版本、许可证，并记入 `NOTICE`。改动过的地方标 `// 改：…`。
- 刻意的简化用 `// 权宜：<现在的上限>，<什么时候要升级成什么>` 标出来，例如
  `// 权宜：无信号不兜底，真机挂死过一次再加超时`。没有上限说明的简化不算权宜，算没想清楚。
- 不留 TODO。要做的事写进 `docs/PLAN.md`（本地记录）或 decisions.md 的暂缓项。

## 5. 输出与退出码

- stdout 只放结果：人读的摘要，或 `--json` 时一个 JSON 对象一行。进度、警告、`--stream` 都走 stderr。
- 每条 stderr 信息一行，以命令名或阶段开头：`new: cwd 不是 worktree，照常建`。
- `--json` 的结构只加字段不删字段、不改字段含义。改了就在 PRD 第 4 节同步。
- 退出码表固定为 0 / 1 / 2 / 3 / 4 / 5，含义见 PRD。新情况归入既有码，不加新码。

## 6. 落盘

- 数据目录只从配置解析一次，所有路径用绝对路径。
- 写 JSON 文件先写同目录临时文件再 `rename`，避免读到半截。
- `events.jsonl` 只追加，一行一个对象，本项目自己的事件 `type` 以 `executor.` 开头。
- 时间一律 ISO 8601 UTC 字符串。
- `runs/`、`worktrees/` 不进仓库；测试用 `mkdtemp` 建临时目录并在 `after()` 里清掉。
- `~/.zcode/v2/config.json` 只读不写。读它只为构造 provider 表推给子进程（decisions D10）；
  读到的内容不落盘、不进日志、不出协议层。

## 7. 协议层

- 每个请求带超时，超时视为失败并说明是哪个方法。
- 反向请求按 `params.requestId` 去重，没有 requestId 的按 `method|sessionId`；没有处理器的反向请求回 `-32601` 错误并打一行 stderr，
  不能不答（不答对端每秒重发）。**例外**：审批请求和提问由会话层接管，没给处理器时刻意不答让回合停住（这就是挂起），
  客户端对同一请求只保留最近 5 个信封 id，应答时只回这几个（挂起 75 秒后 approve 真机验过够用）。
- 未知事件类型原样落盘，不报错。
- 审批应答形状是 `{decision:'allow'|'deny'}`（verified.md「审批」），放行前必须确认 options 里有 `kind` 为 `allow_once` 的项，没有就转人工。
- 子进程 stderr 全部转到本进程 stderr，前面加 `zcode:` 前缀。

## 8. 安全底线（代码层面不可绕）

- 模型审批的出口只有 allow 和 ask。代码里不存在把 deny 应答给 zcode 的分支，除了人跑 `deny` 和 `cancel`。
- `approve` 只在 options 含 `allow_once` 时放行，且只放行这一次。不实现「一直允许」。判定用 `lib/pending.mjs` 的
  `hasAllowOnce`，闸门放行、挂起落盘、`approve` 三处共用同一份，不各写各的。
- runner 只认 `answer.json` 里 requestId 与当前挂起一致的应答，对不上的丢弃：上一轮留下的答案不能放行这一轮。
- 白名单检查在 `new` 做一次，runner 启动时对登记簿里的 cwd 再做一次。
- API key、token 一类字符串永不打印、永不落盘；`doctor` 报 config.json 只报存在与否和 provider 个数。
- 红线表是代码常量，不读配置。

## 9. 测试

- 每个外部行为一个用例，用例名写行为不写实现：「白名单外的 cwd 退出码 2」。
- 断言三样：退出码、stdout 的 JSON、落盘文件和 mock 的记录文件。不断言内部函数被调了几次。
- 只对 `test/mock-appserver.mjs` 跑。`npm test` 任何情况下不碰真机、不花额度。
- 真机脚本放 `scripts/`，名字带 `real-`；会花额度的脚本跑前打印「这次会花额度」并要求 `--yes`。
- 起了后台进程的用例在 `after()` 里统一 SIGKILL，包括子进程的子进程；mock 靠 stdin EOF 自灭。
- 测试用的剧本 JSON 就近放在用例里，不建 fixtures 目录。
- 改协议层行为时先改 mock 再改客户端，让 mock 一直是「真机行为的复刻」，剧本字段注明对应的真机事实。

## 10. 提交

- 一件任务一到几个提交，每个提交能独立跑过 `npm test`。
- 提交信息中文，首行 `<范围>: <做了什么>`，范围用层名或命令名：`协议: 反向请求按 requestId 去重`、
  `send: --wait 超时改为发 session/stop`。正文写为什么，不复述 diff。
- 不提交 `runs/`、`worktrees/`、日志、临时目录。
- 主分支上直接开发；派给执行端的任务在 `task/T-<编号>` 分支上做，验收后合并。

## 11. 文档

- 改行为先改 [PRD.md](PRD.md) 或 [SPEC.md](SPEC.md)，再改代码。
- 真机新发现写进 [verified.md](verified.md)，带日期，标明是哪个版本。
- 做了取舍写进 [decisions.md](decisions.md)：定了什么、为什么、什么情况下重开。
- 新词先进 [CONTEXT.md](CONTEXT.md)，再用。
- 搬代码更新 `NOTICE`。
- 做完一件任务在 `docs/PLAN.md` 打勾；阶段结束时把检查点结果记在对应 handoff 里。这两处是本地记录，不进仓库。
