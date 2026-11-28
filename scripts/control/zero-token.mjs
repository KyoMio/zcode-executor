// scripts/control/zero-token.mjs —— zero-token 子命令实现（ZCE-4，R1-7 加固）。
// 零额度协议路径：握手 + create(deferred + immediate) + list 契约 + close。
// 复用 probe-core 的逐行 JSON 协议——子进程跑它、逐行解析、汇总判定。
// probe-core 本身不发 session/send（RULES：探针零 token），所以这里也零额度。
//
// R1-7 加固（御史判决）：① 子进程退出码非 0 即失败（此前忽略，探针中途死掉也报绿）；
// ② 规格要求的 deferred 成功链必须有：create-deferred ok + 列表不含它 + close 成功；
// ③ immediate 链的列表契约单独断言：list-contains-created 必须 ok——光 list 成功不算数。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcess } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 探针步骤里哪些必须 ok:true 才算零额度路径走通；dispose 必须 ok（密钥零残留红线）
const REQUIRED_OK = [
  'pickProvider', 'writePersonalProviderFile', 'spawn',
  'create-deferred', 'list-excludes-deferred', 'close-deferred', // deferred 规格链（R1-7②）
  'create', 'list', 'list-contains-created', 'close', 'dispose', // immediate 链 + 列表契约（R1-7③）
];
const EXPECTED_GONE = ['updateProviderRegistry-gone', 'create-runtimeModel-gone'];

export async function zeroToken() {
  const r = await runProcess(process.execPath, [path.join(root, 'scripts', 'control', 'probe-core.mjs')], { timeoutMs: 240_000 });
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  const steps = [];
  for (const line of lines) {
    try {
      steps.push(JSON.parse(line));
    } catch {
      steps.push({ step: 'unparsed', raw: line.slice(0, 200), ok: false });
    }
  }
  // R1-7①：子进程自身退出码非 0 = 探针没走完（崩溃/提前退出），一律失败
  if (r.code !== 0) {
    return {
      ok: false,
      human: `zero-token 失败：探针子进程退出码 ${r.code}${r.timedOut ? '（超时强杀）' : ''}`,
      steps,
      error: r.stderr.slice(-400),
      exitCode: r.code,
      next: '先跑 doctor --json 修环境（多半是 zcode.cjs 定位或 provider 表问题），再重试 zero-token',
    };
  }
  if (steps.length === 0) {
    return {
      ok: false,
      human: 'zero-token 失败：probe 一行都没输出',
      steps: [],
      error: r.stderr.slice(-400),
      next: '先跑 doctor --json 修环境（多半是 zcode.cjs 定位或 provider 表问题），再重试 zero-token',
    };
  }
  const byStep = Object.fromEntries(steps.filter((s) => s.step).map((s) => [s.step, s]));
  const failures = [];
  for (const name of REQUIRED_OK) {
    const s = byStep[name];
    if (!s || s.ok !== true) {
      // immediate create 有一次合法重试（toolDenylist 不接受时）：create 失败但 retry 成功也算通
      if (name === 'create' && byStep['create-retry-without-denylist']?.ok === true) continue;
      failures.push({ step: name, detail: s ?? '未执行到' });
    }
  }
  for (const name of EXPECTED_GONE) {
    const s = byStep[name];
    if (s && s.ok !== true) {
      failures.push({ step: name, detail: s, note: '3.12 删掉的方法/字段居然还在——协议可能回滚或环境版本不对' });
    }
  }
  const ok = failures.length === 0;
  const human = [
    `zero-token ${ok ? '通过' : '失败'}（${steps.length} 步探针，含 deferred 规格链）`,
    ...steps.map((s) => `  ${s.ok === true ? '✓' : s.ok === false ? '✗' : '·'} ${s.step}`),
    ...(ok ? [] : ['', '失败明细：', ...failures.map((f) => `  ${f.step}: ${JSON.stringify(f.detail).slice(0, 200)}`)]),
  ].join('\n');
  return {
    ok,
    human,
    steps,
    failures,
    next: ok
      ? '零额度协议链路正常（deferred + immediate 双链）——可以跑 mock-matrix --json 核行为剧本，或 orphan-check --json 扫残留'
      : '零额度链路断了——先跑 doctor --json 对照修环境；若 pickProvider/spawn 失败通常是凭据或 App 版本问题（真错误码在 err.details.code，见 references/features/05）',
  };
}
