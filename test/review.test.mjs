// lib/review/*.mjs 的行为测试：机械红线判定、两阶段输出解析、提示词组装、证据收集、规则表。
// 纯函数测试（任务单 T3.1）：不起进程、不碰真机、不发 send；文件系统夹具用 mkdtemp
// 建临时目录并在 test.after() 里清掉（RULES §6）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkHardRules } from '../lib/review/hard.mjs';
import { parseFast, parseSlow } from '../lib/review/parse.mjs';
import { systemPrompt, actionPrompt } from '../lib/review/prompt.mjs';
import { gatherEvidence, nodeProbe } from '../lib/review/evidence.mjs';
import { RULES, ALLOWANCES, HARD_RULES, OUTSIDE_WORKTREE, ruleById } from '../lib/review/rules.mjs';
import { ExecutorError } from '../lib/errors.mjs';

// ── 临时目录夹具 ──
const tempDirs = [];
function makeTempDir(base = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(base, 'zcx-review-'));
  tempDirs.push(dir);
  return dir;
}
// realpath 过的目录当 cwd 用，避免 macOS 上 /var 与 /private/var 两套拼法干扰断言
function makeCwd() {
  return fs.realpathSync(makeTempDir());
}

test.after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ── checkHardRules ──

test('checkHardRules：Write 到执行副本内的既有文件不命中', () => {
  const cwd = makeCwd();
  const file = path.join(cwd, 'a.txt');
  fs.writeFileSync(file, 'x');
  assert.deepEqual(
    checkHardRules({ toolName: 'Write', input: { file_path: file } }, { cwd }),
    { hit: false, ruleId: null },
  );
});

test('checkHardRules：Write 到执行副本外命中，why 带路径', () => {
  const cwd = makeCwd();
  const outside = makeCwd();
  const target = path.join(outside, 'secret.txt');
  const res = checkHardRules({ toolName: 'Write', input: { file_path: target } }, { cwd });
  assert.equal(res.hit, true);
  assert.equal(res.ruleId, 'outside-worktree');
  assert.ok(res.why.includes(target), `why 应带路径，实际：${res.why}`);
});

test('checkHardRules：../ 越出执行副本命中', () => {
  const cwd = makeCwd();
  const res = checkHardRules(
    { toolName: 'Write', input: { file_path: path.join(cwd, '..', 'escape.txt') } },
    { cwd },
  );
  assert.equal(res.hit, true);
  assert.equal(res.ruleId, 'outside-worktree');
});

test('checkHardRules：cwd 内符号链接指向外部，写穿链接命中', () => {
  const cwd = makeCwd();
  const outside = makeCwd();
  fs.symlinkSync(outside, path.join(cwd, 'link'), 'dir');
  const res = checkHardRules(
    { toolName: 'Write', input: { file_path: path.join(cwd, 'link', 'f.txt') } },
    { cwd },
  );
  assert.equal(res.hit, true);
  assert.equal(res.ruleId, 'outside-worktree');
  assert.ok(res.why.includes(outside), `why 应指向链接的真实目标，实际：${res.why}`);
});

test('checkHardRules：目标不存在但父目录在执行副本内不命中', () => {
  const cwd = makeCwd();
  const res = checkHardRules(
    { toolName: 'Write', input: { file_path: path.join(cwd, 'newdir', 'f.txt') } },
    { cwd },
  );
  assert.deepEqual(res, { hit: false, ruleId: null });
});

test('checkHardRules：Bash rm -rf / 无路径参数不命中，交模型审批', () => {
  const cwd = makeCwd();
  assert.deepEqual(
    checkHardRules({ toolName: 'Bash', input: { command: 'rm -rf /' } }, { cwd }),
    { hit: false, ruleId: null },
  );
  // 无名工具且 input 里没有路径键，同样交模型审批
  assert.deepEqual(
    checkHardRules({ toolName: 'Grep', input: { pattern: 'x' } }, { cwd }),
    { hit: false, ruleId: null },
  );
});

test('checkHardRules：/tmp 与 /private/tmp 写法互通（realpath 归一）', () => {
  // macOS 上 /tmp 是 /private/tmp 的符号链接；两种拼法必须算作同一个地方。
  // Linux 上 /tmp 就是本体，此用例退化为同路径，仍应通过。
  const base = fs.mkdtempSync(path.join('/tmp', 'zcx-review-'));
  tempDirs.push(base);
  const cwd = fs.realpathSync(base); // macOS 上形如 /private/tmp/zcx-review-xxx
  // cwd 用 realpath 拼法、写入用 /tmp 别名拼法——同一个地方，不命中
  assert.deepEqual(
    checkHardRules(
      { toolName: 'Write', input: { file_path: path.join('/tmp', path.basename(base), 'f.txt') } },
      { cwd },
    ),
    { hit: false, ruleId: null },
  );
  // 反方向：/tmp 别名拼法下越出 cwd 的路径，照样判出越界
  const res = checkHardRules(
    {
      toolName: 'Write',
      input: { file_path: path.join('/tmp', path.basename(base), '..', 'elsewhere.txt') },
    },
    { cwd },
  );
  assert.equal(res.hit, true);
});

test('checkHardRules：路径键判据覆盖 notebook_path 与 path，不只认工具名', () => {
  const cwd = makeCwd();
  const outside = makeCwd();
  // 不在点名清单里的工具，input 带 notebook_path 且越界 → 命中
  assert.equal(
    checkHardRules(
      { toolName: 'CustomTool', input: { notebook_path: path.join(outside, 'n.ipynb') } },
      { cwd },
    ).hit,
    true,
  );
  // input 带 path 且越界 → 命中
  assert.equal(
    checkHardRules({ toolName: 'CustomTool', input: { path: path.join(outside, 'p') } }, { cwd }).hit,
    true,
  );
  // 点名工具 NotebookEdit，notebook_path 在界内 → 不命中
  assert.deepEqual(
    checkHardRules(
      { toolName: 'NotebookEdit', input: { notebook_path: path.join(cwd, 'n.ipynb') } },
      { cwd },
    ),
    { hit: false, ruleId: null },
  );
});

test('checkHardRules：相对路径以 cwd 为基解析', () => {
  const cwd = makeCwd();
  assert.deepEqual(
    checkHardRules({ toolName: 'Write', input: { file_path: 'a.txt' } }, { cwd }),
    { hit: false, ruleId: null },
  );
  assert.equal(
    checkHardRules({ toolName: 'Write', input: { file_path: '../a.txt' } }, { cwd }).hit,
    true,
  );
});

test('checkHardRules：~ 与 ~/… 按 homedir 展开后判界，家目录在外命中', () => {
  const cwd = makeCwd();
  assert.notEqual(path.dirname(os.homedir()), cwd); // 夹具有效：家目录不在临时 cwd 里
  assert.equal(
    checkHardRules({ toolName: 'Write', input: { file_path: '~/.ssh/id_rsa' } }, { cwd }).hit,
    true,
  );
  assert.equal(checkHardRules({ toolName: 'Write', input: { file_path: '~' } }, { cwd }).hit, true);
});

test('checkHardRules：兄弟目录前缀（cwd + -evil/x）命中，前缀比对补分隔符', () => {
  const cwd = makeCwd();
  const res = checkHardRules(
    { toolName: 'Write', input: { file_path: path.join(`${cwd}-evil`, 'x') } },
    { cwd },
  );
  assert.equal(res.hit, true);
  assert.ok(res.why.includes(`${cwd}-evil`), `why 应带兄弟目录路径，实际：${res.why}`);
});

test('checkHardRules：只读工具越界，why 说「读到执行副本之外」', () => {
  const cwd = makeCwd();
  const outside = makeCwd();
  const res = checkHardRules(
    { toolName: 'Read', input: { file_path: path.join(outside, 'secret.txt') } },
    { cwd },
  );
  assert.equal(res.hit, true);
  assert.ok(res.why.startsWith('读到执行副本之外：'), `实际：${res.why}`);
});

test('checkHardRules：cwd 不是非空字符串抛 ExecutorError（调用方编程错误）', () => {
  const action = { toolName: 'Write', input: { file_path: 'a.txt' } };
  assert.throws(() => checkHardRules(action, {}), ExecutorError);
  assert.throws(() => checkHardRules(action, { cwd: undefined }), ExecutorError);
  assert.throws(() => checkHardRules(action, { cwd: '' }), ExecutorError);
  assert.throws(() => checkHardRules(action, { cwd: null }), ExecutorError);
});

// ── parseFast ──

test('parseFast：Y 判 pass，N 判 flag', () => {
  assert.equal(parseFast('Y'), 'pass');
  assert.equal(parseFast('N'), 'flag');
});

test('parseFast：大小写、前后空白、模型多话不影响判定', () => {
  assert.equal(parseFast('y'), 'pass');
  assert.equal(parseFast('  Y  '), 'pass');
  assert.equal(parseFast('\n n \n'), 'flag');
  assert.equal(parseFast('答案是 Y。'), 'pass');
});

test('parseFast：垃圾文本按 flag（落到更谨慎的一边）', () => {
  assert.equal(parseFast('模型没按格式回答'), 'flag');
  assert.equal(parseFast(''), 'flag');
});

// ── parseSlow ──

test('parseSlow：allow 带理由，不附规则 id', () => {
  assert.deepEqual(
    parseSlow('结论: allow | 规则: none | 理由: 属于日常工作'),
    { decision: 'allow', reason: '属于日常工作' },
  );
});

test('parseSlow：deny 附命中的规则 id 与理由', () => {
  assert.deepEqual(
    parseSlow('推理过程……\n结论：deny | 规则: cred-exfil | 理由: 凭据外发'),
    { decision: 'deny', ruleId: 'cred-exfil', reason: '凭据外发' },
  );
});

test('parseSlow：deny 说不出规则 id 按 ask 转人工，reason 带前缀标明来路', () => {
  assert.deepEqual(
    parseSlow('结论: deny | 规则: none | 理由: 看着危险'),
    { decision: 'ask', reason: '拒绝未附规则 id，转人工：看着危险' },
  );
  assert.deepEqual(
    parseSlow('结论: deny'),
    { decision: 'ask', reason: '拒绝未附规则 id，转人工：' },
  );
});

test('parseSlow：模型直接回 ask 落 ask', () => {
  assert.deepEqual(
    parseSlow('结论: ask | 理由: 拿不准'),
    { decision: 'ask', reason: '拿不准' },
  );
});

test('parseSlow：首行是结论行就取第一行（T3.3 新格式优先），不再取最后一个', () => {
  assert.equal(parseSlow('模型自由发挥，没有结论行'), undefined);
  assert.deepEqual(
    parseSlow(
      '结论: deny cred-exfil 理由: 先判错了\n'
      + '结论: allow',
    ),
    { decision: 'deny', ruleId: 'cred-exfil', reason: '先判错了' },
  );
});

test('parseSlow：首行不是结论行时全文扫最后一个结论行（兼容旧输出）', () => {
  assert.deepEqual(
    parseSlow(
      '先写一段推理，逐条核对清单……\n'
      + '结论: deny | 规则: cred-exfil | 理由: 先判错了\n'
      + '结论: allow | 规则: none | 理由: 复核后是日常工作',
    ),
    { decision: 'allow', reason: '复核后是日常工作' },
  );
});

test('parseSlow：结论行在第一行 + 理由在后面（T3.3 新格式）解析成功', () => {
  assert.deepEqual(
    parseSlow('结论: allow\n新建 hello.txt 是任务单明确要求的日常工作，且全程在执行副本内，没有越界。'),
    { decision: 'allow', reason: '新建 hello.txt 是任务单明确要求的日常工作，且全程在执行副本内，没有越界。' },
  );
  assert.deepEqual(
    parseSlow('结论: deny cred-exfil\n理由：把私钥内容发到外部接口，凭据离开本机。'),
    { decision: 'deny', ruleId: 'cred-exfil', reason: '把私钥内容发到外部接口，凭据离开本机。' },
  );
});

test('parseSlow：被截断没有结论行 → undefined（createReview 据此落 ask review-failed）', () => {
  const truncated = '这条操作我逐条核对了一遍：先看意图，任务单要求新建文件；再看工作区，'
    + '路径在执行副本之内；再看凭据，没有触碰任何密钥文件；接着看网络外发，没有上传行为；'
    + '综合以上……'; // 推理到一半被 maxOutputTokens 截断，结论行没写出来
  assert.equal(parseSlow(truncated), undefined);
});

// ── systemPrompt / actionPrompt ──

const CTX = {
  intent: ['修复登录页 500 的 bug', '顺带补上回归测试'],
  priorActions: ['Read src/a.ts'],
  environment: ['macOS 本机，工作区是执行副本'],
  sensitive: ['~/.ssh', '~/.aws'],
  evidence: { facts: ['`src/a.ts` 在本次会话开始前就存在'] },
  projectDoc: '# 项目说明\n改完要跑 npm test。',
};

test('systemPrompt：含全部 hard 规则的 blocks 文本与两个规则分节', () => {
  const text = systemPrompt(RULES, CTX, ALLOWANCES);
  assert.ok(text.includes('### 一律拦截（谁也推不翻）'));
  assert.ok(text.includes('### 默认拦截，用户点全了才放行'));
  for (const rule of HARD_RULES) {
    assert.ok(text.includes(rule.blocks), `缺 hard 规则 ${rule.id} 的文本`);
  }
});

test('systemPrompt：含 outside-worktree 的 id 与文案（经 rules 参数进来，无特判）', () => {
  const text = systemPrompt(RULES, CTX, ALLOWANCES);
  assert.ok(text.includes(`- **${OUTSIDE_WORKTREE.id}**：${OUTSIDE_WORKTREE.blocks}`),
    '缺 outside-worktree 的规则行');
  // 只传 hard 规则（gate 慢判复核的场景）也必须带上
  assert.ok(systemPrompt(HARD_RULES, CTX).includes(OUTSIDE_WORKTREE.blocks),
    'HARD_RULES 里也应有 outside-worktree 文案');
});

test('systemPrompt：含全部 ALLOWANCES 文本', () => {
  const text = systemPrompt(RULES, CTX, ALLOWANCES);
  for (const a of ALLOWANCES) {
    assert.ok(text.includes(a.allows), `缺放行例外 ${a.id} 的文本`);
  }
});

test('actionPrompt：含工具名、工作区、参数与 intent 全文与证据事实', () => {
  const action = {
    toolName: 'Write',
    args: { file_path: '/w/src/a.ts', content: 'hi' },
    workspaceRoot: '/w',
  };
  const text = actionPrompt(action, CTX);
  assert.ok(text.includes('工具：Write'));
  assert.ok(text.includes('工作区：/w'));
  assert.ok(text.includes('/w/src/a.ts'));
  for (const line of CTX.intent) assert.ok(text.includes(line), `缺意图全文：${line}`);
  assert.ok(text.includes('`src/a.ts` 在本次会话开始前就存在'), '缺证据事实');
});

test('actionPrompt：task 意图超 600 字不截（T3.2b），send 截 600 并带来源标记', () => {
  const action = { toolName: 'Write', args: {}, workspaceRoot: '/w' };
  const taskText = `${'甲'.repeat(700)}末尾独特句蓝鲸有牙。`;
  const withTask = actionPrompt(action, {
    intent: [{ source: 'task', text: taskText }],
    environment: [],
    sensitive: [],
  });
  assert.ok(withTask.includes('[task]'), 'task 条目带来源标记');
  assert.ok(withTask.includes('末尾独特句蓝鲸有牙。'), '任务单超 600 字的末尾不能被截掉');

  const sendText = `${'乙'.repeat(700)}末尾独特句河马有獠牙。`;
  const withSend = actionPrompt(action, {
    intent: [{ source: 'send', text: sendText }],
    environment: [],
    sensitive: [],
  });
  assert.ok(withSend.includes('[send]'), 'send 条目带来源标记');
  assert.ok(!withSend.includes('河马有獠牙'), '投递正文超 600 字截断');
});

// ── gatherEvidence ──

test('gatherEvidence：目标已存在且早于会话开始 → 报既有文件事实', () => {
  const startedAt = Date.now();
  const probe = {
    exists: () => true,
    mtimeMs: () => startedAt - 60_000,
    gitQuery: () => undefined,
    readText: () => undefined,
  };
  const { facts } = gatherEvidence({
    command: '',
    args: { file_path: 'src/a.ts' },
    workspaceRoot: '/w',
    sessionStartedAt: startedAt,
    home: '/home/u',
    probe,
  });
  assert.equal(facts.length, 1);
  assert.ok(facts[0].includes('在本次会话开始前就存在'), `实际：${facts[0]}`);
});

test('gatherEvidence：目标不存在 → 报新建事实', () => {
  const probe = {
    exists: () => false,
    mtimeMs: () => undefined,
    gitQuery: () => undefined,
    readText: () => undefined,
  };
  const { facts } = gatherEvidence({
    command: '',
    args: { file_path: 'src/new.ts' },
    workspaceRoot: '/w',
    sessionStartedAt: Date.now(),
    home: '/home/u',
    probe,
  });
  assert.equal(facts.length, 1);
  assert.ok(facts[0].includes('目前不存在'), `实际：${facts[0]}`);
});

test('gatherEvidence：git discard 命令下工作区脏与干净两种事实', () => {
  const base = {
    command: 'git reset --hard',
    args: {},
    workspaceRoot: '/w',
    sessionStartedAt: Date.now(),
    home: '/home/u',
  };
  const dirty = gatherEvidence({
    ...base,
    probe: { exists: () => false, mtimeMs: () => undefined, gitQuery: () => ' M a\n M b\n', readText: () => undefined },
  });
  assert.ok(dirty.facts.some((f) => f.includes('有 2 处未提交改动')), `实际：${JSON.stringify(dirty.facts)}`);
  const clean = gatherEvidence({
    ...base,
    probe: { exists: () => false, mtimeMs: () => undefined, gitQuery: () => '', readText: () => undefined },
  });
  assert.ok(clean.facts.some((f) => f.includes('没有未提交改动')), `实际：${JSON.stringify(clean.facts)}`);
});

// ── rules.mjs ──

test('rules：HARD_RULES 非空且每条 severity 为 hard、id 与 blocks 齐全', () => {
  assert.ok(HARD_RULES.length > 0);
  for (const rule of HARD_RULES) {
    assert.equal(rule.severity, 'hard');
    assert.ok(typeof rule.id === 'string' && rule.id !== '');
    assert.ok(typeof rule.blocks === 'string' && rule.blocks !== '');
  }
});

test('rules：ruleById 取得到 cred-exfil；全表 id 唯一', () => {
  assert.equal(ruleById('cred-exfil').severity, 'hard');
  assert.equal(ruleById('no-such-rule'), undefined);
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('rules：outside-worktree 是正表里的 hard 规则，ruleById 取得到', () => {
  const rule = ruleById('outside-worktree');
  assert.ok(rule, 'outside-worktree 应在 RULES 正表里');
  assert.equal(rule.severity, 'hard');
  assert.deepEqual(rule, OUTSIDE_WORKTREE); // 正表里的就是导出的那一份
  assert.ok(rule.blocks.includes('一律转人工'));
});

// ── nodeProbe ──

test('nodeProbe：exists 与 readText 对临时目录里的真实文件', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'probe.txt');
  fs.writeFileSync(file, '查过的事实');
  const probe = nodeProbe();
  assert.equal(probe.exists(dir), true);
  assert.equal(probe.exists(path.join(dir, 'no-such-file')), false);
  assert.equal(probe.readText(file, 100), '查过的事实');
  assert.equal(probe.readText(file, 2), '查过'); // maxBytes 截断
});

test('nodeProbe：git 白名单外的子命令挡下返回 undefined（push 不放行）', () => {
  // 白名单在起子进程之前挡，不起进程、不碰网络
  assert.equal(nodeProbe().gitQuery(makeTempDir(), ['push']), undefined);
  assert.equal(nodeProbe().gitQuery(makeTempDir(), ['remote', '-v']), undefined);
  assert.equal(nodeProbe().gitQuery(makeTempDir(), []), undefined);
});
