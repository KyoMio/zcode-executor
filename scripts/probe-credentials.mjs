// scripts/probe-credentials.mjs —— 薄转发（ZCE-4 收口兼容层）：实现已迁至 scripts/control/probe-credentials-core.mjs。
// 统一入口为 control-executor doctor --json；本脚本保留可用（只读，不打印任何密钥明文）。
import process from 'node:process';
import { formatProbeCredentialsHuman, probeCredentials } from './control/probe-credentials-core.mjs';

console.error('probe-credentials.mjs 已并入 control-executor（ZCE-4）：建议改用 node scripts/control-executor.mjs doctor --json。本转发层将择机删除。');

const json = process.argv.includes('--json');
const result = probeCredentials();
if (json) {
  console.log(JSON.stringify(result));
} else {
  console.log(formatProbeCredentialsHuman(result));
}
process.exitCode = result.ok ? 0 : 1;
