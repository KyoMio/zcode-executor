export const title = "Turn / Runner / Queue Lifecycle (ZCE-6)";

export const colors = {
  setup: "blue",
  active: "teal",
  blocked: "orange",
  steer: "purple",
  closing: "yellow",
  terminal: "tan",
  fault: "pink",
};

const PHASE_LABEL = {
  Idle: "Idle (待抢锁)",
  ObservedDeadLock: "Dead Lock Observed",
  ReclaimLockHeld: "Reclaim Lock Held (.reclaim)",
  ReclaimUnlinked: "Reclaim Unlinked",
  LockHeld: "Lock Held (已持 worktree 锁)",
  Connected: "Connected (已拉起 app-server)",
  CheckingAttempts: "CheckingAttempts (bumpAttempts 后核限)",
  Running: "Running (回合执行中)",
  Blocked: "Blocked (pending.json 挂起等人工)",
  SteerQueued: "Steer Queued (guide 插话在飞)",
  Cancelling: "Cancelling (已发 session/stop)",
  TimedOut: "Timed Out (触发 stop + 5s 宽限)",
  Reconnecting: "Reconnecting (超时重连新闸门)",
  Cleaning: "Cleaning (finally 关连接/删密钥/解锁)",
  SignalClosing: "Signal Closing (关闭子进程与密钥)",
  Settled: "Settled (正常完成，零残留)",
  Cancelled: "Cancelled (已取消结算，零残留)",
  TimeoutSettled: "Timeout Settled (超时结算，零残留)",
  Exited: "Exited (子进程异常退出，保留队列重投)",
  Failed: "Failed (失败收场，零残留)",
};

export const state = (v) => {
  const phase = v.rPhase?.R1 ?? "Idle";
  if (phase === "Connected") {
    return v.queueItems > 0 ? "Connected (队列待发)" : "Connected (队列已空)";
  }
  return PHASE_LABEL[phase] ?? phase;
};

export const group = (v) => {
  const phase = v.rPhase?.R1 ?? "Idle";
  if (phase === "Idle" || phase === "ObservedDeadLock" || phase === "ReclaimLockHeld" || phase === "ReclaimUnlinked" || phase === "LockHeld") return "setup";
  if (phase === "Connected" || phase === "CheckingAttempts" || phase === "Running") return "active";
  if (phase === "Blocked") return "blocked";
  if (phase === "SteerQueued") return "steer";
  if (phase === "Cancelling" || phase === "TimedOut" || phase === "Reconnecting" || phase === "Cleaning" || phase === "SignalClosing") return "closing";
  if (phase === "Exited" || phase === "Failed") return "fault";
  return "terminal";
};

const STEP_LABEL = {
  TryAcquireLockSuccess: "tryLinkLock 成功持锁",
  TryAcquireLockContendedLive: "活锁冲突退出",
  ObserveDeadLock: "livePidOf 判死锁",
  AcquireReclaimLock: "抢占 .reclaim 锁",
  AcquireReclaimContended: ".reclaim 争抢退出",
  ReverifyLiveAndAbort: "复查发现活锁退出",
  ReverifyDead: "复查确认死锁",
  UnlinkDeadLock: "删死锁",
  ReacquireAfterUnlinkSuccess: "原子重抢成功并释 .reclaim",
  ReacquireAfterUnlinkLost: "重抢失手释 .reclaim 退出",
  SpawnAndAttach: "写临时密钥并 spawn + attach",
  SpawnOrAttachFail: "spawn/attach 失败进 finally",
  TakeQueueItem: "nextQueueFile + bumpAttempts",
  StartTurn: "attempts <= MAX_ATTEMPTS 发起 send",
  DropMaxAttempts: "attempts > MAX_ATTEMPTS 丢弃",
  QueueEmptyFinish: "队列已空收场",
  EnterBlocked: "落盘 pending.json 挂起",
  BlockedOnWedgedGate: "gate 挂起链卡死",
  AnswerBlocked: "消费 answer.json 恢复执行",
  LateReviewFallbackBlockedByClose: "已关闸门拦截在飞 review 回落",
  SendSteer: "inTurnWatcher 发送 guide 插话",
  DrainSteer: "turn.steerDrained 生效",
  SteerStartNowFail: "startNow 误起回合发 v4 stop",
  TriggerCancel: "见 cancel 发 session/stop",
  CancelSettleCancelled: "cancel 生效或宽限到期结算 cancelled",
  CancelSettleRacedDone: "cancel 竞态撞上已完成保留 done",
  TurnCompleteSuccess: "turn.completed(success) 出队",
  TurnTimeout: "回合超时发 session/stop",
  SettleTimeout: "gate.close() 结算 timeout",
  CloseForReconnect: "关旧连接重开新闸门",
  ChildCrash: "子进程退出保留队列重投",
  FinallyCleanup: "close + dispose + 解锁",
  ReceiveSignal: "收到 SIGTERM/SIGINT",
  SignalCleanupExit: "先关子进程再删密钥与释放锁",
  Done: "终态保持",
};

export const step = (action, from, to) => {
  if (action === "Done" || action === "LateReviewFallbackBlockedByClose") return null;
  if (action === "TriggerCancel") {
    const f = from.rPhase?.R1;
    if (f === "SteerQueued") return "steerQueued 期间 cancel";
    if (f === "Blocked") return "挂起期间 cancel 替答 deny/decline";
    return "运行中 cancel 发 session/stop";
  }
  if (action === "FinallyCleanup") {
    return `close + dispose + 解锁 -> ${to.rPhase?.R1 ?? "Terminal"}`;
  }
  return STEP_LABEL[action] ?? action;
};
