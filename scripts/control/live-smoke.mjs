// scripts/control/live-smoke.mjs —— live-smoke 子命令实现（ZCE-4，R1-2 重写）。
// 真机冒烟（会花真实 token）：按「依次建 3 个文件制造工具边界」剧本自动测试 steer 与 cancel。
// 编排的是 bin/zcode-executor 公共 CLI（黑盒验证产品本身，不经内部门路）。
//
// 硬红线（派单逐字）：默认禁止自动触发消耗真实 token 的 session/send——
// 必须显式带 --confirm-spend 才允许执行；没有该旗标时在 spawn 任何东西之前退出码 2。
// Proof/验收流程不真跑本子命令（只验证守门与 dry-run 形状）。
//
// R1-2 修复点（御史判决逐字）：
//  ① new 必须显式传 --cwd（缺它退出 1，此前第一步就起不来）——临时工作目录建在
//    白名单根（~/.zcode-executor/worktrees/）下，否则 new 本身就会被拒；
//  ② 事件形状按生产实际：tool.updated 事件的 payload.kind 为 started/scheduled 且
//    payload.toolName 为 Write 才算工具边界（旧代码找 type:'tool' 根本不存在的事件）；
//  ③ 通过条件钉死：必须看到 executor.steer_accepted 且 last.outcome=cancelled 才报通过——
//    steer_failed 后回合自己跑完不算成功（此前 done 也被算过）；
//  ④ runs 目录按配置的数据目录解析（resolveHome 同一逻辑：ZCODE_EXECUTOR_HOME 优先），
//    不再硬编码 ~/.zcode-executor。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { runProcess, UsageError } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = path.join(root, 'bin', 'zcode-executor');

const PLAYBOOK = '依次创建三个文件 1.txt、2.txt、3.txt，每个文件只写一行文件名。每建完一个文件用一句话汇报进度，全部完成后总结。';
const STEER_TEXT = '计划变更：跳过 2.txt，直接建 3.txt 后收尾。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 与 lib/config.mjs resolveHome 同一逻辑（scripts/control 不 import 根 lib/——它是验证端外壳）。 */
function executorHome() {
  const raw = process.env.ZCODE_EXECUTOR_HOME || '~/.zcode-executor';
  return path.resolve(raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
}

/**
 * 选冒烟工作根（R2-3）：读生效配置（与 bin 同一份 config.json 的读取语义——
 * 文件不存在/坏 JSON 按空配置走），allowedRoots 缺省或为空时给默认 home/worktrees；
 * 按序选第一个存在且可写的根。都不行的返回 null（调用方报指路式错误）。
 */
async function pickWorkRoot(home) {
  let roots = [];
  try {
    const cfg = JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'));
    if (Array.isArray(cfg.allowedRoots)) roots = cfg.allowedRoots.filter((r) => typeof r === 'string');
  } catch { /* 无配置/坏配置：空 roots 走默认 */ }
  const usingDefault = roots.length === 0;
  if (usingDefault) roots = [path.join(home, 'worktrees')];
  const { access } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  for (const root of roots) {
    const expanded = root.startsWith('~/') ? path.join(os.homedir(), root.slice(2)) : root;
    try {
      // 默认根可以建（那是执行器自己的目录）；用户配置的根不主动创建——
      // new 的 resolveWhitelist 同样跳过不存在的根，两边语义一致
      if (usingDefault) await mkdir(expanded, { recursive: true });
      await access(expanded, constants.W_OK);
      return expanded;
    } catch { /* 不存在/不可写：试下一个 */ }
  }
  return null;
}

export async function liveSmoke({ confirmSpend = false, dryRun = false, timeoutSec = 600 }) {
  if (!confirmSpend) {
    throw new UsageError(
      'live-smoke 会消耗真实 token，必须显式确认。下一步：确认要跑就加 --confirm-spend；' +
      '只想核协议链路就跑零额度的 zero-token --json，只想核行为就跑 mock-matrix --json'
    );
  }
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1) {
    throw new UsageError(`--timeout 必须是 >= 1 的整数秒，收到：${timeoutSec}。用法示例：--timeout 600`);
  }
  const plan = [
    '① 在白名单根下建临时工作目录 → zcode-executor new --cwd 显式登记',
    '② send 正文（依次建 3 个文件），后台回合',
    '③ 轮询 events.jsonl：tool.updated（payload.kind=started/scheduled、toolName=Write）出现 → send --steer',
    '④ 必须见到 executor.steer_accepted → cancel；必须 last.outcome=cancelled 才算通过',
  ];
  if (dryRun) {
    return {
      ok: true,
      human: `live-smoke dry-run（不会真跑）：\n${plan.map((p) => `  ${p}`).join('\n')}`,
      dryRun: true,
      plan,
      next: '确认后去掉 --dry-run 实跑（保留 --confirm-spend）',
    };
  }

  const steps = [];
  let workdir = null;
  const home = executorHome();
  const finish = (ok, next) => {
    const human = [
      `live-smoke ${ok ? '通过' : '未通过'}`,
      ...steps.map((s) => `  ${s.ok === true ? '✓' : s.ok === false ? '✗' : '·'} ${s.step}${s.note ? ` —— ${s.note}` : ''}`),
    ].join('\n');
    return { ok, human, steps, next };
  };
  try {
    // ① 工作目录必须在白名单根下（new 的硬校验）。R2-3：根从实际生效的配置选——
    // 用户自定义 allowedRoots 时 home/worktrees 不在白名单里，建单必被拒。
    // 按序取第一个存在的可写根；配置缺失/为空时回落默认根（home/worktrees，不存在则建）
    const wtRoot = await pickWorkRoot(home);
    if (wtRoot === null) {
      return finish(false, '配置的 allowedRoots 里没有一个存在且可写的根——在 config.json 里配一个可写目录，或删掉 allowedRoots 用默认（~/.zcode-executor/worktrees）');
    }
    workdir = await mkdtemp(path.join(wtRoot, 'live-smoke-'));
    const nw = await runProcess(process.execPath, [bin, 'new', '--cwd', workdir, '--title', 'live-smoke', '--json'], { cwd: workdir, timeoutMs: 30_000 });
    let id = null;
    for (const line of nw.stdout.trim().split('\n').reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.id) { id = parsed.id; break; }
      } catch { /* 非 JSON 行跳过 */ }
    }
    steps.push({ step: 'new', ok: nw.code === 0 && id !== null, note: id ? `id=${id}` : (nw.stderr.slice(-150) || nw.stdout.slice(-150)) });
    if (id === null) return finish(false, 'new 没拿到任务 id——先跑 doctor --json 与 zero-token --json 修环境再重试');

    // ② 后台 send
    const send = await runProcess(process.execPath, [bin, 'send', id, PLAYBOOK, '--json'], { cwd: workdir, timeoutMs: 30_000 });
    steps.push({ step: 'send', ok: send.code === 0, note: send.code === 0 ? '' : send.stderr.slice(-150) });
    if (send.code !== 0) return finish(false, 'send 失败——看 status --json 与 stderr');

    // ③ 轮询 events.jsonl（按生产事件形状）：tool.updated 且 payload.kind 为 started/scheduled、
    //    toolName 为 Write 才是工具边界；见到即 steer
    const runDir = path.join(home, 'runs', id);
    const eventsPath = path.join(runDir, 'events.jsonl');
    const lastPath = path.join(runDir, 'last.json');
    const deadline = Date.now() + timeoutSec * 1000;
    let steered = false;
    let steerAccepted = false;
    let cancelled = false;
    let lastOutcome = null;
    const readEvents = () => {
      if (!existsSync(eventsPath)) return [];
      return readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    };
    const readOutcome = () => {
      if (!existsSync(lastPath)) return null;
      try { return JSON.parse(readFileSync(lastPath, 'utf8')).outcome ?? null; } catch { return null; }
    };
    while (Date.now() < deadline) {
      const events = readEvents();
      const writeBoundary = events.find((e) =>
        e.type === 'tool.updated' &&
        ['started', 'scheduled'].includes(e.payload?.kind) &&
        e.payload?.toolName === 'Write');
      if (writeBoundary && !steered) {
        steered = true;
        const st = await runProcess(process.execPath, [bin, 'send', id, STEER_TEXT, '--steer', '--json'], { cwd: workdir, timeoutMs: 30_000 });
        steps.push({ step: 'steer-inject', ok: st.code === 0, note: st.code === 0 ? '首个 Write 边界后注入' : st.stderr.slice(-150) });
      }
      if (!steerAccepted && events.some((e) => e.type === 'executor.steer_accepted')) {
        steerAccepted = true;
      }
      // steer 落地才 cancel——验证的是「插话生效后再叫停」的完整链路
      if (steerAccepted && !cancelled) {
        cancelled = true;
        const cc = await runProcess(process.execPath, [bin, 'cancel', id], { cwd: workdir, timeoutMs: 30_000 });
        steps.push({ step: 'cancel', ok: cc.code === 0, note: cc.code === 0 ? '' : cc.stderr.slice(-150) });
      }
      lastOutcome = readOutcome();
      if (lastOutcome) break;
      await sleep(1500);
    }
    steps.push({ step: 'steer-observed', ok: steered && steerAccepted, note: steered ? (steerAccepted ? 'executor.steer_accepted 已见到' : 'steer 被拒或未生效——不满足通过条件') : '超时内未等到 Write 工具边界' });
    if (!cancelled) {
      // 兜底：别留活口（无论 steer 成没成，回合不能留着烧额度）
      await runProcess(process.execPath, [bin, 'cancel', id], { cwd: workdir, timeoutMs: 30_000 });
    }
    // 等结算（最多再 90 秒）
    const settleDeadline = Date.now() + 90_000;
    while (!lastOutcome && Date.now() < settleDeadline) {
      lastOutcome = readOutcome();
      if (!lastOutcome) await sleep(1500);
    }
    // R1-2③：通过条件钉死——cancel 场景必须 cancelled 结算；done 说明 cancel 没生效或发太晚
    steps.push({ step: 'settled', ok: lastOutcome === 'cancelled', note: `outcome=${lastOutcome ?? '超时未结算'}${lastOutcome === 'done' ? '（cancel 未生效，不算通过）' : ''}` });
    // 等 detached runner 完成 session.close() + providerFile.dispose() + 删 lock 再查密钥目录残留
    const lockPath = path.join(runDir, 'lock');
    const lockDeadline = Date.now() + 15_000;
    while (existsSync(lockPath) && Date.now() < lockDeadline) {
      await sleep(200);
    }
    // 临时密钥目录清零（RULES §6）
    const leftovers = readdirSync(os.tmpdir()).filter((n) => n.startsWith('zcode-executor-provider-'));
    steps.push({ step: 'no-key-residue', ok: leftovers.length === 0, note: leftovers.length ? `残留 ${leftovers.join(',')}` : '' });
    const ok = steps.every((s) => s.ok !== false);
    return finish(ok, ok ? '真机冒烟通过（steer 生效 + cancel 结算链路符合预期）' : '按失败步骤排查；orphan-check --cleanup 收场（注意存疑条目需人工确认）');
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
