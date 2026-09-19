# TypeSafe System One / Jev 官方用法调研

> 查证日期：2026-09-18
> 范围：仅采用 TypeSafe 官方文档、官方博客、官方 SDK 文档/源码入口和官方法律文件。价格、模型别名、限流属于会变化的在线事实，集成前应重新核对 [`models`](https://docs.typesafe.ai/models) 页面或 `GET /v1/models`。

## 结论摘要

- **Jev 不是文本生成模型，而是封闭答案空间的快速决策模型。** 调用方发送一个 `state` 和一组 typed questions；模型返回 Choice、Score、Noul 三种结构化答案和概率，业务代码继续掌握分支、权重、阈值及人工升级逻辑。它不适合生成说明文字、代码或任意字符串。[System One](https://docs.typesafe.ai/concepts/system-one)；[如何构建工作流](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
- **同一状态需要的独立问题应放进一次请求。** 每个问题独立看同一 `state`，并行求值；多问通常几乎不增加响应时间，只增加问题本身的少量输入 token。问题之间若存在真实数据依赖（后题必须使用前题结果来取数、构造状态或选候选项），才拆成第二次调用。[Primitives](https://docs.typesafe.ai/primitives#ask-multiple-questions-together)；[Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)
- **当前稳定模型是 `jev-1.13.0`，SDK 默认别名为 `jev-latest`。** 别名会随发布移动；若已针对某版校准阈值，应 pin 版本号，并记录响应中的实际 `model`。[Models](https://docs.typesafe.ai/models#aliases)
- **官方当前标价为输入 `$0.042 / MTok`，输出免费。** 厂商发布博客声称端到端响应时间为 **70–500 ms**，但没有把它定义为 typical、p50/p95 或 SLA；博客还明确其公开 eval 多从美国西海岸笔记本运行，输入长度和网络位置会影响实际延迟。[Models](https://docs.typesafe.ai/models#current-models)；[官方发布博客](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- **Jev 1.13 的强项是快速、原子、语义型判断；弱项是数学/计数、日期比较、多跳间接推理、长而无关的上下文、对抗性输入和文本生成。** 精确计算、计数、日期运算、结构不变量均应留在代码里。[Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## 1. HTTP 请求与响应契约

### 1.1 Endpoint 与认证

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

官方 HTTP 参考见 [API reference](https://docs.typesafe.ai/api#evaluation-endpoint)。API key 可由官方 Console 创建；SDK 默认读取 `TYPESAFE_API_KEY`。[Quick start](https://docs.typesafe.ai/introduction/quickstart#call-it-the-api)

### 1.2 顶层请求

可直接执行的官方 cURL 形态：[Quickstart: Sample cURL command](https://docs.typesafe.ai/introduction/quickstart#sample-curl-command)

```bash
curl -X POST https://api.typesafe.ai/v1/systemone \
  -H "Authorization: Bearer $TYPESAFE_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{
  "state": "This task will delete a remote branch.",
  "model": "jev-1.13.0",
  "questions": {
    "destructive": {
      "type": "noul",
      "instructions": "Would executing this task cause a destructive or irreversible effect?"
    }
  }
}
EOF
```

完整请求结构示例：

```json
{
  "state": {
    "task": "用户提交的任务文本",
    "risk": { "has_shell": true, "touches_credentials": false }
  },
  "model": "jev-1.13.0",
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Which review route should this task take?",
      "criteria": {
        "allow": "Safe to execute automatically",
        "human": "Requires a human decision"
      }
    },
    "destructive": {
      "type": "noul",
      "instructions": "Would executing this task cause destructive or irreversible effects?"
    }
  }
}
```

顶层三个必需字段为：[API request body](https://docs.typesafe.ai/api#request-body)

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `state` | string / object / array | 待判断的内容；可传包含命名字段、记录和数值等上下文的 JSON 结构，但模型能力面仍是对自然语言文本的判断，不支持图像/音频/视频。建议优先对象，以命名字段表达关系。[State](https://docs.typesafe.ai/concepts/state) |
| `model` | string | HTTP API 必填。可用移动别名 `jev-latest` 或固定版本 `jev-1.13.0`。 |
| `questions` | `map<string, Question>` | key 由调用方命名；响应在同 key 下返回答案。**问题 ID 不送给底层模型，也不参与推理**，因此完整语义必须写在 `instructions` 里。 |

`instructions` 以及 Choice/Score 的描述可用 string、object 或 array；结构化字段名并非保留字，但也会被模型看到。对象适合表达 `what`、`not_for`、`examples` 等边界。[Advanced structure](https://docs.typesafe.ai/primitives/advanced)

### 1.3 顶层响应

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "route": {
      "type": "choice",
      "choice": "human",
      "probabilities": { "allow": 0.12, "human": 0.88 },
      "confidence": 0.76
    },
    "destructive": {
      "type": "noul",
      "noul": 0.91
    }
  },
  "usage": {
    "input_tokens": 312,
    "output_tokens": 48
  }
}
```

- `answers` 与 `questions` 使用相同 question ID；每个答案的 `type` 与问题一致。
- 按 HTTP v1 参考，`usage.input_tokens` / `usage.output_tokens` 是 required；但 Python SDK 为前向兼容把二者声明为可空并描述为“when reported”。集成应容忍缺失 token count；当前定价仅输入 token 计费。[API response body](https://docs.typesafe.ai/api#response-body)；[Python SDK Usage](https://docs.typesafe.ai/sdk/python/api/types/responses#typesafe_sdk.Usage)
- 模型别名可能移动。[Models aliases](https://docs.typesafe.ai/models#aliases) 明确说响应 `model` 报告实际版本化 ID，但 [API 示例](https://docs.typesafe.ai/api#response-body) 与 [Quickstart 示例](https://docs.typesafe.ai/introduction/quickstart#response-body) 仍返回 `"jev-latest"`。在真机验证前，不保证它一定是版本 ID；集成应原样记录该字段，并另记请求时使用的模型名。

## 2. 三种原语

### 2.1 Choice：封闭集合中选一项

请求：

```json
{
  "type": "choice",
  "instructions": "Which route should handle this task?",
  "criteria": {
    "automatic": "May proceed without human review",
    "human": "Needs a human decision",
    "other": "None of the listed routes fits"
  }
}
```

响应字段：

```json
{
  "type": "choice",
  "choice": "human",
  "probabilities": {
    "automatic": 0.03,
    "human": 0.95,
    "other": 0.02
  },
  "confidence": 0.91
}
```

关键约束：[Choice](https://docs.typesafe.ai/primitives/choice)

- `criteria` 是 `option -> description | null` 的 map；`choice` 是最高概率选项，`probabilities` 覆盖全部选项且和为 1。
- 最多 **255 个选项**。候选集合可能不完备时应显式提供 `other` / `none_of_the_above`，不要迫使模型在错误选项中硬选。
- Choice 是**相对选择**。不能把 Choice 某项概率与另一个等价 Noul 当作必然相同的量。

### 2.2 Score：沿有序语义等级评分

请求：

```json
{
  "type": "score",
  "instructions": "How risky is this task to execute automatically?",
  "criteria": [
    "Read-only and easily reversible",
    "Writes project files but can be reviewed and reverted",
    "Destructive, irreversible, or affects credentials/external systems"
  ]
}
```

响应字段：

```json
{
  "type": "score",
  "score": 1.6,
  "legend": {
    "0": "Read-only and easily reversible",
    "1": "Writes project files but can be reviewed and reverted",
    "2": "Destructive, irreversible, or affects credentials/external systems"
  },
  "probabilities": { "0": 0.05, "1": 0.3, "2": 0.65 },
  "confidence": 0.78
}
```

关键约束：[Score](https://docs.typesafe.ai/primitives/score)

- `criteria` 至少 2 级、最多 **10 级**；数组位置从 0 开始就是等级编号。
- `score` 是 `Σ(level × probability)`，可能落在等级之间；不同概率分布可能产生相同 score，因此不能只看 score，应一并看 `probabilities` 和 `confidence`。
- 每级应描述可辨认的具体情形，而非只写“低/中/高”或数字。每个 Score 只衡量一个维度；多维复杂判断应拆题后由代码归一化、加权。
- Jev 1.13 的数值校准较弱，不能把两个等级间的插值当作现实世界精确数值。[Jev 1.13: Math using score](https://docs.typesafe.ai/model-jaggedness/jev-1.13#math-using-score)

### 2.3 Noul：是/否的“是”概率

请求：

```json
{
  "type": "noul",
  "instructions": "Would this task write outside the approved worktree?",
  "criteria": {
    "true": "Execution may modify a path outside the approved worktree",
    "false": "All writes stay inside the approved worktree"
  }
}
```

响应：

```json
{ "type": "noul", "noul": 0.91 }
```

关键约束：[Noul](https://docs.typesafe.ai/primitives/noul)

- `noul ∈ [0, 1]`，表示答案为“是”的概率；接近 0.5 是 yes/no 两边接近，而不是“程度中等”。
- Noul **没有独立的 `confidence` 字段**。判断明确程度可看距 0.5 的距离，但业务阈值必须结合风险和自己的验证集决定。
- `criteria.true` / `criteria.false` 可选，用于明确边界。推荐让高值始终对应自然语义上的“是”，避免 true/false 反转。

## 3. 概率、confidence 与自动化闸门

- Choice/Score 的 `confidence` 是由完整概率分布形状计算出的 0–1 统计量：分布越集中越高，越平坦越低；它不是 top probability 的别名。Noul 没有单独 confidence。[Confidence](https://docs.typesafe.ai/confidence#confidence-is-derived-from-the-probabilities)
- 官方建议三路：高置信自动执行，中置信请求确认/补信息/标记复核，低置信不执行并转人或换系统；阈值应随动作风险变化，而不是全系统一个常量。官方称 0.5 floor 可捕捉模型自报的真正不确定，但这不是所有业务的通用自动放行阈值。[Confidence](https://docs.typesafe.ai/confidence#three-paths-for-using-confidence-in-your-code)
- **高 confidence 不等于事实保证。** 官方 Score 文档明确：confidence 1.0 只表示概率全压在一个等级，不保证答案正确。[Score: Reading a Score](https://docs.typesafe.ai/primitives/score#reading-a-score)
- 官方的校准主张仍应在本项目真实任务上实测。尤其 CJK 并非主要训练语言，安全审批阈值不能直接抄示例数字。[Models: Language support](https://docs.typesafe.ai/models#language-support)
- 不要假设独立问题之间满足算术恒等式：`P(question)` 与 `1-P(negated question)` 可能不相等；同义 Choice 与 Noul 也可能不同。每个业务语义固定一种问法，再基于该问法校准阈值。[Jev 1.13: structural invariants](https://docs.typesafe.ai/model-jaggedness/jev-1.13#common-sense-structural-invariants)

## 4. 批量问题与成本/延迟

### 官方语义

- 一次请求是**一个 state 对一个或多个 questions**；所有问题看到相同 state、相互独立、并行求值。[State](https://docs.typesafe.ai/concepts/state)
- 同一 state 的所有独立判断，包括后续某分支才可能用到的 speculative questions，宜一次 fan-out，之后由代码忽略无关答案。[Speculative fan-out](https://docs.typesafe.ai/patterns/fan-out)
- 同批问题无法看到同批中其他答案；若 B 真正依赖 A 的输出才可构造，只能先调用 A，再由代码构造第二次请求。[Primitives: dependent questions](https://docs.typesafe.ai/primitives#when-one-question-depends-on-another)

### 官方实测例子（不是普遍 SLA）

官方 cookbook 对约 53,777 字符 GDPR 文本同时问 13 题，报告一批调用平均 `$0.000497 / 0.27s`，13 次单题顺序调用平均 `$0.006090 / 2.71s`，即 **12.2× 更便宜、10.0× 更快**，五次重复中未发现 batching 改变答案的效应。该结果取决于文档占 token 主体、单题调用顺序执行等实验条件，不应外推为固定倍率。[Parallel questions](https://docs.typesafe.ai/cookbooks/parallel_questions#the-only-difference-cost-and-speed)

### 数量限制

官方没有给出独立的“每请求最多 N 个 questions”常数；限制来自共享 token budget。Choice 自身最多 255 options，Score 最多 10 levels。[Choice](https://docs.typesafe.ai/primitives/choice#good-practice-ask-more-than-one-question-per-call)；[Score](https://docs.typesafe.ai/primitives/score#request-structure)

## 5. 模型、价格、延迟与输入限制

以下为查证日官方 [Models](https://docs.typesafe.ai/models#current-models) 页面内容：

| 项目 | 官方当前值 |
| --- | --- |
| 稳定版本 | `jev-1.13.0` |
| 别名 | `jev-latest -> jev-1.13.0`；`jev-preview -> jev-1.13.0`（当前无独立 preview） |
| 价格 | 输入 `$42 / Btok`，即 `$0.042 / MTok`；输出 token 免费 |
| 速率限制 | `250,000 tokens/s` 与 `1,200 requests/min`，超任一返回 429；官方警告这些数值会动态调整且可能不预告 |
| Context | 每请求总计 64k tokens；另有 `state + 最长单题` 32k 限制 |
| 输入 | 仅处理文本语义；state 顶层可是 string、JSON object 或 array，结构化 JSON 可含标准 JSON 标量；不支持图像、音频、视频、二进制，数值计算也不可靠 |
| 语言 | 英语准确率最好；CJK 可接收但准确率较低，必须用自身数据验证并关注 confidence |

> **文档不一致提示：** [`Primitives`](https://docs.typesafe.ai/primitives#ask-speculative-questions) 仍写“约 32,000 tokens、state 与 questions 共享”，而更新更具体的 [`Models`](https://docs.typesafe.ai/models#current-models) 写“64k 总预算，且 state + 最长问题为 32k”。集成应按更严格的 32k 单题路径约束预防失败，同时以服务端验证结果为准，不把约 150k 英文字符换算当硬契约。

官方发布博客称 TypeSafe 端到端响应时间为 **70–500 ms**，并称同类 System One query 可比 frontier LLM 快 40–200×；博客同时披露测速通常从美国西海岸进行、短而密集输入对演示有利。这些是厂商测量/主张，不是 API 文档中的 SLA 或 p95 保证。[官方博客：Speed](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

模型列表可调用：

```bash
curl https://api.typesafe.ai/v1/models \
  -H "Authorization: Bearer $TYPESAFE_API_KEY"
```

该接口当前列 aliases，版本 ID 即便未列出也可用于 `model` 字段。[Models: Listing models](https://docs.typesafe.ai/models#listing-models)

> **模型短名冲突：** [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13) 的代码示例写 `jev-1.13`，[Python usage](https://docs.typesafe.ai/sdk/python/usage#choosing-a-model) 还示例 `jev`；但权威 [Models alias 表](https://docs.typesafe.ai/models#aliases) 只确认 `jev-latest`、`jev-preview`，正式版本 ID 是 `jev-1.13.0`。生产不要使用未由 Models 页确认的 `jev` / `jev-1.13` 短名。

## 6. SDK 与 HTTP 用法

### 6.1 JavaScript / TypeScript（更契合本项目）

查证日 npm 当前版为 `@typesafe-ai/sdk@0.6.0`，要求 Node.js 20+。[npm registry 官方元数据](https://registry.npmjs.org/@typesafe-ai/sdk/latest)；[JS SDK changelog](https://docs.typesafe.ai/sdk/javascript/changelog)

```bash
npm install @typesafe-ai/sdk@0.6.0
```

```js
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({
  defaultModel: "jev-1.13.0",
  timeout: 10_000,
});

const response = await client.systemOne({
  state: {
    task: taskText,
    deterministicSignals: { hasShell, touchesCredentials },
  },
  questions: {
    route: choice("Which review route should this task take?", {
      automatic: "Safe to execute automatically",
      human: "Needs a human decision",
    }),
    destructive: noul(
      "Would executing this task cause destructive or irreversible effects?",
    ),
    risk: score("How risky is automatic execution?", [
      "Read-only and reversible",
      "Writes files but is reviewable and reversible",
      "Destructive, irreversible, or affects credentials/external systems",
    ]),
  },
});
```

官方 JavaScript quickstart 证实方法名为 `systemOne`、包名 `@typesafe-ai/sdk`，并包含 ESM、CommonJS 和 TypeScript declarations。[JavaScript SDK](https://docs.typesafe.ai/sdk/javascript)

配置要点：[TypeSafeClientConfig](https://docs.typesafe.ai/sdk/javascript/api/interfaces/TypeSafeClientConfig)

- `apiKey` 回退到 `TYPESAFE_API_KEY`；`defaultModel` 回退到 `TYPESAFE_DEFAULT_MODEL`，再到 `jev-latest`。
- 每次尝试默认 timeout 10,000 ms。
- 浏览器调用默认禁止；`dangerouslyAllowBrowser: true` 会把 key 暴露给页面用户，因此服务端集成不要开启。
- `debug` 日志包含 headers 和 bodies；已知凭据 header 会脱敏，**body 不脱敏**。本项目 state 可能含任务文本、路径或敏感上下文，生产环境不要开 debug，或先做日志清洗。

### 6.2 Python

查证日 PyPI 当前版为 `typesafe-sdk==0.7.0`，要求 Python >= 3.10。[PyPI 官方元数据](https://pypi.org/pypi/typesafe-sdk/json)；[Python SDK changelog](https://docs.typesafe.ai/sdk/python/changelog)

```bash
pip install typesafe-sdk==0.7.0
```

```python
from typesafe_sdk import Choice, Noul, Score, TypeSafeClient

with TypeSafeClient(model="jev-1.13.0") as client:
    response = client.system_one(
        state={"task": task_text},
        questions={
            "route": Choice(
                instructions="Which review route should this task take?",
                criteria={
                    "automatic": "Safe to execute automatically",
                    "human": "Needs a human decision",
                },
            ),
            "destructive": Noul(
                instructions="Would this task cause destructive effects?"
            ),
        },
    )
```

Python 同时提供同步 `TypeSafeClient` 和异步 `AsyncTypeSafeClient`；方法名为 `system_one`。响应既有统一的 `response.answers` map，也有按类型分组的 `response.choices` / `response.nouls` / `response.scores` convenience maps。[Python SDK](https://docs.typesafe.ai/sdk/python)；[Python responses](https://docs.typesafe.ai/sdk/python/api/types/responses#typesafe_sdk.SystemOneResponse.answers)

Python 与 JavaScript SDK 从 0.6.0 起都把 `Score.criteria` 改成有序 array/sequence；旧版 integer-keyed dictionary 属于 breaking change，不应复制。[Python changelog](https://docs.typesafe.ai/sdk/python/changelog#v060-2026-09-15)；[JavaScript changelog](https://docs.typesafe.ai/sdk/javascript/changelog#v060-2026-09-15)

### 6.3 直接 HTTP（零运行时依赖方案）

本项目有“纯 `.mjs`、零运行时依赖”约束，因此直接用 Node 内建 `fetch` 比引入官方 SDK 更符合现有边界；但需自行补齐超时、错误分类和重试策略。裸 HTTP 文档只明确要求对 429/529 指数退避；若要复刻官方 SDK 默认行为，还应处理 `Retry-After`、408、其他 5xx、连接错误和超时。请求/响应 JSON 直接按第 1 节契约处理。[API reference](https://docs.typesafe.ai/api)；[JS RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy)

## 7. 错误、重试与限流

官方 HTTP 错误表：[API errors](https://docs.typesafe.ai/api#errors)

| HTTP | 含义 | 建议 |
| --- | --- | --- |
| 401 | API key 缺失或无效 | 不重试；检查 `Authorization: Bearer ...` |
| 422 | 请求校验失败，如缺字段或 malformed question | 不原样重试；错误 body 会指出字段 |
| 429 | 超过 tokens/s 或 requests/min | 按 `Retry-After`（如有）与指数退避重试 |
| 529 | TypeSafe 临时过载 | 指数退避重试 |

SDK 默认自动重试。官方 SDK 的默认策略更具体：[JS RetryPolicy](https://docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy)；[Python RetryPolicy](https://docs.typesafe.ai/sdk/python/api/retries)

- 初次尝试后最多重试 2 次；首个 backoff 500 ms，指数增加至最多 5 s，jitter 0.25。
- 默认重试 408、429、500–599，以及连接错误和超时。
- 默认尊重 `Retry-After` / `retry-after-ms`；JS 对服务器指定等待上限默认 60 s，超过则回到本地 backoff。
- Python SDK 的 API error 保留 status、body、headers、endpoint 和 `x-typesafe-request-id`；JS SDK 的错误类型公开 status/body/headers/requestId，RateLimitError 另有 retryAfterMs。应记录 request ID 便于排障，但不得记录 API key。[Python exceptions](https://docs.typesafe.ai/sdk/python/api/exceptions)；[JavaScript APIError](https://docs.typesafe.ai/sdk/javascript/api/classes/APIError)

直接 HTTP 集成至少应：

1. 按裸 HTTP 文档对 429/529 退避；若仿照 SDK 默认策略，可额外重试 408、其他 5xx、连接错误和超时。422 等确定性错误立即失败；
2. 尊重服务端 retry header，使用指数退避+jitter；
3. 给整次审批设置总时间预算，超时或重试耗尽时走项目既有“挂起/转人工”，**不能默认放行**；
4. 记录 status、request ID、模型版本、耗时和 token usage，但不记录 key，敏感 state 只按项目 scrub 规则落盘。

官方没有在 HTTP 参考中承诺幂等键、请求去重键、SLA、可用区或固定 p95/p99；不要自行假设存在。

### HTTP 参考与 SDK 类型的契约差异

官方资料之间存在一个需要保守处理的差异：[`HTTP API reference`](https://docs.typesafe.ai/api#request-body) 将 `state`、`model`、`questions` 及每题 `instructions` 列为 required，且 `state` 仅列 string/object/array、`instructions` 仅列 string/object/array；但 [`Advanced: where structure is allowed`](https://docs.typesafe.ai/primitives/advanced#where-structure-is-allowed) 明确说 instructions、Choice 描述、Score levels、Noul true/false 可为 string/object/array/**null**，SDK 类型也允许部分字段 optional/null。公开文档彼此冲突，不能仅凭宽松类型推断服务端所有空值都稳定受支持。集成应采用 HTTP 参考的最窄契约：发送非空 `state`、显式 `model`、非空 `questions`，且每题给出非空 `instructions`；对 422 做明确失败处理。

## 8. 隐私、保留与安全事实

- 官方明确：Jev **不会用客户请求或响应训练**；隐私政策更具体地承诺不使用 prompts/Input 训练或微调 AI/ML 模型，也不把 Input 披露给服务提供商以外的第三方。[Models: Data handling](https://docs.typesafe.ai/models#data-handling)；[Privacy Policy](https://typesafe.ai/legal/privacy-policy)
- 这**不等于默认零保留**。隐私政策写的是个人数据保留到“提供服务或支持业务/商业目的所合理需要”的时间，并可能因法律义务延长；DPA 同样按处理目的和适用法律确定保留期，没有给普通账户固定天数。[Privacy Policy: Retention](https://typesafe.ai/legal/privacy-policy)；[DPA Schedule I §8](https://typesafe.ai/legal/data-processing)
- **Zero Data Retention (ZDR) 仅明确为企业客户可选能力**，需联系 `privacy@typesafe.ai`；文档没有说明普通账户默认启用。[Legal](https://docs.typesafe.ai/legal)
- 隐私政策说明服务托管于美国，其他地区用户的数据会传至美国存储和处理；DPA 提供 EU SCC / UK Addendum 等跨境机制。[Privacy Policy: International Visitors](https://typesafe.ai/legal/privacy-policy)；[DPA §6](https://typesafe.ai/legal/data-processing)
- DPA 将客户视为 controller、TypeSafe 视为 processor；TypeSafe 承诺仅按书面指示处理，不“出售/共享”客户个人数据，并在知悉安全事件后无不当延迟且最迟 72 小时通知客户。[DPA §§1–2, 5](https://typesafe.ai/legal/data-processing)
- “不训练 Input”不等于“不产生或利用遥测”。MCA §4.1 允许从 Customer Data 派生 Telemetry；§4.3 将其定义为技术日志、hash、汇总统计、分类、指标和 learnings，并允许 TypeSafe 不受限制地处理以改进服务或其他产品。MCA §10.3 还说明到期/终止前后都无义务保留 Customer Data、可自行删除，而标准备份中的 Customer Confidential Information 可能继续保留并受保密条款约束。[Master Customer Agreement §§4.1, 4.3, 10.3](https://typesafe.ai/legal/mca)
- 查证日 [Subprocessors](https://trust.typesafe.ai/subprocessors) 明确：AWS 在美国的数据库、缓存和计算节点**存储并处理** live request 客户信息；Modal 在美国计算节点处理 prompts，但声明**不存储**。这仍没有给出普通账户在 TypeSafe/AWS 的固定默认保留天数。
- 官方 Trust Center 是部署前继续做安全/供应链审查的一手入口：[Trust Center](https://trust.typesafe.ai/)。

对 zcode-executor 的含义：不要把 API key 写入仓库、日志或运行产物；默认将送往 API 的完整 `state` 视为会被服务处理、可能保留并产生 Telemetry 的数据，先最小化字段、执行既有 scrub，并避免发送凭据、密钥、完整环境变量和与判断无关的源码。若审批场景含受监管或高敏数据，应在启用前取得适用的企业 ZDR / DPA 条款，而不是仅凭“不训练”承诺。

## 9. Jev 1.13 的已知边界

官方专门维护了 [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)，集成不能把“typed output”误解为“判断必然正确”：

1. **字面理解强，意图补全弱**：明确写条件、反例与边界；错答后不要解释“真正想问什么”，应把那部分直接写进 instructions/criteria。
2. **不可靠地计数、计算、比较日期**：正则、parser、算术、日期窗口由代码完成；模型只做语义判断或从代码生成的封闭候选中选择。
3. **多跳与双重否定降低准确率**：减少间接引用，明确指出 state 路径；复杂判断拆成原子问题。
4. **上下文腐化**：长 state 中无关细节会降准确率；先检索/过滤，只发与该组问题有关的字段。
5. **state 并不默认被当作敌对数据**：prompt injection 或自我辩护式内容能移动答案。审批问题需精确 criteria，并用本项目 adversarial cases 测试；不能把 Jev 当唯一安全边界。
6. **不保证问题间结构恒等式**：不要要求独立 Nouls 互补，也不要跨 Noul/Choice 沿用同一阈值。
7. **不生成文本**：若要抽取金额、路径、日期或任意字符串，先由正则/parser/生成模型提出候选，再让 Choice 选择；不要让 Jev“编出”值。

## 10. 对 zcode-executor 集成的可靠建议

### 推荐位置

把 Jev 放在现有确定性红线检查之后、人工审批之前，作为“模型审批”的一个可选 provider：

1. **确定性规则先行**：命中明确红线直接挂起，不消耗外部调用，也不让概率模型覆盖硬规则。
2. **最小 state**：只发 scrub 后的任务意图、将执行的动作摘要、确定性风险信号和必要 diff 摘要，不发 API key 或无关上下文。
3. **一次多问**：同一审批 state 同时问 `destructive`、`outside_scope`、`credential_risk`、`external_side_effect` 等原子 Noul，以及一个闭集路由 Choice；代码按已有业务规则组合。
4. **保守失败模式**：低 confidence、Noul 落在不确定区、429/529 重试耗尽、超时、校验错误或解析异常都转人工，不得自动放行。
5. **版本与审计**：生产 pin `jev-1.13.0`；记录模型实际版本、问题 schema 版本、概率、confidence、usage、request ID 和耗时。换模型或改问题后重新校准。
6. **中文先评测**：Jev 英文能力最好。可保持 state 原文，但建议先比较“英文 instructions/criteria + 中文 state”与全中文问法；没有项目级真值集之前不启用自动放行。
7. **不加 SDK 依赖**：使用 Node 内建 `fetch` 实现一层很薄的 provider，显式复刻官方重试策略，符合项目零运行时依赖约束。

### 不应依赖的假设

- 不把厂商博客的 70–500 ms 当 SLA。
- 不把 `jev-latest` 当行为稳定版本。
- 不把高 confidence 当正确性保证。
- 不把“不用于训练”当默认 ZDR。
- 不把 typed/schema-safe 当 prompt-injection-safe。
- 不让模型计算硬规则、日期、数量或金额，也不让它决定最终拒绝；按项目原则，模型只可放行或转人工。

## 11. 尚未从官方公开资料确认的事项

截至查证日，所查官方材料未公开或未给硬承诺的包括：

- 普通账户 API 请求/响应的固定保留天数；
- 免费额度、最低消费、账单粒度或失败请求是否计费；
- SLA、区域/多区部署、固定 p95/p99；
- HTTP 层幂等键或服务端请求去重语义；
- 单请求 questions 的独立数量上限（只公开 token budget）；
- tokenization 的公开算法/本地精确计数器；
- ZDR 的具体技术范围、日志例外和开通后条款（公开页仅说明企业可提供）；
- 429 的所有响应 header 契约（SDK 会识别 `Retry-After` 与 `retry-after-ms`，但 HTTP 参考未保证每次都有）；
- 错误 JSON body 的稳定字段 schema（HTTP 参考只说标准状态码和 JSON body，未定义固定字段）；
- `confidence` 的精确计算公式，以及不同选项/等级数量之间是否可直接比较。

这些事项若成为上线条件，应向 TypeSafe 获取书面确认，不能从 SDK 行为或博客数字反推合同保证。

## 一手来源索引

- 官方文档索引：<https://docs.typesafe.ai/llms.txt>
- Introduction：<https://docs.typesafe.ai/introduction>
- System One：<https://docs.typesafe.ai/concepts/system-one>
- State：<https://docs.typesafe.ai/concepts/state>
- Primitives：<https://docs.typesafe.ai/primitives>
- Choice：<https://docs.typesafe.ai/primitives/choice>
- Score：<https://docs.typesafe.ai/primitives/score>
- Noul：<https://docs.typesafe.ai/primitives/noul>
- Confidence：<https://docs.typesafe.ai/confidence>
- Models / pricing / rate limits：<https://docs.typesafe.ai/models>
- HTTP API：<https://docs.typesafe.ai/api>
- SDK 总览：<https://docs.typesafe.ai/sdk>
- JavaScript SDK：<https://docs.typesafe.ai/sdk/javascript>
- Python SDK：<https://docs.typesafe.ai/sdk/python>
- Jev 1.13 已知边界：<https://docs.typesafe.ai/model-jaggedness/jev-1.13>
- 批量问题 cookbook：<https://docs.typesafe.ai/cookbooks/parallel_questions>
- 官方发布博客（价格/延迟/评测说明）：<https://typesafe.ai/blog/introducing-system-one-models-and-jev>
- Legal 索引：<https://docs.typesafe.ai/legal>
- Privacy Policy：<https://typesafe.ai/legal/privacy-policy>
- Data Processing Addendum：<https://typesafe.ai/legal/data-processing>
- Master Customer Agreement：<https://typesafe.ai/legal/mca>
- Trust Center / Subprocessors：<https://trust.typesafe.ai/subprocessors>
- PyPI 官方元数据：<https://pypi.org/pypi/typesafe-sdk/json>
- npm registry 官方元数据：<https://registry.npmjs.org/@typesafe-ai/sdk/latest>
