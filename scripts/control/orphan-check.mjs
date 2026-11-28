// scripts/control/orphan-check.mjs —— orphan-check 子命令实现（ZCE-4，R1-1 重写）。
// 扫描两类残留并报告/清理：
//  ① zcode 系进程（node ... zcode.cjs app-server / zcode-executor _runner）；
//  ② os.tmpdir() 下的 zcode-executor-provider-* / zcode-probe-* 临时密钥目录。
//
// R1-1 安全模型（御史判决逐字执行）：
//  - detached runner/服务进程的 PPID 天然是 1，**PPID 不能作为孤儿证据**（此前因此把
//    正常运行的回合判进 SIGTERM 清单——护栏变成杀业务的刀）。
//  - 归属判定三分：owned（登记簿/锁文件/目录所有者能证明有主）/orphan（能证明无主）/
//    unknown（证明不了的）。**只有 orphan 进清理清单，unknown 与 owned 只报告**。
//  - 清理前逐项再核一次（操作时的二次核对）：进程身份按 pid+命令行重验（防 PID 复用误杀），
//    目录重验仍在 tmpdir、前缀匹配、且无活进程引用。
//  - 默认只报告；--cleanup 才动手；--dry-run 永远压过 --cleanup。
import { readdirSync, statSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runProcess } from './lib.mjs';

function listProcesses() {
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

/** 登记簿里所有会话的锁文件 pid 集合：{ pid → sessionId }。锁是 runner 所有权的正式凭证。 */
function registeredLockPids(home) {
  const owned = new Map();
  try {
    const runsDir = path.join(home, 'runs');
    for (const entry of readdirSync(runsDir)) {
      try {
        const lock = JSON.parse(readFileSync(path.join(runsDir, entry, 'lock'), 'utf8'));
        if (Number.isInteger(lock?.pid)) owned.set(lock.pid, entry);
      } catch { /* 无锁或坏锁：不算归属证据 */ }
    }
  } catch { /* runs 目录不存在 */ }
  return owned;
}

function executorHome() {
  const raw = process.env.ZCODE_EXECUTOR_HOME || '~/.zcode-executor';
  return path.resolve(raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
}

export async function orphanCheck({ cleanup = false, dryRun = false }) {
  const effectiveCleanup = cleanup && !dryRun;
  const home = executorHome();
  const findings = { processes: [], tempDirs: [] };

  // —— ① 进程扫描 + 归属甄别 ——
  const procs = listProcesses();
  const lockPids = registeredLockPids(home);
  const selfPid = process.pid;
  for (const p of procs) {
    if (p.pid === selfPid) continue;
    const isZcodeServer = /zcode\.cjs/.test(p.command) && /app-server|serve/.test(p.command);
    const isRunner = /zcode-executor/.test(p.command) && /_runner/.test(p.command);
    if (!isZcodeServer && !isRunner) continue;
    let ownership;
    let ownerDetail = null;
    if (isRunner) {
      // runner 归属看锁：锁里登记的 pid 与此进程一致 → owned；登记了别的活 pid → 此进程
      // 位置被顶替但仍可能是别会话的 runner——查所有锁都查不到才算能证明无主
      if (lockPids.get(p.pid) !== undefined) {
        ownership = 'owned';
        ownerDetail = `登记簿会话 ${lockPids.get(p.pid)} 的锁`;
      } else if ([...lockPids.keys()].some((lp) => lp !== p.pid && pidAlive(lp))) {
        ownership = 'unknown';
        ownerDetail = '登记簿里另有活着的 runner，无法证明此进程无主';
      } else {
        ownership = 'orphan';
        ownerDetail = '登记簿无任何锁指向此 pid，且无其他活 runner';
      }
    } else {
      // zcode app-server 的父进程是 spawn 它的 runner：父活着 → owned；
      // 父死了但登记簿里仍有活 runner（可能换了连接或 spawn 关系判断不到）→ unknown；
      // 父死且登记簿里一个活 runner 都没有 → orphan
      const parentAlive = p.ppid > 1 && pidAlive(p.ppid);
      if (parentAlive) {
        ownership = 'owned';
        ownerDetail = `父进程 ${p.ppid} 存活`;
      } else if ([...lockPids.keys()].some((lp) => pidAlive(lp))) {
        ownership = 'unknown';
        ownerDetail = '父进程不在但登记簿有活 runner，无法证明无主';
      } else {
        ownership = 'orphan';
        ownerDetail = '父进程不在且登记簿无活 runner';
      }
    }
    findings.processes.push({
      pid: p.pid, ppid: p.ppid, kind: isRunner ? 'executor-runner' : 'zcode-app-server',
      command: p.command.slice(0, 160), ownership, ownerDetail,
    });
  }

  // —— ② 临时密钥目录扫描 + 归属甄别 ——
  const tmp = os.tmpdir();
  let entries = [];
  try {
    entries = readdirSync(tmp);
  } catch { /* tmpdir 读不到视为无残留 */ }
  const livePids = new Set(procs.map((p) => p.pid));
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
    const hasKey = existsSync(path.join(full, 'provider.json'));
    // 归属甄别：10 分钟内动过 → 可能正被使用（owned-by-recency，只报告）；
    // 更老的无法证明与活会话相关，但「无法证明无主」的保守面是：只要有活 runner 存在，
    // 老目录也可能是它正在用的（个人文件生命周期 = 子进程一生）——有活 runner 时一律 unknown
    let ownership;
    let ownerDetail = null;
    if (ageMinutes < 10) {
      ownership = 'owned';
      ownerDetail = '10 分钟内有活动，可能正在使用';
    } else if ([...lockPids.keys()].some((lp) => pidAlive(lp))) {
      ownership = 'unknown';
      ownerDetail = '登记簿有活 runner，无法证明此目录无归属';
    } else {
      ownership = 'orphan';
      ownerDetail = '无活 runner，陈旧密钥目录可证明无主';
    }
    findings.tempDirs.push({ path: full, ageMinutes, containsProviderKey: hasKey, ownership, ownerDetail });
  }

  // —— 清理：只有 orphan 进清单，操作前逐项再核一次 ——
  const actions = [];
  if (effectiveCleanup) {
    for (const p of findings.processes.filter((x) => x.ownership === 'orphan')) {
      // 二次核对①：pid 仍是同一个进程（命令行一致，防 PID 复用误杀）
      let stillSame = false;
      try {
        const now = execFileSync('ps', ['-p', String(p.pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).trim();
        stillSame = now === p.command || (now.length > 0 && p.command.startsWith(now.slice(0, 80)));
      } catch {
        stillSame = false; // 进程已死：不用杀
      }
      if (!stillSame) {
        actions.push({ target: `pid ${p.pid}`, action: 'SIGTERM', ok: true, skipped: '操作时复核：进程已不在或身份变化，跳过' });
        continue;
      }
      // 二次核对②：身份核对期间没有被登记簿认领
      if (isRunnerKind(p) && registeredLockPids(home).has(p.pid)) {
        actions.push({ target: `pid ${p.pid}`, action: 'SIGTERM', ok: true, skipped: '操作时复核：已被登记簿认领，跳过' });
        continue;
      }
      const r = await runProcess('kill', ['-TERM', String(p.pid)], { timeoutMs: 5_000 });
      actions.push({ target: `pid ${p.pid}`, action: 'SIGTERM', ok: r.code === 0 });
    }
    for (const d of findings.tempDirs.filter((x) => x.ownership === 'orphan')) {
      // 二次核对：路径仍在 tmpdir 内（防符号链接置换）、前缀仍匹配、无活 runner 新生
      let real = null;
      try {
        real = realpathSync(d.path);
      } catch {
        actions.push({ target: d.path, action: 'rm -rf', ok: true, skipped: '目录已不在，跳过' });
        continue;
      }
      const realTmp = realpathSync(tmp);
      if (!real.startsWith(realTmp + path.sep) || !path.basename(real).match(/^zcode-(executor-provider|probe)-/)) {
        actions.push({ target: d.path, action: 'rm -rf', ok: false, error: '操作时复核：路径逃出 tmpdir 或前缀不符，拒绝删除' });
        continue;
      }
      if ([...registeredLockPids(home).keys()].some((lp) => pidAlive(lp))) {
        actions.push({ target: d.path, action: 'rm -rf', ok: true, skipped: '操作时复核：出现活 runner，无法证明无归属，跳过' });
        continue;
      }
      try {
        await rm(real, { recursive: true, force: true });
        actions.push({ target: d.path, action: 'rm -rf', ok: true });
      } catch (err) {
        actions.push({ target: d.path, action: 'rm -rf', ok: false, error: err.message });
      }
    }
  }

  const orphans = findings.processes.filter((p) => p.ownership === 'orphan');
  const unknownProcs = findings.processes.filter((p) => p.ownership === 'unknown');
  const orphanDirs = findings.tempDirs.filter((d) => d.ownership === 'orphan');
  const unknownDirs = findings.tempDirs.filter((d) => d.ownership === 'unknown');
  const keyLeaks = orphanDirs.filter((d) => d.containsProviderKey).length;
  const found = orphans.length + orphanDirs.length + unknownProcs.length + unknownDirs.length > 0;
  const ok = effectiveCleanup ? actions.every((a) => a.ok) : true;
  const fmtP = (p) => `  pid ${p.pid} [${p.kind}/${p.ownership}] ${p.command.slice(0, 90)}（${p.ownerDetail}）`;
  const fmtD = (d) => `  ${d.path}（${d.ageMinutes} 分钟前${d.containsProviderKey ? '，含密钥文件!' : ''}，${d.ownership}：${d.ownerDetail}）`;
  const human = [
    `orphan-check ${effectiveCleanup ? '（cleanup 执行）' : '（只报告）'}`,
    `  证明无主进程 ${orphans.length}、无法证明归属进程 ${unknownProcs.length}（只报告不动手）、密钥目录无主 ${orphanDirs.length}/存疑 ${unknownDirs.length}`,
    ...[...orphans, ...unknownProcs].map(fmtP),
    ...[...orphanDirs, ...unknownDirs].map(fmtD),
    ...(effectiveCleanup ? actions.map((a) => `  ${a.ok ? '✓' : '✗'} ${a.action} ${a.target}${a.skipped ? ` —— ${a.skipped}` : ''}${a.error ? ` —— ${a.error}` : ''}`) : []),
  ].join('\n');
  return {
    ok,
    human,
    found,
    findings,
    actions,
    cleaned: effectiveCleanup,
    next: found && !effectiveCleanup
      ? '有残留或存疑条目——确认无正在跑的会话后执行 orphan-check --cleanup（先 --dry-run 复核清单；存疑条目永远不会被清理，需人工确认归属后手动处理）'
      : effectiveCleanup
        ? '清理完毕——重跑 orphan-check --json 确认归零'
        : '无残留',
  };
}

function isRunnerKind(p) {
  return p.kind === 'executor-runner';
}
