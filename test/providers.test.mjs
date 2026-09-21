// lib/providers.mjs 的行为测试：纯函数喂合成 config，不读真机 ~/.zcode，
// 只用临时文件测 readProviderRegistry 的文件行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutorError } from '../lib/errors.mjs';
import {
  EXECUTOR_PROVIDER_ID,
  buildAccountProviders,
  buildRegistry,
  readProviderRegistry,
  pickProvider,
  buildPersonalProviderConfig,
  writePersonalProviderFile,
  buildModelSelection,
} from '../lib/providers.mjs';
import { BUILTIN_PROVIDER_FIXTURE, CREDENTIAL_TEST_SECRET, encryptForTest } from './helpers.mjs';

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

test('buildRegistry：apiKey 内联形状、baseURL 与 label', () => {
  const { providers } = buildRegistry(CONFIG);
  const big = providers.find((p) => p.providerId === 'builtin:bigmodel-coding-plan');
  assert.deepEqual(big.apiKey, { source: 'inline', value: 'sk-test-123' });
  assert.equal(big.baseURL, 'https://api.example.test');
  assert.equal(big.label, 'BigModel Coding Plan');
  assert.equal(big.kind, 'anthropic');
  assert.equal(big.apiFormat, 'anthropic-messages');
});

test('buildRegistry：kind 决定 apiFormat，缺 kind 时无 apiFormat', () => {
  const { providers } = buildRegistry(CONFIG);
  const openai = providers.find((p) => p.providerId === 'openai-ish');
  assert.equal(openai.apiFormat, 'openai-chat-completions');
  const kindless = providers.find((p) => p.providerId === 'kindless');
  assert.equal('apiFormat' in kindless, false);
});

test('buildRegistry：provider 缺失时返回空表', () => {
  const { providers } = buildRegistry({});
  assert.deepEqual(providers, []);
});




test('readProviderRegistry：只有 legacy 时读临时文件并构造 registry，账号型来源记 missing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-providers-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  await writeFile(file, JSON.stringify(CONFIG));
  // credentials.json 与内置文件都不指：账号型来源按不存在处理（不读真实 ~/.zcode）
  const registry = readProviderRegistry(file, {
    credentialsPath: path.join(dir, 'no-credentials.json'),
    builtinConfigPath: path.join(dir, 'no-builtin.json'),
    env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_TEST_SECRET },
  });
  try {
    assert.equal(registry.providers.length, 3);
    assert.equal(registry.sources.legacy.ok, true);
    assert.equal(registry.sources.account.missing, true);
    assert.ok(registry.warnings.some((w) => /credentials\.json 不存在/.test(w)), registry.warnings.join('；'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readProviderRegistry：config.json 坏 JSON 不再直接抛——记 warnings，靠账号型来源照样成表', async () => {
  const fx = await writeAccountFixture();
  await writeFile(fx.legacyPath, '{not json');
  const registry = readProviderRegistry(fx.legacyPath, fx.options);
  assert.equal(registry.providers.length, 2); // 账号型两把 key 都在
  assert.equal(registry.sources.legacy.ok, false);
  assert.match(registry.sources.legacy.error, /不是合法 JSON/);
  assert.ok(registry.warnings.some((w) => /不是合法 JSON/.test(w)), registry.warnings.join('；'));
});

test('readProviderRegistry：两个来源都没有 provider → ExecutorError(1)，message 把两个原因都带上', async () => {
  const fx = await writeAccountFixture();
  const missingLegacy = path.join(fx.dir, 'no-such-config.json');
  const missingCred = path.join(fx.dir, 'no-such-credentials.json');
  assert.throws(
    () => readProviderRegistry(missingLegacy, { ...fx.options, credentialsPath: missingCred }),
    (err) => {
      assert.ok(err instanceof ExecutorError);
      assert.equal(err.exitCode, 1);
      assert.match(err.message, /credentials\.json 不存在/);
      assert.match(err.message, /找不到 zcode 配置/);
      // sources 挂在 details 上，doctor 的 ② 排版要用
      assert.equal(err.details.sources.account.missing, true);
      assert.equal(err.details.sources.legacy.ok, false);
      return true;
    },
  );
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

// ---------- pickProvider / buildModelSelection（T1.3 → T5.2，decisions D6/D14） ----------

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

test('buildModelSelection：providerId 固定 zcode-executor，档位进 options.reasoningLevel', () => {
  const provider = byId(PRIORITY, 'builtin:bigmodel-coding-plan');
  assert.equal(EXECUTOR_PROVIDER_ID, 'zcode-executor');
  assert.deepEqual(buildModelSelection(provider, 'GLM-5.3-Flash', 'high'), {
    providerId: 'zcode-executor',
    modelId: 'GLM-5.3-Flash',
    options: { reasoningLevel: 'high' },
  });
  // 档位为空不带 options（调用方自己保证 GLM 5.3 系列给档位，否则 create 被拒）
  assert.deepEqual(buildModelSelection(provider, 'GLM-5.3'), { providerId: 'zcode-executor', modelId: 'GLM-5.3' });
  assert.deepEqual(buildModelSelection(provider, 'GLM-5.3', null), { providerId: 'zcode-executor', modelId: 'GLM-5.3' });
});

test('buildModelSelection：modelId 不在 provider.models 里抛 ExecutorError(2)，报出可选项', () => {
  const provider = byId(PRIORITY, 'builtin:bigmodel-coding-plan');
  assert.throws(() => buildModelSelection(provider, 'GLM-9', 'high'), (err) => {
    assert.ok(err instanceof ExecutorError);
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /GLM-5\.3/);
    return true;
  });
});

// ---------- 个人 provider 文件（T5.2，docs/reference/zcode-app-server-protocol.md「3.12.2 变化」，decisions D14） ----------

test('buildPersonalProviderConfig：registry 的 provider → 个人文件 JSON（形状照 CLI 的 legacy 导入函数）', () => {
  const big = byId(buildRegistry(CONFIG), 'builtin:bigmodel-coding-plan');
  assert.deepEqual(buildPersonalProviderConfig(big), {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: 'zcode-executor',
            providerName: 'zcode-executor',
            config: {
              group: 'standard-personal',
              access: { type: 'api-key', apiKey: 'sk-test-123' },
              api: { type: 'anthropic-messages', baseUrl: 'https://api.example.test' },
              personalModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
              modelOrder: ['GLM-5.3', 'GLM-5.3-Flash'],
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  });
});

test('buildPersonalProviderConfig：provider 没有明文 apiKey 抛 ExecutorError(1)', () => {
  const plain = byId(PRIORITY, 'plain-plan'); // options 里没 apiKey
  assert.throws(() => buildPersonalProviderConfig(plain), (err) => {
    assert.ok(err instanceof ExecutorError);
    assert.equal(err.exitCode, 1);
    assert.match(err.message, /plain-plan/);
    assert.match(err.message, /apiKey/);
    return true;
  });
});

test('writePersonalProviderFile：临时目录里 provider.json 权限 0600，内容是个人文件 JSON，dispose 后目录不在且可重复调', { skip: process.platform === 'win32' && '验的是 POSIX 权限位' }, () => {
  const big = byId(buildRegistry(CONFIG), 'builtin:bigmodel-coding-plan');
  const { path: file, dispose } = writePersonalProviderFile(big);
  try {
    assert.ok(path.isAbsolute(file));
    assert.equal(path.basename(file), 'provider.json');
    assert.ok(path.basename(path.dirname(file)).startsWith('zcode-executor-provider-'));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), buildPersonalProviderConfig(big));
  } finally {
    dispose();
  }
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(path.dirname(file)), false);
  assert.doesNotThrow(dispose); // 收场路径可能从多处进来
});

// ---------- T6-C：账号型 coding plan 来源（credentials.json + 内置 provider 文件，2026-09-21） ----------

/** 写一套账号型来源夹具：内置文件 + 加密 credentials.json + 一个还不存在的 legacy config.json 路径。 */
async function writeAccountFixture({
  builtin = BUILTIN_PROVIDER_FIXTURE,
  family = 'bigmodel',
  accountId = '10086',
  plans = { individual: 'sk-acct-individual', team: 'sk-acct-team' },
  omitBuiltin = false,
} = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-providers-acct-'));
  dirs.push(dir);
  const builtinPath = path.join(dir, 'zcode-builtin.json');
  if (!omitBuiltin) await writeFile(builtinPath, JSON.stringify(builtin));
  const encoded = encodeURIComponent(accountId);
  const entries = {
    'oauth:active_provider': family,
    [`oauth:${family}:user_info`]: JSON.stringify({ id: accountId, username: 'fixture' }),
    [`account-provider:coding-plan:account:${family}-individual-coding-plan:account:${encoded}:api-key`]: plans.individual,
    [`account-provider:coding-plan:account:${family}-team-coding-plan:account:${encoded}:api-key`]: plans.team,
  };
  const credentialsPath = path.join(dir, 'credentials.json');
  await writeFile(credentialsPath, JSON.stringify(Object.fromEntries(
    Object.entries(entries).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encryptForTest(v)]),
  )));
  const legacyPath = path.join(dir, 'config.json');
  return {
    dir,
    builtinPath,
    credentialsPath,
    legacyPath,
    env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_TEST_SECRET },
    options: { credentialsPath, builtinConfigPath: builtinPath, env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_TEST_SECRET } },
  };
}

const ACCOUNT_KEYS = {
  family: 'bigmodel',
  accountId: '10086',
  plans: { individual: 'sk-acct-individual-x', team: 'sk-acct-team-x' },
};

test('buildAccountProviders：账号型元素形状——levels low/high/max、defaultLevel high、contextWindow、baseURL、label、apiKey 内联', () => {
  const { providers, warnings } = buildAccountProviders(BUILTIN_PROVIDER_FIXTURE, ACCOUNT_KEYS);
  assert.deepEqual(warnings, []);
  // 个人版在前、团队版在后，providerId 沿用内置文件里的 id
  assert.deepEqual(
    providers.map((p) => p.providerId),
    ['account:bigmodel-individual-coding-plan', 'account:bigmodel-team-coding-plan'],
  );
  const ind = providers[0];
  assert.equal(ind.apiFormat, 'anthropic-messages');
  assert.equal(ind.baseURL, 'https://open.bigmodel.cn/api/anthropic');
  assert.equal(ind.label, 'BigModel Individual Coding Plan');
  assert.equal('kind' in ind, false); // 账号型没有 config.json 的 kind
  assert.deepEqual(ind.apiKey, { source: 'inline', value: 'sk-acct-individual-x' });
  assert.deepEqual(ind.models.map((m) => m.modelId), ['GLM-5.3', 'GLM-5.3-Flash']);
  // modelRules 忽略大小写：规则写 glm-5\.3，modelId 是 GLM-5.3（-Flash 也命中同一条）
  for (const m of ind.models) {
    assert.equal(m.contextWindow, 1000000);
    assert.equal(m.maxOutputTokens, 128000);
    assert.deepEqual(m.reasoning, {
      enabled: true,
      levels: [
        { value: 'low', label: 'low' },
        { value: 'high', label: 'high' },
        { value: 'max', label: 'max' },
      ],
      defaultLevel: 'high', // values 里有 high 就 high（真机 GLM 5.3 系默认 max，但档位表这么定）
    });
  }
});

test('buildAccountProviders：多条 modelRules 命中时后面覆盖前面（浅合并 properties / optionSpecs）', () => {
  const builtin = structuredClone(BUILTIN_PROVIDER_FIXTURE);
  builtin.config.modelConfigRules.modelRules.push({
    modelMatch: 'glm-5\\.3-flash', // 只覆盖 Flash；reasoningLevel 不在第二条里，保留第一条的
    config: { properties: { contextWindow: 42 }, optionSpecs: { maxOutputTokens: { max: 999 } } },
  });
  const { providers } = buildAccountProviders(builtin, ACCOUNT_KEYS);
  const flash = providers[0].models.find((m) => m.modelId === 'GLM-5.3-Flash');
  assert.equal(flash.contextWindow, 42);
  assert.equal(flash.maxOutputTokens, 999);
  assert.deepEqual(flash.reasoning.levels.map((l) => l.value), ['low', 'high', 'max']);
  const glm = providers[0].models.find((m) => m.modelId === 'GLM-5.3');
  assert.equal(glm.contextWindow, 1000000); // 不命中第二条的不受影响
});

test('buildAccountProviders：内置文件缺该 provider → 跳过并记 warnings，另一档照常生成', () => {
  const builtin = structuredClone(BUILTIN_PROVIDER_FIXTURE);
  builtin.config.providerConfigRules.providerRules = builtin.config.providerConfigRules.providerRules
    .filter((r) => r.providerId !== 'account:bigmodel-team-coding-plan');
  const { providers, warnings } = buildAccountProviders(builtin, ACCOUNT_KEYS);
  assert.deepEqual(providers.map((p) => p.providerId), ['account:bigmodel-individual-coding-plan']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /account:bigmodel-team-coding-plan/);
});

test('buildAccountProviders：builtinModelIds 为空 → 跳过并记 warning（后端 schema 要求每个 provider 至少一个模型）', () => {
  const builtin = structuredClone(BUILTIN_PROVIDER_FIXTURE);
  builtin.config.providerConfigRules.providerRules[0].config.builtinModelIds = [];
  const { providers, warnings } = buildAccountProviders(builtin, ACCOUNT_KEYS);
  assert.deepEqual(providers.map((p) => p.providerId), ['account:bigmodel-team-coding-plan']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /builtinModelIds/);
});

test('readProviderRegistry：两个来源都有 → 账号型在前、legacy 在后，sources 分开报各来源状态', async () => {
  const fx = await writeAccountFixture();
  await writeFile(fx.legacyPath, JSON.stringify(CONFIG));
  const registry = readProviderRegistry(fx.legacyPath, fx.options);
  assert.equal(registry.providers.length, 5); // 账号型 2 + legacy 3
  assert.equal(registry.providers[0].providerId, 'account:bigmodel-individual-coding-plan');
  assert.equal(registry.providers[1].providerId, 'account:bigmodel-team-coding-plan');
  assert.deepEqual(registry.sources.account, {
    ok: true, providerCount: 2, error: null, missing: false, family: 'bigmodel', plans: ['individual', 'team'],
  });
  assert.deepEqual(registry.sources.legacy, { ok: true, providerCount: 3, error: null });
  assert.deepEqual(registry.warnings, []);
});

test('readProviderRegistry：只有账号型来源（config.json 不存在）也成表', async () => {
  const fx = await writeAccountFixture();
  const registry = readProviderRegistry(fx.legacyPath, fx.options); // legacyPath 还没写，不存在
  assert.deepEqual(registry.providers.map((p) => p.providerId), [
    'account:bigmodel-individual-coding-plan',
    'account:bigmodel-team-coding-plan',
  ]);
  assert.equal(registry.sources.legacy.ok, false);
  assert.match(registry.sources.legacy.error, /找不到 zcode 配置/);
  assert.ok(registry.warnings.some((w) => /config\.json/.test(w) || /zcode 配置/.test(w)), registry.warnings.join('；'));
});

test('readProviderRegistry：credentials 在但内置文件不在 → 账号型来源记不可用，不抛（legacy 兜底）', async () => {
  const fx = await writeAccountFixture({ omitBuiltin: true });
  await writeFile(fx.legacyPath, JSON.stringify(CONFIG));
  const registry = readProviderRegistry(fx.legacyPath, fx.options);
  assert.equal(registry.providers.length, 3);
  assert.equal(registry.sources.account.ok, false);
  assert.match(registry.sources.account.error, /内置 provider 文件/);
});

test('pickProvider：account 个人版 > account 团队版 > legacy coding-plan > start-plan > 其它（T6-C 新优先级）', () => {
  const make = (ids) => ({ providers: ids.map((providerId) => ({ providerId })) });
  const all = make([
    'plain-provider',
    'builtin:zai-start-plan',
    'builtin:bigmodel-coding-plan',
    'account:bigmodel-team-coding-plan',
    'account:bigmodel-individual-coding-plan',
  ]);
  assert.equal(pickProvider(all).providerId, 'account:bigmodel-individual-coding-plan');
  // 去掉个人版 → 团队版赢
  assert.equal(pickProvider(make(all.providers.filter((p) => !p.providerId.includes('individual')).map((p) => p.providerId))).providerId, 'account:bigmodel-team-coding-plan');
  // 去掉全部账号型 → legacy coding-plan 赢
  assert.equal(pickProvider(make(all.providers.filter((p) => !p.providerId.startsWith('account:')).map((p) => p.providerId))).providerId, 'builtin:bigmodel-coding-plan');
});

test('pickProvider：preferredProvider 仍压过 account 个人版', () => {
  const registry = { providers: [
    { providerId: 'account:bigmodel-individual-coding-plan' },
    { providerId: 'plain-provider' },
  ] };
  assert.equal(pickProvider(registry, { preferredProvider: 'plain-provider' }).providerId, 'plain-provider');
});

// ---------- T6-C-fix 第 1、2 条：内置文件定位只认注入的 env，绝不从 process.env 补 ----------

test('readProviderRegistry：env 只给 ZCODE_BUILTIN_PROVIDER_CONFIG_FILE、ZCODE_BIN 指向不存在的路径（没装 App 的 CI）→ 账号型来源仍 ok', async () => {
  const fx = await writeAccountFixture();
  await writeFile(fx.legacyPath, JSON.stringify(CONFIG));
  const registry = readProviderRegistry(fx.legacyPath, {
    credentialsPath: fx.credentialsPath,
    env: {
      ZCODE_CREDENTIAL_SECRET: CREDENTIAL_TEST_SECRET,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: fx.builtinPath,
      ZCODE_BIN: '/nonexistent/zcode.cjs', // findZcode 不能抢跑：内置文件的环境变量已经指好了
    },
  });
  assert.equal(registry.sources.account.ok, true);
  assert.equal(registry.sources.account.providerCount, 2);
  assert.deepEqual(registry.warnings, []);
});

test('readProviderRegistry：注入 env 里没有的变量绝不从 process.env 补（宿主的 ZCODE_BIN / 内置文件变量不掺和）', async () => {
  const fx = await writeAccountFixture();
  await writeFile(fx.legacyPath, JSON.stringify(CONFIG));
  // 宿主环境放一个「看起来能用」的 ZCODE_BIN；注入 env 只给一个坏 ZCODE_BIN、不给内置文件变量。
  // 实现若经 process.env 的解构默认值补内置文件变量，这里就会读到宿主文件而变成 ok
  const savedBin = process.env.ZCODE_BIN;
  const savedBuiltin = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  process.env.ZCODE_BIN = fx.builtinPath;
  process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = fx.builtinPath;
  try {
    const registry = readProviderRegistry(fx.legacyPath, {
      credentialsPath: fx.credentialsPath,
      env: {
        ZCODE_CREDENTIAL_SECRET: CREDENTIAL_TEST_SECRET,
        ZCODE_BIN: '/nonexistent/from-injected-env.cjs',
      },
    });
    assert.equal(registry.sources.account.ok, false);
    assert.match(registry.sources.account.error, /from-injected-env/); // 报的是注入的那个坏值
    assert.ok(registry.warnings.some((w) => /from-injected-env/.test(w)), registry.warnings.join('；'));
  } finally {
    if (savedBin === undefined) delete process.env.ZCODE_BIN;
    else process.env.ZCODE_BIN = savedBin;
    if (savedBuiltin === undefined) delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
    else process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = savedBuiltin;
  }
});
