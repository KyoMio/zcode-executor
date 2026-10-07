/**
 * skill 软链：把包内 skills/zcode-executor 暴露成 ~/.dsh/skills/zcode-executor。
 *
 * rc.6 宿主不消费包的 dsh.skills 声明（dsh-llm-verifier 实测 2026-08-19：skill 发现是
 * dsh-skill-filesystem 扫目录根，~/.dsh/skills、~/.agents/skills），所以插件自己维护这条
 * 幂等软链。先例是 dsh-llm-verifier src/index.ts 的 ensureSkillLink，本文件在其上多两条：
 * - 占名者不指向本包时 console.warn 说明（用户排障要看得见 skill 为什么没生效），不覆盖不抛；
 * - fiber dispose 时把仍指向本包的链接移除（包卸载/搬走后留一条死链不如不留）；
 *   别人的文件/链接一律不碰。
 * 全部失败都非致命：skill 是派单教学材料，不是任何功能的前置依赖。
 */
/**
 * ensureSkillLink 对 ctx 的全部要求：能挂 effect（真 ctx 是 cordis Context，
 * 这里只要结构面，测试用收 disposer 的假 ctx 即可）。
 */
export interface EffectHost {
    effect(execute: () => (() => unknown) | Promise<() => unknown>, label?: string): unknown;
}
/** ensure 的结论：新建 / 本来就是本包的链 / 名字被别人占了 / 建链失败（已 warn）。 */
export type SkillLinkOutcome = 'created' | 'existing' | 'foreign' | 'error';
/** ensureSkillLink 的返回：两条路径加结论，给测试与状态路由用。 */
export interface SkillLinkHandle {
    /** 软链本身：`<dshHome>/skills/zcode-executor`。 */
    linkPath: string;
    /** 链接指向的包内 skill 目录（绝对路径）。 */
    target: string;
    outcome: SkillLinkOutcome;
}
/** 软链落在哪个 DSH 主目录：DSH_HOME 优先（测试与多 profile 用），缺省 ~/.dsh（llm-verifier 同款）。 */
export declare function defaultDshHome(): string;
/**
 * 幂等建链并挂 dispose。已存在且指向本包 → 不动；指向别处或是普通文件/目录 →
 * console.warn 后保留原样；不存在 → 新建。dispose（fiber 卸载时跑）只移除
 * 仍指向本包的链接。任何异常都吞成 warn，绝不向上抛。
 */
export declare function ensureSkillLink(ctx: EffectHost, dshHome?: string): Promise<SkillLinkHandle>;
//# sourceMappingURL=skill-link.d.ts.map