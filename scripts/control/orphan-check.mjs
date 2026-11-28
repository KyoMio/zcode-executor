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
      // R2-1（御史判决）：进程扫描是系统级的，归属核对只查当前数据目录会误杀别的
      // ZCODE_EXECUTOR_HOME 实例里正常工作的 runner。规则改为：
      //  owned   —— 本实例锁登记此 pid；
      //  orphan  —— 能证明它属于本实例（命令行里的会话 id 在本实例 runs/ 下有目录）
      //            且锁已失主（没有锁或锁内 pid 已死/被顶替）；
      //  unknown —— 其余一律只报告：查不到归属不等于无主，可能是别的实例的正常任务
      if (lockPids.get(p.pid) !== undefined) {
        ownership = 'owned';
        ownerDetail = `本实例登记簿会话 ${lockPids.get(p.pid)} 的锁`;
      } else {
        const sidMatch = /_runner\s+([A-Za-z0-9_-]+)/.exec(p.command);
        const sid = sidMatch?.[1];
        const belongsHere = sid !== undefined && existsSync(path.join(home, 'runs', sid));
        if (!belongsHere) {
          ownership = 'unknown';
          ownerDetail = sid === undefined
            ? '命令行里读不到会话 id，无法证明属于本实例'
            : `会话 ${sid} 不在本实例 runs/ 下——可能是别的数据目录的任务，只报告`;
        } else {
          // R3-1（御史判决）：同名会话目录不足以证明归属——备份一份已完成会话，
          // 两个数据目录就有相同的会话登记和 runs 目录，这个状态不需要任何人伪造。
          // 锁文件同样会被备份复制，也无法把进程绑定到本 home。缺少不可继承的
          // 运行实例标识（如 home 绝对路径+创建时 nonce）之前，一律 unknown 只报告，
          // 跳过自动终止。「宁可漏清，不可错杀」——收窄的覆盖边界记录在 Proof §4。
          ownership = 'unknown';
          ownerDetail = `会话 ${sid} 的同名目录可被备份副本复制，无法把进程绑定到本实例，只报告`;
        }
      }
    } else {
      // zcode app-server：父活着 → owned。父不在时无法独立证明它属于本实例——
      // 一律 unknown 只报告（R2-1：宁可漏清理，不可错杀；密钥风险在临时目录不在进程）
      const parentAlive = p.ppid > 1 && pidAlive(p.ppid);
      if (parentAlive) {
        ownership = 'owned';
        ownerDetail = `父进程 ${p.ppid} 存活`;
      } else {
        ownership = 'unknown';
        ownerDetail = '父进程不在且无法独立证明归属本实例，只报告';
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
    // R2-1：个人密钥目录的生命周期跟着用它的子进程走，而子进程可能属于别的数据目录实例。
    // 「本实例无活 runner」证明不了它无归属——必须系统里一个 zcode-executor/zcode 相关进程
    // 都没有，才能独立证明陈旧目录失主
    let ownership;
    let ownerDetail = null;
    const anyExecutorProcess = procs.some((p) => /zcode-executor|zcode\.cjs/.test(p.command));
    if (ageMinutes < 10) {
      ownership = 'owned';
      ownerDetail = '10 分钟内有活动，可能正在使用';
    } else if (anyExecutorProcess) {
      ownership = 'unknown';
      ownerDetail = '系统里有 zcode 系进程在跑（可能属于别的实例），无法证明此目录无归属';
    } else {
      ownership = 'orphan';
      ownerDetail = '系统无任何 zcode 系进程，陈旧密钥目录可证明无主';
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
        // 签名比对而非全串相等：runner 看 _runner + 会话 id、server 看 zcode.cjs——
        // ps -p 与 -axo 的输出列格式不同，全串比较会误判身份变化
        if (p.kind === 'executor-runner') {
          const sid = /_runner\s+([A-Za-z0-9_-]+)/.exec(p.command)?.[1];
          stillSame = now.includes('_runner') && (sid === undefined || now.includes(sid));
        } else {
          stillSame = now.includes('zcode.cjs');
        }
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
      if (listProcesses().some((pr) => /zcode-executor|zcode\.cjs/.test(pr.command))) {
        actions.push({ target: d.path, action: 'rm -rf', ok: true, skipped: '操作时复核：系统出现 zcode 系进程，无法证明无归属，跳过' });
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
