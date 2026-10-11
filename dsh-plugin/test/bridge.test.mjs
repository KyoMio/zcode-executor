// src/bridge.ts（PB-6 插件桥声明）的测试：fake ctx 收集 inject/effect 调用，断言只看外部
// 行为——登记了什么声明、dispose 有没有挂进 effect、服务缺席/形状不对/声明被拒时是否
// 降级不炸。协议权威在 zen-remote 仓（其 test 对 normalizeDeclaration 全量覆盖）；这里只
// 守本仓一侧：我们交出去的东西形状正确、失败不伤插件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bridgeDeclaration, PACKAGE_VERSION, registerBridgeDeclaration } from '../src/bridge.ts';
import { REPO_ROUTE, SNAPSHOT_ROUTE, STREAM_ROUTE } from '../src/routes.ts';

/** fake zenRemote 服务：记下收到的声明，dispose 可数。 */
function fakeZenRemote({ throwOnBridge } = {}) {
  const declarations = [];
  let disposes = 0;
  return {
    service: {
      bridge(decl) {
        if (throwOnBridge) throw new Error('invalid bridge declaration, routes[0].path: must start with "/"');
        declarations.push(decl);
        return () => {
          disposes += 1;
        };
      },
    },
    declarations,
    disposed: () => disposes,
  };
}

/**
 * fake 插件行 ctx：inject(['zenRemote'], fn) 按有无服务决定执不执行回调（cordis 等服务
 * 语义：没装 zen-remote 时回调永不触发）。effect 收集登记的 disposer。
 */
function fakeCtx({ hasService, service } = {}) {
  const effects = [];
  const injectCalls = [];
  const ctx = {
    inject(services, fn) {
      injectCalls.push([...services]);
      if (!hasService) return; // cordis 语义：服务缺席，回调根本不执行
      fn({
        zenRemote: service,
        effect(dispose, name) {
          effects.push({ name, dispose: dispose() });
          return {};
        },
      });
    },
  };
  return { ctx, effects, injectCalls };
}

test('声明内容：三条路由，stream/snapshot 是 server 级（stream 标真），repo 是 session 级', () => {
  const decl = bridgeDeclaration('9.9.9');
  assert.equal(decl.plugin, 'dsh-zcode-executor');
  assert.equal(decl.version, '9.9.9');
  assert.deepEqual(decl.routes, [
    { path: STREAM_ROUTE, scope: 'server', stream: true },
    { path: SNAPSHOT_ROUTE, scope: 'server' },
    { path: REPO_ROUTE, scope: 'session' },
  ]);
});

test('版本取自 package.json（运行时读，不写死）：PACKAGE_VERSION 与包文件一致，声明缺省带上它', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(PACKAGE_VERSION, pkg.version);
  assert.equal(bridgeDeclaration().version, pkg.version);
});

test('登记：inject 等 zenRemote 服务，bridge 收到声明，dispose 挂进 effect 随 fiber 撤', () => {
  const zen = fakeZenRemote();
  const { ctx, effects, injectCalls } = fakeCtx({ hasService: true, service: zen.service });
  const logger = { info: () => {}, warn: () => {} };
  registerBridgeDeclaration(ctx, logger);
  assert.deepEqual(injectCalls, [['zenRemote']]);
  assert.equal(zen.declarations.length, 1);
  assert.equal(zen.declarations[0].plugin, 'dsh-zcode-executor');
  assert.equal(effects.length, 1);
  assert.match(effects[0].name, /zenRemote bridge declaration/);
  effects[0].dispose(); // effect 的 disposer 执行 = 撤销登记
  assert.equal(zen.disposed(), 1);
});

test('没装 zen-remote：inject 回调永不触发，登记调用整体无副作用', () => {
  const { ctx, effects, injectCalls } = fakeCtx({ hasService: false });
  registerBridgeDeclaration(ctx, undefined); // logger 都不给（最裸的宿主形状）
  assert.deepEqual(injectCalls, [['zenRemote']]);
  assert.deepEqual(effects, []);
});

test('zenRemote 服务在但没有 bridge 方法（zen-remote 过旧）：warn 降级，不炸', () => {
  const warns = [];
  const { ctx, effects } = fakeCtx({ hasService: true, service: {} });
  registerBridgeDeclaration(ctx, { warn: (fmt, ...args) => warns.push(`${fmt} ${args.join(' ')}`) });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /bridge 方法/);
  assert.deepEqual(effects, []);
});

test('声明被拒（bridge 抛错）：warn 降级，插件行不受影响', () => {
  const warns = [];
  const zen = fakeZenRemote({ throwOnBridge: true });
  const { ctx, effects } = fakeCtx({ hasService: true, service: zen.service });
  registerBridgeDeclaration(ctx, { warn: (fmt, ...args) => warns.push(`${fmt} ${args.join(' ')}`) });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /被拒绝/);
  assert.deepEqual(effects, []); // 没挂 effect：没有登记成功这回事
});
