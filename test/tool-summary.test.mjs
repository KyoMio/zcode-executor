// test/tool-summary.test.mjs —— 本回合解析纯函数的用例（SPEC-watch-pane A）。
// 事件剧本就近写在用例里，形状按真机写（verified.md「工具参数位置与 Bash 成败字段」2026-10-02，
// App 3.14.1）：tool.updated 的 scheduled/started/result/batch，model.streaming 的
// tool_call / text_delta / reasoning_delta。不碰文件系统，全是内存事件数组。
import test from 'node:test';
import assert from 'node:assert/strict';
import { lastMessageMarkdown, markdownTail, parseTurn, replyLines, toolSummary, pendingSummary, turnEvents } from '../lib/tool-summary.mjs';

const CWD = '/repo';

// ---------- 参数的三种形状 ----------

test('parseTurn：3.12+ 参数只在 model.streaming 的 tool_call 里，input 与 summary 都拿得到（verified.md 2026-10-02）', () => {
  const events = [
    // scheduled 行 inputOmitted:true、inputRef:"model_stream"，不带 input
    { type: 'tool.updated', payload: { toolCallId: 'call_1', toolName: 'Write', kind: 'scheduled', inputOmitted: true, inputRef: 'model_stream' } },
    { type: 'model.streaming', payload: { assistantMessageId: 'msg_1', kind: 'tool_call', toolCallId: 'call_1', toolName: 'Write', input: { file_path: '/repo/docs/x.md' } } },
    { type: 'tool.updated', payload: { toolCallId: 'call_1', toolName: 'Write', kind: 'started' } },
    { type: 'tool.updated', payload: { toolCallId: 'call_1', kind: 'result', result: { success: true, content: 'ok' } } },
  ];
  const { calls, reply } = parseTurn(events, { cwd: CWD });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    toolCallId: 'call_1',
    toolName: 'Write',
    input: { file_path: '/repo/docs/x.md' },
    summary: 'docs/x.md', // cwd 内给相对路径
    state: 'done',
    ok: true,
  });
  assert.deepEqual(reply, []);
});

test('parseTurn：旧形状参数在 tool.updated 自带的 input 里', () => {
  const events = [
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Edit', kind: 'scheduled', input: { file_path: 'docs/x.md' } } },
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Edit', kind: 'started', input: { file_path: 'docs/x.md' } } },
    { type: 'tool.updated', payload: { toolCallId: 't1', kind: 'result', result: { success: true } } },
  ];
  const { calls } = parseTurn(events, { cwd: CWD });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    toolCallId: 't1',
    toolName: 'Edit',
    input: { file_path: 'docs/x.md' },
    summary: 'docs/x.md',
    state: 'done',
    ok: true,
  });
});

test('parseTurn：参数只在 permission.requested 里时按同名工具兜底，Read 不借走 Write 的（2026-09-22 冒烟）', () => {
  const events = [
    // Read 在 Write 前面：若实现成「同名队列空就借别家」，Read 会在这里偷走 Write 的兜底，
    // 后面 Write 就拿不到——这个顺序才考得住规则（2026-09-22 冒烟的翻车形状）
    { type: 'tool.updated', payload: { toolCallId: 't2', toolName: 'Read', kind: 'scheduled', inputOmitted: true } },
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Write', kind: 'scheduled', inputOmitted: true } },
    // 真机里审批事件在 tool.updated 之后才到（verified.md「事件流」），兜底靠最后一遍回填
    { type: 'permission.requested', payload: { toolName: 'Write', input: { file_path: 'docs/fallback.md' } } },
  ];
  const { calls } = parseTurn(events, { cwd: CWD });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].toolName, 'Read');
  assert.equal(calls[0].input, undefined); // 真机 Read 省略 input 也不发审批请求，没有兜底
  assert.equal(calls[0].summary, null);
  assert.deepEqual(calls[1], {
    toolCallId: 't1',
    toolName: 'Write',
    input: { file_path: 'docs/fallback.md' },
    summary: 'docs/fallback.md',
    state: 'scheduled',
    ok: null,
  });
});

test('parseTurn：tool.updated 自带 input 与 tool_call 的 input 并存时，用 tool_call 那份（3.12+ 参数权威）', () => {
  const events = [
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Write', kind: 'scheduled', input: { file_path: 'old.md' } } },
    { type: 'model.streaming', payload: { assistantMessageId: 'msg_1', kind: 'tool_call', toolCallId: 't1', toolName: 'Write', input: { file_path: 'new.md' } } },
    { type: 'tool.updated', payload: { toolCallId: 't1', kind: 'result', result: { success: true } } },
  ];
  const { calls } = parseTurn(events, { cwd: CWD });
  assert.deepEqual(calls[0].input, { file_path: 'new.md' });
  assert.equal(calls[0].summary, 'new.md');
});

test('parseTurn：只有 result 行、查不到工具名的调用不进 calls', () => {
  const events = [
    { type: 'tool.updated', payload: { toolCallId: 'ghost', kind: 'result', result: { success: true } } },
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Bash', kind: 'scheduled' } },
    { type: 'tool.updated', payload: { toolCallId: 't1', kind: 'result', result: { success: true } } },
  ];
  const { calls } = parseTurn(events, { cwd: CWD });
  assert.deepEqual(calls.map((c) => c.toolCallId), ['t1']); // ghost 没有 toolName，去掉
});

// ---------- 归并与状态 ----------

test('parseTurn：result 行没有 toolName 靠 toolCallId 归并；state 分 scheduled/running/done', () => {
  const events = [
    { type: 'tool.updated', payload: { toolCallId: 'a', toolName: 'Bash', kind: 'scheduled' } },
    { type: 'tool.updated', payload: { toolCallId: 'b', toolName: 'Bash', kind: 'scheduled' } },
    { type: 'tool.updated', payload: { toolCallId: 'b', kind: 'started' } },
  ];
  const { calls } = parseTurn(events, { cwd: CWD });
  assert.deepEqual(calls.map((c) => [c.toolCallId, c.state, c.ok]), [
    ['a', 'scheduled', null],
    ['b', 'running', null],
  ]);
});

test('parseTurn：两个调用交错（并行）不串，batch 行不产生调用', () => {
  const events = [
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Write', kind: 'scheduled', input: { file_path: 'a.md' } } },
    { type: 'tool.updated', payload: { toolCallId: 't2', toolName: 'Write', kind: 'scheduled', input: { file_path: 'b.md' } } },
    { type: 'tool.updated', payload: { toolCallIds: ['t1', 't2'], successCount: 1, errorCount: 1, kind: 'batch' } },
    { type: 'tool.updated', payload: { toolCallId: 't2', kind: 'result', result: { success: true } } },
    { type: 'tool.updated', payload: { toolCallId: 't1', kind: 'result', result: { success: false } } },
  ];
  const { calls } = parseTurn(events, { cwd: CWD });
  assert.equal(calls.length, 2); // batch 行不算调用
  assert.deepEqual(calls.map((c) => [c.toolCallId, c.input, c.ok]), [
    ['t1', { file_path: 'a.md' }, false], // 成败各归各的调用
    ['t2', { file_path: 'b.md' }, true],
  ]);
  assert.deepEqual(calls.map((c) => c.summary), ['a.md', 'b.md']);
});

// ---------- 成败 ----------

test('parseTurn：Bash 退出码 1 判 ok:false（result.success 仍为 true），退出码 0 判 true（verified.md 2026-10-02）', () => {
  const events = [
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Bash', kind: 'scheduled' } },
    // 真机 x_af149b61：perf 在 payload.result.perf 里，detail.command 带 exitCode 与 status:"failed"
    { type: 'tool.updated', payload: { toolCallId: 't1', kind: 'result', result: { success: true, content: 'Exit code 1\n…', perf: { totalMs: 2997, detail: { kind: 'command', command: { exitCode: 1, status: 'failed' } } } } } },
    { type: 'tool.updated', payload: { toolCallId: 't2', toolName: 'Bash', kind: 'scheduled' } },
    { type: 'tool.updated', payload: { toolCallId: 't2', kind: 'result', result: { success: true, perf: { detail: { kind: 'command', command: { exitCode: 0, status: 'success' } } } } } },
  ];
  const { calls } = parseTurn(events, { cwd: CWD });
  assert.equal(calls[0].ok, false);
  assert.equal(calls[1].ok, true);
});

test('parseTurn：perf 挂在 payload.perf 也认；非 Bash 的 success:false 判 ok:false', () => {
  const events = [
    { type: 'tool.updated', payload: { toolCallId: 't1', toolName: 'Bash', kind: 'scheduled' } },
    { type: 'tool.updated', payload: { toolCallId: 't1', kind: 'result', result: { success: true }, perf: { detail: { command: { exitCode: 2 } } } } },
    { type: 'tool.updated', payload: { toolCallId: 't2', toolName: 'Edit', kind: 'scheduled' } },
    { type: 'tool.updated', payload: { toolCallId: 't2', kind: 'result', result: { success: false } } },
    { type: 'tool.updated', payload: { toolCallId: 't3', toolName: 'Grep', kind: 'scheduled' } },
    { type: 'tool.updated', payload: { toolCallId: 't3', kind: 'result', result: { success: true } } },
  ];
  const { calls } = parseTurn(events, { cwd: CWD });
  assert.equal(calls[0].ok, false); // payload.perf 位置
  assert.equal(calls[1].ok, false); // 非 Bash 的 success:false
  assert.equal(calls[2].ok, true);
});

// ---------- 摘要 ----------

test('toolSummary：四类工具、其他工具、cwd 内外路径、多行命令、200 字截断', () => {
  assert.equal(toolSummary('Bash', { command: 'npm test\nls -la' }, CWD), 'npm test'); // 多行命令只取第一行
  assert.equal(toolSummary('Read', { file_path: '/repo/src/a.mjs' }, CWD), 'src/a.mjs'); // cwd 内相对路径
  assert.equal(toolSummary('Write', { file_path: '/elsewhere/b.md' }, CWD), '/elsewhere/b.md'); // cwd 外原样
  assert.equal(toolSummary('Edit', { file_path: 'docs/c.md' }, CWD), 'docs/c.md'); // 相对路径原样
  assert.equal(toolSummary('MultiEdit', { file_path: '/repo/d.md' }, undefined), '/repo/d.md'); // cwd 未知原样
  assert.equal(toolSummary('Grep', { pattern: 'foo.*bar' }, CWD), 'foo.*bar');
  assert.equal(toolSummary('Glob', { pattern: '**/*.ts' }, CWD), '**/*.ts');
  assert.equal(toolSummary('WebFetch', { url: 'https://example.com' }, CWD), null); // 其他工具没有摘要
  assert.equal(toolSummary('Bash', null, CWD), null); // 没有参数
  assert.equal(toolSummary('Bash', { command: 'x'.repeat(300) }, CWD).length, 200); // 截到 200 字
  assert.equal(toolSummary('Read', { file_path: `/repo/${'y'.repeat(300)}` }, CWD).length, 200);
});

test('toolSummary：file_path 不是字符串（数字、数组）返回 null 不抛错（模型生成的参数格式没保证）', () => {
  assert.equal(toolSummary('Read', { file_path: 123 }, CWD), null);
  assert.equal(toolSummary('Write', { file_path: ['a.md'] }, CWD), null);
  // 挂起摘要不抛错即可：落不进路径分支就按其他工具给整个 input 的 JSON
  assert.equal(pendingSummary('Read', { file_path: 123 }, CWD), '{"file_path":123}');
});

test('pendingSummary：Bash 保留命令全文，其他工具给 JSON，2000 字截断，没有参数为 null', () => {
  assert.equal(pendingSummary('Bash', { command: 'npm test\nls -la' }, CWD), 'npm test\nls -la'); // 全文
  assert.equal(pendingSummary('Write', { file_path: '/repo/src/a.mjs' }, CWD), 'src/a.mjs');
  assert.equal(pendingSummary('Grep', { pattern: 'x' }, CWD), JSON.stringify({ pattern: 'x' })); // 其他工具给 JSON
  assert.equal(pendingSummary('Bash', undefined, CWD), null);
  assert.equal(pendingSummary('Bash', { command: 'z'.repeat(3000) }, CWD).length, 2000);
});

// ---------- 回复 ----------

test('replyLines：消息之间换行、空行去掉、尾部空白 trim，reasoning_delta 不进 reply', () => {
  const events = [
    { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '第一行 \n' } },
    { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '\n\n第二行' } },
    { type: 'model.streaming', payload: { assistantMessageId: 'm2', kind: 'text_delta', delta: '第二条消息' } },
    { type: 'model.streaming', payload: { assistantMessageId: 'm2', kind: 'reasoning_delta', delta: '思考不进回复' } },
  ];
  const { reply } = parseTurn(events, { cwd: CWD });
  assert.deepEqual(reply, ['第一行', '第二行', '第二条消息']);
});

test('replyLines：只留最后 8 行', () => {
  const deltas = [];
  for (let i = 1; i <= 10; i++) deltas.push({ assistantMessageId: 'm1', delta: `行${i}\n` });
  assert.deepEqual(replyLines(deltas), ['行3', '行4', '行5', '行6', '行7', '行8', '行9', '行10']);
});

test('replyLines：总长超 800 字从最前面丢行、最前一行截掉开头', () => {
  const long = 'x'.repeat(400);
  assert.deepEqual(replyLines([{ assistantMessageId: 'm1', delta: `${long}\n${long}\n${long}` }]), [
    // 1200 字：整行丢得下（丢完正好 800）就整行丢
    long,
    long,
  ]);
  const tail = 'y'.repeat(750);
  const kept = replyLines([{ assistantMessageId: 'm1', delta: `${'z'.repeat(100)}\n${tail}` }]);
  assert.deepEqual(kept, ['z'.repeat(50), tail]); // 850 字：丢整行会低于 800，改截最前一行的开头
});

// ---------- replyMarkdown ----------

test('lastMessageMarkdown：只取最后一条消息，前面消息的文字不出现；空行与 Markdown 结构原样', () => {
  const lastBody = '## 第二条\n\n- 甲\n- 乙\n\n| 一 | 二 |\n| --- | --- |\n| 三 | 四 |';
  const deltas = [
    { assistantMessageId: 'm1', delta: '# 第一条' },
    { assistantMessageId: 'm1', delta: '旧文字' },
    { assistantMessageId: 'm2', delta: lastBody },
  ];
  assert.equal(lastMessageMarkdown(deltas), lastBody);
});

test('markdownTail：不超长原样返回；超长以 … 开头、截断点挪到整行开头；找不到换行就不挪', () => {
  const short = '# 标题\n\n正文两行\n第二行';
  assert.equal(markdownTail(short), short);
  assert.equal(markdownTail(short, { maxChars: short.length }), short); // 恰好等于上限也算不超

  const text = `${'x'.repeat(30)}\n${'y'.repeat(5)}\n${'z'.repeat(25)}`; // 长 62
  // maxChars 30：截断点落在 y 行中间，往后挪到换行之后，从 z 行整行开始（宁可少于 30 字）
  assert.equal(markdownTail(text, { maxChars: 30 }), `…\n\n${'z'.repeat(25)}`);
  // 全程没有换行：不挪，末尾 30 字原样保住
  assert.equal(markdownTail('a'.repeat(100), { maxChars: 30 }), `…\n\n${'a'.repeat(30)}`);
});

test('markdownTail：截断点正好在整行开头时不再多丢一行', () => {
  // cut=4 正好是 bbb 行首：旧实现会从 4 往后找到 ccc 行首，把 bbb 也丢了
  assert.equal(markdownTail('aaa\nbbb\nccc', { maxChars: 7 }), '…\n\nbbb\nccc');
});

test('markdownTail：截断点落在代理对后半时再让一个字，结果里没有孤立的半个代理对', () => {
  // 40 个码元、cut=35 落在一个 😀 的后半：再让一个码元，从下一个 😀 整字开始
  assert.equal(markdownTail('😀'.repeat(20), { maxChars: 5 }), `…\n\n${'😀'.repeat(2)}`);
});

test('markdownTail：截在表格中间补回表头与分隔行；截在表格外、表头已在保留部分时不补', () => {
  const table = '前文一段\n\n| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n| 三 | 四 |';
  // 截断点落在数据行里：保留的是没头没尾的两行数据，补回表头与分隔行
  assert.equal(markdownTail(table, { maxChars: 20 }), '…\n\n| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n| 三 | 四 |');
  // 截在表格后面的正文里：保留首行不是 | 开头，不补
  const outside = '前文一段\n\n| 甲 | 乙 |\n| --- | --- |\n| 一 | 二 |\n\n结尾还有很多内容撑长它';
  assert.equal(markdownTail(outside, { maxChars: 8 }), '…\n\n有很多内容撑长它');
  // 截断点正好在表头行首：表头本来就在保留部分里，不重复补
  assert.equal(markdownTail(table, { maxChars: table.length - 6 }), `…\n\n${table.slice(6)}`);
});

test('markdownTail：截断点落在代码块里补原围栏行（含语言名），落在代码块外不补', () => {
  // 被截掉的部分恰含一个开启围栏 ```js（奇数）→ 在 … 之后补回 ```js 重新打开代码块
  const inCode = `引言\n\n\`\`\`js\n${'y'.repeat(40)}\n结尾`;
  assert.equal(markdownTail(inCode, { maxChars: 10 }), '…\n\n```js\n结尾');
  // 围栏成对（偶数）→ 截断点在代码块外，不补
  const outCode = `引言\n\n\`\`\`js\ncode\n\`\`\`\n\n${'y'.repeat(40)}\n结尾`;
  assert.equal(markdownTail(outCode, { maxChars: 10 }), '…\n\n结尾');
});

test('markdownTail：\\r\\n 归一成 \\n、单独 \\r 也是，控制字符删掉，制表符保留，首尾空白去掉', () => {
  const raw = '# 标题\r\n\r\n- 甲\t乙\r- 丙\u0007\n';
  assert.equal(markdownTail(raw), '# 标题\n\n- 甲\t乙\n- 丙');
  assert.equal(markdownTail('a\u009bb'), 'ab'); // C1 控制字符（\x80-\x9f）一并删掉
});

test('lastMessageMarkdown：没有 delta 返回空串', () => {
  assert.equal(lastMessageMarkdown([]), '');
  assert.equal(lastMessageMarkdown(undefined), '');
});

test('parseTurn：replyMarkdown 取最新一条消息，reasoning_delta 不进来；reply 取法不变', () => {
  const events = [
    { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '# 旧消息' } },
    { type: 'model.streaming', payload: { assistantMessageId: 'm2', kind: 'text_delta', delta: '## 新消息\n\n正文' } },
    { type: 'model.streaming', payload: { assistantMessageId: 'm2', kind: 'reasoning_delta', delta: '思考' } },
  ];
  const { reply, replyMarkdown } = parseTurn(events, { cwd: CWD });
  assert.deepEqual(reply, ['# 旧消息', '## 新消息', '正文']);
  assert.equal(replyMarkdown, '## 新消息\n\n正文');
  assert.equal(parseTurn([], { cwd: CWD }).replyMarkdown, '');
});

test('parseTurn：最新一条消息只有 tool_call 没有文字时，replyMarkdown 仍是上一条有文字的消息', () => {
  const events = [
    { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '先说结论' } },
    { type: 'model.streaming', payload: { assistantMessageId: 'm2', kind: 'tool_call', toolCallId: 't1', toolName: 'Bash', input: { command: 'ls' } } },
  ];
  assert.equal(parseTurn(events, { cwd: CWD }).replyMarkdown, '先说结论'); // tool_call 不进 textDeltas，最后一条有文字的还是 m1
});

// ---------- 本回合边界 ----------

test('turnEvents：只取最后一条 executor.send 之后的事件，parseTurn 不跨回合', () => {
  const events = [
    { type: 'executor.send' },
    { type: 'tool.updated', payload: { toolCallId: 'old', toolName: 'Bash', kind: 'scheduled' } },
    { type: 'executor.send' },
    { type: 'model.streaming', payload: { assistantMessageId: 'm1', kind: 'text_delta', delta: '新回合' } },
  ];
  assert.deepEqual(turnEvents(events), events.slice(3)); // send 之后，不含 send 本身
  const { calls, reply } = parseTurn(turnEvents(events), { cwd: CWD });
  assert.deepEqual(calls, []); // 上一回合的工具不清进来
  assert.deepEqual(reply, ['新回合']);
});

test('turnEvents：没有 executor.send 返回空数组', () => {
  assert.deepEqual(turnEvents([]), []);
  assert.deepEqual(turnEvents([{ type: 'tool.updated', payload: { toolName: 'Bash', kind: 'started' } }]), []);
});
