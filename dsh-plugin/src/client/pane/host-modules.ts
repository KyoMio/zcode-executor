// src/client/pane/host-modules.ts —— 宿主浏览器模块表（window.__ModuleLoader__ 的 require）
// 的运行时探测：@deepseek-ai/dsh-client-ui-primitives 里的 MarkdownText。
//
// 为什么 require 而不静态 import：primitives 是 0.1.7/0.2.0 两版宿主都静态播种的平台词
// （2026-10-07 在 0.2.0-rc.2 的 dsh-web-frontend 启动脚本 rM() 里核实，zen-remote 的
// check-client-externals 白名单亦证），静态 import 本可成立；但按 T5 要求两条路都留——
// require 放进 try/catch，宿主模块表真拿不到时探测得 null、面板全部走自绘降级，插件不崩。
// 探测函数（pickComponent / pickMarkdownText）是纯函数，node --test 直接喂数据断言。
// （图标探测 pickIcon 曾在此，2026-10-07 撤除——真机两族图标光学大小不一，面板图标统一
// 自绘，见 icons.tsx 头注。）
//
// 浏览器端 require 的来源：客户端 bundle 被 build-client.mjs 包进
// __ModuleLoader__.load({ factory: (require) => ... })，工厂参数就是模块表取词器；
// 本文件顶层声明它只为过 tsc，运行时用工厂作用域里的那个。
import type { ReactNode } from 'react';

/** 宿主模块表取词器的形状（只需字符串索引）。 */
declare const require: (id: string) => unknown;

/** 探测到的 primitives 模块（null = 模块表没有它，全部自绘/自渲）。 */
let hostPrimitives: Record<string, unknown> | null = null;
try {
  hostPrimitives = require('@deepseek-ai/dsh-client-ui-primitives') as Record<string, unknown>;
} catch {
  hostPrimitives = null; // 老宿主没有 primitives：面板退化为自绘图标与自绘 Markdown
}

/**
 * 从模块对象里认一个「可渲染成 React 元素」的组件：函数组件直接认；
 * React.memo 的返回是带 $$typeof 的对象，认它的 type 是函数。
 * @param mod - 模块对象（可能是 null 或任何未知形状）。
 * @param name - 导出名。
 * @returns 组件本体，认不出时 null。
 */
export function pickComponent(mod: unknown, name: string): ((props: never) => unknown) | null {
  if (typeof mod !== 'object' || mod === null) return null;
  const value = (mod as Record<string, unknown>)[name];
  if (typeof value === 'function') return value as (props: never) => unknown;
  if (typeof value === 'object' && value !== null) {
    const memo = value as { type?: unknown };
    if (typeof memo.type === 'function') return memo.type as (props: never) => unknown;
  }
  return null;
}

/** 宿主 MarkdownText 组件的最小 props 镜像（@deepseek-ai/dsh-client-ui-primitives MarkdownText）。 */
export interface HostMarkdownTextProps {
  text: string;
  labels: { code: { copyLabel: string; copiedLabel: string }; footnotes: string };
  variant?: 'body' | 'compact';
}

/** 宿主 MarkdownText 组件类型（探测成功才有值）。 */
export type HostMarkdownText = (props: HostMarkdownTextProps) => ReactNode;

/**
 * 探测宿主 MarkdownText（memo 包装的导出）。
 * @param mod - 待探测的模块对象。
 * @returns 组件，拿不到时 null（调用方走自绘轻量渲染）。
 */
export function pickMarkdownText(mod: unknown): HostMarkdownText | null {
  return pickComponent(mod, 'MarkdownText') as HostMarkdownText | null;
}

/** 当前宿主环境探测到的 primitives 模块（可能为 null）。 */
export function hostModules(): Record<string, unknown> | null {
  return hostPrimitives;
}
