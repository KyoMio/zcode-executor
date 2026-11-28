import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractComments, scanExcuseComments } from '../scripts/check-boundaries.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/check-boundaries.mjs');

test('check-boundaries：真实仓库执行退出码 0 且包含禁止借口注释检查', () => {
  const out = execFileSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /禁止借口注释 全部通过/);
});

test('scanExcuseComments：拦截注释中的 workaround / hack / 权宜 / 临时方案 / TODO', () => {
  const sample = [
    '// workaround:先跳过校验',
    '/* multi-line',
    '   dirty hack for now */',
    '// 临时方案：先绕过边界',
    '// 权宜：先这样凑合',
    '// TODO: clean this up',
    'const s = 1; // FIXME: later',
  ].join('\n');
  const hits = scanExcuseComments(sample);
  assert.equal(hits.length, 6);
  assert.deepEqual(
    hits.map((h) => [h.line, h.match]),
    [
      [1, 'workaround'],
      [3, 'hack'],
      [4, '临时方案'],
      [5, '权宜'],
      [6, 'TODO'],
      [7, 'FIXME'],
    ],
  );
});

test('scanExcuseComments：豁免合法域名名词与字符串/模板/正则字面量', () => {
  const sample = [
    '// 写临时文件并清理',
    '// 系统临时目录放行；临时个人 provider 文件 0600 落盘',
    'const url = "https://zcode.z.ai"; // 合法协议 URL 注释不误报',
    "const a = 'workaround hack 临时方案 权宜 TODO';",
    'const b = `https://example.com/${"hack"} // 临时补丁`;',
    'const re = /workaround|临时方案/;',
    'const jsxLike = "<a>hi</a>";',
  ].join('\n');
  assert.equal(scanExcuseComments(sample).length, 0);
  const comments = extractComments(sample);
  assert.equal(comments.length, 3);
});

test('check-boundaries CLI：临时仓库出现借口注释时退出 1 并给出修复指引', (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'zce-boundaries-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  mkdirSync(path.join(tmp, 'lib'), { recursive: true });
  mkdirSync(path.join(tmp, 'test'), { recursive: true });
  writeFileSync(path.join(tmp, 'README.md'), '![tests](https://img.shields.io/badge/tests-passing-green)\n');
  writeFileSync(path.join(tmp, 'test', 'ok.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  writeFileSync(path.join(tmp, 'lib', 'bad.mjs'), '// workaround: 临时做法\nexport const x = 1;\n');

  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, '--root', tmp], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => {
      assert.equal(err.status, 1);
      const stderr = String(err.stderr ?? '');
      assert.match(stderr, /\[禁止借口注释\] lib\/bad\.mjs:1/);
      assert.match(stderr, /docs\/decisions\.md/);
      return true;
    },
  );
});

test('scanExcuseComments：JSX 文本区的撇号与裸 URL 不是代码，花括号里的真注释仍命中', () => {
  // 反例（合法文案）：JSX 文本里的撇号与含 TODO 的裸 URL 不产生任何命中
  const jsxText = 'export const View = () => <p>Don\'t close this. https://example.test/help/TODO</p>;';
  assert.equal(scanExcuseComments(jsxText).length, 0);

  // 正例（真实注释）：花括号代码区里的 TODO 块注释必须命中
  const jsxRealComment = "export const View = () => <p>Don't close this. {/* TODO: localize */}</p>;";
  const hits = scanExcuseComments(jsxRealComment);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
  assert.equal(hits[0].match, 'TODO');

  // 纯花括号注释（无撇号干扰）同样命中；嵌套元素文本仍豁免
  const nested = [
    'export const View = () => (',
    '  <div>',
    '    <p>{/* TODO: localize */}Ready</p>',
    "    <span>It's fine — https://example.test/TODO</span>",
    '  </div>',
    ');',
  ].join('\n');
  const nestedHits = scanExcuseComments(nested);
  assert.equal(nestedHits.length, 1);
  assert.equal(nestedHits[0].line, 3);
});

test('check-boundaries CLI：JSX 正反用例退出码——含 TODO 裸 URL 的文案 exit 0，花括号真注释 exit 1', (t) => {
  const mkCase = (t, source) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'zce-jsx-'));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    mkdirSync(path.join(tmp, 'dsh-plugin', 'src'), { recursive: true });
    mkdirSync(path.join(tmp, 'test'), { recursive: true });
    writeFileSync(path.join(tmp, 'README.md'), '![tests](https://img.shields.io/badge/tests-passing-green)\n');
    writeFileSync(path.join(tmp, 'dsh-plugin', 'src', 'view.tsx'), source);
    return tmp;
  };

  // 反例：整段只是页面文案，必须 exit 0
  const legit = mkCase(t, 'export const View = () => <p>https://example.test/help/TODO</p>;\n');
  const out = execFileSync(process.execPath, [SCRIPT, '--root', legit], { encoding: 'utf8' });
  assert.match(out, /全部通过/);

  // 正例：花括号代码区有真实 TODO 注释，必须 exit 1
  const violation = mkCase(t, 'export const View = () => <p>{/* TODO: localize */}Ready</p>;\n');
  assert.throws(
    () => execFileSync(process.execPath, [SCRIPT, '--root', violation], { encoding: 'utf8', stdio: 'pipe' }),
    (err) => {
      assert.equal(err.status, 1);
      assert.match(String(err.stderr ?? ''), /\[禁止借口注释\] dsh-plugin\/src\/view\.tsx:1/);
      return true;
    },
  );
});

test('scanExcuseComments：嵌套 JSX 闭合后回到代码区——元素后的真注释必须命中（ZCE-7 R2）', () => {
  // 嵌套元素整体结束后，下一行的 // TODO 是真实代码注释，必须命中
  const nested = 'const v = <div><span>text</span></div>;\n// TODO: localize';
  const hits = scanExcuseComments(nested);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);

  // 片段嵌套同理
  const fragment = 'const v = <><span>text</span></>;\n// TODO: localize';
  assert.equal(scanExcuseComments(fragment).length, 1);

  // 条件表达式里的子元素闭合后，花括号代码区内的注释必须命中
  const conditional = 'const v = <main>{cond && <div>ready</div> /* TODO: localize */}</main>;';
  const condHits = scanExcuseComments(conditional);
  assert.equal(condHits.length, 1);
  assert.equal(condHits[0].match, 'TODO');

  // 反例保持：嵌套 JSX 文本区内的裸 URL 与撇号仍不是代码
  const prose = 'const v = <div><span>https://example.test/TODO</span>Don\'t</div>;';
  assert.equal(scanExcuseComments(prose).length, 0);
});
