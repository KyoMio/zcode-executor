// 本文件负责：零 token 探针（AGENTS.md 硬约束：先走零 token 路径）——按 3.12.2 协议（decisions D14）
// 走一遍 读表 → pickProvider → writePersonalProviderFile → spawn（personalProviderFile、providerAuth、
// secrets）→ 确认两个被删方法/字段仍报错（workspace/updateProviderRegistry → -32601，
// create 带 runtimeModel → -32602）→ 新形状 create（model + 顶层 thoughtLevel + toolDenylist 试探）→
// session/subscribe → session/list → session/resume → session/close → 收场，每步打一行 JSON 到 stdout，
// 给 docs/verified.md 攒真机事实。
// 不负责：发 session/send（绝不发，探针零 token）、会话编排（那是上层的事）。
// 用法：node scripts/probe.mjs。单步失败不中断，能继续的步骤继续；全局兜底见 main() 的 catch。
// 所有 stdout 输出先过 redactSecrets 再过 scrubValues（按值抹 apiKey）；个人 provider 文件用完
// 在 finally 里 dispose（RULES §6：密钥只落这一个临时文件，收场即删）。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { AppServerClient } from '../lib/appserver.mjs';
import { ExecutorError } from '../lib/errors.mjs';
import {
  EXECUTOR_PROVIDER_ID,
  buildModelSelection,
  pickProvider,
  readProviderRegistry,
  writePersonalProviderFile,
} from '../lib/providers.mjs';
import { redactSecrets, scrubValues } from '../lib/scrub.mjs';

// registry 里的 apiKey 值，读表后填上；每行输出序列化后先按值抹一遍、再按键名抹一遍
let outSecrets = [];
const emit = (obj) => console.log(scrubValues(JSON.stringify(redactSecrets(obj)), outSecrets));
const okStep = (step, extra) => emit({ step, ok: true, ...extra });
const failStep = (step, err) => emit({ step, ok: false, error: errorOf(err) });

function errorOf(err) {
  if (err instanceof ExecutorError) return { message: err.message, ...err.details };
  return { message: String(err?.message ?? err) };
}

/**
 * 期望这个请求被拒——3.12 删掉的方法/字段必须报 expectedCode。报别的错误码或者意外成功
 * 都算 ok:false（协议可能又变了，值得留意）；报对了打 ok:true，意思是「确认已删」。
 */
async function expectGone(step, request, expectedCode) {
  try {
    const result = await request();
    emit({ step, ok: false, note: '预期报错却成功了，协议可能又变了', result });
  } catch (err) {
    const code = err instanceof ExecutorError ? err.details?.code : undefined;
    emit({ step, ok: code === expectedCode, expectedCode, actualCode: code, message: err.message });
  }
}

/** 会话列表的形状协议文档没写死，防御式提取所有 sessionId。 */
function extractSessionIds(result) {
  const list = Array.isArray(result) ? result : result?.sessions ?? result?.items;
  if (!Array.isArray(list)) return [];
  return list.map((s) => (typeof s === 'string' ? s : s?.sessionId)).filter(Boolean);
}

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zcode-probe-'));
  try {
    // workspace 是个 git 仓库更接近真实；init 失败只警告，不挡探针
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: dir, stdio: 'ignore' });
    } catch (err) {
      console.error(`probe: git init 失败（${err.message}），继续用普通目录`);
    }
    await runProbe(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runProbe(dir) {
  // 读表 → pickProvider：失败就没法往下走个人文件与 spawn，直接报错收场
  let provider;
  try {
    const registry = readProviderRegistry();
    outSecrets = registry.providers.map((p) => p.apiKey?.value).filter(Boolean);
    provider = pickProvider(registry);
    okStep('pickProvider', { providerId: provider.providerId, models: provider.models.map((m) => m.modelId) });
  } catch (err) {
    failStep('pickProvider', err);
    process.exitCode = err.exitCode ?? 1;
    return;
  }

  // 个人 provider 文件（D14）：里面的 apiKey 和 registry 里的同一个值，重复加一次也无妨（outSecrets 去重）
  let personalFile;
  try {
    personalFile = writePersonalProviderFile(provider);
    outSecrets = [...new Set([...outSecrets, provider.apiKey?.value].filter(Boolean))];
    okStep('writePersonalProviderFile', { path: personalFile.path });
  } catch (err) {
    failStep('writePersonalProviderFile', err);
    process.exitCode = err.exitCode ?? 1;
    return;
  }

  try {
    await runWithClient(dir, provider, personalFile);
  } finally {
    personalFile.dispose();
    const existsAfter = existsSync(personalFile.path); // 应为 false：确认密钥文件真的删了
    emit({ step: 'dispose', ok: !existsAfter, existsAfter });
  }
}

async function runWithClient(dir, provider, personalFile) {
  let client;
  try {
    client = await AppServerClient.spawn({
      cwd: dir,
      secrets: outSecrets,
      personalProviderFile: personalFile.path,
      providerAuth: (providerId) => (providerId === EXECUTOR_PROVIDER_ID ? provider.apiKey?.value : undefined),
    });
  } catch (err) {
    failStep('spawn', err);
    process.exitCode = err.exitCode ?? 1;
    return;
  }
  okStep('spawn', { result: { pid: client.pid } });

  const workspace = { workspacePath: dir, workspaceKey: dir };

  // 两个 3.12 删掉的方法/字段：确认已删（PLAN-3.12.md 一节层 2、3；decisions D10、D11）
  await expectGone(
    'updateProviderRegistry-gone',
    () =>
      client.request(
        'workspace/updateProviderRegistry',
        { workspace, registry: { providers: [], generatedAt: 1, revision: 'x' } },
        { timeoutMs: 20_000 },
      ),
    -32601,
  );
  await expectGone(
    'create-runtimeModel-gone',
    () =>
      client.request(
        'session/create',
        {
          workspace,
          mode: 'build',
          persistence: 'deferred',
          titleGenerationEnabled: false,
          runtimeModel: { model: { providerId: provider.providerId, modelId: provider.models[0]?.modelId } },
        },
        { timeoutMs: 20_000 },
      ),
    -32602,
  );

  // 新形状 create：model + 顶层 thoughtLevel + toolDenylist 试探（PLAN-3.12.md 二节第 3 条）
  const modelId = provider.models[0]?.modelId;
  const model = buildModelSelection(provider, modelId, 'high');
  const createParams = {
    workspace,
    mode: 'build',
    persistence: 'immediate',
    titleGenerationEnabled: false,
    thoughtLevel: 'high',
    model,
    toolDenylist: ['WebSearch'],
  };
  let created = null;
  try {
    created = await client.request('session/create', createParams, { timeoutMs: 20_000 });
    okStep('create', { result: created });
  } catch (err) {
    failStep('create', err);
    // toolDenylist 可能不被接受，去掉再建一次看结果
    const { toolDenylist: _dropped, ...withoutDenylist } = createParams;
    try {
      created = await client.request('session/create', withoutDenylist, { timeoutMs: 20_000 });
      okStep('create-retry-without-denylist', { result: created });
    } catch (err2) {
      failStep('create-retry-without-denylist', err2);
    }
  }

  const sessionId = created?.session?.sessionId;

  if (sessionId !== undefined) {
    try {
      const result = await client.request(
        'session/subscribe',
        { sessionId, deliveryKind: 'desktop-continuous', includeSnapshot: false, afterSeq: 0 },
        { timeoutMs: 20_000 },
      );
      okStep('subscribe', { result });
    } catch (err) {
      failStep('subscribe', err);
    }
  } else {
    console.error('probe: 没拿到 sessionId，跳过 session/subscribe');
  }

  try {
    const result = await client.request('session/list', { workspace }, { timeoutMs: 20_000 });
    const ids = extractSessionIds(result);
    okStep('list', { result: ids });
    emit({ step: 'list-contains-created', ok: sessionId !== undefined && ids.includes(sessionId) });
  } catch (err) {
    failStep('list', err);
    emit({ step: 'list-contains-created', ok: false });
  }

  if (sessionId !== undefined) {
    try {
      const result = await client.request('session/resume', { sessionId, workspace }, { timeoutMs: 20_000 });
      okStep('resume', { result });
    } catch (err) {
      failStep('resume', err);
    }
  } else {
    console.error('probe: 没拿到 sessionId，跳过 session/resume');
  }

  if (sessionId !== undefined) {
    try {
      const result = await client.request('session/close', { sessionId }, { timeoutMs: 20_000 });
      okStep('close', { result });
    } catch (err) {
      failStep('close', err);
    }
  } else {
    console.error('probe: 没拿到 sessionId，跳过 session/close');
  }

  const exitInfo = await client.close();
  emit({ step: 'exit', code: exitInfo.code, signal: exitInfo.signal });
  process.exitCode = exitInfo.code ?? 1;
}

try {
  await main();
} catch (err) {
  // 兜底：任何没接住的错打到 stderr，退出码按 ExecutorError 的表走
  console.error(`probe: ${err?.message ?? err}`);
  process.exitCode = err?.exitCode ?? 1;
}
