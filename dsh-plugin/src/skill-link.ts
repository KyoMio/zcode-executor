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

import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readlink, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ensureSkillLink 对 ctx 的全部要求：能挂 effect（真 ctx 是 cordis Context，
 * 这里只要结构面，测试用收 disposer 的假 ctx 即可）。
 */
export interface EffectHost {
  effect(execute: () => (() => unknown) | Promise<() => unknown>, label?: string): unknown
}

/** ensure 的结论：新建 / 本来就是本包的链 / 名字被别人占了 / 建链失败（已 warn）。 */
export type SkillLinkOutcome = 'created' | 'existing' | 'foreign' | 'error'

/** ensureSkillLink 的返回：两条路径加结论，给测试与状态路由用。 */
export interface SkillLinkHandle {
  /** 软链本身：`<dshHome>/skills/zcode-executor`。 */
  linkPath: string
  /** 链接指向的包内 skill 目录（绝对路径）。 */
  target: string
  outcome: SkillLinkOutcome
}

/** 软链落在哪个 DSH 主目录：DSH_HOME 优先（测试与多 profile 用），缺省 ~/.dsh（llm-verifier 同款）。 */
export function defaultDshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * 幂等建链并挂 dispose。已存在且指向本包 → 不动；指向别处或是普通文件/目录 →
 * console.warn 后保留原样；不存在 → 新建。dispose（fiber 卸载时跑）只移除
 * 仍指向本包的链接。任何异常都吞成 warn，绝不向上抛。
 */
export async function ensureSkillLink(ctx: EffectHost, dshHome: string = defaultDshHome()): Promise<SkillLinkHandle> {
  // 上两级：src 直读时 src/skill-link.ts → src → 插件目录；编译后 lib/skill-link.js → lib → 插件目录。
  // 两种装法的 skill 位置不同，按实际存在的取：
  // - link: 开发装法（插件目录即包根）：skills/zcode-executor 是软链进仓库根 skills/ 的链接；
  // - npm 包名装法（包根是仓库根，代码在 dsh-plugin/lib/）：npm 打包跳过软链，skill 实体在根 skills/。
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const nested = join(packageRoot, 'skills', 'zcode-executor')
  const target = existsSync(nested)
    ? nested
    : join(dirname(packageRoot), 'skills', 'zcode-executor')
  const linkDir = join(dshHome, 'skills')
  const linkPath = join(linkDir, 'zcode-executor')

  let outcome: SkillLinkOutcome = 'error'
  try {
    await mkdir(linkDir, { recursive: true })
    const existing = await lstat(linkPath).catch(() => undefined)
    if (existing === undefined) {
      await symlink(target, linkPath, 'dir')
      outcome = 'created'
    } else if (existing.isSymbolicLink() && (await pointsAtSelf(linkPath, target))) {
      outcome = 'existing'
    } else {
      outcome = 'foreign'
      console.warn(
        `[dsh-zcode-executor] ${linkPath} 已存在且不指向本插件的 skill（${target}），不覆盖；`
        + '要启用派单教学请手动移走它，再重载插件行',
      )
    }
  } catch (e) {
    outcome = 'error'
    console.warn(`[dsh-zcode-executor] 建 skill 软链失败（不致命，skill 教学不可用）: ${e instanceof Error ? e.message : String(e)}`)
  }

  // dispose：包卸载时清掉自己的链接，防坏链。disposer 返回 Promise，cordis 卸载会 await 它
  //（fiber.d.ts Disposable：「may be async, in which case unloading awaits them」）。
  try {
    ctx.effect(() => () => removeOwnLink(linkPath, target), 'zcode-executor: skill link')
  } catch (e) {
    console.warn(`[dsh-zcode-executor] 挂 skill 软链的 dispose 失败（不致命）: ${e instanceof Error ? e.message : String(e)}`)
  }

  return { linkPath, target, outcome }
}

/**
 * linkPath 是不是「我们建的那条」：字面指到 target（readlink 不要求目标存在，
 * 兜住链接已悬空的情形），或解引用后与 target 同地（realpath 归一别名路径）。
 */
async function pointsAtSelf(linkPath: string, target: string): Promise<boolean> {
  const literal = await readlink(linkPath).catch(() => '')
  if (literal === target) return true
  const [linkReal, targetReal] = await Promise.all([
    realpath(linkPath).catch(() => ''),
    realpath(target).catch(() => target),
  ])
  return linkReal !== '' && linkReal === targetReal
}

/** 只删「仍指向本包目录」的符号链接；没了、不是链接、指向别人，一律不动。失败吞掉（dispose 非致命）。 */
async function removeOwnLink(linkPath: string, target: string): Promise<void> {
  const existing = await lstat(linkPath).catch(() => undefined)
  if (existing === undefined || !existing.isSymbolicLink()) return
  if (!(await pointsAtSelf(linkPath, target))) return
  await rm(linkPath).catch(() => {})
}
