// lib/scrub.mjs 的行为测试：键名替换与按值替换，全部纯函数。
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, scrubValues } from '../lib/scrub.mjs';

test('redactSecrets：嵌套对象与数组里的 apiKey/token/secret 都替换，不分大小写', () => {
  const input = {
    apiKey: 'sk-1',
    nested: { TOKEN: 't-1', keep: 'v', list: [{ secret: 's-1' }, 'plain'] },
    ApiKey: 'sk-2',
  };
  const out = redactSecrets(input);
  assert.equal(out.apiKey, '<redacted>');
  assert.equal(out.nested.TOKEN, '<redacted>');
  assert.equal(out.nested.list[0].secret, '<redacted>');
  assert.equal(out.nested.keep, 'v');
  assert.equal(out.nested.list[1], 'plain');
  assert.equal(out.ApiKey, '<redacted>');
});

test('redactSecrets：原对象不被修改，返回的是深拷贝', () => {
  const input = { apiKey: 'sk-1', nested: { secret: 's-1', arr: [{ token: 't-1' }] } };
  const out = redactSecrets(input);
  assert.equal(input.apiKey, 'sk-1');
  assert.equal(input.nested.secret, 's-1');
  assert.equal(input.nested.arr[0].token, 't-1');
  assert.notEqual(out.nested, input.nested);
  assert.notEqual(out.nested.arr, input.nested.arr);
  assert.notEqual(out.nested.arr[0], input.nested.arr[0]);
});

test('redactSecrets：普通值原样通过（字符串、数字、null）', () => {
  assert.equal(redactSecrets('hello'), 'hello');
  assert.equal(redactSecrets(42), 42);
  assert.equal(redactSecrets(null), null);
});

test('scrubValues：文本里出现的密钥值替换成 <redacted>', () => {
  const secrets = ['sk-live-1', 'sk-live-2'];
  assert.equal(scrubValues('connect with sk-live-1 please', secrets), 'connect with <redacted> please');
  assert.equal(scrubValues('a sk-live-1 and sk-live-2', secrets), 'a <redacted> and <redacted>');
  assert.equal(scrubValues('nothing here', secrets), 'nothing here');
  // 正则元字符当字面量处理（样本足 8 位，过长度门槛）
  assert.equal(scrubValues('key key.*(123', ['key.*(123']), 'key <redacted>');
  // 空串和空列表不折腾原文
  assert.equal(scrubValues('same', []), 'same');
  assert.equal(scrubValues('same', ['']), 'same');
});

test('scrubValues：长度不足 8 的 secret 忽略，不打烂正常输出', () => {
  // T0.3b 复核 C：'x' 这类极短密钥会把每个 x 都替换掉
  assert.equal(scrubValues('example text', ['x']), 'example text');
  assert.equal(scrubValues('abc has abc', ['abc']), 'abc has abc');
  assert.equal(scrubValues('7chars! ok', ['7chars!']), '7chars! ok'); // 恰 7 个字符，忽略
  assert.equal(scrubValues('8chars12 ok', ['8chars12']), '<redacted> ok'); // 恰 8 个字符，替换
});
