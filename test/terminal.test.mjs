// 测 lib/cli/terminal.mjs：CLI 输出里的终端控制字符中和（审计 D9-①）。纯函数与写出口包装，不起子进程；
// 走真实 CLI 的端到端用例在 test/run.test.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { guardOutput, neutralizeControls } from '../lib/cli/terminal.mjs';

const ESC = '\u001b';

test('neutralizeControls：ESC、BEL、NUL、DEL、C1、反向排版符换成看得见的 \\uXXXX', () => {
  assert.equal(neutralizeControls(`a${ESC}[2Kb`), 'a\\u001b[2Kb');
  assert.equal(neutralizeControls(`${ESC}]0;标题\u0007`), '\\u001b]0;标题\\u0007');
  assert.equal(neutralizeControls('x\u0000y\u007fz'), 'x\\u0000y\\u007fz');
  // 8 位的 CSI（U+009B）与 OSC（U+009D）：JSON.stringify 不转义它们，认 C1 的终端照样执行
  assert.equal(neutralizeControls('a\u009b2Jb\u009d0;t\u009c'), 'a\\u009b2Jb\\u009d0;t\\u009c');
  // 双向排版控制符能让一行字看起来顺序颠倒（`\u202egnp.exe` 显示成 exe.png）
  assert.equal(neutralizeControls('\u202egnp.exe\u2066x\u2069'), '\\u202egnp.exe\\u2066x\\u2069');
});

test('neutralizeControls：换行与制表留着，\\r\\n 收成 \\n，落单的 \\r 转义（它能回到行首盖掉已经打出来的字）', () => {
  assert.equal(neutralizeControls('一\t二\n三'), '一\t二\n三');
  assert.equal(neutralizeControls('一\r\n二\r\n'), '一\n二\n');
  assert.equal(neutralizeControls('send: 挂起·审批：rm -rf ~\rsend: done'), 'send: 挂起·审批：rm -rf ~\\u000dsend: done');
});

test('neutralizeControls：普通文字原样（中文、表情、反斜杠、已经是字面量的 \\u001b）', () => {
  const plain = '放行 3 次 —— 改动：a.txt、b.mjs 🎉 C:\\dir \\u001b "引号"';
  assert.equal(neutralizeControls(plain), plain);
  assert.equal(neutralizeControls(''), '');
});

test('neutralizeControls：过一遍 JSON 文本不改它的含义，解析回来一字不差', () => {
  const value = {
    reason: `有副作用${ESC}[2K\r${ESC}]0;pwned\u0007`,
    input: { file_path: 'a\u009b2Jb.txt', note: '\u202egnp.exe', tail: '结尾是反斜杠\\', del: '\u007f' },
    lines: '一\r\n二\t三',
  };
  const text = neutralizeControls(JSON.stringify(value));
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  assert.deepEqual(JSON.parse(text), value);
});

test('guardOutput：字符串先中和再写，Buffer 与其余参数、返回值原样', () => {
  const calls = [];
  const stream = {
    write(...args) {
      calls.push(args);
      return 'ret';
    },
  };
  guardOutput(stream);
  const done = () => {};
  assert.equal(stream.write(`a${ESC}[0m\n`, 'utf8', done), 'ret');
  const raw = Buffer.from([0x1b, 0x5b]);
  stream.write(raw);
  assert.deepEqual(calls[0], ['a\\u001b[0m\n', 'utf8', done]);
  assert.equal(calls[1][0], raw);
});
