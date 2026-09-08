// 本文件负责：全项目唯一的错误类型 ExecutorError，带进程退出码和排障细节。
// 不负责：具体怎么抛（各层自己抛），错误怎么打印（外壳层负责）。
// 被依赖方：所有层。它自己不依赖任何项目内模块。

/**
 * 项目内一切可预期的失败都用它。exitCode 只取 PRD 退出码表里的 0-5。
 * JSON-RPC 错误的有用信息在 error.data.details，调用方把它塞进 details，别只留 message。
 */
export class ExecutorError extends Error {
  /**
   * @param {string} message 中文，说清出了什么事、该怎么办
   * @param {number|object} [exitCode] 进程退出码，默认 1；传对象时视为 details 简写
   *   （评审第 7 条：协议层不定退出码，允许只传 details 不碰退出码）
   * @param {object} [extra] 排障细节（如 { method, code, data }），打印时随 message 一起给
   */
  constructor(message, exitCode = 1, extra = {}) {
    super(message);
    this.name = 'ExecutorError';
    // T0.3b 复核 F：真值判断挡住 null/undefined 落进对象分支；else 侧 ?? 1 堵住传 null 的口子。
    // exitCode 为 0 时走 else 且 0 ?? 1 仍是 0，合法退出码不受影响。
    if (exitCode && typeof exitCode === 'object') {
      this.exitCode = 1;
      this.details = exitCode;
    } else {
      this.exitCode = exitCode ?? 1;
      this.details = extra;
    }
  }
}
