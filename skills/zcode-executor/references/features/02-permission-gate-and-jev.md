# 02 · 审批闸门与 Jev 前筛

## 三级审批链

```
permission.requested → 红线硬规则（本地零成本）
                     → Jev 前筛（可选，apiKey 配置启用）
                     → ZCode 快筛（fast 档）
                     → ZCode 慢判（review.thought，默认 low）
                     → 仍不确定 → 挂起转人工（pending.json + 退出码 5）
```

## 不变量（违反即 bug）

1. **裁决器只产出 `allow` 或 `ask`，绝不静默 `deny`**——拒绝动作只能由人工 `deny` 命令触发。模型给 `deny` 一律降级为 `ask`。
2. **任何解析异常/超时一律安全降级为 `ask`**（写 `pending.json`）。解析器容忍 Markdown 加粗（`**允许**`）、前后空行与常见中文同义结论行；「Y 和 N 都出现」当 N——默认落到更谨慎的那边。
3. **红线硬规则**先于一切模型调用：写执行副本外路径命中（`../` 越界、符号链接穿透也算），但系统临时目录（`/tmp` 本体，非链接穿透）在白名单内。
4. **tool-summary 补全 `inputOmitted` 参数时严格按同名工具匹配**——绝不跨工具借用（3.14.1 真实 bug：`Read` 偷走过 `Write` 的参数）。

## 人工应答

- `approve <id>` / `deny <id>` / `answer <id> <文字>`：应答写 `answer.json`（带 requestId 防串答），runner 轮询拾取继续回合。
- 陈年 `answer.json`（无 requestId）不会被答——防止应答错位打到新挂起上。
- 已挂起的会话再 `send --wait` 立刻退出码 5，不重复等待。

## Jev 前筛

- 配置：`~/.zcode-executor/config.json` 的 `review.jev.apiKey`（非空白即启用）。**key 绝不进命令行参数、环境变量、任务单或仓库文件**；配置文件必须 `chmod 600`（权限宽于 0600 直接报配置错误）。
- 行为：pass 直接 allow 并结束审批（ZCode 零调用）；flag/error/skip 回落原 ZCode 链。正文省略、缺有效意图或必要输入截断时**本地 skip 不发 HTTP**（零成本保护）。
- 没有环境变量 fallback，没有 mode/shadow 开关。`review.enabled:false` 关闭全部模型审批（此时 runner 连付费请求都不发）。

## Gotchas

1. **排障先读 `error.data.details`**——模型调用报错的真原因（方法名/错误码）在 details，顶层 message 常为套话。
2. **挂起不是危险判据也不是放行依据**——先核对任务单与已有授权，能确认的按规则应答；越界或无法确认带依据转用户。
3. **复杂命令本身不是 Jev skip 的理由**——skip 只看输入完整性，不看命令复杂度。
4. **`createComplete` 超时先 `cancelGenerateText`（operationId 一致）再抛**——孤儿 generateText 会继续烧钱。
