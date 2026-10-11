import type { ReactNode } from 'react';
/** 右栏 tab 的实现 id（官方要求跨注册唯一，包名前缀）；kind 同 id（页面类型按 kind 打开）。 */
export declare const TAB_ID = "zcode-executor:tasks";
export declare const TAB_KIND = "zcode-executor:tasks";
/** tab 标题与菜单条目文案。 */
export declare const TAB_TITLE = "zcode \u4EFB\u52A1";
export declare const TAB_DESCRIPTION = "\u672C\u673A zcode-executor \u4F1A\u8BDD\u7684\u5B9E\u65F6\u89C2\u5BDF\u9762\u677F";
/** guide 条目在菜单里的位置：排在宿主自己的条目（files/changes 等 10–30 段）之后。 */
export declare const TAB_GUIDE_ORDER = 50;
/** guide 条目图标的结构镜像（primitives IconProps 的用到的子集；better-sidebar 同款镜像法）。 */
export interface GuideIconLike {
    (props: {
        size?: number | undefined;
    }): ReactNode;
}
/**
 * tab 类型定义（纯数据）：页面类型（无 patterns，按 kind 打开），extension 段最高优先。
 * guide 条目的 id 按官方要求在提供方内唯一（DSH 0.1.6-alpha.2 起必填）。
 * @param icon - 菜单条目的 glyph（接线层给 TabGlyph；测试可不传，条目退宿主方块占位）。
 * @returns 可直接交给 sidebarRightTabs.register 的定义。
 */
export declare function tabDefinition(icon?: GuideIconLike): {
    id: string;
    kind: string;
    priority: 'extension';
    title: (address: string) => string;
    guide: Array<{
        id: string;
        order: number;
        title: () => string;
        description?: () => string;
        icon?: GuideIconLike;
    }>;
};
/**
 * 到点仍未注册上时的说明行：true（已注册）给 null，false 给一行 console 说明。
 * @param registered - sidebarRightTabs 服务到点前是否完成过注册。
 * @returns 说明文字或 null。
 */
export declare function missingServiceNote(registered: boolean): string | null;
//# sourceMappingURL=tab-def.d.ts.map