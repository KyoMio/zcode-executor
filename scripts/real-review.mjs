// scripts/real-review.mjs —— 真机核模型审批链路（T3.2，起 3.12.2 协议改按 D14）：写个人 provider
// 文件 → spawn（带 personalProviderFile、providerAuth）→ 用 createComplete + createReview 对一条
// 固定审批请求（Write 到 cwd 内的 hello.txt）跑一次两段判定，打印两段的原文、解析结果、耗时与 usage。
// 不建会话、不投递。
// **会花额度**（一到两次 workspace/generateText）：RULES §9 要求跑前打印提示并要 --yes。
// 给 Claude 真机核 querySource（固定 'zcode-executor.review'）与 selection 传法是否被接受；
// 结论回写 docs/verified.md。
// 不负责：npm test（这条脚本不进测试）、会话的创建与挂起。
import path from 'node:path';
import process from 'node:process';
import { loadConfig } from '../lib/config.mjs';
import { loadZcodeConfig, resolveReviewSelection } from '../lib/models.mjs';
import { EXECUTOR_PROVIDER_ID, pickProvider, writePersonalProviderFile } from '../lib/providers.mjs';
import { AppServerClient } from '../lib/appserver.mjs';
import { createComplete } from '../lib/review/complete.mjs';
import { createReview } from '../lib/review/run.mjs';

const note = (msg) => process.stderr.write(`real-review: ${msg}\n`);

if (!process.argv.includes('--yes')) {
  note('这次会花额度（真机 workspace/generateText 一到两次）。确认要跑就加 --yes');
  process.exit(1);
}

const config = loadConfig();
const { configPath, registry } = loadZcodeConfig();
const provider = pickProvider(registry, { preferredProvider: config.preferredProvider });
// resolveReviewSelection 按 fast 档 + review.thought 选模型，直接给出 D14 的 selection 形状
// （{providerId: EXECUTOR_PROVIDER_ID, modelId, options?}），不用再自己转换
const { selection } = resolveReviewSelection({ registry, providerId: provider.providerId, config });
note(`zcode 配置 ${configPath}，provider ${provider.providerId}，selection ${JSON.stringify(selection)}`);
note('querySource 固定 zcode-executor.review；思考等级走 selection.options.reasoningLevel（D14）');

const cwd = process.cwd();
const workspace = { workspacePath: cwd, workspaceKey: cwd };
const apiKey = provider.apiKey?.value;
const secrets = [apiKey].filter(Boolean);
// D14：不再推表，改写一份个人 provider 文件给 app-server 自己读；apiKey 只经这个临时文件和
// requestProviderRuntimeHeaders 的应答传出去，finally 里 dispose
const providerAuth = (providerId) => {
  note(`[反向请求] requestProviderRuntimeHeaders providerId=${providerId ?? '(缺 providerId)'}`);
  return providerId === EXECUTOR_PROVIDER_ID ? apiKey : undefined;
};
// 写文件和 spawn 都在 try 里：spawn 拉不起来（内置文件找不到等）时 finally 照样删掉带密钥的临时文件
let personalFile = null;
let client = null;
try {
  personalFile = writePersonalProviderFile(provider);
  client = await AppServerClient.spawn({ cwd, secrets, personalProviderFile: personalFile.path, providerAuth });
  const raws = [];
  const complete = createComplete({ client, workspace, selection, onRaw: (raw) => raws.push(raw) });
  const review = createReview(complete);
  const action = {
    toolName: 'Write',
    args: { file_path: path.join(cwd, 'hello.txt'), content: 'hello' },
    workspaceRoot: cwd,
  };
  const ctx = {
    intent: [{ source: 'task', text: '任务单：在执行副本里新建 hello.txt，内容一行 hello。这是模型审批的试运行，只写这一个文件' }],
    priorActions: [],
    environment: config.environment,
    sensitive: config.sensitive,
    evidence: { facts: [] },
    projectDoc: undefined,
  };
  const started = Date.now();
  const result = await review(action, ctx);
  for (const [index, raw] of raws.entries()) {
    // maxOutputTokens 一并打出来：真机核快筛预算（T3.2b）就靠这两行；
    // 慢判原文全文打到 stderr（T3.3），核结论行有没有被截断直接看这里
    const stageName = index === 0 ? '快筛' : '慢判';
    note(`第 ${index + 1} 段（${stageName}，maxOutputTokens=${raw.maxOutputTokens}，${raw.durationMs}ms，usage ${JSON.stringify(raw.usage ?? null)}）原文全文（不截断）：`);
    process.stderr.write(`${raw.text}\n`);
  }
  process.stdout.write(
    `${JSON.stringify({
      decision: result.decision,
      stage: result.stage,
      reason: result.reason ?? null,
      ruleId: result.ruleId ?? null,
      calls: raws.length,
      elapsedMs: Date.now() - started,
      selection,
      querySource: 'zcode-executor.review',
      calls_detail: raws.map((r) => ({ maxOutputTokens: r.maxOutputTokens, usage: r.usage ?? null, durationMs: r.durationMs })),
    })}\n`,
  );
} finally {
  try {
    await client?.close();
  } catch (err) {
    note(`收场失败：${err?.message ?? err}`);
  }
  // D14：个人 provider 文件用完即删
  personalFile?.dispose();
}
