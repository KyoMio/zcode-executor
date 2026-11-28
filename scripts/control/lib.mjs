// scripts/control/lib.mjs —— control-executor 各子命令的公共件（ZCE-4）。
// 负责：参数解析（值旗标/布尔旗标/未知旗标拒绝）、--json 输出形、指路式报错
// （fail() 的 message 里必须带「下一步该做什么」——Agent 友好 CLI 的第一原则）、
// 子进程执行器（node --test / 脚本调用的统一捕获）。不含任何子命令的业务逻辑。
import { spawn } from 'node:child_process';
import process from 'node:process';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.usageError = true;
  }
}

/**
 * 解析 argv：values 里的旗标收值，booleans 里的旗标只记录存在。
 * 未知 --xxx 直接 UsageError 并列出可用旗标（报错即修复方案）。
 */
export function parseArgs(argv, { values = [], booleans = [] } = {}) {
  const out = { flags: {}, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out.positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (values.includes(name)) {
      if (eq >= 0) {
        out.flags[name] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out.flags[name] = argv[i + 1];
        i += 1;
      } else {
        throw new UsageError(`--${name} 需要一个值。用法：--${name} <值>`);
      }
    } else if (booleans.includes(name)) {
      if (eq >= 0) throw new UsageError(`--${name} 是开关旗标不带值。直接写 --${name} 即可`);
      out.flags[name] = true;
    } else {
      throw new UsageError(`不认识的旗标 --${name}。本子命令可用：${[...values, ...booleans].map((f) => `--${f}`).join(' ') || '（无）'}`);
    }
  }
  return out;
}

/**
 * 子命令的统一出口包装：ok 时按 --json/人读两种形态输出；失败时 message 必须
 * 自带下一步指引（指路式报错——调用方保证，这里只在缺失时补一句兜底指向）。
 */
export function emitResult({ json, result }) {
  if (json) {
    console.log(JSON.stringify(result, null, 1));
  } else {
    console.log(result.human ?? JSON.stringify(result, null, 1));
  }
  return result.ok === false ? 1 : 0;
}

export function fail(step, err, next) {
  const message = err?.message ?? String(err);
  return {
    step,
    ok: false,
    error: message,
    next: next ?? `先跑 node scripts/control-executor.mjs doctor --json 定位环境，再重试 ${step}`,
  };
}

/** 跑一个子进程并捕获 stdout/stderr/退出码（不 shell，参数数组原样传）。 */
export function runProcess(cmd, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, signal: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
  });
}

/** node --test 跑指定文件（可带 --test-name-pattern），返回解析后的计数。 */
export async function runNodeTest(files, { namePattern, timeoutMs = 300_000, concurrency = 1 } = {}) {
  const args = ['--test', `--test-concurrency=${concurrency}`];
  if (namePattern) args.push(`--test-name-pattern=${namePattern}`);
  args.push(...files);
  const r = await runProcess(process.execPath, args, { timeoutMs });
  // spec 报告摘要行形如 "ℹ pass 12"（Node ≥20 默认）；TAP 兼容 "# pass 12"
  const count = (label) => {
    const m = r.stdout.match(new RegExp(`^(?:ℹ|#) ${label} (\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  return {
    ...r,
    pass: count('pass'),
    fail: count('fail'),
    tests: count('tests'),
  };
}
