// hooks/register.mjs —— 观察面板 mod 的引擎一侧（decisions D22）：起 watch 子进程读快照、注册 /zcode、画面板、
// 状态栏、弹出提示、Claude 投递时自动打开。只有这个文件依赖 Claude Code 引擎；分段与文案在 view.mjs，布局在 pane.mjs。
// 运行环境没有 Node，不 import lib/：数据只从 `zcode-executor watch --json` 来（PRD 第 4 节）。
// 面板只看不应答：挂起由 Claude 用 AskUserQuestion 转交（AGENTS.md 硬约束），这里不放任何应答控件。
import { atom, read, update } from 'claude-code';
import { drawPane } from './pane.mjs';
import { filterByRepo, statusLine, toastsFor } from './view.mjs';

const PANE = 'zcode';
const TITLE = 'zcode 任务';
const RESTART_MS = 5000; // watch 意外退出后多久重起
const REDRAW_MS = 30000; // 让「已运行 N 分钟」走起来、让刚结束的卡片按时缩成一行
const FRAME_MS = 250; // 终端转圈字符换帧
const SEND_RE = /\bzcode-executor\s+send\b/;

const panel = atom({ plugin: 'zcode-executor', key: 'panel' }, {
  sessions: {}, repo: null, synced: false, updatedAt: null, link: 'starting', message: null,
});
const frame = atom({ plugin: 'zcode-executor', key: 'frame' }, 0);

const clock = () => new Date().toTimeString().slice(0, 8);

// 模块重载时这些从头来；面板数据在 $.state 里，重载不丢
let nodePath = '';
let baseline = new Map(); // synced 之前收到的快照：重连后的第一轮只当基线，不弹提示
let paneOpen = false;
let frameTimer = null;

const inScope = (p, s) => p.repo === null || s.repo === p.repo;

async function onLine($, msg) {
  if (msg.type === 'hello') {
    baseline = new Map();
    await update($, panel, (p) => ({ ...p, repo: msg.repo ?? null, synced: false }));
    return;
  }
  if (msg.type === 'session' && msg.session?.id) {
    const s = msg.session;
    const p = await read($, panel);
    if (!p.synced) {
      baseline.set(s.id, s);
      return;
    }
    if (inScope(p, s)) for (const text of toastsFor(p.sessions[s.id], s)) $.ui.toast(text);
    const next = await update($, panel, (q) => ({ ...q, sessions: { ...q.sessions, [s.id]: s }, updatedAt: clock() }));
    $.ui.status(statusLine(filterByRepo(Object.values(next.sessions), next.repo)));
    return;
  }
  if (msg.type === 'removed' && msg.id) {
    await update($, panel, (q) => {
      const { [msg.id]: _gone, ...rest } = q.sessions;
      return { ...q, sessions: rest, updatedAt: clock() };
    });
    return;
  }
  if (msg.type === 'synced') {
    const sessions = Object.fromEntries(baseline);
    baseline = new Map();
    const next = await update($, panel, (q) => ({ ...q, sessions, synced: true, link: 'live', message: null, updatedAt: clock() }));
    $.ui.status(statusLine(filterByRepo(Object.values(next.sessions), next.repo)));
  }
}

// 起一次 watch，读到它结束。返回 'failed'（一行输出都没有就挂了：多半是找不到 node）或 'ended'。
async function runWatch($, cwd) {
  const bin = `${$.plugin.root}/bin/zcode-executor`;
  const argv = nodePath ? [nodePath, bin, 'watch', '--json'] : [bin, 'watch', '--json'];
  let buffer = '';
  let gotLine = false;
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
        gotLine = true;
        try {
          await onLine($, JSON.parse(line));
        } catch (err) {
          $.ui.log(`zcode-executor: watch 输出一行读不懂，跳过：${String(err?.message ?? err)}`, { to: 'debug' });
        }
      }
    }
    return gotLine ? 'ended' : { failed: stderr.trim() || 'watch 没有输出就退出了' };
  } catch (err) {
    return gotLine ? 'ended' : { failed: String(err?.message ?? err) };
  }
}

async function keepWatching($, cwd) {
  const result = await runWatch($, cwd);
  if (result !== 'ended') {
    // 起不来不重试：重试也是同样的错，面板上把原因和办法写清楚
    await update($, panel, (p) => ({ ...p, link: 'failed', message: `启动 watch 失败：${result.failed}。可在插件配置里填写 node 路径（nodePath）` }));
    return;
  }
  await update($, panel, (p) => ({ ...p, link: 'down', synced: false, message: `实时连接中断，${RESTART_MS / 1000} 秒后重连` }));
  $.clock.after(RESTART_MS, () => void keepWatching($, cwd));
}


/** @type {import('claude-code').Register} */
export const register = (on, options) => {
  nodePath = options?.nodePath ?? '';

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'zcode', description: '打开 zcode 任务观察面板（实时刷新本项目的会话进展）' });
    await update($, panel, (p) => ({ ...p, synced: false, link: 'starting', message: null }));
    void keepWatching($, e.cwd);
    $.clock.every(REDRAW_MS, () => {
      if (paneOpen) $.ui.invalidate('ui.render');
    });
    return next(e);
  });

  on('command.run', { command: 'zcode' }, async ($) => {
    await $.ui.open({ id: PANE, title: TITLE });
    paneOpen = true;
    return { text: 'zcode 观察面板已打开。' };
  });

  on('ui.close', { id: PANE }, async ($, e, next) => {
    paneOpen = false;
    return next(e);
  });

  // Claude 投递时自动打开：不等面板、不改不拦，命令照常往下走
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (typeof e.command === 'string' && SEND_RE.test(e.command)) {
      paneOpen = true;
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
      // 终端没有 Svg：转圈字符靠定时换帧，只在面板开着且有执行中会话时换；桌面版不起这个定时器
      f = await read($, frame);
      frameTimer ??= $.clock.every(FRAME_MS, () => void (async () => {
        if (!paneOpen) return;
        const now = await read($, panel); // 现读：闭包里那份是第一次画时的
        if (filterByRepo(Object.values(now.sessions), now.repo).some((s) => s.phase === 'running')) await update($, frame, (n) => (n + 1) % 1000);
      })());
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
