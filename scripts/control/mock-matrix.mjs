// scripts/control/mock-matrix.mjs —— mock-matrix 子命令实现（ZCE-4）。
// 跑全量 mock 剧本矩阵：正常回合 / 审批放行 / 审批挂起 / steer 插话 / cancel 秒停 / 凭据解密。
// 实现策略：剧本事实源在 test/（mock-appserver.mjs + 各测试文件），这里按
// 「场景 → 文件 + 测试名正则」的固定映射驱动 node --test --test-name-pattern，
// 逐场景收集 pass/fail。映射写死并校验「每个场景至少跑到 1 个测试」——
// 名字漂移导致匹配为空时算失败而不是静默通过。
import { runNodeTest } from './lib.mjs';

// 场景映射：正则锚定到具体测试名关键字，避免误中过多无关用例（但也别精确到整句——措辞小改不该炸）
export const MATRIX = [
  {
    scenario: 'normal-round',
    label: '正常回合',
    files: ['test/run.test.mjs'],
    pattern: 'completed 全链路',
  },
  {
    scenario: 'approve-release',
    label: '审批放行',
    files: ['test/run.test.mjs'],
    pattern: '审批挂起.*answer.*继续到 done',
  },
  {
    scenario: 'approve-blocked',
    label: '审批挂起',
    files: ['test/run.test.mjs'],
    pattern: '已挂起的会话',
  },
  {
    scenario: 'steer-injection',
    label: 'steer 插话',
    files: ['test/run.test.mjs'],
    pattern: '回合中 steer 成功',
  },
  {
    scenario: 'cancel-fast',
    label: 'cancel 秒停',
    files: ['test/run.test.mjs'],
    pattern: 'cancel 收场后个人 provider 文件目录已删',
  },
  {
    scenario: 'credential-decrypt',
    label: '凭据解密',
    files: ['test/credentials.test.mjs'],
    pattern: 'roundtrip',
  },
];

export async function mockMatrix({ json }) {
  const results = [];
  for (const item of MATRIX) {
    const r = await runNodeTest(item.files, { namePattern: item.pattern, timeoutMs: 300_000 });
    // R1-7：必须真有命名用例跑过——文件级 ✔（零匹配时 Node 照样计 pass）不算数
    const ran = (r.namedPasses ?? []).length > 0;
    const ok = ran && r.code === 0 && (r.fail ?? 1) === 0;
    results.push({
      scenario: item.scenario,
      label: item.label,
      ok,
      tests: r.tests,
      pass: r.pass,
      fail: r.fail,
      namedPasses: r.namedPasses,
      durationMs: undefined,
      ...(ok ? {} : {
        next: ran
          ? `场景「${item.label}」有失败用例——单独复现：node --test --test-name-pattern="${item.pattern}" ${item.files.join(' ')}`
          : `场景「${item.label}」一个测试都没跑到——测试名可能漂移了，先更新 scripts/control/mock-matrix.mjs 的 MATRIX 映射（pattern: "${item.pattern}"）`,
      }),
    });
  }
  const ok = results.every((r) => r.ok);
  const human = [
    `mock-matrix ${ok ? '通过' : '未通过'}（${results.filter((r) => r.ok).length}/${results.length} 场景）`,
    ...results.map((r) => `  ${r.ok ? '✓' : '✗'} ${r.scenario}（${r.label}）pass=${r.pass ?? '?'} fail=${r.fail ?? '?'}`),
  ].join('\n');
  return {
    ok,
    human,
    results,
    next: ok ? '六个 mock 剧本全绿——行为层无回归' : '按失败场景的 next 指引单独复现；矩阵全绿前不要派真机单',
  };
}
