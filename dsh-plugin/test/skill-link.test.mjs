// skill 软链（src/skill-link.ts）的测试。全部在临时目录（mkdtemp）里当 DSH_HOME 用，
// 绝不碰真实的 ~/.dsh。断言只看文件系统事实与返回值：链建没建、指没指对本包、
// 重复调用动没动、dispose 移没移、别人的链接碰没碰。
// 行为规格出处：tasks/todo.md Task 7（照 dsh-llm-verifier src/index.ts ensureSkillLink
// 的先例，多两条：指向别处 console.warn；dispose 时只移除仍指向本包的链接防坏链）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureSkillLink } from '../src/skill-link.ts';

test('派单教学与公告：原会话闭环、非阻塞、授权分流及安全边界', async () => {
  const skill = await readFile(new URL('../skills/zcode-executor/SKILL.md', import.meta.url), 'utf8');
  const host = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  for (const text of [skill, host]) {
    assert.match(text, /原执行会话/);
    assert.match(text, /原 review 会话/);
    assert.match(text, /独立工作/);
    assert.match(text, /上层.*限制/);
    assert.doesNotMatch(text, /审批请求与提问必须转交用户|挂起必转交用户/);
  }
  assert.match(skill, /expected-requestId\/CAS/);
  assert.match(skill, /外部串行化/);
  const sends = skill.split('\n').filter(line => /^\s*zcode-executor send .*--task "/.test(line));
  assert.ok(sends.length > 0);
  assert.ok(sends.every(line => !line.includes('--wait')), '可执行投递示例默认非阻塞');
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 收集 effect 注册进来的 disposer 的假 ctx：ensureSkillLink 只用 ctx.effect 这一个面。 */
function fakeCtx() {
  const disposers = [];
  return {
    disposers,
    effect(execute) {
      const result = execute();
      if (result) disposers.push(result);
      return result;
    },
  };
}

/** 临时 DSH_HOME（每例独享，测完删干净）。 */
async function tempHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'zexec-skill-link-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** 包内 skill 目录的绝对路径（软链该指向的地方），顺带断言它真实存在。 */
function packageSkillTarget() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '../skills/zcode-executor');
}

const linkPathIn = (home) => path.join(home, 'skills', 'zcode-executor');

test('临时 HOME 下建链：~/.dsh/skills/zcode-executor 是指向包内 skill 目录的软链', async (t) => {
  const home = await tempHome(t);
  const handle = await ensureSkillLink(fakeCtx(), home);
  const linkPath = linkPathIn(home);
  const st = await lstat(linkPath);
  assert.ok(st.isSymbolicLink(), 'skills/zcode-executor 应是符号链接');
  assert.equal(await realpath(linkPath), await realpath(packageSkillTarget()), '应指向包内 skill 目录');
  assert.equal(handle.outcome, 'created');
  assert.equal(handle.linkPath, linkPath);
});

test('重复调用幂等：第二次不动已有链接，outcome 报 existing', async (t) => {
  const home = await tempHome(t);
  const ctx = fakeCtx();
  await ensureSkillLink(ctx, home);
  const linkPath = linkPathIn(home);
  const before = await readlink(linkPath);
  const second = await ensureSkillLink(ctx, home);
  assert.equal(await readlink(linkPath), before, '链接目标不应变化');
  assert.equal(second.outcome, 'existing');
});

test('指向别处时：不覆盖、不抛，console.warn 说明，outcome 报 foreign', async (t) => {
  const home = await tempHome(t);
  const other = await mkdtemp(path.join(tmpdir(), 'zexec-skill-foreign-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await mkdir(path.join(home, 'skills'), { recursive: true });
  await symlink(other, linkPathIn(home), 'dir');

  const warns = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    const handle = await ensureSkillLink(fakeCtx(), home);
    assert.equal(handle.outcome, 'foreign');
    assert.ok(warns.some((msg) => msg.includes(linkPathIn(home))), `应有 warn 指到被占路径，实际: ${JSON.stringify(warns)}`);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(await readlink(linkPathIn(home)), other, '别人的链接应原样保留');
});

test('dispose 移除：仍指向本包的链接在 disposer 后消失', async (t) => {
  const home = await tempHome(t);
  const ctx = fakeCtx();
  await ensureSkillLink(ctx, home);
  const linkPath = linkPathIn(home);
  assert.ok((await lstat(linkPath)).isSymbolicLink());
  assert.equal(ctx.disposers.length, 1, '应恰好注册一个 disposer');
  await ctx.disposers[0]();
  await sleep(10);
  await assert.rejects(() => lstat(linkPath), { code: 'ENOENT' }, 'disposer 应移除本包的链接');
});

test('指向别处时 dispose 不动它：foreign 链接在 disposer 后原样保留', async (t) => {
  const home = await tempHome(t);
  const other = await mkdtemp(path.join(tmpdir(), 'zexec-skill-foreign-'));
  t.after(() => rm(other, { recursive: true, force: true }));
  await mkdir(path.join(home, 'skills'), { recursive: true });
  await symlink(other, linkPathIn(home), 'dir');

  const ctx = fakeCtx();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await ensureSkillLink(ctx, home);
  } finally {
    console.warn = originalWarn;
  }
  await ctx.disposers[0]();
  assert.equal(await readlink(linkPathIn(home)), other, 'dispose 后别人的链接应仍在');
});

test('dshHome 指向普通文件：mkdir 失败 → warn + outcome error，disposer 不误删', async (t) => {
  const home = await tempHome(t);
  const fileHome = path.join(home, 'not-a-dir'); // dshHome 是普通文件：mkdir(<file>/skills) 必炸
  await writeFile(fileHome, 'x');
  const ctx = fakeCtx();
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  let handle;
  try {
    handle = await ensureSkillLink(ctx, fileHome);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(handle.outcome, 'error', '建链失败应报 error，不向上抛');
  assert.ok(warns.some((msg) => msg.includes('建 skill 软链失败')), `应有失败 warn，实际: ${JSON.stringify(warns)}`);
  await ctx.disposers[0](); // 只许不抛地空跑：普通文件不是本包链接，disposer 不许动它
  assert.equal(await readFile(fileHome, 'utf8'), 'x', 'disposer 不得动 dshHome 上的普通文件');
});
