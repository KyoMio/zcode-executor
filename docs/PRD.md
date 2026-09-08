# PRD — zcode-executor

> 状态：第一版已实现（2026-09-08），下面写的都是现在的行为。需求于 2026-09-07 对齐（31 个问题一轮轮问完）。
> 术语以 [CONTEXT.md](CONTEXT.md) 为准；为什么这么定见 [decisions.md](decisions.md)；
> 本机实测事实见 [verified.md](verified.md)；接手开发见 `docs/handoff/handoff-20260908.md`（本地记录，不进仓库）。

## 1. 要解决什么

Claude Code 负责想清楚一件开发任务，本机 ZCode（GLM）负责把代码改出来。两者之间缺一条通道，
能做到：任务写成文件派过去、在隔离的执行副本里跑、执行端要审批时有人或有模型来答、
最后用 `git diff` 和测试验收，而不是听执行端自述。

**用户**：本机 ZCode 桌面 App 的使用者本人。单用户、本机、不考虑远程和多租户。

**不做**：协议翻译产品、TUI、远程访问、代码审查工具、通用资源调度、往 ZCode App 的任务列表同步、MCP 外壳。

## 2. 形态

一个 Claude Code 插件，仓库、插件、CLI、skill 同名 `zcode-executor`。

| 层 | 文件 | 干什么 |
| --- | --- | --- |
| 协议 | `lib/appserver.mjs` `lib/session.mjs` `lib/providers.mjs` `lib/scrub.mjs` | 拉起 `zcode app-server --stdio`，JSON-RPC 配对、反向请求路由、会话生命周期、回合结束判定、provider 表与脱敏 |
| 工作流 | `lib/config.mjs` `lib/registry.mjs` `lib/tiers.mjs` `lib/models.mjs` `lib/runs.mjs` `lib/queue.mjs` `lib/run.mjs` `lib/intent.mjs` | 配置、登记簿、等级分配、队列与锁、runner 的一生、`runs/<id>/` 落盘、白名单、模型审批的素材 |
| 闸门 | `lib/gate.mjs` `lib/pending.mjs` `lib/review/` | 红线 → 模型审批 → 挂起 |
| 外壳 | `bin/zcode-executor` `lib/cli/` `skills/zcode-executor/` `templates/task.md` | CLI、skill、任务单模板 |

**技术栈**：Node ≥ 22、ESM、纯 `.mjs`、零运行时依赖、无构建步骤、`node --test`。
审批层的 TypeScript 原型手工去掉类型改成 `.mjs`。
从 zcode-acp 搬来的代码保留 Apache-2.0 声明，记入 `NOTICE`。

## 3. 一次派活的完整走法

1. Claude 把任务写成 `tasks/T-xxx.md`（模板 `templates/task.md`），验收标准要能被机器检查。
2. Claude 自己跑两条 git 命令，在白名单目录下建执行副本：
   `git -C <主仓> worktree add ~/.zcode-executor/worktrees/<仓库名> -b task/T-xxx`，首次装依赖。
3. `zcode-executor new --cwd <执行副本> --title T-xxx [--tier fast|strong] [--thought <档>] [--deny "工具 工具"]`
   → 登记簿多一行，返回本地 id（`x_…`）。zcode 会话在第一次投递时才建（D13）。
4. `zcode-executor send <id> "执行 tasks/T-xxx.md" --task <执行副本>/tasks/T-xxx.md --wait`
   → 前台等；或去掉 `--wait` 后台跑，用 `follow` / `status` 看。正文里的相对路径是给执行端自己读的，
   `--task` 给的是模型审批看的授权依据，要写绝对路径。
5. 回合中执行端要审批：闸门先判红线，再模型审批，都判不下来就挂起。
   `send --wait` 立刻以退出码 5 返回并打印挂起内容。
   Claude 看内容决定：审批请求用 AskUserQuestion 转给人，然后 `approve <id>` 或 `deny <id>`；
   提问自己能答就 `answer <id> <值>`，答不了再问人。回合从挂起处继续。
6. 回合结束后 Claude 验收：执行端不提交，改动停在执行副本的工作区，所以先
   `git -C <执行副本> add -A` 把新文件也收进来，再看 `git -C <执行副本> diff --cached`，并在执行副本里跑测试。
7. 过了：Claude 在执行副本里提交，回主仓 `git -C <主仓> merge` 合并；
   没过：`git -C <执行副本> reset` 撤掉暂存，写 `tasks/T-xxx-fix.md` 再投同一条会话。

## 4. CLI

命令名 `zcode-executor`。契约和退出码沿用作者其它派单工具的同一套约定，Claude 学一套就够。

| 命令 | 作用 |
| --- | --- |
| `doctor [--json]` | 零 token 自检三步：找到 `zcode.cjs` 且版本 ≥ 0.14.8 → `~/.zcode/v2/config.json` 存在 → 真握手一次；顺带报模型等级每档选了谁、有没有档空着 |
| `models [--json]` | 从 `workspace/readState` 拿可用模型，显示每个模型的思考等级、被禁用原因、自动分到哪个等级 |
| `list [--project 关键字] [--json]` | 列登记簿里的会话：id、标题、cwd、等级、上次结果、是否挂起 |
| `new --cwd <绝对路径> [--title T] [--tier fast\|strong] [--thought 档] [--deny "工具…"] [--provider id] [--json]` | 建会话。cwd 必须在白名单内；不是 worktree 只警告不拒 |
| `send <id> <正文\|-> [--task 文件] [--wait] [--steer] [--timeout 秒] [--stream] [--json]` | 投递。默认排队；`--steer` 用 zcode 原生方式插进当前回合，不打断 |
| `follow <id> [--timeout 秒] [--stream] [--json]` | 跟看后台 runner，写出新结果就返回 |
| `status <id> [--tools N] [--json]` | 只读快照：phase（`running` 在跑 / `idle` 队列空 / `pending` 挂起 / `exited` 正常收工 / `stale` runner 半路没了）、最近工具调用、队列长度、上次结果、挂起了多久 |
| `cancel <id>` | 叫停：挂起的先答拒绝，再 `session/stop`，之后不再取队列 |
| `approve <id>` | 应答当前挂起的审批请求，只回 `allow_once` |
| `deny <id>` | 应答当前挂起的审批请求为拒绝 |
| `answer <id> [--] <值…>` | 应答当前挂起的提问：有选项按 value、label 或序号匹配，多选一个参数里逗号分隔；无选项就是自由文本。值以 `--` 开头时先用 `--` 分隔 |

退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 回合干完了，去验收 |
| 1 | 用法错、zcode 起不来、版本过低 |
| 2 | 被拒：白名单外、会话不在登记簿、等级或思考等级不合法 |
| 3 | `send --wait` 超时，当前回合已取消，会话还在可再投；`follow --timeout` 到点只是旁观者走了，不取消任何东西 |
| 4 | 回合异常：`turn.failed`、被中止、撞输出上限 |
| 5 | 挂起等人：审批请求或提问 |

- `--wait` 默认 1800 秒（config `waitTimeoutSec`），到点取消当前回合。挂起不算超时，一挂起立刻返回 5。
- `--json` 输出里 `id` 是本地派单 id，`sessionId` 是 zcode 的 `sess_`（首回合前为 null），所有命令一致。
- `send --wait` 与 `follow` 结束时打两块摘要：「闸门：放行 N 次（红线挂起 a、快筛 b、慢判 c、转人工 d）」与「改动：文件列表；Bash 条数」；`--json` 对应 `summary:{gate:{allow, ask, hard, fast, slow}, files:[…], bashCount}`。
- `status` 的最近工具显示 `Write(文件名)` 形式；`list` 的挂起行末尾标「挂起: 工具名」。
- 一条会话同一时刻最多一个挂起（审批在回合内串行）。`approve` / `deny` / `answer` 应答的就是那一个。
- `--thought` 的值在建会话前对着该模型的合法档位校验，不合法退出码 2（`session/create` 遇到非法值会静默忽略，不能靠它报错）。
- 正文写 `-` 从 stdin 读。`--json` 给机器可读结构。

## 5. 模型等级与思考等级

- **两个等级**：`fast`（Flash、lite、mini、air 这类）和 `strong`（旗舰）。
- **对上具体模型**：从 `workspace/readState` 拿列表，按模型名关键词自动分，同档多个取版本最新的，
  跳过有 `disabledReason` 的。`config.json` 的 `tiers` 可覆盖。不按模型名写死，模型换代不用改代码。
- **provider 优先 coding plan**（配置 `preferredProvider` 可改），国内 `bigmodel` 与国际 `zai` 站点哪个启用用哪个。
- **不给 `--tier`** 就用优先 provider 下 zcode 当前选中的模型；那个模型不在这个 provider 下或不可用时退到 `fast`，再没有才退到 `strong`。
- **派活的思考等级默认 `high`**，模型没有 `high` 档就不传，跟模型默认。`--thought` 可覆盖。**模型审批默认 `low`**（审批只需判是不是日常工作，high 让快筛多花几秒和几百 token；用户 2026-09-08 定），配置 `review.thought` 可改。
- **档位只有 `build`**。不开 `--mode`。
- **`--deny`** 默认不拿掉任何工具。

skill 里的选择指南：机械改动 → `fast`；常规实现 → `fast`；难活（要取舍、调试难复现、改陌生代码）→ `strong`。
Flash 类模型思考等级不要往低调，效果差。

## 6. 闸门

执行端发来的 `interaction/requestPermission` 和 `interaction/requestUserInput` 都进闸门。

**审批请求**走三段，每段的结果作为一条 `executor.gate` 事件写进 `events.jsonl`，事件里的 stage 取这几个值：
`hard`（红线）、`no-allow-option`（options 里没有 `allow_once`，放不出来）、`review-fast`（快筛放行）、
`review-slow`（慢判）、`review-failed`（模型调用或解析失败）、`review-disabled`（配置关了模型审批）、
`gate-error`（闸门自己出错）、`question`（提问直接挂起）。

1. **红线**（写死在代码里，谁也推不翻）：
   - hard 规则表沿用 Claude Code auto 模式的类别（凭据外泄等）。
   - **本项目专属**：带路径参数的工具（Write、Edit 等）路径解析成绝对路径后不在 cwd 之下 → 转人工。
     Bash 的路径没法可靠解析，不做红线，交给模型审批并在提示词里写明「任何越出执行副本的写入或删除一律转人工」。
   - 命中即挂起，不进模型审批。
2. **模型审批**：经 `workspace/generateText`，用 `fast` 档模型、思考 `low`。两段：快筛 pass / flag，flag 再慢判。
   快筛输出预算 300 token（`review.fastMaxTokens`），慢判 2000（`review.slowMaxTokens`）。
   慢判要求**第一行就是结论行**（`结论: allow` / `结论: ask` / `结论: deny <规则 id>`），理由写在后面——
   结论放最后一行时推理一长就被截断，整次判定作废。
   **只产出放行或转人工，从不拒绝**；模型返回解析不了、调用失败 → 转人工。
   输入：任务单全文 + 本会话所有投递正文（意图）、本回合之前的工具调用摘要、`config.json` 的
   `environment` / `sensitive`、证据（目标文件是否已存在、工作区脏不脏）、cwd 下的 AGENTS.md / CLAUDE.md。
   soft 规则原样搬，任务单同时点到「动作」和「对象」才算清除。
   放行 → 应答 `allow_once`。
3. **挂起**：写 `runs/<id>/pending.json`（kind = permission，含工具名、参数、命中的红线或转人工理由），
   连接保持不答。**不过期**，只有 `approve` / `deny` / `cancel` 结束它。

**提问**（zcode 的 AskUserQuestion）不进红线和模型审批，直接挂起，kind = question，含问题和选项。
`answer` 应答。build 档下不会有 ExitPlanMode。

**`--task`** 是模型审批的意图来源。不给的话意图只有投递正文，越界判断没有依据，几乎全转人工——skill 里要求必给。

## 7. 存储

```
~/.zcode-executor/                 ZCODE_EXECUTOR_HOME 可覆盖
  config.json                      allowedRoots（默认 [~/.zcode-executor/worktrees]）、waitTimeoutSec（1800）、
                                   preferredProvider、tiers 覆盖、environment、sensitive、
                                   review（enabled、model、thought 默认 low、fastMaxTokens 300、
                                   slowMaxTokens 2000、timeoutMs）。都可选
  sessions.json                    登记簿：本地 id、zcode 的 sess_（首回合后）、标题、cwd、是否 worktree、等级、模型、思考等级、创建时间、上次结果
  worktrees/<仓库名>/               执行副本，Claude 建
  runs/<本地 id>/
    state.json                     runner 状态、pid
    events.jsonl                   zcode 事件原样 + 本项目自己的动作（投递、闸门各段结果、approve/deny/answer）
    last.json                      上次回合结果
    pending.json                   挂起中的审批请求或提问，答完删除
    answer.json                    approve/deny/answer 写的应答，runner 消费后删
    cancel                         叫停当前回合的标记，runner 见到就发 session/stop 并替人拒答挂起，处理完删掉
    runner.log                     runner 的 stderr
    queue/                         排队的投递
    lock                           O_EXCL 锁
    stop                           收摊标记，runner 做完手上这条就不再取队列、关连接退出
```

只有一个审计源：`events.jsonl`。查一条会话的来龙去脉只看一处。
`~/.zcode/v2/config.json` 只读，`doctor` 只查它存在。

## 8. runner

- 一条会话一个 runner 进程，没有常驻 daemon，一律后台起；`send --wait` 只是跟看文件，挂起时连接由 runner 保持。
- runner 的一生：拿锁 → 拉起 app-server 子进程 → `session/resume`（登记簿里还没有 `sess_`，或 resume 报
  Session not found，就 `session/create` 并把新 id 写回登记簿，记一条 `executor.recreated`）→ 循环消费 queue →
  队列空或见到 stop 标记就退出。
- 挂起期间 runner 和 app-server 子进程都活着。
- 多条会话可同时跑，各自一个 app-server 子进程，不设上限。
- 回合结束靠 `turn.completed` / `turn.failed` / `turn.terminal`。先不做无信号兜底，遇到挂死再加。
- 反向请求未答会每秒重发一次同一 requestId，要去重。

## 9. skill

`skills/zcode-executor/SKILL.md` 要教的：

- 铁律：任务单是契约，消息只是门铃；验收看 `git diff` 和测试；反复投同一条会话三四轮没过就回去改任务单；不替用户批越界。
- 派活前先写任务单，`send` 必带 `--task`（绝对路径）。任务单里别写凭据：全文会作为授权依据发给模型审批。
- 命令一律用本地派单 id；zcode 的 `sess_` 只在 `list` 里对账用。
- 验收前先 `git -C <执行副本> add -A`：执行端不提交，新文件不收进暂存区就看不到。
- 等级与思考等级的选择指南（第 5 节）。
- 退出码 5 的两种处理：审批请求用 AskUserQuestion 转给人再 `approve` / `deny`；提问自己先判断能不能答，能答就 `answer`。
- `--steer` 是插话不是打断；要打断先 `cancel`。
- `follow` 用后台任务起，别在前台 timeout 包着等。
- 不要在 ZCode App 里打开正在跑的会话（共用 sqlite，没有跨进程锁）。
- git 操作一律 `-C <绝对路径>`，主仓合并、执行副本切分支分清楚；切新分支前核对 main 已含上一单（踩过）。

## 10. 测试与验证

- `npm test` 只对 `test/mock-appserver.mjs` 跑，不花额度。
- 真机分两类：零 token 的（握手、create、readState、list、close）随手验；
  花额度的（`session/send`）每步只做一次，见 handoff 的完成判据。
- ~~验收标准：新开一个 Claude Code 会话，只靠 skill 完成一次派单、挂起、审批、验收~~ 已达成（T4.2，2026-09-08）。

## 11. 开工前要在真机上验的事实（都已验完，留作出处索引）

零 token：

- ~~`session/requestRuntimePreferences` 是否先于 create 到达~~ 已验：0.16.5 直连没收到，处理器保留但不等它。
- ~~不同步 provider 表时 create 返回的模型对不对~~ 已验：不推表 create 直接被拒，必须推（decisions D10）。
- ~~`toolDenylist` 的字段名和取值格式~~ 已验：`--deny "Write Edit MultiEdit"` 后模型全程碰不到这些工具（verified.md「交付后七项核验」⑤）。
- ~~`workspace/generateText` 的 `querySource` 填什么被接受；`modelRef.variant` 传思考等级是否生效~~ 已验：`zcode-executor.review` 被接受，`modelRef.variant` 传得进去（当时试的是 high，现在审批默认 low）（verified.md）。

花额度：

- ~~`build` 档下哪些操作会发审批请求~~ 已验一部分：Write 会发（verified.md「第一次真机投递」），Bash 跑 git 也会发（verified.md「检查点 2」）。
- ~~`turn.completed` 够不够判回合结束~~ 已验：够，且 payload 带回答全文和 usage。
