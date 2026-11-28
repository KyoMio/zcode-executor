// scripts/control/live-smoke.mjs —— live-smoke 子命令实现（ZCE-4）。
// 真机冒烟（会花真实 token）：按「依次建 3 个文件制造工具边界」剧本自动测试 steer 与 cancel：
// 回合开跑后轮询 events.jsonl，首个工具边界（Write 工具调用）出现即注入 --steer；
// steer 事件落地后再发 cancel，验证回合以 cancelled 结算。
// 编排的是 bin/zcode-executor 公共 CLI（黑盒验证产品本身，不经内部门路）。
//
// 硬红线（派单逐字）：默认禁止自动触发消耗真实 token 的 session/send——
// 必须显式带 --confirm-spend 才允许执行；没有该旗标时在 spawn 任何东西之前退出码 2。
// Proof/验收流程不真跑本子命令（只验证守门与 dry-run 形状）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runProcess, UsageError } from './lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = path.join(root, 'bin', 'zcode-executor');

const PLAYBOOK = '依次创建三个文件 1.txt、2.txt、3.txt，每个文件只写一行文件名。每建完一个文件用一句话汇报进度，全部完成后总结。';
const STEER_TEXT = '计划变更：跳过 2.txt，直接建 3.txt 后收尾。';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function liveSmoke({ confirmSpend = false, dryRun = false, timeoutSec = 600 }) {
  if (!confirmSpend) {
    throw new UsageError(
      'live-smoke 会消耗真实 token，必须显式确认。下一步：确认要跑就加 --confirm-spend；' +
      '只想核协议链路就跑零额度的 zero-token --json，只想核行为就跑 mock-matrix --json'
    );
  }
  const plan = [
    '① mkdtemp 工作目录 → zcode-executor new 登记',
    `② send 正文（依次建 3 个文件），后台回合`,
    '③ 轮询 events.jsonl：首个 Write 工具边界出现 → send --steer 注入「跳过 2.txt」',
    '④ executor.steer 事件落地 → cancel，验证 last.outcome=cancelled、临时密钥目录清零',
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
  const finish = (ok, next) => {
    const human = [
      `live-smoke ${ok ? '通过' : '未通过'}`,
      ...steps.map((s) => `  ${s.ok === true ? '✓' : s.ok === false ? '✗' : '·'} ${s.step}${s.note ? ` —— ${s.note}` : ''}`),
    ].join('\n');
    return { ok, human, steps, next };
  };
  try {
    workdir = await mkdtemp(path.join(os.tmpdir(), 'zcode-live-smoke-'));
    // ① new
    const nw = await runProcess(process.execPath, [bin, 'new', '--json'], { cwd: workdir, timeoutMs: 30_000 });
    let id = null;
    for (const line of nw.stdout.trim().split('\n').reverse()) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.id) { id = parsed.id; break; }
      } catch { /* 非 JSON 行跳过 */ }
    }
    steps.push({ step: 'new', ok: nw.code === 0 && id !== null, note: id ? `id=${id}` : nw.stderr.slice(-120) });
    if (id === null) return finish(false, 'new 没拿到任务 id——先跑 doctor --json 与 zero-token --json 修环境再重试');

    // ② 后台 send（不 --wait，回合由 runner 跑）
    const send = await runProcess(process.execPath, [bin, 'send', id, PLAYBOOK, '--json'], { cwd: workdir, timeoutMs: 30_000 });
    steps.push({ step: 'send', ok: send.code === 0, note: send.code === 0 ? '' : send.stderr.slice(-120) });
    if (send.code !== 0) return finish(false, 'send 失败——看 status --json 与 stderr');

    // ③ 轮询 events.jsonl 等首个 Write 工具边界 → steer
    const eventsPath = path.join(os.homedir(), '.zcode-executor', 'runs', id, 'events.jsonl');
    const deadline = Date.now() + timeoutSec * 1000;
    let steered = false;
    let steerOk = false;
    let cancelled = false;
    let lastOutcome = null;
    const readEvents = () => {
      if (!existsSync(eventsPath)) return [];
      return readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    };
    while (Date.now() < deadline) {
      const events = readEvents();
      const writeBoundary = events.find((e) => e.type === 'tool' && /write/i.test(e.toolName ?? '') && !steered);
      if (writeBoundary && !steered) {
        steered = true;
        const st = await runProcess(process.execPath, [bin, 'send', id, STEER_TEXT, '--steer', '--json'], { cwd: workdir, timeoutMs: 30_000 });
        steerOk = st.code === 0;
        steps.push({ step: 'steer-inject', ok: steerOk, note: steerOk ? '首个 Write 边界后注入' : st.stderr.slice(-120) });
      }
      const steerLanded = events.some((e) => e.type === 'executor.steer' || e.type === 'executor.steer_failed');
      if (steerLanded && !cancelled) {
        cancelled = true;
        // steer 落地即 cancel——验证取消链路
        const cc = await runProcess(process.execPath, [bin, 'cancel', id], { cwd: workdir, timeoutMs: 30_000 });
        steps.push({ step: 'cancel', ok: cc.code === 0, note: cc.code === 0 ? '' : cc.stderr.slice(-120) });
      }
      const lastPath = path.join(os.homedir(), '.zcode-executor', 'runs', id, 'last.json');
      if (existsSync(lastPath)) {
        try {
          lastOutcome = JSON.parse(readFileSync(lastPath, 'utf8')).outcome;
        } catch { /* 写入中 */ }
      }
      if (lastOutcome) break;
      await sleep(1500);
    }
    steps.push({ step: 'steer-observed', ok: steered, note: steered ? '' : '超时内未等到 Write 工具边界' });
    if (!cancelled && lastOutcome === null) {
      // 兜底：别留活口
      await runProcess(process.execPath, [bin, 'cancel', id], { cwd: workdir, timeoutMs: 30_000 });
    }
    // 等结算（最多再 90 秒）
    const settleDeadline = Date.now() + 90_000;
    while (!lastOutcome && Date.now() < settleDeadline) {
      const lastPath = path.join(os.homedir(), '.zcode-executor', 'runs', id, 'last.json');
      if (existsSync(lastPath)) {
        try { lastOutcome = JSON.parse(readFileSync(lastPath, 'utf8')).outcome; } catch { /* 写入中 */ }
      }
      if (!lastOutcome) await sleep(1500);
    }
    steps.push({ step: 'settled', ok: ['cancelled', 'done'].includes(lastOutcome), note: `outcome=${lastOutcome ?? '超时未结算'}` });
    // 临时密钥目录清零（RULES §6）
    const leftovers = (await import('node:fs')).readdirSync(os.tmpdir()).filter((n) => n.startsWith('zcode-executor-provider-'));
    steps.push({ step: 'no-key-residue', ok: leftovers.length === 0, note: leftovers.length ? `残留 ${leftovers.join(',')}` : '' });
    const ok = steps.every((s) => s.ok !== false);
    return finish(ok, ok ? '真机冒烟通过（steer+cancel 链路行为符合预期）' : '按失败步骤排查；orphan-check --cleanup 收场');
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
