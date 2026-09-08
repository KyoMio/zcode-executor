// 七家代理适配清单的静态测试：只读仓库里的文件，不碰协议层，不花 token。
// 覆盖三件事——版本号全部跟着 package.json 走、files 数组不漏发新清单、README 的安装命令在位。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));

const VERSIONED_JSON = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.grok-plugin/plugin.json',
  '.github/plugin/plugin.json',
  'gemini-extension.json',
];

test('五份带版本号的清单都是合法 JSON，version 等于 package.json 的版本', () => {
  for (const file of VERSIONED_JSON) {
    const manifest = JSON.parse(read(file));
    assert.equal(manifest.version, pkg.version, `${file} 的 version 应与 package.json 一致`);
  }
});

test('plugin.yaml 的 version: 行等于 package.json 的版本', () => {
  const match = read('plugin.yaml').match(/^version: (.+)$/m);
  assert.ok(match, 'plugin.yaml 应有 version: 行');
  assert.equal(match[1].trim(), pkg.version);
});

test('package.json 的 files 覆盖每一个新增的适配文件或其所在目录', () => {
  for (const entry of ['gemini-extension.json', '.grok-plugin', '.github/plugin', 'plugin.yaml', '__init__.py']) {
    assert.ok(pkg.files.includes(entry), `files 数组应包含 ${entry}，不加就发不进 npm 包`);
  }
  assert.deepEqual(pkg.pi, { skills: ['./skills'] });
  assert.ok(pkg.keywords.includes('pi-package'));
});

test('新清单的关键字段照抄 .claude-plugin/plugin.json', () => {
  const base = JSON.parse(read('.claude-plugin/plugin.json'));
  for (const file of ['.github/plugin/plugin.json', '.grok-plugin/plugin.json']) {
    const manifest = JSON.parse(read(file));
    for (const key of ['name', 'description', 'author', 'repository', 'homepage', 'license', 'keywords']) {
      assert.deepEqual(manifest[key], base[key], `${file} 的 ${key} 应照抄 .claude-plugin/plugin.json`);
    }
  }
  assert.equal(JSON.parse(read('.github/plugin/plugin.json')).skills, 'skills/');
  assert.match(read('plugin.yaml'), /^provides_skills:\n  - zcode-executor$/m);
});

test('两份 README 都有七家代理的安装小节和 skill 链接命令', () => {
  const snippets = [
    'copilot plugin marketplace add kyomio/zcode-executor',
    'gemini extensions install https://github.com/kyomio/zcode-executor',
    'agy plugin install https://github.com/kyomio/zcode-executor',
    'pi install npm:zcode-executor',
    '~/.openclaw/skills/zcode-executor',
    'hermes plugins install kyomio/zcode-executor',
    'hermes plugins enable zcode-executor',
    '~/.grok/skills/zcode-executor',
    'mkdir -p ~/.claude/skills && ln -s "$SKILL" ~/.claude/skills/zcode-executor',
    'ln -s "$PWD/skills/zcode-executor" ~/.claude/skills/zcode-executor',
    '~/.config/opencode/skills',
    '~/.agents/skills',
  ];
  for (const readme of ['README.md', 'README.zh-CN.md']) {
    const text = read(readme);
    for (const snippet of snippets) {
      assert.ok(text.includes(snippet), `${readme} 应包含 ${snippet}`);
    }
  }
});
