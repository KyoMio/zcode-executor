// lib/models.mjs 的行为测试：工作流层的模型编排（resolveModels / zcodeInfo / resolveReviewSelection），
// 全部对 test/mock-appserver.mjs 跑，不发 session/send，不花额度。
// 3.12 起模型清单从 registry 本地换算，握手（probeHandshake：create + close）只在 handshake:true 时走。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMock, readRecord } from './helpers.mjs';
import { resolveModels, resolveReviewSelection, zcodeInfo } from '../lib/models.mjs';
import { readProviderRegistry } from '../lib/providers.mjs';

// 两个启用的 provider（同名模型并存），模拟本机形状
const ZCODE_CONFIG = {
  provider: {
    'builtin:bigmodel': {
      kind: 'anthropic',
      options: { apiKey: 'sk-test-plain', baseURL: 'https://plain.invalid/api/anthropic' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
        'GLM-5.3-Flash': {},
      },
    },
    'builtin:bigmodel-coding-plan': {
      kind: 'anthropic',
      options: { apiKey: 'sk-test-plan', baseURL: 'https://plan.invalid/api/anthropic' },
      models: {
        'GLM-5.3': { name: 'GLM 5.3', reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' }, limit: { context: 200000, output: 32000 } },
        'GLM-5.3-Flash': {},
      },
    },
  },
};

const dirs = [];
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function writeZcodeConfig(config = ZCODE_CONFIG) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'zcode-models-config-'));
  dirs.push(configDir);
  const configPath = path.join(configDir, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  return configPath;
}

// 个人 provider 文件落在 os.tmpdir()：把 TMPDIR 临时指到一个空目录跑 fn，返回 { result, tmp }，
// 跑完看 tmp 空不空就知道有没有 dispose（同一文件里的用例顺序跑，改 process.env.TMPDIR 不会串）
async function withTmpdir(fn) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'zcode-models-tmp-'));
  dirs.push(tmp);
  const savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    return { result: await fn(), tmp };
  } finally {
    if (savedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmpdir;
  }
}

// 起 mock + 写 zcode 配置文件，跑一次 resolveModels；mock.env 走 env 透传（并发前提，不写 process.env）
async function runResolve({ config, providerId, handshake, script, zcodeConfig } = {}) {
  const mock = await startMock({ script });
  dirs.push(mock.dir);
  const configPath = await writeZcodeConfig(zcodeConfig);
  const { result: resolved, tmp } = await withTmpdir(() =>
    resolveModels({ config, configPath, providerId, handshake, zcodePath: mock.zcodePath, env: mock.env }),
  );
  return { resolved, recordPath: mock.env.MOCK_APPSERVER_RECORD, tmp };
}

test('resolveModels：形状齐全，providerId 优先于 config.preferredProvider，模型清单从 registry 本地换算', async () => {
  const { resolved, recordPath } = await runResolve({
    config: { preferredProvider: 'builtin:bigmodel', tiers: {} },
    providerId: 'builtin:bigmodel-coding-plan',
  });
  assert.equal(resolved.provider.providerId, 'builtin:bigmodel-coding-plan'); // 显式 providerId 赢
  assert.equal(resolved.providerCount, 2);
  assert.match(resolved.configPath, /config\.json$/);
  assert.deepEqual(resolved.available.map((m) => m.ref.modelId).sort(), ['GLM-5.3', 'GLM-5.3-Flash']);
  assert.equal(resolved.all.length, 4); // all 是全部 provider 的条目（models 按 provider 分组用）
  // 条目形状照真机 settings.model.available：ref.providerId 是 config.json 的 id，不是 zcode-executor
  const strong = resolved.available.find((m) => m.ref.modelId === 'GLM-5.3');
  assert.deepEqual(strong.ref, { providerId: 'builtin:bigmodel-coding-plan', modelId: 'GLM-5.3' });
  assert.equal(strong.label, 'GLM 5.3');
  assert.equal(strong.contextWindow, 200000);
  assert.equal(strong.maxOutputTokens, 32000);
  assert.deepEqual(strong.reasoning.levels.map((l) => l.value), ['low', 'high', 'max']);
  assert.equal(strong.reasoning.defaultLevel, 'max');
  assert.equal(strong.tier, 'strong');
  assert.equal(resolved.fast.ref.modelId, 'GLM-5.3-Flash');
  assert.equal(resolved.strong.ref.modelId, 'GLM-5.3');
  assert.equal('current' in resolved, false); // 3.12 没有 readState 了，current 不再有
  assert.deepEqual(resolved.warnings, []);
  assert.equal(resolved.registry.providers.length, 2);
  assert.deepEqual(readRecord(recordPath), []); // 不握手：mock 根本没被起过
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

test('resolveModels：handshake:true 零 token——只有 deferred 的 create 与 close，create 用 fast 档 + 默认档位，个人文件收场即删', async () => {
  const { resolved, recordPath, tmp } = await runResolve({ config: {}, handshake: true });
  const record = readRecord(recordPath);
  const methods = [...new Set(record.map((m) => m.method).filter(Boolean))].sort();
  assert.deepEqual(methods, ['session/close', 'session/create']);
  const create = record.find((m) => m.method === 'session/create').params;
  assert.equal(create.persistence, 'deferred'); // 探针会话不进 App 的任务列表（verified.md「3.12.2 直连探针实测」「mock 复刻依据」）
  assert.deepEqual(create.model, { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } });
  assert.equal(create.thoughtLevel, 'high'); // 顶层也带（真机只给 options 时 thoughtLevel.current 是空的）
  assert.deepEqual(resolved.warnings, []); // 个人文件里的两个模型 app-server 都认了
  assert.deepEqual(await readdir(tmp), []); // 个人 provider 文件（含 apiKey）已随目录删掉
});

test('resolveModels：握手回来的可用模型缺了个人文件里的 → warnings 点名', async () => {
  const { resolved } = await runResolve({
    config: {},
    handshake: true,
    script: { models: [{ ref: { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash' }, reasoning: { levels: [{ value: 'high' }] } }] },
  });
  assert.ok(resolved.warnings.some((w) => /GLM-5\.3 没被 app-server 认/.test(w)), resolved.warnings.join('；'));
});

test('resolveModels：握手失败（create 被拒）→ 抛错且个人文件照样删掉', async () => {
  const configPath = await writeZcodeConfig();
  const mock = await startMock({ script: { errors: { 'session/create': { code: -32603, message: 'Provider Registry 中不存在 Model' } } } });
  dirs.push(mock.dir);
  const { tmp } = await withTmpdir(() =>
    assert.rejects(
      resolveModels({ config: {}, configPath, handshake: true, zcodePath: mock.zcodePath, env: mock.env }),
      /Provider Registry/,
    ),
  );
  assert.deepEqual(await readdir(tmp), []);
});

test('resolveModels：选中的 provider 没有明文 apiKey → 不握手照常列模型，握手抛错说清', async () => {
  const noKey = { provider: { 'builtin:bigmodel-coding-plan': { kind: 'anthropic', options: {}, models: { 'GLM-5.3': {} } } } };
  const local = await runResolve({ config: {}, zcodeConfig: noKey });
  assert.equal(local.resolved.strong.ref.modelId, 'GLM-5.3');
  const configPath = await writeZcodeConfig(noKey);
  const mock = await startMock({});
  dirs.push(mock.dir);
  await withTmpdir(() =>
    assert.rejects(
      resolveModels({ config: {}, configPath, handshake: true, zcodePath: mock.zcodePath, env: mock.env }),
      /没有明文 apiKey/,
    ),
  );
  assert.deepEqual(readRecord(mock.env.MOCK_APPSERVER_RECORD), []); // 没 key 连 spawn 都不该有
});

test('zcodeInfo：返回路径、版本与内置 provider 文件；环境变量指的文件优先，找不到时把错误放进返回值不抛', async () => {
  const mock = await startMock({});
  dirs.push(mock.dir);
  const viaEnv = zcodeInfo({ zcodePath: mock.zcodePath, builtinFile: mock.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE });
  assert.match(viaEnv.path, /mock-appserver\.mjs$/);
  assert.equal(viaEnv.version, '0.16.5');
  assert.equal(viaEnv.builtinConfigPath, mock.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE);
  assert.equal(viaEnv.builtinConfigError, null);
  // mock 旁边没有 ../config/provider/zcode-builtin.json：这就是「App 低于 3.12」的样子
  const missing = zcodeInfo({ zcodePath: mock.zcodePath, builtinFile: undefined });
  assert.equal(missing.version, '0.16.5'); // 版本照样能拿到，版本号区分不了新旧
  assert.equal(missing.builtinConfigPath, null);
  assert.match(missing.builtinConfigError, /ZCODE_BUILTIN_PROVIDER_CONFIG_FILE/);
  // 环境变量指了但文件不存在，同样按找不到报（spawn 会原样把它交给子进程，子进程秒退）
  const stale = zcodeInfo({ zcodePath: mock.zcodePath, builtinFile: path.join(mock.dir, 'nope.json') });
  assert.equal(stale.builtinConfigPath, null);
  assert.match(stale.builtinConfigError, /nope\.json/);
});

test('resolveReviewSelection：fast 档 + review.thought（默认 low）→ selection 形状同 create 的 model', async () => {
  const registry = readProviderRegistry(await writeZcodeConfig({
    provider: {
      'builtin:bigmodel-coding-plan': {
        kind: 'anthropic',
        options: { apiKey: 'sk-test-plan' },
        models: {
          'GLM-5.3': { reasoning: { enabled: true, variants: ['low', 'high', 'max'], defaultVariant: 'max' } },
          'GLM-5.3-Flash': { reasoning: { enabled: true, variants: ['low', 'high'], defaultVariant: 'high' } },
        },
      },
    },
  }));
  const providerId = 'builtin:bigmodel-coding-plan';
  const byDefault = resolveReviewSelection({ registry, providerId, config: {} });
  assert.deepEqual(byDefault.selection, { providerId: 'zcode-executor', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } });
  assert.equal(byDefault.model.ref.providerId, providerId); // model 条目仍认 config.json 的 id
  const overridden = resolveReviewSelection({ registry, providerId, config: { review: { model: 'GLM-5.3', thought: 'max' } } });
  assert.deepEqual(overridden.selection, { providerId: 'zcode-executor', modelId: 'GLM-5.3', options: { reasoningLevel: 'max' } });
  assert.throws(() => resolveReviewSelection({ registry, providerId: 'no-such', config: {} }), /不在 provider 表里/);
  assert.throws(() => resolveReviewSelection({ registry, providerId, config: { review: { model: 'nope' } } }), /nope/);
});
