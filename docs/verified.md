# 本机实测（2026-09-07）

写的是当时的情况。文件、版本、命令用之前先确认还在。

## 本机环境

| 东西 | 情况 |
| --- | --- |
| ZCode 桌面 App | 3.11.2，已登录，运行中，当天新装（`recentProjects` 为空） |
| ZCode CLI | 0.16.5，在 `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs`，App 没把它放进 PATH |
| 凭据 | `~/.zcode/v2/config.json`，`builtin:bigmodel-coding-plan` 带 key，模型 `GLM-5.3` / `GLM-5.3-Flash`；`builtin:zai-start-plan` 禁用且 models 为空 |
| Node | app-server 子进程需要带 `node:sqlite` 的 Node ≥ 22；zcode-acp 的 `backend/resolve.js` 有探测逻辑 |

## 跨平台（2026-09-08，CI 实测）

- GitHub Actions 上 ubuntu-latest 与 windows-latest、Node 22 与 24 四档全跑得起来，不用装依赖。
- **`node --test` 的 glob 不能加引号。** `node --test 'test/*.test.mjs'` 在 Windows 上一个文件都匹配不到：
  npm 在那边用 pwsh/cmd 起脚本，单引号不会被剥掉，node 收到的是带引号的字面串。
  而 `node --test` 匹配不到任何文件时**退出码是 0**（本机实测），于是整档 CI 假绿、`tests 0` 藏在日志里。
  去掉引号两边都对：POSIX 的 shell 自己展开，Windows 交给 node 的 glob。
- **别拿目录当参数。** `node --test test/` 会把 `helpers.mjs`、`mock-appserver.mjs` 这些非测试文件也当测试跑，直接失败。
- **Windows 上已知的真实差距（CI 实测，非测试问题）**：
  - 队列文件名不能带冒号。ISO 时间戳直接当文件名在 Windows 上一律 ENOENT，`send` 全挂（已修，`lib/queue.mjs`）。
  - `SIGTERM` 收不到。Node 的处理器不跑，runner 的收尾（state 定稿、删锁）不发生，退出码是 null 不是 0，
    锁文件会残留。要支持得改成 Windows 上另找一种停机信号。
  - `process.kill(-pid, 'SIGKILL')` 杀进程组不成立（`lib/appserver.mjs`），只能杀直接子进程，zcode 的孙子进程会成孤儿。
    这条 CI 覆盖不到（要真 zcode），是读代码得出的。
  - 路径包含判定用字符串前缀比较（`lib/review/hard.mjs`），Windows 大小写不敏感可能误判成越界。
    方向是保守的（多转人工，不会误放行），同样没被 CI 覆盖。
- **两条用例在 CI 上偶发失败**：`run.test.mjs` 的「exitAfter:send 重投」与 `appserver.test.mjs` 的
  「信封 id 只保留最近 5 个」。都起真子进程卡时序，同一个 commit 连跑三轮，前两轮各挂一条、第三轮全绿；
  本机 Node 22 与 25 各跑三次都过。看红之前先重跑一次再判断。
- 测试套件里六条用例是 Unix 专属手段（SIGSTOP 冻 runner、`/tmp` 符号链接归一），Windows 上跳过，不是产品缺陷。
- ZCode App 装在哪（抄自 zcode-acp `resolve.js` 的 `bundledZcodeCandidates`）：macOS `/Applications/ZCode.app/…`
  与 `~/Applications/…`；Linux 常见于 `/opt/ZCode/resources/glm/zcode.cjs`、`/usr/share/zcode/resources/glm/zcode.cjs`，
  但官方说法是「解压出来的应用目录里」，位置不固定；Windows 是 `%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs`（未验）。
  三个平台都能用 `ZCODE_BIN` 兜底。

## app-server 协议

协议全文见 `reference/zcode-app-server-protocol.md`。下面是本机跑出来、
文档没写或与文档有出入的部分。实测经 zcode-acp-server 0.17.1 做，
标「直连不适用」的是 zcode-acp 自己造的行为。

| 验的点 | 结果 |
| --- | --- |
| 启动 | `[node, zcode.cjs, "app-server", "--stdio"]`；coder-mcp-bridge 另设 `ELECTRON_RUN_AS_NODE=1`、`NO_COLOR=1`、删掉 `ZCODE_MODEL` |
| 信封 | 0.16+ 没有 `jsonrpc` 字段：请求 `{id, method, params}`，响应 `{id, result}` / `{id, error}`，通知 `{method, params}` |
| 握手 | 新版 app-server 会先发 `session/requestRuntimePreferences` 反向请求，不答则 `session/create` 卡住。zcode-acp 回 `{nativeSearchEnhancementsEnabled:false, memoryEnabled:false, askUserQuestionAutoResolutionEnabled:false}` |
| `session/create` | 立刻返回真 `sess_` id。coder-mcp-bridge 传 `{workspace:{workspacePath,workspaceKey}, persistence:"immediate", titleGenerationEnabled:false}` 加可选 `mode`（plan/build/edit/yolo/auto）、`toolAllowlist`、`toolDenylist`、`runtimeModel`、`thoughtLevel` |
| 反向请求 | `interaction/requestPermission`、`interaction/requestUserInput`（AskUserQuestion、ExitPlanMode）、`interaction/requestProviderRuntimeHeaders`、`interaction/requestOfficialMcpAuthHeaders`。未答的请求每秒重发一次，同一 `params.requestId` 但**信封 id 每次都换**；zcode-acp 的做法是记下所有信封 id，答案出来后逐个回，并缓存结果给迟到的重发（`handlers/server-requests.js` 271 到 290 行）。只回第一个信封 id 对端认不认，未验，别赌 |
| 审批 | yolo 档全程 0 次审批请求，直接写文件。允许类 optionId 含 `allow_once`，未识别的 id 一律当拒绝。**应答形状**（zcode-acp `interaction/adapter.js` 与 `handlers/server-requests.js`）：`requestPermission` 回 `{decision:"allow"}` 或 `{decision:"deny", reason}`；`requestUserInput`（AskUserQuestion）回 `{action:"accept", content:{answers:{[question 原文]: "value"}}}`（多选用 `", "` 拼接），拒答回 `{action:"decline", reason}`；ExitPlanMode 的应答也走 `{decision}`，build 档不会遇到 |
| 回合结束 | `turn.completed` / `turn.failed` / `turn.terminal` 事件。zcode-acp 另有一套 120 秒无信号与 10 分钟水位线冻结的兜底，直连时是否需要待验 |
| `session/send` | 回合进行中再发一条会被当作 steer 输入排队 |
| 事件种类 | `turn.started`、`model.streaming`、`tool.updated`、`turn.completed`、`turn.failed`、`session.updated`、`state.updated`（模型/档位切换）；另有 `computer-use/operation-event`、`process/mcpTelemetry` 可丢弃 |
| resume | 跨进程 resume 保住模型选择和上下文（zcode-acp 0.17.1 上 resume 后首次投递被拒，根因是它同步 provider 表时没过滤空 provider，0.18.1 已修；直连时自己过滤） |
| 已删方法 | 0.16+ 删了 `session/steer`、`session/rewind`、`prompt/enhance*`；0.16.5 删了 `automation/*` |
| `workspace/generateText` | 从 zcode.cjs 的 zod schema 核出（未真机调用）：params `{workspace, modelRef:{providerId,modelId,variant?}, prompt 或 messages（至少一个）, tools?, querySource（必填字符串）, maxOutputTokens?, operationId?}`，**没有 thoughtLevel 字段，思考档走 `modelRef.variant`**；result `{text, modelRef, toolCalls?, finishReason?, usage?}`。复用该 workspace 已有会话进程，没有就临时起一个用完关。`cancelGenerateText` 参数 `{operationId}`。zcode-acp 没用它 |
| `workspace/readState` | 唯一返回可用模型全集的方法。params `{workspace, preferWorkspaceDefaults?, runtimeModel?}`；result `settings.model.{current,available[],lastUsed}`，每个模型有 `ref、label、reasoning.{enabled,levels[],defaultLevel}、disabledReason`；`settings.thoughtLevel.{enabled,current,defaultLevel,available[]}`。`session/read` 的 result 带同一份 settings。zcode-acp 不走它，直接读 config.json |
| 思考等级 | 协议层是自由字符串，合法值按模型定。GLM-5.3 族 `low / high / max`（默认 max），无 medium 无关闭；GLM-5.2 有 `nothink`；toggle 类模型是 `enabled / disabled`。`session/create` 传非法值**静默忽略**只打 warn；`session/setThoughtLevel` 才报错。CLI 认 `disabled/none/off/nothink` 为关闭，但只有出现在该模型 levels 里的才可用 |
| diff | 协议只给改动文件名，不给内容。验收靠 `git diff` |

## 直连探针实测（2026-09-07，CLI 0.16.5，T0.2）

| 验的点 | 结果 |
| --- | --- |
| `session/create` 直连 | **不先推 provider 表就被拒**：`-32603 ModelProtocolError: Model config is missing. Create ~/.zcode/cli/config.json with an explicit model provider`。本机 `~/.zcode/cli/config.json` 只有 `skills` 一项，模型和 provider 全在 `~/.zcode/v2/config.json`，app-server 不自己读它 |
| provider 表 | zcode-acp 在 `session/create` **之前**发 `workspace/updateProviderRegistry {workspace, registry:{providers[], generatedAt, revision}}`，registry 从 `~/.zcode/v2/config.json` 的 `provider` 构造：每项 `{providerId, kind, apiFormat（anthropic→anthropic-messages）, baseURL, label, models[]（数组，不是对象）, source, apiKey:{source:"inline", value}}`；`models[]` 每项 `{modelId, label?, contextWindow?, maxOutputTokens?, reasoning:{enabled, levels[{value,label}], defaultLevel}}`。**models 为空的 provider 必须过滤掉**（schema 要求 ≥1），本机 `builtin:zai-start-plan` 的 `models` 是空**数组** `[]`（其余是对象） |
| 本机 config.json 形状 | 顶层只有 `provider`；六个 provider 都是 `kind:"anthropic"`、`source:"custom"`，`enabled` 缺省视为启用；`options.{apiKey, baseURL, apiKeyRequired?}`；`models` 是对象 `{GLM-5.3:{…}, GLM-5.3-Flash:{…}}` |
| `session/requestRuntimePreferences` | 直连 0.16.5 时**没有收到**（至少在 create 被拒之前没有）。应答处理器保留，但不能等它 |
| `workspace/readState` 未推表时 | 正常返回但 `modelCatalog.available` 和 `settings.model.available` 为空，`current` 是 `{providerId:"zcode-unconfigured", modelId:"missing-model"}`，`thoughtLevel.enabled:false`。所以等级分配必须在推表之后读 |
| 推表之后（T0.2b） | `updateProviderRegistry` 回 ok，后端把 `revision` 原样记为 `appliedProviderRevision`（变更门，稳定哈希有用）。`session/create` 成功返回 `sess_` id 和 settings：`mode.current:"build"`，`thoughtLevel.current:"high"`（传入被接受并回显，available `low/high/max`，defaultLevel `max`），**默认模型落在 `builtin:bigmodel`（API Key 计费那条）而不是 coding-plan**，同名模型在三个 provider 下各一份，共 6 条。`list` 返回数组，含刚建的 id；`close` 返回 `{closed:true}` |
| 响应形状（T0.3 抓取） | `updateProviderRegistry` 回 `{appliedProviderRevision, providerCount, status, workspace, workspaceState}`；`session/list` 回 **`{sessions:[…]}` 对象**（每项含 sessionId 等），不是裸数组；`session/subscribe` **必须带 `deliveryKind`**（用 `desktop-continuous`），缺了被拒 |
| `toolDenylist` | `['WebSearch']` 在 schema 层被接受，create 不报错。是否真的屏蔽了工具要等有回合时验 |
| `session/requestRuntimePreferences` 时序 | **在 create 成功之后**才到，params `{sessionId, scope:"runtime-materialization"}`。所以它不是 create 的前置握手，是 create 之后的物化阶段请求；处理器要常驻，不能只在 create 前等 |
| cli 日志 | 探针会话只有 info 和一条 warn `session.model_selection.persist_failed`（Session model selection persistence failed，无 details），没有 error。warn 的影响未知，先记着 |



## 第一次真机投递（2026-09-07，CLI 0.16.5，检查点 1）

两次花额度：投递「新建 hello.txt」一回合，杀进程后 resume 再问一句。

| 验的点 | 结果 |
| --- | --- |
| **create 必须带 `runtimeModel`** | 只推 provider 表不够：回合报 `provider_not_configured`「Model provider is missing an API key: builtin:bigmodel」（失败回合不计 usage）。create 带 `runtimeModel:{revision, generatedAt, model:{providerId, modelId}, provider:<registry 里那一项，含 apiKey:{source:"inline"}>}` 后回合正常，且 settings.model.current 就是指定的 provider/model（也解决了默认落到 API Key provider 的问题） |
| resume | 新进程 `session/resume {sessionId, workspace}` **不带 runtimeModel** 也能接上并正常投递，上下文完整（问「刚才建了什么文件」答 hello.txt） |
| build 档审批 | `Write` 触发 `interaction/requestPermission`，reason「Tool has side effects and requires approval」。**options 每项自带 `response` 对象**：`{kind:"allow_once", optionId:"allow_once", response:{decision:"allow", reason:"Approved once"}}`、`{kind:"allow_always", optionId:"allow_project", response:{decision:"allow", permissionUpdates:[{behavior:"allow", rules:[{toolName, ruleContent}], type:"addRules"}], reason:"Approved for this project"}}`、**`{kind:"deny", optionId:"deny", response:{decision:"deny", reason:"Denied"}}`（拒绝项 kind 是 `deny`，不是 deny_once）**。我们回 `{decision:"allow"}` 被接受 |
| 事件流 | 一回合：`turn.started`（payload 有 input、turnNumber、queryId）→ `session.updated`×8 → `model.streaming`×15 → `tool.updated`×4（kind: scheduled / started / 带 result / batch，`toolName` 在 scheduled 与 started 两条里）→ `permission.requested` / `permission.resolved` 各一条 → `checkpoint.created` → `turn.completed`。`turn.completed.payload` 有 `response`（最后回答全文）、`usage`（inputTokens/outputTokens/totalTokens/cacheReadTokens…）、`toolCallCount`、`duration`、`resultType:"success"`。另有大量 `v4/telemetry/event`（73 条）、`computer-use/operation-event`、`process/mcpTelemetry` 通知，可丢 |
| 额度 | 写一个文件的回合 input 32k / output 91（cacheRead 16k）；resume 后问一句 input 16k / output 9。系统提示很重，派活按回合数算账 |
| 未验 | `session/stop` 之后推什么；`inputSource: background_task`；挂起一分钟以上再 approve 旧信封 id 认不认；`turn.terminal` 未见（只见 completed） |
| cli 日志 | 每回合一条 warn `session.model_selection.persist_failed`，无 error |
| CLI 全链路（2026-09-08，T2.4b 快照，第四次花额度） | `new`（本地 id，不建会话）→ `send --wait` 立刻以 5 返回并打出 pending → `status` 显示 pending 与最近工具 → `approve` applied → `follow` 拿到 done（usage 与首投一致约 32k 输入）→ 文件写出 → `list` 显示本地 id 与 `sess_`。runner 首投 create 成功；cli 日志无 error |
| 审批请求的参数字段 | `interaction/requestPermission` 的 params 里工具参数在 **`input`**（真机 pending.json 已含 `toolName`、`input.file_path`、`input.content`、`input.command`）。MultiEdit 在 zcode 侧的形状未见过 |
| `workspace/generateText` 真机（2026-09-08，T3.2 `scripts/real-review.mjs`，第六次花额度） | 接受 `querySource:"zcode-executor.review"`、`modelRef.variant:"high"`（coding-plan Flash），messages 形式；一次快筛 5.3 秒，usage input 5010 / output 286；返回 `{text, usage}` 与 zod 核出的形状一致。模型对「任务单授权的 Write hello.txt」回 Y → 放行 |
| 提问真机（2026-09-08，第九次花额度） | `interaction/requestUserInput` params：`{questions:[{header, question, multiSelect, options:[{label, value, description}]}]}`（还有 requestId、sessionId、toolCallId）。**zcode 的 AskUserQuestion 工具没有独立的 value 字段**，模型自述「工具不支持 value 字段，改用 label 承载」，实际 options 里 value 与 label 相同。我们 `answer <id> 2` 送 `{action:"accept", content:{answers:{"<question 原文>":"用 hello"}}}`（label），zcode 接受并按选项写出 `hello`。answer 这条路通 |
| AskUserQuestion 应答的处理（zcode.cjs 源码，2026-09-08） | 应答 schema `{action:"accept"|"decline"|"cancel", content?: record, reason?}` strict。`content.answers` 按 **`question` 原文**作键（兜底 `content.answer_<下标>`，单问题时 `content.answer`）；值只 `trim()` 后**原样透传**给模型（`"问题"="答案"`），不与 options 的 value/label 比对；数组值按 `", "` 拼接，与字符串等价。下发的 `options[].value` 由 app-server 补，恒等于 `label`（模型侧 schema 无 value）。`answers` 为空对象 = 用户未答（模型自行判断）；键全对不上 → 工具报「requires user answers」失败。decline/cancel → 工具不执行，模型看到拒答。唯一按值精确比对的是 plan_approval：键固定「Review this implementation plan.」，值必须是 `approve` |
| 交付后七项核验（2026-09-08，第十一到十八次花额度，main cca7903） | ① **后台任务回合**：任务让模型用 Bash `run_in_background` 跑 `sleep 8 && echo done > bg.txt` 再轮询，整段只有一个 `turn.started`（turnNumber 0、无 inputSource），没有出现 `background_task` 回合，正常 `turn.completed`。0.16.5 的后台 Bash 完成不会另起回合（Agent 子代理未试）。② **挂起 75 秒后 approve**：zcode 接受应答并继续（9 秒后到下一步），客户端只留最近 5 个信封 id 的做法够用。③ **两条会话并行**：两个 runner、两个 app-server 子进程同时跑，24 秒内都 done，cli 日志无 error。④ **resume 报 Session not found → 重建**：把登记簿 sessionId 改成假的再投，`executor.recreated` 事件、create 成功、新 id 写回、文件写出。⑤ **toolDenylist 真的生效**：`--deny "Write Edit MultiEdit"` 后模型全程只用 Read 与 Bash（用 echo 写文件），Write 一次没出现。**cancel 后 `session/stop`**：5 秒宽限内 zcode 没有推任何 turn 结束事件（回合内 Bash sleep 在跑），只有 `tool.updated` 进度行；我们按宽限断开结算 `cancelled`，无孤儿进程。⑥ **`cancelGenerateText`** 真机返回 `{operationId, cancelled:false}`（那次 150 毫秒内已跑完），形状与 zod 核出的一致。⑦ **慢判**：Bash `git push --force origin main` 快筛 N → 慢判首行「结论： ask」，65 个输出 token，理由「命中 git-force-push…没点到 force push 也没点到 main」，2000 预算下没有截断。另：模型试图用 Bash `mkdir` 写到执行副本外时慢判也判 ask（引 outside-worktree），说明提示词里那条越界文案对 Bash 起作用 |
| 模型审批思考等级 low（2026-09-08，第十次花额度） | 同一条快筛请求：`variant:"low"` 输出 3 token、2.1 秒；`high` 时输出 158 到 286 token、4 到 5 秒。审批默认改 low |
| 模型审批慢判被截断（同上） | 快筛对一个范围内的 Write 回了 flag，慢判 `maxOutputTokens:600` 下模型先写了一长段逐条推理，结论行还没写到就被截断 → `parseSlow` 失败 → review-failed 转人工。思考等级 high 的输出预算要留给推理，慢判预算 600 不够 |
| 检查点 3（2026-09-08，main 8c5ff23，第七、八次花额度） | A 范围内写：模型快筛回 Y 自动放行，无挂起，事件 `executor.gate` stage review-fast 带理由，回合 done、文件写出。B 越界写：`Write` 到 cwd 外 → 红线挂起（stage hard、ruleId outside-worktree、why 带路径），`approve` 后回合继续并写出外部文件。两次都无残留 runner。快筛预算 300 时输出约 160 token、4 秒 |
| 检查点 2（2026-09-08，main ab6dfc8，第五次花额度） | 真 worktree + `--task`：`new` → `send --wait --task` 5（Write）→ `approve` → 模型继续读任务单后又发 **Bash `git -C …` 的审批请求**（build 档下 git 命令也要审批）→ 第二次 approve → done。`hello.txt` 只出现在 worktree，主检出零改动；`last.json` 记了任务单路径；一回合 usage 约 65k（两次模型请求 + 读任务单）。撞出 bug：`approve` 在应答生效后匹配 events 回执时遇到 `{method,params}` 行崩溃且退出码 0（T2.6 修） |
| **没跑过回合的会话 resume 不了**（2026-09-08，T2.3b 真机） | `new` 建完立刻 `session/close` 并退出进程，runner 再 `session/resume` 报 `Session not found`。与 zcode-acp 时期的实测一致：跑过至少一回合的会话才能跨进程 resume。`session/create` 带自定义 `sessionId` 被拒：「sessionId is only supported for imported history creates」 |

## 一次性 CLI（备用路线）

`zcode --prompt "<text>" --json --mode build --cwd <dir> --resume <sess_> --attach <file> --disallowed-tools "Write Edit Bash"`。
`--help` 列出的 `--allowed-tools`、`--max-turns` 在 0.16.5 上报 Unknown option。
zcode-open-bridge 称此模式不读配置里的模型，要环境变量注入；是否仍如此未验。
每次调用在库里留一行会话。

## 存储与 App 共存

- App 任务列表读 `~/.zcode/v2/tasks-index.sqlite` 的 `tasks` 表，**按 `workspace_key`（=cwd）分组**。
  只有 zcode-acp 会往里写；直连 app-server 不写，会话不出现在 App 列表里。
- 会话正文在 `~/.zcode/cli/db/db.sqlite`（WAL，表 `session` / `message` / `part`，
  后两者有 `sequence` 列）。App 自己的 `zcode-cli` 子进程和我们拉起的 app-server
  打开的是同一个文件（lsof 核实）。
- `zcode.cjs` 里没有跨进程的会话占用锁。SQLite 保证文件不撕裂；两个进程驱动
  同一条会话时逻辑层会不会乱，未验。

## zcode-acp-server 速览

- 0.27.3 共 17,300 行。值得搬的：`backend/client.js`+`listener.js`（613，拉进程与配对）、
  `backend/resolve.js`+`credentials.js`（242）、`config/provider-registry.js`（143）、
  `handlers/server-requests.js` 里的去重与应答（815 中一部分）、`handlers/session.js`
  里的回合结束判定（2665 中两三百行，搜 `STALE_FREEZE_MS`）。可选 `tasks-index.js`（360）。
- 不搬：`lazy-sessions`、`translators/*`（事件到 ACP 的映射）、`options`、`extensions`、
  `remote`、TUI、`sandbox`、`replay`、`i18n`。
- 版本节奏：0.17.1 → 0.27.3 用了两天。changelog 里"session-create incubates terminal REPL"
  只在 hub/远程路径发生。0.27.3 仍未实现 ACP 侧 `session/close`。
- 拿源码：`npm pack zcode-acp-server@0.27.3`，或 npx 缓存里的 0.17.1
  `~/.npm/_npx/c904e5833c2b97e0/node_modules/zcode-acp-server`。

## Claude Code 侧（官方文档核对）

- 插件可同时带 `skills/`、`bin/`（启用期间进 Bash 的 PATH）、`.mcp.json`；
  `${CLAUDE_PLUGIN_ROOT}` 指向安装目录，`${CLAUDE_PLUGIN_DATA}` 是持久数据目录。
- Bash 默认超时 2 分钟、上限 10 分钟；超时的命令自动转后台，完成时通知 Claude。
  MCP 工具调用超过 2 分钟（`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`）同样自动转后台。
- MCP elicitation（表单 / URL 两种）在交互会话支持，`-p` 和 SDK 模式下让那次调用失败。
  转后台之后还能不能弹，文档没写。
- PreToolUse 钩子和 `--permission-prompt-tool` 只作用于 Claude 自己的工具调用。
- AskUserQuestion 在交互会话可用，`askUserQuestionTimeout` 可设自动继续；`dontAsk` 模式下不可用。
- 插件 `bin/` 脚本经 Bash 运行时走普通 Bash 审批，`Bash(zcode-executor *)` 可做前缀白名单。

## 第三方项目速览

| 项目 | 语言 | 接 zcode 的方式 | 对外 | 活跃 |
| --- | --- | --- | --- | --- |
| zcode-open-bridge（tizerluo） | Python 零依赖 | 直连 app-server；也用 `--prompt --json` | ACP 桥、MCP 审查工具、能力探测 | 2026-08-31 最后提交 |
| zcode-acp（william0wang） | TypeScript | 直连 app-server | ACP 服务、TUI、远程 hub | 日发多版；README 注明参考了 open-bridge |
| coder-mcp-bridge（Deslord319） | Python 零依赖 | 直连 app-server（`zcode_protocol.py` 13KB） | MCP 编排工具，管三种后端 | 2026-08-15 最后提交 |

coder-mcp-bridge 的审批策略：非 plan 档下 `requestPermission` 自动批准（除写到
exclusive 根之外），`requestUserInput` 只自动批 plan_approval。
