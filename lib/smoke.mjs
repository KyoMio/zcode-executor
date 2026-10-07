// 派单流程冒烟测试用的最小探针：只提供一个可被机器断言的纯函数，不依赖任何模块。
// 任务验收后可整体删除，不接入任何调用方。

export function smokePing(name = 'zcode') {
  return `pong:${name}`;
}
