export const title = "Permission Gate and Tool Summary Attribution (ZCE-6)";

export const colors = {
  gateCheck: "blue",
  review: "purple",
  allow: "teal",
  pending: "orange",
  summary: "yellow",
  done: "tan",
};

const GATE_LABEL = {
  Idle: "Gate: Idle (等待权限请求)",
  CheckHard: "Gate: CheckHard (机械红线检查)",
  CheckAllowOnce: "Gate: CheckAllowOnce (校验 allow_once)",
  CheckReviewEnabled: "Gate: CheckReviewEnabled (检查审批可用性)",
  JevPreScreen: "Gate: JevPreScreen (Jev 前筛)",
  ZCodeFast: "Gate: ZCodeFast (Stage 1 快筛)",
  ZCodeSlow: "Gate: ZCodeSlow (Stage 2 慢判)",
  AutoAllowed: "Gate: AutoAllowed (裁决 allow)",
  PendingHuman: "Gate: PendingHuman (落盘 pending.json)",
  Resolved: "Gate: Resolved",
};

export const state = (v) => {
  if (v.gatePhase !== "Resolved") {
    if (v.gatePhase === "PendingHuman") {
      if (v.gateStage === "review-failed" || v.gateStage === "gate-error") {
        return `PendingHuman (${v.gateStage} 异常降级 -> ask)`;
      }
      return `PendingHuman (${v.gateStage} -> ask)`;
    }
    if (v.gatePhase === "AutoAllowed") {
      return `AutoAllowed (${v.gateStage} -> allow)`;
    }
    return GATE_LABEL[v.gatePhase] ?? v.gatePhase;
  }
  if (v.summaryPhase === "Collecting") {
    if (v.callName?.[1] === "Unset") return "Summary: Collecting (待记录调用)";
    if (v.callName?.[2] === "Unset") return "Summary: Collecting (已记 Read omitted)";
    if ((v.permQueue?.Write ?? 0) === 0) return "Summary: Collecting (Read+Write omitted)";
    return "Summary: Collecting (已收 Write permission.requested)";
  }
  if (v.summaryPhase === "Backfill1") return "Summary: Backfill Slot 1 (Read 仅查 Read 队列)";
  if (v.summaryPhase === "Backfill2") return "Summary: Backfill Slot 2 (Write 查 Write 队列)";
  return v.callInput?.[2] === "perm_Write"
    ? "Emitted (Read=none, Write=perm_Write)"
    : "Emitted (Read=none, Write=none)";
};

export const group = (v) => {
  if (v.gatePhase !== "Resolved") {
    if (v.gatePhase === "PendingHuman") return "pending";
    if (v.gatePhase === "AutoAllowed") return "allow";
    if (v.gatePhase === "JevPreScreen" || v.gatePhase === "ZCodeFast" || v.gatePhase === "ZCodeSlow") return "review";
    return "gateCheck";
  }
  if (v.summaryPhase === "Emitted") return "done";
  return "summary";
};

const STEP_LABEL = {
  ReceivePermissionRequest: "收到 interaction/requestPermission",
  HardRuleHit: "命中红线 -> ask",
  HardRulePass: "红线通过",
  GateInternalError: "闸门异常 -> 安全降级 ask",
  NoAllowOnce: "无 allow_once -> ask",
  HasAllowOnce: "存在 allow_once",
  ReviewDisabled: "审批不可用 -> ask",
  EnterJevPreScreen: "启用 Jev 前筛",
  SkipJevToFast: "直入 Stage 1",
  JevPass: "Jev pass -> allow",
  JevFallback: "Jev flag/skip/error -> Stage 1",
  FastPass: "parseFast=pass -> allow",
  FastFlag: "parseFast=flag -> Stage 2",
  FastCompleteError: "Stage 1 异常 -> review-failed ask",
  SlowAllow: "parseSlow=allow -> allow",
  SlowAsk: "parseSlow=ask -> ask",
  SlowDenyCited: "parseSlow=deny(有效规则) -> 映射 ask",
  SlowDenyUncited: "parseSlow=deny(无/假规则) -> 降级 ask",
  SlowParseAnomaly: "parseSlow 畸形/解析失败 -> review-failed ask",
  SlowCompleteError: "Stage 2 异常 -> review-failed ask",
  EmitAutoAllow: "自动应答 allow",
  HumanApprove: "人工 approve -> allow",
  HumanDeny: "人工 deny -> deny",
  ScheduleSlot1: "记录 Read(inputOmitted)",
  ScheduleSlot2: "记录 Write(inputOmitted)",
  ReceivePermRequest: "收到 Write 的 permission.requested",
  StartBackfill: "开始同名工具回填",
  BackfillSlot1: "Read 不借 Write 输入 (保持 none)",
  Done: "完成",
};

export const step = (action, from, to) => {
  if (action === "Done") return null;
  if (action === "BackfillSlot2") {
    return to.callInput?.[2] === "perm_Write"
      ? "Write 命中同队列回填 perm_Write"
      : "Write 无审批输入保持 none";
  }
  return STEP_LABEL[action] ?? action;
};
