/**
 * 插件行收到的配置：schema（设置页字段表）与读取时的解析。
 * 从 src/index.ts 抽出（Task 3 起 index.ts 的 apply 要读它），公共导出面仍在 index.ts 转发。
 */

import z from '@deepseek-ai/schemastery'

/** 插件行收到的配置（loader 转交后的形状）。 */
export interface RowConfig {
  /** watch CLI 的可执行路径，缺省从 PATH 找 `zcode-executor`。 */
  execPath?: unknown
  /** watch 拉起模式：always（常驻，默认）/ on-demand（按流订阅计数起停）。 */
  watchMode?: unknown
  /** 是否往 system prompt 挂派单公告（Task 7）。 */
  announceToAgent?: unknown
}

/**
 * loader 的 Config schema：设置页的字段表。两条硬规则（照 dsh-zen-remote
 * src/config.ts 的结论）：
 * 1. 全字段 `z.any()` 是故意的——schemastery 类型不符会让 loader 丢弃整行、
 *    插件根本不加载；合法性校验归读取处（resolveWatchSettings）管，schema 只
 *    告诉设置页「有哪些字段」。
 * 2. 全字段 `.volatile()` 不是优化而是必须——DSH 的设置服务只给 volatile
 *    字段渲染表单，非 volatile 字段在设置页不可见、存不了。代价是 apply
 *    收到的是 `{ get() }` 现场引用而不是值：读值必须现场解包（unwrapVolatile）。
 *
 * 不写 `.default()`：schema 默认值会在加载时写进每一行，配置里的缺省语义
 * （如 execPath 落回 PATH）由 resolveWatchSettings 兜底。
 */
export const Config = z.object({
  execPath: z.any().volatile(),
  watchMode: z.any().volatile(),
  announceToAgent: z.any().volatile(),
})

/**
 * 剥掉 loader 包在 volatile 字段外面的 `{ get() }` 引用（duck-typing，照
 * dsh-zen-remote src/config.ts 的 unwrapVolatile）；不是包装就原样通过。
 */
export function unwrapVolatile(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get: () => unknown }).get()
  }
  return value
}

/** apply 时从行配置解出的三项设置。任一项变更都经 src/reload.ts 的指纹守卫重载插件行（Task 8 ①）。 */
export interface WatchSettings {
  /** watch CLI 路径：配置给了非空字符串就用它，否则落回 PATH 里的 `zcode-executor`。 */
  execPath: string
  watchMode: 'always' | 'on-demand'
  /** 派单公告开关：默认开，显式 false 才关（Task 7 的 systemPrompt.section 消费）。 */
  announceToAgent: boolean
}

/** 行配置 → 设置。垃圾进/缺省出：execPath 非字符串或空串落回默认，watchMode 只认字面 'on-demand'。 */
export function resolveWatchSettings(config: RowConfig): WatchSettings {
  const execPath = unwrapVolatile(config.execPath)
  const watchMode = unwrapVolatile(config.watchMode)
  const announceToAgent = unwrapVolatile(config.announceToAgent)
  return {
    execPath: typeof execPath === 'string' && execPath.trim() ? execPath.trim() : 'zcode-executor',
    watchMode: watchMode === 'on-demand' ? 'on-demand' : 'always',
    announceToAgent: announceToAgent !== false,
  }
}
