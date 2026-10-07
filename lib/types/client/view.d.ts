/** 工具调用的显示形状（真机快照 recentTools / activeTool 的成员）。 */
export interface ToolCall {
    toolName: string;
    summary?: string | null;
    ok?: boolean;
}
/** 挂起详情（zcode-executor lib/snapshot.mjs:219-230 的两种 kind）。 */
export interface PendingDetail {
    kind: 'permission' | 'question';
    toolName?: string | null;
    summary?: string | null;
    reason?: string | null;
    questionTexts?: Array<string | null>;
}
/** 闲时排队状态（zcode-executor lib/snapshot.mjs:205-206）。 */
export interface OffpeakQueue {
    phase: 'queued' | 'ready';
    position?: number | null;
}
/**
 * watch --json 的一条会话快照。所有 id 之外的字段都可缺（旧版 CLI 与容错降级，SPEC 用户故事 24），
 * 视图函数按「没有」处理。
 */
export interface SessionSnapshot {
    id: string;
    sessionId?: string | null;
    title?: string | null;
    cwd?: string | null;
    repo?: string | null;
    phase?: string | null;
    task?: string | null;
    lastOutcome?: string | null;
    since?: string | null;
    lastEndedAt?: string | null;
    lastEndOutcome?: string | null;
    reply?: string[];
    replyMarkdown?: string | null;
    activeTool?: ToolCall | null;
    recentTools?: ToolCall[];
    pendingDetail?: PendingDetail | null;
    offpeakQueue?: OffpeakQueue | null;
}
/** 已结束会话的结果与卡片标题的文案 + 配色名（配色映射归渲染层，Task 5）。 */
export interface Outcome {
    glyph: string;
    label: string;
    color: 'success' | 'warning' | 'error' | 'inactive' | 'suggestion';
}
/** 卡片标题：kind 告诉布局用哪种图标（pulse 脉冲、wait 转圈、其余用 glyph）。 */
export interface Head {
    kind: 'glyph' | 'pulse' | 'wait';
    glyph?: string;
    label: string;
    color: Outcome['color'];
}
/** 只留所属仓库等于 repo 的会话；repo 为 null（Claude 会话不在 git 仓库里）时全留。repo 为 null 的会话在过滤时隐藏。 */
export declare function filterByRepo(sessions: SessionSnapshot[], repo: string | null | undefined): SessionSnapshot[];
/** 已结束会话的结果文案：exited 没有结果记录时是「已退出」，idle 没有结果是「空闲」。 */
export declare function outcomeOf(session: SessionSnapshot): Outcome;
/** 卡片标题的状态文案与配色；kind 告诉布局用哪种图标（pulse 脉冲、wait 转圈、其余用 glyph）。 */
export declare function headOf(session: SessionSnapshot): Head;
/** 「N 分钟」「N 小时 M 分」；since 为空或解析不了给 null（卡片右上角就不显示）。 */
export declare function elapsed(since: string | null | undefined, now: number): string | null;
/** 卡片右上角：执行中「已运行」、挂起「已等待」、排队「已排」、中断只写时长。 */
export declare function cornerOf(session: SessionSnapshot, now: number): string | null;
/**
 * 分三段：待处理（挂起、中断）、执行中（含闲时排队）、已结束（exited、idle）。
 * 已结束按 since 新的在前、没有 since 的排最后，只留前 limit 条（面板传 20，不传保持
 * CC mod 的 5 条）；其中结束 30 分钟内的进 recent（卡片），其余进 rows（一行，可点开成卡片）。
 * counts.done 是已结束的总数，不受 limit 限制。
 */
export declare function sectionsOf(sessions: SessionSnapshot[], now: number, limit?: number): {
    todo: SessionSnapshot[];
    doing: SessionSnapshot[];
    recent: SessionSnapshot[];
    rows: SessionSnapshot[];
    counts: {
        todo: number;
        doing: number;
        done: number;
    };
};
/**
 * 回复的一行文字（收起时用）：只去掉纯排版的 Markdown 记号，内容里的符号一个不动。
 * 行首的标题 `# `、无序列表 `- ` `* ` `+ `、引用 `> `（记号后面必须跟空格才算）；表格行（以 `|` 开头）首尾的竖线；
 * 反引号代码以外成对的 `**加粗**` 记号。有序列表的编号保留（表示步骤顺序）；`__` 一律不动（常是 `__init__` 这类内容）。
 * 纯排版的行返回 ''：空行、`…`、代码块围栏、表格分隔行、整行分隔线（`---` `***` `___`）。
 */
export declare function plainLine(raw: string | null | undefined): string;
/**
 * 回复要不要折叠：按原文里有内容的行（plainLine 非空）数，超过 limit 行才折叠。
 * 返回 { fold, lines }：fold 为 false 时整段按 Markdown 显示、不出按钮；为 true 时 lines 是收起时显示的前 limit 行。
 * limit = 2 复刻 CC mod 原值（2026-10-07 晚间定案：当日早先改的 1 行是在「不折叠分支被 CSS
 * 藏死、短回复整段不可见」的坏行为下定的；回到 CC mod 语义——≤2 行整段显示、>2 行收两行加展开）。
 */
export declare function replyFold(markdown: string | null | undefined, limit?: number): {
    fold: boolean;
    lines: string[];
};
//# sourceMappingURL=view.d.ts.map