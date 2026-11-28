#!/usr/bin/env node
// scripts/control-executor.mjs —— zcode-executor 统一验证 CLI（ZCE-4）。
// 收口 probe.mjs / probe-credentials.mjs / real-send.mjs / real-review.mjs 的验证能力为
// 单一入口（旧脚本保留薄转发兼容）。零运行时依赖，只用 Node 内置。
//
// 子命令（全部支持 --json 与指路式报错——报错里带下一步该做什么）：
//   doctor         环境与版本阈值自检（零 token）
//   zero-token     零额度协议路径：握手 + create(deferred) + list + close
//   mock-matrix    六个 mock 剧本矩阵（正常回合/审批放行/审批挂起/steer/cancel/凭据解密）
//   orphan-check   扫描残留进程与临时密钥目录（--cleanup 仅删可证无主的临时密钥目录、进程一律只报告，--dry-run 只报告）
//   live-smoke     真机冒烟（强制 --confirm-spend，否则拒绝；--dry-run 只打印剧本）
//   flake-swarm    并发重复压力子集（--runs N --concurrency C，默认 30/4）
import process from 'node:process';
import { parseArgs, emitResult, UsageError } from './control/lib.mjs';

const SUBCOMMANDS = ['doctor', 'zero-token', 'mock-matrix', 'orphan-check', 'live-smoke', 'flake-swarm'];

const USAGE = `用法：node scripts/control-executor.mjs <子命令> [旗标]
子命令：${SUBCOMMANDS.join('、')}
通用旗标：--json（结构化输出）
各子命令旗标：
  doctor        --json
  zero-token    --json
  mock-matrix   --json
  orphan-check  --json [--cleanup] [--dry-run]
  live-smoke    --json --confirm-spend（必需，否则拒绝） [--dry-run] [--timeout 秒]
  flake-swarm   --json [--runs N] [--concurrency C]`;

function parseSubcommandArgs(cmd, rest, spec) {
  const parsed = parseArgs(rest, spec);
  if (parsed.positionals.length > 0) {
    throw new UsageError(
      `${cmd} 不接受位置参数：${parsed.positionals.join(' ')}。布尔开关直接写旗标名（不要传 true/false）`,
    );
  }
  return parsed.flags;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exitCode = cmd ? 0 : 1;
    return;
  }
  if (!SUBCOMMANDS.includes(cmd)) {
    console.error(`不认识子命令 ${cmd}。可用：${SUBCOMMANDS.join('、')}——对照上面用法重跑`);
    process.exitCode = 1;
    return;
  }
  let result;
  let json = false;
  switch (cmd) {
    case 'doctor': {
      const flags = parseSubcommandArgs(cmd, rest, { booleans: ['json'] });
      json = !!flags.json;
      const { doctor } = await import('./control/doctor.mjs');
      result = await doctor();
      break;
    }
    case 'zero-token': {
      const flags = parseSubcommandArgs(cmd, rest, { booleans: ['json'] });
      json = !!flags.json;
      const { zeroToken } = await import('./control/zero-token.mjs');
      result = await zeroToken();
      break;
    }
    case 'mock-matrix': {
      const flags = parseSubcommandArgs(cmd, rest, { booleans: ['json'] });
      json = !!flags.json;
      const { mockMatrix } = await import('./control/mock-matrix.mjs');
      result = await mockMatrix({ json });
      break;
    }
    case 'orphan-check': {
      const flags = parseSubcommandArgs(cmd, rest, { booleans: ['json', 'cleanup', 'dry-run'] });
      json = !!flags.json;
      const { orphanCheck } = await import('./control/orphan-check.mjs');
      result = await orphanCheck({ cleanup: !!flags.cleanup, dryRun: !!flags['dry-run'] });
      break;
    }
    case 'live-smoke': {
      const flags = parseSubcommandArgs(cmd, rest, { values: ['timeout'], booleans: ['json', 'confirm-spend', 'dry-run'] });
      json = !!flags.json;
      const { liveSmoke } = await import('./control/live-smoke.mjs');
      result = await liveSmoke({
        confirmSpend: !!flags['confirm-spend'],
        dryRun: !!flags['dry-run'],
        timeoutSec: flags.timeout === undefined ? 600 : Number(flags.timeout),
      });
      break;
    }
    case 'flake-swarm': {
      const flags = parseSubcommandArgs(cmd, rest, { values: ['runs', 'concurrency'], booleans: ['json'] });
      json = !!flags.json;
      const { flakeSwarm } = await import('./control/flake-swarm.mjs');
      const runsN = flags.runs === undefined ? 30 : Number(flags.runs);
      const concN = flags.concurrency === undefined ? 4 : Number(flags.concurrency);
      result = await flakeSwarm({ runs: runsN, concurrency: concN });
      break;
    }
    default:
      throw new UsageError(`子命令 ${cmd} 未实现`);
  }
  const exitCode = emitResult({ json, result });
  process.exitCode = exitCode;
}

try {
  await main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(err.message);
    process.exitCode = 2;
  } else {
    console.error(`control-executor 内部错误：${err?.message ?? err}——先跑 doctor --json 定位环境；持续复现请带这段报错回报`);
    process.exitCode = 1;
  }
}
