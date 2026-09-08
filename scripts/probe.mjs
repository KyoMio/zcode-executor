// 本文件负责：零 token 探针——拉起真机 app-server 依次走 spawn → 推 provider 表 →
// session/create（含 toolDenylist 试探）→ workspace/readState → session/list → session/close →
// 收场，每步打一行 JSON 到 stdout，给 docs/verified.md 攒真机事实。
// 不负责：发 session/send（绝不发，探针零 token）、会话编排（那是上层的事）。
// 用法：node scripts/probe.mjs。单步失败不中断，能继续的步骤继续；全局兜底见 main() 的 catch。
// 所有 stdout 输出先过 redactSecrets 再过 scrubValues（按值抹 apiKey）；provider 表只进请求 params。
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { AppServerClient } from '../lib/appserver.mjs';
import { ExecutorError } from '../lib/errors.mjs';
import { readProviderRegistry } from '../lib/providers.mjs';
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

/** 会话列表的形状协议文档没写，防御式提取所有 sessionId（探针核完由 Claude 回填 verified.md）。 */
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
  // 表在 spawn 之前读好：apiKey 值要作为 secrets 传给客户端，从子进程 stderr 转发里抹掉；
  // 读表的失败先记下，等 spawn 打完自己的行再报
  let registry = null;
  let registryError = null;
  try {
    registry = readProviderRegistry();
    outSecrets = registry.providers.map((p) => p.apiKey?.value).filter(Boolean);
  } catch (err) {
    registryError = err;
  }

  let runtimePrefs = { params: null, beforeCreate: null };
  let createSent = false;
  let client;
  try {
    client = await AppServerClient.spawn({
      cwd: dir,
      secrets: outSecrets,
      onServerRequest: (req) => {
        if (req.method === 'session/requestRuntimePreferences') {
          // 返回 undefined 让客户端回内置默认值；这里只记录有没有到过、相对 create 的时序
          if (runtimePrefs.params === null) {
            runtimePrefs.params = req.params ?? {};
            runtimePrefs.beforeCreate = !createSent;
          }
          return undefined;
        }
        emit({ step: 'unexpected-server-request', method: req.method, params: req.params ?? {} });
        return {};
      },
    });
  } catch (err) {
    failStep('spawn', err);
    process.exitCode = err.exitCode ?? 1;
    return;
  }
  okStep('spawn', { result: { pid: client.pid } });

  const workspace = { workspacePath: dir, workspaceKey: dir };

  // 直连时 app-server 不自己读配置，create 之前必须推 provider 表（decisions.md D10）
  try {
    if (registryError !== null) throw registryError;
    await client.request('workspace/updateProviderRegistry', { workspace, registry }, { timeoutMs: 20_000 });
    okStep('updateProviderRegistry', {
      providers: registry.providers.length,
      providerIds: registry.providers.map((p) => p.providerId),
    });
  } catch (err) {
    failStep('updateProviderRegistry', err);
  }

  const createParams = {
    workspace,
    mode: 'build',
    persistence: 'immediate',
    titleGenerationEnabled: false,
    thoughtLevel: 'high',
    toolDenylist: ['WebSearch'],
  };
  createSent = true;
  let created = null;
  try {
    const result = await client.request('session/create', createParams, { timeoutMs: 20_000 });
    created = result;
    okStep('create', { result });
  } catch (err) {
    failStep('create', err);
    // 任务单要求：toolDenylist 可能不被接受，去掉再建一次看结果
    const { toolDenylist: _dropped, ...withoutDenylist } = createParams;
    try {
      const result = await client.request('session/create', withoutDenylist, { timeoutMs: 20_000 });
      created = result;
      okStep('create-retry-without-denylist', { result });
    } catch (err2) {
      failStep('create-retry-without-denylist', err2);
    }
  }

  try {
    const result = await client.request('workspace/readState', { workspace }, { timeoutMs: 20_000 });
    okStep('readState', { result });
  } catch (err) {
    failStep('readState', err);
  }

  const sessionId = created?.session?.sessionId;
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

  // 收尾汇总 requestRuntimePreferences 有没有到过、相对 create 前后的时序，不再等待（T0.2b）
  emit({
    step: 'runtimePreferences',
    arrived: runtimePrefs.params !== null,
    arrivedBeforeCreate: runtimePrefs.beforeCreate,
    params: runtimePrefs.params,
  });
}

try {
  await main();
} catch (err) {
  // 兜底（评审第 11 条）：任何没接住的错打到 stderr，退出码按 ExecutorError 的表走
  console.error(`probe: ${err?.message ?? err}`);
  process.exitCode = err?.exitCode ?? 1;
}
