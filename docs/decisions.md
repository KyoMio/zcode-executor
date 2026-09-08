# 决策记录

每条记「定了什么、为什么、什么情况下值得重开」。D1 到 D5 于 2026-09-07 定下，D6 到 D9 是同日需求对齐时补的，
D10 是 T0.2 探针之后补的，D11 是检查点 1 撞出来的，D12 D13 是 2026-09-08 做阶段 2 时定的。

## D1 定位：派单与验收层，协议是别人的事

三个第三方项目（zcode-open-bridge、zcode-acp、coder-mcp-bridge）已经把 zcode 的
app-server 协议摸了三遍，没有一个碰"Claude 怎么写任务单、派到哪个 worktree、
怎么排队、怎么验收、怎么记账"。本项目只做后者。

**明确不做**：协议翻译产品、TUI、远程访问、审查工具、通用资源调度。

重开条件：zcode 官方出了派单/验收能力。

## D2 直连 app-server，中间没有 ACP

原方案是走 ACP 传输层，经 zcode-acp-server 翻译。
ACP 只在同时接多个执行端时才是公共语言；项目只接 zcode，它就是一层多余翻译。

直连之后原来的四个问题三个消失：`session/create` 立刻返回真 `sess_` id
（懒会话和 list 命名空间是 zcode-acp 为编辑器造的）；`session/close` 本来就有；
`mode` 和 `toolDenylist` 可以在 create 时直接传；`interaction/requestPermission`
直接落到我们手上。剩下的 provider 表同步只是几行过滤。

代价：自己维护一个约 800 到 1200 行的 app-server 客户端，从 zcode-acp 搬核心
（Apache-2.0，保留声明）。zcode-acp 两天发十个 minor 版本、方向往 TUI 和远程走，
把它当运行时依赖的风险比自己维护一份小客户端高。

重开条件：zcode 改 app-server 协议的频率高到我们跟不上。

## D3 审批：红线 → 模型审批 → 挂起等人

会话用 `build` 档（会发审批请求），可选 `toolDenylist` 物理拿掉工具。
审批请求进闸门：

1. 红线规则先判（不可清除的那几条）。
2. 模型审批经 `workspace/generateText` 判，额度走 zcode 的 coding plan，
   不建会话、不污染 App 列表。逻辑参考 Claude Code auto 模式的快慢两段审批。
3. 判不下来就挂起：请求写进 `runs/<id>/pending.json`，连接保持不答
   （app-server 侧无超时），`send --wait` 以 `blocked` 返回。Claude 用
   AskUserQuestion 问人，再跑 `zcode-executor approve|deny <id>`。

**模型审批只产出放行或转人工。** 拒绝也走人工。这条是"自己审自己"能被接受的前提。

Claude Code 原生通道为何没选：MCP elicitation 是唯一能把外部请求弹到 Claude
Code 对话框里的路，但要求桥以 MCP 服务形态常驻、弹框发生在某个工具调用进行中，
且非交互模式直接失败；钩子和 `--permission-prompt-tool` 方向相反，只管 Claude
自己的工具调用。留作 MCP 外壳阶段的升级项。

重开条件：Claude Code 给外部进程开了审批入口。

## D4 单执行端，独立项目

不做"一个桥接多个后端"的通用桥。本项目只接 ZCode，借鉴的是作者先前派单工具里
验证过的模式（runner 一生、队列与锁、runs 落盘、验收），代码不引用。

## D5 名字：zcode-executor

仓库、插件、CLI、skill 同名，和作者其它派单 skill 的命名对称，用户说
"让 zcode 去做"就触发。名字里没有 bridge（三个第三方项目都叫 bridge），
也没有协议名（协议是实现细节）。

## D6 模型按等级选，不按名字

派活和模型审批都用 `fast` / `strong` 两个等级，从 `workspace/readState` 拿列表按名字关键词自动分，
`config.json` 可覆盖。派活的思考等级默认 `high`，`--thought` 可覆盖；模型审批默认 `low`（2026-09-08 改：审批只判是不是日常工作，high 白花时间和 token，且慢判在 high 下曾把预算耗在推理上被截断）。

不写死模型名是因为模型会换代，写死了每次换代都要改代码和 skill。Flash 类模型思考等级不往低调，
用户实测低了效果差。

**provider 优先级（T0.2b 后补）**：同名模型在多个 provider 下并存，zcode 默认落到 API Key 按量计费的 `builtin:bigmodel`。
我们优先 coding plan：配置 `preferredProvider` > id 以 `-coding-plan` 结尾 > `-start-plan` > 其它，只在启用的里面选。
国内站点 `builtin:bigmodel-*` 和国际站点 `builtin:zai-*` 一视同仁，哪个启用用哪个。

重开条件：出现第三种明显不同档次的模型，两档装不下。

## D7 执行端的提问也挂起，由 Claude 先答

zcode 的 AskUserQuestion 不进红线和模型审批，直接挂起，`send --wait` 以 5 返回，
Claude 看问题决定自己 `answer` 还是转给人。

不自动回「按任务单自决」：那等于把执行端最需要人的时刻糊弄过去。不直接拒绝：Claude 是工头，
大部分问题任务单里写过，它自己能答，不必每次惊动人。

重开条件：实际用下来 Claude 答错的比例高到不如全部转人。

## D8 cwd 白名单，默认只允许 `~/.zcode-executor/worktrees/`

白名单挡的是 Claude 手滑把主检出当 cwd，红线挡的是执行端越界，两者不重叠。
cwd 不是 worktree 只警告不拒：白名单里放一个普通仓库是用户有意为之。

## D9 纯 `.mjs`，零依赖，无构建

审批层的 TypeScript 原型手工去类型。几百行代码不值得引入构建；
Node 22.18 的运行时剥类型会把 Node 门槛抬高并多一种文件形态。

重开条件：搬来的代码超过两三千行，手工维护两份开始出错。

## D10 建会话前必须推 provider 表，所以要读 `~/.zcode/v2/config.json`

T0.2 探针证实：直连 app-server 时不推 `workspace/updateProviderRegistry`，`session/create` 直接被拒
（Model config is missing），readState 也拿不到模型列表。app-server 不自己读 v2 config，
只有 App 和 zcode-acp 会替它推。所以我们必须读 `~/.zcode/v2/config.json` 构造 registry，
含 apiKey 内联传给子进程。

约束不变的部分：这个文件**只读不写**；apiKey 只出现在发给子进程的 stdin 里，永不落盘、永不打印；
models 为空或 `enabled:false` 的 provider 过滤掉。之前 RULES 里「只判断存在不读内容」这条改成
「只读，且内容不出协议层」。

重开条件：zcode 让 app-server 自己读配置。

## D11 建会话带 `runtimeModel`，模型与 provider 由我们指定

检查点 1 证实：推 provider 表之后 create 若不带 `runtimeModel`，回合仍因 provider 无 key 失败，而且默认模型落在
API Key 计费的 provider。带上 `runtimeModel`（model ref + provider 定义含内联 apiKey）两个问题一起消失。
所以 `new` 一律按等级和 provider 优先级算出 model ref，构造 runtimeModel 传给 create；resume 不带。

重开条件：zcode 让 app-server 自己解析 provider 鉴权。

## D12 runner 一律后台，前台命令只读文件

原设计是 `send --wait` 前台自己当 runner。但本项目挂起时要**保持连接不答**，前台以退出码 5 返回后连接不能断，
所以 runner 必须是独立后台进程，前台 `send --wait`、`follow`、`status` 都只读 `runs/<id>/` 的文件，
`approve / deny / answer` 通过 `answer.json` 把应答交给 runner。代价是多一个 detached 进程和一层文件轮询。

重开条件：无。

## D13 `new` 不建 zcode 会话，登记簿用本地派单 id

真机证实：没跑过回合的会话进程一关就 resume 不了，create 又不接受自定义 sessionId。所以 `new` 只做零 token 的模型校验和登记，
登记簿的键是本地 id（`x_` 加 8 位十六进制），`sessionId` 字段先空着；runner 第一次投递时 `session/create`（带 runtimeModel、thoughtLevel、
toolDenylist）并把 `sess_` 写回登记簿，之后都 `session/resume`。所有命令的 `<id>` 参数都是本地 id。
runner 若 resume 报 Session not found（会话在 zcode 侧丢了）→ 记事件 `executor.recreated` 后重新 create，不静默失败。

代价：本地 id 和 zcode id 两套，`list` 两列都显示。CONTEXT.md「会话」条目相应改写。

重开条件：zcode 允许自定义 sessionId 或空会话可持久化。

## 补记：模型审批的模型从已推的 provider 表里选，不再多一次 readState

runner 起来时已经推了表，registry 里的模型清单与 readState 一致；省一次往返。代价是看不到后端的 `disabledReason`，
真机上 coding plan 的两个模型都没被禁用过。哪天出现被禁用的模型再改成 readState。

## 暂缓

- ~~挂起期间 zcode 每秒重发审批请求，对端对「回旧信封 id」认不认未验~~ 已验（2026-09-08 交付后核验②）：
  挂起 75 秒后 approve，zcode 照样接受并继续，只保留最近 5 个信封 id 的做法够用。

- ZCode App 共存实验（本插件跑长任务时在 App 里点开同一条会话，看 cli log）。
  两边共用 `~/.zcode/cli/db/db.sqlite`，无跨进程锁，SQLite 保文件不撕裂，
  逻辑层是否错乱未验。先靠 worktree 隔离。
- 往 `~/.zcode/v2/tasks-index.sqlite` 同步会话让 App 列表看到。第一版不做。
- MCP 外壳与 elicitation。
- 给 zcode-acp 上游报问题。现在不依赖它了，报不报看心情，报之前问用户。
