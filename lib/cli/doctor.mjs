// lib/cli/doctor.mjs —— doctor 子命令（外壳层）：三步零 token 自检，只编排 lib 的调用与排版。
// ① zcode.cjs 找得到、旁边的内置 provider 文件找得到（3.12+ 的判据：`--version` 在 3.11 与 3.12 都打
//   0.16.5，区分不了，verified.md「3.12.2 直连探针实测」 2026-09-18）；② provider 两个来源各自的状态
//   （T6-C：账号型 credentials.json 与 legacy config.json 两行，再一行选中的 provider；只报 key 在不在，
//   不打内容——这也是「App 哪天不写 config.json 了」的断粮预警）；
//   ③ 真握手一次（create deferred + close）并报等级分配；④ 只看插件配置，报告新启动 runner
//   的模型审批/快筛选择，不请求 Jev。
// 不 import 协议层；zcode 交互走 lib/models 的 zcodeInfo / resolveModels / loadZcodeConfig / pickProvider。
import { loadConfig } from '../config.mjs';
import { loadZcodeConfig, pickProvider, resolveModels, zcodeInfo } from '../models.mjs';
import { parseFlags, sayConfigWarnings, slimModel } from './common.mjs';

// --json 只加字段不删字段（RULES §5）：minVersion 保留，值改成说明性的——真正的门槛是内置文件在不在
const MIN_VERSION_NOTE = 'App ≥ 3.12.2';

// ② 账号型那一行的排版：未登录（credentials.json 不存在）/ 不可用（原因）/ 已登录（family + 两档 key 在不在）
function accountLine(account) {
  if (account.missing) return 'doctor ② 账号型 coding plan：未登录（credentials.json 不存在）';
  if (!account.ok) return `doctor ② 账号型 coding plan：不可用（${account.error}）`;
  const planState = (name, present) => `${name} key ${present ? '在' : '不在'}`;
  return `doctor ② 账号型 coding plan：已登录（${account.family}，`
    + `${planState('个人版', account.plans.includes('individual'))}、${planState('团队版', account.plans.includes('team'))}）`;
}

// ② legacy 那一行只报来源本身；apiKey 是选中 provider 的状态，口径归「选中」行（T6-C-fix 第 3 条）
function legacyLine(legacy) {
  if (!legacy.ok) return `doctor ② config.json：读不到（${legacy.error}）`;
  return `doctor ② config.json：${legacy.providerCount} 个可用 provider（备用来源）`;
}

// ② 「选中」行：带上选中 provider 的 apiKey 在不在（T6-C-fix 第 3、7 条，与 --json 的 apiKeyPresent 同口径）
function pickedLine(picked, apiKeyPresent) {
  if (!picked) return 'doctor ② 选中 （无）';
  return `doctor ② 选中 ${picked.providerId}（apiKey ${apiKeyPresent ? '在' : '不在'}）`;
}

export async function run(argv) {
  const { json } = parseFlags(argv, { boolean: ['--json'] });
  const out = {
    ok: true,
    zcode: { ok: false, path: null, version: null, minVersion: MIN_VERSION_NOTE, builtinConfigPath: null, error: null },
    config: { ok: false, path: null, providerCount: null, apiKeyPresent: false, sources: null, error: null },
    handshake: { ok: false, skipped: false, providerId: null, tiers: { fast: null, strong: null }, warnings: [], error: null },
    review: { enabled: null, fastScreen: null, jevConfigured: null, pipeline: null },
  };
  const say = (line) => {
    if (!json) console.log(line);
  };
  // 插件自己的配置坏了不该让 ①② 也报不出来：错误记到 ③（握手要靠它），前两步照常
  let config = null;
  let configError = null;
  try {
    config = loadConfig();
    sayConfigWarnings('doctor', config);
  } catch (err) {
    configError = err;
  }
  if (config !== null) {
    const enabled = config.review?.enabled !== false;
    const jevConfigured = config.review?.jev?.apiKey !== undefined;
    out.review = {
      enabled,
      fastScreen: enabled ? (jevConfigured ? 'jev' : 'zcode') : null,
      jevConfigured,
      pipeline: enabled ? [...(jevConfigured ? ['jev'] : []), 'zcode-fast', 'zcode-slow'] : [],
    };
  }

  // ① zcode 二进制、版本与内置 provider 文件
  try {
    const info = zcodeInfo();
    const ok = info.builtinConfigPath !== null;
    out.zcode = { ok, path: info.path, version: info.version, minVersion: MIN_VERSION_NOTE, builtinConfigPath: info.builtinConfigPath, error: info.builtinConfigError };
    say(`doctor ① zcode：版本 ${info.version}，内置 provider 文件 ${info.builtinConfigPath ?? '找不到'}（${info.path}）`);
    if (!ok) console.error(`doctor: ${info.builtinConfigError}`);
  } catch (err) {
    out.zcode.error = err.message;
    say('doctor ① zcode：不可用');
    console.error(`doctor: ${err.message}`);
  }

  // ② provider 两个来源（只读）；路径解析收在 lib/models 的 loadZcodeConfig（T2.2b 第 11 条）。
  //    T6-C：账号型一行 + legacy 一行 + 选中一行；选中的 provider 按 ③ 同一套规则挑（D6），
  //    只报 key 在不在，不打内容（RULES §8）
  let configPath = null;
  try {
    const { configPath: resolved, registry } = loadZcodeConfig();
    configPath = resolved;
    // pickProvider 对空表抛错；空表这里照旧只报个数，让 ③ 去报「表是空的」
    const picked = registry.providers.length > 0 ? pickProvider(registry, { preferredProvider: config?.preferredProvider }) : null;
    out.config.ok = true;
    out.config.path = configPath;
    out.config.providerCount = registry.providers.length;
    out.config.apiKeyPresent = Boolean(picked?.apiKey?.value);
    out.config.sources = registry.sources;
    say(accountLine(registry.sources.account));
    say(legacyLine(registry.sources.legacy));
    say(pickedLine(picked, out.config.apiKeyPresent));
    if (picked && !out.config.apiKeyPresent) {
      console.error(`doctor: 选中的 provider ${picked.providerId} 没有明文 apiKey，握手和投递都会失败。确认 ZCode App 登录的是账号型或 API-key 型 coding plan，或用 preferredProvider 换一个`);
    }
  } catch (err) {
    out.config.error = err.message;
    // 两个来源都空时 readProviderRegistry 把 sources 挂在 details 上（T6-C），排版照旧分两行
    const sources = err?.details?.sources;
    out.config.sources = sources ?? null;
    if (sources) {
      say(accountLine(sources.account));
      say(legacyLine(sources.legacy));
      say(pickedLine(null, false));
    } else {
      say('doctor ② 账号型 coding plan：不可用');
      say('doctor ② config.json：读不到');
      say(pickedLine(null, false));
    }
    console.error(`doctor: ${err.message}`); // 怎么办只在 stderr 一处（T2.1b 第 7 条）
  }

  // ③ 真握手并报等级分配；前两步有失败就跳过（spawn 无从谈起）
  if (out.zcode.ok && out.config.ok) {
    try {
      if (configError) throw configError;
      const resolved = await resolveModels({ config, configPath, handshake: true });
      for (const w of resolved.warnings) console.error(`doctor: 警告：${w}`);
      out.handshake.ok = true;
      out.handshake.providerId = resolved.provider.providerId;
      out.handshake.tiers = { fast: slimModel(resolved.fast), strong: slimModel(resolved.strong) };
      out.handshake.warnings = resolved.warnings;
      say(`doctor ③ 握手：选中 ${resolved.provider.providerId}；fast=${resolved.fast?.ref.modelId ?? '（空）'}、strong=${resolved.strong?.ref.modelId ?? '（空）'}`);
    } catch (err) {
      out.handshake.error = err.message;
      say('doctor ③ 握手：失败');
      console.error(`doctor: ${err.message}`);
    }
  } else {
    out.handshake.skipped = true;
    say('doctor ③ 握手：跳过（前两步有失败）');
  }

  if (configError === null) {
    if (!out.review.enabled) {
      say(`doctor ④ 模型审批：关闭；Jev key ${out.review.jevConfigured ? '已配置但不会使用' : '未配置'}`);
    } else {
      say(`doctor ④ 模型审批：开启，新启动 runner 将使用 ${out.review.jevConfigured ? 'Jev 前筛 → ' : ''}ZCode 快筛 → 慢判`);
    }
  } else {
    say('doctor ④ 模型审批：配置不可用');
  }

  out.ok = Boolean(out.zcode.ok && out.config.ok && out.handshake.ok);
  if (json) console.log(JSON.stringify(out));
  if (!out.ok) process.exitCode = 1;
}
