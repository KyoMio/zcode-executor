--------------------- MODULE PermissionGateToolSummary ---------------------
\* Subsystem 2 formal model: Permission Gate verdict safety & Tool Summary inputOmitted attribution
\* Covered implementation files:
\*   - lib/gate.mjs (createGate, permission, gatePermission)
\*   - lib/review/run.mjs (createReview, two-stage fast/slow + optional Jev pre-screen)
\*   - lib/review/parse.mjs (parseFast, parseSlow, toResult, candidateLines)
\*   - lib/review/hard.mjs (checkHardRules)
\*   - lib/pending.mjs (createPendingGate, hasAllowOnce, permissionResponse)
\*   - lib/tool-summary.mjs (parseTurn, inputOmitted same-tool backfill)

EXTENDS Integers, FiniteSets

CONSTANTS
  AllowUnnamedOmitted, \* TRUE exposes Finding F3 (lib/tool-summary.mjs:238 unnamed call steals named perm input)
  ChartCompact         \* TRUE bounds ToolSummary slot permutations & serializes after Gate for <= 500-state Mermaid rendering

VARIABLES
  \* --- Region 1: Permission Gate (lib/gate.mjs + lib/review/* + lib/pending.mjs) ---
  gatePhase,          \* "Idle" | "CheckHard" | "CheckAllowOnce" | "CheckReviewEnabled" |
                      \* "JevPreScreen" | "ZCodeFast" | "ZCodeSlow" | "AutoAllowed" | "PendingHuman" | "Resolved"
  hardHit,            \* BOOLEAN: checkHardRules hit (outside-worktree or self-modify-approval)
  hasAllowOnce,       \* BOOLEAN: options contain kind = "allow_once"
  reviewEnabled,      \* BOOLEAN: config.review.enabled !== false /\ complete # undefined
  jevEnabled,         \* BOOLEAN: fastScreen # undefined
  gateInternalErr,    \* BOOLEAN: unexpected exception caught by permission() try/catch (lib/gate.mjs:143)
  parseAnomaly,       \* BOOLEAN: model error/timeout, parseSlow undefined, uncited deny, or gate internal error
  gateDecision,       \* "none" | "allow" | "ask" | "deny" ("deny" included in type so InvGateNeverAutoDenies is non-tautological)
  gateStage,          \* "none" | "hard" | "no-allow-option" | "review-disabled" | "review-fast" | "review-slow" | "review-failed" | "gate-error"
  pendingWritten,     \* BOOLEAN: pending.json written on disk before waiting for human answer
  finalWireResponse,  \* "none" | "allow" | "deny"
  responseActor,      \* "none" | "gate" | "human"

  \* --- Region 2: Tool Summary inputOmitted Backfill (lib/tool-summary.mjs:166-257) ---
  summaryPhase,       \* "Collecting" | "Backfill1" | "Backfill2" | "Emitted"
  callName,           \* [1..2 -> {"Unset", "Read", "Write", "None"}]
  callOmitted,        \* [1..2 -> BOOLEAN]
  callInput,          \* [1..2 -> {"none", "stream", "inline", "perm_Read", "perm_Write"}]
  permQueue,          \* [{"Read", "Write"} -> 0..1]
  permSent            \* [{"Read", "Write"} -> BOOLEAN]

vars == <<
  gatePhase, hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr,
  parseAnomaly, gateDecision, gateStage, pendingWritten, finalWireResponse, responseActor,
  summaryPhase, callName, callOmitted, callInput, permQueue, permSent
>>

ToolNames == {"Read", "Write"}
SlotNames == {"Unset", "Read", "Write", "None"}
GatePhases == {
  "Idle", "CheckHard", "CheckAllowOnce", "CheckReviewEnabled",
  "JevPreScreen", "ZCodeFast", "ZCodeSlow", "AutoAllowed", "PendingHuman", "Resolved"
}
GateStages == {
  "none", "hard", "no-allow-option", "review-disabled",
  "review-fast", "review-slow", "review-failed", "gate-error"
}
InputSources == {"none", "stream", "inline", "perm_Read", "perm_Write"}

TypeOK ==
  /\ gatePhase \in GatePhases
  /\ hardHit \in BOOLEAN
  /\ hasAllowOnce \in BOOLEAN
  /\ reviewEnabled \in BOOLEAN
  /\ jevEnabled \in BOOLEAN
  /\ gateInternalErr \in BOOLEAN
  /\ parseAnomaly \in BOOLEAN
  /\ gateDecision \in {"none", "allow", "ask", "deny"}
  /\ gateStage \in GateStages
  /\ pendingWritten \in BOOLEAN
  /\ finalWireResponse \in {"none", "allow", "deny"}
  /\ responseActor \in {"none", "gate", "human"}
  /\ summaryPhase \in {"Collecting", "Backfill1", "Backfill2", "Emitted"}
  /\ callName \in [{1, 2} -> SlotNames]
  /\ callOmitted \in [{1, 2} -> BOOLEAN]
  /\ callInput \in [{1, 2} -> InputSources]
  /\ permQueue \in [ToolNames -> 0..1]
  /\ permSent \in [ToolNames -> BOOLEAN]

Init ==
  /\ gatePhase = "Idle"
  /\ hardHit = FALSE
  /\ hasAllowOnce = FALSE
  /\ reviewEnabled = FALSE
  /\ jevEnabled = FALSE
  /\ gateInternalErr = FALSE
  /\ parseAnomaly = FALSE
  /\ gateDecision = "none"
  /\ gateStage = "none"
  /\ pendingWritten = FALSE
  /\ finalWireResponse = "none"
  /\ responseActor = "none"
  /\ summaryPhase = "Collecting"
  /\ callName = [i \in {1, 2} |-> "Unset"]
  /\ callOmitted = [i \in {1, 2} |-> FALSE]
  /\ callInput = [i \in {1, 2} |-> "none"]
  /\ permQueue = [t \in ToolNames |-> 0]
  /\ permSent = [t \in ToolNames |-> FALSE]

SummaryUNCHANGED ==
  UNCHANGED <<summaryPhase, callName, callOmitted, callInput, permQueue, permSent>>

GateUNCHANGED ==
  UNCHANGED <<
    gatePhase, hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr,
    parseAnomaly, gateDecision, gateStage, pendingWritten, finalWireResponse, responseActor
  >>

-----------------------------------------------------------------------------
\* Region 1: Permission Gate actions (lib/gate.mjs, lib/review/run.mjs, lib/review/parse.mjs, lib/pending.mjs)

ReceivePermissionRequest ==
  \E allowOpt \in BOOLEAN :
    /\ gatePhase = "Idle"
    /\ hasAllowOnce' = allowOpt
    /\ gatePhase' = "CheckHard"
    /\ UNCHANGED <<
         hardHit, reviewEnabled, jevEnabled, gateInternalErr,
         parseAnomaly, gateDecision, gateStage, pendingWritten, finalWireResponse, responseActor
       >>
    /\ SummaryUNCHANGED

\* Mechanical hard rules (lib/gate.mjs:160-165, lib/review/hard.mjs)
HardRuleHit ==
  /\ gatePhase = "CheckHard"
  /\ hardHit' = TRUE
  /\ gateDecision' = "ask"
  /\ gateStage' = "hard"
  /\ pendingWritten' = TRUE
  /\ gatePhase' = "PendingHuman"
  /\ UNCHANGED <<hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

HardRulePass ==
  /\ gatePhase = "CheckHard"
  /\ hardHit' = FALSE
  /\ gatePhase' = "CheckAllowOnce"
  /\ UNCHANGED <<hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, gateDecision, gateStage, pendingWritten, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

\* Unexpected gate exception caught by permission() (lib/gate.mjs:143-153) -> safe ask
GateInternalError ==
  /\ gatePhase \in {"CheckHard", "CheckAllowOnce", "CheckReviewEnabled", "JevPreScreen", "ZCodeFast", "ZCodeSlow"}
  /\ gateInternalErr' = TRUE
  /\ parseAnomaly' = TRUE
  /\ gateDecision' = "ask"
  /\ gateStage' = "gate-error"
  /\ pendingWritten' = TRUE
  /\ gatePhase' = "PendingHuman"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

\* allow_once option guard (lib/gate.mjs:167-171, lib/pending.mjs:38-40)
NoAllowOnce ==
  /\ gatePhase = "CheckAllowOnce"
  /\ ~hasAllowOnce
  /\ gateDecision' = "ask"
  /\ gateStage' = "no-allow-option"
  /\ pendingWritten' = TRUE
  /\ gatePhase' = "PendingHuman"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

HasAllowOnce ==
  /\ gatePhase = "CheckAllowOnce"
  /\ hasAllowOnce
  /\ gatePhase' = "CheckReviewEnabled"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, gateDecision, gateStage, pendingWritten, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

\* Review availability check (lib/gate.mjs:173-177)
ReviewDisabled ==
  /\ gatePhase = "CheckReviewEnabled"
  /\ reviewEnabled' = FALSE
  /\ gateDecision' = "ask"
  /\ gateStage' = "review-disabled"
  /\ pendingWritten' = TRUE
  /\ gatePhase' = "PendingHuman"
  /\ UNCHANGED <<hardHit, hasAllowOnce, jevEnabled, gateInternalErr, parseAnomaly, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

EnterJevPreScreen ==
  /\ gatePhase = "CheckReviewEnabled"
  /\ reviewEnabled' = TRUE
  /\ jevEnabled' = TRUE
  /\ gatePhase' = "JevPreScreen"
  /\ UNCHANGED <<hardHit, hasAllowOnce, gateInternalErr, parseAnomaly, gateDecision, gateStage, pendingWritten, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

SkipJevToFast ==
  /\ gatePhase = "CheckReviewEnabled"
  /\ reviewEnabled' = TRUE
  /\ jevEnabled' = FALSE
  /\ gatePhase' = "ZCodeFast"
  /\ UNCHANGED <<hardHit, hasAllowOnce, gateInternalErr, parseAnomaly, gateDecision, gateStage, pendingWritten, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

\* Jev fast pre-screen (lib/review/run.mjs:71-86): only 'pass' short-circuits to allow; flag/skip/error fall back to ZCode fast.
JevPass ==
  /\ gatePhase = "JevPreScreen"
  /\ gateDecision' = "allow"
  /\ gateStage' = "review-fast"
  /\ gatePhase' = "AutoAllowed"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, pendingWritten, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

JevFallback ==
  /\ gatePhase = "JevPreScreen"
  /\ gatePhase' = "ZCodeFast"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, gateDecision, gateStage, pendingWritten, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

\* ZCode Stage 1 fast screen (lib/review/run.mjs:89-108, lib/review/parse.mjs:19-25)
FastPass ==
  /\ gatePhase = "ZCodeFast"
  /\ gateDecision' = "allow"
  /\ gateStage' = "review-fast"
  /\ gatePhase' = "AutoAllowed"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, pendingWritten, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

FastFlag ==
  /\ gatePhase = "ZCodeFast"
  /\ gatePhase' = "ZCodeSlow"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, gateDecision, gateStage, pendingWritten, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

FastCompleteError ==
  /\ gatePhase = "ZCodeFast"
  /\ parseAnomaly' = TRUE
  /\ gateDecision' = "ask"
  /\ gateStage' = "review-failed"
  /\ pendingWritten' = TRUE
  /\ gatePhase' = "PendingHuman"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

\* ZCode Stage 2 slow review (lib/review/run.mjs:111-151, lib/review/parse.mjs:180-214)
SlowAllow ==
  /\ gatePhase = "ZCodeSlow"
  /\ gateDecision' = "allow"
  /\ gateStage' = "review-slow"
  /\ gatePhase' = "AutoAllowed"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, pendingWritten, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

SlowAsk ==
  /\ gatePhase = "ZCodeSlow"
  /\ gateDecision' = "ask"
  /\ gateStage' = "review-slow"
  /\ pendingWritten' = TRUE
  /\ gatePhase' = "PendingHuman"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

\* Cited deny in RULES is mapped to ask for human confirmation (lib/review/run.mjs:140-141, lib/gate.mjs:211-224).
SlowDenyCited ==
  /\ gatePhase = "ZCodeSlow"
  /\ gateDecision' = "ask"
  /\ gateStage' = "review-slow"
  /\ pendingWritten' = TRUE
  /\ gatePhase' = "PendingHuman"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

\* Uncited / invalid ruleId deny degrades to ask (lib/review/parse.mjs:107-113, lib/review/run.mjs:133-139).
SlowDenyUncited ==
  /\ gatePhase = "ZCodeSlow"
  /\ parseAnomaly' = TRUE
  /\ gateDecision' = "ask"
  /\ gateStage' = "review-slow"
  /\ pendingWritten' = TRUE
  /\ gatePhase' = "PendingHuman"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

\* Malformed / quoted / fenced / truncated output -> parseSlow returns undefined -> review-failed -> ask (lib/review/run.mjs:122-127).
SlowParseAnomaly ==
  /\ gatePhase = "ZCodeSlow"
  /\ parseAnomaly' = TRUE
  /\ gateDecision' = "ask"
  /\ gateStage' = "review-failed"
  /\ pendingWritten' = TRUE
  /\ gatePhase' = "PendingHuman"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

SlowCompleteError ==
  /\ gatePhase = "ZCodeSlow"
  /\ parseAnomaly' = TRUE
  /\ gateDecision' = "ask"
  /\ gateStage' = "review-failed"
  /\ pendingWritten' = TRUE
  /\ gatePhase' = "PendingHuman"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, finalWireResponse, responseActor>>
  /\ SummaryUNCHANGED

\* Gate automatically emits allow to zcode (lib/gate.mjs:204-209)
EmitAutoAllow ==
  /\ gatePhase = "AutoAllowed"
  /\ finalWireResponse' = "allow"
  /\ responseActor' = "gate"
  /\ gatePhase' = "Resolved"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, gateDecision, gateStage, pendingWritten>>
  /\ SummaryUNCHANGED

\* Human resolves pending.json via approve or deny (lib/pending.mjs:43-55,203-220)
HumanApprove ==
  /\ gatePhase = "PendingHuman"
  /\ hasAllowOnce \* permissionResponse requires allow_once to emit allow (lib/pending.mjs:46-48)
  /\ finalWireResponse' = "allow"
  /\ responseActor' = "human"
  /\ pendingWritten' = FALSE
  /\ gatePhase' = "Resolved"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, gateDecision, gateStage>>
  /\ SummaryUNCHANGED

HumanDeny ==
  /\ gatePhase = "PendingHuman"
  /\ finalWireResponse' = "deny"
  /\ responseActor' = "human"
  /\ pendingWritten' = FALSE
  /\ gatePhase' = "Resolved"
  /\ UNCHANGED <<hardHit, hasAllowOnce, reviewEnabled, jevEnabled, gateInternalErr, parseAnomaly, gateDecision, gateStage>>
  /\ SummaryUNCHANGED

-----------------------------------------------------------------------------
\* Region 2: Tool Summary inputOmitted Attribution (lib/tool-summary.mjs:166-257)

SummaryCanStep ==
  IF ChartCompact THEN gatePhase = "Resolved" ELSE TRUE

ScheduleSlot1 ==
  /\ SummaryCanStep
  /\ summaryPhase = "Collecting"
  /\ callName[1] = "Unset"
  /\ IF ChartCompact THEN
       /\ callName' = [callName EXCEPT ![1] = "Read"]
       /\ callOmitted' = [callOmitted EXCEPT ![1] = TRUE]
     ELSE
       \E name \in (ToolNames \cup (IF AllowUnnamedOmitted THEN {"None"} ELSE {})), om \in BOOLEAN :
         /\ callName' = [callName EXCEPT ![1] = name]
         /\ callOmitted' = [callOmitted EXCEPT ![1] = om]
  /\ UNCHANGED <<summaryPhase, callInput, permQueue, permSent>>
  /\ GateUNCHANGED

ScheduleSlot2 ==
  /\ SummaryCanStep
  /\ summaryPhase = "Collecting"
  /\ callName[1] # "Unset"
  /\ callName[2] = "Unset"
  /\ IF ChartCompact THEN
       /\ callName' = [callName EXCEPT ![2] = "Write"]
       /\ callOmitted' = [callOmitted EXCEPT ![2] = TRUE]
     ELSE
       \E name \in (ToolNames \cup (IF AllowUnnamedOmitted THEN {"None"} ELSE {})), om \in BOOLEAN :
         /\ callName' = [callName EXCEPT ![2] = name]
         /\ callOmitted' = [callOmitted EXCEPT ![2] = om]
  /\ UNCHANGED <<summaryPhase, callInput, permQueue, permSent>>
  /\ GateUNCHANGED

\* Authoritative model.streaming tool_call or inline tool.updated input (lib/tool-summary.mjs:196,229).
\* Note: ZCode 3.12+ emits tool.updated(inputOmitted: true) alongside model.streaming tool_call, so stream/inline
\* can arrive regardless of callOmitted[i].
ReceiveStreamOrInlineInput ==
  /\ SummaryCanStep
  /\ summaryPhase = "Collecting"
  /\ ~ChartCompact
  /\ \E i \in {1, 2}, src \in {"stream", "inline"} :
       /\ callName[i] \in ToolNames
       /\ callInput[i] = "none"
       /\ (src = "stream" \/ ~callOmitted[i])
       /\ callInput' = [callInput EXCEPT ![i] = src]
  /\ UNCHANGED <<summaryPhase, callName, callOmitted, permQueue, permSent>>
  /\ GateUNCHANGED

\* permission.requested pushes input into requestedByTool.get(toolName) (lib/tool-summary.mjs:202-209).
ReceivePermRequest ==
  /\ SummaryCanStep
  /\ summaryPhase = "Collecting"
  /\ callName[1] # "Unset"
  /\ callName[2] # "Unset"
  /\ IF ChartCompact THEN
       /\ ~permSent["Write"]
       /\ permQueue' = [permQueue EXCEPT !["Write"] = 1]
       /\ permSent' = [permSent EXCEPT !["Write"] = TRUE]
     ELSE
       \E t \in ToolNames :
         /\ ~permSent[t]
         /\ permQueue' = [permQueue EXCEPT ![t] = 1]
         /\ permSent' = [permSent EXCEPT ![t] = TRUE]
  /\ UNCHANGED <<summaryPhase, callName, callOmitted, callInput>>
  /\ GateUNCHANGED

StartBackfill ==
  /\ SummaryCanStep
  /\ summaryPhase = "Collecting"
  /\ callName[1] # "Unset"
  /\ callName[2] # "Unset"
  /\ summaryPhase' = "Backfill1"
  /\ UNCHANGED <<callName, callOmitted, callInput, permQueue, permSent>>
  /\ GateUNCHANGED

\* Backfill helper matching lib/tool-summary.mjs:233-240 (post F3 fix):
\* - Only named tools (callName[i] \in ToolNames) consume from permQueue[callName[i]].
\* - Unnamed ("None") calls never borrow from another tool's permission.requested queue.
BackfillSlot(i, nextPhase) ==
  /\ callName[i] \in {"Read", "Write", "None"}
  /\ summaryPhase' = nextPhase
  /\ IF callInput[i] = "none" /\ callOmitted[i] /\ callName[i] \in ToolNames THEN
       IF permQueue[callName[i]] > 0 THEN
         /\ callInput' = [callInput EXCEPT ![i] = IF callName[i] = "Read" THEN "perm_Read" ELSE "perm_Write"]
         /\ permQueue' = [permQueue EXCEPT ![callName[i]] = @ - 1]
       ELSE
         UNCHANGED <<callInput, permQueue>>
     ELSE
       UNCHANGED <<callInput, permQueue>>
  /\ UNCHANGED <<callName, callOmitted, permSent>>
  /\ GateUNCHANGED

BackfillSlot1 ==
  /\ summaryPhase = "Backfill1"
  /\ BackfillSlot(1, "Backfill2")

BackfillSlot2 ==
  /\ summaryPhase = "Backfill2"
  /\ BackfillSlot(2, "Emitted")

Done ==
  /\ gatePhase = "Resolved"
  /\ summaryPhase = "Emitted"
  /\ UNCHANGED vars

Next ==
  \/ ReceivePermissionRequest
  \/ HardRuleHit
  \/ HardRulePass
  \/ GateInternalError
  \/ NoAllowOnce
  \/ HasAllowOnce
  \/ ReviewDisabled
  \/ EnterJevPreScreen
  \/ SkipJevToFast
  \/ JevPass
  \/ JevFallback
  \/ FastPass
  \/ FastFlag
  \/ FastCompleteError
  \/ SlowAllow
  \/ SlowAsk
  \/ SlowDenyCited
  \/ SlowDenyUncited
  \/ SlowParseAnomaly
  \/ SlowCompleteError
  \/ EmitAutoAllow
  \/ HumanApprove
  \/ HumanDeny
  \/ ScheduleSlot1
  \/ ScheduleSlot2
  \/ ReceiveStreamOrInlineInput
  \/ ReceivePermRequest
  \/ StartBackfill
  \/ BackfillSlot1
  \/ BackfillSlot2
  \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* Invariants (safety properties, never weakened)

\* 1. Gate/Review never emits or auto-answers deny; only human can produce deny.
InvGateNeverAutoDenies ==
  /\ gateDecision # "deny"
  /\ (responseActor = "gate" => finalWireResponse # "deny")
  /\ (finalWireResponse = "deny" => responseActor = "human")

\* 2. Any parse anomaly, model error, uncited deny, or internal gate error safely degrades to ask + pending.json.
InvParseAnomalySafeAsk ==
  parseAnomaly =>
    /\ gateDecision = "ask"
    /\ (gatePhase = "PendingHuman" => pendingWritten)
    /\ responseActor # "gate"

\* 3. Hard-rule hits and missing allow_once can never be auto-allowed.
InvHardRuleAndAllowOnceGuard ==
  (gateDecision = "allow") => (~hardHit /\ hasAllowOnce /\ ~gateInternalErr)

\* 4. Named tool calls with inputOmitted only ever receive permission.requested input from the exact same toolName.
InvSameToolAttribution ==
  \A i \in {1, 2} :
    /\ (callName[i] = "Read" => callInput[i] # "perm_Write")
    /\ (callName[i] = "Write" => callInput[i] # "perm_Read")

\* 5. Unnamed omitted tool call must never consume a named tool's permission.requested input.
InvNoUnnamedSteal ==
  \A i \in {1, 2} :
    callName[i] = "None" => callInput[i] \notin {"perm_Read", "perm_Write"}

=============================================================================
