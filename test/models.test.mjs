// lib/models.mjs 的行为测试：工作流层的模型编排（resolveModels / zcodeInfo），
// 全部对 test/mock-appserver.mjs 跑，不发 session/send，不花额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMock, readRecord } from './helpers.mjs';
import { resolveModels, zcodeInfo } from '../lib/models.mjs';

// 两个启用的 provider（同名模型并存），模拟本机形状
const ZCODE_CONFIG = {
  provider: {
    'builtin:bigmodel': {
      kind: 'anthropic',
      options: { apiKey: 'sk-test-plain' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': {},
      },
    },
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      options: { apiKey: 'sk-test-plan' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': {},
      },
    },
  },
};

const dirs = [];
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// 起 mock + 写 zcode 配置文件，跑一次 resolveModels；mock.env 走 env 透传（并发前提，不写 process.env）
async function runResolve({ config, providerId } = {}) {
  const mock = await startMock({});
  dirs.push(mock.dir);
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-models-config-'));
  dirs.push(configDir);
  const configPath = path.join(configDir, 'config.json');
  await writeFile(configPath, JSON.stringify(ZCODE_CONFIG));
  const resolved = await resolveModels({ config, configPath, providerId, zcodePath: mock.zcodePath, env: mock.env });
  return { resolved, recordPath: mock.env.MOCK_APPSERVER_RECORD };
}

test('resolveModels：形状齐全，providerId 优先于 config.preferredProvider', async () => {
  const { resolved } = await runResolve({
    config: { preferredProvider: 'builtin:bigmodel', tiers: {} },
    providerId: 'builtin:bigmodel-coding-plan',
  });
  assert.equal(resolved.provider.providerId, 'builtin:bigmodel-coding-plan'); // 显式 providerId 赢
  assert.equal(resolved.providerCount, 2);
  assert.match(resolved.configPath, /config\.json$/);
  assert.deepEqual(resolved.available.map((m) => m.ref.modelId).sort(), ['GLM-5.3', 'GLM-5.3-Flash']);
  assert.ok(resolved.all.length >= resolved.available.length); // all 是全部 provider 的条目
  assert.equal(resolved.fast.ref.modelId, 'GLM-5.3-Flash');
  assert.equal(resolved.strong.ref.modelId, 'GLM-5.3');
  assert.deepEqual(resolved.current, { providerId: 'builtin:bigmodel', modelId: 'GLM-5.3' }); // mock 默认第一条
  assert.deepEqual(resolved.warnings, []);
  assert.equal(resolved.registry.providers.length, 2);
});

test('resolveModels：没给 providerId 时按 config.preferredProvider 选', async () => {
  const { resolved } = await runResolve({ config: { preferredProvider: 'builtin:bigmodel', tiers: {} } });
  assert.equal(resolved.provider.providerId, 'builtin:bigmodel');
});

test('resolveModels：配置 tiers 指到不存在的模型 → warnings 提醒且按自动规则选', async () => {
  const { resolved } = await runResolve({ config: { tiers: { fast: 'no-such-model' } } });
  assert.equal(resolved.provider.providerId, 'builtin:bigmodel-coding-plan'); // 无 preferred 时按 D6
  assert.equal(resolved.fast.ref.modelId, 'GLM-5.3-Flash'); // 自动规则兜底
  assert.ok(resolved.warnings.some((w) => /tiers\.fast/.test(w) && /no-such-model/.test(w)), resolved.warnings.join('；'));
});

test('resolveModels：preferredProvider 不在表里 → warnings 有回落提醒', async () => {
  const { resolved } = await runResolve({ config: { preferredProvider: 'no-such-plan', tiers: {} } });
  assert.equal(resolved.provider.providerId, 'builtin:bigmodel-coding-plan'); // 回落到 D6 优先级
  assert.ok(resolved.warnings.some((w) => /no-such-plan/.test(w) && /回落/.test(w)), resolved.warnings.join('；'));
});

test('resolveModels：mock 零 token——只收到推表与 readState', async () => {
  const { recordPath } = await runResolve({ config: {} });
  const methods = [...new Set(readRecord(recordPath).map((m) => m.method).filter(Boolean))].sort();
  assert.deepEqual(methods, ['workspace/readState', 'workspace/updateProviderRegistry']);
});

test('zcodeInfo：ZCODE_BIN 指到 mock 时返回其路径与版本（传参，不改全局环境变量）', async () => {
  const mock = await startMock({});
  dirs.push(mock.dir);
  const info = zcodeInfo({ zcodePath: mock.zcodePath });
  assert.match(info.path, /mock-appserver\.mjs$/);
  assert.equal(info.version, '0.16.5');
});
