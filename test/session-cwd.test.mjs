// src/client/session-cwd.ts 的测试：纯函数，「当前项目」的 cwd 派生。
// 只测外部行为——行进去、cwd 出来；行形状按宿主结构镜像（SessionRowLike / WorkspaceRowLike），
// 用例覆盖 ask 点名的：有/无 mainView 行、cwd 缺失、空列表、多项工作区。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mainSessionCwdOf, pickWorkspacePath } from '../src/client/session-cwd.ts';

test('mainSessionCwdOf：retainedBy.mainView > 0 的行给出它的 cwd', () => {
  assert.equal(
    mainSessionCwdOf([
      { cwd: '/a', retainedBy: { mainView: 0 } },
      { cwd: '/b', retainedBy: { mainView: 1 } },
    ]),
    '/b',
  );
});

test('mainSessionCwdOf：多条 mainView 行取先出现的一条（官方 publishMain 同款先到先得）', () => {
  assert.equal(
    mainSessionCwdOf([
      { cwd: '/first', retainedBy: { mainView: 2 } },
      { cwd: '/second', retainedBy: { mainView: 1 } },
    ]),
    '/first',
  );
});

test('mainSessionCwdOf：没有 mainView 行 / 缺 retainedBy / 主行缺 cwd / cwd 为 null 都回 null', () => {
  assert.equal(mainSessionCwdOf([]), null); // 空目录
  assert.equal(mainSessionCwdOf([{ cwd: '/a' }]), null); // 行没带 retainedBy
  assert.equal(mainSessionCwdOf([{ cwd: '/a', retainedBy: { mainView: 0 } }]), null); // 计数 0 不算主视图
  assert.equal(mainSessionCwdOf([{ retainedBy: { mainView: 3 } }]), null); // 主行缺 cwd
  assert.equal(mainSessionCwdOf([{ cwd: null, retainedBy: { mainView: 3 } }]), null); // cwd null（运行时形状）
  assert.equal(mainSessionCwdOf([{ cwd: '', retainedBy: { mainView: 1 } }]), null); // cwd 空串当没有
});

test('pickWorkspacePath：空列表回 null，唯一项直接取 path', () => {
  assert.equal(pickWorkspacePath([]), null);
  assert.equal(pickWorkspacePath([{ path: '/only', updatedAt: '2026-10-01T00:00:00.000Z' }]), '/only');
});

test('pickWorkspacePath：多项取 updatedAt 最近的一项（ISO-8601 字典序即时间序）', () => {
  assert.equal(
    pickWorkspacePath([
      { path: '/old', updatedAt: '2026-09-01T00:00:00.000Z' },
      { path: '/new', updatedAt: '2026-10-06T00:00:00.000Z' },
      { path: '/mid', updatedAt: '2026-09-15T00:00:00.000Z' },
    ]),
    '/new',
  );
});

test('pickWorkspacePath：缺 updatedAt 当最旧；选中项缺 path / 空串回 null', () => {
  assert.equal(
    pickWorkspacePath([{ path: '/a' }, { path: '/b', updatedAt: '2026-10-01T00:00:00.000Z' }]),
    '/b',
  );
  assert.equal(pickWorkspacePath([{ updatedAt: '2026-10-01T00:00:00.000Z' }]), null);
  assert.equal(pickWorkspacePath([{ path: '', updatedAt: '2026-10-01T00:00:00.000Z' }]), null);
});
