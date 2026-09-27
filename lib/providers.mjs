// 本文件负责：构造 provider 表的两个来源并合并（readProviderRegistry：账号型 credentials.json 来源在前，
// legacy ~/.zcode/v2/config.json 来源在后，T6-C / decisions D19）、账号型元素的拼装（buildAccountProviders）、
// 选 provider（pickProvider，decisions D6）、以及 3.12 起 app-server 要的两样东西：个人 provider 文件
// （buildPersonalProviderConfig / writePersonalProviderFile，decisions D14）和 session/create 与
// workspace/generateText 共用的模型选择（buildModelSelection）。
// 不负责：发请求（协议层的事）、配置的写入（config.json 与 credentials.json 永远只读）、凭据解密
// （lib/credentials.mjs）、输出脱敏（在 lib/scrub.mjs，T0.3b 复核 B 把它挪过去让协议层不必依赖本模块）。
//
// 安全边界（RULES §6、§8，decisions D14/D19）：本文件读到的 config 与凭据内容——包括两类来源的 apiKey——
// 只有两个去处：一是 writePersonalProviderFile 写的临时文件（os.tmpdir() 下 mkdtemp 的目录，0600，子进程
// 收场 dispose 即删），二是协议层按需答给子进程的反向请求；永不进 runs/、日志和任何面向人的输出。
// credentials.json 只读、只解四个键（lib/credentials.mjs），解出的 key 只进临时个人文件与 secrets 抹除名单。
// 3.12.2 没有不落盘的路（verified.md「3.12.2 直连探针实测」 2026-09-18：provider/updateAccountConfig 只收账号型，
// 反向请求要到模型请求时才来，建会话那步 registry 里就得先有这个 provider）。
// 凡是要打印/落盘的数据，先过 lib/scrub.mjs 的 redactSecrets()。
//
// 来源：provider 表构造与 revision 哈希移植自 zcode-acp-server 0.17.1（Apache-2.0，
// William Wang，https://github.com/william0wang/zcode-acp）dist/config/provider-registry.js，
// 见 NOTICE。改动处在行内标「改：」。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { ExecutorError } from './errors.mjs';
import { builtinProviderConfigPath, findZcode } from './appserver.mjs';
import { defaultCredentialsPath, readCodingPlanKeys } from './credentials.mjs';

// 默认路径导出给外壳报路径用（doctor 第 ② 步只报存在与否和 provider 个数，不打内容）
export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.zcode', 'v2', 'config.json');

// 个人 provider 文件里我们这条 provider 的固定 id（decisions D14）：3.12 起 `builtin:` /
// `account:` 前缀有保留含义（CLI 的 legacy 导入函数明确跳过这两类），自己起名最不会撞。
// 登记簿里 entry.provider 存的仍是 config.json 的 id，用来选 key 和模型表。
export const EXECUTOR_PROVIDER_ID = 'zcode-executor';

/** config.json 的 kind → 协议 apiFormat（搬自 provider-registry.js）。 */
function apiFormatForKind(kind) {
  if (!kind) return undefined;
  if (kind.includes('anthropic')) return 'anthropic-messages';
  if (kind.includes('openai')) return 'openai-chat-completions';
  return undefined;
}

/**
 * config.json 的单个 model 条目 → 协议 model 元素（搬自 buildModelElement）。
 * reasoning 不带的话后端会退回 apiFormat 的两档默认思考等级，丢掉真实 variants。
 */
function buildModelElement(modelId, m) {
  const el = { modelId };
  if (m.name) el.label = m.name;
  if (m.limit?.context) el.contextWindow = m.limit.context;
  if (m.limit?.output) el.maxOutputTokens = m.limit.output;
  const variants = m.reasoning?.variants ?? [];
  if (m.reasoning?.enabled && variants.length > 0) {
    const reasoning = { enabled: true, levels: variants.map((v) => ({ value: v, label: v })) };
    if (m.reasoning.defaultVariant) reasoning.defaultLevel = m.reasoning.defaultVariant;
    el.reasoning = reasoning;
  }
  return el;
}

/** config.json 的单个 provider 条目 → 协议 provider 元素（搬自 buildProviderElement）。 */
function buildProviderElement(providerId, p) {
  // models 必须是数组：后端 strict schema 拒绝 config.json 里的对象形状
  const models = Object.entries(p.models ?? {}).map(([modelId, m]) => buildModelElement(modelId, m ?? {}));
  const el = {
    providerId,
    kind: p.kind,
    apiFormat: apiFormatForKind(p.kind),
    baseURL: p.options?.baseURL,
    label: p.name ?? providerId,
    models,
  };
  // apiKey 必须是 inline union 形状，裸字符串会被后端 strict schema 拒绝
  if (p.options?.apiKey) {
    el.apiKey = { source: 'inline', value: p.options.apiKey };
  }
  for (const k of Object.keys(el)) {
    if (el[k] === undefined) delete el[k];
  }
  return el;
}

/**
 * 纯函数：config.json 解析后的对象 → {providers, generatedAt, revision}。
 * 改：过滤 enabled === false 和 models 为空的 provider（后端 schema 要求每个
 * provider 至少一个 model，空表会被整体拒绝）；enabled 缺省视为启用。
 * models 是数组（形状不对）同样视为空跳过，打一行 stderr 提醒（评审第 10 条）——
 * 任务单点名要这行警告，是本「纯函数」唯一的副作用出口。
 */
export function buildRegistry(config) {
  const providers = [];
  for (const [providerId, p] of Object.entries(config.provider ?? {})) {
    if (p?.enabled === false) continue;
    if (Array.isArray(p?.models)) {
      process.stderr.write(`providers: provider ${providerId} 的 models 是数组，按缺配置跳过\n`);
      continue;
    }
    if (Object.keys(p?.models ?? {}).length === 0) continue;
    providers.push(buildProviderElement(providerId, p ?? {}));
  }
  return { providers };
}

/**
 * 纯函数：在 registry.providers（已经 buildRegistry / buildAccountProviders 过滤过的）里按 D6 的优先级选一个
 * provider。preferredProvider 命中优先；否则 account:*-individual-coding-plan > account:*-team-coding-plan
 * （T6-C：账号型来源的 key 最稳，个人版按量计费风险更小）> id 以 -coding-plan 结尾 > -start-plan 结尾 > 其它；
 * 同级多个取 registry 里靠前的（同名模型在多个 provider 下并存时，来源文件里的顺序就是依据）。
 * 表里没有可用 provider 抛 ExecutorError(1)。
 */
export function pickProvider(registry, { preferredProvider } = {}) {
  const providers = registry?.providers ?? [];
  if (providers.length === 0) {
    throw new ExecutorError(
      'provider 表是空的：~/.zcode/v2/config.json 里没有可用的 provider（models 为空或 enabled:false 的都已被过滤）。确认 ZCode App 已登录并配好模型',
      1,
    );
  }
  // preferredProvider 不在表里的回落提醒由 resolveModels 的 warnings 统一收（评审 T2.2b 第 6 条）
  const rank = (p) => {
    if (preferredProvider !== undefined && p.providerId === preferredProvider) return 0;
    if (p.providerId.startsWith('account:') && p.providerId.endsWith('-individual-coding-plan')) return 1;
    if (p.providerId.startsWith('account:') && p.providerId.endsWith('-team-coding-plan')) return 2;
    if (p.providerId.endsWith('-coding-plan')) return 3;
    if (p.providerId.endsWith('-start-plan')) return 4;
    return 5;
  };
  let best = providers[0];
  for (const p of providers) {
    if (rank(p) < rank(best)) best = p;
  }
  return best;
}

/**
 * 纯函数：registry 的 provider 元素 → 个人 provider 文件的 JSON（docs/reference/zcode-app-server-protocol.md「3.12.2 变化」，形状照
 * CLI 自己的 legacy 导入函数 importLegacyCliPersonalProviderConfig 抄，真机零 token 跑通 2026-09-18）。
 * 只写一条 provider，id 固定 EXECUTOR_PROVIDER_ID；模型表用 provider.models 的 modelId 顺序
 * （personalModelIds 与 modelOrder 两处都要，CLI 按前者建表、按后者排序）。
 * 不借内置模板（templateId 写法）：模板 id 和模型表是 CDN 可刷新的，自己写全最稳。
 * provider 没有明文 apiKey 抛 ExecutorError(1)：没有 key 的 provider 建了会话也跑不了回合。
 */
export function buildPersonalProviderConfig(provider) {
  const apiKey = provider?.apiKey?.value;
  if (!apiKey) {
    throw new ExecutorError(
      `config.json 里 provider ${provider?.providerId ?? '(缺 providerId)'} 没有明文 apiKey，没法给 zcode 建个人 provider 文件。`
        + '确认 ZCode App 登录的是 API-key 型 coding plan，或换一个 provider',
      1,
    );
  }
  const modelIds = (provider.models ?? []).map((m) => m.modelId);
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: EXECUTOR_PROVIDER_ID,
            providerName: EXECUTOR_PROVIDER_ID,
            config: {
              group: 'standard-personal',
              access: { type: 'api-key', apiKey },
              api: { type: provider.apiFormat, baseUrl: provider.baseURL },
              personalModelIds: modelIds,
              modelOrder: modelIds,
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}

/**
 * 把 buildPersonalProviderConfig 的结果写成临时文件，返回 { path, dispose }。
 * 目录 os.tmpdir()/zcode-executor-provider-XXXX（mkdtemp，0700），文件 provider.json 0600；
 * dispose 同步删整个目录，可重复调用（收场路径可能从多处进来）。
 * 密钥只落这一个文件（D14），调用方必须在子进程收场的 finally 里 dispose。
 */
export function writePersonalProviderFile(provider) {
  const content = JSON.stringify(buildPersonalProviderConfig(provider)); // 先算：没 key 抛错时不留空目录
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zcode-executor-provider-'));
  const file = path.join(dir, 'provider.json');
  writeFileSync(file, content, { mode: 0o600 });
  return {
    path: file,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * 纯函数：provider + modelId + 思考等级 → session/create 的 model 与 workspace/generateText 的
 * selection 共用的形状 {providerId: EXECUTOR_PROVIDER_ID, modelId, options?: {reasoningLevel}}
 * （verified.md「3.12.2 直连探针实测」表第 3、4 行，2026-09-18）。reasoningLevel 为空不带 options——但 GLM 5.3 系列
 * 缺它 create 会被拒「Reasoning level is required」，调用方自己保证给档位。
 * modelId 不在 provider.models 里抛 ExecutorError(2)。
 */
export function buildModelSelection(provider, modelId, reasoningLevel) {
  const models = provider?.models ?? [];
  if (!models.some((m) => m.modelId === modelId)) {
    const known = models.map((m) => m.modelId).join('、') || '（无）';
    throw new ExecutorError(`provider ${provider?.providerId ?? '(缺 providerId)'} 里没有模型 ${modelId}。可选：${known}`, 2);
  }
  const selection = { providerId: EXECUTOR_PROVIDER_ID, modelId };
  if (reasoningLevel) selection.options = { reasoningLevel };
  return selection;
}

/**
 * 纯函数：账号型来源的 provider 元素拼装（T6-C，D19）。对 keys.plans 里存在的每一档（individual/team），
 * 在内置 provider 文件的 providerRules 里找 providerId === `account:${family}-<档>-coding-plan` 的条目，
 * 配上 baseUrl、模型表与那把 key，拼成与 legacy 同形状的元素：
 * apiFormat = config.api.type、baseURL = config.api.baseUrl、label = providerName、
 * models 来自 builtinModelIds + modelConfigRules.modelRules（正则忽略大小写匹配 modelId，
 * 多条命中后面覆盖前面，浅合并 properties / optionSpecs），reasoning.levels 从 reasoningLevel.values 来，
 * defaultLevel 取 values 里有 high 就 high、否则最后一个。
 * 内置文件里找不到该 provider、或 builtinModelIds 为空 → 跳过并把原因收进 warnings（后端 schema
 * 要求每个 provider 至少一个 model）。返回 { providers, warnings }。
 */
export function buildAccountProviders(builtinConfig, keys) {
  const providers = [];
  const warnings = [];
  const rules = builtinConfig?.config?.providerConfigRules?.providerRules ?? [];
  const modelRules = builtinConfig?.config?.modelConfigRules?.modelRules ?? [];
  for (const plan of ['individual', 'team']) {
    const apiKey = keys?.plans?.[plan];
    if (!apiKey) continue;
    const providerId = `account:${keys.family}-${plan}-coding-plan`;
    const rule = rules.find((r) => r?.providerId === providerId);
    if (!rule) {
      warnings.push(`内置 provider 文件里没有 ${providerId} 的条目，这一档账号型 provider 跳过（App 版本旧了或目录布局变了？）`);
      continue;
    }
    const modelIds = rule.config?.builtinModelIds ?? [];
    if (modelIds.length === 0) {
      warnings.push(`内置 provider 文件里 ${providerId} 的 builtinModelIds 是空的，这一档账号型 provider 跳过`);
      continue;
    }
    const el = {
      providerId,
      apiFormat: rule.config?.api?.type,
      baseURL: rule.config?.api?.baseUrl,
      label: rule.providerName ?? providerId,
      models: modelIds.map((modelId) => buildAccountModelElement(modelId, modelRules)),
      apiKey: { source: 'inline', value: apiKey },
    };
    for (const k of Object.keys(el)) {
      if (el[k] === undefined) delete el[k];
    }
    providers.push(el);
  }
  return { providers, warnings };
}

/**
 * 内置文件 modelRules → 账号型 provider 的单个 model 元素。2026-09-21 对照 ZCode 源码 3.14.0：
 * modelMatch 按忽略大小写匹配 modelId（规则写 glm-5\.3，modelId 是 GLM-5.3），多条命中时后面的
 * 覆盖前面的（浅合并 properties / optionSpecs）；contextWindow 在 properties，maxOutputTokens 在
 * optionSpecs.maxOutputTokens.max，思考档位在 optionSpecs.reasoningLevel.values。
 */
function buildAccountModelElement(modelId, modelRules) {
  const el = { modelId };
  let properties = {};
  let optionSpecs = {};
  for (const rule of modelRules) {
    if (typeof rule?.modelMatch !== 'string') continue;
    let re;
    try {
      re = new RegExp(rule.modelMatch, 'i');
    } catch {
      continue; // 内置文件里的正则坏了：那是 App 的数据问题，跳过这条规则不让整个来源垮掉
    }
    if (!re.test(modelId)) continue;
    properties = { ...properties, ...rule.config?.properties };
    optionSpecs = { ...optionSpecs, ...rule.config?.optionSpecs };
  }
  if (properties.contextWindow !== undefined) el.contextWindow = properties.contextWindow;
  if (optionSpecs.maxOutputTokens?.max !== undefined) el.maxOutputTokens = optionSpecs.maxOutputTokens.max;
  const values = optionSpecs.reasoningLevel?.values;
  if (Array.isArray(values) && values.length > 0) {
    el.reasoning = {
      enabled: true,
      levels: values.map((v) => ({ value: v, label: v })),
      defaultLevel: values.includes('high') ? 'high' : values[values.length - 1],
    };
  }
  return el;
}

/**
 * 读两个来源并合并 provider 表（T6-C，D19）。账号型来源（credentials.json + 内置 provider 文件）在前，
 * legacy（config.json，原逻辑）在后。任一来源缺失或出错不抛，记进 warnings（如「credentials.json 不存在」）；
 * 两个来源加起来一个 provider 都没有才抛 ExecutorError(1)，message 把两个来源的原因都带上（sources
 * 挂在 details 上供 doctor 排版）。返回 { providers, warnings, sources }，sources 各带
 * { ok, providerCount, error }，账号型另有 missing（未登录）/ family / plans 供 doctor 报状态。
 * credentialsPath / builtinConfigPath / env 可注入；builtinConfigPath 缺省时按 env 定位内置文件
 * （ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指了就用它、不找 zcode.cjs；没指才从 zcode.cjs 位置推——env 是
 * 唯一来源，缺的变量不从 process.env 补，T6-C-fix 第 1、2 条），credentialsPath 缺省用
 * lib/credentials.mjs 的默认路径。现有调用方只用 registry.providers，不受影响。
 */
export function readProviderRegistry(configPath = DEFAULT_CONFIG_PATH, { credentialsPath, builtinConfigPath, env = process.env } = {}) {
  if (!path.isAbsolute(configPath)) {
    configPath = path.resolve(process.cwd(), configPath);
  }
  const warnings = [];
  // 账号型来源：先看 credentials.json 在不在（不在 = 未登录，连内置文件都不用读），再解 key、拼元素
  const account = { ok: false, providerCount: 0, error: null, missing: false, family: null, plans: [] };
  let accountProviders = [];
  const credPath = credentialsPath ?? defaultCredentialsPath(env);
  const keys = readCodingPlanKeys({ credentialsPath: credPath, env });
  if (keys === null) {
    account.missing = true;
    account.error = `credentials.json 不存在：${credPath}`;
    warnings.push(`账号型来源跳过（未登录）：${account.error}。要用账号型 coding plan，先在 ZCode App 里登录`);
  } else if (keys.error) {
    account.error = keys.error;
    warnings.push(`账号型来源不可用：${keys.error}`);
  } else {
    let builtinError = null;
    let builtinConfig = null;
    let builtinPath = builtinConfigPath;
    if (builtinPath === undefined) {
      // 内置文件定位（T6-C-fix 第 1、2 条）：注入的 env 是唯一来源，绝不从 process.env 补——
      // lib/appserver.mjs 两个定位函数的解构默认值都会回落 process.env，传 ''（两处都按没给处理）绕开。
      // 环境变量指了内置文件就不找 zcode.cjs（没装 App 的 CI 只有这条路）；两个变量都没有才从 zcode.cjs 位置推
      const builtinFile = env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || '';
      try {
        builtinPath = builtinFile
          ? builtinProviderConfigPath(null, { builtinFile })
          : builtinProviderConfigPath(findZcode({ zcodeBin: env.ZCODE_BIN || '' }), { builtinFile: '' });
      } catch (err) {
        if (!(err instanceof ExecutorError)) throw err;
        builtinError = err.message;
      }
    }
    if (builtinError === null) {
      try {
        builtinConfig = JSON.parse(readFileSync(builtinPath, 'utf8'));
      } catch (err) {
        builtinError = `内置 provider 文件读不了或不是合法 JSON：${builtinPath}：${err.message}`;
      }
    }
    if (builtinError !== null) {
      account.error = builtinError;
      warnings.push(`账号型来源不可用：${builtinError}`);
    } else {
      const built = buildAccountProviders(builtinConfig, keys);
      accountProviders = built.providers;
      warnings.push(...built.warnings);
      account.ok = true;
      account.providerCount = built.providers.length;
      account.family = keys.family;
      account.plans = Object.keys(keys.plans); // 只放档名，key 的值不出这个模块的 warnings/sources
    }
  }
  // legacy 来源：原逻辑原样跑，抛错改成记 warning（另一来源可用时不该被它拦住）
  const legacy = { ok: false, providerCount: 0, error: null };
  let legacyProviders = [];
  try {
    const raw = readFileSync(configPath, 'utf8');
    let config;
    try {
      config = JSON.parse(raw);
    } catch {
      throw new ExecutorError(`zcode 配置不是合法 JSON：${configPath}。文件可能被 App 正在重写，稍后重试`, 1);
    }
    legacyProviders = buildRegistry(config).providers;
    legacy.ok = true;
    legacy.providerCount = legacyProviders.length;
  } catch (err) {
    if (!(err instanceof ExecutorError)) {
      legacy.error = err?.code === 'ENOENT'
        ? `找不到 zcode 配置：${configPath}。确认 ZCode App 已安装并登录过`
        : `读不了 zcode 配置 ${configPath}：${err.message}`;
    } else {
      legacy.error = err.message;
    }
    warnings.push(`legacy config.json 来源不可用：${legacy.error}`);
  }
  const providers = [...accountProviders, ...legacyProviders];
  if (providers.length === 0) {
    throw new ExecutorError(
      `provider 表是空的，两个来源都没解出 provider——账号型（${account.error ?? '没有匹配的 provider 条目'}）；`
        + `legacy config.json（${legacy.error ?? '没有可用 provider（models 为空或 enabled:false 都被过滤）'}）。`
        + '确认 ZCode App 已登录账号型 coding plan，或 config.json 里有可用的 provider',
      1,
      { sources: { account, legacy } },
    );
  }
  return { providers, warnings, sources: { account, legacy } };
}
