# Spec：闲时投递（off-peak send）

只在本地 `offpeak` 分支上，不推送。决定出处：decisions D20；真机事实：verified.md「闲时任务探针」；
术语：CONTEXT.md「闲时投递」「号」。本文件是这条分支上的规格，和 SPEC.md 冲突时以本文件为准。

## 目标

Claude（工头）能把一件不急的开发任务交给 ZCode 的闲时算力去跑：Coding Plan 订阅免费、不占套餐额度，
开跑时间由服务器决定。验收方式与普通投递完全一样（git diff + 测试）。

另有一项自检：闲时依赖的是 ZCode App 的内部接口，App 一升级就可能变。`doctor` 要能分辨「接口变了」
「暂时不可用」「不适用」，让用户挂在自己的 cron 上及时发现。

用户：派单的 Claude 会话；维护这个工具的人（看 doctor）。

## 行为

### A. `send <id> <正文|-> --offpeak [--task 文件] [--wait] [--timeout 秒] [--stream] [--json]`

1. 前置条件，任一不满足退出码 2，stderr 写原因与怎么办：
   - 会话空闲：没有活着的 runner，队列为空（闲时投递独占空闲会话）；
   - 会话的模型在闲时模型表里（内置文件 `account:<family>-offpeak-idle-plan` 的 `builtinModelIds`）；
   - 凭据文件可读，能解出 JWT 与个人版 Coding Plan key；登录的是团队版 → 「团队版暂不支持」；
   - 不和 `--steer` 同用（用法错，退出码 1）。
2. 当场取号：`POST /ticket {task_id: offPeakId}`，`offPeakId` = `offpeak-<uuid>`，一次投递一个，重取号不换。
   - 3101 → 退出码 2「这个账号没有闲时资格（需要 Coding Plan 订阅）」；
   - 3103 → 退出码 2，带 `next_take_at` 换算成本地时间「额度用完，<时间> 以后可再取」；
   - 网络错、5xx、超时 → 退出码 2「闲时服务暂时不可用」；
   - 其余非 0 业务码或返回形状不对 → 退出码 2，报步骤名、服务器原话、logid，附「闲时接口可能变了，跑
     `zcode-executor doctor --offpeak` 确认」。
3. 取号成功：写 `runs/<id>/offpeak.json`（见 E），入队一项 `{text, task, timeoutSec, offpeak: {offPeakId}}`，
   记事件 `executor.offpeak.taken`，起 runner（同普通 send）。
4. 不带 `--wait`：退出码 0；人读输出 `send: 已取号，排第 N 位（闲时投递 <offPeakId>）`；
   `--json` 在原有字段上加 `offpeak: {offPeakId, ticketId, position}`。
5. 带 `--wait`：排号时间不计入 `--timeout`，计时从回合开跑算起；`--stream` 每次轮询在 stderr 打一行排位；
   回合结束后的退出码与普通 send 相同（0/3/4/5）。

### B. runner 处理闲时队列项

队列头是闲时项时，按顺序：

1. **等号就绪**（不起 app-server）：按 `next_poll_after` 轮询 `/ticket/status`，间隔封顶 60 秒（测试可用环境变量
   压短）；macOS 上整个等待与运行期间挂 `caffeinate -i -w <runner pid>`，其他平台跳过。
   - `queued` → 更新排位；`ready` → 进第 2 步；
   - `expired` / `not_found` → 重取号（见 C）。
2. **开跑**：拉连接（同普通投递）→ 推 `provider/updateAccountConfig`：
   `{revision:"zcode-executor-offpeak:<时间戳>", basedOnZCodeBuiltinRevision:"zcode-builtin:<内置文件 revision>:<sha256(内置文件绝对路径)>",
   providers:{<闲时 providerId>:{access:{type:"zhipu-account", entitled:true}}},
   states:{<闲时 providerId>:{availability:"available", entitled:true, current:true}}}`，回执 revision 不等或推送报错 → 按回合异常处理（回执为 `unchanged` 不算失败）。注意：版本号算错时回执照样是 `received`（CLI 源码原样回显 revision），真实表现是回合报 provider 找不到，所以版本号由 doctor 全链路层兜底；
   → `session/send` 在原参数上加：
   `modelSelection:{providerId:<闲时 providerId>, modelId:<会话模型>, options:{reasoningLevel:<会话思考等级>}}`、
   `modelExecution:{selectionScope:"execution", memoryExtraction:"skip", requestAuth:{apiKey:<JWT>, headers:{Authorization:"Bearer <JWT>",
   "X-Coding-Plan-Api-Key":<key>, "X-Off-Peak-Ticket-ID":<号>}}, subagents:{foregroundModel:"submission", background:"deny"}}`、
   `offPeakTaskId:<offPeakId>`、`offPeakRunType:"init"`（续跑为 `"resume"`）、`toolDenylist` 在会话原有基础上加 `CronCreate`、`OffPeakCreate`。
   记事件 `executor.offpeak.started`。闸门、挂起、插话、超时与普通回合完全一样。
3. **回合结束**：
   - 回合失败且错误码是 `3102` / `3104` / `3001`（号过期、号无效）→ 重取号（见 C），就绪后在同一会话发续跑提示
     「Continue the previous task from where it left off. The run was interrupted (app restart or execution window expired).
     Do not start over; review what has already been done and complete the remaining work.」（照抄 App 原文），
     `offPeakRunType:"resume"`；
   - 其他结局（done / failed / timeout / cancelled / exited）照普通回合结算，写 last.json 与 `executor.result`。
4. **结算**：投递的终局（含 cancel 与重取用尽）对当前号 `POST /ticket/<号>/settle`；失败退避重试 3 次，
   仍失败在 offpeak.json 记 `settleError`，`status` 显示「号 … 未结算」。记事件 `executor.offpeak.settled`。

### C. 重取号

一次闲时投递最多重取 2 次（共 3 个号），就绪过期与运行中号失效共用这个上限。每次重取记 `executor.offpeak.retaken`
（原因、第几个号）。用完 → 投递以 `failed` 结束（退出码 4），reason「闲时号用完了（共 3 个）」，执行副本里的改动保留。
重取时服务器回 3103 等失败 → 同样以 `failed` 结束，reason 带服务器原因。

### D. `cancel <id>`

- 排号中：runner 停止轮询、结算当前号，投递以 `cancelled` 结束；
- 运行中：照现有做法停回合，然后结算。

### E. 状态与显示

`runs/<id>/offpeak.json`（原子写）：`{offPeakId, ticketId, ticketCount, phase: queued|ready|running|done, position,
readyDeadline, activeDeadline, settledAt, settleError, updatedAt}`。不含任何凭据。

`status` 与 `follow` 在闲时投递期间多一行：`闲时：排第 N 位（号 <ticketId>，第 k/3 个号）` / `闲时：运行中（号 …，最晚 <时间> 截止）`；
`--json` 加 `offpeak` 对象（即 offpeak.json 的内容）。

事件：`executor.offpeak.taken|ready|started|retaken|settled`，都不含凭据。

### F. `doctor` 第 ⑤ 项与 `doctor --offpeak`

不带参数的 doctor 在现有 ①–④ 之后加 ⑤；`doctor --offpeak` 只跑 ⑤。四层，全部零额度：

| 层 | 查什么 | 期望 |
| --- | --- | --- |
| 凭据 | 凭据文件能解出 JWT 与个人版 key | 都在 |
| 内置条目 | 内置文件里 `account:<family>-offpeak-idle-plan` | 存在，`access.mode` 为 `off-peak`，`api.baseUrl` 为 `https://zcode.z.ai/api/v1/off-peak/anthropic`，有 `builtinModelIds` |
| 服务器约定 | `GET /ticket/availability`；`POST /ticket/status` 带假号 `1000000000000000000` | `code:0` 且有 `can_take_number`；假号返回 `state:"not_found"` |
| 全链路 | 起 app-server → 推授权 → 建 deferred 会话 → 用假号发一回合 | 回合失败、错误码 `3104`；然后 close |

结论四态：
- `ok`：四层都符合；
- `changed`：形状、路由、业务码、条目、回执 revision、全链路错误码任一不符（HTTP 404 也算）；
- `unavailable`：网络错、5xx、HTTP 429（限流，业务码不是 3103）、超时；凭据文件存在但读不了（权限等）；
- `not-applicable`：没登录、团队版、3101 没资格、HTTP 401/403（JWT 失效，重新登录 App）。

客户端只接受 https 的 origin，或 http 的本机回环地址（测试用）；不跟随重定向（3xx 按 `changed`）。

人读输出一行：`doctor ⑤ 闲时：正常` / `接口变了（<层>：期望 …，实际 …，logid …）` / `暂时不可用（…）` / `不适用（…）`。
另外，App 版本不等于 `OFFPEAK_VERIFIED_APP`（当前 `3.14.1`）时 stderr 多一行提示：「闲时路径只在 App <值> 上真机验证过」，不影响结论。

退出码：`changed` → 1，其余三态不因 ⑤ 变成非 0（不带参数的 doctor 仍按 ①–③ 决定）。`--json` 加
`offpeak: {state, layer, expected, actual, logid, appVersion, verifiedAppVersion}`。

## 技术栈与命令

Node ≥ 22，ESM `.mjs`，零运行时依赖（HTTP 用全局 `fetch`）。

```sh
npm test                          # node --test test/*.test.mjs + 版本同步检查，不碰真机
node --test test/offpeak.test.mjs # 单个文件
node --check lib/offpeak.mjs      # 提交前语法检查
bin/zcode-executor doctor --offpeak --json   # 真机零额度自检
```

## 结构

| 位置 | 层 | 内容 |
| --- | --- | --- |
| `lib/credentials.mjs` | 工作流 | 加 `readOffPeakAuth()`：`{family, jwt, planKey}` 或 `{error}`，只多读 `zcodejwttoken` |
| `lib/offpeak.mjs`（新） | 工作流 | 闲时服务器客户端：`availability / take / status / settle`，fetch 与 origin 可注入；错误分类 |
| `lib/offpeak-provider.mjs`（新） | 协议 | 闲时 provider id、模型表、内置版本号、授权配置与 send 额外参数（纯函数为主） |
| `lib/session.mjs` | 协议 | `send(text, {timeoutMs, extraParams})` 合并额外参数；outcome 加 `errorCode`（只在 failed 时有值）；落盘事件与上抛的错误按值抹 `secrets`（同一份名单也交给 `AppServerClient.spawn`，stderr 转发靠它） |
| `lib/offpeak-run.mjs`（新） | 工作流 | runner 的闲时部分：等号就绪、caffeinate、重取、结算、offpeak.json 读写 |
| `lib/run.mjs` | 工作流 | 只加调用点，不把闲时逻辑写进来（文件已 510 行） |
| `lib/cli/send.mjs` `status.mjs` `follow.mjs` `doctor.mjs` | 外壳 | 见 A、E、F |
| `test/mock-offpeak.mjs`（新） | 测试 | 照 App 自带 mock 网关的状态机写的闲时 HTTP 服务（node:http） |
| `test/mock-appserver.mjs` | 测试 | 记录 updateAccountConfig 与 send 的新参数；剧本可让闲时回合以指定错误码失败 |

测试专用环境变量：`ZCODE_EXECUTOR_OFFPEAK_ORIGIN`（指向 mock 服务）、`ZCODE_EXECUTOR_OFFPEAK_POLL_MS`（轮询封顶）、
`ZCODE_EXECUTOR_NO_CAFFEINATE=1`（测试里不起 caffeinate）。

## 代码风格

照 RULES.md。示意：

```js
// verified.md 2026-09-27：服务器回 {code:0, data}，非 0 业务码带 msg 与 logid
export async function take({ origin, auth, fetchImpl = fetch }, offPeakId) {
  const data = await request({ origin, auth, fetchImpl }, 'POST', '/ticket', { task_id: offPeakId });
  return { ticketId: data.ticket_id, state: data.state, position: data.position ?? null, nextPollMs: (data.next_poll_after ?? 60) * 1000 };
}
```

错误用 `ExecutorError`，message 中文且说清怎么办；details 带 `bizCode`、`httpStatus`、`logid`、`kind`（`changed|unavailable|not-applicable|quota`）。

## 测试策略

`node --test`，不加框架。单测：`offpeak.test.mjs`（客户端对 mock 服务的各业务码与形状）、`providers.test.mjs`（版本号与授权配置纯函数）、
`session.test.mjs`（额外参数、errorCode、事件抹密）、`credentials.test.mjs`（JWT 读取）。
集成：`cli.test.mjs` / `run.test.mjs` 用 mock-appserver + mock-offpeak 跑 `send --offpeak` 的全链路、重取、续跑、cancel、
doctor ⑤ 四态。断言退出码、`--json`、落盘文件、mock 记录；每个落盘文件与事件里都查不到测试用 JWT 与 key。

## 边界

- **一律做**：凭据只进内存、secrets 抹除名单与 JSON-RPC 参数；每个任务跑过 `npm test` 再提交；提交在 `offpeak` 分支上。
- **先问**：改退出码表；动普通投递的既有行为；加任何依赖；往 main 合任何东西。
- **绝不做**：在 `npm test` 里碰真机或真实 `~/.zcode`；把 JWT、key 写进任何文件、日志、事件、输出；推送 `offpeak` 分支；
  在会花额度或取号的脚本里省掉「这次会取号」的提示与 `--yes`。

## 完成标准

1. `npm test` 全绿（现有 438 个用例不减），新增用例覆盖 A–F 每条行为；
2. 真机 `doctor --offpeak` 报「正常」，退出码 0；把内置文件路径指错，报「接口变了」、退出码 1；
3. 真机检查点 6a–6d（PLAN-offpeak.md）按表跑完，结果写进 verified.md；
4. 全部落盘文件、事件、输出里 grep 不到 JWT 与 key。

## 未决

- 挂起多久会让号失效：检查点 6c 的结果决定要不要加「挂起超过 N 分钟主动退回重排」；
- 号没结算会不会挡住下一次取号：检查点 6d。
