// 本文件负责：真机投递脚本（会花额度，由 Claude 跑）——读 provider 表、拉起 app-server、
// 推表、create 或 resume、attach 会话、投递一条正文、等回合结算并打印结果。
// 不负责：闸门的红线与模型审批（这里的人肉 y/n 只是通道）、批量任务、pending 之外的落盘。
// 用法：
//   node scripts/real-send.mjs --yes [--cwd <目录>] [--text "<投递正文>"] [--resume <sess_>]
//        [--provider <providerId>] [--model <modelId>]
//        [--on-permission allow|deny] [--on-question "<文字>"]
// create 默认带 runtimeModel（D11：不带则回合因 provider 无 key 失败）：provider 按 D6 优先级选
// （--provider 指定则必须命中），模型取该 provider 里 id 含 flash/lite/mini/air 的第一个、没有就第一个
// （--model 指定则必须存在）；--resume 不带 runtimeModel（verified）。
// RULES §9：跑前先提示会花额度，没有 --yes 直接退出码 2，不 spawn 任何东西。
// 审批/提问的作答顺序：给了 --on-permission / --on-question 就用参数；没给且 stdin 是终端
// 就交互问（空答案审批按 deny、提问抛错）；两者都没有 → 保留 pending.json、打印
// {"outcome":"blocked",…}、退出码 5（T1.2b 第 2 条）。
// stdout 每步一行 JSON，全部过 redactSecrets + scrubValues（apiKey 不出现在任何输出里）。
import { mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { AppServerClient } from '../lib/appserver.mjs';
import { attachSession } from '../lib/session.mjs';
import { createPendingGate } from '../lib/pending.mjs';
import { readProviderRegistry, pickProvider, buildRuntimeModel } from '../lib/providers.mjs';
import { ExecutorError } from '../lib/errors.mjs';
import { redactSecrets, scrubValues } from '../lib/scrub.mjs';

const EXIT_USAGE = 2;
const EXIT_BLOCKED = 5;
const VALUE_FLAGS = ['--cwd', '--text', '--resume', '--on-permission', '--on-question', '--provider', '--model'];
// SPEC「模型等级」的 fast 档关键词，不分大小写；real-send 默认模型从这些里挑（任务单 T1.3）
const FAST_MODEL_WORDS = ['flash', 'lite', 'mini', 'air'];

// --provider 给了就必须命中（显式指定不能静默回落到优先级规则），没给走 D6 优先级选
function selectProvider(registry, wanted) {
  if (wanted === undefined) return pickProvider(registry);
  const hit = registry.providers.find((p) => p.providerId === wanted);
  if (!hit) {
    console.error(
      `real-send: registry 里没有 provider ${wanted}。现有的：${registry.providers.map((p) => p.providerId).join('、') || '（空）'}`,
    );
    process.exit(EXIT_USAGE);
  }
  return hit;
}

// 默认模型：id 含 flash/lite/mini/air 的第一个，没有就第一个（registry 过滤后 models 不会为空）
function defaultModelId(provider) {
  const hit = provider.models.find((m) => FAST_MODEL_WORDS.some((w) => m.modelId.toLowerCase().includes(w)));
  return hit?.modelId ?? provider.models[0]?.modelId;
}

function parseArgs(argv) {
  const args = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes') {
      args.yes = true;
      continue;
    }
    if (VALUE_FLAGS.includes(a)) {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`real-send: ${a} 后缺一个值`);
        process.exit(EXIT_USAGE);
      }
      // --on-permission → onPermission（驼峰键）
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = value;
      continue;
    }
    console.error(`real-send: 不认识的参数 ${a}`);
    process.exit(EXIT_USAGE);
  }
  // --resume 靠目录定位会话归属，不给 cwd 就不知道要接哪条工作区的会话
  if (args.resume && !args.cwd) {
    console.error('real-send: --resume 需要同时给 --cwd');
    process.exit(EXIT_USAGE);
  }
  if (args.onPermission !== undefined && !['allow', 'deny'].includes(args.onPermission)) {
    console.error('real-send: --on-permission 只能是 allow 或 deny');
    process.exit(EXIT_USAGE);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.yes) {
    // RULES §9：会花钱的脚本，没有 --yes 不读配置、不 spawn，直接拒
    console.error('real-send: 这次会花额度（真实投递给 zcode，消耗编码计划）。确认要跑请加 --yes。');
    process.exit(EXIT_USAGE);
  }

  let secrets = []; // registry 里的 apiKey 值：抹 stderr 转发和输出用
  const emit = (obj) => console.log(scrubValues(JSON.stringify(redactSecrets(obj)), secrets));
  let client = null;
  let gate = null;
  let sessionId = null;
  let pendingPath = null;
  let exitCodeSet = false;
  // 审批/提问无法作答或作答出错时，打断 send 的等待，让 main 统一收尾（T1.2b 第 1 条）
  let abortTrigger = null;
  const aborted = new Promise((resolve) => {
    abortTrigger = (kind, error) => resolve({ kind, error });
  });

  try {
    const registry = readProviderRegistry(process.env.ZCODE_CONFIG_PATH);
    secrets = registry.providers.map((p) => p.apiKey?.value).filter(Boolean);

    // runtimeModel（D11）在任何 spawn 之前定好：--provider/--model 给错了直接退 2，不留临时目录、不起子进程
    const provider = selectProvider(registry, args.provider);
    const runtimeModel = buildRuntimeModel(provider, args.model ?? defaultModelId(provider));

    let cwd = args.cwd;
    if (!cwd) {
      cwd = await mkdtemp(path.join(os.tmpdir(), 'zcode-real-send-'));
      try {
        execFileSync('git', ['init', '--quiet'], { cwd, stdio: 'ignore' });
      } catch (err) {
        console.error(`real-send: git init 失败（${err.message}），继续用普通目录`);
      }
    }
    cwd = path.resolve(cwd);
    const workspace = { workspacePath: cwd, workspaceKey: cwd };
    const eventsPath = path.join(cwd, '.zcode-executor-events.jsonl');
    pendingPath = path.join(cwd, '.zcode-executor-pending.json');

    client = await AppServerClient.spawn({ cwd, secrets });
    emit({ step: 'spawn', ok: true, result: { pid: client.pid } });

    await client.request('workspace/updateProviderRegistry', { workspace, registry }, { timeoutMs: 20_000 });
    emit({
      step: 'updateProviderRegistry',
      ok: true,
      providers: registry.providers.length,
      providerIds: registry.providers.map((p) => p.providerId),
    });

    // 评审 T1.3b 第 2 条：这里必须用外层 sessionId，之前内层 let 遮蔽后 blocked 行永远是 null
    sessionId = args.resume;
    if (sessionId) {
      emit({ step: 'resume', ok: true, result: { sessionId } });
    } else {
      const created = await client.request(
        'session/create',
        // D11：create 必带 runtimeModel（model ref + provider 定义含内联 apiKey）
        { workspace, mode: 'build', persistence: 'immediate', titleGenerationEnabled: false, thoughtLevel: 'high', runtimeModel },
        { timeoutMs: 20_000 },
      );
      sessionId = created.session.sessionId;
      emit({ step: 'create', ok: true, result: { sessionId, model: created.settings?.model?.current } });
    }

    gate = createPendingGate({ pendingPath, onPending: (pending) => handlePending(pending) });
    const session = await attachSession({ client, sessionId, cwd, eventsPath, handlers: gate.handlers });
    emit({ step: 'attach', ok: true, result: { sessionId, eventsPath } });

    const text = args.text ?? '在当前目录新建 hello.txt，内容一行 hello，然后结束';
    const settled = await Promise.race([
      session.send(text).then((outcome) => ({ kind: 'outcome', outcome })),
      aborted.then(({ kind }) => ({ kind })),
    ]);

    if (settled.kind === 'blocked') {
      // 挂起无法作答：pending.json 原样保留交人工，进程按 blocked 收场（关子进程）
      emit({ outcome: 'blocked', pendingPath, sessionId });
      process.exitCode = EXIT_BLOCKED;
      exitCodeSet = true;
    } else {
      const outcome = settled.outcome;
      emit({ step: 'outcome', ok: true, sessionId, eventsPath, ...outcome });
      // RULES 退出码表：done 0；起不来 1；timeout 3；failed 4；blocked 5
      process.exitCode = { done: 0, timeout: 3, failed: 4, exited: 1, blocked: EXIT_BLOCKED }[outcome.outcome] ?? 1;
      exitCodeSet = true;
      await session.close();
    }
  } catch (err) {
    // T1.2b 第 6 条：错误信息可能带密钥，过一遍 scrubValues
    console.error(`real-send: ${scrubValues(String(err?.message ?? err), secrets)}`);
    if (!exitCodeSet) process.exitCode = err?.exitCode ?? 1;
  } finally {
    // T1.2b 第 3 条：出错路径也要收场，不留孤儿 app-server；close 的异常不覆盖已设好的退出码
    try {
      await client?.close({ timeoutMs: 5000 });
    } catch (err) {
      console.error(`real-send: 收场失败：${scrubValues(String(err?.message ?? err), secrets)}`);
    }
  }

  // ---------- 挂起作答 ----------

  async function handlePending(pending) {
    try {
      if (pending.kind === 'permission') {
        // T1.2b 第 6 条：input 可能回显敏感内容，打印前过 scrub
        const input = scrubValues(JSON.stringify(pending.input ?? {}), secrets);
        console.error(`real-send: [挂起·审批] ${pending.toolName} ${input} —— ${pending.reason ?? '无理由'}`);
        const response = await decidePermission();
        if (response === null) return; // 已走 blocked 收场
        gate.answer(response);
        return;
      }
      console.error('real-send: [挂起·提问]');
      const values = await decideQuestionValues(pending);
      if (values === null) return;
      gate.answer({ values });
    } catch (err) {
      abortTrigger('error', err); // 作答出错：打断 send，统一走 main 的 catch 打印并收场
    }
  }

  async function decidePermission() {
    if (args.onPermission !== undefined) {
      return { decision: args.onPermission }; // 预给答案优先（非终端环境）
    }
    if (process.stdin.isTTY) {
      const line = (await ask('real-send: 允许这次操作？(y=允许 / n=拒绝) > ')).trim();
      if (!line) return { decision: 'deny' }; // 空答案按 deny
      return line.toLowerCase() === 'y' ? { decision: 'allow' } : { decision: 'deny' };
    }
    blockedExit(); // 没参数也不是终端：作答不了，保留 pending 交人工
    return null;
  }

  async function decideQuestionValues(pending) {
    if (args.onQuestion !== undefined) {
      // 预给答案：同一句文字按顺序套到每个问题上
      return (pending.questions ?? []).map(() => args.onQuestion);
    }
    if (process.stdin.isTTY) {
      const values = [];
      for (const q of pending.questions ?? []) {
        const choices = (q.options ?? []).map((o, i) => `${i + 1}=${o.label ?? o.value}`).join(' ');
        const hint = choices ? `（${choices}${q.multiSelect ? '，多选逗号分隔' : ''}）` : '（直接输文字）';
        const line = (await ask(`real-send: ${q.question}${hint} > `)).trim();
        if (!line) throw new ExecutorError(`提问「${q.question ?? ''}」答案为空，拒绝作答`);
        values.push(q.multiSelect && line.includes(',') ? line.split(',').map((x) => x.trim()) : line);
      }
      return values;
    }
    blockedExit();
    return null;
  }

  function blockedExit() {
    process.exitCode = EXIT_BLOCKED;
    exitCodeSet = true;
    emit({ outcome: 'blocked', pendingPath, sessionId });
    abortTrigger('blocked');
  }

  function ask(prompt) {
    return new Promise((resolve, reject) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true, prompt });
      rl.on('close', () => resolve('')); // EOF 兜底：当作空答案
      rl.on('error', reject);
      rl.question(prompt, (line) => {
        rl.close();
        resolve(line);
      });
    });
  }
}

await main();
