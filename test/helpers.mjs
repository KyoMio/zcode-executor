// test/helpers.mjs —— 起 mock、等条件、收尾杀进程的公共函数（T0.3）。
// 只服务测试；不负责协议行为（那是 mock-appserver.mjs 的事）。
// T0.3c 第 5 条：startMock 不再写 process.env，env 由调用方经 AppServerClient.spawn 的
// env 选项传给子进程——这是并发用例（队列、锁）的前提。
// 3.12（docs/reference/zcode-app-server-protocol.md「3.12.2 变化」）：mock 和真机一样要两个环境变量才肯启动，startMock 在临时目录里
// 准备好假的内置文件和一份默认个人 provider 文件，放进返回的 env。
// T6-C：内置文件夹具带账号型 providerRules 与 GLM-5.3 的 modelRules（形状照真机 zcode-builtin.json，
// 2026-09-21 对照 ZCode 源码 3.14.0）；可选写一份加密的 credentials.json。ZCODE_DATA_BASE_DIR 一律
// 指进夹具临时目录、ZCODE_CREDENTIAL_SECRET 固定测试值——测试全程不读真实的 ~/.zcode，密钥派生不依赖运行机器。
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPersonalProviderConfig } from '../lib/providers.mjs';
import { deriveCredentialKey } from '../lib/credentials.mjs';

const MOCK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-appserver.mjs');

// 测试固定密钥（任务单 T6-C）：credentials.json 的加密与解密都用它，不随机器变
export const CREDENTIAL_TEST_SECRET = 'zcode-executor-test-credential-secret';

/** 把明文加密成 enc:v1:<iv>.<tag>.<密文>（三段 base64url，与 App 写盘格式一致）。 */
export function encryptForTest(plain, key = deriveCredentialKey({ env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_TEST_SECRET } })) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const b64u = (buf) => buf.toString('base64url');
  return `enc:v1:${b64u(iv)}.${b64u(cipher.getAuthTag())}.${b64u(data)}`;
}

// 内置 provider 文件夹具：账号型 coding plan 条目 + GLM-5.3 系的模型规则（形状照任务单 T6-C 抄的真机事实）
export const BUILTIN_PROVIDER_FIXTURE = {
  schemaVersion: 1,
  revision: 'mock-builtin-revision-1',
  config: {
    providerConfigRules: {
      providerRules: [
        {
          providerId: 'account:bigmodel-individual-coding-plan',
          providerName: 'BigModel Individual Coding Plan',
          config: {
            group: 'bigmodel-family',
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
            access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'bigmodel' },
            api: { type: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
          },
        },
        {
          providerId: 'account:bigmodel-team-coding-plan',
          providerName: 'BigModel Team Coding Plan',
          config: {
            group: 'bigmodel-family',
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
            access: { type: 'zhipu-account', mode: 'team-coding-plan', accountType: 'bigmodel' },
            api: { type: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
          },
        },
        {
          providerId: 'account:zai-individual-coding-plan',
          providerName: 'ZAI Individual Coding Plan',
          config: {
            group: 'zai-family',
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
            access: { type: 'zhipu-account', mode: 'individual-coding-plan', accountType: 'zai' },
            api: { type: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' },
          },
        },
        {
          providerId: 'account:zai-team-coding-plan',
          providerName: 'ZAI Team Coding Plan',
          config: {
            group: 'zai-family',
            builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'],
            access: { type: 'zhipu-account', mode: 'team-coding-plan', accountType: 'zai' },
            api: { type: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' },
          },
        },
      ],
    },
    modelConfigRules: {
      // 2026-09-21 对照 ZCode 源码 3.14.0：modelMatch 按忽略大小写匹配 modelId，多条命中后面覆盖前面
      modelRules: [
        {
          modelMatch: '.*glm-5\\.3(?:-flash)?(?:[.\\-:/\\[].*)?',
          config: {
            properties: { contextWindow: 1000000 },
            optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] }, maxOutputTokens: { max: 128000 } },
          },
        },
      ],
    },
  },
};

/**
 * 写剧本到临时目录，返回可直接交给 AppServerClient.spawn 的 zcodePath 和 env。
 * 个人文件走 lib/providers.mjs 的 buildPersonalProviderConfig（真实构造路径，形状顺带被 mock 读到），
 * providerId 固定 zcode-executor，模型 GLM-5.3-Flash 与 GLM-5.3，apiKey 每次随机；
 * 直接 spawn 的用例把 `providerAuth: () => apiKey` 传进去，回合的模型请求才放得行。
 * T6-C：env 一律带 ZCODE_DATA_BASE_DIR（指进夹具，凭据默认路径解析落在夹具里，不读真实 ~/.zcode）
 * 与 ZCODE_CREDENTIAL_SECRET（固定测试值）。给了 credentials 才写加密的 credentials.json。
 *
 * @param {object} [opts.credentials] 账号型登录夹具：{ family='bigmodel', accountId='10086',
 *   individual=true, team=true }；两把 api-key 随机生成，值返回在 accountKeys 里（断言「输出不含 key」用）
 * @returns {Promise<{zcodePath: string, env: object, recordPath: string, dir: string,
 *   personalProviderFile: string, apiKey: string, credentialsPath: string,
 *   accountKeys: {individual?: string, team?: string}, cleanup: () => Promise<void>}>}
 */
export async function startMock({ script, record, version, credentials } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-mock-'));
  const scriptPath = path.join(dir, 'script.json');
  await writeFile(scriptPath, JSON.stringify(script ?? {}));
  const recordPath = record ?? path.join(dir, 'record.jsonl');
  const builtinFile = path.join(dir, 'zcode-builtin.json');
  await writeFile(builtinFile, JSON.stringify(BUILTIN_PROVIDER_FIXTURE)); // mock 只查存在；内容给 readProviderRegistry 的账号型来源读
  const apiKey = `mock-api-key-${randomUUID().slice(0, 8)}`;
  const personalProviderFile = path.join(dir, 'provider.json');
  await writeFile(
    personalProviderFile,
    JSON.stringify(
      buildPersonalProviderConfig({
        providerId: 'builtin:mock-coding-plan',
        apiFormat: 'anthropic-messages',
        baseURL: 'https://mock.invalid/api/anthropic',
        apiKey: { source: 'inline', value: apiKey },
        models: [{ modelId: 'GLM-5.3-Flash' }, { modelId: 'GLM-5.3' }],
      }),
    ),
    { mode: 0o600 },
  );
  const dataDir = path.join(dir, 'zcode-data');
  const credentialsPath = path.join(dataDir, '.zcode', 'v2', 'credentials.json');
  const accountKeys = {};
  if (credentials) {
    const { family = 'bigmodel', accountId = '10086', individual = true, team = true } = credentials;
    if (individual) accountKeys.individual = `account-key-individual-${randomBytes(4).toString('hex')}`;
    if (team) accountKeys.team = `account-key-team-${randomBytes(4).toString('hex')}`;
    const encoded = encodeURIComponent(accountId);
    const entries = {
      'oauth:active_provider': family,
      [`oauth:${family}:user_info`]: JSON.stringify({ id: accountId, username: 'fixture', displayName: '夹具', rawProfile: {} }),
      [`account-provider:coding-plan:account:${family}-individual-coding-plan:account:${encoded}:api-key`]: accountKeys.individual,
      [`account-provider:coding-plan:account:${family}-team-coding-plan:account:${encoded}:api-key`]: accountKeys.team,
      [`oauth:${family}:access_token`]: 'enc:v1:garbage', // 别的键给了坏密文也不该被读
    };
    for (const key of Object.keys(entries)) {
      if (entries[key] !== undefined) entries[key] = encryptForTest(String(entries[key]));
    }
    await mkdir(path.dirname(credentialsPath), { recursive: true });
    await writeFile(credentialsPath, JSON.stringify(entries), { mode: 0o600 });
  }
  const env = {
    MOCK_APPSERVER_SCRIPT: scriptPath,
    MOCK_APPSERVER_RECORD: recordPath,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinFile,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalProviderFile,
    ZCODE_DATA_BASE_DIR: dataDir,
    ZCODE_CREDENTIAL_SECRET: CREDENTIAL_TEST_SECRET,
    ...(version ? { MOCK_APPSERVER_VERSION: version } : {}),
  };
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(dir, { recursive: true, force: true });
  };
  return { zcodePath: MOCK_PATH, env, recordPath, dir, personalProviderFile, apiKey, credentialsPath, accountKeys, cleanup };
}

/** 轮询直到 fn 返回真值；返回那个值，超时抛错（带上最后一次的值方便排障）。 */
// 默认 20 秒：这是上限不是断言，CI 的两核机器上 runner 拉起 mock 再走到轮询点就要好几秒；
// 要断言「多久之内」的用例自己传短的 timeoutMs
export async function waitFor(fn, { timeoutMs = 20000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let value;
  for (;;) {
    value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor 超时（${timeoutMs}ms），最后结果：${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * 记录文件 → 消息数组（一行一条 JSON）。文件还不存在（ENOENT）返回空数组；
 * 最后一行 JSON 解析失败视为半截写入丢掉；其余异常照常抛（T0.3c 第 7 条）。
 */
export function readRecord(recordPath) {
  let raw;
  try {
    raw = readFileSync(recordPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  const out = [];
  lines.forEach((line, index) => {
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      if (index === lines.length - 1) return; // 最后一行可能是写了一半的，丢掉
      throw err;
    }
  });
  return out;
}

/** after() 用：SIGKILL 一组 pid，已死的忽略。 */
export function killAll(pids) {
  for (const pid of pids ?? []) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退了，忽略
    }
  }
  pids.length = 0;
}
