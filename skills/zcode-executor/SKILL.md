---
name: zcode-executor
description: 把一件已经想清楚的开发任务交给本机 ZCode（GLM）执行，在隔离的执行副本里改代码，用 git diff 和测试验收。当用户说「让 zcode 去做」「派给 zcode」「派给执行端」，或者当前会话负责规划、实际改代码要交给 zcode 时使用。也用于查看 zcode 会话状态、给正在跑的回合插话、应答挂起的审批请求或提问。
---

# 把任务派给 zcode 执行

你是规划中枢，zcode 是执行端。你把要做什么写成任务单，zcode 在隔离的执行副本（git worktree）里改，
你用客观证据验收。命令是 `zcode-executor`，下面的命令块替换占位符后可直接复制运行。
装成 Claude Code 插件时它已在 PATH 里；在别的代理（如 Codex）里如果找不到这个命令，它就在本 skill 目录上两级的
`bin/zcode-executor`（即 `<插件根>/bin/zcode-executor`），用绝对路径调；也可以 `npm install -g zcode-executor` 或直接 `npx zcode-executor …`。

## 铁律

1. **任务单是契约，消息只是门铃。** 任务内容全部写进任务单文件，投递正文一句「执行 tasks/T-xxx.md」就够——
   zcode 是有自己判断的完整 agent，一段话过去它会自己重新理解，任务单才是事后对账的依据。
   所以 `send` 必带 `--task`：不给任务单，模型审批看不到你授权了什么，越界判断没有依据，几乎全部转人工。
2. **验收看 `git diff` 和测试，不看它怎么说。** 回合结束带回来的回答只是执行端自述。判断做没做对，
   一律回主仓看 diff、在执行副本里跑测试、读产物文件。
3. **反复投同一条会话三四轮还没过，回去改任务单。** 通常问题出在任务描述不清，不是多投几次能解决的。
   改法：写 `tasks/T-xxx-fix.md` 说明差在哪，再投同一条会话（它有上下文，带着上下文返工）。
4. **不替用户批越界。** 挂起（退出码 5）是执行端在等人的信号：审批请求用 AskUserQuestion 转给用户，
   拿到决定再 `approve` / `deny`。模型审批只会放行或转人工、从不拒绝，替用户点「允许」越过这一层，
   等于把人工这道闸门拆了。

## 一个任务的完整走法

```bash
# 1. 先写任务单（模板 templates/task.md）
#    验收标准要能被机器检查：跑什么命令、看什么文件、期望什么输出

# 2. 给仓库建执行副本（每个仓库一个，按任务切分支）
WT=~/.zcode-executor/worktrees/<仓库名>
git -C <主仓绝对路径> worktree add "$WT" -b task/T-xxx    # 首次：在 $WT 里装一次依赖

# 3. 建会话：只做零 token 登记，返回本地 id（x_ 开头）；zcode 会话第一次投递时才建
zcode-executor new --cwd "$WT" --title T-xxx --tier fast --json

# 4. 投递并跟看到干完（--task 必带）
#    消息里的 tasks/T-xxx.md 是让 zcode 自己在执行副本里读的相对路径，所以任务单必须放在 $WT 里；
#    --task 给的是模型审批看的授权依据，用绝对路径
zcode-executor send <id> "执行 tasks/T-xxx.md" --task "$WT/tasks/T-xxx.md" --wait

# 5. 验收（客观证据，不是它的自述）。zcode 不提交，改动停在执行副本工作区，先把未跟踪文件收进来再看 diff
git -C "$WT" add -A && git -C "$WT" diff --cached --stat && git -C "$WT" diff --cached
git -C "$WT" <跑测试的命令>
#    还想看审批经过：$ZCODE_EXECUTOR_HOME/runs/<id>/events.jsonl 里 type 为 executor.gate 的行

# 6. 过了：在 $WT 里提交（git -C "$WT" commit -m "T-xxx: …"），再回主仓合并（见下一节）。
#    没过：git -C "$WT" reset 撤掉暂存，写 tasks/T-xxx-fix.md，再投同一条会话
```

挂起时 `send --wait` 立刻以退出码 5 返回并打印挂起内容，处理见「退出码 5」一节；
不想前台等就去掉 `--wait`（立刻返回，起一个后台 runner），用 `follow` 跟看。

## git 一律 `-C <绝对路径>`，别靠 cd

主仓和执行副本是两个目录，一条 Bash 里 `cd` 过一次之后，后面的 `git merge`、`git checkout -b`
就可能跑在你以为之外的那个仓库里。真踩过的坑：在执行副本里跑完测试接着 merge，merge 落在执行副本
（HEAD 就是那个分支，自合并什么都没变），主仓 main 没动，下一单从 main 切的分支缺上一单的代码。

```bash
git -C <主仓绝对路径> merge --ff-only task/T-xxx      # 合并进 main：在主仓
git -C <主仓绝对路径> log --oneline -1                # 切新分支前核对 main 已含上一单
git -C "$WT" checkout -b task/T-yyy main              # 切新分支：在执行副本
```

## 模型等级与思考等级

按等级选模型，不写模型名——模型换代不用改习惯。`models` 能看每个等级当前分到了谁。

| 活儿 | 建议 |
| --- | --- |
| 机械改动（改名、搬代码、按明确清单补测试） | `--tier fast` |
| 常规实现（有明确验收标准的功能） | `--tier fast` |
| 难活（要设计取舍、调试难复现、改陌生代码） | `--tier strong` |

- **思考等级默认 `high`，都不用调。** Flash 类模型不要往低调，实测效果差。
- provider 已优先 coding plan；同名模型在多个 provider 下并存时不用管，插件自己选对。
- 模型和思考等级建会话时定，同一条会话后续投递沿用。难活别复用之前建的 fast 会话，新开一条。

## 退出码与应对

| 码 | 含义 | 你该做什么 |
| --- | --- | --- |
| 0 | 回合干完了 | 去验收，别直接信它说完成了 |
| 1 | 用法错、zcode 起不来、版本过低 | 看报错；环境问题跑 `zcode-executor doctor`（零 token 自检） |
| 2 | 被拒：白名单外、会话不在登记簿、等级或思考等级不合法 | 报错里写了原因，按原因处理，别原样重试 |
| 3 | `send --wait` 超时（默认 1800 秒，`--timeout` 可改），**当前回合已取消**，会话还在 | 直接再投一次接着做；`follow` 的超时不取消任何东西，只是旁观者到点走了 |
| 4 | 回合异常：报错、被中止、撞输出上限 | 读 reason；撞上限就把任务拆小再投 |
| 5 | 挂起等人：审批请求或提问 | 见下一节，别想办法绕过去 |

## 退出码 5：挂起的两种情况

挂起不过期，会话停在原地等人。`send --wait` 立刻返回 5 并打印挂起内容；后台跑时用 `status <id>` 看。

**审批请求**（执行端要做某个操作，等你允许）：

1. 看挂起内容里的工具名、参数和转人工的理由，用 AskUserQuestion 转给用户
   （命中红线的一定要转，比如越出执行副本的写入）。
2. 拿到决定：允许 → `zcode-executor approve <id>`（只放行这一次，没有「一直允许」）；
   拒绝 → `zcode-executor deny <id>`。回合从挂起处继续。

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
- **`follow` 用后台任务起**（`run_in_background`），它退出时你会被自动叫回来。别在前台用 timeout
  包着等——超时切断的只是你这个旁观者，回合还在跑，你却容易当成它挂了。
- 想随时问「到哪了」用 `status`：只读、不花额度、不阻塞。phase 的取值：`running` 在跑、`pending` 挂起等人、
  `idle` runner 活着但队列空、`exited` runner 跑完正常退出（配合「上次: done」看，不是出事）、`stale` runner 跑到一半没了，最需要人工看。
  `list` 每行的 `[phase]` 同一套词，没有 running / pending 就是没有在跑的会话。
- 要边跑边看，`send` / `follow` 加 `--stream`：工具调用摘要和成型回答打到 stderr。

## 两种会话 id

- 命令一律用**本地 id**（`x_` 开头，`new` 返回的那个）。
- zcode 自己的 `sess_…` id 首回合之后才存在，只在 `list` 里和本地 id 并排显示，对账用，不敲命令。

## 别做的事

- **不要在 ZCode App 里打开正在跑的会话。** 两边写同一个 sqlite，没有跨进程锁，会互相踩。
- **不在执行副本之外派活。** `new` 的 cwd 白名单默认只有 `~/.zcode-executor/worktrees/`，
  那是保护不是障碍；两个 agent 同时改同一批文件会互相覆盖。
- **不要把「zcode 说改好了」当验收写进汇报。** 验收只认 `git diff` 和测试结果（铁律 2）。
- 不要投第四轮。三四轮没过，改任务单（铁律 3）。
- **任务单里别写凭据。** 任务单全文会作为授权依据发给模型审批。

## 命令速查

```bash
zcode-executor doctor [--json]                  # 零 token 自检：zcode 版本、配置存在、真握手、等级分配
zcode-executor models [--json]                  # 可用模型、思考等级、禁用原因、自动分到哪个等级
zcode-executor list [--project 关键字] [--json]  # 登记簿里的会话：本地 id、sess_、上次结果、是否挂起
zcode-executor new --cwd <绝对路径> [--title T] [--tier fast|strong] [--thought 档] [--deny "工具…"] [--provider id] [--json]
zcode-executor send <id> <正文|-> [--task 文件] [--wait] [--steer] [--timeout 秒] [--stream] [--json]
zcode-executor follow <id> [--timeout 秒] [--stream] [--json]
zcode-executor status <id> [--tools N] [--json]  # 在跑/空闲/挂起/异常结束、最近工具调用、队列长度
zcode-executor cancel <id>                       # 叫停：挂起的先答拒绝，之后不再取队列
zcode-executor approve <id>                      # 应答挂起的审批请求，只回 allow_once
zcode-executor deny <id>                         # 应答挂起的审批请求为拒绝
zcode-executor answer <id> <值…>                 # 应答挂起的提问：按序号/value/label，多选逗号分隔
```

- 正文写 `-` 从 stdin 读，长文本别跟命令行引号较劲：

  ```bash
  zcode-executor send <id> - --task "$WT/tasks/T-xxx.md" --wait <<'EOF'
  执行 tasks/T-xxx.md，按验收标准逐条自检后再停
  EOF
  ```

- `--deny` 建会话时物理拿掉工具（如 `--deny "WebSearch"`），任务不需要执行端上网时用。
- `--json` 给机器可读结构，脚本化处理时用；输出里的 `id` 都是本地 id。
- cwd 会解析成真实路径存进登记簿（macOS 的 `/tmp/x` 会变成 `/private/tmp/x`），`list --project` 按解析后的路径匹配。
- 数据目录 `~/.zcode-executor/`（`ZCODE_EXECUTOR_HOME` 可改）：`sessions.json` 登记簿，`runs/<id>/` 里有 `events.jsonl`（zcode 事件与闸门决定）、`last.json`、`pending.json`、`runner.log`。
