// scripts/control/flake-swarm.mjs —— flake-swarm 子命令实现（ZCE-4）。
// 并发重复执行压力子集，验证队列锁、stdio 缓冲区与临时目录清理在高压下无竞态。
// 压力子集（锁/队列/取消/回合编排所在的测试文件）固定为：
//   run / cli / offpeak-cancel / pending / proof——全量 876 断言级别的全套件跑 N 轮成本太高，
//   子集已经覆盖了所有并发敏感面。--runs N --concurrency C，默认 30/4。
// 判定：全部轮次 pass>0 且 fail=0 且 exit 0；并发组内可重复失败 = flake 实锤，把失败轮次的
// stderr/stdout 尾巴带回报告（指路式：下一步怎么单独复现）。
import { runNodeTest } from './lib.mjs';

const STRESS_FILES = [
  'test/run.test.mjs',
  'test/cli.test.mjs',
  'test/offpeak-cancel.test.mjs',
  'test/pending.test.mjs',
  'test/proof.test.mjs',
];

export async function flakeSwarm({ runs = 30, concurrency = 4 }) {
  // R1-7：两个参数必须是正整数——非数字/零/负数直接拒绝（此前 NaN 轮空跑也报绿）
  if (!Number.isInteger(runs) || runs < 1) {
    throw new (await import('./lib.mjs')).UsageError(`--runs 必须是正整数，收到：${runs}。用法示例：--runs 20`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new (await import('./lib.mjs')).UsageError(`--concurrency 必须是正整数，收到：${concurrency}。用法示例：--concurrency 4`);
  }
  const results = [];
  const lanes = Array.from({ length: concurrency }, () => []);
  for (let i = 0; i < runs; i += 1) lanes[i % concurrency].push(i);
  const startedAt = Date.now();
  await Promise.all(lanes.map(async (lane) => {
    for (const iter of lane) {
      const r = await runNodeTest(STRESS_FILES, { timeoutMs: 600_000 });
      results[iter] = {
        iter,
        code: r.code,
        pass: r.pass,
        fail: r.fail,
        tests: r.tests,
        timedOut: r.timedOut,
        stderrTail: r.stderr.slice(-300),
        stdoutTail: r.stdout.slice(-300),
      };
    }
  }));
  const durationMs = Date.now() - startedAt;
  const failures = results.filter((r) => r && (r.code !== 0 || (r.fail ?? 1) !== 0 || r.timedOut));
  // R1-7：零用例的轮次不算成功（跑空了不是绿了）；完成轮数必须等于请求轮数
  const emptyRuns = results.filter((r) => r && !failures.includes(r) && (r.pass ?? 0) === 0);
  const ok = results.every(Boolean) && results.length === runs && failures.length === 0 && emptyRuns.length === 0;
  const totalPass = results.reduce((a, r) => a + (r?.pass ?? 0), 0);
  const human = [
    `flake-swarm ${ok ? '通过' : '发现不稳定'}：${runs} 轮 × 并发 ${concurrency}，共 ${totalPass} 断言通过，${failures.length} 轮失败，耗时 ${Math.round(durationMs / 1000)}s`,
    ...failures.slice(0, 5).map((f) => `  ✗ 第 ${f.iter} 轮：code=${f.code} fail=${f.fail}${f.timedOut ? '（超时强杀）' : ''}`),
  ].join('\n');
  return {
    ok,
    human,
    runs,
    concurrency,
    durationMs,
    totalPass,
    failedRuns: failures.map((f) => ({ iter: f.iter, code: f.code, fail: f.fail, timedOut: f.timedOut, stderrTail: f.stderrTail, stdoutTail: f.stdoutTail })),
    next: ok
      ? '高压下无竞态——队列锁/缓冲区/清理行为稳定'
      : `单独复现失败轮次：node --test ${STRESS_FILES.join(' ')}；连续两轮同点失败大概率是真 bug 不是 flake，按 pstack 排查止损规范先写最小复现`,
  };
}
