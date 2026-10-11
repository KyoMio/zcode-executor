// skill 单一事实源检查：dsh-plugin 的 SKILL.md 必须是指向根 skills/ 的软链，
// 两份只有一份实体，改 skill 只改根目录那份，防止又抄出第二份各改各的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const link = path.join(root, 'dsh-plugin', 'skills', 'zcode-executor', 'SKILL.md');
const canonical = path.join(root, 'skills', 'zcode-executor', 'SKILL.md');

test('dsh-plugin 的 SKILL.md 是软链，且指向根 skills/ 的实体文件', () => {
  assert.ok(lstatSync(link).isSymbolicLink(), 'dsh-plugin/skills/zcode-executor/SKILL.md 必须是软链，不能是复制件');
  assert.equal(realpathSync(link), realpathSync(canonical));
});

test('软链目标可读且是 zcode-executor 的 skill', () => {
  const content = readFileSync(link, 'utf8');
  assert.ok(content.includes('name: zcode-executor'), 'front matter 里应有 name: zcode-executor');
  assert.ok(content.length > 10000, 'skill 内容不应是残缺的');
});
