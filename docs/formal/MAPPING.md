# ZCE-6 形式化建模与代码实现对照（TurnRunnerQueue & PermissionGateToolSummary）

> **同步基线**：`main@0677b96` + **F1–F4 源码修复闭环（含 R1 并发加固）**
> **修复说明**（将 ZCE-6 暴露的 F1–F4 四项源码缺陷全部修完，原有 4 份 finding 配置均已翻绿为 `exit 0`）：
> - **F1 修复**（[lib/runs.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/runs.mjs)、[lib/run.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/run.mjs)）：新增 `acquireSessionLock` 与 `releaseLockIfOwned`，对陈年锁回收用同目录 `.reclaim` 原子互斥锁串行化后再复查活锁与清理；区分 `ENOENT` 与死 `.reclaim`（仅超 `RECLAIM_STALE_MS = 5000ms` 才回收）并在 `try` 内复验 `.reclaim` 归属，`tryLinkLock` 绝不删异主锁。
> - **F2 修复**（[lib/run.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/run.mjs)）：`onSignal` 独占收尾（主 `finally` 首行 `if (signaled) return;` 退让，所有队列续跑/出队循环检查 `signaled` 早退），等待在飞 `spawnPromise` 落位并冲刷 `session/stop` 后 `await clientRef?.close({ timeoutMs: 1500 })` 关闭 detached 子进程组，随后才 `dispose()` 临时密钥、删 `pending.json`、`offpeak.wrapUp(true)`、`releaseLockIfOwned(lockPath)` 并 `process.exit(0)`。
> - **F3 修复**（[lib/tool-summary.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/tool-summary.mjs)）：`parseTurn` 回填仅对 `call.toolName` 非空条目消费同名 `requestedByTool` 队列，移除 `:238` 缺名跨工具借用兜底。
> - **F4 修复**（[lib/pending.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/pending.mjs)、[lib/gate.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/gate.mjs)、[lib/run.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/run.mjs)）：`createPendingGate` 新增不可逆 `close()`（`PENDING_ABORTED` 透传过 `gate.mjs` `permission`/`question` 的 `catch`），拒掉当前挂起、后续 `tail` 排队项与超时后迟到的在飞 `review()` 回落；`session.send().finally()` 调 `gate?.close()`，`last.outcome === 'timeout'` 跳出内层队列循环关闭旧连接，队列非空时外层循环以新连接与新闸门续跑。
>
> **覆盖文件**：
> - 子系统 1：[lib/run.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/run.mjs)、[lib/session.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/session.mjs)、[lib/queue.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/queue.mjs)（及关联原语 [lib/runs.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/runs.mjs)、[lib/providers.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/providers.mjs)、[lib/appserver.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/appserver.mjs)）
> - 子系统 2：[lib/gate.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/gate.mjs)、[lib/tool-summary.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/tool-summary.mjs)（及关联裁决/挂起模块 [lib/review/run.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/review/run.mjs)、[lib/review/parse.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/review/parse.mjs)、[lib/review/hard.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/review/hard.mjs)、[lib/pending.mjs](file:///Volumes/MacData/projects/zcode-executor/lib/pending.mjs)）
> **验证工具**：TLC v2.19（`/opt/homebrew/bin/tlc`）+ `$pstack-statechart`（`pstack` 插件内置 `/statechart`）。后续如改动上述覆盖文件，请按 `/maintain-formal-verification-skill` 流程复核并更新本对照表的同步基线。

---

## 一、一键复现命令

```sh
# 1. 子系统 1（全量并发互斥、重试上限与终态清理，0 反例）
tlc -workers 1 -metadir /tmp/zce6-meta-trq -config docs/formal/TurnRunnerQueue.cfg docs/formal/TurnRunnerQueue.tla

# 2. 子系统 2（全量交错裁决安全与同名回填，0 反例）
tlc -workers 1 -metadir /tmp/zce6-meta-pg -config docs/formal/PermissionGateToolSummary.cfg docs/formal/PermissionGateToolSummary.tla

# 3. F1–F4 修复后回归验证（全部 0 反例通过，exit 0）
tlc -workers 1 -metadir /tmp/zce6-meta-f1 -config docs/formal/TurnRunnerQueue-finding-stale-lock.cfg docs/formal/TurnRunnerQueue.tla
tlc -workers 1 -metadir /tmp/zce6-meta-f2 -config docs/formal/TurnRunnerQueue-finding-signal.cfg docs/formal/TurnRunnerQueue.tla
tlc -workers 1 -metadir /tmp/zce6-meta-f3 -config docs/formal/PermissionGateToolSummary-finding-unnamed-steal.cfg docs/formal/PermissionGateToolSummary.tla
tlc -workers 1 -metadir /tmp/zce6-meta-f4 -config docs/formal/TurnRunnerQueue-finding-timeout-wedge.cfg docs/formal/TurnRunnerQueue.tla

# 4. 重新渲染两份 Mermaid 状态图（需使用新的空输出目录；/statechart 生成）
TLA2TOOLS=/opt/homebrew/share/tla/tla2tools.jar JAVA=/opt/homebrew/opt/openjdk@17/bin/java \
  /Volumes/MacData/Users/kyomio/.gemini/config/plugins/pstack/skills/statechart/scripts/statechart \
  docs/formal/TurnRunnerQueue.tla --config docs/formal/TurnRunnerQueue-chart.cfg \
  --view docs/formal/turn-runner-queue.view.mjs --out /tmp/zce6-chart-trq

TLA2TOOLS=/opt/homebrew/share/tla/tla2tools.jar JAVA=/opt/homebrew/opt/openjdk@17/bin/java \
  /Volumes/MacData/Users/kyomio/.gemini/config/plugins/pstack/skills/statechart/scripts/statechart \
  docs/formal/PermissionGateToolSummary.tla --config docs/formal/PermissionGateToolSummary-chart.cfg \
  --view docs/formal/permission-gate-tool-summary.view.mjs --out /tmp/zce6-chart-pg
```

---

## 二、TLC 模型检测结果总表（8/8 全绿）

| 模型与配置 | 边界与参数 | 状态数（Distinct / Generated） | 深度 | 结论 |
|---|---|---:|---:|---|
| `TurnRunnerQueue.cfg` | `Runners={"R1","R2","R3"}`, `MaxAttempts=2`, `MaxQueue=1`, `AllowStaleLock=FALSE`, `AllowSignal=FALSE` | `11,453` / `20,852` | `23` | **exit 0（0 反例）** |
| `TurnRunnerQueue-chart.cfg` | `Runners={"R1"}`, `MaxAttempts=2`, `MaxQueue=1`（供 `/statechart` 渲染） | `69` / `123` | `10` | **exit 0（0 反例），16 态 28 边** |
| `TurnRunnerQueue-finding-stale-lock.cfg` | `AllowStaleLock=TRUE`（含死 `.reclaim` 初态与新鲜度保护） | `4,969` / `9,209` | `18` | **exit 0（F1 修复后 0 反例）** |
| `TurnRunnerQueue-finding-signal.cfg` | `AllowSignal=TRUE`（覆盖 `LockHeld` 含 spawn 窗口至执行期） | `91` / `170` | `10` | **exit 0（F2 修复后 0 反例）** |
| `TurnRunnerQueue-finding-timeout-wedge.cfg` | `Runners={"R1"}`, `MaxQueue=2`（F4 `gate.close()` + 超时重连新闸门） | `163` / `309` | `15` | **exit 0（F4 修复后 0 反例）** |
| `PermissionGateToolSummary.cfg` | `AllowUnnamedOmitted=FALSE`, `ChartCompact=FALSE`（全交错） | `93,438` / `257,307` | `18` | **exit 0（0 反例）** |
| `PermissionGateToolSummary-chart.cfg` | `AllowUnnamedOmitted=FALSE`, `ChartCompact=TRUE`（供 `/statechart` 渲染） | `319` / `390` | `15` | **exit 0（0 反例），23 态 38 边** |
| `PermissionGateToolSummary-finding-unnamed-steal.cfg` | `AllowUnnamedOmitted=TRUE`（F3 严格限定具名工具消费自身队列） | `134,386` / `362,059` | `18` | **exit 0（F3 修复后 0 反例）** |

---

## 三、`TurnRunnerQueue.tla` ↔ 代码实现逐条对照

输出状态图：[turn-runner-queue.mmd](file:///Volumes/MacData/projects/zcode-executor/docs/formal/turn-runner-queue.mmd)（报告：[turn-runner-queue-statechart-report.md](file:///Volumes/MacData/projects/zcode-executor/docs/formal/turn-runner-queue-statechart-report.md)）

| TLA+ 动作 | 实现位置（`file:line`） | 语义对照与抽象说明 |
|---|---|---|
| `TryAcquireLockSuccess` | `lib/run.mjs:163,171`；`lib/runs.mjs:224-243,254` (`tryLinkLock` / `acquireSessionLock`) | `linkSync` 原子抢锁成功后回读校验 `pid === process.pid`，清陈年 `pending.json`/`answer.json`。 |
| `TryAcquireLockContendedLive` | `lib/runs.mjs:100-110,255-258` (`livePidOfLockFile`) | `livePidOfLockFile` 见活进程立即抛 `ExecutorError(..., 2)`，不触碰锁与现场文件。 |
| `ObserveDeadLock` / `AcquireReclaimLock` / `AcquireReclaimContended` / `ReverifyLiveAndAbort` / `ReverifyDead` / `UnlinkDeadLock` / `ReacquireAfterUnlink*` | `lib/runs.mjs:254-309` (`acquireSessionLock`) | **F1 修复**：先抢占 `.reclaim` 互斥锁（`ENOENT` 不删除直接重试、新鲜死 `.reclaim` 在 `5s` 交接窗内拒抢、仅过期死 `.reclaim` 清理重抢），进入 `try` 后先复验 `.reclaim` 归属，再 `ReverifyDead`（`livePidOfLockFile`），确认非活锁后 `UnlinkDeadLock`（`removeFileIfExists`），保留快路径 `TryAcquireLockSuccess` 在两步之间抢锁的交错窗口。 |
| `SpawnAndAttach` / `SpawnOrAttachFail` | `lib/run.mjs:242-265,361-390`；`lib/providers.mjs:183-192`；`lib/appserver.mjs:415-445` | 先 `writePersonalProviderFile` 写 `0600` 临时文件（`providerKeyFile=TRUE`），再通过 `spawnPromise` 调 `AppServerClient.spawn` + `attachSession`。覆盖 `spawn` 失败与 `spawn` 后 `attachSession`/`session/create` 抛错两条进 `finally` 路径。 |
| `TakeQueueItem` / `StartTurn` / `DropMaxAttempts` / `QueueEmptyFinish` | `lib/run.mjs:394-421,466,558`；`lib/queue.mjs:13,48-61` | 先取队头并 `bumpAttempts` 持久化递增（`CheckingAttempts`），再判 `attempts > MAX_ATTEMPTS`（`2`）：超限直接出队丢弃并回 `Connected` 继续循环；队列为空且 `ended='empty'` 时结束外层循环进 `finally`。 |
| `EnterBlocked` / `AnswerBlocked` / `LateReviewFallbackBlockedByClose` | `lib/run.mjs:280-346`；`lib/pending.mjs:120-256`；`lib/gate.mjs:157-244` | `onPending` 写 `pending.json` 并启动 `ANSWER_POLL_MS`（300ms）轮询；`gate.close()` 置不可逆 `closed` 态（`gateClosed=TRUE`），使 `tail` 排队挂起与超时后迟到的在飞 `review()` 回落一律以 `PENDING_ABORTED` 拒绝，绝不再写 `pending.json`。 |
| `SendSteer` / `DrainSteer` / `SteerStartNowFail` | `lib/run.mjs:425-462`；`lib/session.mjs:256-282` | `inTurnWatcher` 确认无 `pending.json` 与 `cancel` 后取 `nextSteerFile` 调 `session.steer`；正常路径在工具边界 `turn.steerDrained` 生效；竞态撞上回合刚结束（`delivery='startNow'`）则发 `v4 stop` 并记 `steerUnavailable` 报错但不弄死 `session.send`。 |
| `TriggerCancel` | `lib/run.mjs:180-203,288-309,429-433` | 从 `Running`/`Blocked`/`SteerQueued` 均可触发：设 `cancelSeen=TRUE`、发 `session/stop`、启动 `CANCEL_GRACE_MS` 强断定时器；若在 `Blocked`，挂起轮询自动替答 `deny`/`decline` 并清 `pending.json`。 |
| `CancelSettleCancelled` / `CancelSettleRacedDone` | `lib/run.mjs:487,500,535-540` | `cancelled = cancelSeen && outcome.outcome !== 'done'`：未在 stop 前正常完工则一律按 `cancelled` 明确结算；若已先拿到 `done` 则保留已完成事实并以 `cancelSeen` 退出循环。 |
| `TurnCompleteSuccess` / `TurnTimeout` / `SettleTimeout` / `CloseForReconnect` / `ChildCrash` | `lib/session.mjs:58-79,201-246`；`lib/run.mjs:466-558`；`lib/pending.mjs:233-246`；`lib/gate.mjs:144,197,238` | **F4 修复**：`session.send().finally()` 调 `gate?.close()`，`timeout` 后 `lib/run.mjs:543` 跳出内层循环进入 `CloseForReconnect` 关旧连接与旧闸门，队列仍有下一项时重连 `SpawnAndAttach`。 |
| `FinallyCleanup` | `lib/run.mjs:564-583`；`lib/session.mjs:294-300`；`lib/appserver.mjs:570-599` | 首行 `if (signaled) return;` 让位信号处理器；非信号路径依次关闭 `sessionRef`/`clientRef`、`providerFile.dispose()`、清 `pending.json`、调 `releaseLockIfOwned(lockPath)` 进终态。 |
| `ReceiveSignal` / `SignalCleanupExit` | `lib/run.mjs:104-156,242-258,395,477,549,561,565` | **F2 修复**：覆盖 `LockHeld`（含在飞 `spawnPromise`）至运行/挂起/重连全窗口，`onSignal` 独占清理并阻断后续队列消费、出队与主 `finally` 抢跑释锁。 |

---

## 四、`PermissionGateToolSummary.tla` ↔ 代码实现逐条对照

输出状态图：[permission-gate-tool-summary.mmd](file:///Volumes/MacData/projects/zcode-executor/docs/formal/permission-gate-tool-summary.mmd)（报告：[permission-gate-tool-summary-statechart-report.md](file:///Volumes/MacData/projects/zcode-executor/docs/formal/permission-gate-tool-summary-statechart-report.md)）

| TLA+ 动作 | 实现位置（`file:line`） | 语义对照与抽象说明 |
|---|---|---|
| `ReceivePermissionRequest` | `lib/gate.mjs:138-156` | 闸门 `permission(params)` 入口，整段包裹在 `try/catch` 内（仅 `PENDING_ABORTED` 透传），并在请求进入时即携带 `hasAllowOnce \in BOOLEAN` 属性。 |
| `HardRuleHit` / `HardRulePass` | `lib/gate.mjs:162-167`；`lib/review/hard.mjs:39-113` | 命中 `outside-worktree` 或 `self-modify-approval` 直接记事件并写 `pending.json` 转人工（`stage='hard'`），绝不进模型审批；若原请求带 `allow_once` 仍可由人工 `approve`。 |
| `GateInternalError` | `lib/gate.mjs:143-155` | 非 `PENDING_ABORTED` 异常被顶层 `catch` 接住，写入 `stage='gate-error'` 并挂起转人工（故障默认安全）。 |
| `NoAllowOnce` / `HasAllowOnce` | `lib/gate.mjs:169-173`；`lib/pending.mjs:31-40` | 校验请求自带的 `options` 是否存在 `kind === 'allow_once'`（忽略 `allow_always`）；缺失则挂起 `stage='no-allow-option'`。 |
| `ReviewDisabled` / `EnterJevPreScreen` / `SkipJevToFast` | `lib/gate.mjs:175-179`；`lib/review/run.mjs:71-86` | 无 `complete` 直接转人工 `review-disabled`；有 `fastScreen` 先跑 Jev，仅 `pass` 提前放行，其余全回落 ZCode 两段审批。 |
| `FastPass` / `FastFlag` / `FastCompleteError` | `lib/review/run.mjs:89-108`；`lib/review/parse.mjs:19-25` | `parseFast` 仅全文唯一独立 `Y/YES` 返回 `'pass'`；异常/超时转 `review-failed` 挂起。 |
| `SlowAllow` / `SlowAsk` / `SlowDenyCited` / `SlowDenyUncited` / `SlowParseAnomaly` / `SlowCompleteError` | `lib/review/run.mjs:111-151`；`lib/review/parse.mjs:105-214`；`lib/gate.mjs:207-227` | `SlowDenyCited` 在 `review/run.mjs:140-141` 强制映射为 `decision: 'ask'`；`SlowDenyUncited` 在 `parse.mjs:107-113` 与 `review/run.mjs:133-139` 降级为 `'ask'`；`parseSlow === undefined`（畸形/引用块/围栏块/截断）或调用抛错落入 `review-failed` + `'ask'`。 |
| `EmitAutoAllow` / `HumanApprove` / `HumanDeny` | `lib/gate.mjs:207-212`；`lib/pending.mjs:43-55,208-225` | 只有 `gate` 自动应答 `allow`；`deny` 仅能由人工触发 `permissionResponse(pending, 'deny')` 产生。 |
| `ScheduleSlot1` / `ScheduleSlot2` / `ReceiveStreamOrInlineInput` / `ReceivePermRequest` | `lib/tool-summary.mjs:190-232` | 收集两槽位调用记录：`model.streaming` `tool_call` 为权威参数源（即使 `tool.updated` 带 `inputOmitted: true` 亦可由 `stream` 覆盖），其次为旧形状行内 `input`；`permission.requested` 按 `toolName` 入 `requestedByTool` 队列。 |
| `BackfillSlot1` / `BackfillSlot2` | `lib/tool-summary.mjs:233-240` | **F3 修复后严格同名归属**：仅 `call.toolName` 非空条目按 `requestedByTool.get(call.toolName)` 回填；缺名调用不再从任何具名队列借用输入。 |

---

## 五、变异测试与反向修复证伪闭环（15/15）

所有变异均在临时目录执行（不修改仓库正式规约），每项均触发对应不变量反例并退出 `12`：

| 变异编号 | 注入缺陷（对应源码失守情景） | 违背的不变量 | TLC 结果 |
|---|---|---|---|
| **Mut1** | `TryAcquireLockSuccess` 去掉 `lockOwner = "none"` 互斥守卫 | `InvMutexSingleLockHolder` | **exit 12**（depth 3，5 states） |
| **Mut2** | `FinallyCleanup` 漏掉释放 `lockOwner` / `rLockHeld` | `InvTerminalReleasesLock` | **exit 12**（depth 4，28 states） |
| **Mut3** | `FinallyCleanup` 漏掉关闭 `childAlive`（漏调 `clientRef.close()`） | `InvTerminalZeroOrphans` | **exit 12**（depth 4，29 states） |
| **Mut4** | `FinallyCleanup` 漏掉清理 `providerKeyFile`（漏调 `providerFile.dispose()`） | `InvTerminalZeroTempKeyFiles` | **exit 12**（depth 4，28 states） |
| **Mut5** | `CancelSettleCancelled` 将取消宽限退出误结算为 `exited` | `InvSteerCancelExplicitSettlement` | **exit 12**（depth 9，470 states） |
| **Mut6** | `StartTurn` 放宽为 `attempts <= MaxAttempts + 1`（off-by-one） | `InvQueueAttemptBound` | **exit 12**（depth 17，6,949 states） |
| **MutG1** | `SlowDenyCited` 直接对外应答 `deny` 而非映射 `ask` | `InvGateNeverAutoDenies` | **exit 12**（depth 7，4,373 states） |
| **MutG2** | `SlowParseAnomaly` 解析异常误放行 `allow` | `InvParseAnomalySafeAsk` | **exit 12**（depth 7，4,374 states） |
| **MutG3** | `HardRuleHit` 命中红线后仍走 `allow` | `InvHardRuleAndAllowOnceGuard` | **exit 12**（depth 3，8 states） |
| **MutT1** | `BackfillSlot` 允许 `Read` 缺省时借用 `permQueue["Write"]` | `InvSameToolAttribution` | **exit 12**（depth 6，2,321 states） |
| **RevF1** | 回退 F1：去掉 `.reclaim` 互斥与 `try` 内归属复验 | `InvMutexSingleLockHolder` | **exit 12**（depth 11，2,091 states） |
| **RevF2** | 回退 F2：`SignalCleanupExit` 漏关 `childAlive` | `InvTerminalZeroOrphans` | **exit 12**（depth 5，13 states） |
| **RevF3** | 回退 F3：恢复 `callName = "None"` 借用 `permQueue["Read"]` | `InvNoUnnamedSteal` | **exit 12**（depth 6，4,180 states） |
| **RevF4** | 回退 F4：`SettleTimeout` 漏调 `gate.close()` 并回 `Connected` | `InvNoWedgedGate` | **exit 12**（depth 11，94 states） |
| **RevF4b** | 回退 F4：`LateReviewFallbackBlockedByClose` 在 `gateClosed` 后写 `pending.json` | `InvNoWedgedGate` | **exit 12**（depth 7，26 states） |

---

## 六、未建模范围声明

1. **闲时投递 / Start Plan 排队取号协议**（`lib/offpeak-*.mjs`、`lib/startplan-*.mjs`）：已通过集成测试覆盖，未纳入本次两份 TLA+ 规约。
2. **Jev HTTP 退避重试、脱敏正则与本地代理隧道细节**（`lib/review/jev.mjs`、`lib/review/proxy-fetch.mjs`）：规约将 Jev 抽象为「`pass` 短路放行，其余（`flag`/`skip`/`error`/抛错）一律安全回落 Stage 1」。
3. **文件原子写半截与磁盘满/权限异常**（`writeJsonAtomic`、`appendEvent`）：规约假设原子文件原语按规范生效。
4. **多会话跨 `sessionId` 并发与 `cancel.mjs` 独立删除队列时的竞争**：`TurnRunnerQueue` 聚焦单一会话 worktree 锁及所属 runner/队列项生命周期。
5. **非 `inputOmitted` 路径的 `tool-summary` 文本截断、Bash `perf` 成败判定与 Markdown 尾截**（`toolSummary` / `replyLines` / `markdownTail`）：纯文本格式化逻辑，不涉及状态机跨工具归属竞态。
