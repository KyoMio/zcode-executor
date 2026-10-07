// register-tab 的纯数据面（src/client/tab-def.ts）：tab 类型定义的形状与到点未注册的说明行。
// 接线本体（register-tab.ts）依赖 ctx 与 react 组件，不进单测（仓库无 React 组件测试先例，
// SPEC 测试决策：纯逻辑层 + 服务端半场两条缝）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TAB_DESCRIPTION,
  TAB_GUIDE_ORDER,
  TAB_ID,
  TAB_KIND,
  TAB_TITLE,
  missingServiceNote,
  tabDefinition,
} from '../src/client/tab-def.ts';

test('tab 类型定义：id/kind 同名、extension 段、标题与 guide 条目形状齐备', () => {
  const def = tabDefinition();
  assert.equal(def.id, 'zcode-executor:tasks');
  assert.equal(def.kind, TAB_ID); // 页面类型 kind 同 id
  assert.equal(def.priority, 'extension');
  assert.equal(def.title('/any/address'), TAB_TITLE); // title 是地址上的函数，恒给标题
  assert.equal(def.guide.length, 1);
  const entry = def.guide[0];
  assert.equal(entry.id, 'tasks'); // 官方要求条目 id 在提供方内唯一
  assert.equal(entry.order, TAB_GUIDE_ORDER);
  assert.equal(entry.title(), TAB_TITLE);
  assert.equal(entry.description(), TAB_DESCRIPTION);
  assert.equal(entry.icon, undefined); // 不给图标就没有该字段（DSH 对空串 description 有过教训，字段缺席要干净）
});

test('tab 类型定义：传入图标时进 guide 条目，每次调用出新对象（可安全交给 register）', () => {
  const icon = (props) => ({ size: props.size });
  const def = tabDefinition(icon);
  assert.equal(def.guide[0].icon, icon);
  assert.notEqual(tabDefinition(), def); // 两次调用不共享引用，注册方持有自己的定义
});

test('到点未注册的说明行：已注册给 null，未注册给一行说明', () => {
  assert.equal(missingServiceNote(true), null);
  const note = missingServiceNote(false);
  assert.match(note, /sidebarRightTabs/);
  assert.match(note, /不挂载/);
});
