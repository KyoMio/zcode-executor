// 观察面板 mod 的 $.state 契约（decisions D22）：hooks/register.mjs 用到的每个状态键都在这里声明，
// claude plugin validate 按它核对。快照形状同 watch --json（PRD 第 4 节）。
export type ZcodeExecutorTool = { toolName: string; summary: string | null; ok?: boolean | null };

export type ZcodeExecutorSnapshot = {
  id: string;
  sessionId: string | null;
  title: string;
  cwd: string;
  repo: string | null;
  phase: 'running' | 'pending' | 'stale' | 'idle' | 'exited';
  lastOutcome: string | null;
  task: string | null;
  since: string | null;
  lastEndedAt: string | null;
  lastEndOutcome: string | null;
  reply: string[];
  activeTool: ZcodeExecutorTool | null;
  recentTools: ZcodeExecutorTool[];
  pendingDetail:
    | { kind: 'permission'; toolName: string | null; summary: string | null; reason: string | null }
    | { kind: 'question'; questionTexts: string[] }
    | null;
  offpeakQueue: { phase: 'queued' | 'ready'; position: number | null } | null;
};

export type ZcodeExecutorPanel = {
  sessions: Record<string, ZcodeExecutorSnapshot>;
  repo: string | null;
  synced: boolean;
  updatedAt: string | null;
  link: 'starting' | 'live' | 'down' | 'failed';
  message: string | null;
};

declare module 'claude-code' {
  interface PluginState {
    'zcode-executor': { panel: ZcodeExecutorPanel; frame: number };
  }
}
