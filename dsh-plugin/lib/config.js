/**
 * 插件行收到的配置：schema（设置页字段表）与读取时的解析。
 * 从 src/index.ts 抽出（Task 3 起 index.ts 的 apply 要读它），公共导出面仍在 index.ts 转发。
 */
import z from '@deepseek-ai/schemastery';
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
});
/**
 * 剥掉 loader 包在 volatile 字段外面的 `{ get() }` 引用（duck-typing，照
 * dsh-zen-remote src/config.ts 的 unwrapVolatile）；不是包装就原样通过。
 */
export function unwrapVolatile(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
/** 行配置 → 设置。垃圾进/缺省出：execPath 非字符串或空串落回默认，watchMode 只认字面 'on-demand'。 */
export function resolveWatchSettings(config) {
    const execPath = unwrapVolatile(config.execPath);
    const watchMode = unwrapVolatile(config.watchMode);
    const announceToAgent = unwrapVolatile(config.announceToAgent);
    return {
        execPath: typeof execPath === 'string' && execPath.trim() ? execPath.trim() : 'zcode-executor',
        watchMode: watchMode === 'on-demand' ? 'on-demand' : 'always',
        announceToAgent: announceToAgent !== false,
    };
}
//# sourceMappingURL=config.js.map