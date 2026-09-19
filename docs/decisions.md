# 决策记录

每条记「定了什么、为什么、什么情况下值得重开」。D1 到 D5 于 2026-09-07 定下，D6 到 D9 是同日需求对齐时补的，
D10 是 T0.2 探针之后补的，D11 是检查点 1 撞出来的，D12 D13 是 2026-09-08 做阶段 2 时定的，
D14 是 2026-09-18 适配 ZCode App 3.12.2 时补的，D15 是同日确定 Jev 可选快筛时补的；D16 记录本轮批准的 Jev 前筛修订，替代 D15 的路由与审计方案。

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

## D10 建会话前必须推 provider 表，所以要读 `~/.zcode/v2/config.json`（3.12 起失效，见 D14）

T0.2 探针证实：直连 app-server 时不推 `workspace/updateProviderRegistry`，`session/create` 直接被拒
（Model config is missing），readState 也拿不到模型列表。app-server 不自己读 v2 config，
只有 App 和 zcode-acp 会替它推。所以我们必须读 `~/.zcode/v2/config.json` 构造 registry，
含 apiKey 内联传给子进程。

约束不变的部分：这个文件**只读不写**；apiKey 只出现在发给子进程的 stdin 里，永不落盘、永不打印；
models 为空或 `enabled:false` 的 provider 过滤掉。之前 RULES 里「只判断存在不读内容」这条改成
「只读，且内容不出协议层」。

重开条件：zcode 让 app-server 自己读配置。

2026-09-18 起 ZCode 3.12.2 删掉了 `workspace/updateProviderRegistry` / `runtimeModel`，见 D14。

## D11 建会话带 `runtimeModel`，模型与 provider 由我们指定（3.12 起失效，见 D14）

检查点 1 证实：推 provider 表之后 create 若不带 `runtimeModel`，回合仍因 provider 无 key 失败，而且默认模型落在
API Key 计费的 provider。带上 `runtimeModel`（model ref + provider 定义含内联 apiKey）两个问题一起消失。
所以 `new` 一律按等级和 provider 优先级算出 model ref，构造 runtimeModel 传给 create；resume 不带。

重开条件：zcode 让 app-server 自己解析 provider 鉴权。

2026-09-18 起 ZCode 3.12.2 删掉了 `workspace/updateProviderRegistry` / `runtimeModel`，见 D14。

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

## D14 3.12 起自带个人 provider 文件，密钥落临时文件

定了什么：ZCode App 3.12.2 把 provider 表从「宿主推给 app-server」改成「app-server 自己从两个文件读」，
`workspace/updateProviderRegistry` 和 `runtimeModel` 一并消失（见 D10、D11）。我们改成 spawn 子进程时带两个
环境变量：`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 指向 ZCode App 自带的内置 provider 文件（`zcode-builtin.json`，
CONTEXT.md 有词条），`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 指向我们自己写的一份个人 provider 文件——里面只有
一个 provider，providerId 固定写死 `zcode-executor`（不沿用 config.json 里的 `builtin:bigmodel-coding-plan`，
理由同 D11：新版 `builtin:` / `account:` 前缀有保留含义）。`session/create` 的模型参数从 `runtimeModel` 改成
`model:{providerId:'zcode-executor', modelId, options:{reasoningLevel}}`，`workspace/generateText` 的
`modelRef` 改成同形状的 `selection`。zcode.cjs 里还有一条新的反向请求
`interaction/requestProviderRuntimeHeaders`（模型请求前向宿主要运行时头），检查点 5 真机证实 api-key 型
provider 不会发它（verified.md 2026-09-18 表第 5 行）；客户端仍保留内置应答以防账号型 provider 用到：有 key 答
`{headersApplied:true, requestAuth:{apiKey}}`，没有答 `{headersApplied:false, errorMessage}`。

为什么：app-server 改成自己读文件，不再接受宿主推表，`workspace/updateProviderRegistry`（D10）和
`runtimeModel`（D11）都被删了，我们必须换一套办法把密钥和模型表交给它。试过的不落盘路径都走不通：
`provider/updateAccountConfig` 只收 `access.type:"zhipu-account"` 那一种账号型 provider，塞 `apiKey` 直接
被拒；反向请求 `requestProviderRuntimeHeaders` 又是模型请求时才会来，建会话那一步 registry 里还是要先有这个
provider，不能靠它临时插入。写用户自己的 `~/.zcode/v2/provider_config.json` 也不行：App 会重写这个文件、
会和用户自己的配置打架，还违反「`~/.zcode` 只读」的约束（RULES §6）。所以只能自己写一份个人 provider 文件
让 app-server 读。

密钥放哪：个人 provider 文件放在 `os.tmpdir()` 下用 `mkdtemp` 建的临时目录里，权限 0600，子进程收场的
`finally` 里删掉；不进 `runs/<id>/`（那个目录是留着事后查看的，不该有密钥）。

残留边界：只有 runner 被 SIGKILL 或机器崩溃时，这个临时文件才会留在 `os.tmpdir()` 里没删掉——生产路径没有
对 runner 发 SIGKILL 的代码，`cancel` 走的是文件信号（`answer.json` / `stop.json`），不是杀进程；macOS 的
`$TMPDIR` 本身权限 0700（只有当前用户能进）且系统会定期清理，双重兜底。

重开条件：zcode 提供一种不落盘就能推 api-key 型 provider 的方法；或者 legacy 的 `~/.zcode/v2/config.json`
不再存明文 apiKey（那样密钥的落盘问题从根上消失）。

## D15 Jev 以插件配置里的 key 选择快筛，不设 shadow 阶段（历史决定，路由已由 D16 修订）

> 以下保留当时的决定与理由，不是现行路由。原替代快筛、失败直接慢判及 `fastReview` 写入方案由 D16 修订；key 来源、文件保护、无 shadow 等约束继续保留。历史校准不构成新路线的安全或性能证明。

定了什么：`~/.zcode-executor/config.json` 的 `review.jev.apiKey` 为非空时，闸门第一段直接使用固定版本 Jev；没有 key 时回退到已有 ZCode fast 档 + `low` 思考等级快筛。Jev 只替代快筛，flag 与任何调用/校验失败都进入同一份 ZCode 慢判。红线、`allow_once`、慢判与挂起不变。首版不提供 shadow/off/screen、provider 枚举或环境变量 key 来源。

为什么：本机历史回放已经完成校准，用户选择跳过 shadow。配置文件比 detached runner 继承环境变量稳定，也能被 `doctor` 确定性检查；只有一份 key 来源则没有优先级歧义。让 Jev 失败回落慢判，而不是直接挂起，可以保持两段模型审批的可用性；让慢判仍走 ZCode，避免把外部服务故障扩大成人工审批风暴。

安全与数据边界：含 Jev key 的 config 必须是当前 uid 拥有的普通非符号链接文件，权限不宽于 `0600`；否则拒绝读取。只发送字段 allowlist 下的最小 state，Write/Edit 正文不出机，路径与凭据脱敏；key、Authorization、完整 state 和原始响应 body不进事件、pending、runner.log 或 app-server 子进程。Jev questions 全是独立负向风险，不使用“日常操作”或综合 confidence。事件保留现有 stage/decision，只附加 reviewer 与筛选后的 typed metadata；慢判事件通过嵌套 `fastReview` 说明 Jev flag/失败原因。

代价：key 以明文保存在用户目录的配置文件中，因此必须强制文件 owner/mode，不再满足旧 RULES “除临时 provider 文件外不落 key”的限制；这是用户为稳定读取明确选择的权衡。配置改动只影响之后由命令启动/重启且重新读取配置的 runner，已经在跑的连接不热更新。

重开条件：需要系统 keychain、企业 secret store、自定义 TypeSafe endpoint/模型、多个 key 来源；Jev 不稳定到“失败回落慢判”仍不可接受；或用户明确需要按会话/项目开关。

## D16 Jev 改为可选前筛，原 ZCode 快筛完整保留

定了什么：按已批准的 [修复与优化方案](jev-hardening-plan.md)，Jev 是提前通过层，不再替代 ZCode 快筛。红线和 `allow_once` 在前；非空白 `review.jev.apiKey` 启用 Jev。证据充分且五项概率均达标的 pass 提前 allow；flag/error/skip、超时、非法响应和 adapter 异常都进入原 ZCode fast + low 快筛，结果未通过或无法解析才慢判。原快筛调用失败仍 `review-failed` / ask，慢判失败仍 ask。无 key 保留原链路，关闭 review 的原挂起合同不变。

为什么：保留原快筛的判断机会，让 Jev 不能提前通过时回到既有审批链，而不是强制慢判。前筛仍有提前放行权，增加一层本身不是安全证明；必要证据门槛、输入脱敏、响应校验和严格 deadline 必须同时成立。

证据边界：Write/Edit/MultiEdit 正文省略、缺有效意图、命令或授权信息截断、无法可靠脱敏时，本地 skip，零 Jev HTTP 请求。复杂性不是风险：完整且任务相关的管道、子 shell、批处理、项目脚本仍可前筛；确实缺少必要事实才回落。原快筛收到原 action/context，不接 Jev 概率指令；不上传正文来换取直通率，不扩大原隐私权限。

审计与诊断：每次请求仍只有一个最终 `executor.gate`；`preScreen` 独立记录 Jev pass/flag/error/skip，最终 stage/reviewer 区分 Jev 提前通过、ZCode 快筛通过与慢判。历史 `fastReview` 保持旧 Jev 回落含义，不静默改义。`doctor` 新增 `review.pipeline`，有 key 为 `['jev','zcode-fast','zcode-slow']`，无 key 为后两项，禁用为 `[]`，配置失败为 `null`（不可确定）；兼容 `fastScreen` 不表示替代原快筛。

保留：配置文件唯一 key 来源、属主与权限检查、无环境变量后门、无 shadow/mode、固定模型、零运行时依赖；不并发竞速。本轮题目去重与边界修订升级为 `approval-v2`（模型仍为 `jev-1.13.0`），尚未重新真实校准；阈值维持 0.20，不放宽。

代价：Jev 未提前通过会增加串行等待；本地 skip 无这笔 HTTP 开销。省略正文的写操作不再享有 Jev 直通。必须用同批样本比较端到端耗时、提前通过率、回落与费用；旧真实 Write pass 和旧校准仅是历史证据，不改写成新路线已验。

重开条件：配对测量无净收益，需缩小适用范围或调整预算；若要恢复正文省略动作的直通、让原快筛调用异常也进入慢判，须另行决策并验收，不能借本轮暗改。

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
- 账号 provider 路线（`account:bigmodel-individual-coding-plan` + `provider/updateAccountConfig`）：推
  `{access:{type:'zhipu-account',entitled:true}}` 返回 received，但 `session/create` 仍报 registry 里没有
  这个模型，还要再拆 `states` 与内置活动文件的语义才能往下走。收益只是「会话在 App 里显示成同一个账号」，先记着。
- 只支持 ZCode App 3.12+，不做新旧两套握手兼容。理由：`--version` 区分不出新旧（3.11.2 和 3.12.2 都打印
  `0.16.5`），两套握手会让 mock 和测试翻倍；App 自动更新，用户机器回不去老版本。
