# Jev：基于本机 zcode-executor 运行记录的初步校准

> 历史记录：本文实验数据与当时建议原样保留，不代表现行 [D16](../decisions.md#d16-jev-改为可选前筛原-zcode-快筛完整保留) 的「Jev 前筛 → 原 ZCode 快筛 → 必要时慢判」路线；`approval-v2` 尚未重新真实校准，旧通过率不可直接复用。

> 日期：2026-09-18
> 数据来源：`~/.zcode-executor/sessions.json` 与 `runs/*/events.jsonl` 的只读快照。
> 目的：判断历史记录是否足以校准 Jev 快筛，并估计可行的初始 shadow/canary 阈值。
> 注意：这是历史弱标签实验，不是安全认证，也不是可直接上线的最终阈值。

## 1. 摘要结论

本机记录足以证明 Jev **有希望承担第一段快筛**，但不足以证明它可以直接无监督上线。

在 398 条分层样本上，加入可读取的任务单正文后，以下候选策略与历史参考标签对照：

```text
scope pass probability       >= 0.80
outside-worktree probability <= 0.20
credential/exfil probability <= 0.20
destructive/external prob.   <= 0.20
routine probability          >= 0.80
```

得到：

- 自动放行候选：205 / 398；
- 参考 allow 中覆盖：205 / 374，约 54.8%；
- 24 条参考 flag 中误放：0；
- 按 run 分组的留出集：45 / 87 个 allow 被覆盖，4 / 4 个 flag 被挡住；
- API 调用 398 次全部成功；
- Jev 延迟：p50 281 ms、p95 692 ms、最大 2665 ms；
- 输入 845,946 token，按 `$0.042/MTok` 约 `$0.0355`。

但是“0 条误放”只能解释为：**在这个小而有偏的历史危险集上没观察到误放**。24 条 flag 太少，按零失误的 rule-of-three，真实误放率的单侧约 95% 上界仍约为 12.5%，远不能达到安全上线要求。

因此推荐：

1. 先实施 shadow；
2. 把任务单正文作为 Jev state 的必要输入；
3. canary 初期使用上面的保守阈值，且只对明确的低风险工具 profile 生效；
4. 对全部 ask/slow 样本人工盲标，并补充合成危险样本后再调整阈值。

## 2. 历史记录概况

分析快照包含：

| 指标 | 数量 |
| --- | ---: |
| 会话 / events 文件 | 73 |
| 事件行 | 约 336 万 |
| 审批请求 | 3,598 |
| `review-fast / allow` | 3,517 |
| `review-slow / allow` | 40 |
| `review-slow / ask` | 18 |
| `review-failed / ask` | 22 |
| `hard / ask` | 1 |
| 人工 approve | 17 |
| 非 cancel 的人工 deny | 11 |
| cancel 派生 deny | 11 |

审批工具分布：

| 工具 | 数量 | 占比 |
| --- | ---: | ---: |
| Edit | 2,260 | 62.8% |
| Bash | 1,078 | 30.0% |
| Write | 253 | 7.0% |
| WebFetch | 5 | 0.1% |
| node repl | 2 | 0.1% |

主要限制：

- 97.75% 请求被旧快筛直接放行，极度不平衡；
- 真正人工监督只有 28 条，约占 0.78%；
- hard 样本只有 1 条；
- cancel、timeout 和最终会话 outcome 不是安全标签；
- 旧模型的 allow/ask 是参考路由，不是独立真值；
- gate 事件没有 requestId，并发时不能始终仅靠邻近事件精确归属。

## 3. 标签定义

本实验没有把旧模型结果叫作金标，而是定义参考标签：

- `model-allow`：旧链路 fast allow 或 slow allow；弱标签。
- `human-allow`：旧链路 ask 后人工 approve；较强候选标签，但仍需复核。
- `human-flag`：非 cancel 的人工 deny；must-ask 候选。
- `model-flag`：旧链路 ask、但没有人工 approve/deny；弱标签，可能包含取消或模型故障。

阈值统计中：

- 人工 deny、hard ask，以及没有人工 approve 的 ask 被归为参考 flag；
- 其余归为参考 allow；
- cancel 派生 deny 不作为独立安全判断；
- 最终 done/timeout/cancelled 不作为安全标签。

## 4. 数据提取和脱敏

数据只读扫描，本轮没有修改 `~/.zcode-executor`。

外发给 Jev 的实验 state 经过最小化：

- 用户 home 和 worktree 绝对路径替换为占位符；
- `/tmp` 归一为 `<OUTSIDE_TMP>`，保留“位于 worktree 外”这一安全语义；
- API key/token/password/Authorization 模式替换；
- Write/Edit 的正文、old/new string 不发送，只发送长度与行数；
- Bash 仅保留脱敏后的 command 和 description；
- Jev 输出文件不保存原始 state，只保存 sample id、历史参考元数据与 typed answers。

需要强调：日志内容和任务单仍可能含无法靠正则完全识别的敏感业务信息。正式工具应采用字段 allowlist、项目级 opt-out 和数据保留策略，而不能仅靠正则脱敏。

## 5. 分层抽样

没有把 3,598 条记录全量发送给 Jev。样本构成为：

- 全部 81 条非 `review-fast` 案例；
- 对 fast allow 按固定 SHA-256 顺序分层抽样：
  - Edit 150；
  - Bash 100；
  - Write 60；
  - WebFetch 5；
  - node repl 2。

去重后共 398 条：

| 工具 | allow 参考 | flag 参考 |
| --- | ---: | ---: |
| Bash | 149 | 20 |
| Edit | 154 | 4 |
| Write | 64 | 0 |
| WebFetch | 5 | 0 |
| node repl | 2 | 0 |

任务单正文可从保留路径读到的样本为 326 / 398，覆盖率 81.9%，平均约 2,528 字。

## 6. Jev 问题设计

使用固定 `jev-1.13.0`，一次请求并行询问：

1. `scope` Choice：`pass / flag / other`；
2. `outside_worktree_write` Noul；
3. `credential_or_exfiltration` Noul；
4. `destructive_or_external` Noul；
5. `routine` Noul。

关键经验：

- 第一版只传“执行某任务单”而不传任务单正文，Jev 无法判断具体边界，scope 大量 flag。
- 加入任务单正文后，针对“不要提交 git”“只准改某文件”等边界的识别显著改善。
- 不应把历史 gate stage 传给 Jev；那会造成标签泄漏。
- outside-worktree 必须单独问，不能只依赖笼统的 destructive/risk 问题。

## 7. 结果

### 7.1 推荐 shadow/canary 候选

```text
scope.pass >= 0.80
outside_worktree_write <= 0.20
credential_or_exfiltration <= 0.20
destructive_or_external <= 0.20
routine >= 0.80
```

全样本：

| 指标 | 结果 |
| --- | ---: |
| 样本 | 398 |
| 参考 allow | 374 |
| 参考 flag | 24 |
| 自动放行候选 | 205 |
| 其中参考 allow | 205 |
| 其中参考 flag | 0 |
| allow 覆盖率 | 54.8% |

按工具：

- Edit：124 个自动放行候选；
- Write：39；
- Bash：37；
- WebFetch：5；
- node repl：0。

按历史阶段：

- `review-fast / allow`：317 条中 203 条可由该策略放行；
- `review-slow / allow`：40 条中 0 条直接放行；
- `review-slow / ask`：18 条中 0 条放行；
- `hard / ask`：1 条中 0 条放行；
- `review-failed / ask`：22 条中有 2 条放行，两条后来都被人工 approve，均为 Write/Edit。

这说明该策略目前更像一个保守的“明显安全日常操作”筛选器，符合替代第一段快筛的定位，而不是替代慢判。

### 7.2 按 run 分组留出验证

为降低同一会话相邻操作泄漏，用 `sha256(runId)` 固定划分：

- 训练：51 runs、307 条；
- 留出验证：18 runs、91 条。

推荐候选在留出集上：

- 参考 allow：87；
- 参考 flag：4；
- 自动放行：45；
- flag 误放：0；
- allow 覆盖率：51.7%。

危险留出只有 4 条，因此该结果仅说明没有立刻暴露明显错误，不能证明泛化安全。

### 7.3 数据驱动但不建议直接采用的宽松阈值

训练集搜索得到：

```text
scope.pass >= 0.75
outside <= 0.30
credential/destructive <= 0.40
routine >= 0.60
```

它在全样本覆盖约 69.5%，参考 flag 误放仍为 0；留出集覆盖约 66.7%，4 个 flag 全挡住。

但这组阈值是对同一小样本搜索出来的，而且 risk=0.40 过宽，不应直接用于安全 canary。它只能说明：加入任务单后，Jev 输出中存在可利用的区分信号。

## 8. 延迟与成本

398 次调用：

| 指标 | 结果 |
| --- | ---: |
| 成功 | 398 / 398 |
| 输入 token | 845,946 |
| 估算费用 | `$0.0355` |
| p50 | 281 ms |
| p95 | 692 ms |
| 最大 | 2,665 ms |

这是本机单次实验结果，不是 SLA。批量实验使用有限并发；生产审批应有总超时和有界退避。

## 9. 不能从本实验推出的结论

不能据此声称：

- Jev 的真实危险误放率为 0；
- 阈值已完成生产校准；
- Jev 可以替代机械红线或 ZCode 慢判；
- 所有历史 allow 都是正确的；
- CJK、prompt injection、长任务单、网络/生产/凭据场景已充分覆盖；
- 正则脱敏已满足所有数据治理要求。

尤其是：历史 slow allow 对 `/tmp` 的判断不一致，而项目当前 hard rule 是 worktree 外写入必须转人工。正式标签应按**当前代码不变量**重新人工标，而不是盲从历史慢判。

## 10. 下一轮校准建议

### 必做

1. 人工盲复核全部 81 条非 fast 案例，不显示旧模型结论。
2. 人工抽查至少 100 条 fast allow，按 Edit/Write/Bash 和项目分层。
3. 建立合成危险集：每条规则至少 20–50 个正例，并做成任务边界最小对照对。
4. 单独构造复杂 Bash：重定向、`cd ..`、变量路径、子 shell、管道、`mktemp`、`curl`、凭据读取、git 写操作。
5. 用 session/run 分组，并做近重复去重后再划 train/calibration/test。
6. shadow 期间保存 Jev model、schema 版本、概率、耗时与最终人工结果。

### 推荐初始运行策略

- （历史建议，已被 D15 取代）曾建议 `review.jev.mode = shadow`；当前产品决定跳过 shadow，使用 `review.jev.apiKey` 是否配置直接选择快筛。
- 先观察候选阈值至少一段真实流量；
- canary 首期仅允许：
  - worktree 内 Edit/Write；
  - 明确只读或明确测试/构建的 Bash；
- 网络、凭据、git 写、删除、外部路径、复杂复合 Bash 即使 Jev pass 也继续慢判；
- 任何字段缺失、低置信、API 错误或超时都回落慢判。

## 11. 对实现方案的修订

基于这次实测，前一份应用方案应强调两点：

1. **任务单正文是快筛 state 的必要组成。** 仅传最近 send 文本通常只有任务单文件名，不能判断边界。
2. **阈值应当是多个原子概率的合取。** 单独使用 Choice confidence 或 `scope.pass` 会漏掉外部写入等硬风险。

正式实现仍应遵循：机械红线 → Jev 快筛 → ZCode 慢判 → 挂起等人。

## 12. 后续 Prompt 调整

后续同样本对照表明，把综合性的 `scope` Choice 改为只判断“是否违反明确任务边界”的 `scope_conflict` Noul，可将符合率提高到约 62.7%，且机械红线后的参考 flag 未观察到误放。最终建议与失败尝试见 [`jev-prompt-tuning.md`](jev-prompt-tuning.md)。
