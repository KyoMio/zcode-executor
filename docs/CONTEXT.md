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
由一个模型判断审批请求是放行还是转人工。只产出放行或转人工，从不拒绝。
_Avoid_: 裁决、judge、自动审批

**挂起（pending）**：
审批请求或提问在等人回应，回合停在那里不动。对外表现为 blocked。
_Avoid_: 阻塞、等待审批、卡住

**回执（receipt）**：
应答被 runner 消费之后写进 `events.jsonl` 的那条 `executor.approve` / `deny` / `answer` 事件。
`approve` / `deny` / `answer` 的 `--json` 里的 `eventType` 就是它，找不到为 null。
_Avoid_: ack、确认消息

### 模型

**模型等级（model tier）**：
按能力和成本把可用模型分成的档，派活和模型审批都按等级选，不按具体模型名。
_Avoid_: 模型名、型号

**思考等级（thought level）**：
执行端一次回合里推理的深浅，建会话时定。
_Avoid_: effort、reasoning、思考档位
