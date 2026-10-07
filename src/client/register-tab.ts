// src/client/register-tab.ts —— 官方右栏接入（两段注册，SPEC 客户端半场）：
//   1. 类型：ctx.sidebarRightTabs.register({ id, kind, priority: 'extension', title, guide })；
//   2. 本体：sidebar.right.pane.tab 槽位按 key = 类型 id 挂 pane/index.tsx 的 Body。
// 注册面与生命周期对照 dsh-better-sidebar 的 native 接入（官方 API 的活样例）：sidebarRightTabs
// 是宿主（@deepseek-ai/dsh-client-ui-sidebar-right）在客户端 fiber 里提供的服务，本插件的
// 注册活在 ctx.inject(['sidebarRightTabs']) 的子 fiber 里——服务出现即注册、插件卸载随 fiber
// 级联清掉；槽位注入用 ctx.slots.inject（等宿主声明槽位，声明在服务之前，两者都会等到）。
// 老版本 DSH 没有 sidebarRightTabs：inject 永远等不到，到点 console 一行说明、整块不挂载，
// 插件其余部分照常（tab-def.ts 的 missingServiceNote，test/register-tab.test.mjs 断言）。
import type { Context } from '@deepseek-ai/cordis';
import { Body } from './pane/index.tsx';
import { TabGlyph } from './pane/icons.tsx';
import type { SnapshotStore } from './store.ts';
import { TAB_ID, missingServiceNote, tabDefinition } from './tab-def.ts';

// 纯类型引入：把 sidebar-right 对 cordis Context 的服务声明（sidebarRight/sidebarRightTabs）
// 与 SlotMap 的右栏槽位声明拉进本程序，不产生运行时代码。运行时不 require 那个包——
// 老版本 DSH 没有它，静态 require 会在模块表上炸掉整个 bundle。
import type {} from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';

/**
 * 注册右栏 tab 与本体槽位。挂载失败（比如插件重载时上下文已失活）把类型注册一并回滚，
 * 不留占死 id 的半挂载（better-sidebar 同款防守）。
 * @param ctx - 客户端根上下文。
 * @param store - 面板数据 store（T4），作为 Body 的业务面经槽位 inject 工厂下发。
 */
export function registerTasksTab(ctx: Context, store: SnapshotStore): void {
  let registered = false;
  ctx.inject(['sidebarRightTabs'], (inner) => {
    // inject 已等到了服务；运行时值仍不受类型标注约束，先认值再存（better-sidebar 同款镜像法）
    const tabs = inner.get('sidebarRightTabs') as typeof inner.sidebarRightTabs | undefined;
    if (tabs === undefined) return;
    let disposeType: () => void;
    try {
      disposeType = tabs.register(tabDefinition(TabGlyph));
    } catch (error) {
      // register 抛错只 console 一行、不 rethrow：cordis 会吞掉 fiber 里的异常，rethrow 等于
      // 无声失败；标志也不翻真，与下方 slots.inject 的 rollback 防守同款
      console.error('[dsh-zcode-executor] sidebarRightTabs.register 抛错，右侧栏「zcode 任务」不挂载', error);
      return;
    }
    registered = true;
    let disposeSlots: (() => void) | null = null;
    try {
      // keyed 槽：key = 类型 id（官方两段注册的第二段）；slots.inject 的效果活在
      // 本 inject 子 fiber 里，插件卸载自动级联；register 的业务面把 store 交给 Body。
      disposeSlots = inner.slots.inject('sidebar.right.pane.tab', () =>
        inner.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            inject: () => ({ store }),
          },
          Body,
        ),
      );
    } catch (error) {
      disposeType();
      throw error;
    }
    return () => {
      disposeSlots?.();
      disposeType();
    };
  });
  // 到点说明：到点前 registered 已翻真（服务出现并注册上）就不打印；说明措辞用「仍未出现」
  // 而非「宿主未提供」——慢宿主 10-15 秒才供上服务时，这行只是到点那刻的快照，不是版本确诊
  const timer = setTimeout(() => {
    const note = missingServiceNote(registered);
    if (note !== null) console.info(note);
  }, 10_000);
  ctx.effect(
    () => () => {
      clearTimeout(timer);
    },
    'zcode-executor: sidebar right fallback note',
  );
}
