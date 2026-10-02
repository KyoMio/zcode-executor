// hooks/register.mjs —— 观察面板 mod 的引擎一侧（decisions D22）：起 watch 子进程读快照、注册 /zcode、画面板、
// 状态栏、弹出提示、Claude 投递时自动打开。只有这个文件依赖 Claude Code 引擎；逐行处理、分段与文案在 view.mjs，布局在 pane.mjs。
// 运行环境没有 Node，不 import lib/：数据只从 `zcode-executor watch --json` 来（PRD 第 4 节）。
// 面板只看不应答：挂起由 Claude 用 AskUserQuestion 转交（AGENTS.md 硬约束），这里不放任何应答控件。
// 引擎的静态检查要求接收 $ 的函数声明在文件顶层，所以下面的函数不写进 register 里。
import { atom, read, update } from 'claude-code';
import { drawPane } from './pane.mjs';
import { EMPTY_PANEL, applyLine, filterByRepo, startFailure } from './view.mjs';

const PANE = 'zcode';
const TITLE = 'zcode 任务';
const RESTART_MS = 5000; // watch 跑起来之后意外退出，多久重起
const REDRAW_MS = 30000; // 让「已运行 N 分钟」走起来、让刚结束的卡片按时缩成一行
const FRAME_MS = 250; // 终端转圈字符换帧
const SEND_RE = /\bzcode-executor['"]?\s+send\b/; // 绝对路径带引号时是 "…/zcode-executor" send

const panel = atom({ plugin: 'zcode-executor', key: 'panel' }, EMPTY_PANEL);
const frame = atom({ plugin: 'zcode-executor', key: 'frame' }, 0);

const clock = () => new Date().toTimeString().slice(0, 8);

// 模块重载时这些从头来（重载会重起 watch，从 hello 开始一轮新基线）；面板数据在 $.state 里，重载不丢。
// 面板开没开不记在这里：问引擎的 $.ui.panes()，重载后它仍记得。
let nodePath = '';
let baseline = {};
let frameTimer = null;

async function onLine($, msg) {
  let result;
  await update($, panel, (p) => {
    result = applyLine(p, baseline, msg, clock());
    return result.panel;
  });
  baseline = result.baseline;
  for (const text of result.toasts) $.ui.toast(text);
  if (result.status !== null) $.ui.status(result.status);
}

// 起一次 watch，读到它结束。收到 synced 之前就结束算「起不来」（找不到 node、登记簿读不出等，重试也一样），
// 收到 synced 之后才结束算「跑过后断了」。spawn 的循环拿不到退出码，所以用 synced 作分界。
async function runWatch($, cwd) {
  const bin = `${$.plugin.root}/bin/zcode-executor`;
  const argv = nodePath ? [nodePath, bin, 'watch', '--json'] : [bin, 'watch', '--json'];
  let buffer = '';
  let synced = false;
  let stderr = '';
  try {
    for await (const chunk of $.process.spawn({ argv, cwd })) {
      if (chunk.stream === 'stderr') {
        stderr = (stderr + chunk.text).slice(-500);
        continue;
      }
      buffer += chunk.text;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          $.ui.log(`zcode-executor: watch 输出一行不是 JSON，跳过：${line.slice(0, 120)}`, { to: 'debug' });
          continue;
        }
        if (msg.type === 'synced') synced = true;
        await onLine($, msg);
      }
    }
  } catch (err) {
    stderr = stderr || String(err?.message ?? err);
  }
  return { synced, stderr: stderr.trim() };
}

async function keepWatching($, cwd) {
  const { synced, stderr } = await runWatch($, cwd);
  if (!synced) {
    await update($, panel, (p) => ({ ...p, link: 'failed', message: startFailure(stderr) }));
    return;
  }
  const why = stderr ? `（${stderr.split('\n').pop()}）` : '';
  await update($, panel, (p) => ({ ...p, link: 'down', synced: false, message: `实时连接中断${why}，${RESTART_MS / 1000} 秒后重连` }));
  $.clock.after(RESTART_MS, () => void keepWatching($, cwd));
}

async function paneIsUp($) {
  return (await $.ui.panes()).some((p) => p.id === PANE);
}

// 终端换帧：面板没开或没有执行中会话就停掉，下次画面板时再起；桌面版不起这个定时器（有 Svg 动画）
async function nextFrame($) {
  const p = await read($, panel);
  const running = filterByRepo(Object.values(p.sessions), p.repo).some((s) => s.phase === 'running');
  if (!running || !(await paneIsUp($))) {
    frameTimer?.cancel();
    frameTimer = null;
    return;
  }
  await update($, frame, (n) => ((n ?? 0) + 1) % 1000);
}

/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  nodePath = options?.nodePath ?? '';

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'zcode', description: '打开 zcode 任务观察面板（实时刷新本项目的会话进展）' });
    await update($, panel, (p) => ({ ...p, synced: false, link: 'starting', message: null }));
    void keepWatching($, e.cwd);
    // 只让已画出的实例重画，面板没开时什么也不做
    $.clock.every(REDRAW_MS, () => $.ui.invalidate('ui.render'));
    return next(e);
  });

  on('command.run', { command: 'zcode' }, async ($) => {
    await $.ui.open({ id: PANE, title: TITLE });
    return { text: 'zcode 观察面板已打开。' };
  });

  // Claude 投递时自动打开：不等面板、不改不拦，命令照常往下走
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (typeof e.command === 'string' && SEND_RE.test(e.command)) {
      // 打不开不用处理：窄窗口时引擎让面板排队等宽度，人也随时能 /zcode 手动打开
      $.ui.open({ id: PANE, title: TITLE }).catch(() => {});
    }
    return next(e);
  });

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e);
    const p = await read($, panel);
    const sessions = filterByRepo(Object.values(p.sessions), p.repo);
    let f = 0;
    if (!el.Svg) {
      f = await read($, frame);
      if (!frameTimer && sessions.some((s) => s.phase === 'running')) frameTimer = $.clock.every(FRAME_MS, () => void nextFrame($));
    }
    return drawPane(el, {
      sessions,
      repo: p.repo,
      updatedAt: p.updatedAt,
      link: p.link === 'starting' ? 'live' : p.link,
      message: p.message,
      now: Date.now(),
      frame: f,
    });
  });
};
