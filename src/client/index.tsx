/**
 * dsh-zcode-executor，浏览器半场。
 *
 * apply 里四件事（生命周期全部挂本 fiber，插件卸载级联清掉）：
 * 1. 样式：模板字符串 CSS 一次注入 <style data-plugin="dsh-zcode-executor">（zen-remote 同款）；
 * 2. 数据：createSnapshotStore（baseUrl 同源根，路由常量与 store.ts 对齐）并 start；
 * 3. 范围与侧（PB-6）：订阅 ctx.sessions.list / ctx.workspaces.list，派生当前主会话 id 与
 *    cwd——id 交给 store.setSession（侧变化在 store 内部重开流：远程会话的取数带
 *    `?sessionId=` 由 zen-remote 插件桥改道到主服务端，本机/无会话不带）；repo 路由主会话
 *    存在时按 sessionId 解析（服务端用会话 cwd 判仓库），无主会话退工作区路径 `?cwd=`——
 *    失败或 repo 为 null 时 scope 为 null = 显示全部并在面板注明；
 * 4. 右栏：registerTasksTab 挂官方「zcode 任务」tab（register-tab.ts，含老宿主降级）。
 * 面板只看不应答：本半场不注册任何 approve/deny/answer 控件（AGENTS.md 硬边界）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, isUnbridgedResponse, REPO_PATH } from './store.ts'
import { mainSessionIdOf, pickWorkspacePath } from './session-cwd.ts'
import { registerTasksTab } from './register-tab.ts'
import { PANE_CSS } from './pane/styles.ts'

/** 客户端半场插件名（与 host 半场同名的包标识，自研插件惯例）。 */
export const name = 'dsh-zcode-executor'

/** 需要的客户端服务：slots 挂槽位；sessions/workspaces 派生当前项目的过滤仓库。 */
export const inject = ['slots', 'sessions', 'workspaces']

/** 同源根：路由常量都以前导斜杠写死（store.ts 与 src/routes.ts 两处复制，测试防漂移）。 */
const BASE_URL = ''

/**
 * 「当前项目」变化时的换仓动作（PB-6）：调 repo 路由解析所属仓库进 store。主会话存在时
 * 按 `?sessionId=<主会话 id>` 解析（服务端用该会话的 cwd 判仓库；远程会话由插件桥转发到
 * 主服务端解析，本地会话 id 原样到本机路由），无主会话退回工作区路径 `?cwd=`。
 * 解析失败 / 不是 git 仓（repo null）/ 两者都没有 → scopeRepo 置 null，
 * 面板显示全部并注明（SPEC 用户故事 14 的另一面）。
 * @param isCurrent - 代际守卫：dispose 或换了新会话之后，旧回应不得倒拨新 scope。
 */
async function routeScopeRepo(
  store: ReturnType<typeof createSnapshotStore>,
  target: { sessionId: string } | { cwd: string } | null,
  isCurrent: () => boolean,
): Promise<void> {
  if (target === null) {
    if (isCurrent()) store.setScopeRepo(null);
    return;
  }
  const query =
    'sessionId' in target
      ? `sessionId=${encodeURIComponent(target.sessionId)}`
      : `cwd=${encodeURIComponent(target.cwd)}`;
  try {
    const res = await fetch(`${BASE_URL}${REPO_PATH}?${query}`);
    if (isUnbridgedResponse(res)) {
      // 未桥接：面板横幅已有原因文案（store 侧合成），repo 解析不到是同一件事的另一半，
      // 不再打「解析失败」warn 重复报障（PB-7b）；scope 照失败路径落到「显示全部」。
      if (isCurrent()) store.setScopeRepo(null);
      return;
    }
    if (!res.ok) throw new Error(`repo HTTP ${res.status}`);
    const body = (await res.json()) as { repo?: unknown };
    if (!isCurrent()) return;
    store.setScopeRepo(typeof body.repo === 'string' && body.repo !== '' ? body.repo : null);
  } catch (error) {
    if (!isCurrent()) return;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[zcode-executor] 解析当前项目所属仓库失败，面板显示全部：${message}`);
    store.setScopeRepo(null);
  }
}

/**
 * 浏览器半场入口。ctx.slots 由 renderer 提供、ctx.sessions/ctx.workspaces 由宿主控制器提供
 * （类型来自两个 controller 包的 /client 声明，文件尾的纯类型引入）。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: Context): void {
  // 构建号：真机排障用（宿主模块缓存按应用会话发旧 bundle，2026-10-07 连续两轮踩坑）——
  // devtools Console 里一眼核对跑的是哪版；改动记号见 git/构建时间，格式 YYYYMMDD-HHMM。
  console.info('[zcode-executor] 面板构建 20261010-1200（插件桥：远程会话看主服务端任务）');
  // 面板数据 store：每插件激活一份；start/stop 跟 fiber 走，状态不清（重载后面板保留旧数据
  // 直到流重连，重连首轮按基线对齐——归约器语义）。侧切换的清屏重开在 store.setSession 里。
  const store = createSnapshotStore({ baseUrl: BASE_URL });
  ctx.effect(() => {
    store.start();
    return () => {
      store.stop();
    };
  }, 'zcode-executor: snapshot store');

  // 样式：apply 时一次注入（ zen-remote 同款）；dispose 时随 style 标签移除。
  ctx.effect(() => {
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-zcode-executor';
    tag.textContent = PANE_CSS;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, 'zcode-executor: pane styles');

  // 当前项目 → 数据侧与过滤仓库：两个目录都可观察，任一变化就重派生。主会话 id 变化时
  // store.setSession（侧变化重开流、同侧只换参数）；repo 的变化检测键是「主会话 id，无
  // 主会话退工作区路径」——repo 路由进程内有缓存，但这挡得住客户端侧的重复请求。
  ctx.effect(() => {
    let lastKey: string | null = null;
    let routed = false; // 首轮即使键是 null 也要把 scope 落到「显示全部」
    let sequence = 0; // 在途请求的代际号：dispose 或换会话后，旧回应不得倒拨新 scope
    const rederive = (): void => {
      // 直接传参（不提中间变量）：rows 的宿主类型经参数位置的上下文推断对上 SessionRowLike
      const sessionId = mainSessionIdOf(Object.values(ctx.sessions.list.getSnapshot().byId));
      // 侧判定与重开在 store 内部（与本 effect 的 repo 代际互不干扰）
      store.setSession(sessionId);
      // repo 的目标：主会话在 → sessionId 分支（服务端按会话 cwd 判仓库）；不在 → 退
      // 现有的工作区路径 cwd 分支。变化检测键同理：主会话 id 优先，无主会话用工作区路径。
      const workspaceCwd = sessionId !== null ? null : pickWorkspacePath(ctx.workspaces.list.getSnapshot().items);
      const target = sessionId !== null ? { sessionId } : workspaceCwd !== null ? { cwd: workspaceCwd } : null;
      const key = sessionId ?? workspaceCwd;
      if (routed && key === lastKey) return; // 无变化不重路由，也不作废在途请求
      const mine = ++sequence;
      lastKey = key;
      routed = true;
      void routeScopeRepo(store, target, () => mine === sequence);
    };
    const unsubscribeSessions = ctx.sessions.list.subscribe(rederive);
    const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(rederive);
    rederive();
    return () => {
      sequence++; // 在途的 routeScopeRepo 回应作废
      unsubscribeSessions();
      unsubscribeWorkspaces();
    };
  }, 'zcode-executor: scope repo');

  // 官方右栏「zcode 任务」tab（两段注册 + 老宿主降级说明，见 register-tab.ts）。
  registerTasksTab(ctx, store);
}

// 纯类型引入，只把声明合并拉进本程序、不产生运行时代码：
// renderer/client 把 ctx.slots（SlotRegistry）声明到 cordis Context 上；
// sidebar-right/client 声明 sidebarRightTabs 服务与右栏槽位（register-tab.ts 也要）；
// 两个 controller/client 分别声明 ctx.sessions 与 ctx.workspaces。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
