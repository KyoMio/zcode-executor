// lib/tiers.mjs 的行为测试：等级自动分配与思考等级校验（SPEC「工作流层」、PRD 第 5 节）。
// 纯函数直接喂固定输入断言输出，不碰协议层、不读文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutorError } from '../lib/errors.mjs';
import { assignTiers, thoughtLevelFor } from '../lib/tiers.mjs';

// 造一个 readState settings.model.available 形状的条目
const M = (modelId, { label, disabledReason, levels } = {}) => {
  const m = { ref: { providerId: 'p', modelId } };
  if (label !== undefined) m.label = label;
  if (disabledReason !== undefined) m.disabledReason = disabledReason;
  if (levels !== undefined) m.reasoning = { enabled: true, levels: levels.map((v) => ({ value: v, label: v })) };
  return m;
};

test('assignTiers：id 或 label 含 flash/lite/mini/air（不分大小写）归 fast，其余 strong', () => {
  const models = [
    M('GLM-5.3'),
    M('GLM-5.3-Flash'),
    M('glm-4-lite'),
    M('something', { label: 'Mini Model' }),
    M('GLM-4.6-Air'),
  ];
  const { fast, strong, all } = assignTiers(models);
  assert.equal(fast.ref.modelId, 'GLM-5.3-Flash'); // 同档 5.3 > 4.6 > 4，版本号最大的胜
  assert.equal(strong.ref.modelId, 'GLM-5.3');
  assert.deepEqual(
    all.map((m) => m.tier),
    ['strong', 'fast', 'fast', 'fast', 'fast'],
  );
});

test('assignTiers：同档多个取版本号最大的，解析不出算 0', () => {
  const { fast } = assignTiers([M('legacy-flash'), M('GLM-1.0-Flash')]);
  assert.equal(fast.ref.modelId, 'GLM-1.0-Flash'); // legacy 解析不出版本算 0，输给 1.0
  const { strong } = assignTiers([M('GLM-4.6'), M('GLM-4.11')]);
  assert.equal(strong.ref.modelId, 'GLM-4.11'); // 数字比较，11 > 6（不是字符串序）
});

test('assignTiers：有 disabledReason 的跳过，该档空着为 null', () => {
  const { fast, strong, all } = assignTiers([
    M('GLM-5.3-Flash', { disabledReason: 'deprecated' }),
    M('GLM-5.3'),
  ]);
  assert.equal(fast, null);
  assert.equal(strong.ref.modelId, 'GLM-5.3');
  const flashEntry = all.find((m) => m.ref.modelId === 'GLM-5.3-Flash');
  assert.equal(flashEntry.tier, null); // 禁用的出现在 all 里但不占档
});

test('assignTiers：配置覆盖不让位，两档可以指向同一模型（评审 T2.1b 第 1 条）', () => {
  const models = [M('GLM-5.3'), M('GLM-5.3-Flash'), M('GLM-4.6')];
  const { fast, strong } = assignTiers(models, { tiers: { fast: 'GLM-5.3' } });
  assert.equal(fast.ref.modelId, 'GLM-5.3');
  assert.equal(strong.ref.modelId, 'GLM-5.3'); // 不让位：strong 自动结果仍是 GLM-5.3，两档同模型允许
  const both = assignTiers(models, { tiers: { fast: 'GLM-4.6', strong: 'GLM-5.3-Flash' } });
  assert.equal(both.fast.ref.modelId, 'GLM-4.6');
  assert.equal(both.strong.ref.modelId, 'GLM-5.3-Flash');
  // 配置指了不存在的 modelId：不覆盖，按自动结果
  const untouched = assignTiers(models, { tiers: { fast: 'no-such-model' } });
  assert.equal(untouched.fast.ref.modelId, 'GLM-5.3-Flash');
});

test('assignTiers：本机形状——两个模型的 provider 里配置 fast 为旗舰，两档都不空', () => {
  // 评审 T2.1b 第 1 条的动机：让位会让另一档变 null，这里钉住不发生
  const { fast, strong } = assignTiers([M('GLM-5.3'), M('GLM-5.3-Flash')], { tiers: { fast: 'GLM-5.3' } });
  assert.equal(fast.ref.modelId, 'GLM-5.3');
  assert.equal(strong.ref.modelId, 'GLM-5.3');
});

test('assignTiers：只有一档时另一档为 null', () => {
  const { fast, strong } = assignTiers([M('GLM-5.3-Flash')]);
  assert.equal(fast.ref.modelId, 'GLM-5.3-Flash');
  assert.equal(strong, null);
});

test('thoughtLevelFor：levels 里有 wanted 就返回它，没有返回 undefined', () => {
  const glm = M('GLM-5.3', { levels: ['low', 'high', 'max'] });
  assert.equal(thoughtLevelFor(glm), 'high'); // 默认 wanted high
  assert.equal(thoughtLevelFor(glm, 'low'), 'low');
  assert.equal(thoughtLevelFor(glm, 'max'), 'max');
  const flash = M('GLM-5.3-Flash'); // 没有 reasoning 字段
  assert.equal(thoughtLevelFor(flash), undefined);
  assert.equal(thoughtLevelFor(M('x', { levels: ['low'] }), 'high'), undefined); // high 不在档位里
});

test('thoughtLevelFor：explicit 且不合法 → ExecutorError(2) 并列出档位（评审 T2.1b 第 4 条）', () => {
  const glm = M('GLM-5.3', { levels: ['low', 'high', 'max'] });
  assert.equal(thoughtLevelFor(glm, 'high', { explicit: true }), 'high'); // 显式且合法照常返回
  assert.throws(() => thoughtLevelFor(glm, 'ultra', { explicit: true }), (err) => {
    assert.ok(err instanceof ExecutorError);
    assert.equal(err.exitCode, 2);
    assert.match(err.message, /ultra/);
    assert.match(err.message, /low、high、max/); // 列出合法档位
    return true;
  });
  const flash = M('GLM-5.3-Flash'); // 模型没有任何档位
  assert.throws(() => thoughtLevelFor(flash, 'high', { explicit: true }), (err) => err?.exitCode === 2);
});
