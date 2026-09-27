// lib/offpeak-provider.mjs 的行为测试：闲时投递（decisions D20）的 provider 与协议形状纯函数。
// 只喂合成配置和临时文件，不读真实 ~/.zcode 与 /Applications（真机路径只当字符串算哈希）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  offPeakProviderId,
  offPeakModelIds,
  formatBuiltinRevision,
  builtinRevision,
  buildOffPeakAccountConfig,
  buildOffPeakSendParams,
} from '../lib/offpeak-provider.mjs';
import { BUILTIN_PROVIDER_FIXTURE } from './helpers.mjs';

const dirs = [];
test.after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

// 参数错一律退出码 2（PRD：用法对但前置条件不满足）
const EXEC_ERR_2 = { name: 'ExecutorError', exitCode: 2 };

// 内置文件里的闲时隐藏条目（形状照真机 zcode-builtin.json，verified.md「闲时任务探针」2026-09-27 App 3.14.1）；
// helpers 的夹具没有它，就近造一份
const OFFPEAK_BUILTIN = {
  revision: 30,
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: 'account:bigmodel-offpeak-idle-plan',
          config: {
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
            access: { type: 'zhipu-account', mode: 'off-peak', accountType: 'bigmodel' },
            api: { type: 'anthropic-messages', baseUrl: 'https://zcode.z.ai/api/v1/off-peak/anthropic' },
          },
        },
      ],
    },
  },
};

const SEND_BASE = {
  family: 'zai',
  modelId: 'GLM-5.3',
  reasoningLevel: 'max',
  jwt: 'jwt-aaaa.bbbb.cccc',
  planKey: 'plan-key-123456',
  ticketId: '1000000000000000001',
  offPeakId: 'offpeak-uuid-1',
};

test('offPeakProviderId：两个账号族各得各的闲时 provider id', () => {
  assert.equal(offPeakProviderId('zai'), 'account:zai-offpeak-idle-plan');
  assert.equal(offPeakProviderId('bigmodel'), 'account:bigmodel-offpeak-idle-plan');
});

test('offPeakProviderId：不认识的账号族抛 ExecutorError（退出码 2）', () => {
  assert.throws(() => offPeakProviderId('openai'), EXEC_ERR_2);
  assert.throws(() => offPeakProviderId(undefined), EXEC_ERR_2);
});

test('offPeakModelIds：返回内置条目的 builtinModelIds', () => {
  assert.deepEqual(offPeakModelIds(OFFPEAK_BUILTIN, 'bigmodel'), ['GLM-5.3', 'GLM-5.3-Flash']);
});

test('offPeakModelIds：内置文件里没有这个族的闲时条目返回 null', () => {
  assert.equal(offPeakModelIds(OFFPEAK_BUILTIN, 'zai'), null);
  assert.equal(offPeakModelIds(BUILTIN_PROVIDER_FIXTURE, 'bigmodel'), null);
});

test('offPeakModelIds：providerRules 不是数组时返回 null，不抛 TypeError', () => {
  const broken = { config: { providerConfigRules: { providerRules: { 'account:zai-offpeak-idle-plan': {} } } } };
  assert.equal(offPeakModelIds(broken, 'zai'), null);
  assert.equal(offPeakModelIds(null, 'zai'), null);
});

test('formatBuiltinRevision：哈希的是内置文件的绝对路径字符串（真机 3.14.1 实测值）', () => {
  const realPath = '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json';
  assert.equal(
    formatBuiltinRevision(30, realPath),
    'zcode-builtin:30:8f54ff88821cb0f70c213894cd6e3434966f570e74b53e061aa19778f79fab1c',
  );
});

test('formatBuiltinRevision：相对路径先按 cwd 解析成绝对路径再哈希', () => {
  const rel = path.join('some', 'zcode-builtin.json');
  assert.equal(formatBuiltinRevision(7, rel), formatBuiltinRevision(7, path.resolve(rel)));
});

test('builtinRevision：读内置文件的 revision，和路径哈希拼成版本号', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-offpeak-rev-'));
  dirs.push(dir);
  const file = path.join(dir, 'zcode-builtin.json');
  await writeFile(file, JSON.stringify(OFFPEAK_BUILTIN));
  assert.equal(builtinRevision(file), formatBuiltinRevision(30, file));
  assert.match(builtinRevision(file), /^zcode-builtin:30:[0-9a-f]{64}$/);
});

test('builtinRevision：文件不存在、不是 JSON、没有 revision 都抛 ExecutorError（退出码 2）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-offpeak-rev-'));
  dirs.push(dir);
  const bad = path.join(dir, 'bad.json');
  await writeFile(bad, '{not json');
  const norev = path.join(dir, 'norev.json');
  await writeFile(norev, JSON.stringify({ config: {} }));
  assert.throws(() => builtinRevision(path.join(dir, 'missing.json')), EXEC_ERR_2);
  assert.throws(() => builtinRevision(bad), EXEC_ERR_2);
  assert.throws(() => builtinRevision(norev), EXEC_ERR_2);
});

test('buildOffPeakAccountConfig：授权闲时 provider 的 updateAccountConfig 参数', () => {
  const params = buildOffPeakAccountConfig({ family: 'zai', basedOnZCodeBuiltinRevision: 'zcode-builtin:30:abc', now: 1700000000000 });
  assert.deepEqual(params, {
    revision: 'zcode-executor-offpeak:1700000000000',
    basedOnZCodeBuiltinRevision: 'zcode-builtin:30:abc',
    providers: { 'account:zai-offpeak-idle-plan': { access: { type: 'zhipu-account', entitled: true } } },
    states: { 'account:zai-offpeak-idle-plan': { availability: 'available', entitled: true, current: true } },
  });
});

test('buildOffPeakAccountConfig：缺内置版本号抛 ExecutorError（退出码 2，CLI 会静默忽略整份配置）', () => {
  assert.throws(() => buildOffPeakAccountConfig({ family: 'zai' }), EXEC_ERR_2);
});

test('buildOffPeakSendParams：闲时回合要带的模型选择、请求鉴权与闲时标识', () => {
  const params = buildOffPeakSendParams({ ...SEND_BASE, family: 'bigmodel', modelId: 'GLM-5.3-Flash', reasoningLevel: 'high' });
  assert.deepEqual(params, {
    modelSelection: { providerId: 'account:bigmodel-offpeak-idle-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'high' } },
    modelExecution: {
      selectionScope: 'execution',
      memoryExtraction: 'skip',
      requestAuth: {
        apiKey: 'jwt-aaaa.bbbb.cccc',
        headers: {
          Authorization: 'Bearer jwt-aaaa.bbbb.cccc',
          'X-Coding-Plan-Api-Key': 'plan-key-123456',
          'X-Off-Peak-Ticket-ID': '1000000000000000001',
        },
      },
      subagents: { foregroundModel: 'submission', background: 'deny' },
    },
    offPeakTaskId: 'offpeak-uuid-1',
    offPeakRunType: 'init',
    toolDenylist: ['CronCreate', 'OffPeakCreate'],
  });
});

test('buildOffPeakSendParams：续跑标 resume，toolDenylist 在调用方列表上追加并去重', () => {
  const params = buildOffPeakSendParams({ ...SEND_BASE, runType: 'resume', toolDenylist: ['WebFetch', 'CronCreate'] });
  assert.equal(params.offPeakRunType, 'resume');
  assert.deepEqual(params.toolDenylist, ['WebFetch', 'CronCreate', 'OffPeakCreate']);
});

test('buildOffPeakSendParams：runType 不是 init/resume、缺号或缺凭据都抛 ExecutorError（退出码 2）', () => {
  assert.throws(() => buildOffPeakSendParams({ ...SEND_BASE, runType: 'restart' }), EXEC_ERR_2);
  assert.throws(() => buildOffPeakSendParams({ ...SEND_BASE, ticketId: undefined }), EXEC_ERR_2);
  assert.throws(() => buildOffPeakSendParams({ ...SEND_BASE, jwt: '' }), EXEC_ERR_2);
  assert.throws(() => buildOffPeakSendParams({ ...SEND_BASE, planKey: undefined }), EXEC_ERR_2);
});

test('buildOffPeakSendParams：JWT 或 plan key 短于 8 个字符抛 ExecutorError（太短的值落盘时抹不掉）', () => {
  assert.throws(() => buildOffPeakSendParams({ ...SEND_BASE, jwt: 'a.b.c' }), EXEC_ERR_2);
  assert.throws(() => buildOffPeakSendParams({ ...SEND_BASE, planKey: 'k1234' }), EXEC_ERR_2);
  // 恰好 8 个字符放行
  assert.doesNotThrow(() => buildOffPeakSendParams({ ...SEND_BASE, jwt: '12345678', planKey: 'abcdefgh' }));
});
