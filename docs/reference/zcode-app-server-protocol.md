<!-- 来源：zcode-acp-server 0.27.3 docs/PROTOCOL.md（https://github.com/william0wang/zcode-acp，Apache-2.0，作者 William Wang）。
     原样复制作为 ZCode app-server 协议参考，2026-09-07。未经本项目改动。 -->

# ZCode JSON-RPC Protocol

This document describes the internal JSON-RPC protocol between zcode-acp-server
and the ZCode CLI.

## 3.12.2 变化（2026-09-18 实测）

> 这一节是本项目加的，不是 zcode-acp-server 原文。协议在 ZCode App 3.12.2 上的变化记在这里；
> 下文原有段落若描述了被这次改动影响的方法，段首会加一句「3.12 起失效，见顶部」，原文不删，留作
> 与老版本对照。完整推导过程见 [`decisions.md`](../decisions.md) D14、[`verified.md`](../verified.md)
> 「3.12.2 直连探针实测」。

**被删的方法**：`workspace/updateProviderRegistry`、`workspace/readState` 都返回 `-32601 Method not found`。
provider 表（哪些 provider、哪些模型、密钥怎么鉴权）改由 app-server 自己从两个文件拼：内置 provider 文件
+ 个人 provider 文件（两词定义见 [`CONTEXT.md`](../CONTEXT.md)）。

**启动**：新版 CLI 自己去找内置 provider 文件（内部函数 `resolveBundledZCodeBuiltinProviderConfig`），
只看两处：`zcode.cjs` 同目录下的 `provider/`，和 `zcode.cjs` 往上五级的 `config/provider/`——后者是源码仓库
的目录层次，打包进 App 后这条路径算出来是磁盘根目录下的 `/config/…`，找不到就报错退出（真实位置是
`<App>/Contents/Resources/config/provider/zcode-builtin.json`）。App 自己拉起 CLI 时用环境变量告诉它这个
位置，我们直接 spawn 子进程时没人告诉它，所以要自己算好两个环境变量传进去：
`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`（内置 provider 文件路径，从 `zcode.cjs` 路径推出）和
`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`（个人 provider 文件路径，我们自己写的一份）。两个都给了，CLI 就原样
采用、不去 CDN 刷新、也不碰用户的 `~/.zcode/v2/provider_config.json`。

**个人 provider 文件的形状**（照 CLI 自带的 legacy 导入函数 `importLegacyCliPersonalProviderConfig` 抄）：

```json
{"schemaVersion":1,"config":{
  "providerConfigRules":{"providerRules":[{
    "providerId":"zcode-executor","providerName":"zcode-executor",
    "config":{"group":"standard-personal",
              "access":{"type":"api-key","apiKey":"<config.json 里的 key>"},
              "api":{"type":"anthropic-messages","baseUrl":"<config.json 里的 baseURL>"},
              "personalModelIds":["GLM-5.3-Flash","GLM-5.3"],"modelOrder":["GLM-5.3-Flash","GLM-5.3"]}}]},
  "modelConfigRules":{"providerModelRules":[],"manualProviderModelRules":[]}}}
```

**`session/create` 的新参数**（strict schema，多传字段直接报错）：

| 字段 | 说明 |
| --- | --- |
| `model` | `{providerId, modelId, options?:{reasoningLevel}}`，取代旧版的 `runtimeModel` |
| `runtimeModel` | 不再接受，带上就报 `Unrecognized key: "runtimeModel"` |
| `thoughtLevel` | 顶层仍要带（实测只传 `options.reasoningLevel` 时 `settings.thoughtLevel.current` 是空的，两处都给最稳） |

GLM-5.3 系列模型 `options.reasoningLevel` 必填，不带报 `Reasoning level is required`。返回值里
`settings.model.available` 就是 app-server 当前认的模型表——原来要另外调 `workspace/readState` 才能拿到。
本插件的等级分配从 config.json 本地算，`doctor` 握手时只拿这张表比对个人 provider 文件里的模型有没有全被认出。

**`workspace/generateText`**：参数 `modelRef` 改名 `selection`，形状与上面的 `model` 一样
（`{providerId, modelId, options?:{reasoningLevel}}`），不带 `selection` 就报
`Unrecognized key: "modelRef"`。

**新反向请求 `interaction/requestProviderRuntimeHeaders`**（zcode.cjs 3.12.2 源码里宿主模式的 headers port
会在模型请求前向客户端要一次运行时头；**检查点 5 真机（2026-09-18）证实 api-key 型 provider 不来这个请求**，
回合与 generateText 都直接用个人文件里的 key；账号型 provider 未验。客户端仍保留内置应答以防万一。params
形状从源码读出，真机没抓到过实例）：

```json
{
  "id": 200,
  "method": "interaction/requestProviderRuntimeHeaders",
  "params": {
    "requestId": "<sessionId>:provider-runtime-headers:<uuid>",
    "sessionId": "sess_...",
    "turnId": "...",
    "workspace": { "workspacePath": "...", "workspaceKey": "..." },
    "modelSelection": { "providerId": "zcode-executor", "modelId": "GLM-5.3" },
    "providerId": "zcode-executor",
    "accountAccess": null,
    "reason": "model-request"
  }
}
```

应答两种形状：

```json
{ "headersApplied": true, "requestAuth": { "apiKey": "...", "headers": { "...": "..." } } }
```

```json
{ "headersApplied": false, "errorMessage": "..." }
```

超时 180 秒未答，回合报 `-32031 Provider runtime headers were not applied before model request attempt`。

**不变的方法**：`session/send`、`resume`、`subscribe`、`stop`、`close`、`list`、
`requestRuntimePreferences`、`interaction/requestPermission`、`interaction/requestUserInput`、
`session/event` 的事件种类都没变——会话生命周期、回合结束判定、闸门那三层不用动。

## Protocol Overview

ZCode communicates over stdio using **line-delimited JSON**. The message format
resembles JSON-RPC, but **does not include the `jsonrpc` field**.

### Message classification

Messages are classified by the presence of `id` and `method`:

| Combination        | Type         | Direction                          |
| ------------------ | ------------ | ---------------------------------- |
| `id` + no `method` | Response     | zcode -> bridge                    |
| `id` + `method`    | Request      | bridge -> zcode or zcode -> bridge |
| `method` + no `id` | Notification | bidirectional                      |

### Request format

```json
{
  "id": 1,
  "method": "session/create",
  "params": {
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    },
    "mode": "yolo"
  }
}
```

### Response format

```json
{
  "id": 1,
  "result": {
    "session": {
      "sessionId": "sess_abc123",
      "title": "your prompt text..."
    }
  }
}
```

### Error format

```json
{
  "id": 1,
  "error": {
    "message": "prompt is running",
    "code": 1308
  }
}
```

### Notification format

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 42,
    "type": "turn.started",
    "payload": {}
  }
}
```

## Session Lifecycle Methods

### `session/create`

Create a new session. Note: the bridge defers this call until a session's
first use — ACP `session/new` returns a local placeholder id and materializes
the backend session (this RPC) on the first prompt / config change / extension
method, so an editor startup that never sends a message leaves no session.

**Request:**

```json
{
  "id": 1,
  "method": "session/create",
  "params": {
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    },
    "mode": "yolo"
  }
}
```

**Response:**

```json
{
  "id": 1,
  "result": {
    "session": {
      "sessionId": "sess_abc123",
      "title": "",
      "traceId": "trace_xyz789"
    }
  }
}
```

### `session/list`

List all sessions.

**Request:**

```json
{
  "id": 2,
  "method": "session/list",
  "params": {
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    }
  }
}
```

### `session/resume`

Resume an existing session.

The sessionId may be a lazy `session/new` placeholder (the editor persists it
and resumes it after a bridge restart). The bridge resolves it before the
backend call: an in-memory or persisted (`acp-lazy-sessions.json`) mapping is
followed to the real backend session — resuming it, or materializing a fresh
empty one if the placeholder was never used. Real ids from `session/list` pass
through unchanged.

**Request:**

```json
{
  "id": 3,
  "method": "session/resume",
  "params": {
    "sessionId": "sess_abc123",
    "workspace": {
      "workspacePath": "/path/to/project",
      "workspaceKey": "/path/to/project"
    }
  }
}
```

### `session/send`

Send a prompt.

**Request:**

```json
{
  "id": 4,
  "method": "session/send",
  "params": {
    "sessionId": "sess_abc123",
    "content": "your prompt text"
  }
}
```

**Response:**

```json
{
  "id": 4,
  "result": {
    "accepted": true
  }
}
```

Sending another `session/send` while a turn is already running is rejected with
JSON-RPC error code `-32010`, message `A prompt is already running for this
session`（2026-09-21 对照 ZCode 源码核实：3.12.2 起直接拒绝，3.11 的排队插话已删除）.

### `session/stop`

Stop the current turn. This is a **request**: it must carry an `id` —
app-server ignores any message without an `id`（2026-09-21 对照 ZCode 源码核实：
3.14.0 与本机 3.12.2 的 zcode.cjs）.

**Request:**

```json
{
  "id": 8,
  "method": "session/stop",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

**Response:** `{}`（result 形状可能另有字段，忽略）。叫停生效后，回合以
`turn.completed`（`payload.resultType: "cancelled"`，见下）结束，而不是
`turn.failed`。

### `session/read`

Read the session state and projection.

**Request:**

```json
{
  "id": 5,
  "method": "session/read",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

**Response:**

```json
{
  "id": 5,
  "result": {
    "projection": {
      "status": "idle",
      "contextUsed": 1234,
      "contextWindow": 32000,
      "totalTokenCount": 5678
    },
    "settings": {
      "mode": { "current": "yolo" },
      "model": { "current": { "modelId": "GLM-5.2" } },
      "thoughtLevel": { "current": "high" }
    },
    "todos": [{ "content": "Implement login", "status": "pending", "priority": "high" }]
  }
}
```

### `session/messages`

Fetch the session's historical messages.

**Request:**

```json
{
  "id": 6,
  "method": "session/messages",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

## Event Stream Subscription

### `session/subscribe`

Subscribe to a session's event push.

**Request:**

```json
{
  "id": 7,
  "method": "session/subscribe",
  "params": {
    "sessionId": "sess_abc123",
    "deliveryKind": "desktop-continuous",
    "includeSnapshot": true,
    "afterSeq": 0
  }
}
```

**Response:**

```json
{
  "id": 7,
  "result": {
    "eventSeq": 42,
    "snapshot": {
      "projection": { ... },
      "messages": [ ... ]
    }
  }
}
```

## Event Types

After subscribing, zcode pushes events via `session/event` notifications:

### `turn.started`

The turn has started.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 43,
    "type": "turn.started",
    "payload": {}
  }
}
```

### `model.streaming`

Model streaming output.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 44,
    "type": "model.streaming",
    "payload": {
      "kind": "text_delta",
      "delta": "this code..."
    }
  }
}
```

`kind` can be:

- `text_delta`: text delta
- `reasoning_delta`: reasoning text delta
- `tool_call`: tool call declaration (caches toolName and input)

### `tool.updated`

Tool status update.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 45,
    "type": "tool.updated",
    "payload": {
      "kind": "scheduled",
      "toolCallId": "call_xyz",
      "toolName": "Bash",
      "input": { "command": "ls -la" }
    }
  }
}
```

`kind` can be:

- `scheduled`: tool scheduled
- `started`: tool started executing
- `progress`: progress update (stdoutTail / stderrTail)
- `result`: tool finished
- `error`: tool error
- `batch`: multiple tools finished in a batch

### `turn.completed`

The turn completed.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 46,
    "type": "turn.completed",
    "payload": {
      "resultType": "success",
      "usage": {
        "totalTokens": 1234
      }
    }
  }
}
```

`payload.resultType` can be（2026-09-21 对照 ZCode 源码核实；非 success 也走
`turn.completed`，不走 `turn.failed`）:

| `resultType` | 含义 |
| --- | --- |
| `success` | 正常结束 |
| `cancelled` | 回合被叫停（`session/stop`） |
| `error_max_turns` | 达到回合数上限 |
| `error_max_budget` | 达到预算上限 |
| `error_during_execution` | 回合执行中出错 |
| `error_max_tool_calls` | 达到工具调用次数上限 |

### `turn.failed`

The turn failed.

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 47,
    "type": "turn.failed",
    "payload": {
      "error": {
        "code": 1308,
        "message": "prompt is running"
      }
    }
  }
}
```

### `session.updated`

Session state update (usage, etc.).

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 48,
    "type": "session.updated",
    "payload": {
      "usage": {
        "inputTokens": 1234
      },
      "contextWindow": 32000
    }
  }
}
```

### Steer lifecycle events

When a user input is steered into (queued behind) a running turn, the backend
emits a pair of lifecycle events (app-server 0.15.2+). The bridge does
not currently translate these — they are tracked as a future enhancement (see
[`BACKLOG.md`](./BACKLOG.md)).

```json
{
  "type": "turn.steerQueued",
  "payload": {}
}
```

```json
{
  "type": "turn.steerDrained",
  "payload": {}
}
```

## Interaction Protocol (Server -> Client)

Requests that zcode actively sends to the bridge.

### `interaction/requestPermission`

Tool permission request.

```json
{
  "id": 100,
  "method": "interaction/requestPermission",
  "params": {
    "requestId": "req_xyz",
    "sessionId": "sess_abc123",
    "toolCallId": "call_xyz",
    "toolName": "Bash",
    "reason": "run command",
    "input": { "command": "rm -rf /" },
    "options": [
      { "optionId": "allow", "kind": "allow_once", "name": "Allow once" },
      { "optionId": "deny", "kind": "deny_once", "name": "Deny" }
    ]
  }
}
```

### `interaction/requestUserInput`

User input request (ExitPlanMode / AskUserQuestion).

**ExitPlanMode:**

```json
{
  "id": 101,
  "method": "interaction/requestUserInput",
  "params": {
    "requestId": "req_xyz",
    "sessionId": "sess_abc123",
    "toolCallId": "call_xyz",
    "schema": { "interaction": "plan_approval" },
    "input": { "plan": "1. Implement login\n2. Implement signup" }
  }
}
```

**AskUserQuestion:**

```json
{
  "id": 102,
  "method": "interaction/requestUserInput",
  "params": {
    "requestId": "req_xyz",
    "sessionId": "sess_abc123",
    "toolCallId": "call_xyz",
    "questions": [
      {
        "question": "Select the files to test",
        "multiSelect": true,
        "options": [
          { "label": "auth.test.ts", "value": "auth" },
          { "label": "user.test.ts", "value": "user" }
        ]
      }
    ]
  }
}
```

### Bridge routing (protocol negotiation)

ZCode `interaction/*` requests are routed to different ACP interaction
mechanisms based on client capabilities:

| Request type                                                  |      Client supports elicitation.form      |              Client does not              |
| ------------------------------------------------------------- | :----------------------------------------: | :---------------------------------------: |
| Tool auth (`interaction/requestPermission`)                   |        `session/request_permission`        |       `session/request_permission`        |
| ExitPlanMode (`interaction/requestUserInput` + plan_approval) | `elicitation/create` (approve/reject form) |       `session/request_permission`        |
| AskUserQuestion (`interaction/requestUserInput`)              |     `elicitation/create` (single form)     | per-question `session/request_permission` |

**Capability detection**: at `initialize` time the client declares support via
`clientCapabilities.elicitation.form`. The server detects it with
`server.supportsElicitationForm()`.

**Reconnect resend**: interaction requests are one-shot and raced across the
clients connected when they fire (first response wins). A client that was
offline at that moment never sees them — so when a client completes
`session/load` / `session/resume` (the reconnect catch-up), the bridge re-sends
that session's still-unanswered interaction requests to it (after a short
delay, so the replay renders first). The re-send joins the existing race: if
another client answers first, the reconnected client receives `$/cancel_request`
and should drop the dialog.

**elicitation form example** (AskUserQuestion):

```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "sessionId": "sess_abc123",
    "message": "Please answer 2 questions.",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "q_0": {
          "type": "string",
          "title": "Select the files to test",
          "oneOf": [
            { "const": "auth.test.ts", "title": "auth.test.ts" },
            { "const": "user.test.ts", "title": "user.test.ts" },
            { "const": "__skip__", "title": "Skip this question" }
          ]
        },
        "q_0_other": {
          "type": "string",
          "title": "↳    or type a custom value (overrides the selection)"
        }
      },
      "required": []
    }
  }
}
```

ACP/MCP elicitation string fields are EITHER an enum (restricted dropdown) OR
free text — the spec forbids a single field that is both. So each question is
rendered as TWO fields: `q_<i>` (a `oneOf`/`anyOf` enum dropdown of the model's
suggested answers, with a trailing "Skip this question" option whose `const` is
the `__skip__` sentinel and whose `title` is the readable label) and
`q_<i>_other` (a free-text companion). On submit, a non-empty `q_<i>_other`
overrides the dropdown (single-select) or is appended to the picked values
(multi-select); selecting "Skip this question" or leaving both blank skips just
that question without cancelling the form.

**elicitation response** (accept/decline/cancel):

```json
{
  "action": "accept",
  "content": { "q_0": "auth.test.ts" }
}
```

**ExitPlanMode elicitation form** — single `feedback` text field; no
approve/reject dropdown. The client's own submit button is the approve action;
typing into the field is the reject action. Submitting with the field empty
approves the plan; submitting with text rejects it and returns the text to
zcode as the decline `reason` (so the agent sees the redirection when it
re-plans). The cancel/decline button is a plain reject with no reason.

```json
{
  "method": "elicitation/create",
  "params": {
    "mode": "form",
    "sessionId": "sess_abc123",
    "message": "Ready to code?\n\n1. Implement login\n2. Implement signup\n\nLeave the box empty and submit to approve; type feedback to reject and redirect.",
    "requestedSchema": {
      "type": "object",
      "properties": {
        "feedback": {
          "type": "string",
          "title": "Feedback",
          "description": "Empty = approve the plan. Anything typed = reject and use this text as the redirection."
        }
      },
      "required": []
    }
  }
}
```

## Extension Methods (0.14.8+)

### `session/fork`

Fork a new session from a checkpoint.

**Request:**

```json
{
  "id": 8,
  "method": "session/fork",
  "params": {
    "sessionId": "sess_abc123",
    "target": { "kind": "latestCheckpoint" }
  }
}
```

### `session/rewind` — removed in 0.16+

`session/rewind` (and `session/rewindCascade`) existed up to app-server
0.15.x. The 0.16 app-server removed them from its RPC dispatch (verified
against 0.16.3: `-32601 Method not found`) — rewind moved to the v4
conversation API (`v4/conversation/fileRewindPreview` and friends), which the
bridge does not speak. The bridge's `session/rewind` /
`session/rewindCascade` ACP extensions and the `/rewind` slash command were
removed accordingly. `session/fork` (branch from checkpoint) remains the
bridge-side alternative.

### `session/goal`

Read / set / replace / clear the goal.

**Request:**

```json
{
  "id": 10,
  "method": "session/goal",
  "params": {
    "sessionId": "sess_abc123",
    "action": "set",
    "objective": "Refactor the auth module"
  }
}
```

`action` can be: `show`, `set`, `replace`, `clear`, `pause`, `resume`

### `session/compact`

Compact the conversation history.

**Request:**

```json
{
  "id": 11,
  "method": "session/compact",
  "params": {
    "sessionId": "sess_abc123"
  }
}
```

### `session/steer` — removed in 0.16+

`session/steer` existed up to app-server 0.15.x. The 0.16 app-server removed
it from its RPC dispatch (verified against 0.16.3: `-32601 Method not found`);
steering moved to the v4 command/conversation API. The bridge's
`session/steer` ACP extension and the `/steer` slash command were removed
accordingly. Queued inputs still surface as `turn.steerQueued` /
`turn.steerDrained` events (see above).

### `session/setMode`

Switch the session mode.

**Request:**

```json
{
  "id": 13,
  "method": "session/setMode",
  "params": {
    "sessionId": "sess_abc123",
    "mode": "build"
  }
}
```

### `session/setThoughtLevel`

Set the thought level.

**Request:**

```json
{
  "id": 14,
  "method": "session/setThoughtLevel",
  "params": {
    "sessionId": "sess_abc123",
    "thoughtLevel": "max"
  }
}
```

## Background Tasks & Sub-Agents

When the model dispatches a sub-agent via the `Agent` (or `Task`) tool, the
backend keeps producing events on the **same session stream** — both while the
sub-agent runs and after the main turn ends. The bridge forwards a curated
subset to the ACP client:

### Synchronous sub-agent (blocking)

The `Agent` tool blocks until the sub-agent finishes. Its internal tool calls
(`Read`, `Bash`, …) arrive as ordinary `tool.updated` events on the main stream
and are forwarded as regular `tool_call` cards. The `Agent` card itself carries
structured metadata in `_meta.subagent` (parsed from the result content):

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call_xxx",
  "status": "completed",
  "_meta": {
    "claudeCode": { "toolName": "Agent" },
    "subagent": {
      "agentId": "agent_73c7c63d-...",
      "tokens": 40904,
      "toolUses": 1,
      "durationMs": 10559
    }
  }
}
```

### Background sub-agent (`run_in_background: true`)

The `Agent` tool returns immediately with a launch acknowledgement (result
content contains `agentId` + `output_file` + "working in the background"). The
main turn then completes, but the backend continues to push the task's
lifecycle on the same stream:

**1. Status changes** — `session.updated` carries a `taskId` and `status`:

```json
{
  "method": "session/event",
  "params": {
    "sessionId": "sess_abc123",
    "seq": 16,
    "type": "session.updated",
    "payload": {
      "taskId": "agent_88a44529-...",
      "toolCallId": "call_orig",
      "toolName": "Agent",
      "status": "running",
      "description": "Read README first heading",
      "outputPath": "/.../output.txt",
      "terminalId": "agent_88a44529-...",
      "startedAt": "2026-07-18T09:06:45.929Z"
    }
  }
}
```

The bridge's session-scoped `BackgroundTaskListener` turns these into a
dedicated ACP tool card (`[background] <description>`) plus status updates:

| Backend event                              | ACP notification                                               |
| ------------------------------------------ | -------------------------------------------------------------- |
| first `session.updated` (status `running`) | `tool_call` (new card, `kind:"other"`, `status:"in_progress"`) |
| `session.updated` (status `completed`)     | `tool_call_update` (`status:"completed"`)                      |

`session.updated` events WITHOUT a `taskId` (e.g. usage updates) are ignored by
the background listener — they remain owned by the turn loop.

**2. Completion notification turn** — when the background task finishes, the
backend auto-triggers a new turn whose `turn.started` carries
`inputSource:"background_task"`:

```json
{
  "type": "turn.started",
  "payload": {
    "inputSource": "background_task",
    "inputVisibility": "model-only",
    "input": "<task-notification>\n  <task-id>agent_...</task-id>\n  <status>completed</status-status>\n  ...\n</task-notification>",
    "turnId": "turn_95197b25-..."
  }
}
```

The background listener forwards that turn's `model.streaming text_delta` as
`agent_message_chunk` so the user sees the background result. The per-prompt
turn loop **defers** this entire turn (drops its events) to avoid double-
forwarding and to keep it from prematurely ending the user's real turn.

### Background Bash (`run_in_background: true`)

The `Bash` tool launched with `run_in_background: true` returns immediately
with a launch acknowledgement (result content: "Command running in background
with ID: exec_…"). Like the Agent sub-agent, the backend keeps pushing the
task's lifecycle on the same stream via `session.updated` events that carry
the originating `toolCallId`:

```json
{
  "type": "session.updated",
  "payload": {
    "taskId": "exec_ac3a5053-...",
    "toolCallId": "call_e282b4ec...",
    "toolName": "Bash",
    "status": "running",
    "pid": 22410,
    "outputPath": "/.../call_...-stdout.log",
    "outputTail": "done\n"
  }
}
```

**Card reuse, not duplication.** Unlike an Agent sub-agent (which mints a fresh
`bg_*` card), a background Bash task **reuses the launch card** — the very
terminal card the dispatcher created when `Bash` was scheduled. This keeps the
lifecycle on a single card instead of producing a duplicate `[background]` card
that the editor would show alongside the closed launch card.

The mechanism:

1. **Launch turn** — the dispatcher tags the `ToolCallNew`/`ToolCallUpdate`
   with `background: true` (threaded from the cached `input.run_in_background`
   flag) and, on the launch `result`, **skips `terminal_exit`** so the launch
   card stays `in_progress`. It seeds an empty marker in `terminalSentData`
   for the `toolCallId` — this is the signal the background listener uses to
   recognise "this is a tracked launch card".
2. **Lifecycle (`session.updated`)** — the `BackgroundTaskListener` resolves
   the `toolCallId`, sees it in `terminalSentData`, and routes status updates
   back to the launch card. On `status:"completed"`, it emits the final
   `outputTail` via `terminal_output` (iff launch text wasn't already streamed)
   and closes the terminal UI with `terminal_exit` (exit code 0, or 1 on
   `failed`), then clears the `terminalSentData` entry.
3. **Fallback** — if the `session.updated` lacks a `toolCallId`, or the
   `toolCallId` is unknown to `terminalSentData` (sub-agent case), the listener
   falls back to minting a fresh `bg_*` card — the Agent sub-agent path above.

| Backend event                                             | ACP notification (background Bash)                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| first `session.updated` (status `running`)                | `tool_call_update` on the launch card (`status:"in_progress"`)                                                             |
| `session.updated` (status `completed`, with `outputTail`) | `terminal_output` (final output, if not already streamed) + `tool_call_update` with `terminal_exit` (`status:"completed"`) |
| `session.updated` (status `failed`)                       | `tool_call_update` with `terminal_exit` (`status:"failed"`, exit_code 1)                                                   |

`session/cancelBackgroundTask` for a background Bash task additionally emits
`terminal_exit` with `_meta.backgroundTask.cancelled = true` so the terminal
UI closes on cancellation.

### `session/cancelBackgroundTask`

Cancels a background task. The bridge additionally marks the corresponding ACP
tool card as `failed` with `_meta.backgroundTask.cancelled = true`.

| ZCode CLI version | session/subscribe | Extension methods       | Notes                                                                                                                                                        |
| ----------------- | ----------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| >= 0.16.0         | Supported         | All except steer/rewind | `session/steer`, `session/rewind`, `session/rewindCascade` removed upstream (v4 API); bridge dropped its passthroughs and `/steer`, `/rewind` slash commands |
| >= 0.15.0         | Supported         | All supported           | Full functionality                                                                                                                                           |
| >= 0.14.8         | Supported         | Partially supported     | workspace/* unavailable                                                                                                                                      |
| 0.14.5 ~ 0.14.7   | Not supported     | Not supported           | Incompatible with this project                                                                                                                               |

## Additional backend methods (not wired into the bridge)

The backend exposes more RPC methods than the bridge uses (sub-agent listing,
event pull, session usage/close, automation, workspace config, MCP/plugins).
These have no ACP-side counterpart yet. See [`BACKLOG.md`](./BACKLOG.md) for
the full list and which are candidates for future support.

## Multi-client semantics (remote access)

When `ZCODE_ACP_REMOTE=1` is enabled, the bridge accepts additional ACP clients
over WebSocket (via the machine-level hub) alongside the stdio editor. All
clients share the same backend sessions; the rules below define how one agent
serves many clients.

| Aspect                                             | Behaviour                                                                                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/update` notifications                     | Broadcast to every connected client. A client that never saw a session (e.g. an editor receiving a phone-created session) simply ignores the update.                                     |
| `session/request_permission`, `elicitation/create` | Sent to every client; the **first response wins**. Losing requests are aborted, which emits `$/cancel_request` so the losing client dismisses its dialog and replies `RequestCancelled`. |
| Capabilities                                       | OR-merged across clients at each `initialize` (booleans union, `_meta` shallow-merged). A capability any client declares is enabled for interaction routing.                             |
| Concurrent `session/prompt` on one session         | Serialized by the per-session preempt lock — identical to the single-client case; a second client's prompt preempts or queues the same way.                                              |
| `session/cancel`                                   | Affects the shared turn regardless of which client sent it.                                                                                                                              |
| Process lifetime                                   | Follows the stdio client: when the editor disconnects, the bridge (and every remote attachment) exits. Remote clients never extend the lifetime.                                         |

Transport details (hub discovery API, token auth, tunnel notes) live in the
[Remote Access](../README.md#remote-access) section of the README.
