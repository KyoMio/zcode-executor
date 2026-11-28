# 04 · 观察面板与 DSH 插件

## watch --json 行协议

`watch` 只读、常驻：盯登记簿里所有会话，某条快照有变化就输出一次**完整快照**（单行 JSON）。这是 Claude Code 观察面板 mod 与 `dsh-plugin/` 唯一的数据来源——插件与 CLI 的耦合仅此一条行协议。

**行为契约**：

1. 快照是完整的不是增量的——消费方不需要合并状态，直接整条替换。
2. 退出条件全以 0 退：stdout EPIPE（读方断开）、父进程没了（ppid 变 1）、SIGTERM/SIGINT。不靠 stdin。
3. 单条会话读文件出错只跳过这条（stderr 一行 `watch: <id> <原因>`）；登记簿连续 10 轮读不出才以 1 退出。
4. 轮询参数走环境变量（`ZCODE_EXECUTOR_WATCH_POLL_MS` 等，默认 200ms/2000ms idle/300ms debounce），不是 CLI 旗标。

## Claude Code hooks（hooks/）

**红线：hooks/ 运行环境没有完整 Node 能力，绝对禁止 import 根 `lib/`（含 `lib/errors.mjs`）**——静态扫描（check-boundaries）直接红；共用的小逻辑保持自包含在 `hooks/` 内。hooks 与后端的通信只有 stdio 单行 JSON。

## dsh-plugin/

与 CLI 唯一耦合是 spawn `watch --json` 并逐行消费。**不得 import 根 `lib/`**（同一条静态红线）。插件自身的 SPEC 与 mockup 在 `dsh-plugin/` 目录内自治。

## Gotchas

1. **输出终端控制字符会被中和**（审计 D9-①）：执行端可控文本（挂起回显、流式回复）里的控制字符换成可见转义，但换行/制表保留，`--json` 解析回来一字不差——消费方不要再做二次转义。
2. **watch 的 phase 文本是中文人读形**（执行中/挂起/执行进程已中断）——机器消费用 `phase` 字段原值，别解析中文。
3. **`watch` 快照不含 `proofSummary`**：`proofSummary` 只在 `status --json`、`runs/<id>/last.json` 与 `send`/`follow` 结束摘要里提供；`prematureStop` 或失败命令是打回信号，没有 `proof.json` 时为 `null`（不打扰）。
