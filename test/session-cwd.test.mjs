// src/client/session-cwd.ts 的测试：纯函数，「当前项目」的 cwd 派生。
// 只测外部行为——行进去、cwd 出来；行形状按宿主结构镜像（SessionRowLike / WorkspaceRowLike），
// 用例覆盖 ask 点名的：有/无 mainView 行、cwd 缺失、空列表、多项工作区。
// PB-6 追加：主会话 id 派生（mainSessionIdOf）与「侧」判定（sideOfSessionId / sideEquals）——
// 远程会话（dsh-zen-remote 插件桥）的虚拟 id 是 `zr~<serverId>~<原始 id>`。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mainSessionCwdOf, mainSessionIdOf, pickWorkspacePath, sideEquals, sideOfSessionId } from '../src/client/session-cwd.ts';

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

// ---- PB-6：主会话 id 派生与「侧」判定 ----

test('mainSessionIdOf：与 mainSessionCwdOf 同一行（mainView>0 的第一行），sessionId 字段优先', () => {
  assert.equal(
    mainSessionIdOf([
      { sessionId: 'sess_a', retainedBy: { mainView: 0 } },
      { sessionId: 'sess_b', cwd: '/b', retainedBy: { mainView: 1 } },
    ]),
    'sess_b',
  );
  // 多条 mainView 行先到先得（官方 publishMain 同款）
  assert.equal(
    mainSessionIdOf([
      { sessionId: 'sess_first', retainedBy: { mainView: 2 } },
      { sessionId: 'sess_second', retainedBy: { mainView: 1 } },
    ]),
    'sess_first',
  );
});

test('mainSessionIdOf：无 sessionId 字段时退行内 id（测试/预览桩的简化形状）；都缺回 null', () => {
  assert.equal(mainSessionIdOf([{ id: 'host-main', retainedBy: { mainView: 1 } }]), 'host-main');
  assert.equal(mainSessionIdOf([{ sessionId: 'sess_a', id: 'ignored', retainedBy: { mainView: 1 } }]), 'sess_a');
  assert.equal(mainSessionIdOf([{ cwd: '/a', retainedBy: { mainView: 1 } }]), null); // 两种 id 都没有
  assert.equal(mainSessionIdOf([]), null); // 没有主视图行
  assert.equal(mainSessionIdOf([{ sessionId: '', retainedBy: { mainView: 1 } }]), null); // 空串当没有
});

test('sideOfSessionId：本机 id 与 null 都是 local；zr~ 前缀按 serverId 段分远程侧', () => {
  assert.deepEqual(sideOfSessionId(null), { kind: 'local' });
  assert.deepEqual(sideOfSessionId('sess_local'), { kind: 'local' });
  assert.deepEqual(sideOfSessionId('zr~abc12345~sess_remote'), { kind: 'remote', serverId: 'abc12345' });
  assert.deepEqual(sideOfSessionId('zr~def67890~sess_other'), { kind: 'remote', serverId: 'def67890' });
});

test('sideOfSessionId：坏形状的 zr~ 串（无 serverId 段）当本机，不挂死面板', () => {
  assert.deepEqual(sideOfSessionId('zr~'), { kind: 'local' });
  assert.deepEqual(sideOfSessionId('zr~noserver'), { kind: 'local' });
});

test('sideEquals：同侧判定——本机只认本机；远程比 serverId；同机换会话算同侧', () => {
  const local = { kind: 'local' };
  assert.ok(sideEquals(local, { kind: 'local' }));
  assert.ok(!sideEquals(local, { kind: 'remote', serverId: 'abc12345' }));
  const srvA1 = sideOfSessionId('zr~abc12345~s1');
  assert.ok(sideEquals(srvA1, sideOfSessionId('zr~abc12345~s2'))); // 同侧换会话
  assert.ok(!sideEquals(srvA1, sideOfSessionId('zr~def67890~s1'))); // 不同主服务端
});
