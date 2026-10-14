---
name: zcode-executor
description: 把一件已经想清楚的开发任务交给本机 ZCode（GLM）执行，在隔离的执行副本里改代码，用 git diff 和测试验收。当用户说「让 zcode 去做」「派给 zcode」「派给执行端」，或者当前会话负责规划、实际改代码要交给 zcode 时使用。也用于闲时投递（用户选择时）、查看 zcode 会话状态、给正在跑的回合插话、应答挂起的审批请求或提问。
---

# 把任务派给 zcode 执行

你是规划中枢，zcode 是执行端。你把要做什么写成任务单，zcode 在隔离的执行副本（git worktree）里改，
你用客观证据验收。命令是 `zcode-executor`，下面的命令块替换占位符后可直接复制运行。
终端里先 `command -v zcode-executor` 确认：在 PATH 里就照抄命令块。找不到时按宿主取值：
- Claude Code 插件装好时已进 PATH；散装用法里它是本 skill 目录上两级的 `bin/zcode-executor`（`<插件根>/bin/zcode-executor`），用绝对路径调；
- 本机源码用法：仓库 `bin/` 的绝对路径（示例：`/Volumes/MacData/projects/zcode-executor/bin/zcode-executor doctor`）；
- 也可以 `npm install -g zcode-executor` 或直接 `npx zcode-executor …`。

## 工作模式：主 agent 编排，原会话闭环

- 主 agent 负责任务单、调度和最终证据验收；实现与返工交给执行会话，代码评审与复审交给独立 review 会话。记录任务对应的执行 id、review id 和执行副本路径；review 会话只读。
- **返工 → 原执行会话；返工后复审 → 原 review 会话。** 将评审问题、复现证据和通过标准写入返工单，等原执行回合结束后带 `--task` 重投；将最新 diff、测试结果和返工单交回原 review 会话，逐项确认问题关闭。主 agent 的证据验收不代替 review，也不亲自接管修补。原会话确实不可恢复时才新建，并移交上述上下文。
- **投递后先推进独立工作，确实无事可做再等待。** 默认 `send` 不带 `--wait`，后台起 `follow` 并记录 job id；期间规划下一步、准备验收清单或梳理后续任务，不碰执行端正在改的文件，不提前使用尚未完成的产物。收到完成或挂起通知再处理，交付前收齐结果；不要用反复 `status` 或 sleep 循环代替后台等待。

## 铁律

1. **任务单是契约，消息只是门铃。** 任务内容全部写进任务单文件，投递正文一句「执行 tasks/T-xxx.md」就够——
   zcode 是有自己判断的完整 agent，一段话过去它会自己重新理解，任务单才是事后对账的依据。
   所以 `send` 必带 `--task`：不给任务单，模型审批看不到你授权了什么，越界判断没有依据，几乎全部转人工。
   审批认的是**投递那一刻**的任务单内容（入队时留了快照）：之后再改文件，审批看不到，带着 `--task` 再投一次才算数。
2. **验收看 `git diff` 和测试，不看它怎么说。** 回合结束带回来的回答只是执行端自述。判断做没做对，
   一律回主仓看 diff、在执行副本里跑测试、读产物文件。
3. **反复投同一条会话三四轮还没过，回去改任务单。** 通常问题出在任务描述不清，不是多投几次能解决的。
   改法：写 `tasks/T-xxx-fix.md` 说明差在哪，再投同一条会话（它有上下文，带着上下文返工）。
4. **挂起先分流，不替用户批越界。** 先核对任务单、用户已有授权和具体操作：能确认且规则允许主 agent 处理的，按「退出码 5」应答；越界、无法确认或上层指令要求人工确认的，带判断依据转用户。挂起本身不是危险判据，也不是放行依据；本 skill 不覆盖宿主的审批限制。
5. **Jev 只由配置启用前筛。** 非空白 `review.jev.apiKey` 启用提前通过层；pass 结束审批，flag/error/skip 回到
   原 ZCode `fast` + `review.thought`（默认 `low`）快筛，未通过或无法解析才慢判；原快筛调用失败仍转人工。
   正文省略、缺有效意图或必要输入截断时本地 skip，不发 HTTP；复杂命令本身不是跳过理由。无 key 保留原链，
   无环境变量 fallback 或 mode/shadow；`review.enabled:false` 关闭全部模型审批。

## 一个任务的完整走法

```bash
# 1. 先写任务单（模板 templates/task.md）
#    验收标准要能被机器检查：跑什么命令、看什么文件、期望什么输出
#    合理拆分任务：一单只做一件能独立验收的事；估计要改很多文件或跑很久测试的活儿，
#    拆成多单串行投（前一单过了再投下一单），别塞成一单
#    回合默认超时 1 小时（--timeout 3600）：任务还要更久的，派单手动给更长的 --timeout，
#    超时会把当前回合取消、重投浪费额度

# 2. 给仓库建执行副本（每个仓库一个，按任务切分支）
WT=~/.zcode-executor/worktrees/<仓库名>
git -C <主仓绝对路径> worktree add "$WT" -b task/T-xxx    # 首次：在 $WT 里装一次依赖

# 3. 建会话：只做零 token 登记，返回本地 id（x_ 开头）；zcode 会话第一次投递时才建
zcode-executor new --cwd "$WT" --title T-xxx --tier fast --json

# 每个对话第一次派单前：zcode-executor quota（零额度），按「闲时投递」一节的话术告诉用户，然后照常普通投递
# 4. 非阻塞投递（--task 必带），随后用后台任务起 follow <id>；按「工作模式」推进独立工作
#    消息里的 tasks/T-xxx.md 是让 zcode 自己在执行副本里读的相对路径，所以任务单必须放在 $WT 里；
#    --task 给的是模型审批看的授权依据，用绝对路径
zcode-executor send <id> "执行 tasks/T-xxx.md" --task "$WT/tasks/T-xxx.md"

# 5. 收到完成通知后，交独立 review 会话评审；主 agent 核对客观证据。
#    zcode 不提交，改动停在执行副本工作区，先把未跟踪文件收进来再看 diff
git -C "$WT" add -A && git -C "$WT" diff --cached --stat && git -C "$WT" diff --cached
git -C "$WT" <跑测试的命令>
#    还想看审批经过：$ZCODE_EXECUTOR_HOME/runs/<id>/events.jsonl 里 type 为 executor.gate 的行

# 6. 过了：在 $WT 里提交（git -C "$WT" commit -m "T-xxx: …"），再回主仓合并（见下一节）。
#    没过：git -C "$WT" reset 撤掉暂存，写 tasks/T-xxx-fix.md，投原执行会话；完成后交原 review 会话复审
```

默认投递立刻返回、后台 runner 继续工作；`follow` 用宿主的后台任务工具启动（`run_in_background: true`），记下返回的 job id。
仅当前下一步确实依赖结果且无独立工作时才等待该后台任务；`send --wait` 是可选阻塞用法，挂起时以退出码 5 返回。

## git 一律 `-C <绝对路径>`，别靠 cd

主仓和执行副本是两个目录，一条 Bash 里 `cd` 过一次之后，后面的 `git merge`、`git checkout -b`
就可能跑在你以为之外的那个仓库里。真踩过的坑：在执行副本里跑完测试接着 merge，merge 落在执行副本
（HEAD 就是那个分支，自合并什么都没变），主仓 main 没动，下一单从 main 切的分支缺上一单的代码。

```bash
git -C <主仓绝对路径> merge --ff-only task/T-xxx      # 合并进 main：在主仓
git -C <主仓绝对路径> log --oneline -1                # 切新分支前核对 main 已含上一单
git -C "$WT" checkout -b task/T-yyy main              # 切新分支：在执行副本
```

## 模型等级、思考等级与 Jev 前筛

按等级选 ZCode 模型，不写模型名——模型换代不用改习惯。`models` 能看每个等级当前分到了谁。Jev 只增加可选前筛，不改变执行会话的 `--tier`，原 ZCode 快筛与慢判仍保留。

| 活儿 | 建议 |
| --- | --- |
| 机械改动（改名、搬代码、按明确清单补测试） | `--tier fast` |
| 常规实现（有明确验收标准的功能） | `--tier fast` |
| 难活（要设计取舍、调试难复现、改陌生代码） | `--tier strong` |

- **思考等级默认 `high`，都不用调。** Flash 类模型不要往低调，实测效果差。
- provider 优先账号型个人版 coding plan（App 账号登录后的 key），其次账号型团队版，再次 `config.json` 里的 coding plan；同名模型在多个 provider 下并存时不用管，插件自己选对，要换就在插件配置里写 `preferredProvider`（如 `account:bigmodel-team-coding-plan`）。
- 模型和思考等级建会话时定，同一条会话后续投递沿用。难活别复用之前建的 fast 会话，新开一条。
- **原 zcode 会话上下文超过 1M token 就换新会话派单。** 会话越长每次投递的固定开销越大、执行效率越低；
  旧会话攒的上下文对新任务多半是噪声。新任务一律新会话（必要时配新副本），把任务单和必要 diff 移交过去。

可选启用 Jev 前筛时，编辑 `~/.zcode-executor/config.json`；**不要**把真实 key 放进命令参数、环境变量、任务单、聊天消息或仓库文件：

```json
{
  "review": {
    "jev": {
      "apiKey": "jev_请替换为用户自己的密钥"
    }
  }
}
```

保存后必须执行：

```bash
chmod 600 ~/.zcode-executor/config.json
```

含 key 的配置文件必须由当前 UID 拥有、是普通非符号链接文件且权限不宽于 `0600`，否则命令会报配置错误。删除 `apiKey` 或留成全空白可只走原 ZCode 链；不要找 Jev 环境变量或 mode/shadow 开关。`doctor` 显示新 runner 的审批链，不联网调用 Jev、不显示 key：`review.pipeline` 有 key 为 `['jev','zcode-fast','zcode-slow']`，无 key 为后两项，禁用为 `[]`，配置错误为 `null`。兼容 `fastScreen` 不表示替代原快筛。

## 退出码与应对

| 码 | 含义 | 你该做什么 |
| --- | --- | --- |
| 0 | 回合干完了 | 去验收，别直接信它说完成了 |
| 1 | 用法错、zcode 起不来（含 ZCode App 早于 3.12） | 看报错；环境问题跑 `zcode-executor doctor`（不花额度的自检）。它退出码 1 时先看是哪一步不过：只有 ⑤ 闲时接口变了的话，普通派单照常能用 |
| 2 | 被拒：白名单外、会话不在登记簿、等级或思考等级不合法；闲时投递被拒 | 报错里写了原因，按原因处理，别原样重试；闲时的见「闲时投递」一节 |
| 3 | `send --wait` 超时（默认 3600 秒，`--timeout` 可改），**当前回合已取消**，会话还在 | 直接再投一次接着做；`follow` 的超时不取消任何东西，只是旁观者到点走了 |
| 4 | 回合异常：报错、被中止、撞输出上限 | 读 reason；撞上限就把任务拆小再投 |
| 5 | 挂起等人：审批请求或提问 | 见下一节，别想办法绕过去 |

## 退出码 5：挂起的两种情况

挂起不过期，会话停在原地等人。`send --wait` 立刻返回 5 并打印挂起内容；后台跑时用 `status <id>` 看。

**审批请求**（执行端要做某个操作，等你允许）：

1. 读取完整工具名、参数、目标路径和挂起理由，对照任务单与用户授权判断实际影响；证据不足先做只读核查。
2. **可自行确认**：操作明确在授权范围内、未命中红线，且上层指令允许自主应答 → 说明依据后 `zcode-executor approve <id>`（仅本次）；明确违反任务约束且允许自主拒绝 → `zcode-executor deny <id>`，将原因交回原执行会话调整方案。
3. **需人工决定**：越界（例如执行副本外写入）、新增权限或不可逆影响未获授权、证据不足，或上层指令明确要求转交 → 原样转述工具名、参数、理由，附建议与未确认点（Claude Code 用 AskUserQuestion，DSH 走宿主的上抛）；得到决定再 `approve` / `deny`。不得通过改任务单、关闭审批或换命令绕过限制。

   规则是 `self-modify-approval` 的要格外当心：那是执行端在碰 zcode-executor 自己的数据目录（审批的挂起与应答都在里面）或者在调 `zcode-executor` 命令。正常干活用不着这两样，原样告诉用户它想做什么，别替它解释成无害。

**应答绑定限制（approve / deny / answer 都适用）**：当前 CLI 会重新读取 pending，未提供 expected-requestId/CAS；只做两次读取或声称单人操作不能防止串答。只有已验证的外部串行化覆盖「核对当前请求 → CLI 读取」全过程，才执行应答；否则保留挂起并报告该限制，请用户协调安全处理，人工说“允许”本身也不消除竞态。不要虚构参数或直接写 answer.json。

**提问**（执行端反过来问你问题，要答案不是要允许）：

1. 先自己判断任务单里有没有答案，能答就不必惊动用户：`zcode-executor answer <id> <值…>`。
   有选项按序号、value 或 label 给值，多选逗号分隔；无选项就是自由文本。
2. 答不了再问人，拿到答案后同样 `answer` 回过去。

## 插话、跟看、叫停

```bash
zcode-executor send <id> "方向改一下，先只改 A" --steer   # 回合进行中插话，不打断
zcode-executor follow <id> [--stream]                     # 跟看后台 runner，写出新结果就返回
zcode-executor status <id>                                # 只读快照：状态、最近工具、队列、挂起多久
zcode-executor cancel <id>                                # 叫停：挂起的先答拒绝，再停回合，不再取队列
```

- **`--steer` 是插话不是打断。** 消息递给正在跑的回合，不打断它；要打断先 `cancel` 再重投。
  插话在下一个工具边界生效；没有边界时排到回合结束后执行。
- **`follow` 用后台任务起**（`run_in_background`），它退出时你会被自动叫回来。别在前台用 timeout
  包着等——超时切断的只是你这个旁观者，回合还在跑，你却容易当成它挂了。
- 想随时问「到哪了」用 `status`：只读、不花额度、不阻塞。phase 的取值：`running` 在跑、`pending` 挂起等人、
  `idle` runner 活着但队列空、`exited` runner 跑完正常退出（配合「上次: done」看，不是出事）、`stale` runner 跑到一半没了，最需要人工看。
  `list` 每行的 `[phase]` 同一套词，没有 running / pending 就是没有在跑的会话。
- 要边跑边看，`send` / `follow` 加 `--stream`：工具调用摘要和成型回答打到 stderr。

## 闲时投递

闲时投递用 Coding Plan 订阅的免费闲时算力跑回合，不占套餐额度；代价是先取号排队，开跑时间由服务器决定，没法预估。
验收、返工、挂起照普通投递。旧版本没有这个功能：`send` 报「不认识的参数 --offpeak」就改用普通投递。

**什么时候用**：派单默认普通投递；走不走闲时由用户知情后决定。

- 每个对话第一次派单前跑一次 `zcode-executor quota`（零额度，不取号），用一句话告诉用户：这次按普通投递；
  也可以改走闲时投递（Coding Plan 订阅的免费算力，开跑时间由服务器决定、没法预估），今天本工具已用 N 次
  （每天约 3 次，App 里用的不计入），现在能不能取（不能取时给出可再取的时间）。
- 说完**直接按普通投递继续，不停下来等回答**。用户回复要走闲时：已经发出的普通投递不改；之后的新任务照「怎么用」
  另开会话发 `--offpeak`，返工在原会话等上一次投递结束后再发 `--offpeak`。
- 用户明确选了闲时才发 `--offpeak`。返工同样默认普通投递，闲时只作为选项提。
- `quota` 的结论不是「正常」时：
  - 「不适用」（没登录、团队版）：这个对话里不用再提闲时选项；
  - 输出里是「接口变了」（退出码 1）：照下面表里「闲时接口可能变了」那一行处理；
  - 其他退出码 1（原因在 stderr，比如旧版本不认识 quota 命令）或「暂时不可用」：对用户说一句「闲时情况暂时查不到」，照常普通投递。
- 同一对话里后面派单不再跑 `quota`、也不再提闲时；只有用户问起闲时，或者准备发 `--offpeak` 之前，才再跑一次。

**怎么用**：闲时投递要求会话空闲（没有 runner、队列为空）。新任务另开一条会话、配自己的执行副本专门发；
返工时上一次投递已经结束，直接在原会话 `send <id> … --offpeak`，保留上下文。一个执行副本只配一条会话。

```bash
WT2=~/.zcode-executor/worktrees/<仓库名>-offpeak
git -C <主仓绝对路径> worktree add "$WT2" -b task/T-xxx     # 任务单放进 $WT2
zcode-executor new --cwd "$WT2" --title T-xxx-offpeak --tier fast --json
zcode-executor send <id> "执行 tasks/T-xxx.md" --task "$WT2/tasks/T-xxx.md" --offpeak   # 取号后立刻返回「已取号，排第 N 位」
zcode-executor status <id>    # 看排位、运行中还是已结束
```

- 取号后立刻返回，排号可能很久：要等结果就用后台任务（`run_in_background`）起 `follow`，发闲时投递时不带 `--wait`。
- 免费取号每天约 3 次、本地零点重置（2026-09-28 实测），一次闲时投递最坏会用掉 3 个；别为试探而反复取号。
- 回合 `--timeout`（默认 3600 秒）从开跑算起、挂起时间也算：闲时回合要等人审批的，给宽一点的 `--timeout`。
- 号过期或失效由 runner 自动重取，最多 3 个号，用完以退出码 4 结束。以退出码 4 结束时先 `status <id>`：
  有「闲时：投递 … 没收尾」那一行就用 `--resume`（见下），没有就照普通回合异常处理，改动留在执行副本里。
- 挂起：由你尽快应答（见「退出码 5」一节），闲时回合同样可能要审批。号开跑后最长跑 3 小时；挂起久了会不会让号失效还没验证过。
- `--steer` 只在回合开跑后能用。排号期间 `cancel` 再重投会重新取号、重新排队，还占一次免费取号次数；方向小改就等开跑后 `--steer`。

**退出码 2：取号前或取号时被拒**，按报错原因处理：

| 报错说的 | 你该做什么 |
| --- | --- |
| 会话不空闲，刚 `cancel` 过 | 等几秒，`status` 显示不再有 runner 后重投同一会话 |
| 会话不空闲，有普通投递在跑 | 等它结束；或另建一个执行副本再 `new` 一条会话 |
| 模型不在闲时模型表里（报错列出了表） | 用 `zcode-executor models` 看哪个等级分到的是表里的模型，用那个 `--tier` `new` 一条 |
| 没登录、团队版暂不支持、没有闲时资格 | 告诉用户：闲时要在 ZCode App 里登录个人版 Coding Plan 订阅账号 |
| 额度用完，<时间> 以后可再取 | 把这个时间告诉用户；急的活改普通投递 |
| 闲时服务暂时不可用、连不上闲时服务 | 过一会儿再投，或改普通投递 |
| 闲时接口可能变了 | 跑 `zcode-executor doctor --offpeak`，把结论转告用户，这次改普通投递 |
| 投递 … 没收尾，runner 已不在 | 见下面「出事了怎么办」 |

**出事了怎么办**：以 `status` 里「闲时：投递 … 没收尾，runner 已不在」那一行为准；phase 是 `exited` 本身只是正常收工，不用恢复。

- 有那一行（回合 exited 或 runner 没了）→ `zcode-executor send <id> --offpeak --resume`。
  它只重新拉起 runner 接着跑那次投递，不重新取号，不带正文和 `--task`。
- 不想要了 → `zcode-executor cancel <id>`，任何阶段都会自动结算号。
- `status` 里出现「闲时：号 … 未结算」→ 把号告诉用户，说明服务器那边这几个号没结算成功。

**健康检查**：`zcode-executor doctor --offpeak` 只查闲时接口，不花额度（会联网，起一个假号回合）。
只有退出码 1「接口变了」要处理：原因在 stderr，告诉用户闲时这条路暂时断了，派活改普通投递。「暂时不可用」「不适用」退出码 0，把那一行转告用户即可。

用户想定期查，建议他挂在自己的 cron 上（本工具不自动跑）。cron 的 PATH 很短，node 与脚本都写绝对路径；
stdout 总有一行结论，丢掉，只看退出码与 stderr：

```cron
0 9 * * * /绝对路径/node /绝对路径/bin/zcode-executor doctor --offpeak >/dev/null
```

App 版本和验证过的版本不同时，stderr 每次多一行提示；每跑一次在 zcode 命令行的会话库里留一条 App 看不到的自检会话，所以频率别太高（一天一次够了）。

## start plan 投递

Start Plan 是 ZCode App 里的另一档订阅。`send <id> <正文> --start-plan` 让**这一回合**吃 Start Plan 额度，
其余与普通投递完全一样：立刻开跑、没有号、不独占会话、验收照旧。`--offpeak` 与 `--start-plan` 互斥，
`--steer` 不能插进 start plan 投递（它是一次新投递）。（2026-09-29 曾因阿里云验证码在无头宿主上不可用，
2026-10-09 服务器撤下验证后恢复。）

- 模型表以 ZCode App 的内置配置为准（被拒时退出码 2，报错会列出表）；会话模型不在表里就换 `--tier` 新建会话。
- 同一会话可以混用：有的投递带 `--start-plan`、有的不带，互不影响；失败也不影响后续普通投递。

## 两种会话 id

- 命令一律用**本地 id**（`x_` 开头，`new` 返回的那个）。
- zcode 自己的 `sess_…` id 首回合之后才存在，只在 `list` 和各命令的 `--json` 里和本地 id 并排显示，对账用，不敲命令。

## 别做的事

- **不要在 ZCode App 里打开正在跑的会话。** 两边写同一个 sqlite，没有跨进程锁，会互相踩。
- **不在执行副本之外派活。** `new` 的 cwd 白名单默认只有 `~/.zcode-executor/worktrees/`，
  那是保护不是障碍；两个 agent 同时改同一批文件会互相覆盖。
- **不要把「zcode 说改好了」当验收写进汇报。** 验收只认 `git diff` 和测试结果（铁律 2）。
- 不要投第四轮。三四轮没过，改任务单（铁律 3）。
- **任务单里别写凭据。** 任务单会作为授权依据进入模型审批；启用 Jev 且通过本地证据检查时，脱敏后的任务契约与操作摘要会送往 TypeSafe；必要内容被截断则本地跳过。
- **不要用 shell 参数或环境变量配置 Jev key。** 唯一入口是受 `0600` 保护的 `review.jev.apiKey`；示例永远用占位值。

## 命令速查

```bash
zcode-executor doctor [--json]                  # 不花额度的自检：zcode、配置、握手、等级、新 runner 的审批链、闲时接口（⑤ 会联网，每跑一次留一条自检会话）
zcode-executor doctor --offpeak [--json]        # 只查闲时接口（同样留一条自检会话）；只有退出码 1（接口变了）要处理
zcode-executor quota [--json]                   # 今天本工具取过几次闲时号、服务器现在能不能取；零额度，不取号
zcode-executor models [--json]                  # 可用模型、思考等级、禁用原因、自动分到哪个等级
zcode-executor list [--project 关键字] [--json]  # 登记簿里的会话：本地 id、sess_、上次结果、是否挂起
zcode-executor new --cwd <绝对路径> [--title T] [--tier fast|strong] [--thought 档] [--deny "工具…"] [--provider id] [--json]
zcode-executor send <id> <正文|-> [--task 文件] [--wait] [--steer] [--timeout 秒] [--stream] [--json]
zcode-executor send <id> <正文|-> --offpeak [--task 文件] [--wait] [--timeout 秒] [--stream] [--json]  # 闲时投递：当场取号
zcode-executor send <id> --offpeak --resume [--wait] [--stream] [--json]  # 接着跑没收尾的闲时投递
zcode-executor send <id> <正文|-> --start-plan [--task 文件] [--wait] [--timeout 秒] [--stream] [--json]  # Start Plan 额度
zcode-executor follow <id> [--timeout 秒] [--stream] [--json]
zcode-executor status <id> [--tools N] [--json]  # 在跑/空闲/挂起/异常结束、最近工具调用、队列长度
zcode-executor cancel <id>                       # 叫停：挂起的先答拒绝，之后不再取队列
zcode-executor approve <id>                      # 应答挂起的审批请求，只回 allow_once
zcode-executor deny <id>                         # 应答挂起的审批请求为拒绝
zcode-executor answer <id> <值…>                 # 应答挂起的提问：按序号/value/label，多选逗号分隔
```

- 观察面板实时显示各会话进展（回复、工具、挂起与排队）：Claude Code 里用户输入 `/zcode` 打开（你投递时自动打开，
  状态栏汇总、关键变化弹提示），DSH 右侧栏有「zcode 任务」tab。面板只看不应答，挂起照样按上面的规矩在对话里处理。
  背后是你不需要自己跑的只读 `zcode-executor watch --json`。

- 正文写 `-` 从 stdin 读，长文本别跟命令行引号较劲：

  ```bash
  zcode-executor send <id> - --task "$WT/tasks/T-xxx.md" <<'EOF'
  执行 tasks/T-xxx.md，按验收标准逐条自检后再停
  EOF
  ```

- `--deny` 建会话时从工具注册中移除指定工具。**任务不需要执行端上网就带上 `--deny "WebFetch WebSearch"`**，减少联网工具的可用面。
  这只移除这两个工具，Bash、js 和 MCP 工具仍可能联网；需要断网时要由系统或容器限制网络。
- 你自己环境里的凭据变量（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`GITHUB_TOKEN`、`GH_TOKEN` 等）不会带给执行端。
  任务要用 GitHub 凭据时靠本机已登录的 `gh` / git 凭据助手，别指望环境变量。
- `--json` 给机器可读结构，脚本化处理时用；输出里的 `id` 都是本地 id。
- cwd 会解析成真实路径存进登记簿（macOS 的 `/tmp/x` 会变成 `/private/tmp/x`），`list --project` 按解析后的路径匹配。
- 数据目录 `~/.zcode-executor/`（`ZCODE_EXECUTOR_HOME` 可改）：`sessions.json` 登记簿，`runs/<id>/` 里有 `events.jsonl`（zcode 事件与闸门决定）、`last.json`、`pending.json`、`offpeak.json`（闲时投递时）、`runner.log`。
