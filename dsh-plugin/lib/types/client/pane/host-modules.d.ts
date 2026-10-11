import type { ReactNode } from 'react';
/**
 * 从模块对象里认一个「可渲染成 React 元素」的组件：函数组件直接认；
 * React.memo 的返回是带 $$typeof 的对象，认它的 type 是函数。
 * @param mod - 模块对象（可能是 null 或任何未知形状）。
 * @param name - 导出名。
 * @returns 组件本体，认不出时 null。
 */
export declare function pickComponent(mod: unknown, name: string): ((props: never) => unknown) | null;
/** 宿主 MarkdownText 组件的最小 props 镜像（@deepseek-ai/dsh-client-ui-primitives MarkdownText）。 */
export interface HostMarkdownTextProps {
    text: string;
    labels: {
        code: {
            copyLabel: string;
            copiedLabel: string;
        };
        footnotes: string;
    };
    variant?: 'body' | 'compact';
}
/** 宿主 MarkdownText 组件类型（探测成功才有值）。 */
export type HostMarkdownText = (props: HostMarkdownTextProps) => ReactNode;
/**
 * 探测宿主 MarkdownText（memo 包装的导出）。
 * @param mod - 待探测的模块对象。
 * @returns 组件，拿不到时 null（调用方走自绘轻量渲染）。
 */
export declare function pickMarkdownText(mod: unknown): HostMarkdownText | null;
/** 当前宿主环境探测到的 primitives 模块（可能为 null）。 */
export declare function hostModules(): Record<string, unknown> | null;
//# sourceMappingURL=host-modules.d.ts.map