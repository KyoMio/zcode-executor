// scripts/preview.mjs —— 观察面板「真实渲染预览」harness：不起 DSH 宿主，把真实的
// lib/client.js bundle、真实的 store、真实的样式渲染成浏览器可直接打开的静态 HTML
// （.preview/pane.html），给 T6 视觉打磨与 mockup/pane.html 并排比对用。
//
// 用法：node scripts/preview.mjs（或 npm run preview）。只读现有产物，只写 .preview/。
//
// 与真实宿主的对应关系：
// · window.__ModuleLoader__.load({ id, factory })：假 loader 收下 factory，本脚本用
//   自己的模块表调 factory(require)——react 与 react/jsx-runtime 用 dsh-web-mobile 的
//   react@18.3.1 / react-dom@18.3.1（同一份 realpath，防双 React hooks 崩，脚本内断言）；
//   @deepseek-ai/dsh-client-ui-primitives 不提供，require 抛错被 host-modules.ts 的
//   try/catch 探测落 null——面板走自绘图标与自绘 Markdown 回退，这是真实回退代码路径。
// · document：最小假对象（createElement('style') 出带 dataset/textContent/remove 的轻量
//   节点，head.appendChild 收集），只够 apply 的样式注入用。
// · ctx：最小假上下文——effect 立即执行并收集 dispose；inject(['sidebarRightTabs'])
//   当场给服务（cordis「等服务」的等待语义不在预览范围）；sessions/workspaces 各给一个
//   不变化的 observable，主视图行带样例仓库的 cwd，让 apply 的 scope 派生真实走到 repo 路由。
// · 数据：node:http 桩服务器喂 store 的流端点，样例行照搬 test/reducer.test.mjs:154-203
//   对齐 mockup/pane.html 的那组（hello → 挂起审批 / 执行中 / 闲时排队 / 刚结束卡 /
//   已结束五行 → synced）；唯一改动是把 since 换成相对当前时钟，卡片/行分段与时长角标才
//   和 mockup 同款，另有两处按 ask 标注（见 SAMPLE_SESSIONS 上方注释）。
// · 渲染：react-dom/server 的 renderToStaticMarkup 渲染槽位注册的 Body；渲染前等 store
//   到 synced。useSyncExternalStore 的第三参 getServerSnapshot 由 src/client/pane/index.tsx
//   提供（仅 SSR 取快照用，客户端行为不变，理由见该处注释）。
// 自检断言失败即非零退出。
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const bundlePath = join(root, 'lib', 'client.js');
const outDir = join(root, '.preview');
const outPath = join(outDir, 'pane.html');

// 样例所属仓库（reducer.test.mjs:155 同款）：apply 的 scope 派生把 repo 路由解析到它。
const SAMPLE_REPO = '/Volumes/MacData/projects/zcode-executor';

// ---- React 18.3.1：从 dsh-web-mobile 的 .pnpm 取，react 与 react-dom 必须同一份 ----
const pnpmDir = join(dirname(root), 'dsh-web-mobile', 'node_modules', '.pnpm');
const reactDir = join(pnpmDir, 'react@18.3.1', 'node_modules', 'react');
const pnpmEntries = await readdir(pnpmDir).catch(() => []);
const reactDomEntry = pnpmEntries.find((name) => name.startsWith('react-dom@18.3.1'));
if (!reactDomEntry) {
  console.error(`[preview] 在 ${pnpmDir} 下找不到 react-dom@18.3.1（找到了：${pnpmEntries.filter((n) => n.startsWith('react-dom')).join(', ') || '无'}）`);
  process.exit(1);
}
const reactDomDir = join(pnpmDir, reactDomEntry, 'node_modules', 'react-dom');
// 锚在 react-dom 目录里解析：它内部 require('react') 走的正是这里，拿到的必是同一份
const reqFromDom = createRequire(join(reactDomDir, 'index.js'));
const React = reqFromDom('react');
const jsxRuntime = reqFromDom('react/jsx-runtime');
const ReactDOMServer = reqFromDom('react-dom/server');
const ReactDirect = createRequire(join(reactDir, 'index.js'))('react');
assert.equal(React.version, '18.3.1', `react 版本应为 18.3.1，收到 ${React.version}`);
assert.equal(ReactDirect, React, 'react 与 react-dom 必须同一份，防双 React hooks 崩');

// ---- 假 window / 假 loader：收下 factory（真实宿主在这里把 bundle 激活） ----
const loaded = { id: null, factory: null };
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      loaded.id = def.id;
      loaded.factory = def.factory;
    },
  },
};
// 假 document：够 apply 的 <style data-plugin> 注入即可
const styleTags = [];
globalThis.document = {
  head: {
    appendChild(tag) {
      styleTags.push(tag);
    },
  },
  createElement(tag) {
    return {
      tagName: tag,
      dataset: {},
      textContent: '',
      remove() {
        const at = styleTags.indexOf(this);
        if (at !== -1) styleTags.splice(at, 1);
      },
    };
  },
};

const source = await readFile(bundlePath, 'utf8');
new Function(source)(); // 顶层只调 window.__ModuleLoader__.load，工厂先收着
if (typeof loaded.factory !== 'function') {
  console.error('[preview] bundle 没把工厂交给 __ModuleLoader__.load，lib/client.js 形状变了？');
  process.exit(1);
}

// 工厂的模块表：react 同份供给；primitives 故意不提供（老宿主的真实形状，探测自然落 null）
const provided = { react: React, 'react/jsx-runtime': jsxRuntime };
const hostRequire = (id) => {
  if (id in provided) return provided[id];
  throw new Error(`[preview] 模块表没有 ${id}（宿主未提供，面板探测落 null 走自绘回退）`);
};
const plugin = loaded.factory(hostRequire); // { name, inject, apply }

// ---- 桩 stream 服务器：样例行照搬 test/reducer.test.mjs:154-203（对齐 mockup/pane.html） ----
// 两处与夹具的偏差（都有 ask/比对理由）：
// 1. since 改为相对当前时钟（夹具固定在 2026-10-02，相对渲染时刻才能复现 mockup 的
//    卡片/行分段与「已等待 3 分钟」这类角标——归约器测试注释本就说各行时刻是相对钟面的换算）。
// 2. 执行中卡的 replyMarkdown 按夹具前两句续写 mockup/pane.html:435-449 的回复全文
//    （ask 指定「replyMarkdown 含代码块」：围栏代码块 + 列表行，顺带如实暴露自绘
//    Markdown 不渲染列表的回退效果）。
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const snap = (over) => ({
  id: 'x_00000001',
  sessionId: 'sess_2b195e9f-4a10-40d1-bb00-3f5278864ef2',
  title: 'T1',
  cwd: '/wt/app',
  lastOutcome: null,
  repo: '/repo/app',
  phase: 'idle',
  task: null,
  since: null,
  lastEndOutcome: null,
  lastEndedAt: null,
  reply: [],
  replyMarkdown: null,
  activeTool: null,
  recentTools: [],
  pendingDetail: null,
  offpeakQueue: null,
  ...over,
});
const SAMPLE_SESSIONS = [
  snap({ id: 'x_9f31c2a0', title: 'T4-board', task: 'tasks/T4-board.md', phase: 'pending', since: ago(3), repo: SAMPLE_REPO,
    replyMarkdown: ['看板骨架已经搭完，四列拖拽都能动。', '', '`npm test` 12 例全绿，剩交互细节下一轮补。'].join('\n'),
    pendingDetail: { kind: 'permission', toolName: 'Bash', summary: 'rm -rf node_modules && npm ci',
      reason: '含删除操作，慢判转人工——任何越出执行副本的写入或删除一律转人工。' } }),
  snap({ id: 'x_a1b2c3d4', title: 'T2-auth-flow', task: 'tasks/T2-auth.md', phase: 'running', since: ago(6), repo: SAMPLE_REPO,
    replyMarkdown: [
      '会话过期的问题定位到了：',
      '',
      '`refresh()` 在 401 后没有重试，token 就断了。',
      '',
      '修法是给 client 加一层重试队列，过期时先续 token 再重放原请求。要点：',
      '',
      '- `authFetch()` 包一层，401 时挂进队列等续期；',
      '- 并发请求只触发一次 `refresh()`，其余共享同一个 Promise；',
      '- 续期失败统一抛 `SessionExpired`，路由层跳登录。',
      '',
      '```',
      'const r = await fetch(url, init);',
      'if (r.status === 401 && !init.__retried) {',
      '  await refreshOnce();',
      '  return authFetch(url, { ...init, __retried: true });',
      '}',
      '```',
      '',
      '改完跑 `npm test`，两处旧用例要跟着改 mock。',
    ].join('\n'),
    activeTool: { toolName: 'Edit', summary: 'src/auth/session.ts' },
    recentTools: [
      { toolName: 'Bash', summary: 'npm test -- --runInBand', ok: true },
      { toolName: 'Edit', summary: 'src/auth/session.ts', ok: true },
      { toolName: 'Read', summary: 'docs/SPEC.md', ok: true },
      { toolName: 'Bash', summary: 'npm run lint', ok: false },
    ] }),
  snap({ id: 'x_77aa01ff', title: 'T5-rename', task: 'tasks/T5-rename.md', phase: 'running', since: ago(12), repo: SAMPLE_REPO,
    offpeakQueue: { phase: 'queued', position: 2 } }),
  snap({ id: 'x_4e0b19cc', title: 'T1-api-client', task: 'tasks/T1-api.md', phase: 'exited', lastOutcome: 'done', since: ago(2), repo: SAMPLE_REPO,
    reply: ['client 封装完成，四个端点都有测试覆盖，npm test 41 个用例全绿。'] }),
  // 已结束五行（reducer.test.mjs:176-182 同款）：已超时（40 分钟，30 分钟窗口外稳定成行；避开 30 分钟整点边界防抖动）/ 执行失败 / 已取消（zeta-base，本项目范围被过滤）/ 空闲 / 已退出
  snap({ id: 'x_11aaaaaa', title: 'T0-probe', phase: 'exited', lastOutcome: 'timeout', since: ago(40), repo: SAMPLE_REPO }),
  snap({ id: 'x_22bbbbbb', title: 'T3-flaky-test', phase: 'exited', lastOutcome: 'failed', since: ago(48), repo: SAMPLE_REPO }),
  snap({ id: 'x_33cccccc', title: 'T6-bench', phase: 'exited', lastOutcome: 'cancelled', since: ago(101), repo: '/Volumes/MacData/projects/zeta-base' }),
  snap({ id: 'x_44dddddd', title: 'T9-scratch', phase: 'idle', since: ago(192), repo: SAMPLE_REPO }),
  snap({ id: 'x_5f0d21ab', title: '', phase: 'exited', lastOutcome: null, since: ago(329), repo: SAMPLE_REPO }),
];
const sampleTable = Object.fromEntries(SAMPLE_SESSIONS.map((s) => [s.id, s]));

const stubBase = await new Promise((resolveServer) => {
  const server = createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://stub');
    if (pathname === '/zcode-executor/stream') {
      // 回放形状照 routes.ts 的 stream 路由：connection live + hello + 表 + synced
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      const send = (line) => res.write(`${JSON.stringify(line)}\n`);
      send({ type: 'connection', link: 'live', message: null });
      send({ type: 'hello', repo: null }); // 插件从用户主目录 spawn，范围仓库为 null
      for (const session of SAMPLE_SESSIONS) send({ type: 'session', session });
      send({ type: 'synced' });
      return;
    }
    if (pathname === '/zcode-executor/snapshot') {
      // 流健康时 store 绝不该轮询到这里；给出同表的全量兜底，万一轮询也不倒拨状态
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ link: 'live', message: null, synced: true, table: sampleTable }));
      return;
    }
    if (pathname === '/zcode-executor/repo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ repo: SAMPLE_REPO }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1', () => {
    resolveServer(`http://127.0.0.1:${server.address().port}`);
    globalThis.__previewServer = server;
  });
});
// store 的 baseUrl 是空串（同源相对路径，浏览器语义）；Node 的 fetch 要绝对地址，这里补桩根
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  return realFetch(new URL(url, stubBase), init);
};

// ---- 假 ctx：effect 即执行并收集 dispose；inject 当场给 sidebarRightTabs；两个 observable 不变化 ----
const disposables = [];
const captured = { body: null, slotDef: null, tabDef: null };
const makeObservable = (snapshot) => ({
  getSnapshot: () => snapshot,
  subscribe: (fn) => {
    void fn; // cwd 不变化，预览期间没有通知
    return () => {};
  },
});
const ctx = {
  effect(fn, name) {
    void name;
    const dispose = fn();
    if (typeof dispose === 'function') disposables.push(dispose);
  },
  inject(_services, fn) {
    const tabsService = {
      register(def) {
        captured.tabDef = def;
        return () => {};
      },
    };
    const slots = {
      inject(_slotName, factory) {
        return factory();
      },
      register(def, component) {
        captured.slotDef = def;
        captured.body = component;
        return () => {};
      },
    };
    const dispose = fn({ get: (name) => (name === 'sidebarRightTabs' ? tabsService : undefined), slots });
    if (typeof dispose === 'function') disposables.push(dispose);
  },
  // 主视图行带样例仓库的 cwd：mainSessionCwdOf 选中它 → repo 路由 → store.setScopeRepo
  sessions: { list: makeObservable({ byId: { 'host-main': { id: 'host-main', cwd: SAMPLE_REPO, retainedBy: { mainView: 1 } } } }) },
  workspaces: { list: makeObservable({ items: [] }) },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`waitFor 超时：${label}`);
    await sleep(10);
  }
}

plugin.apply(ctx);
const store = captured.slotDef?.inject?.().store;
if (!store) {
  console.error('[preview] 没捕获到 sidebar.right.pane.tab 槽位的注册（Body / inject），假 ctx 的 slots 形状对不上？');
  process.exit(1);
}

// 渲染前等 store 到 synced（桩发完行后轮询 getState），scope 派生也落地
await waitFor(() => store.getState().synced, 'store 同步（桩已吐完 hello→session×9→synced）');
await waitFor(() => Object.keys(store.getState().table).length === SAMPLE_SESSIONS.length, '9 条样例会话全部进表');
await waitFor(() => store.getState().scopeRepo === SAMPLE_REPO, 'scope 派生到样例仓库');

// ---- SSR 渲染：Body 的 props 照 pane/index.tsx 的期望形状（store 由槽位 inject 下发） ----
const Body = captured.body;
assert.equal(typeof Body, 'function', '槽位注册的 Body 应是函数组件');
const dom = ReactDOMServer.renderToStaticMarkup(React.createElement(Body, captured.slotDef.inject()));

// 样式文本先留快照再收摊：dispose 会真实地 tag.remove()（忠实行为），收摊后 styleTags 就空了
const paneCss = styleTags.map((t) => t.textContent).join('\n');

// 收摊：停 store、清定时器、关服务器（10 秒的到点说明定时器也在 dispose 里）
for (const dispose of disposables.reverse()) dispose();
globalThis.fetch = realFetch;
globalThis.__previewServer.closeAllConnections();
await new Promise((resolve) => globalThis.__previewServer.close(resolve));

// ---- 组装完整文档：mockup 主题令牌（照搬）+ 预览控件 + 插件样式 + 渲染 DOM ----
if (!paneCss) {
  console.error('[preview] 没捕获到插件注入的 <style>（apply 的样式 effect 没跑？）');
  process.exit(1);
}

// 主题令牌：逐字照搬 mockup/pane.html:24-69（浅 :root 与深 body[data-ds-dark-theme]）
const THEME_CSS = `  /* ---- 主题令牌：照搬 mockup/pane.html:24-69（真实插件由宿主提供，这里自带近似取值以便独立预览） ---- */
  :root {
    --dsw-alias-bg-base: #f4f5f7;            /* 应用底 */
    --dsw-alias-bg-layer-1: #ffffff;         /* 面板/卡片面 */
    --dsw-alias-bg-layer-2: #eef0f3;         /* 次级面（代码块、分段控件槽） */
    --dsw-alias-bg-layer-3: #e4e7ec;
    --dsw-alias-border-l1: #e6e8ec;
    --dsw-alias-border-l2: #d6dae1;
    --dsw-alias-label-primary: #1b1f26;
    --dsw-alias-label-secondary: #4d5462;
    --dsw-alias-label-tertiary: #767e8c;
    --dsw-alias-label-dimmed: #9aa1ad;
    --dsw-alias-label-caption: #aab0ba;
    --dsw-alias-interactive-bg-hover: rgba(27, 31, 38, .055);
    --dsw-alias-state-success-primary: #1a7f37;
    --dsw-alias-state-warn-primary: #9a6700;
    --dsw-alias-state-error-primary: #cf222e;
    --dsw-alias-state-idle-primary: #6e7681;
    --dsw-alias-state-business-primary: #4f6ef7;
    --dsw-focus-ring-color: #4176e6;
    /* 插件自有派生色（同风格状态色，深浅各配） */
    --zxe-ok: var(--dsw-alias-state-success-primary);
    --zxe-warn: var(--dsw-alias-state-warn-primary);
    --zxe-err: var(--dsw-alias-state-error-primary);
    --zxe-dim: var(--dsw-alias-state-idle-primary);
    --zxe-acc: var(--dsw-alias-state-business-primary);
  }
  body[data-ds-dark-theme] {
    --dsw-alias-bg-base: #101318;
    --dsw-alias-bg-layer-1: #161a21;
    --dsw-alias-bg-layer-2: #1d222b;
    --dsw-alias-bg-layer-3: #262c36;
    --dsw-alias-border-l1: #262c36;
    --dsw-alias-border-l2: #333a46;
    --dsw-alias-label-primary: #e8ebf0;
    --dsw-alias-label-secondary: #aeb6c2;
    --dsw-alias-label-tertiary: #828b99;
    --dsw-alias-label-dimmed: #5d6570;
    --dsw-alias-label-caption: #4d545e;
    --dsw-alias-interactive-bg-hover: rgba(232, 235, 240, .07);
    --dsw-alias-state-success-primary: #3fb950;
    --dsw-alias-state-warn-primary: #d29922;
    --dsw-alias-state-error-primary: #f85149;
    --dsw-alias-state-idle-primary: #8b929d;
    --dsw-alias-state-business-primary: #7aaaff;
    --dsw-focus-ring-color: #7aaaff;
  }`;

// 舞台与右栏容器：照搬 mockup/pane.html 的 .stage/.sidebar/.tabbar（.pane 换成槽位容器）
const SHELL_CSS = `
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font: 12.5px/1.55 -apple-system, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif;
    color: var(--dsw-alias-label-primary);
    background: var(--dsw-alias-bg-base);
    -webkit-font-smoothing: antialiased;
  }
  code, pre, .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11.5px; }
  .stage { display: flex; justify-content: flex-end; height: 100vh; }
  .preview-note {
    position: fixed; left: 16px; bottom: 14px; color: var(--dsw-alias-label-dimmed);
    font-size: 11px; user-select: none; max-width: 340px;
  }
  .sidebar {
    width: 348px; height: 100%;
    background: var(--dsw-alias-bg-layer-1);
    border-left: 1px solid var(--dsw-alias-border-l2);
    display: flex; flex-direction: column;
  }
  .tabbar { /* 宿主提供的 tab 标题行，仅示意（照搬 mockup） */
    display: flex; align-items: center; gap: 8px;
    height: 38px; padding: 0 12px; flex: none;
    border-bottom: 1px solid var(--dsw-alias-border-l1);
  }
  .tabbar .t-ico { display: grid; place-items: center; color: var(--dsw-alias-label-secondary); }
  .tabbar .t-title { font-weight: 600; font-size: 12.5px; }
  .tabbar .t-sp { flex: 1; }
  .tabbar .t-btn {
    width: 24px; height: 24px; border: 0; border-radius: 6px; background: none;
    color: var(--dsw-alias-label-dimmed); display: grid; place-items: center; cursor: default;
  }
  .tabbar .icon { display: block; }
  .pane-slot { flex: 1; min-height: 0; } /* 宿主槽位容器：.zxe-pane 在里面 height:100% */

  /* ---- 预览控件（照 mockup 控件区，只留主题切换） ---- */
  .controls {
    position: fixed; left: 16px; top: 16px; width: 250px;
    background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l2);
    border-radius: 12px; padding: 12px 14px; font-size: 12px;
    box-shadow: 0 8px 28px rgba(0,0,0,.14);
  }
  .controls h3 { margin: 0 0 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
  .controls .btns { display: flex; flex-wrap: wrap; gap: 6px; }
  .controls button {
    font: inherit; font-size: 11.5px; cursor: pointer; border-radius: 7px;
    border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2);
    color: var(--dsw-alias-label-secondary); padding: 3px 9px;
  }
  .controls button:hover { background: var(--dsw-alias-interactive-bg-hover); }
  .controls .cap { margin-top: 8px; color: var(--dsw-alias-label-dimmed); font-size: 11px; }
  @media (max-width: 900px) { .controls { display: none; } }`;

// 静态图标 <symbol>：照搬 mockup/pane.html:350-363（tabbar 示意图标用；面板本体自绘 SVG 内联，不依赖这里）
const SYMBOLS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    <symbol id="i-tab" viewBox="0 0 20 20"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="13" height="13" rx="3"/><path d="M7 12.5V10c0-1.7 1.3-3 3-3s3 1.3 3 3v2.5"/></g></symbol>
    <symbol id="i-idle" viewBox="0 0 20 20"><g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="6.4"/></g><circle cx="10" cy="10" r="1.6" fill="currentColor"/></symbol>
    <symbol id="i-cancel" viewBox="0 0 20 20"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7.2"/><path d="M7.4 10h5.2"/></g></symbol>
  </defs>
</svg>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>zcode 任务 · 真实渲染预览（scripts/preview.mjs）</title>
<!--
  dsh-zcode-executor 观察面板「真实渲染预览」：node scripts/preview.mjs 生成，勿手改。
  与 mockup/pane.html 的差别：面板 DOM 不是手摆的，是真实 lib/client.js 的 Body 组件经
  react-dom/server 渲染的产物；primitives 模块不提供，走面板的自绘图标与自绘 Markdown 回退
  （真实回退代码路径）。数据是桩 stream 喂的样例行（test/reducer.test.mjs 对齐 mockup 的那组）。
-->
<style>
${THEME_CSS}
${SHELL_CSS}
</style>
<style data-plugin="dsh-zcode-executor">
${paneCss}
</style>
</head>
<body>
${SYMBOLS}
<div class="stage">
  <aside class="sidebar" data-link="live">
    <div class="tabbar">
      <span class="t-ico"><svg class="icon" width="16" height="16"><use href="#i-tab"/></svg></span>
      <span class="t-title">zcode 任务</span>
      <span class="t-sp"></span>
      <span class="t-btn"><svg class="icon" width="14" height="14"><use href="#i-idle"/></svg></span>
      <span class="t-btn"><svg class="icon" width="14" height="14"><use href="#i-cancel"/></svg></span>
    </div>
    <!-- Body 渲染 DOM：renderToStaticMarkup(<Body store={store}/>)，props 由槽位 inject 下发 -->
    <div class="pane-slot">
${dom}
    </div>
  </aside>
</div>

<!-- ======== 预览控件（不进面板） ======== -->
<div class="controls">
  <h3>预览控件 · 不属于面板</h3>
  <div class="btns">
    <button type="button" id="btnTheme">切换 浅色 / 深色</button>
  </div>
  <div class="cap">主题钩子照 mockup：body[data-ds-dark-theme] 翻转 --dsw-alias-* 令牌。面板本体是静态渲染的快照，范围切换与回复展开按钮不响应点击。</div>
</div>

<div class="preview-note">真实 lib/client.js 渲染 · primitives 缺席（自绘回退） · 样例行照 test/reducer.test.mjs 对齐 mockup/pane.html 的那组 · 生成于 ${new Date().toISOString()}</div>

<script>
  // 预览控件：主题切换（真实实现里宿主已经切好 body[data-ds-dark-theme]，插件只需用令牌）
  document.getElementById('btnTheme').addEventListener('click', () => {
    const dark = document.body.toggleAttribute('data-ds-dark-theme');
    document.getElementById('btnTheme').textContent = dark ? '当前深色 · 点切浅色' : '切换 浅色 / 深色';
  });
</script>
</body>
</html>
`;

// ---- 自检断言：T6 视觉差异修复的六项 + 原有廉价附带检查；失败非零退出 ----
// 令牌对账：插件样式引用的每个 --dsw-* 名字必须在 THEME_CSS 有定义（名字集以宿主 app.asar
// 实测为准）——防止再造出宿主不存在的短名（2026-10-07 真机全灰阶事故的根因）
const usedTokens = [...new Set([...paneCss.matchAll(/--dsw-[a-z0-9-]+/g)].map((m) => m[0]))];
const definedTokens = new Set([...THEME_CSS.matchAll(/--dsw-[a-z0-9-]+(?=\s*:)/g)].map((m) => m[0]));
const missingTokens = usedTokens.filter((t) => !definedTokens.has(t));
const checks = [
  ['样例的挂起标题「挂起：审批请求（Bash）」', html.includes('挂起：审批请求（Bash）')],
  ['闲时排队「第 2 位」', html.includes('第 2 位')],
  ['已结束行标题 title 优先：「T3-flaky-test」出现（夹具该行有 title 无 task）', html.includes('T3-flaky-test')],
  ['已结束行不再裸奔本地 id：「x_22bbbbbb」不出现', !html.includes('x_22bbbbbb')],
  ['已结束行 id 兜底仍在：「x_5f0d21ab」出现（title 空串不算命中、无 task）', html.includes('x_5f0d21ab')],
  ['失败工具行可见：第 4 条 recentTools（ok:false）出 zxe-bad（工具区画满 5 条）', html.includes('zxe-bad')],
  ['自绘 Markdown 列表渲染：replyMarkdown 的 - 行聚成 <ul>（renderToStaticMarkup 产物是小写标签）', html.includes('<ul>')],
  ['排队卡 task 不进标题行：「tasks/T5-rename.md」恰好出现 1 次（只剩 meta 行那次）', (html.match(/tasks\/T5-rename\.md/g) ?? []).length === 1],
  ['执行中卡标题行显示会话 title：「T2-auth-flow」出现', html.includes('T2-auth-flow')],
  ['zxe- 根类名「zxe-pane」', html.includes('zxe-pane')],
  ['插件 <style> 已捕获且含面板根样式', paneCss.includes('.zxe-pane {')],
  ['自绘图标回退在用（zxe-icon，宿主图标缺席的真实路径）', html.includes('zxe-icon')],
  ['回复折叠在用（执行中卡的「展开回复」按钮恰好 1 个；挂起卡与已结束卡 ≤2 行走平铺无按钮。样式注释里也写了「展开回复」，故只数按钮元素）', (html.match(/>展开回复<\/button>/g) ?? []).length === 1],
  ['回复默认收起前两行（复刻 CC mod）：执行中卡的 zxe-peek 恰好一个、含两个 <p>', (html.match(/<div class="zxe-peek"><p>[^<]*<\/p><p>[^<]*<\/p><\/div>/g) ?? []).length === 1],
  ['不折叠回复平铺可见（复刻 CC mod）：挂起卡与已结束卡的短回复走 zxe-flat 整段显示（DOM class 恰好 2 处，CSS 规则文本另算）', (html.match(/class="zxe-reply zxe-flat"/g) ?? []).length === 2],
  ['已结束卡回复不再被藏：reply 文字「client 封装完成」直接出现在 HTML（fold=false 平铺）', html.includes('client 封装完成')],
  ['已结束行可点开（2026-10-07 规格）：行带 role="button"', html.includes('role="button"')],
  [`插件样式引用的 --dsw-* 令牌全部在 THEME_CSS 有定义（缺 ${missingTokens.join('、') || '无'}）`, missingTokens.length === 0],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [label] of failed) console.error(`[preview] 自检失败：HTML 里没有 ${label}`);
if (failed.length > 0) process.exit(1);

await mkdir(outDir, { recursive: true });
await writeFile(outPath, html);
console.log(`[preview] 面板 tab「${captured.tabDef ? captured.tabDef.id : '?'}」Body 已渲染，插件样式 ${paneCss.length} 字节`);
console.log(`[preview] 产物：${outPath}（${html.length} 字节；自检 ${checks.length}/${checks.length} 通过）`);
