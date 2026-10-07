/**
 * dsh-zcode-executor，浏览器半场。
 *
 * apply 里四件事（生命周期全部挂本 fiber，插件卸载级联清掉）：
 * 1. 样式：模板字符串 CSS 一次注入 <style data-plugin="dsh-zcode-executor">（zen-remote 同款）；
 * 2. 数据：createSnapshotStore（baseUrl 同源根，路由常量与 store.ts 对齐）并 start；
 * 3. 范围：订阅 ctx.sessions.list / ctx.workspaces.list，派生当前主会话 cwd（无会话退
 *    工作区路径，session-cwd.ts），cwd 变化时调 repo 路由换过滤仓库进 store.setScopeRepo——
 *    失败或 repo 为 null 时 scope 为 null = 显示全部并在面板注明；
 * 4. 右栏：registerTasksTab 挂官方「zcode 任务」tab（register-tab.ts，含老宿主降级）。
 * 面板只看不应答：本半场不注册任何 approve/deny/answer 控件（AGENTS.md 硬边界）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, REPO_PATH } from './store.ts'
import { mainSessionCwdOf, pickWorkspacePath } from './session-cwd.ts'
import { registerTasksTab } from './register-tab.ts'
import { PANE_CSS } from './pane/styles.ts'

/** 客户端半场插件名（与 host 半场同名的包标识，自研插件惯例）。 */
export const name = 'dsh-zcode-executor'

/** 需要的客户端服务：slots 挂槽位；sessions/workspaces 派生当前项目的过滤仓库。 */
export const inject = ['slots', 'sessions', 'workspaces']

/** 同源根：路由常量都以前导斜杠写死（store.ts 与 src/routes.ts 两处复制，测试防漂移）。 */
const BASE_URL = ''

/**
 * 「当前项目」cwd 变化时的换仓动作：调 repo 路由解析所属仓库进 store。
 * 解析失败 / 不是 git 仓（repo null）/ 没有 cwd 可派生 → scopeRepo 置 null，
 * 面板显示全部并注明（SPEC 用户故事 14 的另一面）。
 * @param isCurrent - 代际守卫：dispose 或换了新 cwd 之后，旧回应不得倒拨新 scope。
 */
async function routeScopeRepo(
  store: ReturnType<typeof createSnapshotStore>,
  cwd: string | null,
  isCurrent: () => boolean,
): Promise<void> {
  if (cwd === null) {
    if (isCurrent()) store.setScopeRepo(null);
    return;
  }
  try {
    const res = await fetch(`${BASE_URL}${REPO_PATH}?cwd=${encodeURIComponent(cwd)}`);
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
  console.info('[zcode-executor] 面板构建 20261007-1500（安全网提速+告警、no-store 版）');
  // 面板数据 store：每插件激活一份；start/stop 跟 fiber 走，状态不清（重载后面板保留旧数据
  // 直到流重连，重连首轮按基线对齐——归约器语义）。
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

  // 当前项目 → 过滤仓库：两个目录都可观察，任一变化就重派生 cwd，cwd 真变了才调 repo 路由
  // （repo 路由自带进程内缓存，但这挡得住客户端侧的重复请求）。
  ctx.effect(() => {
    let lastCwd: string | null = null;
    let routed = false; // 首轮即使 cwd 是 null 也要把 scope 落到「显示全部」
    let sequence = 0; // 在途请求的代际号：dispose 或换 cwd 后，旧回应不得倒拨新 scope
    const rederive = (): void => {
      const cwd = mainSessionCwdOf(Object.values(ctx.sessions.list.getSnapshot().byId))
        ?? pickWorkspacePath(ctx.workspaces.list.getSnapshot().items);
      if (routed && cwd === lastCwd) return; // 无变化不重路由，也不作废在途请求
      const mine = ++sequence;
      lastCwd = cwd;
      routed = true;
      void routeScopeRepo(store, cwd, () => mine === sequence);
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
