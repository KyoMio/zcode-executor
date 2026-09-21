# zcode-executor

Claude 当工头，把想清楚的开发任务派给本机 ZCode 执行，用客观证据验收。
这份文件只定词，不定实现；实现决定在 decisions.md 和 SPEC.md。

## Language

### 派活

**会话（session）**：
ZCode 那边的一条对话，由它的 `sess_` id 标识。本项目在登记簿里给它一个本地派单 id（`x_` 开头），命令行只用本地 id；
zcode 的 `sess_` 在第一回合后才存在。
_Avoid_: run、任务实例、job

**本地派单 id（local id）**：
登记簿给每条会话的键，`x_` 加 8 位十六进制。所有命令的 `<id>` 都是它；zcode 的 `sess_` 只在 `list` 和 `--json` 里并排显示，对账用。
_Avoid_: run id、任务 id

**任务单（task file）**：
Claude 写给执行端的契约文件，写清目标、改哪些文件、验收标准、禁区。
_Avoid_: 提示词、prompt、消息

**投递（send）**：
往一条会话发一条消息，触发一个回合。消息只是门铃，内容在任务单里。
_Avoid_: 提交、prompt

**回合（turn）**：
执行端从收到一条投递到停下来的一整段工作。
_Avoid_: 轮次、prompt、run

**验收（acceptance）**：
Claude 看 `git diff` 和测试结果判断任务是否完成。执行端的自述不算证据。
_Avoid_: 确认、review

**执行副本（worktree）**：
执行端干活用的 git worktree，和主检出隔离。由 Claude 建，本项目只记录。

### 审批

**审批请求（permission request）**：
执行端做某个操作前发来的「可不可以」。
_Avoid_: 权限弹窗、permission prompt

**提问（question）**：
执行端反过来问的问题，要一个答案而不是允许或拒绝。
_Avoid_: 用户输入、user input

**闸门（gate）**：
处理审批请求的整段流程：红线 → 模型审批 → 挂起。
_Avoid_: 审批器、过滤器

**红线（hard rule）**：
谁也推不翻的规则，命中就直接转人工，不进模型审批。
_Avoid_: 黑名单、硬规则

**模型审批（model review）**：
由模型逐层判断审批请求是放行还是转人工。可有前筛、快筛和慢判；最终只产出放行或转人工，从不拒绝。
_Avoid_: 裁决、judge、自动审批

**前筛（pre-screen）**：
原快筛之前可选的 Jev 判断。证据充分且通过时提前放行，其余继续原快筛，不替代它。
_Avoid_: 替代快筛、shadow

**本地跳过（local skip）**：
发送前已知判断所需证据不足或无法可靠脱敏，因此不请求 Jev，继续原快筛；不是模型判定有风险。
_Avoid_: flag、模型拒绝

**快筛（fast screen）**：
原 ZCode 模型审批的第一段，判断能否直接放行；结果未通过或无法解析就交给慢判，调用失败则转人工。
_Avoid_: Jev 前筛、shadow、预审

**慢判（slow review）**：
ZCode 快筛结果未通过或无法解析后的复核；可放行或转人工，从不直接拒绝。
_Avoid_: 二审、终审

**挂起（pending）**：
审批请求或提问在等人回应，回合停在那里不动。对外表现为 blocked。
_Avoid_: 阻塞、等待审批、卡住

**回执（receipt）**：
应答被 runner 消费之后写进 `events.jsonl` 的那条 `executor.approve` / `deny` / `answer` 事件。
`approve` / `deny` / `answer` 的 `--json` 里的 `eventType` 就是它，找不到为 null。
_Avoid_: ack、确认消息

### 模型

**模型等级（model tier）**：
按能力和成本把 ZCode 模型分成的档。派活、ZCode 快筛与慢判按等级选，不按具体模型名；Jev 使用固定版本，不属于这个等级表。
_Avoid_: 模型名、型号

**思考等级（thought level）**：
执行端一次回合里推理的深浅，建会话时定。
_Avoid_: effort、reasoning、思考档位

**个人 provider 文件（personal provider config file）**：
我们写给 app-server 子进程的一份只含一个 provider 的 JSON，内容从 `~/.zcode/v2/config.json` 里选中的
provider 换算而来，路径经环境变量 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 传给子进程（decisions D14）。
_Avoid_: provider 表、registry

**内置 provider 文件（builtin provider config file）**：
ZCode App 自带的 `zcode-builtin.json`，路径经环境变量 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 告诉子进程；
本项目只负责算出并传入这个路径，不生成也不改它的内容。

**账号型 provider（account provider）**：
内置 provider 文件里 `account:` 前缀的 coding plan 条目（个人版 / 团队版）。用户在 App 里用账号（OAuth）登录后，
key 不写进 config.json，而在凭据文件里由 App 替用户领取；本项目解出后当普通平台 key 走 D14 的个人文件路径
（decisions D19）。
_Avoid_: OAuth provider、zhipu-account

**凭据文件（credentials file）**：
`~/.zcode/v2/credentials.json`，ZCode App 存登录凭据的平面 JSON，值多为 `enc:v1:` 加密（AES-256-GCM）。
本项目只读、只解四个键（active provider、user_info、两把 coding plan api-key），其余键一律不读不解。
_Avoid_: 密钥库、keychain
