# SPEC — dsh-zcode-executor

> DSH（DeepSeek Harness）插件：把 zcode-executor 接进 DSH——智能体教学（当工头派单）+ 官方右侧栏「zcode 任务」观察面板。
> 视觉与信息布局基准：`mockup/pane.html`（已确认）。需求经 2026-10-06 对齐（Q1–Q9 + 图标族要求）。
> 数据契约：`zcode-executor watch --json` 的 NDJSON 行协议（hello / session / synced / removed，快照字段见其 PRD 第 4 节）。
> 术语沿用 zcode-executor 的 CONTEXT.md：会话、投递、回合、挂起、观察面板、所属仓库、闲时投递。
> 状态（2026-10-07）：T1–T5/T7–T9 完成，T6 视觉精修与真机检查点（tasks/plan.md 检查点 A/B/C）待验收。

## Problem Statement

用户在 DSH 里想把手头的开发任务派给本机 ZCode 执行（zcode-executor 已提供完整 CLI），但有两块缺口：

1. DSH 的智能体不知道怎么当工头——没有任务单、执行副本、投递、挂起、验收这套流程的教学，只会把 zcode-executor 当普通命令瞎调。
2. 派出去之后看不见进展——用户在 DSH 界面里没有任何地方实时看到各条会话的回复、正在用的工具、挂起内容、闲时排队；只能靠智能体反复跑 `status` / `follow` 轮询，费对话轮次且人看不到过程。

Claude Code 那边已经有同款观察面板（zcode-executor 的 Claude Code mod），但 DSH 认不了 mod；DSH 的插件体系（官方右侧栏、真 React、主题令牌）足以承载一个更好的版本。

## Solution

一个 DSH bundle 插件 `dsh-zcode-executor`，三件套：

1. **派活教学**：DSH 版 SKILL.md（软链进 `~/.dsh/skills/`），教智能体完整派单流程与铁律；`ctx.systemPrompt.section` 挂两三句公告（可配置关闭）。
2. **观察面板**：官方右侧栏 tab「zcode 任务」，实时显示当前项目各条 zcode 会话——三段（待处理 / 执行中 / 已结束）、回复按 Markdown 渲染、工具与挂起详情、闲时排队。数据由服务端常驻的 `zcode-executor watch --json` 进程经插件自己的流式路由推给客户端。
3. **边界不变**：面板只看不应答——挂起仍由派单的智能体在对话里转交用户；面板上没有任何批准 / 拒绝 / 回答控件。

不注册智能体工具（终端工具直接跑 CLI 即是全部能力）、不做 slash 命令、不依赖 better-sidebar（走官方右栏注册 API）。

## User Stories

**派单教学**

1. 作为用户，我对 DSH 智能体说「把 T-xxx 派给 zcode」，智能体因为 skill 知道完整走法（写任务单、建执行副本、`new` / `send --task` / 验收、合并回主仓），不需要我教。
2. 作为用户，我要智能体遵守铁律：任务单是契约、`send` 必带 `--task`、验收只看 `git diff` 和测试不看执行端自述、三四轮不过回去改任务单——这些写进了教学。
3. 作为用户，回合挂起（退出码 5）时，我要智能体把审批请求原样转述给我、拿到决定再 `approve` / `deny`，而不是自作主张替我批越界操作。
4. 作为用户，执行端反过来提问时，我要智能体先自己判断任务单里有没有答案，能答就 `answer`，答不了再问我。
5. 作为用户，我要智能体会正确使用闲时投递（先 `quota` 告知、我选了才 `--offpeak`、另开会话发、`--resume` 恢复），这些规则在教学里和 Claude Code 版一致。
6. 作为用户，我可以关掉 system prompt 里的派单能力公告（设置项 `announceToAgent`），关了智能体就少一段提示、skill 仍可用。

**观察面板**

7. 作为用户，我在 DSH 右侧栏点开「zcode 任务」tab，看到本项目全部会话按 待处理 / 执行中 / 已结束 三段排列，顶部有计数与实时时间。
8. 作为用户，会话有任何变化（回复新行、工具切换、挂起、结束），面板约 1 秒内自动刷新，不需要手动刷新，也不花任何额度（watch 只读）。
9. 作为用户，执行中的会话卡片上，我要一眼看到：动态脉冲图标、「已运行 N 分钟」、最新回复（按 Markdown 渲染，折叠复刻 CC mod：有内容的行不超过两行整段显示、超过收起前两行可展开；2026-10-07 晚定案——当日早先的「超过一行收一行」规格里单段无换行的回复被整个藏掉）、正在执行的工具与参数摘要、最近完成的工具及成败。
10. 作为用户，挂起的会话卡片上，我要看到挂起类型（审批请求带工具名 / 提问带条数）、命令或参数全文、转人工的原因、最新回复（2026-10-07 补，原版无），以及「由派单智能体在对话中处理」的提示。
11. 作为用户，执行进程中断（stale）时，我要面板用醒目的警示卡片告诉我回合没正常收尾、需要决定重投或取消（卡片同样带最新回复，2026-10-07 补）。
12. 作为用户，闲时投递排队时，我要看到「闲时排队中，第 N 位」或「闲时已就绪」、已排时长，配转圈动态图标。
13. 作为用户，回合刚结束的会话以卡片显示（结果文案 + 最后回复），30 分钟后自动缩为一行，点行可展开回卡片看回复（2026-10-07 改，原 10 分钟且行不可点）；已结束列表最多 20 条、可滚动。
14. 作为用户，我切换 DSH 里的会话或工作区，面板自动只显示当前项目的会话（按所属仓库判定）；顶部有「本项目 / 全部项目」切换，切到全部时其他仓库的会话也显示并标注仓库名。
15. 作为用户，面板跟随 DSH 的浅色 / 深色主题，颜色全部取宿主主题令牌，两种主题下文字与状态色都看得清。
16. 作为用户，watch 进程意外退出时，面板顶部出现断连横幅、实时指示变红，约 5 秒后自动重连；重连后的首轮变化不当作新变化提示（不补弹）。
17. 作为用户，重启 DSH 桌面端或重载插件后，面板与数据流自动恢复，不需要我手动重开。
18. 作为用户，本机没装 `zcode-executor` 或可执行路径不对时，面板显示可读的失败说明（并提示 execPath 配置项），插件本身不崩、DSH 不受影响。
19. 作为用户，没有会话时各段有明确空态文案（如「没有执行中的回合」），面板不空白。
20. 作为用户，我要面板上的每个状态指示图标风格统一（一套 20×20、1.6px 圆头描边的 SVG 家族），执行中与闲时排队用动态图标，其余静态。

**维护**

21. 作为插件维护者，我要插件的测试不建 DSH 会话、不发消息、不花 token（dsh-plugins 仓库纪律）；watch 与面板逻辑都能用桩数据测。
22. 作为插件维护者，我要插件只用官方接入点（官方右栏 tab 注册、官方主题令牌、官方 Markdown 组件），不依赖 better-sidebar 或其他第三方插件，装不装它们都不影响。
23. 作为插件维护者，我要能在设置页改 `execPath`（CLI 路径）、`watchMode`（常驻 / 按需）、`announceToAgent`，改完按 DSH 的配置生命周期生效。
24. 作为插件维护者，我要快照行协议缺字段（旧版 CLI）时面板容错降级而不是崩——如同 Claude Code mod 对旧 `watch` 无 `replyMarkdown` 的回退。

## Implementation Decisions

**打包与形态**

- dsh-plugins monorepo 新包 `plugins/dsh-zcode-executor`，bundle 型插件：TypeScript + 仓库既有构建管线（tsc + `build-client.mjs` 内联打包），`lib/` 产物入库；`cordis.patch.yml` 一行 insert，行 id `zcode-executor`。
- `package.json` 的 `dsh` 字段：`bundle.patch` + `client.platform: "web"` + `exports["./client"]`；peer 范围照仓库约定 `>=0.1.7-rc.2 <0.3.0`（0.3 出来重核）。
- v1 只 `link:` 装进 desktop profile 本地使用，不发 npm。

**服务端（Node 半场）**

- 常驻子进程：`watchMode: always`（默认）下 apply() 即 spawn `zcode-executor watch --json`（argv 取 `execPath` 配置，默认从 PATH 找），cwd 取用户主目录（`hello.repo` 为 null → 流里是全量会话，客户端按仓库过滤）。`watchMode: on-demand` 下按流路由的订阅引用计数起 / 杀。
- 行协议解析：逐行 JSON，`hello` 记会话范围、`session` 更新快照表、`removed` 删除、`synced` 标记基线完成。意外退出：`synced` 前死视为「起不来」（面板报启动失败，不重试循环）；`synced` 后死视为「断了」，5 秒重起，重起到下个 `synced` 之间的快照只作新基线。
- 路由（`webServer.register`，全部先过 `ctx.connection.admit`）：
  - `GET /zcode-executor/stream`：NDJSON 流，把快照变化（含 hello/synced 语义的本地等价事件）推给订阅者；
  - `GET /zcode-executor/snapshot`：一次性全量快照（流式 fetch 不可用时的轮询兜底，建议 1 秒间隔）；
  - `GET /zcode-executor/repo?cwd=<路径>`：按 git 共同数据目录解析所属仓库（与 zcode-executor 的 repo 判定同规则），进程内缓存。
- Config（全字段 volatile、schema 全 `z.any()`，遵守设置服务的两条硬规则）：`execPath`、`watchMode`、`announceToAgent`。三个字段的变更都经 src/reload.ts 的指纹守卫重载插件行（Task 8 ①）：监听行的 `loader/volatile-update` 事件 + 2 秒轮询兜底，对 resolveWatchSettings 的解析值做指纹比对，变了就 `fiber.restart`——apply 重跑，watch 进程与路由随之用新配置重建（zen-remote 的 restart-watcher 先例；announceToAgent 同样走行重载，不精细到只撤销公告）。
- 三路由的 method 墙（Task 8 ②，zen-remote 同款）：admit 之后非 GET 一律 405 + `Allow: GET` + JSON 错误体，admit 放行的 GET 语义不变。
- **背压 / 心跳（Task 8 ③ 评估结论：可接受，不做实现）**：stream 的 `res.write` 忽略返回值、无心跳，是有意为之。依据：面板是单用户桌面场景，客户端在同机回环上持续读（浏览器侧 ReadableStream），响应头带 `X-Accel-Buffering: no` 防反代攒批；推送量有界——快照表 ≤ 数百条会话，首轮回放实测 244 行 1.0s 内齐（出处：tasks/todo.md「Task 3」Verification 的实测记录，2026-10-07），之后只有人的操作尺度的事件。Node 的 `write` 返回 false 仅表示数据进了用户态缓冲等 socket 排空，回环路径毫秒级；「多客户端 × 高频变更 × 跨网段慢消费者」的组合在本插件的接入面（本机 desktop、admit 门内）不存在，不为它加 drain 复杂度。心跳同理不做：路由本身即时转发连接态行（watch 起 / 停 / 断立刻有行），连不上的场景由客户端首响应超时兜住，同机回环没有中途静默丢连接的环节。
- **onChildExit 的 intentionalStop 分支（Task 8 ④ 复查结论：留作纵深防御）**：stopForIdle 与 dispose 都先置空 `this.child` 再 kill，主动停机的 exit 事件在身份校验处就被拦下，该分支实际不可达；保留是防将来出现「不先置空就 kill」的新停机路径把主动停机误报成断连横幅（用户可见的假警报），代价 4 行，删了不划算。
- 教学与公告：`ensureSkillLink()` 幂等软链 `~/.dsh/skills/zcode-executor` → 包内 skill 目录（DSH 不消费 `dsh.skills` 声明，走目录扫描）；`ctx.systemPrompt.section({ name, order: 150 })` 挂短公告，`announceToAgent` 控制。

**客户端（web 半场）**

- 右栏接入（官方 API，实证自 app.asar 内 `dsh-client-ui-sidebar-right`）：`ctx.sidebarRightTabs.register({ id: 'zcode-executor:tasks', kind: 'zcode-executor:tasks', priority: 'extension', title, guide })`；内容组件挂 `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id }, Body)`；导航用 `ctx.sidebarRight.openTab(kind)`。better-sidebar 的 native 接入代码是这套 API 的活样例，实现时对照。
- 纯逻辑层：把 zcode-executor 的 `hooks/view.mjs`（零依赖纯函数：`filterByRepo` / `sectionsOf` / `outcomeOf` / `headOf` / `elapsed` / `replyFold` / `plainLine`）逐字搬入客户端，另加一个流行归约器（对 CC mod `applyLine` 的去 toast 版改写：维护快照表、基线/同步语义、removed 处理）。
- 当前项目判定：优先从 `ctx.sessions.list`（observable，行带 `cwd`）用 `retainedBy.mainView > 0` 派生当前主会话；无会话时退 `ctx.workspaces.list` 取（唯一/最近）工作区 `path`。拿到 cwd 后调 `repo` 路由得所属仓库，与快照 `repo` 相等过滤（`filterByRepo` 语义：范围仓库为 null 时显示全部并注明）。切「全部项目」chip 直接跳过过滤、显示仓库名。
- 取数：优先 `fetch` 流式读 `stream` 路由（同源、默认带 cookie）；失败自动落到 `snapshot` 轮询。断连三态（starting / live / down / failed）与重连语义照 CC mod `view.mjs`。stream 与 snapshot 的 fetch 挂首响应闹钟 `firstResponseMs`（默认 15 秒，可注入，Task 8 ⑤）：服务器收下 TCP 不回时 fetch 会永久挂起、轮询永不启动，超时即 abort 并按连接失败走既有退化；响应头一到就拆闹钟，之后的流读不限时（watch 空闲长时间无行是常态，限时正文会掐死健康的空闲流）。
- **安全网轮询（2026-10-07 补）**：流活着时也按 `safetyPollMs`（默认 5 秒，0 关闭）低频拉一次 snapshot——真机发现宿主 webview 的流式传输层疑似把小增量行缓冲住（首轮大块回放能到、中途更新永不到、流没断所以退化轮询不启动，`ReadonlyStream` 真机试读这一风险表项一直未执行）。流正常时安全网拿到的与服务端一致等于空转；被缓冲时保证状态 ≤ 间隔必达；退化轮询期间安全网让位，流恢复即回低频节奏。流路由同步补 `flushHeaders()`（存在才调）。
- **合成连接态的语义区分（Task 8 ⑥）**：store 合成的连接行按病因各说各话——transport 全断合成 down「实时连接中断」，但不覆盖服务端已报的 failed（「起不来」是更接近病根的诊断，覆盖掉会误导排障）；snapshot 回 401/403 时 link 仍记 down（横幅位置不变）而 message 为「无权访问（admit 拒绝）：本机登录态可能已失效，重新登录 DSH 后自动恢复」，不再说「连接中断」；轮询照常继续，重新登录后下一轮自动恢复。
- 渲染：React 组件 + 模板字符串 CSS 常量注入单个 `<style data-plugin="dsh-zcode-executor">`；颜色只用 `--dsw-alias-*` 令牌与派生状态色，深浅随 `body[data-ds-dark-theme]`；回复用宿主 `MarkdownText` 渲染 `replyMarkdown`（缺失时回退 `reply` 逐行）；代码块用宿主 `CodeBlock` 风格。
- 图标：一套 20×20、1.6px 圆头描边 SVG 家族（mockup 的 `<symbol>` 表即基准）。2026-10-07 起全部自绘（原「优先映射宿主 `Icon*Regular`」撤销——真机两族光学大小不一，「已完成」明显偏大，用户反馈统一）；动态图标（执行中脉冲、闲时转弧）自绘 + CSS 关键帧，`prefers-reduced-motion` 停用。
- 信息架构与 CC mod 对齐（2026-10-07 用户改规格，三处已偏离）：三段、结果文案表、挂起详情（工具名 + 挂起摘要 + 原因）、闲时排队（phase + position）、已结束 30 分钟内成卡片（原 10 分钟）/ 至多 20 条 / 行可点开成卡片（新增交互）、回复 `replyFold` 判定（有内容的行超过一行才折叠，原两行）、时长角标（`elapsed` 同文案）。分段标题吸顶、摘要计数可点跳分段（mockup 已画）。卡片状态图标无底衬（原有 13% 着色芯片，2026-10-07 按用户反馈移除）。
- 面板内不弹 toast、不做 tab 角标（官方注册面没有徽标字段）——挂起的醒目性由「待处理」段置顶 + 警示色承担。

**明确不做（边界）**

- 面板上任何 approve / deny / answer 控件（AGENTS.md 硬约束：挂起由派单智能体转交）。
- 注册智能体工具、slash 命令、`agent.inject` 挂起提醒、智能体跑 `send` 时自动展开 tab（后两者记为 v1.1 候选）。
- 英文文案（locale 管线留接口不填字典）、quota 小块、发 npm。

## Testing Decisions

**什么是好测试**：只测外部可观察行为——行进去、可观察的状态出来；不断言内部函数调用次数、不 mock 内部模块。

**缝（seam）有三个，都选在已有先例的最高处**：

1. **纯逻辑层（最高缝）**：流行归约器 + 搬入的 view 函数是纯函数，`node --test` 直接喂数据断言。输入是 watch 行协议的样例行（按真机形状写，注明出处），输出是快照表 / 分段 / 过滤 / 折叠判定。先例：zcode-executor 的 `test/view.test.mjs`。
2. **服务端半场（fake ctx + 桩 watch）**：不真跑 `zcode-executor`——`execPath` 指向一个吐假 NDJSON 行的桩脚本（可控制输出节奏与退出），fake ctx 假装 cordis（`ctx.effect/ctx.on/ctx.get/webServer.register` 收集调用）。断言：watch 起了、行进了快照表、桩意外退出后 5 秒重起、未过 admit 的请求被拒、stream 路由输出 NDJSON、repo 路由调 git 并缓存。先例：zen-remote 的 `test/push-tool.test.cjs`（fake ctx + cache-busting 重导入）与 zcode-executor 的 `test/watch.test.mjs`（真子进程桩 + 调小轮询）。
3. **配置热重载（reload）**：指纹守卫（`src/reload.ts`）是纯逻辑 + 可注入计时，`node --test` 用假钟驱动每一次 tick——事件触发与轮询兜底共用的 fire-at-most-once 闸门、基线读失败延后补记、轮询句柄 unref。先例：zen-remote 的 `test/restart-watcher.test.cjs`（假钟驱动 `src/restart-watcher.ts` 同款）。

客户端 React 组件不引测试框架单测（仓库无先例），用构建期 `tsc --noEmit` + 真机检查点兜底：

- **检查点（真机，仅派单花额度、watch 零额度）**，照 zcode-executor watch-pane 的 W1–W10 改写：C1 装入 desktop profile 重启后面板 tab 出现；C2 真实派一小单，1 秒内出现执行中卡片、回复与工具随执行刷新；C3 触发挂起进待处理、答完回执行中；C4 回合结束卡片化、30 分钟后缩行、点行可展开（2026-10-07 改，原 10 分钟不可点）；C5 切工作区 / 切「全部项目」过滤正确；C6 kill watch 进程看断连横幅与 5 秒恢复、恢复不补弹；C7 浅深主题各过一遍；C8 宿主重启后自动恢复；C9 智能体照 skill 完成一次真实派单（含挂起转述与验收）；C10 拔掉 execPath（指向不存在路径）看失败说明。

## Out of Scope

- 面板应答（approve / deny / answer）——做了才算改 zcode-executor 的闸门边界，属另立决定。
- toast 通知、tab 角标、自动展开 tab、挂起 `agent.inject` 提醒。
- 英文文案、quota 显示、slash 命令、agent 工具。
- 发 npm 与 Trusted Publishing 流水线（留到要公开分发时照 zen-remote 补）。
- zcode-executor 仓库的代码改动。唯一关联改动是它发版时的文档项：README 提及 DSH 插件、CONTEXT.md「观察面板」词条从「Claude Code 里」泛化为「宿主界面里」，随插件可用后一起做。

## Further Notes

- 两仓唯一耦合面是 `watch --json` 行协议 + SKILL.md 教学内容；协议只加字段不改含义，插件对缺字段容错。
- 官方右栏 API 的形状是从 app.asar 内 README 与 better-sidebar 的用法实证的（DSH 0.2.0-rc.2）；DSH 0.3 发布时要重核 peer 与注册面，必要时走 `dsh plugin allow-version` 豁免流程。
- `mockup/pane.html` 是视觉与信息密度基准（用户已确认）；落地 React 时删除其自带的主题取值，全部换宿主令牌。
- 浏览器插件 bundle 里流式 fetch 属首例（zen-remote 只做过轮询 store），标准平台能力可行，但 C1 检查点要优先验证桌面端 Electron 下 `ReadableStream` 读到底。
