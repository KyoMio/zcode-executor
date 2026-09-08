<h1 align="center">zcode-executor</h1>

<p align="center">中文 · <a href="./README.md">English</a></p>

<p align="center"><strong>Claude 规划，ZCode 写码，git 验收。</strong></p>

<p align="center">一个 Claude Code（也支持 Codex）插件：把一件想清楚的开发任务派给本机的 <a href="https://zcode.z.ai">ZCode</a>（GLM）执行，在隔离的 git worktree 里跑，每一次写操作都过「红线 + 模型审批」两道闸，最后用 <code>git diff</code> 和测试验收，而不是听执行端的自述。</p>

<p align="center"><img src="https://img.shields.io/badge/version-v0.1.0-5B4CF0" alt="v0.1.0"> <a href="https://www.npmjs.com/package/zcode-executor"><img src="https://img.shields.io/npm/v/zcode-executor?label=npm" alt="npm"></a> <img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License"> <img src="https://img.shields.io/badge/node-%3E%3D22-green" alt="Node"> <img src="https://img.shields.io/badge/tests-303%20passing-brightgreen" alt="Tests"></p>

## 为什么

Claude Code 擅长把任务想清楚，ZCode 擅长用很低的成本把代码磨出来。放任不管，哪一个都会跑偏。这个插件把两者各归其位：

- **任务单是契约。** Claude 写 `tasks/T-xxx.md`，发给 ZCode 的消息只是门铃。
- **worktree 是沙箱。** ZCode 在 `~/.zcode-executor/worktrees/<仓库名>` 里干活，永远不碰你的主检出。
- **闸门决定谁来批。** ZCode 每一次工具调用都走三段：红线（越出执行副本的写一律停下）、模型审批（先快筛后慢判）、判不下来才找人。模型只会「放行」或「转人工」，从不替你「拒绝」。
- **证据胜过自述。** 验收看 `git diff` 和你的测试。

## 快速开始

把这句话贴给你的 agent（Claude Code、Codex 或任何能跑 shell 的代理）：

> `Read https://github.com/kyomio/zcode-executor/blob/main/README.md and install zcode-executor by following its Install section, then run zcode-executor doctor.`

## 怎么用

命令行不用你自己敲。你把任务讲给你的 agent，它去跑这个 skill：写任务单、建执行副本、投给 ZCode、等它干完，再用 `git diff` 和你的测试核对结果，然后才回来告诉你成没成。中间 ZCode 要做闸门放不了的事，agent 会停下来问你。

两种叫法：

**直接调 skill**

```
/zcode-executor 给 status 命令加一个 --json 开关，测试要保持全绿
```

**或者直接提要求**

```
把 lib/queue.mjs 的重构派单给 zcode。
```

两种用法都一样：说清楚「做完」的标准——跑哪条命令要过、哪个文件该出现、期望什么输出。agent 会把这些写成任务单里的验收标准，任务单才是契约，发给 ZCode 的那句话只是开始信号。

## 两层结构

- **工作流层**：派活与验收。任务单 → 隔离的 worktree → 本地会话 id → 后台 runner → `git diff` 与测试。CLI 命令和 skill 讲的都是这一层。
- **安全管理层**：自动处理 ZCode 发来的审批请求。逻辑参考 Claude Code 的 **auto 模式**：一张谁也推不翻的红线表，然后是**快慢两段模型审批**（便宜的快筛只答 Y/N，快筛拿不准才进带理由的慢判），最后判不下来的交给人。审批模型只会「放行」或「转人工」，从不替你「拒绝」。

## 怎么运转

![zcode-executor 怎么运转：派活、审批闸门、验收](https://raw.githubusercontent.com/kyomio/zcode-executor/main/assets/how-it-works.zh-CN.png)

_时序图由 [archify](https://github.com/tt-a1i/archify) 从 [`assets/how-it-works.zh-CN.json`](assets/how-it-works.zh-CN.json) 渲染。_

一条会话一个 runner 进程，一律后台；命令行只读 `~/.zcode-executor/runs/<id>/` 下的文件。除了 `send` 和审批调用，什么都不花 token。

## 成本实测

下面这份用量就是开发本项目本身花掉的：35 张任务单、4 条执行会话，执行端提示 9.57 亿 token、输出 239 万 token。同一份 token 按公开 API 牌价算三档，两个模型的缓存读取率都固定为 95%：

![同一份活，执行端花多少](https://raw.githubusercontent.com/kyomio/zcode-executor/main/assets/cost.zh-CN.png)

| 执行端 | 新输入 | 缓存读取 | 输出 | 合计 | 相对 Sonnet 5 |
| --- | --- | --- | --- | --- | --- |
| Claude Sonnet 5 | $119.6 | $181.9 | $23.9 | **$325** | 1 倍 |
| GLM-5.3-Flash 牌价 | $7.2 | $27.3 | $1.2 | **$35.7** | 1/9.1，省 89% |
| GLM-5.3-Flash 经 ZCode（付牌价 67%） | $4.8 | $18.3 | $0.8 | **$23.9** | 1/13.6，省 93% |

牌价（美元 / 百万 token）：Sonnet 5 缓存写入 $2.50 / 缓存读取 $0.20 / 输出 $10；GLM-5.3-Flash $0.15 / $0.03 / $0.50。Sonnet 的新输入按缓存写入价计，因为 Claude Code 每回合都把新内容写进缓存。钱几乎全花在缓存读取上：agent 循环每回合都重读整个上下文，所以缓存读取单价决定了差距。实测缓存读取率其实是 99.3%，按那个算倍数是 7.5 和 11.2。规划端的费用三档相同，不计入。牌价截至 2026 年 9 月：[Claude](https://platform.claude.com/docs/en/about-claude/pricing)、[Z.ai](https://docs.z.ai/guides/overview/pricing)。

## 安装

### Claude Code（插件 marketplace）

本仓库既是插件也是自己的 marketplace。

```bash
claude plugin marketplace add kyomio/zcode-executor      # 或本地目录路径
claude plugin install zcode-executor@zcode-executor --scope user
```

插件启用期间 `bin/zcode-executor` 自动进 Bash 的 `PATH`，skill 以 `/zcode-executor:zcode-executor` 出现；说「让 zcode 去做」就会触发。

### Codex

```bash
codex plugin marketplace add kyomio/zcode-executor        # 或本地目录路径
codex plugin add zcode-executor@zcode-executor
```

和 Claude Code 两点不同：Codex 不把插件的 `bin/` 放进 `PATH`（skill 里写明了二进制在哪）；默认 `workspace-write` 沙箱不许写 `~/.zcode-executor`，在 `~/.codex/config.toml` 的 `[sandbox_workspace_write] writable_roots` 里加上它，或按提示批准。

### GitHub Copilot CLI

这份仓库同时也是 Copilot CLI 的插件 marketplace。

```bash
copilot plugin marketplace add kyomio/zcode-executor
copilot plugin install zcode-executor@zcode-executor
```

### Gemini CLI

仓库根的 `gemini-extension.json` 让它成为一个 Gemini CLI 扩展，`skills/` 下的技能装完即被自动发现。

```bash
gemini extensions install https://github.com/kyomio/zcode-executor
```

### Antigravity

Antigravity 就是改名的 Gemini CLI（`agy`），复用同一份扩展清单。

```bash
agy plugin install https://github.com/kyomio/zcode-executor
```

### pi

pi 认 `package.json` 里的 `pi` 字段，按 npm 包直接装。

```bash
pi install npm:zcode-executor
```

### OpenClaw

不用清单，把技能放进它的用户技能目录即可：

```bash
ln -s "$(npm root -g)/zcode-executor/skills/zcode-executor" ~/.openclaw/skills/zcode-executor
```

### Hermes

仓库根带了 Hermes 认的 `plugin.yaml`，装完再启用：

```bash
hermes plugins install kyomio/zcode-executor
hermes plugins enable zcode-executor
```

### Grok Build

`.grok-plugin/` 是给它 marketplace 装法用的清单，它也读 `~/.agents/skills/`，技能本身一条软链即可：

```bash
ln -s "$(npm root -g)/zcode-executor/skills/zcode-executor" ~/.grok/skills/zcode-executor
```

上面这七家和 Codex 一样，不会像 Claude Code 那样把插件的 `bin/` 放进 `PATH`——先 `npm install -g zcode-executor`，或让 skill 走 `npx zcode-executor` 兜底，SKILL.md 里两条兜底都写了。

### npm（任何代理，或者不用代理）

```bash
npm install -g zcode-executor   # 零依赖，无构建
zcode-executor doctor           # 零 token 自检
```

不想装也可以直接 `npx zcode-executor doctor`。skill 随包一起，在 `$(npm root -g)/zcode-executor/skills/zcode-executor/`，复制或软链到你的代理的 skills 目录即可。CLI 本身不依赖任何 Claude 专有的东西。

```bash
SKILL=$(npm root -g)/zcode-executor/skills/zcode-executor
mkdir -p ~/.claude/skills && ln -s "$SKILL" ~/.claude/skills/zcode-executor
```

目录换成下表里你自己代理的那个即可：

| 代理 | 用户级 skills 目录 |
| --- | --- |
| Claude Code | `~/.claude/skills` |
| Codex | `~/.codex/skills` |
| Gemini CLI / Antigravity | `~/.gemini/skills` |
| Grok Build | `~/.grok/skills` |
| Hermes | `~/.hermes/skills` |
| OpenClaw | `~/.openclaw/skills` |
| opencode | `~/.config/opencode/skills` |
| 通用（多家都读这个） | `~/.agents/skills` |

### 从源码

```bash
git clone https://github.com/kyomio/zcode-executor && cd zcode-executor
npm link && zcode-executor doctor
```

```bash
ln -s "$PWD/skills/zcode-executor" ~/.claude/skills/zcode-executor
```

目录换成上一小节表格里你自己代理的那个即可。

### 环境要求

- macOS 或 Linux，**Windows 暂不支持**。ZCode App 的位置按各平台的惯例找（`/Applications/…`、`/opt/ZCode/…`、`/usr/share/zcode/…`），装在别处就用 `ZCODE_BIN` 指到 `zcode.cjs`。
- Node ≥ 22（ZCode 的 app-server 要 `node:sqlite`）。
- 装好并登录过 ZCode 桌面 App（CLI 只读 `~/.zcode/v2/config.json` 来推 provider 表，从不写回）。

## 推荐工作流

zcode-executor 自己就是这么开发出来的：

1. **用 Claude Fable 规划。** 推理最强的模型负责追问需求、写规格，再拆成带机器可查验收标准的任务单。
2. **用 ZCode 执行。** 每张任务单通过 `zcode-executor` 派给一条 GLM 会话，在各自的 worktree 里跑；例行审批由闸门处理。
3. **Fable 粗审，Opus 细审。** Fable 看 `git diff`、跑测试；过了就派一个 Opus 子代理逐行 review，发现的问题写成补充任务单投回同一条 ZCode 会话。
4. **凭证据合并。** 测试和 review 都过了才进主干。

这样分工，贵的模型只花在判断上，便宜的模型负责敲代码。

## 命令

| 命令 | 作用 |
| --- | --- |
| `doctor [--json]` | 零 token 自检：找到 `zcode.cjs`（≥ 0.14.8）、确认配置存在、真握手一次、报模型等级分配 |
| `models [--json]` | 列可用模型：思考等级、禁用原因、分到哪个等级 |
| `new --cwd <绝对路径> [--title T] [--tier fast\|strong] [--thought 档] [--deny "工具…"] [--provider id] [--json]` | 登记会话（返回本地 id `x_…`）；ZCode 会话在第一次 `send` 时才建 |
| `send <id> <正文\|-> [--task 文件] [--wait] [--timeout 秒] [--steer] [--stream] [--json]` | 投递；`--wait` 跟到结束或挂起；`--task` 是模型审批拿来当授权依据的任务单 |
| `follow <id> [--timeout 秒] [--stream] [--json]` | 跟看后台 runner 直到有结果或挂起 |
| `status <id> [--tools N] [--json]` | 只读快照：阶段、最近工具、队列、挂起、上次结果 |
| `list [--project 关键字] [--json]` | 登记簿里的会话：阶段、等级、上次结果 |
| `cancel <id>` | 挂起的先拒绝，停掉回合，清空队列 |
| `approve <id>` / `deny <id>` | 应答挂起的审批请求（放行只有 `allow_once`） |
| `answer <id> [--] <值…>` | 应答挂起的提问：按序号、value 或 label；多选逗号分隔 |

退出码：`0` 干完 · `1` 用法错 / 起不来 · `2` 被拒（白名单、会话不在、等级不合法） · `3` `--wait` 超时（回合已取消） · `4` 回合失败 / 被叫停 · `5` **挂起等人**（审批或提问）。

## 配置

`~/.zcode-executor/config.json`（目录可用 `ZCODE_EXECUTOR_HOME` 改）。所有字段可选。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `allowedRoots` | `["~/.zcode-executor/worktrees"]` | `new --cwd` 允许指向的目录（解析符号链接后比对） |
| `waitTimeoutSec` | `1800` | `send --wait` 超时，到点停掉回合 |
| `preferredProvider` | 优先 coding plan | 同名模型在多个 provider 下时选哪个 |
| `tiers` | 按名字自动分 | 手动指定 `fast` / `strong` 的模型 |
| `review` | `{enabled, model, thought:"low", fastMaxTokens:300, slowMaxTokens:2000, timeoutMs:60000}` | 模型审批：开关、模型（默认 `fast` 档）、思考等级、两段预算、单次超时 |
| `environment` / `sensitive` | `[]` | 给审批模型看的环境说明与敏感位置 |

## 安全模型

- **红线是代码常量，不是配置。** 带路径的工具写到执行副本之外一律停下等人。规则表的类别沿用 Claude Code auto 模式（凭据、外泄、破坏性 git、删除、供应链、持久化、部署、共享资源、外部写入）。
- **审批模型从不拒绝。** 它只产出「放行」或「转人工」；调用失败、超时、解析不出都落到「转人工」。
- **只在允许时放行。** 自动放行和 `approve` 都要求 options 里有 `allow_once`；没有「一直允许」。
- **密钥不落地。** 从 ZCode 配置读到的 API key 只进 app-server 的 stdin，所有日志都脱敏，本工具从不写盘。
- **应答绑定请求。** `approve`/`deny`/`answer` 都带请求 id，陈年应答一律丢弃。

## 开发

```bash
npm test          # 303 个用例对剧本驱动的 mock app-server 跑，外加文档版本号一致性检查；不花 token
node --check lib/**/*.mjs
```

发版由 tag 驱动：`npm version patch` 改 `package.json`、把版本号同步进两份 README 和两份插件清单、建提交和 tag；`git push --follow-tags` 触发 workflow 跑测试、发 npm（Trusted Publishing，无令牌）、建 GitHub Release。提交信息就是 changelog。

纯 `.mjs`，零运行时依赖，无构建。设计文档在 `docs/`：[PRD](docs/PRD.md)、[SPEC](docs/SPEC.md)、[CONTEXT](docs/CONTEXT.md)（术语）、[RULES](docs/RULES.md)（开发规范）、[decisions](docs/decisions.md)、[verified](docs/verified.md)（对真 app-server 实测的事实）。给 agent 看的入口是 [AGENTS.md](AGENTS.md)。

## 常见问题

**能接 ZCode 之外的执行端吗？** 不能，这是有意的。执行端只有 ZCode；规划端可以是 Claude Code、Codex 或任何能跑 shell 的代理。

**为什么不直接让 Claude 改代码？** 成本和隔离。ZCode 的 GLM coding plan 是积分制，比前沿模型的 token 便宜得多（在 ZCode 内使用还有 67% 折扣，另有闲时免费额度），worktree 又让两个代理不会改同一批文件。

**一件任务花多少？** 按 token 算，改一个文件在 ZCode 侧约 3 到 6.5 万输入（它的系统提示很重），审批每次快筛约 5k 输入、2 秒。折成 coding plan 的积分再打 ZCode 的折扣，只是用前沿模型做同一改动的零头。

**审批模型判错了怎么办？** 它只会多问、不会多放：判不准的全部以退出码 5 交到你手上。

## 许可证

Apache-2.0。搬入的代码保留原始声明，见 [NOTICE](NOTICE)。
