// lib/cli/doctor.mjs —— doctor 子命令（外壳层）：三步零 token 自检，只编排 lib 的调用与排版。
// 不 import 协议层；zcode 交互走 lib/models 的 zcodeInfo / resolveModels / loadZcodeConfig。
import { loadConfig } from '../config.mjs';
import { loadZcodeConfig, resolveModels, zcodeInfo } from '../models.mjs';
import { MIN_ZCODE_VERSION, parseFlags, sayConfigWarnings, slimModel, versionLt } from './common.mjs';

export async function run(argv) {
  const { json } = parseFlags(argv, { boolean: ['--json'] });
  const out = {
    ok: true,
    zcode: { ok: false, path: null, version: null, minVersion: MIN_ZCODE_VERSION, error: null },
    config: { ok: false, path: null, providerCount: null, error: null },
    handshake: { ok: false, skipped: false, providerId: null, tiers: { fast: null, strong: null }, warnings: [], error: null },
  };
  const say = (line) => {
    if (!json) console.log(line);
  };

  // ① zcode 二进制与版本
  try {
    const info = zcodeInfo();
    const ok = !versionLt(info.version, MIN_ZCODE_VERSION);
    out.zcode = { ok, path: info.path, version: info.version, minVersion: MIN_ZCODE_VERSION, error: null };
    say(`doctor ① zcode：版本 ${info.version}（${info.path}）${ok ? '' : `，低于门槛 ${MIN_ZCODE_VERSION}`}`);
    if (!ok) {
      console.error(`doctor: zcode 版本 ${info.version} 低于门槛 ${MIN_ZCODE_VERSION}。升级 ZCode App，或设 ZCODE_BIN 指向新版 zcode.cjs`);
    }
  } catch (err) {
    out.zcode.error = err.message;
    say('doctor ① zcode：不可用');
    console.error(`doctor: ${err.message}`);
  }

  // ② zcode 的 provider 配置（只读）；路径解析收在 lib/models 的 loadZcodeConfig（T2.2b 第 11 条）
  let configPath = null;
  try {
    const { configPath: resolved, registry } = loadZcodeConfig();
    configPath = resolved;
    out.config.ok = true;
    out.config.path = configPath;
    out.config.providerCount = registry.providers.length;
    say(`doctor ② config：${registry.providers.length} 个可用 provider（${configPath}）`);
  } catch (err) {
    out.config.error = err.message;
    say('doctor ② config：读不到');
    console.error(`doctor: ${err.message}`); // 怎么办只在 stderr 一处（T2.1b 第 7 条）
  }

  // ③ 真握手并报等级分配；前两步有失败就跳过（spawn 或推表都无从谈起）
  if (out.zcode.ok && out.config.ok) {
    try {
      const config = loadConfig();
      sayConfigWarnings('doctor', config);
      const resolved = await resolveModels({ config, configPath });
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

  out.ok = Boolean(out.zcode.ok && out.config.ok && out.handshake.ok);
  if (json) console.log(JSON.stringify(out));
  if (!out.ok) process.exitCode = 1;
}
