// scripts/control/orphan-check.mjs —— orphan-check 子命令实现（ZCE-4）。
// 扫描两类残留并报告/清理：
//  ① 系统里还活着的 zcode 系孤儿进程（node ... zcode.cjs app-server / zcode-executor _runner）；
//  ② os.tmpdir() 下残留的 zcode-executor-provider-* 临时密钥目录（RULES §6：收场即删，残留即泄漏）。
// --cleanup 真删（进程 SIGTERM→SIGKILL、目录 rm -rf）；--dry-run 只报告不动手（默认就是 dry-run 语义，
// 不带 --cleanup 时绝不写——安全降级方向）。
// 活性甄别：runner 进程参照登记簿 pid——登记在册且运行中的不算孤儿；zcode.cjs app-server
// 凡是父进程已死的（ppid 1 或父 pid 不存在）才算孤儿，避免误杀正在服务的会话。
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runProcess } from './lib.mjs';

function listProcesses() {
  // ps 输出: pid ppid command（macOS/Linux 通用）
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  return out.split('\n').map((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] } : null;
  }).filter(Boolean);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function orphanCheck({ cleanup = false, dryRun = false }) {
  const effectiveCleanup = cleanup && !dryRun;
  const findings = { processes: [], tempDirs: [] };

  // —— ① 进程扫描 ——
  const procs = listProcesses();
  const alivePids = new Set(procs.map((p) => p.pid));
  for (const p of procs) {
    const isZcodeServer = /zcode\.cjs/.test(p.command) && /app-server|serve/.test(p.command);
    const isRunner = /zcode-executor/.test(p.command) && /_runner/.test(p.command);
    if (!isZcodeServer && !isRunner) continue;
    // 父进程活着（且不是 launchd 的 ppid 1 重领养——detached 进程 ppid 天然是 1，
    // 所以 ppid 1 不算孤儿证据；孤儿判据改为：非登记 runner 或 zcode server 无父进程存活）
    const parentAlive = p.ppid > 1 && alivePids.has(p.ppid);
    if (parentAlive) continue;
    findings.processes.push({ pid: p.pid, ppid: p.ppid, kind: isRunner ? 'executor-runner' : 'zcode-app-server', command: p.command.slice(0, 160), orphan: true });
  }

  // —— ② 临时密钥目录扫描 ——
  const tmp = os.tmpdir();
  let entries = [];
  try {
    entries = readdirSync(tmp);
  } catch {
    // tmpdir 读不到视为无残留
  }
  for (const name of entries) {
    if (!name.startsWith('zcode-executor-provider-') && !name.startsWith('zcode-probe-')) continue;
    const full = path.join(tmp, name);
    let st = null;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const ageMinutes = Math.round((Date.now() - st.mtimeMs) / 60_000);
    // 正在使用的目录（10 分钟内新建）不算残留——正常回合可能正在跑
    const stale = ageMinutes >= 10;
    const hasKey = existsSync(path.join(full, 'provider.json'));
    findings.tempDirs.push({ path: full, ageMinutes, stale, containsProviderKey: hasKey });
  }

  // —— 清理 ——
  const actions = [];
  if (effectiveCleanup) {
    for (const p of findings.processes) {
      if (!p.orphan) continue;
      const r = await runProcess('kill', ['-TERM', String(p.pid)], { timeoutMs: 5_000 });
      actions.push({ target: `pid ${p.pid}`, action: 'SIGTERM', ok: r.code === 0 });
    }
    for (const d of findings.tempDirs.filter((x) => x.stale)) {
      try {
        await rm(d.path, { recursive: true, force: true });
        actions.push({ target: d.path, action: 'rm -rf', ok: true });
      } catch (err) {
        actions.push({ target: d.path, action: 'rm -rf', ok: false, error: err.message });
      }
    }
  }

  const orphanCount = findings.processes.filter((p) => p.orphan).length;
  const staleCount = findings.tempDirs.filter((d) => d.stale).length;
  const keyLeaks = findings.tempDirs.filter((d) => d.stale && d.containsProviderKey).length;
  const found = orphanCount + staleCount > 0;
  const ok = effectiveCleanup ? actions.every((a) => a.ok) : true;
  const human = [
    `orphan-check ${effectiveCleanup ? '（cleanup 执行）' : dryRun || !cleanup ? '（只报告）' : ''}`,
    `  孤儿进程 ${orphanCount} 个，临时密钥目录残留 ${staleCount} 个（其中含密钥 ${keyLeaks} 个）`,
    ...findings.processes.filter((p) => p.orphan).map((p) => `  pid ${p.pid} [${p.kind}] ${p.command.slice(0, 100)}`),
    ...findings.tempDirs.filter((d) => d.stale).map((d) => `  ${d.path}（${d.ageMinutes} 分钟前${d.containsProviderKey ? '，含密钥文件!' : ''}）`),
    ...(effectiveCleanup ? actions.map((a) => `  ${a.ok ? '✓' : '✗'} ${a.action} ${a.target}`) : []),
  ].join('\n');
  return {
    ok,
    human,
    found,
    findings,
    actions,
    cleaned: effectiveCleanup,
    next: found && !effectiveCleanup
      ? '有残留——确认无正在跑的回合后执行 node scripts/control-executor.mjs orphan-check --cleanup（先加 --dry-run 复核清单）'
      : effectiveCleanup
        ? '清理完毕——重跑一次 orphan-check --json 确认归零'
        : '无残留',
  };
}
