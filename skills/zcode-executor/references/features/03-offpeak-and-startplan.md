# 03 · 闲时投递与 Start Plan

> 完整操作手册在 [../offpeak-and-start-plan.md](../offpeak-and-start-plan.md)；本文是 Feature Map 视角的行为契约与 Gotchas。

## 闲时投递（--offpeak）

用 Coding Plan 订阅的免费闲时算力跑回合，不占套餐额度；代价是先取号排队，开跑时间由服务器决定、无法预估。

**行为契约**：

1. 取号后立即返回（「已取号，排第 N 位」）——发闲时投递**别带 `--wait`**，后台 `follow` 等结果。
2. 免费取号每天约 3 次、本地零点重置；一次投递最坏用掉 3 个号（号过期由 runner 自动重取）。**别为试探反复取号**。
3. `--timeout`（默认 3600s）从开跑算起且**挂起时间也算**——闲时回合要审批的给宽一点。
4. 会话必须空闲（无 runner、队列为空）：新任务另开一条会话配专用执行副本；返工在原会话等上次投递结束后发。
5. `--offpeak` 与 `--start-plan`、`--steer` 互斥。排号期 `cancel` 再投会重新取号排队——方向小改等开跑后 `--steer`。

**事故恢复**：

- `status` 出现「投递 … 没收尾，runner 已不在」→ `send <id> --offpeak --resume`（不重新取号，不带正文/task）。
- `cancel` 任何阶段都自动结算号。

## Start Plan（--start-plan）

让**这一回合**吃 Start Plan 额度，其余与普通投递一致：立刻开跑、无号、不独占会话。

**JWT 机制（decisions D21）**：Start Plan 的凭据由 `zcode app-server` 发反向请求 `interaction/requestProviderRuntimeHeaders` 向 `zcode-executor` 索取，后者在内存里返回解密后的 `zcodejwttoken`（`{headersApplied: true, requestAuth: {apiKey: <JWT>}}`，无额外头）。安全边界：**JWT 只进内存与 JSON-RPC 应答，绝不落盘**；错误文案与返回值都不带凭据值。接口与键名是 App 私有实现——改了这条路就断，普通派单不受影响。

## Gotchas

1. **`quota` 是零额度查询**，不取号——每个对话首次派单前跑一次告知用户即可；「不适用」（团队版/未登录）后这个对话别再提闲时。
2. **退出码 1「接口变了」**：跑 `doctor --offpeak` 拿结论转告用户，本次改普通投递。
3. **退出码 4 结束时先看 `status`**：有「没收尾」行用 `--resume`，没有按普通异常处理——改动还留在执行副本里，不会丢。
4. **排号期挂起要人审批**：审批久拖会不会让号失效未验证过——挂起尽快应答。
5. cron 健康检查一天一次足够：每次自检在会话库留一条 App 看不到的记录。
