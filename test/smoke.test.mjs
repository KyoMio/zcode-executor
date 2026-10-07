// lib/smoke.mjs 的冒烟测试（T-test-dispatch）：纯函数断言，不起进程、不落盘、不花额度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { smokePing } from '../lib/smoke.mjs';

test('smokePing 默认参数返回 pong:zcode', () => {
  assert.equal(smokePing(), 'pong:zcode');
});

test("smokePing 传入 'kimi' 返回 pong:kimi", () => {
  assert.equal(smokePing('kimi'), 'pong:kimi');
});
