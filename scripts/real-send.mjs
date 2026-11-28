// scripts/real-send.mjs —— 薄转发（ZCE-4 R1 收口兼容层）：实现已抽到 scripts/control/real-send-core.mjs。
// 参数、输出与退出码与原实现完全一致（单向 import，无循环）；统一入口为 control-executor。
import process from 'node:process';

console.error('real-send.mjs 已并入 control-executor（实现迁至 scripts/control/real-send-core.mjs）：建议改用 node scripts/control-executor.mjs。本转发层将择机删除。');
await import('./control/real-send-core.mjs');
