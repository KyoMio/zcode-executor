# Jev 前筛配置（`~/.zcode-executor/config.json`）

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

保存后必须收紧权限：

```bash
chmod 600 ~/.zcode-executor/config.json
```

含 key 的配置文件必须由当前 UID 拥有、是普通非符号链接文件且权限不宽于 `0600`，否则命令会报配置错误。删除 `apiKey` 或留成全空白可只走原 ZCode 链；不要找 Jev 环境变量或 mode/shadow 开关。`doctor` 显示新 runner 的审批链，不联网调用 Jev、不显示 key：`review.pipeline` 有 key 为 `['jev','zcode-fast','zcode-slow']`，无 key 为后两项，禁用为 `[]`，配置错误为 `null`。兼容 `fastScreen` 不表示替代原快筛。
