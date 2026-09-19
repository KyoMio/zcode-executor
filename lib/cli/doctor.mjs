// lib/cli/doctor.mjs —— doctor 子命令（外壳层）：三步零 token 自检，只编排 lib 的调用与排版。
// ① zcode.cjs 找得到、旁边的内置 provider 文件找得到（3.12+ 的判据：`--version` 在 3.11 与 3.12 都打
//   0.16.5，区分不了，verified.md「3.12.2 直连探针实测」 2026-09-18）；② config.json 读得到，顺带报选中的 provider 有没有
//   明文 apiKey（没有的话 ③ 必挂，先把话说清——这也是「App 哪天不写 config.json 了」的断粮预警）；
// ③ 真握手一次（create deferred + close）并报等级分配；④ 只看插件配置，报告新启动 runner
// 的模型审批/快筛选择，不请求 Jev。
// 不 import 协议层；zcode 交互走 lib/models 的 zcodeInfo / resolveModels / loadZcodeConfig / pickProvider。
import { loadConfig } from '../config.mjs';
import { loadZcodeConfig, pickProvider, resolveModels, zcodeInfo } from '../models.mjs';
import { parseFlags, sayConfigWarnings, slimModel } from './common.mjs';

// --json 只加字段不删字段（RULES §5）：minVersion 保留，值改成说明性的——真正的门槛是内置文件在不在
const MIN_VERSION_NOTE = 'App ≥ 3.12.2';

export async function run(argv) {
  const { json } = parseFlags(argv, { boolean: ['--json'] });
  const out = {
    ok: true,
    zcode: { ok: false, path: null, version: null, minVersion: MIN_VERSION_NOTE, builtinConfigPath: null, error: null },
    config: { ok: false, path: null, providerCount: null, apiKeyPresent: false, error: null },
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

  // ② zcode 的 provider 配置（只读）；路径解析收在 lib/models 的 loadZcodeConfig（T2.2b 第 11 条）。
  //    选中的 provider 按 ③ 同一套规则挑（D6），只报 apiKey 在不在，不打内容（RULES §8）
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
    say(`doctor ② config：${registry.providers.length} 个可用 provider，选中 ${picked?.providerId ?? '（无）'}，apiKey ${out.config.apiKeyPresent ? '在' : '不在'}（${configPath}）`);
    if (picked && !out.config.apiKeyPresent) {
      console.error(`doctor: config.json 里 provider ${picked.providerId} 没有明文 apiKey，握手和投递都会失败。确认 ZCode App 登录的是 API-key 型 coding plan，或用 preferredProvider 换一个`);
    }
  } catch (err) {
    out.config.error = err.message;
    say('doctor ② config：读不到');
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
