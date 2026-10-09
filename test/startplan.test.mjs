// start plan 投递的纯函数单测（lib/startplan-provider.mjs，decisions D21）。
// 只测形状与报错；内置配置夹具照真机 zcode-builtin.json 的 start plan 条目形状（2026-09-29 本机 3.14.1）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutorError } from '../lib/errors.mjs';
import { builtinRevision } from '../lib/offpeak-provider.mjs';
import {
  buildStartPlanAccountConfig,
  buildStartPlanSendParams,
  startPlanModelIds,
  startPlanProviderId,
} from '../lib/startplan-provider.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dirs = [];
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

/** 内置配置夹具：providerRules 与 modelRules 的形状照真机（modelRules 给 startplan-provider 不用，只放条目）。 */
function builtinConfig({ families = ['bigmodel', 'zai'], models = ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo'], revision = 'mock-revision-1' } = {}) {
  return {
    revision,
    config: {
      providerConfigRules: {
        providerRules: families.map((family) => ({
          providerId: `account:${family}-start-plan`,
          providerName: 'Start Plan',
          config: {
            group: `${family}-family`,
            access: { type: 'zhipu-account', accountType: family, mode: 'start-plan' },
            api: { type: 'anthropic-messages', baseUrl: 'https://zcode.z.ai/api/v1/zcode-plan/anthropic' },
            builtinModelIds: models,
          },
        })),
      },
      modelConfigRules: { modelRules: [] },
    },
  };
}

test('startplan：providerId 按族拼，族不对抛 ExecutorError(2)', () => {
  assert.equal(startPlanProviderId('bigmodel'), 'account:bigmodel-start-plan');
  assert.equal(startPlanProviderId('zai'), 'account:zai-start-plan');
  assert.throws(() => startPlanProviderId('team'), (err) => err instanceof ExecutorError && err.exitCode === 2);
});

test('startplan：模型表从内置条目的 builtinModelIds 来', () => {
  assert.deepEqual(startPlanModelIds(builtinConfig(), 'bigmodel'), ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']);
});

test('startplan：内置文件没条目、providerRules 不是数组 → 模型表 null（交给调用方报接口变了）', () => {
  assert.equal(startPlanModelIds({ config: { providerConfigRules: { providerRules: [] } } }, 'bigmodel'), null);
  assert.equal(startPlanModelIds({ config: {} }, 'bigmodel'), null);
  assert.equal(startPlanModelIds(null, 'bigmodel'), null);
});

test('startplan：授权配置形状与闲时同款，revision 前缀是 zcode-executor-start-plan', () => {
  const config = buildStartPlanAccountConfig({ family: 'bigmodel', basedOnZCodeBuiltinRevision: 'zcode-builtin:rev:hash', now: 1234 });
  assert.deepEqual(config, {
    revision: 'zcode-executor-start-plan:1234',
    basedOnZCodeBuiltinRevision: 'zcode-builtin:rev:hash',
    providers: { 'account:bigmodel-start-plan': { access: { type: 'zhipu-account', entitled: true } } },
    states: { 'account:bigmodel-start-plan': { availability: 'available', entitled: true, current: true } },
  });
});

test('startplan：授权配置缺 basedOnZCodeBuiltinRevision 抛 ExecutorError(2)', () => {
  assert.throws(() => buildStartPlanAccountConfig({ family: 'bigmodel' }), (err) => err instanceof ExecutorError && err.exitCode === 2);
});

test('startplan：send 参数——modelSelection 加 options、modelExecution 是 execution 作用域，没有 requestAuth', () => {
  const params = buildStartPlanSendParams({ family: 'bigmodel', modelId: 'GLM-5.3-Flash', reasoningLevel: 'high' });
  assert.deepEqual(params, {
    modelSelection: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } },
    modelExecution: { selectionScope: 'execution', memoryExtraction: 'skip' },
  });
  // 思考等级为空不带 options（同 buildModelSelection）
  const bare = buildStartPlanSendParams({ family: 'zai', modelId: 'GLM-5.2' });
  assert.deepEqual(bare.modelSelection, { providerId: 'account:zai-start-plan', modelId: 'GLM-5.2' });
});

test('startplan：send 参数缺 modelId 抛 ExecutorError(2)', () => {
  assert.throws(() => buildStartPlanSendParams({ family: 'bigmodel' }), (err) => err instanceof ExecutorError && err.exitCode === 2);
});

test('startplan：send 参数与授权配置里查不到任何凭据形状的字段（JWT 走反向请求，不进 send 参数）', () => {
  const params = JSON.stringify(buildStartPlanSendParams({ family: 'bigmodel', modelId: 'GLM-5.3-Flash', reasoningLevel: 'high' }));
  assert.equal(/jwt|apiKey|requestAuth|Bearer/i.test(params), false);
});

test('startplan：builtinRevision 可从 offpeak-provider 复用（读真机形状的内置文件）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-startplan-test-'));
  dirs.push(dir);
  const file = path.join(dir, 'zcode-builtin.json');
  await writeFile(file, JSON.stringify(builtinConfig()));
  const rev = builtinRevision(file);
  assert.match(rev, /^zcode-builtin:mock-revision-1:[0-9a-f]{64}$/);
});
