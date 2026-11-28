---
name: zcode-executor
description: 把一件已经想清楚的开发任务交给本机 ZCode（GLM）执行，在隔离的执行副本里改代码，用 git diff 和测试验收。当用户说「让 zcode 去做」「派给 zcode」「派给执行端」，或者当前会话负责规划、实际改代码要交给 zcode 时使用。也用于闲时投递（用户选择时）、查看 zcode 会话状态、给正在跑的回合插话、应答挂起的审批请求或提问。
---

# 把任务派给 zcode 执行

你是规划中枢，zcode 是执行端。你把要做什么写成任务单，zcode 在隔离的执行副本（git worktree）里改，
你用客观证据验收。命令是 `zcode-executor`，下面的命令块替换占位符后可直接复制运行。
终端里先 `command -v zcode-executor` 确认；找不到时按宿主取值：Claude Code 插件装好时已进 PATH；散装用法用 `<插件根>/bin/zcode-executor` 绝对路径；或 `npx zcode-executor …`。

## 工作模式：主 agent 编排，原会话闭环

- 主 agent 管任务单、调度和证据验收；实现与返工归执行会话，评审与复审归独立 review 会话（只读）。记录执行 id、review id、执行副本路径。
- **返工 → 原执行会话；复审 → 原 review 会话。** 评审问题与通过标准写进返工单，回合结束后带 `--task` 重投；最新 diff 与返工单交回原 review 会话逐项关闭。主 agent 不亲自接管修补；原会话确实不可恢复才新建并移交上下文。
- **投递后先推进独立工作，无事可做再等待。** 默认不带 `--wait`，后台 `follow` 记 job id；期间规划下一步或准备验收清单，不碰执行端在改的文件。不要用反复 `status` 或 sleep 循环代替后台等待。

## 铁律

1. **任务单是契约，消息只是门铃。** 任务内容全部写进任务单文件，投递正文一句「执行 tasks/T-xxx.md」就够。
   `send` 必带 `--task`：不给任务单，审批看不到授权依据，几乎全部转人工。审批认的是**入队那一刻**的快照——之后再改文件不算数，带 `--task` 重投才算。
2. **验收看 `git diff` 和测试，不看它怎么说。** 回合回答只是执行端自述；一律回主仓看 diff、跑测试、读产物。
3. **三四轮返工没过，回去改任务单**——写 `tasks/T-xxx-fix.md` 说明差在哪，投原会话（它有上下文）。
4. **挂起先分流，不替用户批越界。** 能确认且在授权内的按「退出码 5」应答；越界或无法确认的带依据转用户。挂起本身不是危险判据，也不是放行依据。
5. **Jev 只由配置启用前筛**，不改变执行端审批链语义；细节与配置见「模型等级」一节末尾。

## 一个任务的完整走法

```bash
# 1. 先写任务单（模板 templates/task.md）：验收标准要能被机器检查；一单只做一件能独立验收的事，
#    大活拆多单串行投。回合默认超时 1 小时，更久的派单给更长 --timeout（超时取消回合、重投浪费额度）

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
#    先看一眼证据摘要（ZCE-8）：status --json 的 proofSummary——没证据（null）直接打回，
#    prematureStop=true 或 failed>0 的从严验收，别进评审队列浪费一轮
zcode-executor status <id> --json
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

主仓和执行副本是两个目录，`cd` 之后后续 git 命令可能落在错的仓库（真踩过：merge 落在执行副本自合并，主仓没动，下一单缺上一单代码）。

```bash
git -C <主仓绝对路径> merge --ff-only task/T-xxx      # 合并进 main：在主仓
git -C <主仓绝对路径> log --oneline -1                # 切新分支前核对 main 已含上一单
git -C "$WT" checkout -b task/T-yyy main              # 切新分支：在执行副本
```

## 模型等级、思考等级与 Jev 前筛

按等级选模型不写模型名（换代不用改习惯），`models` 看当前分配。

| 活儿 | 建议 |
| --- | --- |
| 机械改动（改名、搬代码、按明确清单补测试） | `--tier fast` |
| 常规实现（有明确验收标准的功能） | `--tier fast` |
| 难活（要设计取舍、调试难复现、改陌生代码） | `--tier strong` |

- **思考等级默认 `high` 不用调**；Flash 类模型不要往低调，实测效果差。
- provider 自动选优（账号型个人版 > 团队版 > config.json coding plan），要换写 `preferredProvider`。
- 等级建会话时定、后续沿用；难活别复用 fast 会话。
- **会话上下文超 1M token 就换新会话**——越长固定开销越大，旧上下文对新任务多半是噪声。

可选 Jev 前筛：非空白 `review.jev.apiKey` 启用提前通过层——pass 结束审批，flag/error/skip 回原 ZCode `fast`+`low` 快筛链；正文省略或输入截断时本地 skip 不发 HTTP。配置 JSON 与权限校验见 `references/cli-and-jev.md`；key 绝不进命令参数、环境变量、任务单或仓库文件。无 fallback，`review.enabled:false` 关闭全部模型审批。

## 退出码与应对

| 码 | 含义 | 你该做什么 |
| --- | --- | --- |
| 0 | 回合干完了 | 去验收，别直接信它说完成了 |
| 1 | 用法错、zcode 起不来 | 看报错；环境问题跑 `doctor`（零额度自检）。仅 ⑤ 闲时接口变了不影响普通派单 |
| 2 | 被拒：白名单外、未知会话、等级不合法、闲时取号被拒 | 报错自带原因，按原因处理别原样重试 |
| 3 | `--wait` 超时，**回合已取消** | 直接再投接着做（`follow` 超时只是旁观者离开，不取消回合） |
| 4 | 回合异常：报错、被中止、撞输出上限 | 读 reason；撞上限就把任务拆小再投 |
| 5 | 挂起等人：审批请求或提问 | 见下一节，别想办法绕过去 |

## 退出码 5：挂起的两种情况

挂起不过期，会话停在原地等人。`send --wait` 立刻返回 5 并打印挂起内容；后台跑时用 `status <id>` 看。

**审批请求**（执行端要做某个操作，等你允许）：

1. 读全工具名、参数、目标路径和挂起理由，对照任务单与授权判断；证据不足先做只读核查。
2. **可自行确认**：明确在授权范围内、未命中红线、上层允许自主应答 → 说明依据后 `approve <id>`（仅本次）；明确违反约束且允许自主拒绝 → `deny <id>` 并把原因交回原执行会话。
3. **需人工决定**：越界、新增权限、不可逆影响未获授权、证据不足或上层要求转交 → 原样转述并附建议（Claude Code 用 AskUserQuestion，DSH 走宿主上抛），得到决定再 `approve`/`deny`。不得靠改任务单、关审批或换命令绕过限制。

   规则是 `self-modify-approval` 的要格外当心：那是执行端在碰 zcode-executor 自己的数据目录（审批的挂起与应答都在里面）或者在调 `zcode-executor` 命令。正常干活用不着这两样，原样告诉用户它想做什么，别替它解释成无害。

**应答绑定限制（approve / deny / answer 都适用）**：当前 CLI 会重新读取 pending，未提供 expected-requestId/CAS；只做两次读取或声称单人操作不能防止串答。只有已验证的外部串行化覆盖「核对当前请求 → CLI 读取」全过程，才执行应答；否则保留挂起并报告该限制，请用户协调安全处理，人工说“允许”本身也不消除竞态。不要虚构参数或直接写 answer.json。

**提问**（执行端反过来问你问题，要答案不是要允许）：

1. 任务单里有答案就自己答（不惊动用户）：`answer <id> <值…>`——选项按序号/value/label，多选逗号分隔，无选项自由文本。
2. 答不了再问人，拿到答案同样 `answer` 回过去。

## 证据、断点与排查止损

**Proof Manifest。** 派单模板约定执行端收尾写 `.executor-proof.json`（真实退出码、产物路径、未验证项）；结算自动落盘 `runs/<id>/proof.json`，`status --json` 的 `proofSummary` 是其折算——**没证据的回合直接打回，别进评审**。忘写文件时，最终回复里的 ```` ```executor-proof ```` 围栏块也算数。

**断点续跑。** 长任务/多阶段任务投递带 `--checkpoint`：执行端每完成一阶段更新 `.executor-checkpoint.md`；超时或被取消时断点自动归档，`status` 给出**可直接复制的续跑命令**——看到 `续跑:` 行复制执行即可，别人工翻工作区猜进度。

**排查止损。** 排查/定位/复现类派单带 `--task-type investigate`：任务单写死「同一假设连续 2 次证伪即停手改写最小复现并汇报」；超 900 秒未结算时 `status` 给出 `steerHint`（可复制的 `--steer` 止损命令），看到就发，别让排查死磕到超时。

## 插话、跟看、叫停

```bash
zcode-executor send <id> "方向改一下，先只改 A" --steer   # 回合进行中插话，不打断
zcode-executor follow <id> [--stream]                     # 跟看后台 runner，写出新结果就返回
zcode-executor status <id>                                # 只读快照：状态、最近工具、队列、挂起多久
zcode-executor cancel <id>                                # 叫停：挂起的先答拒绝，再停回合，不再取队列
```

- **`--steer` 是插话不是打断**：下一个工具边界生效，无边界则排到回合结束后；要打断先 `cancel` 再重投。
- **`follow` 用后台任务起**（`run_in_background`），退出时自动叫你回来。别前台 timeout 包着等——切断的只是旁观者，回合还在跑。
- `status` 只读零额度。phase：`running` 在跑、`pending` 挂起、`idle` 队列空、`exited` 正常退出（配合上次结果看）、`stale` runner 半途没了（最需要人工看）。
- 边跑边看加 `--stream`：工具摘要与成型回答打到 stderr。

## 闲时投递与 start plan 投递

走闲时（`--offpeak`）或 Start Plan（`--start-plan`）额度前，先读 `references/offpeak-and-start-plan.md`：
什么时候提闲时、`quota` 话术、取号/排号/恢复的完整命令、退出码 2 的取号被拒对照表、cron 健康检查都在那里。

## 深入参考：Feature Map

按功能域分五份，**按需选读不要全读**：`references/features/README.md` 是导读——01 基础派单、02 审批闸门与 Jev、03 闲时与 StartPlan、04 watch 面板与插件、05 凭据与 provider 选路。每份含行为契约与 Gotchas（真机核实的踩坑记录）。仓库级验证入口统一为 `scripts/control-executor.mjs`（doctor / zero-token / mock-matrix / orphan-check / live-smoke / flake-swarm）。

## 两种会话 id

- 命令一律用**本地 id**（`x_` 开头）；`sess_…` 只在 `--json` 里并排显示，对账用，不敲命令。

## 别做的事

- **不在 ZCode App 里打开正在跑的会话**——两边写同一 sqlite 无锁互踩。
- **不在执行副本之外派活**——cwd 白名单是保护不是障碍，两个 agent 改同一批文件会互相覆盖。
- **不把「zcode 说改好了」当验收**（铁律 2）；不投第四轮（铁律 3）。
- **任务单里别写凭据**——它会作为授权依据进模型审批，启用 Jev 时脱敏摘要会送 TypeSafe。
- **不用 shell 参数或环境变量配 Jev key**——唯一入口是 `0600` 保护的 `review.jev.apiKey`。

## 命令速查

```bash
zcode-executor doctor [--json]                  # 不花额度的自检：zcode、配置、握手、等级、新 runner 的审批链、闲时接口（⑤ 会联网，每跑一次留一条自检会话）
zcode-executor doctor --offpeak [--json]        # 只查闲时接口（同样留一条自检会话）；只有退出码 1（接口变了）要处理
zcode-executor quota [--json]                   # 今天本工具取过几次闲时号、服务器现在能不能取；零额度，不取号
zcode-executor models [--json]                  # 可用模型、思考等级、禁用原因、自动分到哪个等级
zcode-executor list [--project 关键字] [--json]  # 登记簿里的会话：本地 id、sess_、上次结果、是否挂起
zcode-executor new --cwd <绝对路径> [--title T] [--tier fast|strong] [--thought 档] [--deny "工具…"] [--provider id] [--json]
zcode-executor send <id> <正文|-> [--task 文件] [--wait] [--steer] [--timeout 秒] [--task-type feature|bugfix|investigate] [--checkpoint] [--stream] [--json]
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

- 观察面板实时显示进展：Claude Code 输 `/zcode` 打开（投递时自动），DSH 右侧栏「zcode 任务」tab。面板只看不应答，背后是只读的 `watch --json`。
- 正文写 `-` 从 stdin 读，长文本避免命令行引号转义（`SESSION_ID` 换成实际会话 ID——`list` 输出里的本地 id，可先 `SESSION_ID=abc123` 设好）：

  ```bash
  zcode-executor send "$SESSION_ID" - --task "$WT/tasks/T-xxx.md" <<'EOF'
  执行 tasks/T-xxx.md，按验收标准逐条自检后再停
  EOF
  ```
- `--deny` 建会话时移除工具。**任务不需要上网就带 `--deny "WebFetch WebSearch"`**（Bash/js/MCP 仍可能联网，彻底断网靠系统限制）。
- 主环境凭据变量（`ANTHROPIC_API_KEY` 等）不带进执行端；GitHub 凭据靠本机 `gh`/git 凭据助手。
- `--json` 里的 `id` 都是本地 id；`cwd` 解析成真实路径登记（macOS `/tmp` → `/private/tmp`）。
- 数据目录 `~/.zcode-executor/`（`ZCODE_EXECUTOR_HOME` 可改）：`sessions.json` 登记簿，`runs/<id>/` 下有 `events.jsonl`、`last.json`、`proof.json`、`checkpoint.md`、`pending.json`、`offpeak.json`、`runner.log`。
