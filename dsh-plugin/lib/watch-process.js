/**
 * dsh-zcode-executor，服务端 watch 子进程管理。
 *
 * spawn `zcode-executor watch --json`（argv 从 execPath 换算，缺省 PATH 里找），cwd 取用户主目录
 * （hello.repo 为 null → 流里是全量会话，按仓库过滤归客户端）。逐行 JSON.parse 进快照表，语义与
 * 客户端归约器（src/client/reducer.ts）一致：hello 回到未同步、synced 前只进基线、synced 把基线
 * 整体换上——基线的「只当新基线、不当更新」在客户端归约器里管，服务端只负责把行原样转发加维护
 * 这张表与连接态。
 *
 * 重起语义照 zcode-executor 的 CC mod（hooks/register.mjs keepWatching）：收到 synced 之前退出 =
 * failed（起不来，重试也一样，不重试）；synced 之后退出 = down，restartMs（默认 5 秒）后重起。
 * 订阅接口把每一行原样递给订阅者（{ kind: 'line' }），连接态变化单独递（{ kind: 'link' }）。
 * on-demand 模式下由 stream 路由的活跃连接计数驱动起停（addStreamClient / removeStreamClient），
 * always 模式忽略计数、由 apply 起到 fiber dispose。
 */
import { spawn } from 'node:child_process';
/** watch 起不来时面板上的说明：只有看得出是找不到可执行文件时才提 execPath 配置项。 */
function startFailure(reason) {
    const text = reason.trim() || 'watch 没有输出就退出了';
    const noPath = /ENOENT|No such file|not found/i.test(text);
    return `启动 watch 失败：${text}${noPath ? '。可在插件配置里检查 execPath（watch CLI 路径）' : ''}`;
}
export class WatchProcess {
    execPath;
    cwd;
    restartMs;
    mode;
    logger;
    child = null;
    subscribers = new Set();
    restartTimer = null;
    link = 'starting';
    message = null;
    table = {};
    baseline = {};
    synced = false;
    refs = 0;
    disposed = false;
    intentionalStop = false;
    /** 本轮（一次 spawn 到退出）是否已收尾：'error' 与 'exit' 可能都来，只认第一个。 */
    settled = false;
    /** 本轮是否见到过 synced：重起判定的分界（CC mod keepWatching 同款）。 */
    runSynced = false;
    stderrTail = '';
    stdoutBuffer = '';
    constructor(options) {
        this.execPath = options.execPath;
        this.cwd = options.cwd;
        this.restartMs = options.restartMs ?? 5000;
        this.mode = options.mode ?? 'always';
        this.logger = options.logger;
    }
    /** 当前状态与快照表（表做浅拷贝，外部改不动内部）。 */
    getSnapshot() {
        return { link: this.link, message: this.message, synced: this.synced, table: { ...this.table } };
    }
    /** 只测用：当前子进程 pid（没起时 null）。纯读；竞态回归用例拿它断言陈旧 exit 没清掉新进程。 */
    get childPidForTest() {
        return this.child?.pid ?? null;
    }
    /** 订阅行与连接态；返回退订函数（stream 路由断开时调）。 */
    subscribe(listener) {
        this.subscribers.add(listener);
        return () => {
            this.subscribers.delete(listener);
        };
    }
    /** stream 路由：一条活跃连接。on-demand 下 0→1 起进程；always 只计数。 */
    addStreamClient() {
        this.refs += 1;
        if (this.mode === 'on-demand')
            this.start();
    }
    /** stream 路由：一条连接断开。on-demand 下归零杀进程且不进重起循环；always 只计数。 */
    removeStreamClient() {
        this.refs = Math.max(0, this.refs - 1);
        if (this.mode === 'on-demand' && this.refs === 0)
            this.stopForIdle();
    }
    /** 起一次 watch（已在跑或已卸载时不重复）。 */
    start() {
        if (this.disposed || this.child !== null)
            return;
        this.setLink('starting', null);
        this.runSynced = false;
        this.settled = false;
        // 上一轮若因按需停掉（intentionalStop）收尾，exit 已被身份校验挡下、旗标没机会清；
        // 不重置的话新进程意外退出会被误当成主动停掉，漏报断开。
        this.intentionalStop = false;
        this.stderrTail = '';
        this.stdoutBuffer = '';
        let child;
        try {
            child = spawn(this.execPath, ['watch', '--json'], { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch (error) {
            this.setLink('failed', startFailure(error instanceof Error ? error.message : String(error)));
            return;
        }
        this.child = child;
        // 挂 data 前先设编码：按 Buffer 逐块 String() 会让跨 chunk 的多字节字符变 U+FFFD
        child.stdout?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => this.onStdout(chunk));
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk) => {
            this.stderrTail = (this.stderrTail + chunk).slice(-500);
        });
        // 子进程实例经闭包传给回调做身份校验：stopForIdle 置空后同 tick 重连时，旧进程迟到的
        // error/exit 不得清掉新进程的引用（否则杀不到新进程，产生孤儿与重复喂行）
        child.on('error', (error) => this.onChildError(child, error));
        child.on('exit', (code) => this.onChildExit(child, code));
    }
    /** 卸载：杀子进程、清计时器与订阅者；之后不再重起。 */
    dispose() {
        this.disposed = true;
        this.clearRestartTimer();
        this.subscribers.clear();
        const child = this.child;
        this.child = null;
        child?.kill();
    }
    /** on-demand 计数归零：杀进程、停掉重起计时，状态记 down（没在跑）。已在 failed 时不覆盖原因。 */
    stopForIdle() {
        this.clearRestartTimer();
        const child = this.child;
        this.child = null;
        if (!child)
            return;
        this.intentionalStop = true;
        this.setLink('down', null);
        child.kill();
    }
    clearRestartTimer() {
        if (this.restartTimer !== null) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
    }
    onStdout(text) {
        this.stdoutBuffer += text;
        let newline = this.stdoutBuffer.indexOf('\n');
        while (newline !== -1) {
            const line = this.stdoutBuffer.slice(0, newline).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            newline = this.stdoutBuffer.indexOf('\n');
            if (!line)
                continue;
            let parsed;
            try {
                parsed = JSON.parse(line);
            }
            catch {
                this.logger?.debug?.('zcode-executor: watch 输出一行不是 JSON，跳过：%s', line.slice(0, 120));
                continue;
            }
            this.applyLine(parsed);
            this.emit({ kind: 'line', line: parsed });
        }
    }
    /** 一行进表（与 src/client/reducer.ts 同语义，服务端自己留一份全量给 snapshot 路由）。 */
    applyLine(msg) {
        if (!isLine(msg))
            return;
        if (msg.type === 'hello') {
            this.baseline = {};
            this.synced = false;
            return;
        }
        if (msg.type === 'session') {
            const session = sessionOf(msg);
            if (session === null)
                return;
            if (this.synced)
                this.table = { ...this.table, [session.id]: session };
            else
                this.baseline = { ...this.baseline, [session.id]: session };
            return;
        }
        if (msg.type === 'removed' && typeof msg.id === 'string') {
            const source = this.synced ? this.table : this.baseline;
            const { [msg.id]: _gone, ...rest } = source;
            if (this.synced)
                this.table = rest;
            else
                this.baseline = rest;
            return;
        }
        if (msg.type === 'synced') {
            this.table = { ...this.baseline };
            this.baseline = {};
            this.synced = true;
            this.runSynced = true;
            this.setLink('live', null);
        }
    }
    onChildError(child, error) {
        if (child !== this.child)
            return; // 陈旧事件：这轮进程已被换掉或主动停掉，别动现任
        if (this.disposed || this.settled)
            return;
        this.settled = true;
        this.child = null; // 本轮收尾；error 后 exit 不一定再来（spawn 失败只有 error），不清会挡住下次 start
        if (!this.runSynced) {
            this.setLink('failed', startFailure(error.message));
            return;
        }
        this.scheduleRestart(error.message);
    }
    onChildExit(child, code) {
        if (child !== this.child)
            return; // 陈旧事件：旧进程迟到的退出，别动现任进程
        this.child = null;
        if (this.disposed || this.settled)
            return;
        this.settled = true;
        if (this.intentionalStop) {
            // 纵深防御（Task 8 ④ 复查结论）：现行两条主动停机路径（stopForIdle / dispose）都先
            // 置空 this.child 再 kill，此类 exit 在上面的身份校验就被拦下，本分支实际到不了；
            // 留着防将来出现「不先置空就 kill」的新停机路径把主动停机误报成断连。
            this.intentionalStop = false;
            return; // 按需停掉或卸载：不算断开（dispose 连 down 都不记）
        }
        const tail = this.stderrTail.trim();
        if (!this.runSynced) {
            this.setLink('failed', startFailure(tail || `退出码 ${code ?? '未知'}`));
            return;
        }
        this.scheduleRestart(tail);
    }
    /** synced 之后断开：报 down 带原因，restartMs 后重起（重起到下个 synced 之间的行只作新基线）。 */
    scheduleRestart(tail) {
        const why = tail ? `（${tail.split('\n').pop()}）` : '';
        this.setLink('down', `实时连接中断${why}，${Math.round(this.restartMs / 1000)} 秒后重连`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.start();
        }, this.restartMs);
    }
    setLink(link, message) {
        this.link = link;
        this.message = message;
        // down/starting 回到未同步、旧表保留到下个 synced（与客户端归约器对连接事件的语义一致）
        if (link === 'down' || link === 'starting')
            this.synced = false;
        this.emit({ kind: 'link', link, message });
    }
    emit(event) {
        for (const listener of this.subscribers)
            listener(event);
    }
}
/** 行守卫：JSON.parse 的行是未知形状，先认 type 再认字段（旧版 CLI 缺字段整行忽略）。 */
function isLine(msg) {
    return typeof msg === 'object' && msg !== null && typeof msg.type === 'string';
}
/** session 行的会话对象窄化：只认 id 是字符串的（id 是归约与删除的键，缺了整行忽略）。 */
function sessionOf(msg) {
    const session = msg.session;
    if (typeof session === 'object' && session !== null && typeof session.id === 'string') {
        return session;
    }
    return null;
}
//# sourceMappingURL=watch-process.js.map