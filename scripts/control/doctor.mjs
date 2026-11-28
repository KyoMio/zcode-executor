// scripts/control/doctor.mjs —— doctor 子命令实现（ZCE-4）。
// 环境与版本阈值自检：经 bin/zcode-executor doctor 做真握手与内置 provider 自检（零 token，不发 session/send），
// 再复用 probe-credentials-core 检查 credentials 4 键可读性。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './lib.mjs';
import { probeCredentials } from './probe-credentials-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = path.join(root, 'bin', 'zcode-executor');

export async function doctor() {
  const steps = [];
  // ① 环境自检：bin doctor（内部含 zcode.cjs 定位 + 内置 provider + provider 来源 + 真握手 deferred）
  const r = await runProcess(process.execPath, [bin, 'doctor'], { timeoutMs: 120_000 });
  const envOk = r.code === 0;
  steps.push({
    step: 'env-doctor',
    ok: envOk,
    detail: r.stdout.trim().split('\n').slice(0, 20),
    stderrTail: r.stderr.trim().split('\n').slice(-5),
    ...(envOk ? {} : { next: '对照上面失败行修复环境（zcode.cjs 缺失就装/升 ZCode App；provider 表空就检查 ~/.zcode/v2 配置），然后重跑 doctor' }),
  });
  // ② credentials 4 键可读性（直接复用只读 probe-credentials-core，支持 enc:v2:os / enc:v2:env / enc:v1）
  const credDetail = probeCredentials();
  const credOk = credDetail.ok === true;
  steps.push({
    step: 'credentials-keys',
    ok: credOk,
    severity: 'warning', // 键缺失只警告不判坏：没开 coding-plan 的账号型环境是合法的
    detail: credDetail,
    ...(credOk ? {} : { next: '凭据 coding-plan 键缺失或解不开——若要用账号型来源请先在本机 ZCode App 登录/恢复；不用账号型可忽略本警告' }),
  });
  const ok = steps.every((s) => s.ok || s.severity === 'warning');
  const human = [
    `doctor ${ok ? '通过' : '未通过'}（${steps.filter((s) => s.ok).length}/${steps.length} 步）`,
    ...steps.map((s) => `  ${s.ok ? '✓' : '✗'} ${s.step}${s.ok ? '' : ` —— ${s.next ?? ''}`}`),
  ].join('\n');
  return { ok, human, steps, next: ok ? '环境可用：可以跑 zero-token --json 核协议零额度路径' : '先按失败行的指引修复，再重跑 doctor --json' };
}
