// 配置热重载守卫（src/reload.ts）的测试。fake ctx（effect 收 disposer、on 收监听、
// fiber.restart 数调用、logger.warn 收文案）+ 可变行配置桩（loader 包 volatile 字段的
// { get() } 现场引用形状，测试中途改 holder 模拟设置页保存）。断言只看外部行为：
// loader/volatile-update 且解析值有变 → fiber.restart 恰好一次；值没变（指纹相同）不重载；
// 轮询兜底同样 fire-at-most-once；没 fiber 只 warn 不炸；restart 被拒只 warn 不炸；
// effect 的 disposer 能停守卫。先例：dsh-zen-remote src/restart-watcher.ts（指纹 +
// 双触发 + fire-at-most-once）与 loader 1.0.5 的 loader/volatile-update 事件实证（其
// src/index.ts:949-997 注释）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { installReloadWatcher, settingsKey, startReloadWatcher } from '../src/reload.ts';

/** 可变的行配置桩：loader 转 volatile 字段给 apply 的样子（{ get() } 现场引用）。 */
function volatileConfig(holder) {
  return {
    execPath: { get: () => holder.execPath },
    watchMode: { get: () => holder.watchMode },
    announceToAgent: { get: () => holder.announceToAgent },
  };
}

/** fake ctx：effect 收 disposer、on 收监听、fiber.restart 数次数、warn 收文案。 */
function fakeCtx() {
  const calls = { restart: 0, warn: [] };
  const listeners = new Map();
  const disposers = [];
  const ctx = {
    fiber: { restart: async () => { calls.restart += 1; } },
    logger: { warn: (format, ...args) => { calls.warn.push([format, ...args]); } },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    effect(execute) {
      const d = execute();
      if (d) disposers.push(d);
      return d;
    },
  };
  return {
    ctx,
    calls,
    disposers,
    fire: (event) => { for (const fn of listeners.get(event) ?? []) fn(); },
  };
}

test('settingsKey：解析后的三项按稳定键序组指纹（键序不同、值相同则同串）', () => {
  const a = settingsKey({ execPath: 'x', watchMode: 'always', announceToAgent: true });
  const b = settingsKey({ announceToAgent: true, watchMode: 'always', execPath: 'x' });
  assert.equal(a, b);
  assert.notEqual(a, settingsKey({ execPath: 'y', watchMode: 'always', announceToAgent: true }));
  assert.notEqual(a, settingsKey({ execPath: 'x', watchMode: 'on-demand', announceToAgent: true }));
  assert.notEqual(a, settingsKey({ execPath: 'x', watchMode: 'always', announceToAgent: false }));
});

test('loader/volatile-update 且解析值有变：fiber.restart 被调恰好一次，之后不再触发', () => {
  const holder = { execPath: '/old/path', watchMode: 'always', announceToAgent: true };
  const f = fakeCtx();
  installReloadWatcher(f.ctx, volatileConfig(holder));
  holder.execPath = '/new/path'; // 设置页保存了新值（volatile-only 提交，宿主广播事件）
  f.fire('loader/volatile-update');
  assert.equal(f.calls.restart, 1);
  f.fire('loader/volatile-update'); // 行还没真重载、值没再变：不得连发
  assert.equal(f.calls.restart, 1);
});

test('值未变（解析后指纹相同）不重载；原文变了但解析值没变也不重载', () => {
  const holder = { execPath: '/p', watchMode: 'always', announceToAgent: true };
  const f = fakeCtx();
  installReloadWatcher(f.ctx, volatileConfig(holder));
  f.fire('loader/volatile-update'); // 没有任何变化
  assert.equal(f.calls.restart, 0);
  holder.execPath = '  /p  '; // 原文变了，resolveWatchSettings 的解析值没变（trim）
  f.fire('loader/volatile-update');
  assert.equal(f.calls.restart, 0);
});

test('announceToAgent / watchMode 变更同样触发重载（不精细到只撤销公告）', () => {
  for (const field of ['watchMode', 'announceToAgent']) {
    const holder = { execPath: '/p', watchMode: 'always', announceToAgent: true };
    const f = fakeCtx();
    installReloadWatcher(f.ctx, volatileConfig(holder));
    holder[field] = field === 'watchMode' ? 'on-demand' : false;
    f.fire('loader/volatile-update');
    assert.equal(f.calls.restart, 1, field);
  }
});

test('轮询兜底：注入假 interval，tick 发现变化 → 恰好一次并自解除武装', () => {
  const holder = { execPath: '/p', watchMode: 'always', announceToAgent: true };
  const f = fakeCtx();
  const ticks = [];
  const intervals = [];
  const cleared = [];
  installReloadWatcher(f.ctx, volatileConfig(holder), {
    setIntervalImpl: (cb, ms) => { ticks.push(cb); intervals.push(ms); return ticks.length; },
    clearIntervalImpl: (handle) => { cleared.push(handle); ticks[handle - 1] = null; },
  });
  assert.deepEqual(intervals, [2000]); // 缺省 2 秒兜底（zen-remote 同款）
  holder.execPath = '/q'; // 轮询兜底要抓的正是「事件没覆盖到的变化」
  ticks[0]?.();
  assert.equal(f.calls.restart, 1); // 第一 tick 就 fire
  assert.deepEqual(cleared, [1]); // fire 后自停：轮询计时器已清
  ticks[0]?.(); // 句柄已清成 null：第二声不触发
  assert.equal(f.calls.restart, 1);
});

test('没有 fiber（路由测试等 fake 场景）：只 warn 不炸，更不抛', () => {
  const holder = { execPath: '/p', watchMode: 'always', announceToAgent: true };
  const f = fakeCtx();
  delete f.ctx.fiber;
  installReloadWatcher(f.ctx, volatileConfig(holder));
  holder.execPath = '/q';
  f.fire('loader/volatile-update');
  assert.equal(f.calls.restart, 0);
  assert.ok(f.calls.warn.flat().join(' ').includes('fiber'));
});

test('restart 被拒（行重载失败）：warn 一条，不炸、不冒未处理的 rejection', async () => {
  const holder = { execPath: '/p', watchMode: 'always', announceToAgent: true };
  const f = fakeCtx();
  f.ctx.fiber = { restart: () => Promise.reject(new Error('boom')) };
  installReloadWatcher(f.ctx, volatileConfig(holder));
  holder.execPath = '/q';
  f.fire('loader/volatile-update');
  await new Promise((resolve) => setTimeout(resolve, 0)); // 给 rejection 的处理留一拍
  assert.ok(f.calls.warn.flat().join(' ').includes('boom'));
});

test('effect 的 disposer 停守卫：dispose 后事件与轮询都不再触发', () => {
  const holder = { execPath: '/p', watchMode: 'always', announceToAgent: true };
  const f = fakeCtx();
  installReloadWatcher(f.ctx, volatileConfig(holder));
  assert.equal(f.disposers.length, 1); // 守卫的停止函数挂在行 effect 上
  f.disposers[0]();
  holder.execPath = '/q';
  f.fire('loader/volatile-update');
  assert.equal(f.calls.restart, 0);
});

// 以下两例直接测 startReloadWatcher（SPEC.md「缝 3」声称的两条语义）：
// 基线读失败延后补记、轮询句柄 unref。走纯逻辑半场（假钟驱动），不经 installReloadWatcher
// ——基线失败要 getValues 首调抛错，行配置桩给不出这个形状。

test('基线读失败延后补记：不 fire，首个成功触发补记基线，之后的真实变化才 fire', () => {
  let values = { execPath: '/p', watchMode: 'always', announceToAgent: true };
  let baselineBroken = true;
  const getValues = () => {
    if (baselineBroken) throw new Error('config not ready'); // 启动时基线读失败
    return values;
  };
  let fired = 0;
  const ticks = [];
  const watcher = startReloadWatcher({
    getValues,
    onChange: () => { fired += 1; },
    setIntervalImpl: (cb) => { ticks.push(cb); return { unref() {} }; },
    clearIntervalImpl: () => {},
  });
  baselineBroken = false; // 配置恢复可读，但值没变过
  ticks[0]?.(); // 首个成功触发：只补记基线
  assert.equal(fired, 0); // 基线缺失不得当成「变化」误 fire
  values = { ...values, execPath: '/q' };
  ticks[0]?.(); // 基线已补记，这回是真变化
  assert.equal(fired, 1);
  watcher.stop();
});

test('轮询句柄 unref：兜底计时器不托住宿主进程', () => {
  const holder = { execPath: '/p', watchMode: 'always', announceToAgent: true };
  const f = fakeCtx();
  const unrefCalls = [];
  installReloadWatcher(f.ctx, volatileConfig(holder), {
    setIntervalImpl: (cb, ms) => ({ unref: () => { unrefCalls.push(ms); } }),
    clearIntervalImpl: () => {},
  });
  assert.equal(unrefCalls.length, 1); // 句柄一拿到就 unref
  assert.equal(unrefCalls[0], 2000); // unref 的就是兜底轮询那个计时器
});
