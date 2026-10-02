# PRD — zcode-executor

> 状态：第一版已实现（2026-09-08）；模型审批部分已按批准的 Jev 修订路线（`docs/jev-hardening-plan.md`，本地记录，不进仓库） 更新为目标合同，实施与验证进度以对应记录为准。需求于 2026-09-07 对齐（31 个问题一轮轮问完）。
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
| `doctor [--offpeak] [--json]` | 自检五步，都不花额度：① `zcode.cjs` 旁边找得到 `config/provider/zcode-builtin.json`（3.12+ 判据，找不到提示升级 ZCode App）→ ② provider 两个来源各报状态（账号型 `credentials.json` 是否登录、`config.json` 备用来源）并报选中的 provider → ③ 真握手一次（零 token），报模型等级、provider key 状态 → ④ 新启动 runner 的审批链（可选 Jev 前筛 → ZCode 快筛 → 慢判；只读配置，不联网探测 Jev）→ ⑤ 闲时接口自检：会联网，并起一个带假号的闲时回合（服务器直接拒掉，零额度），见下面「闲时投递」。`--offpeak` 只跑 ⑤ |
| `quota [--json]` | 今天的闲时取号情况，零额度、不起 app-server、不取号：本工具今天取过几次号（数 `runs/*/events.jsonl` 里机器本地今天 0 点以后的取号与重取号事件，修改时间早于今天的文件整个跳过，读不了的文件跳过并在 stderr 说一行；App 里用的不计入；每天约 3 次是观察值）+ 服务器现在能不能取（不能时给可再取的本地时间）。人读一行；`--json` 为 `{usedToday, estimatedDailyLimit, canTakeNumber, nextTakeAt, state, reason}`，`state` 同 doctor ⑤ 的四态。只有「接口变了」退出码 1，额度用完也是 0（见下面「闲时投递」） |
| `models [--json]` | 从两个来源本地换算可用模型（账号型：`credentials.json` 解出的 key + 内置 provider 文件的模型表；legacy：`~/.zcode/v2/config.json`；3.12 起 `workspace/readState` 已删，不握手），显示每个模型的思考等级、自动分到哪个等级 |
| `list [--project 关键字] [--json]` | 列登记簿里的会话：id、标题、cwd、等级、上次结果、是否挂起；`--json` 每行带所属仓库 `repo` |
| `new --cwd <绝对路径> [--title T] [--tier fast\|strong] [--thought 档] [--deny "工具…"] [--provider id] [--json]` | 建会话。cwd 必须在白名单内；不是 worktree 只警告不拒 |
| `send <id> <正文\|-> [--task 文件] [--wait] [--steer] [--timeout 秒] [--stream] [--json]` | 投递。默认排队；`--steer` 走 `v4/command` 的 `sendText`（guide）插进当前回合，在下一个工具边界生效、没有边界时排到回合结束后执行，不打断 |
| `send <id> <正文\|-> --offpeak [--task 文件] [--wait] [--timeout 秒] [--stream] [--json]` | 闲时投递：当场取号，排到号才用免费闲时算力开跑，不占套餐额度（见下面「闲时投递」）。不和 `--steer` 同用 |
| `send <id> --offpeak --resume [--wait] [--stream] [--json]` | 回合 exited 或 runner 崩了之后，只重新拉起 runner 接着跑队列里那次闲时投递，不入队、不取号 |
| `follow <id> [--timeout 秒] [--stream] [--json]` | 跟看后台 runner，写出新结果就返回 |
| `status <id> [--tools N] [--json]` | 只读快照：phase（`running` 在跑 / `idle` 队列空 / `pending` 挂起 / `exited` 正常收工 / `stale` runner 半路没了）、最近工具调用、队列长度、上次结果、挂起了多久；`--json` 带所属仓库 `repo`，`tools[]` 每项带参数摘要 `summary` |
| `watch [--json]` | 只读、常驻：盯所有会话，某条有变化就输出它的完整快照（阶段、回复末尾几行、当前工具、最近工具、挂起内容、闲时排队、所属仓库），同一会话最多每 300 毫秒一次；读的一方断开或父进程没了就退出。给观察面板用（decisions D22），不花额度 |
| `cancel <id>` | 叫停：挂起的先答拒绝，再 `session/stop`，之后不再取队列 |
| `approve <id>` | 应答当前挂起的审批请求，只回 `allow_once` |
| `deny <id>` | 应答当前挂起的审批请求为拒绝 |
| `answer <id> [--] <值…>` | 应答当前挂起的提问：有选项按 value、label 或序号匹配，多选一个参数里逗号分隔；无选项就是自由文本。值以 `--` 开头时先用 `--` 分隔 |

退出码：

| 码 | 含义 |
| --- | --- |
| 0 | 回合干完了，去验收 |
| 1 | 用法错、zcode 起不来、版本过低 |
| 2 | 被拒：白名单外、会话不在登记簿、等级或思考等级不合法；闲时投递取号前或取号时被拒（会话不空闲、模型不在闲时模型表、没登录或团队版、没有闲时资格、额度用完、取号时鉴权被拒（401/403，要在 App 里重新登录）、闲时服务暂时不可用、闲时接口可能变了）；闲时投递占着会话时的普通投递与排号中的 `--steer`；`--resume` 没有可恢复的闲时投递 |
| 3 | `send --wait` 超时，当前回合已取消，会话还在可再投；`follow --timeout` 到点只是旁观者走了，不取消任何东西 |
| 4 | 回合异常：`turn.failed`、被中止、撞输出上限 |
| 5 | 挂起等人：审批请求或提问 |

- `--wait` 默认 1800 秒（config `waitTimeoutSec`），到点取消当前回合。挂起不算超时，一挂起立刻返回 5。
- `--json` 输出里 `id` 是本地派单 id，`sessionId` 是 zcode 的 `sess_`（首回合前为 null），所有命令一致。
- `send --wait` 与 `follow` 结束时打两块摘要：「闸门：放行 N 次（红线挂起 a、快筛 b、慢判 c、转人工 d）」与「改动：文件列表；Bash 条数」；`--json` 对应 `summary:{gate:{allow, ask, hard, fast, slow}, files:[…], bashCount}`。
- `status` 的最近工具一次调用一项，带参数摘要：`Bash(npm test)`、`Edit(src/a.mjs)`，没有摘要的写工具名；`list` 的挂起行末尾标「挂起: 工具名」。
- 一条会话同一时刻最多一个挂起（审批在回合内串行）。`approve` / `deny` / `answer` 应答的就是那一个。
- `--thought` 的值在建会话前对着该模型的合法档位校验，不合法退出码 2（`session/create` 遇到非法值会静默忽略，不能靠它报错）。
- `watch --json` 每行一个对象：开头 `{type:'hello', repo}`（启动目录的所属仓库），之后 `{type:'session', session}`；首轮全部输出完是 `{type:'synced'}`，会话从登记簿消失是 `{type:'removed', id}`。快照字段与 `status --json` 不同名的才是新含义（`activeTool`、`recentTools`、`pendingDetail`、`offpeakQueue`、`reply`、`since`、`lastEndedAt`）。
- 正文写 `-` 从 stdin 读。`--json` 给机器可读结构。
- `doctor` 的退出码与 `--json.ok`：①–③ 有一步失败，或 ⑤ 的结论是「接口变了」（changed），`ok` 为 false、退出码 1；⑤ 的另外三种结论（正常、暂时不可用、不适用）不影响两者。⑤ 加进来之前 `ok` 只看 ①–③（2026-09-27 起才看 ⑤）。`--json` 加 `offpeak: {state, layer, expected, actual, reason, logid, appVersion, verifiedAppVersion}`；`doctor --offpeak --json` 只输出 `{ok, offpeak}`（另外，测试用的闲时服务地址环境变量 `ZCODE_EXECUTOR_OFFPEAK_ORIGIN` 配错时，`doctor --offpeak` 也以 1 退出）。

### 闲时投递

规格见 `docs/SPEC-offpeak.md`（本地记录，不进仓库），为什么这么定见 decisions D20。

- **是什么**：投递的一个属性，会话没有类型。回合用 Coding Plan 订阅的免费闲时算力跑，不占套餐额度；开跑时间由服务器决定——先取号排队，号就绪才开跑。验收与普通投递相同。只支持个人版 Coding Plan，会话的模型要在闲时模型表里。
- **谁来选**：派单默认普通投递，闲时由用户选择——Claude 每个对话第一次派单前跑 `quota` 查今天用量，把「可以改走闲时、今天已用几次、现在能不能取」告诉用户，说完照常普通投递、不等回答，用户选了才在之后的投递发 `--offpeak`；返工同样默认普通投递（decisions D20 2026-09-28 补充）。
- **独占空闲会话**：发闲时投递时会话要空闲（没有活着的 runner、队列为空），否则退出码 2。闲时投递排号或运行期间，同一会话的普通投递被拒；`--steer` 只在回合开跑后放行。约定另开一条会话专门发闲时投递，做完后可在同一会话接着发普通或闲时投递返工。
- **当场取号**：`send --offpeak` 当场向闲时服务器取号，取号失败退出码 2，报错写明原因与怎么办。取号成功后不带 `--wait` 立刻以 0 返回，人读 `send: 已取号，排第 N 位（闲时投递 <offPeakId>）`，`--json` 在原有字段上加 `offpeak: {offPeakId, ticketId, position}`。
- **排号不计入 `--timeout`**：`--wait` 的计时从回合开跑算起；回合结束后的退出码与普通投递相同。`--stream` 排号期间每次轮询在 stderr 打一行排位。
- **号失效自动重取，最多 3 个号**：号在就绪前过期，或回合因号失效失败（错误码 3102 / 3104 / 3001），runner 自动重取（同一次投递，最多重取 2 次），就绪后在同一会话发续跑提示接着做；每个续跑回合的 `--timeout` 重新计时。3 个号用完或重取被服务器拒，投递以 `failed` 结束（退出码 4），执行副本里的改动保留。
- **cancel 在任何阶段都结算号**：排号中、运行中、重取中、runner 已不在，`cancel` 都会结算当前号；还没结局的投递以 `cancelled` 结束，已有结局的不改写。runner 在时由 runner 结算，失败退避重试 3 次；runner 不在时由 CLI 结算一次。仍失败的号记进 `runs/<id>/offpeak.json` 的 `unsettledTickets`，`status` 显示「闲时：号 … 未结算」。
- **exited 之后用 `--resume` 恢复**：回合 exited 或 runner 崩了，队列里那次闲时投递还在，这时普通 send 被拒并提示两条路：`send <id> --offpeak --resume` 接着跑（不带正文、`--task`、`--timeout`，带了算用法错，退出码 1；没有可恢复的投递退出码 2；不带 `--wait` 时 `--json` 加 `offpeak: {offPeakId, resumed: true}`），或 `cancel` 收掉。
- **显示**：`status` 与 `follow` 在闲时投递期间多一行排位、就绪或运行中（带截止时间），另有「号 … 未结算」「投递 … 没收尾」；`status --json` 与 `follow --json` 一律带 `offpeak` 字段（offpeak.json 的内容，没有时为 null）。macOS 上从等号到收尾挂 `caffeinate` 防空闲睡眠。
- **健康检查 `doctor --offpeak`**：只跑 doctor 的 ⑤，查凭据、内置条目、服务器约定、假号全链路四层，结论四种：正常 / 接口变了 / 暂时不可用 / 不适用。只有「接口变了」退出码 1，适合挂在用户自己的 cron 上；stdout 总会有一行结论，cron 里丢掉 stdout、只看退出码与 stderr。App 版本不是真机验证过的那个时 stderr 多一行提示，不影响结论。代价：每跑一次，zcode 命令行自己的会话库里多一条自检会话，App 的任务列表看不到。

## 5. 模型等级与思考等级

- **两个等级**：`fast`（Flash、lite、mini、air 这类）和 `strong`（旗舰）。
- **对上具体模型**：从两个来源本地换算列表（账号型来源用内置 provider 文件的 `builtinModelIds` 与 `modelRules`；legacy 来源用 `~/.zcode/v2/config.json`；3.12 起 `workspace/readState` 已删），按模型名关键词自动分，同档多个取版本最新的。
  `doctor` 握手时把返回的 `settings.model.available` 里 `zcode-executor` 名下的模型和本地清单比对，缺的进警告。`config.json` 的 `tiers` 可覆盖。不按模型名写死，模型换代不用改代码。
- **provider 优先账号型个人版 coding plan，其次账号型团队版，再次 `config.json` 里的 coding plan**（配置 `preferredProvider` 可改，如 `account:bigmodel-team-coding-plan`），国内 `bigmodel` 与国际 `zai` 站点哪个登录用哪个。
- **不给 `--tier`** 用 `fast` 档，没有 `fast` 才用 `strong`。
- **派活的思考等级默认 `high`**，模型没有 `high` 档就不传，跟模型默认。`--thought` 可覆盖。ZCode 模型审批默认 `low`，配置 `review.thought` 可改；若配置里有非空白 `review.jev.apiKey`，原快筛之前增加 Jev 前筛，ZCode 快筛与慢判仍用该思考等级。
- **档位只有 `build`**。不开 `--mode`。
- **`--deny`** 默认不拿掉任何工具。

skill 里的选择指南：机械改动 → `fast`；常规实现 → `fast`；难活（要取舍、调试难复现、改陌生代码）→ `strong`。
Flash 类模型思考等级不要往低调，效果差。

## 6. 闸门

执行端发来的 `interaction/requestPermission` 和 `interaction/requestUserInput` 都进闸门。

**审批请求**走三段，每个请求写一个最终 `executor.gate` 事件到 `events.jsonl`，事件里的 stage 取这几个值（Jev 前筛细节嵌在 `preScreen`，历史 `fastReview` 保留旧义）：
`hard`（红线）、`no-allow-option`（options 里没有 `allow_once`，放不出来）、`review-fast`（快筛放行）、
`review-slow`（慢判）、`review-failed`（模型调用或解析失败）、`review-disabled`（配置关了模型审批）、
`gate-error`（闸门自己出错）、`question`（提问直接挂起）。

1. **红线**（写死在代码里，谁也推不翻）：
   - hard 规则表沿用 Claude Code auto 模式的类别（凭据外泄等）。
   - **本项目专属**：带路径参数的工具（Write、Edit 等）路径解析成绝对路径后不在 cwd 之下 → 转人工。
     Bash 的路径没法可靠解析，不做红线，交给模型审批并在提示词里写明「任何越出执行副本的写入或删除一律转人工」。
   - 命中即挂起，不进模型审批。
2. **模型审批**：可选 Jev 前筛 → 原 ZCode `fast` + `low` 快筛 → 必要时慢判。非空白 `review.jev.apiKey` 启用前筛；Jev pass 提前放行，flag/error/skip（含超时、非法响应、adapter 异常）都回到原快筛。无 key 时原链路不变。原快筛结果未通过或无法解析才进入慢判；原快筛调用失败仍以 `review-failed` 转人工。
   原快筛收到既有的完整 action/context，不使用 Jev 缩减后的 state，也不接受 Jev 概率作为指令；提示词、思考等级与解析规则沿用原合同。ZCode 快筛输出预算 300 token（`review.fastMaxTokens`），慢判 2000（`review.slowMaxTokens`）。Jev 不设 shadow/mode，也不从环境变量读取 key。含 Jev key 的 `~/.zcode-executor/config.json` 必须是当前用户拥有的普通非符号链接文件且权限不宽于 `0600`，否则配置读取失败。
   慢判要求**第一行就是结论行**（`结论: allow` / `结论: ask` / `结论: deny <规则 id>`），理由写在后面——
   结论放最后一行时推理一长就被截断，整次判定作废。
   **只产出放行或转人工，从不拒绝**；慢判返回解析不了、调用失败 → 转人工。
   ZCode 慢判输入：任务单全文 + 本会话所有投递正文（意图）、本回合之前的工具调用摘要、`config.json` 的
   `environment` / `sensitive`、证据（目标文件是否已存在、工作区脏不脏）、原仓库（不是执行副本）下的 AGENTS.md / CLAUDE.md——只当背景，不构成用户授权。
   Jev 前筛只发送脱敏且最小化的任务契约、最近消息和工具输入。Write/Edit/MultiEdit 正文省略、缺少有效意图、命令或授权信息截断、无法可靠脱敏时，本地 skip，不发 HTTP，直接运行原快筛。Jev 的五项负向风险为 scope conflict、worktree 外写、凭据/外发、破坏/外部副作用、明显无关/无必要，全部概率 `<=0.20` 且本地证据充分才 pass；复杂 Bash、管道、子 shell、批处理和项目脚本本身不是风险或跳过理由。
   soft 规则原样搬，任务单同时点到「动作」和「对象」才算清除。
   放行 → 应答 `allow_once`。
3. **挂起**：写 `runs/<id>/pending.json`（kind = permission，含工具名、参数、命中的红线或转人工理由），
   连接保持不答。**不过期**，只有 `approve` / `deny` / `cancel` 结束它。

**提问**（zcode 的 AskUserQuestion）不进红线和模型审批，直接挂起，kind = question，含问题和选项。
`answer` 应答。build 档下不会有 ExitPlanMode。

**`--task`** 是模型审批的意图来源。不给的话意图只有投递正文，越界判断没有依据，快筛更容易 flag——skill 里要求必给。

每次审批只记一个最终 `executor.gate`：`stage:"review-fast"` + `reviewer:"jev"` 表示前筛提前通过，同一 stage + `reviewer:"zcode"` 表示原快筛通过；慢判/调用失败的最终 reviewer 为 ZCode。独立 `preScreen` 记录 Jev pass/flag/error/skip 与允许的原因、耗时、次数和概率等元数据；skip 不伪装成模型 flag。历史 `fastReview` 保持旧 Jev 回落含义，不改作 ZCode 快筛记录。终态统计不重复计数，字段合同见 SPEC。

`doctor --json` 的 `review.pipeline`：启用且有 key 为 `['jev','zcode-fast','zcode-slow']`，无 key 为 `['zcode-fast','zcode-slow']`，关闭 review 为 `[]`，配置读取失败为 `null` 并说明不可确定。旧 `fastScreen` 字段仅兼容第一可选筛选器的名称，不代表替代 ZCode 快筛。

## 7. 存储

```
~/.zcode-executor/                 ZCODE_EXECUTOR_HOME 可覆盖
  config.json                      allowedRoots（默认 [~/.zcode-executor/worktrees]）、waitTimeoutSec（1800）、
                                   preferredProvider、tiers 覆盖、environment、sensitive、
                                   review（enabled、model、thought 默认 low、fastMaxTokens 300、
                                   slowMaxTokens 2000、timeoutMs、jev.apiKey）。都可选；含 Jev key 时文件必须 0600
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
`~/.zcode/v2/config.json` 与 `~/.zcode/v2/credentials.json` 只读；`doctor` 只报它们在不在、key 在不在，不打内容。

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
- 闲时投递：什么时候用、另开会话发、退出码 2 的几种原因怎么处理、`--resume` 与 `cancel`、`doctor --offpeak`。
- 不要在 ZCode App 里打开正在跑的会话（共用 sqlite，没有跨进程锁）。
- git 操作一律 `-C <绝对路径>`，主仓合并、执行副本切分支分清楚；切新分支前核对 main 已含上一单（踩过）。

## 10. 测试与验证

- `npm test` 只对 `test/mock-appserver.mjs` 跑，不花额度。
- 真机分两类：零 token 的（握手、create（含模型表）、list、close）随手验；
  花额度的（`session/send`）每步只做一次，见 handoff 的完成判据。
- ~~验收标准：新开一个 Claude Code 会话，只靠 skill 完成一次派单、挂起、审批、验收~~ 已达成（T4.2，2026-09-08）。

## 11. 开工前要在真机上验的事实（都已验完，留作出处索引）

零 token：

- ~~`session/requestRuntimePreferences` 是否先于 create 到达~~ 已验：0.16.5 直连没收到，处理器保留但不等它。
- ~~不同步 provider 表时 create 返回的模型对不对~~ 已验：不推表 create 直接被拒，必须推（decisions D10）。
- ~~`toolDenylist` 的字段名和取值格式~~ 已验：`--deny "Write Edit MultiEdit"` 后模型全程碰不到这些工具（verified.md「交付后七项核验」⑤）。
- ~~`workspace/generateText` 的 `querySource` 填什么被接受；`modelRef.variant` 传思考等级是否生效~~ 已验：`zcode-executor.review` 被接受，`modelRef.variant` 传得进去（当时试的是 high，现在审批默认 low）（verified.md）。3.12 起 `modelRef` 改名 `selection`、`variant` 改成 `options.reasoningLevel`，见 decisions.md D14。

花额度：

- ~~`build` 档下哪些操作会发审批请求~~ 已验一部分：Write 会发（verified.md「第一次真机投递」），Bash 跑 git 也会发（verified.md「检查点 2」）。
- ~~`turn.completed` 够不够判回合结束~~ 已验：够，且 payload 带回答全文和 usage。
