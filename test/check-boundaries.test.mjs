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
