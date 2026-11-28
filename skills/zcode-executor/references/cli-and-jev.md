# Jev 前筛配置与审批链（zcode-executor 详细参考）

[Jev](https://docs.typesafe.ai/introduction) 是 TypeSafe 的结构化判断模型：返回概率而不是生成解释。它**不执行任务、不替代原 ZCode 快筛**，只是在证据足够时让动作提前通过。在红线和 `allow_once` 检查之后，审批链是三档：

```text
红线与 allow_once 检查通过后
  → Jev 前筛：明确通过就放行；其余进入下一层
  → ZCode 快筛（默认 fast + low）：通过就放行；未通过进入下一层
  → ZCode 慢判：放行或转人工
```

前筛检查五类风险：任务边界冲突、工作目录外写入、凭据暴露或敏感数据外发、破坏性或外部副作用、与任务无关的操作。五项概率均不高于 `0.20` 才可能提前通过——这是筛选阈值，不是安全保证。Jev 当前总预算 10 秒，独立于 ZCode 的 `review.timeoutMs`；通过能省掉后续审批调用，未通过则多一段串行等待，实际速度与费用收益取决于通过率。

## 1. 配置 API key

从 [TypeSafe 官方站点](https://typesafe.ai/) 获取自己的 key（参考[官方快速开始](https://docs.typesafe.ai/introduction/quickstart)）。它与 ZCode 的 provider key 是两套独立凭据，不需要修改 ZCode App 的配置。编辑 `~/.zcode-executor/config.json`（配了 `ZCODE_EXECUTOR_HOME` 就编辑那个目录下的），**已配置的字段要合并不要整份覆盖**——保留 `allowedRoots`、provider 等其他设置：

```json
{
  "review": {
    "jev": {
      "apiKey": "jev_请替换为你自己的密钥"
    }
  }
}
```

**不要**把真实 key 放进命令参数、shell 环境变量、任务单、聊天消息、提交进仓库的示例、issue 或日志——只此一处叮嘱，后面不再重复。上面的值只是占位符，真实 key 不要求这个前缀。没有环境变量 fallback，也没有 mode/shadow 之类的开关。

### proxy（可选）

Jev 端点直连不通时，在同一个 `review.jev` 对象里加 `proxy`。接受 `http://` 或 `https://` 地址，可带 `user:pass@` 凭据（以 Basic `Proxy-Authorization` 发送）；只有 Jev 的 HTTPS 请求经该代理的 CONNECT 隧道发出，ZCode 派单链路和 app-server 的流量不受影响。不支持 `socks5://`；未配 `review.jev.apiKey` 时该字段不生效：

```json
{
  "review": {
    "jev": {
      "apiKey": "jev_请替换为你自己的密钥",
      "proxy": "http://127.0.0.1:7890"
    }
  }
}
```

### review.jev.model（可选）

模型 ID 或别名，默认 `jev-latest`。前筛的阈值和 schema 是按 `jev-1.13.0` 调的；钉成版本号可回到当时的旧行为。

## 2. 保护配置文件

文件必须已存在，随后收紧权限（自定义配置目录就替换路径）：

```bash
chmod 600 ~/.zcode-executor/config.json
```

配置了 `review.jev.apiKey` 后，`config.json` 必须由当前 UID 拥有、是普通非符号链接文件、权限不宽于 `0600`（仅属主可访问），否则 zcode-executor 拒绝读取、报配置错误。key 只存在这个文件里，只作为 Jev Authorization 发出，绝不复制进事件、挂起状态、runner 日志或 app-server 进程。

## 3. 验证与生效

```bash
zcode-executor doctor --json
```

审批开启且 key 已配置时，输出的 `review` 段应包含：

```json
"review": {
  "enabled": true,
  "fastScreen": "jev",
  "jevConfigured": true,
  "pipeline": ["jev", "zcode-fast", "zcode-slow"]
}
```

`doctor` 不联网调用 Jev，所以它只确认配置与所选链路，**不验证 TypeSafe key 是否有效、账户额度或网络连通性**。`fastScreen` 是兼容字段，不表示 Jev 替代了原快筛。`review.pipeline` 的四种取值：有 key 为 `['jev','zcode-fast','zcode-slow']`，无 key 为 `['zcode-fast','zcode-slow']`，审批禁用为 `[]`，配置失败为 `null`。

配置由新启动的 runner 读取，已有 runner 不热更新——等当前 runner 退出后再投递才会生效。实际审批记录在 `executor.gate.preScreen`：`pass / flag / error / skip` 加筛选后的诊断信息，不记 key 或完整 Jev state。

## 本地 skip 与回退行为

- Write/Edit/MultiEdit 的正文不发给 Jev，这类动作目前直接本地跳过前筛；缺少有效意图、必要输入被截断、凭据无法可靠脱敏时也跳过，**不产生 Jev HTTP 请求**。命令复杂本身不是跳过理由。
- Jev 标记风险（flag）、超时、网络错误或响应非法，都回到原 ZCode 快筛——不是直接拒绝、也不是强制慢判。ZCode 快筛调用失败仍转人工。
- `review.enabled:false` 关闭包括 Jev 在内的**全部**模型审批；红线仍生效，其余审批请求转人工。只想停用 Jev 就删除 `review.jev.apiKey`（或留成全空白），保留原 ZCode 快筛与慢判链。
