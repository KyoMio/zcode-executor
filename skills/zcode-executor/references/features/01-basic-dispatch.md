# 01 · 基础派单：new / send / follow / status / cancel

## 生命周期

```
new（登记，本地 id）→ send（入队，runner 起）→ 回合跑 → follow/status 观察
                                                  → cancel（随时可停）
```

- `new`：在 `cwd`（必须在白名单内）登记一条本地会话，返回本地 id。不接触 ZCode、零 token。`--tier fast|strong` 选模型档、`--thought` 选思考档。
- `send <id> <正文|->`：正文入队，detached runner 拉起。**默认必带 `--task <文件>`**（任务是契约，审批按入队快照判断授权）。`--wait` 阻塞到回合结算；不带则立即返回，用 `follow` 或后台等待。退出码：`done=0 timeout=3 failed/exited/cancelled=4`，挂起（审批/提问）`=5`。
- `follow <id>`：等价于 attach 等当前回合结算，输出与 `send --wait` 同形。
- `status <id> [--json]`：phase（`pending/running/stale/idle/…`）+ 最近事件 + proof 摘要。`--json` 的 `pending` 含脱敏 `toolName`/`commandPreview`（240 字符截断）/`filePath`——排障先看这里，不用翻 `runs/<id>/pending.json`。
- `cancel <id>`：写 `stop`/`cancel` 标记、有活着 runner 时发 `session/stop` 使回合以 `cancelled` 结算；幂等（runner 已不在时清理残留挂起/队列并正常退出 0，仅未知会话 id 退出码 2）。

## 状态与文件布局

`~/.zcode-executor/runs/<id>/`：`lock`（pid 存活判定）、`state.json`、`events.jsonl`（逐行事件流）、`last.json`（结算 outcome）、`pending.json`（挂起详情）、`proof.json`（执行端证据 manifest）、`checkpoint.md`（超时断点）。**验收看 `git diff` 和测试，不看执行端自述。**

## worktree 白名单

`config.json` 的 `allowedRoots` 与 `cwd` 都经 realpath 后比前缀（macOS `/tmp` → `/private/tmp` 双写法都能过）。不在白名单 → 退出码 2，报错列出允许的根目录。非 worktree 只警告不拒；git 钩子里的 `GIT_DIR` 等环境变量会被剥离，worktree 判定按 cwd 本身。

## Gotchas

1. **回合默认超时 3600s**：长任务派单时显式给更长 `--timeout`；超时取消回合后重投是浪费额度——超时场景先读 `runs/<id>/checkpoint.md` 断点续跑。
2. **`send` 快照语义**：审批认的是入队那一刻的 `--task` 文件内容。之后再改任务单文件对本次审批无效——改了就要带 `--task` 重投。
3. **steer 的提交时机与生效时机是两回事**：提交侧，mock 实测 `turn.started` 后（无需等首个工具事件）`--steer` 就能拿到 queued/accepted；生效侧，插话在**下一个工具边界**落地，没有边界时排到回合结束后执行。回合刚起（turn.started 之前）注入仍可能丢——等 events 出现 `turn.started` 再发。3.12 起回合忙时 `session/send` 直接拒绝，插话走 `v4/command sendText`。
4. **runner 锁**：按会话隔离（`runs/<id>/lock` 的 `linkSync` 原子锁），同一会话同时至多一个活 runner（第二个 `_runner` 退出码 2，pid 死掉的陈年锁会被新 runner 覆盖接管）；不跨会话保护同一 worktree，多会话勿共用同一工作目录。
5. **investigate 止损**：`--task-type investigate` 超 900s 未结算时，CLI 会提示可用 `--steer` 注入止损指令退回汇报——别无限等。
6. **连续三四轮返工不过，改任务单而不是再投**：执行端有完整判断力，反复失败通常是任务描述不清。写 `tasks/T-xxx-fix.md` 说明差在哪再投同一会话。
