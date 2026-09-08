// lib/providers.mjs 的行为测试：纯函数喂合成 config，不读真机 ~/.zcode，
// 只用临时文件测 readProviderRegistry 的文件行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExecutorError } from '../lib/errors.mjs';
import { buildRegistry, readProviderRegistry, pickProvider, buildRuntimeModel } from '../lib/providers.mjs';

// after() 兜底：就算某个用例在 try 之前就炸了，临时目录也在这里清掉（T2.9 第 10 条）
const dirs = [];
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// 合成 config：覆盖过滤（空 models、enabled:false）、reasoning、apiKey、多 kind 形状
const CONFIG = {
  provider: {
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      source: 'custom',
      name: 'BigModel Coding Plan',
      options: { baseURL: 'https://api.example.test', apiKey: 'sk-test-123', apiKeyRequired: false },
      models: {
        'GLM-5.3': {
          name: 'GLM 5.3',
          limit: { context: 200000, output: 32000 },
          reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' },
        },
        'GLM-5.3-Flash': {},
      },
    },
    'builtin:zai-start-plan': { kind: 'anthropic', options: {}, models: {} },
    'disabled-plan': { kind: 'anthropic', enabled: false, options: {}, models: { M1: {} } },
    'openai-ish': { kind: 'openai-compatible', options: { baseURL: 'https://o.example.test' }, models: { 'o-model': {} } },
    kindless: { options: {}, models: { 'k-model': {} } },
  },
};

test('buildRegistry：models 为空的 provider 被过滤', () => {
  const { providers } = buildRegistry(CONFIG);
  assert.equal(providers.some((p) => p.providerId === 'builtin:zai-start-plan'), false);
});

test('buildRegistry：enabled:false 的 provider 被过滤', () => {
  const { providers } = buildRegistry(CONFIG);
  assert.equal(providers.some((p) => p.providerId === 'disabled-plan'), false);
  // enabled 缺省视为启用：其余三个都在
  assert.deepEqual(providers.map((p) => p.providerId).sort(), [
    'builtin:bigmodel-coding-plan',
    'kindless',
    'openai-ish',
  ]);
});

test('buildRegistry：models 对象转数组，键名进 modelId', () => {
  const { providers } = buildRegistry(CONFIG);
  const big = providers.find((p) => p.providerId === 'builtin:bigmodel-coding-plan');
  assert.ok(Array.isArray(big.models));
  assert.deepEqual(big.models.map((m) => m.modelId), ['GLM-5.3', 'GLM-5.3-Flash']);
});

test('buildRegistry：name→label、limit→contextWindow/maxOutputTokens、reasoning→levels/defaultLevel', () => {
  const { providers } = buildRegistry(CONFIG);
  const big = providers.find((p) => p.providerId === 'builtin:bigmodel-coding-plan');
  const glm = big.models[0];
  assert.equal(glm.label, 'GLM 5.3');
  assert.equal(glm.contextWindow, 200000);
  assert.equal(glm.maxOutputTokens, 32000);
  assert.deepEqual(glm.reasoning, {
    enabled: true,
    levels: [
      { value: 'low', label: 'low' },
      { value: 'high', label: 'high' },
      { value: 'max', label: 'max' },
    ],
    defaultLevel: 'max',
  });
  // 没有 name/limit/reasoning 的模型只带 modelId，不带 undefined 键
  const flash = big.models[1];
  assert.deepEqual(flash, { modelId: 'GLM-5.3-Flash' });
});

test('buildRegistry：apiKey 内联形状、baseURL 与 label、source 缺省 custom', () => {
  const { providers } = buildRegistry(CONFIG);
  const big = providers.find((p) => p.providerId === 'builtin:bigmodel-coding-plan');
  assert.deepEqual(big.apiKey, { source: 'inline', value: 'sk-test-123' });
  assert.equal(big.baseURL, 'https://api.example.test');
  assert.equal(big.label, 'BigModel Coding Plan');
  assert.equal(big.source, 'custom');
  assert.equal(big.kind, 'anthropic');
  assert.equal(big.apiFormat, 'anthropic-messages');
  assert.equal(big.apiKeyRequired, false);
});

test('buildRegistry：kind 决定 apiFormat，缺 kind 时无 apiFormat', () => {
  const { providers } = buildRegistry(CONFIG);
  const openai = providers.find((p) => p.providerId === 'openai-ish');
  assert.equal(openai.apiFormat, 'openai-chat-completions');
  const kindless = providers.find((p) => p.providerId === 'kindless');
  assert.equal('apiFormat' in kindless, false);
});

test('buildRegistry：revision 是稳定哈希，generatedAt 是数字', () => {
  const a = buildRegistry(CONFIG);
  const b = buildRegistry(CONFIG);
  assert.equal(a.revision, b.revision);
  assert.match(a.revision, /^[0-9a-f]{8}$/);
  assert.notEqual(
    a.revision,
    buildRegistry({ provider: { 'another-plan': { kind: 'anthropic', options: {}, models: { M: {} } } } }).revision,
  );
  assert.equal(typeof a.generatedAt, 'number');
});

test('buildRegistry：provider 缺失时返回空表', () => {
  const { providers, revision } = buildRegistry({});
  assert.deepEqual(providers, []);
  assert.match(revision, /^[0-9a-f]{8}$/);
});




test('readProviderRegistry：文件不存在抛 ExecutorError(1)', () => {
  assert.throws(() => readProviderRegistry('/nonexistent/zcode-config.json'), (err) => {
    assert.ok(err instanceof ExecutorError);
    assert.equal(err.exitCode, 1);
    return true;
  });
});

test('readProviderRegistry：读临时文件并构造 registry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-providers-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify(CONFIG));
  try {
    const registry = readProviderRegistry(file);
    assert.equal(registry.providers.length, 3);
    assert.match(registry.revision, /^[0-9a-f]{8}$/);
    assert.equal(typeof registry.generatedAt, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readProviderRegistry：坏 JSON 抛 ExecutorError(1)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-providers-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  await writeFile(file, '{not json');
  try {
    assert.throws(() => readProviderRegistry(file), (err) => err instanceof ExecutorError && err.exitCode === 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hashRevision：只改 apiKey，revision 跟着变', () => {
  // 评审第 4 条：key 轮换必须让 revision 变，否则后端跳过不应用
  const withKeyA = buildRegistry(CONFIG);
  const configB = structuredClone(CONFIG);
  configB.provider['builtin:bigmodel-coding-plan'].options.apiKey = 'sk-rotated-456';
  const withKeyB = buildRegistry(configB);
  assert.notEqual(withKeyA.revision, withKeyB.revision);
  // 同一个 key 改回来 revision 复原（哈希稳定，不是随机盐）
  const configC = structuredClone(CONFIG);
  assert.equal(buildRegistry(configC).revision, withKeyA.revision);
});


test('buildRegistry：models 是数组时按缺配置跳过', () => {
  const config = {
    provider: {
      'weird-plan': { kind: 'anthropic', models: ['GLM-5.3'] },
      'good-plan': { kind: 'anthropic', options: {}, models: { 'GLM-5.3': {} } },
    },
  };
  const { providers } = buildRegistry(config);
  assert.deepEqual(providers.map((p) => p.providerId), ['good-plan']);
});

// ---------- pickProvider / buildRuntimeModel（T1.3，decisions D6/D11） ----------

// 模拟本机 registry 的形状：同名模型在多个 provider 下并存，coding-plan / start-plan / 其它混着
const PRIORITY = buildRegistry({
  provider: {
    'builtin:bigmodel': { kind: 'anthropic', options: { apiKey: 'sk-plain' }, models: { 'GLM-5.3': {}, 'GLM-5.3-Flash': {} } },
    'builtin:bigmodel-coding-plan': { kind: 'anthropic', options: { apiKey: 'sk-coding' }, models: { 'GLM-5.3': {}, 'GLM-5.3-Flash': {} } },
    'builtin:zai-start-plan': { kind: 'anthropic', options: { apiKey: 'sk-start' }, models: { 'GLM-5.3': {} } },
    'plain-plan': { kind: 'anthropic', options: {}, models: { M1: {} } },
  },
});
const byId = (registry, id) => registry.providers.find((p) => p.providerId === id);

test('pickProvider：coding-plan 优先于 start-plan 优先于其它', () => {
  assert.equal(pickProvider(PRIORITY).providerId, 'builtin:bigmodel-coding-plan');
  const partial = buildRegistry({
    provider: {
      'plain-a': { kind: 'anthropic', options: {}, models: { M: {} } },
      'zai-start-plan': { kind: 'anthropic', options: {}, models: { M: {} } },
    },
  });
  assert.equal(pickProvider(partial).providerId, 'zai-start-plan');
});

test('pickProvider：同级多个取 registry 里靠前的', () => {
  const two = buildRegistry({
    provider: {
      'a-coding-plan': { kind: 'anthropic', options: {}, models: { M: {} } },
      'b-coding-plan': { kind: 'anthropic', options: {}, models: { M: {} } },
    },
  });
  assert.equal(pickProvider(two).providerId, 'a-coding-plan');
});

test('pickProvider：preferredProvider 命中优先，没命中回落优先级规则', () => {
  assert.equal(pickProvider(PRIORITY, { preferredProvider: 'builtin:bigmodel' }).providerId, 'builtin:bigmodel');
  assert.equal(pickProvider(PRIORITY, { preferredProvider: 'no-such' }).providerId, 'builtin:bigmodel-coding-plan');
});

test('pickProvider：preferredProvider 不在表里 → 静默回落，提醒归 resolveModels 的 warnings（评审 T2.2b 第 6 条）', () => {
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    assert.equal(pickProvider(PRIORITY, { preferredProvider: 'no-such' }).providerId, 'builtin:bigmodel-coding-plan');
  } finally {
    process.stderr.write = original;
  }
  assert.deepEqual(writes, []); // 本函数不再打 stderr：warnings 统一在 resolveModels 收
});

test('pickProvider：空表抛 ExecutorError(1)', () => {
  assert.throws(() => pickProvider({ providers: [] }), (err) => err instanceof ExecutorError && err.exitCode === 1);
  assert.throws(() => pickProvider({}), (err) => err instanceof ExecutorError);
});

test('buildRuntimeModel：形状——model ref、provider 原样含内联 apiKey、revision、generatedAt', () => {
  const provider = byId(PRIORITY, 'builtin:bigmodel-coding-plan');
  const rm = buildRuntimeModel(provider, 'GLM-5.3-Flash');
  assert.deepEqual(rm.model, { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-5.3-Flash' });
  assert.deepEqual(rm.provider, provider); // 原样透传
  assert.deepEqual(rm.provider.apiKey, { source: 'inline', value: 'sk-coding' });
  assert.match(rm.revision, /^[0-9a-f]{8}$/);
  assert.equal(typeof rm.generatedAt, 'number');
});

test('buildRuntimeModel：modelId 不在 provider.models 里抛 ExecutorError(2)，报出可选项', () => {
  const provider = byId(PRIORITY, 'builtin:bigmodel-coding-plan');
  assert.throws(() => buildRuntimeModel(provider, 'GLM-9'), (err) => {
    assert.ok(err instanceof ExecutorError);
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /GLM-5\.3/);
    return true;
  });
});

test('buildRuntimeModel：revision 稳定，随 modelId 与 apiKey 变化', () => {
  const provider = byId(PRIORITY, 'builtin:bigmodel-coding-plan');
  assert.equal(buildRuntimeModel(provider, 'GLM-5.3').revision, buildRuntimeModel(provider, 'GLM-5.3').revision);
  assert.notEqual(
    buildRuntimeModel(provider, 'GLM-5.3').revision,
    buildRuntimeModel(provider, 'GLM-5.3-Flash').revision,
  );
  // key 轮换要换 revision，理由同 buildRegistry（评审第 4 条）
  const rotated = structuredClone(provider);
  rotated.apiKey = { source: 'inline', value: 'sk-rotated' };
  assert.notEqual(buildRuntimeModel(provider, 'GLM-5.3').revision, buildRuntimeModel(rotated, 'GLM-5.3').revision);
});
