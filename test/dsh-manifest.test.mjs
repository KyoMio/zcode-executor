// DSH 插件定义守卫：根 package.json 本身就是 DSH 插件（dsh 字段 + cordis.patch.yml），
// npm 包名直装可用。这里盯的是「定义只能有一份、引用的产物必须存在」，
// 防止改 dsh-plugin/ 时根定义漂移或漏构建。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

test('根 package.json 带 DSH 插件定义，且 patch 文件在包根', () => {
  assert.ok(pkg.dsh?.bundle?.patch, '缺少 dsh.bundle.patch');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(existsSync(path.join(root, pkg.dsh.bundle.patch)), 'cordis.patch.yml 必须存在于包根');
  assert.ok(!existsSync(path.join(root, 'dsh-plugin', 'cordis.patch.yml')), 'dsh-plugin/ 里不应再有第二份 patch（定义只留根这一份）');
});

test('patch insert 的 name 是可 import 的 npm 包名（加载器按它 import）', () => {
  const patch = readFileSync(path.join(root, pkg.dsh.bundle.patch), 'utf8');
  const names = [...patch.matchAll(/^\s*name:\s*(\S+)\s*$/gm)].map(m => m[1]);
  assert.ok(names.length > 0, 'insert 条目缺少 name');
  for (const name of names) {
    assert.equal(name, pkg.name, `insert name 必须等于包名 ${pkg.name}（旧包名残留会让插件行加载不到、状态「未运行」）`);
  }
});

test('bundle 入口与 client 入口指向已构建的产物', () => {
  assert.equal(pkg.main, 'dsh-plugin/lib/index.js');
  for (const key of ['.', './client']) {
    const target = pkg.exports?.[key]?.default;
    assert.ok(target, `exports["${key}"] 缺少 default`);
    assert.ok(existsSync(path.join(root, target)), `${target} 不存在——先 cd dsh-plugin && npm run build`);
  }
});

function clientRegistration(source) {
  const registrations = [];
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: registration => registrations.push(registration) } },
  }, { timeout: 1000 });
  assert.equal(registrations.length, 1, '客户端必须只注册一个模块工厂');
  assert.equal(typeof registrations[0].factory, 'function');
  return registrations[0];
}

test('发布的客户端工厂以根包名注册，和 patch import 的模块一致', () => {
  const source = readFileSync(path.join(root, pkg.exports['./client'].default), 'utf8');
  assert.equal(clientRegistration(source).id, pkg.name);
});

test('客户端构建读取根 package name，不使用子包名或当前工作目录', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-client-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = path.join(dir, 'dsh-plugin');
  mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  mkdirSync(path.join(plugin, '.client-build', 'client'), { recursive: true });
  copyFileSync(path.join(root, 'dsh-plugin/scripts/build-client.mjs'), path.join(plugin, 'scripts/build-client.mjs'));
  const name = '@test/renamed-executor';
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'dsh-zcode-executor' }));
  writeFileSync(path.join(plugin, '.client-build/client/index.js'), 'exports.loaded = true;');
  execFileSync(process.execPath, [path.join(plugin, 'scripts/build-client.mjs')], {
    cwd: tmpdir(), timeout: 10_000,
  });
  const registration = clientRegistration(readFileSync(path.join(plugin, 'lib/client.js'), 'utf8'));
  assert.equal(registration.id, name);
  assert.equal(registration.factory(() => assert.fail('fixture 没有外部依赖')).loaded, true);
});

test('DSH 需要的产物都进 npm files（npm 包名直装才带得全）', () => {
  // dsh-plugin/skills 不进 files：npm 打包跳过软链，npm 装法由 skill-link 回退到根 skills/
  for (const entry of ['cordis.patch.yml', 'dsh-plugin/lib', 'skills']) {
    assert.ok(pkg.files.includes(entry), `files 缺 ${entry}`);
  }
});

test('peer 依赖全部 optional：CLI 全局安装保持零依赖，DSH 侧由宿主供给', () => {
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, `${name} 必须是 optional peer`);
  }
});

test('dsh-plugin/package.json 不再携带第二份插件定义', () => {
  const sub = JSON.parse(readFileSync(path.join(root, 'dsh-plugin', 'package.json'), 'utf8'));
  assert.equal(sub.dsh, undefined, 'dsh 字段只应留在根 package.json');
  assert.equal(sub.exports?.['./cordis.patch.yml'], undefined);
});
