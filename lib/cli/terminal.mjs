// 本文件负责：CLI 输出里的终端控制字符中和（审计 D9-①）。执行端可控的文本——审批请求的工具名与理由、
// 提问、模型回复、文件名、zcode 报错原文——会被原样打到终端，里面夹一段 ANSI/OSC 转义就能清屏、
// 改写人正在看的挂起行、动剪贴板。打印点有几十处，逐处过滤迟早漏一处，所以在入口把 stdout/stderr 的
// 写出口整个包一层：这些字符换成看得见的 \uXXXX，内容不丢，人能看出这里被塞了东西。
// --json 输出的含义不变：这些字符只会出现在 JSON 字符串里，\uXXXX 在那里是合法转义，解析回来还是原字符。
// 不负责：密钥抹除（lib/scrub.mjs）；输出内容的真假——模型回复里自己写一行「send: done」拦不了，
// 回复原文按原样分行打印是定下来的做法（T2.8 第 1 条）。
// 被依赖方：bin/zcode-executor。无依赖。

// 换行和制表留着，输出的行结构靠它们。其余一律转义：C0；DEL；C1（8 位的 CSI、OSC 在这一段，
// JSON.stringify 不转义它们）；双向排版控制符 U+202A-202E、U+2066-2069（让一行字看起来顺序颠倒）。
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * 把文本里的终端控制字符换成 \uXXXX 字面量。`\r\n` 收成 `\n`（那个 `\r` 没有显示效果）；
 * 落单的 `\r` 照样转义——它把光标送回行首，后面的字会盖掉已经打出来的那一行。
 */
export function neutralizeControls(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(UNSAFE, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** 包住流的 write：字符串先过 neutralizeControls 再写；Buffer 与其余参数、返回值原样。 */
export function guardOutput(...streams) {
  for (const stream of streams) {
    const write = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => write(typeof chunk === 'string' ? neutralizeControls(chunk) : chunk, ...rest);
  }
}
