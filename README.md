# dsh-zcode-executor

DSH（DeepSeek Harness）插件：把本机的 [zcode-executor](../../../../zcode-executor)（Claude Code 当工头、
本机 ZCode（GLM）当执行端的派单执行器）接进 DSH。
智能体教学 + 观察面板两件事：

1. **派单教学**——SKILL.md 软链进 `~/.dsh/skills/` 教 DSH 智能体完整走派单流程（写任务单、建执行副本、
   `new` / `send --task` / 验收、合并），再往 system prompt 挂两三句公告提醒通道存在与「挂起必转交用户」的红线。
2. **观察面板**——官方右侧栏「zcode 任务」tab，实时显示当前项目的各条 zcode 会话：待处理（挂起/中断）、
   执行中（最新回复按 Markdown 渲染、正在跑的工具、闲时排队）、已结束三段，约 1 秒内自动刷新、零额度。
3. **边界不变**——面板只看不应答：没有 approve / deny / answer 控件，挂起仍由派单的智能体在对话里转交用户。

数据来自服务端常驻的 `zcode-executor watch --json` 子进程，经插件自己的 NDJSON 流路由推给客户端；
与 zcode-executor 仓库的唯一耦合面是这条行协议（见 [架构](#架构一览)）。

> 本文写给拿到这个包、要装它或继续开发它的下一个会话。规格全文在 [SPEC.md](SPEC.md)（含测试决定与边界），
> 任务与检查点在 [tasks/plan.md](tasks/plan.md) + [tasks/todo.md](tasks/todo.md)。

## 安装

v1 只以 `link:` 装本机 desktop profile 本地使用，**不发 npm**。装法（手工两处登记）：

1. `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 加：

   ```json
   "dsh-zcode-executor": "link:/Volumes/MacData/projects/dsh-plugins/plugins/dsh-zcode-executor"
   ```

2. **同一文件**里的 `dsh.profile.bundles` 数组追加 `"dsh-zcode-executor"`（数组里原有的项别动）。
   **bundles 不加、只装包等于没启用**——profile 加载器只挂 bundles 列表里的包，手工 `pnpm install`
   只会装包不会启用（`dsh plugin` 命令和 App 插件页会自动追加这一项；CLI 拒绝 `--profile desktop`，
   桌面端要么 App 插件页装，要么照上面手工改）。
3. 插件目录里装依赖并构建：

   ```sh
   cd /Volumes/MacData/projects/dsh-plugins/plugins/dsh-zcode-executor
   pnpm install
   npm run build   # tsc 两套 tsconfig + build-client.mjs 内联打包客户端，产物 lib/ 入库
   ```

4. 重启 DSH 桌面端（改插件代码后同样）：

   ```sh
   osascript -e 'quit app "DeepSeek Harness"' && open -a "DeepSeek Harness"
   ```

5. 到插件页确认行 `dsh-zcode-executor` 为 active。首次加载会幂等建软链
   `~/.dsh/skills/zcode-executor` → 包内 `skills/zcode-executor`（被同名异物占着时只 warn 不覆盖，
   手动移走占名者再重载插件行即可）。

**卸载**：从上面两处各删一行 → `pnpm install` → 重启。插件行 dispose 时会摘掉仍指向本包的 skill
软链（别人的文件/链接一律不碰），不留坏链。

## 配置

设置页里本插件三个字段，**改动经行热重载生效，不用重启宿主**（`src/reload.ts` 的指纹守卫：
监听 `loader/volatile-update` 事件 + 2 秒轮询兜底，解析值变了就 `fiber.restart` 重载插件行，
watch 进程与路由随之用新配置重建）：

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `execPath` | PATH 里的 `zcode-executor` | watch CLI 的可执行路径。配错了不重试，进 `failed` 态（见[故障排查](#故障排查)） |
| `watchMode` | `always` | `always`：插件行加载即 spawn watch，常驻到行卸载；`on-demand`：按 stream 路由的活跃连接数起停（没人开面板就不跑进程） |
| `announceToAgent` | 开 | system prompt 派单公告开关。关闭后智能体少一段提示，SKILL.md 教学仍可用（公告与软链同走行重载，不精细到只撤公告） |

## 架构一览

```
zcode-executor watch --json（子进程，stdout NDJSON 行协议）
        │  hello / session / synced / removed
        ▼
服务端 lib/index.js（Node 半场）
  WatchProcess：逐行解析进快照表；synced 前退出 = failed 不重试，之后退出 = down、5 秒重起
  三路由（全部先过 connection.admit，非 GET 一律 405 + Allow: GET）：
    GET /zcode-executor/stream    NDJSON 推送（连接态行 + watch 原始行；已同步的新客户端先补一轮全量）
    GET /zcode-executor/snapshot  一次性全量快照（轮询兜底）
    GET /zcode-executor/repo?cwd=…  按 git 共同数据目录判所属仓库，进程内缓存
        │  fetch（同源带 cookie）
        ▼
客户端 lib/client.js（浏览器半场，官方右栏 API）
  store：流式读 stream（首响应 15 秒闹钟），断流退 snapshot 1 秒轮询 + 3 秒重试流
  当前项目：主会话 cwd（retainedBy.mainView）→ 无会话退工作区路径 → repo 路由换过滤仓库
  pane：「zcode 任务」tab（sidebarRightTabs.register + sidebar.right.pane.tab 槽位），三段渲染
```

**行协议契约**：`zcode-executor watch --json` 的 NDJSON（hello / session / synced / removed，
快照字段表见 zcode-executor 仓库 PRD 第 4 节）。协议只加字段不改含义，插件对缺字段容错降级
（如旧 CLI 无 `replyMarkdown` 时回退 `reply` 逐行）。两个仓库各自独立发版，互不锁版本。

服务端缺 `webServer` / `connection` 服务的宿主组合（如 Electron 无 web 半场）里，路由与 watch
经 `ctx.inject` 惰性注入——整块不挂载但插件照常加载；客户端遇老版本 DSH 没有 `sidebarRightTabs`
服务时同理，只 console 一行说明、tab 不挂载。

## 开发与测试

```sh
node --test "test/*.test.mjs"   # 85 用例，零额度：纯逻辑层直读 src/*.ts（靠 Node 类型剥离，
                                # 本机 v22.22.3 实测可用），服务端半场用 fake ctx + 桩 watch
                                # 脚本（test/fixtures/stub-watch.mjs）
npm run build                   # 产出 lib/（入库）
npm run verify                  # 两套 tsconfig --noEmit
```

测试不建 DSH 会话、不发消息（dsh-plugins 仓库纪律）。测试缝的选取与先例见 SPEC「Testing Decisions」。

## 验收与检查点索引

检查点全表在 [tasks/plan.md](tasks/plan.md)：**检查点 A**（T1 后，装入冒烟）、**检查点 B**
（T5 后，真机 C1–C5、C7）、**检查点 C**（T8 后，真机 C1–C10 全量；C9 智能体真实派单是唯一花额度
步骤，需用户在场）。真机检查点细目（C1–C10）在 SPEC「Testing Decisions」末尾。

**当前状态（2026-10-07）**：T1–T5、T7–T9 完成（87 用例全绿、构建与 verify 绿、服务端真跑实测
首轮 244 行 1.0s 内齐）；T6 机器侧完成（`npm run preview` 真实渲染预览 + mockup 并排比对修掉四处差异，
深浅主题截图复验过）；**A/B/C 的真机检查点均待验收**（需重启 DSH 桌面端后人工过；已测部分见
tasks/todo.md 末尾备注）。真实使用前请先过检查点 C。

## 故障排查

| 现象 | 含义与处理 |
| --- | --- |
| 面板顶部横幅「实时连接中断，正在重试」（down） | watch 进程断了，服务端 5 秒自动重起、起好即恢复；客户端同时退 1 秒轮询兜底，恢复后不补弹断连期间的变化。持续不去：到终端 `pgrep -f "zcode-executor watch"` 看进程是否反复死 |
| 面板横幅为 failed 态（「起不来」类说明 + 指引） | watch 在首轮同步完成前就退出（多半 `execPath` 配错或 CLI 不在 PATH），**不重试**——重试也一样起不来。修法：设置页把 `execPath` 改对（存盘即热重载，watch 用新路径重起）。GUI 启动的宿主连 node 都不在 PATH，全局安装 + 落回 PATH 救不了——见下节「execPath 与 GUI 宿主的 PATH」 |
| 横幅「无权访问（admit 拒绝）：本机登录态可能已失效，重新登录 DSH 后自动恢复」（snapshot 回 401/403） | 传输其实是通的，病根在鉴权：重新登录 DSH 即可，下一轮轮询自动恢复，不用动插件配置 |
| 插件页行为 active 但右栏没有「zcode 任务」tab | 宿主缺 `sidebarRightTabs` 服务（DSH 版本过老），客户端 console 有一行说明；本插件 peer 钉 `^0.1.7-rc.2 || ^0.2.0-rc.1`，升 DSH 后重核 |
| `~/.dsh/skills/zcode-executor` 没建出来 / 智能体不会派单 | 插件页或宿主日志找 `[dsh-zcode-executor]` 的 warn：建链失败（不致命）或路径被别人占着（foreign，手动移走占名者再重载插件行） |
| 面板数据停着不动但横幅没报错 | watch 空闲时本来就无行（没有会话在跑）；确认 zcode 侧确有活跃会话，或切「全部项目」看是否过滤仓库判错 |

**execPath 与 GUI 宿主的 PATH**：从 Dock/Finder 启动的 DSH，进程 PATH 通常只有
`/usr/bin:/bin:/usr/sbin:/sbin`——既找不到全局安装的 `zcode-executor`，CLI shebang
`#!/usr/bin/env node` 要找的 node 也不在里面（面板报 `spawn zcode-executor ENOENT`
多半卡在这一层，`npm install -g` 后清空 execPath 救不了）。可靠的修法：做一个不依赖
PATH 的包装脚本（node 与 CLI 全写绝对路径、`chmod +x`），`execPath` 填它的绝对路径：

```sh
#!/bin/sh
exec /绝对路径/node /仓库绝对路径/bin/zcode-executor "$@"
```

（本机 2026-10-07 验收时即按此打通，示例在 `~/.local/bin/zcode-executor`，node 用
`~/.local/bin/node`、CLI 用 `/Volumes/MacData/projects/zcode-executor/bin/zcode-executor`。）

## 已知边界

- **面板只看不应答**：挂起的审批请求 / 提问由派单的智能体在对话里转交用户，面板与插件其他部分
  都没有任何应答控件。要改这条边界等于改 zcode-executor 的闸门设计，是另立决定的事（SPEC「Out of Scope」）。
- **v1 纯中文**：文案写死中文，locale 管线留了接口不填字典。
- **不发 npm**：v1 只 `link:` 装本机 desktop profile。要公开分发时照 zen-remote 补 Trusted
  Publishing 流水线，见下方[发布前 checklist](#发布前-checklist)。
- **视觉精修（T6）待真机反馈**：信息架构与 CC mod 对齐、mockup/pane.html 是版式基准，但图标映射表、
  密度与两主题的逐项核对要真机上人工过。
- 已结束列表至多 20 条：结束 30 分钟内成卡片，更久缩为一行（行可点开成卡片看回复、卡片「收起」收回）；回复折叠复刻 CC mod 语义——有内容的行不超过两行整段 Markdown 直接显示，超过则默认收起前两行、点「展开回复」看全文（2026-10-07 晚修复：当日早先的「一律收一行」规格下，单段无换行的回复与执行中每条新消息的开头会被 CSS 整个藏掉，面板上完全看不到）。面板不弹 toast、不做 tab 角标（官方注册面没有徽标字段）。
- 面板显示的回复是 watch 快照里的最新一条消息（执行中随回合推进、已结束为最终回复），**不是**完整会话历史；要看全文去派单的对话或 zcode 侧。已结束卡显示「最终回复」依赖 zcode-executor ≥0.4.5 在 last.json 落的 `lastMessageText`（2026-10-07 起本机工作树已带、存量已回填）；旧版 CLI 没这字段时回退整回合拼接文本，插件侧无需改动。

## 发布前 checklist

- [ ] `skills/zcode-executor/SKILL.md` 里硬编码的本机 CLI 绝对路径
      （`/Volumes/MacData/projects/zcode-executor/bin/zcode-executor`，SKILL.md 第 11 行附近）
      改成可推导写法：保留 `command -v zcode-executor` 探测，绝对路径示例改为
      `npm root -g` / `npm prefix -g` 推导或让用户按自己的安装位置填，删去本机卷路径。
- [ ] `package.json` 补 `repository` 字段（现有 `license: MIT`、`description` 双语已就位）。
- [ ] 发 npm 时照 zen-remote 补：`.github/workflows/publish.yml`（Trusted Publishing，OIDC）、
      版本同步脚本、两份 README 的徽章；`files` 字段已含 `lib/ src/ scripts/ skills/ cordis.patch.yml`。
- [ ] 发 npm 前按 Apache-2.0 §4 处理衍生件：`src/client/view.ts` 与 `skills/zcode-executor/SKILL.md`
      按 Apache-2.0 授权（见 LICENSE 末尾授权说明），随包携带 Apache 许可证全文
      （如 `LICENSE.apache-2.0` 并入 `files`），两件文件头部的 SPDX 标注保持完整。
- [ ] 依赖 DSH 版本重核：peer 范围 `^0.1.7-rc.2 || ^0.2.0-rc.1` 在 DSH 0.3 发布时按官方
      兼容核查方法重跑（SPEC「Further Notes」），必要时 `dsh plugin allow-version` 豁免。
- [ ] zcode-executor 仓库侧的关联文档改动（其 README 提及 DSH 插件、CONTEXT.md「观察面板」
      词条从「Claude Code 里」泛化为「宿主界面里」）随其下次发版一起做（交接已登记在其仓库本地记录）。
