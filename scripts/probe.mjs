// scripts/probe.mjs —— 薄转发（ZCE-4 收口兼容层）：零 token 探针已收口进统一验证 CLI。
// 新用法：node scripts/control-executor.mjs zero-token [--json]
// 本脚本保留原逐行 JSON 输出语义（直接转调核心），一段周期后可删。
import process from 'node:process';

console.error('probe.mjs 已并入 control-executor（ZCE-4）：建议改用 node scripts/control-executor.mjs zero-token --json。本转发层将择机删除。');
const { runZeroTokenProbe } = await import('./control/probe-core.mjs');
process.exitCode = await runZeroTokenProbe();
