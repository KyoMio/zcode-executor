------------------------- MODULE TurnRunnerQueue -------------------------
\* Subsystem 1 formal model: Turn / Runner / Queue lifecycle (post F1/F2/F4 fixes + Carbon R1)
\* Covered implementation files:
\*   - lib/run.mjs (runSession, acquireSessionLock, spawn/attach, queue loop, watchers, onSignal, cancel, finally)
\*   - lib/session.mjs (attachSession, Session.send, Session.steer, Session.stop, Session.close, settleTurn)
\*   - lib/queue.mjs (MAX_ATTEMPTS, enqueue, nextQueueFile, bumpAttempts, nextSteerFile)
\*   - lib/runs.mjs (tryLinkLock, livePidOfLockFile, releaseLockIfOwned, acquireSessionLock, removeFileIfExists)
\*   - lib/gate.mjs & lib/pending.mjs (createGate, createPendingGate, close, abort, PENDING_ABORTED)
\*   - lib/providers.mjs (writePersonalProviderFile / dispose)
\*   - lib/appserver.mjs (AppServerClient.spawn / close)

EXTENDS Integers, FiniteSets

CONSTANTS
  Runners,         \* Set of runner identities, e.g. {"R1", "R2", "R3"}
  MaxAttempts,     \* MAX_ATTEMPTS = 2 (lib/queue.mjs:13)
  MaxQueue,        \* Bound on queue items (1 for single-item nominal check, 2 for timeout-reconnect check)
  AllowStaleLock,  \* TRUE exercises F1 serialized .reclaim stale-lock recovery (incl. dead .reclaim)
  AllowSignal      \* TRUE exercises F2 SIGTERM/SIGINT graceful child close & lock release

VARIABLES
  lockOwner,        \* "none" | "dead" | Runners
  reclaimOwner,     \* "none" | "dead" | Runners (F1 atomic .reclaim mutex)
  reclaimFresh,     \* BOOLEAN: whether a dead .reclaim is within RECLAIM_STALE_MS handoff window
  queueItems,       \* 0..MaxQueue
  attempts,         \* 0..(MaxAttempts + 1)
  pendingFile,      \* BOOLEAN: pending.json present on disk
  gateClosed,       \* [Runners -> BOOLEAN]: gate.close() latched at turn end
  pendingGateWedged,\* [Runners -> BOOLEAN]: unresolved waitAnswer or leaked post-close pending on active gate
  childAlive,       \* [Runners -> BOOLEAN]: detached zcode app-server process alive
  providerKeyFile,  \* [Runners -> BOOLEAN]: temp provider.json exists on disk
  rPhase,           \* [Runners -> Phase]
  rLockHeld,        \* [Runners -> BOOLEAN]
  rCancelSeen,      \* [Runners -> BOOLEAN]
  rSignaled,        \* [Runners -> BOOLEAN]
  rSteerState,      \* [Runners -> {"none", "queued", "drained", "failed"}]
  rTurnActive,      \* [Runners -> BOOLEAN]
  rTurnOutcome,     \* [Runners -> {"none", "done", "cancelled", "timeout", "exited", "dropped", "spawn_err"}]
  rLastOutcome      \* [Runners -> {"none", "done", "cancelled", "timeout", "exited", "failed"}]

vars == <<
  lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed,
  pendingGateWedged, childAlive, providerKeyFile, rPhase, rLockHeld, rCancelSeen,
  rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome
>>

Phases == {
  "Idle",
  "ObservedDeadLock",
  "ReclaimLockHeld",
  "ReclaimVerifiedDead",
  "ReclaimUnlinked",
  "LockHeld",
  "Connected",
  "CheckingAttempts",
  "Running",
  "Blocked",
  "SteerQueued",
  "Cancelling",
  "TimedOut",
  "Reconnecting",
  "Cleaning",
  "SignalClosing",
  "Settled",
  "Cancelled",
  "TimeoutSettled",
  "Exited",
  "Failed"
}

TerminalPhases == {"Settled", "Cancelled", "TimeoutSettled", "Exited", "Failed"}

TypeOK ==
  /\ lockOwner \in ({"none", "dead"} \cup Runners)
  /\ reclaimOwner \in ({"none", "dead"} \cup Runners)
  /\ reclaimFresh \in BOOLEAN
  /\ queueItems \in 0..MaxQueue
  /\ attempts \in 0..(MaxAttempts + 1)
  /\ pendingFile \in BOOLEAN
  /\ gateClosed \in [Runners -> BOOLEAN]
  /\ pendingGateWedged \in [Runners -> BOOLEAN]
  /\ childAlive \in [Runners -> BOOLEAN]
  /\ providerKeyFile \in [Runners -> BOOLEAN]
  /\ rPhase \in [Runners -> Phases]
  /\ rLockHeld \in [Runners -> BOOLEAN]
  /\ rCancelSeen \in [Runners -> BOOLEAN]
  /\ rSignaled \in [Runners -> BOOLEAN]
  /\ rSteerState \in [Runners -> {"none", "queued", "drained", "failed"}]
  /\ rTurnActive \in [Runners -> BOOLEAN]
  /\ rTurnOutcome \in [Runners -> {"none", "done", "cancelled", "timeout", "exited", "dropped", "spawn_err"}]
  /\ rLastOutcome \in [Runners -> {"none", "done", "cancelled", "timeout", "exited", "failed"}]

Init ==
  /\ lockOwner \in (IF AllowStaleLock THEN {"none", "dead"} ELSE {"none"})
  /\ reclaimOwner \in (IF AllowStaleLock THEN {"none", "dead"} ELSE {"none"})
  /\ reclaimFresh \in (IF AllowStaleLock THEN BOOLEAN ELSE {FALSE})
  /\ queueItems = MaxQueue
  /\ attempts = 0
  /\ pendingFile = FALSE
  /\ gateClosed = [r \in Runners |-> FALSE]
  /\ pendingGateWedged = [r \in Runners |-> FALSE]
  /\ childAlive = [r \in Runners |-> FALSE]
  /\ providerKeyFile = [r \in Runners |-> FALSE]
  /\ rPhase = [r \in Runners |-> "Idle"]
  /\ rLockHeld = [r \in Runners |-> FALSE]
  /\ rCancelSeen = [r \in Runners |-> FALSE]
  /\ rSignaled = [r \in Runners |-> FALSE]
  /\ rSteerState = [r \in Runners |-> "none"]
  /\ rTurnActive = [r \in Runners |-> FALSE]
  /\ rTurnOutcome = [r \in Runners |-> "none"]
  /\ rLastOutcome = [r \in Runners |-> "none"]

-----------------------------------------------------------------------------
\* 1. Lock acquisition (lib/run.mjs:152, lib/runs.mjs:tryLinkLock & acquireSessionLock)

\* Fast-path atomic linkSync succeeds when no lock exists.
TryAcquireLockSuccess ==
  \E r \in Runners :
    /\ rPhase[r] = "Idle"
    /\ lockOwner = "none"
    /\ lockOwner' = r
    /\ rLockHeld' = [rLockHeld EXCEPT ![r] = TRUE]
    /\ rPhase' = [rPhase EXCEPT ![r] = "LockHeld"]
    /\ pendingFile' = FALSE
    /\ UNCHANGED <<reclaimOwner, reclaimFresh, queueItems, attempts, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

\* Contention on a live lock owner -> runner throws ExecutorError(2) without touching lock or files.
TryAcquireLockContendedLive ==
  \E r \in Runners :
    /\ rPhase[r] = "Idle"
    /\ lockOwner \in Runners
    /\ rPhase' = [rPhase EXCEPT ![r] = "Failed"]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "failed"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome>>

\* Step 1 of stale-lock recovery: livePidOfLockFile observes dead PID (lib/runs.mjs).
ObserveDeadLock ==
  \E r \in Runners :
    /\ AllowStaleLock
    /\ rPhase[r] = "Idle"
    /\ lockOwner = "dead"
    /\ rPhase' = [rPhase EXCEPT ![r] = "ObservedDeadLock"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

\* Step 2a (F1 fix): acquire atomic .reclaim mutex via tryLinkLock(reclaimPath),
\* or recover an aged (non-fresh) dead .reclaim after ageMs >= RECLAIM_STALE_MS.
AcquireReclaimLock ==
  \E r \in Runners :
    /\ AllowStaleLock
    /\ rPhase[r] = "ObservedDeadLock"
    /\ (reclaimOwner = "none" \/ (reclaimOwner = "dead" /\ ~reclaimFresh))
    /\ reclaimOwner' = r
    /\ reclaimFresh' = TRUE
    /\ rPhase' = [rPhase EXCEPT ![r] = "ReclaimLockHeld"]
    /\ UNCHANGED <<lockOwner, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

\* Step 2b (F1 fix): live .reclaim OR fresh dead .reclaim inside handoff window -> abort cleanly without unlinking .reclaim.
AcquireReclaimContended ==
  \E r \in Runners :
    /\ AllowStaleLock
    /\ rPhase[r] = "ObservedDeadLock"
    /\ (reclaimOwner \in Runners \/ (reclaimOwner = "dead" /\ reclaimFresh))
    /\ rPhase' = [rPhase EXCEPT ![r] = "Failed"]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "failed"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome>>

\* Step 3a (F1 fix): inside .reclaim, recheck livePidOfLockFile sees a live owner -> release .reclaim and abort.
ReverifyLiveAndAbort ==
  \E r \in Runners :
    /\ AllowStaleLock
    /\ rPhase[r] = "ReclaimLockHeld"
    /\ lockOwner \in Runners
    /\ reclaimOwner' = IF reclaimOwner = r THEN "none" ELSE reclaimOwner
    /\ rPhase' = [rPhase EXCEPT ![r] = "Failed"]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "failed"]
    /\ UNCHANGED <<lockOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome>>

\* Step 3b (F1 fix): inside .reclaim (ownership rechecked), recheck livePidOfLockFile sees dead/missing lock.
ReverifyDead ==
  \E r \in Runners :
    /\ AllowStaleLock
    /\ rPhase[r] = "ReclaimLockHeld"
    /\ reclaimOwner = r
    /\ lockOwner \notin Runners
    /\ rPhase' = [rPhase EXCEPT ![r] = "ReclaimVerifiedDead"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

\* Step 3c (F1 fix): removeFileIfExists(lockPath) runs as a separate syscall after ReverifyDead.
UnlinkDeadLock ==
  \E r \in Runners :
    /\ AllowStaleLock
    /\ rPhase[r] = "ReclaimVerifiedDead"
    /\ lockOwner' = "none"
    /\ rPhase' = [rPhase EXCEPT ![r] = "ReclaimUnlinked"]
    /\ UNCHANGED <<reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

\* Step 4a (F1 fix): atomic tryLinkLock(lockPath) succeeds after unlink, then finally releases .reclaim.
ReacquireAfterUnlinkSuccess ==
  \E r \in Runners :
    /\ AllowStaleLock
    /\ rPhase[r] = "ReclaimUnlinked"
    /\ lockOwner = "none"
    /\ lockOwner' = r
    /\ rLockHeld' = [rLockHeld EXCEPT ![r] = TRUE]
    /\ reclaimOwner' = IF reclaimOwner = r THEN "none" ELSE reclaimOwner
    /\ pendingFile' = FALSE
    /\ rPhase' = [rPhase EXCEPT ![r] = "LockHeld"]
    /\ UNCHANGED <<reclaimFresh, queueItems, attempts, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

\* Step 4b (F1 fix): fast-path runner grabbed lockPath between UnlinkDeadLock and tryLinkLock -> lose cleanly and release .reclaim.
ReacquireAfterUnlinkLost ==
  \E r \in Runners :
    /\ AllowStaleLock
    /\ rPhase[r] = "ReclaimUnlinked"
    /\ lockOwner # "none"
    /\ reclaimOwner' = IF reclaimOwner = r THEN "none" ELSE reclaimOwner
    /\ rPhase' = [rPhase EXCEPT ![r] = "Failed"]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "failed"]
    /\ UNCHANGED <<lockOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome>>

-----------------------------------------------------------------------------
\* 2. Provider temp file + AppServerClient.spawn + attachSession (lib/run.mjs:243-260,349-378)

SpawnAndAttach ==
  \E r \in Runners :
    /\ rPhase[r] = "LockHeld"
    /\ ~rSignaled[r]
    /\ providerKeyFile' = [providerKeyFile EXCEPT ![r] = TRUE]
    /\ childAlive' = [childAlive EXCEPT ![r] = TRUE]
    /\ gateClosed' = [gateClosed EXCEPT ![r] = FALSE]
    /\ pendingGateWedged' = [pendingGateWedged EXCEPT ![r] = FALSE]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Connected"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

SpawnOrAttachFail ==
  \E r \in Runners, spawned \in BOOLEAN :
    /\ rPhase[r] = "LockHeld"
    /\ ~rSignaled[r]
    /\ providerKeyFile' = [providerKeyFile EXCEPT ![r] = TRUE]
    /\ childAlive' = [childAlive EXCEPT ![r] = spawned]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Cleaning"]
    /\ rTurnOutcome' = [rTurnOutcome EXCEPT ![r] = "spawn_err"]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "failed"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive>>

-----------------------------------------------------------------------------
\* 3. Queue consumption & turn start (lib/run.mjs:384-457, lib/queue.mjs:48-71)

TakeQueueItem ==
  \E r \in Runners :
    /\ rPhase[r] = "Connected"
    /\ ~rSignaled[r]
    /\ queueItems > 0
    /\ attempts <= MaxAttempts
    /\ attempts' = attempts + 1
    /\ rPhase' = [rPhase EXCEPT ![r] = "CheckingAttempts"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

StartTurn ==
  \E r \in Runners :
    /\ rPhase[r] = "CheckingAttempts"
    /\ ~rSignaled[r]
    /\ attempts <= MaxAttempts
    /\ rTurnActive' = [rTurnActive EXCEPT ![r] = TRUE]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Running"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnOutcome, rLastOutcome>>

DropMaxAttempts ==
  \E r \in Runners :
    /\ rPhase[r] = "CheckingAttempts"
    /\ ~rSignaled[r]
    /\ attempts > MaxAttempts
    /\ queueItems' = queueItems - 1
    /\ rTurnOutcome' = [rTurnOutcome EXCEPT ![r] = "dropped"]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "failed"]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Connected"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive>>

QueueEmptyFinish ==
  \E r \in Runners :
    /\ rPhase[r] = "Connected"
    /\ ~rSignaled[r]
    /\ queueItems = 0
    /\ rPhase' = [rPhase EXCEPT ![r] = "Cleaning"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

-----------------------------------------------------------------------------
\* 4. Mid-turn transitions: Pending gate & Steer (lib/run.mjs:268-334,415-452; lib/session.mjs:268-282)

EnterBlocked ==
  \E r \in Runners :
    /\ rPhase[r] = "Running"
    /\ rTurnActive[r]
    /\ ~gateClosed[r]
    /\ ~pendingGateWedged[r]
    /\ pendingFile' = TRUE
    /\ rPhase' = [rPhase EXCEPT ![r] = "Blocked"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

BlockedOnWedgedGate ==
  \E r \in Runners :
    /\ rPhase[r] = "Running"
    /\ rTurnActive[r]
    /\ pendingGateWedged[r]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Blocked"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

AnswerBlocked ==
  \E r \in Runners :
    /\ rPhase[r] = "Blocked"
    /\ ~pendingGateWedged[r]
    /\ pendingFile' = FALSE
    /\ rPhase' = [rPhase EXCEPT ![r] = "Running"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

\* In-flight review() fallback or queued tail entry arriving after gate.close():
\* Because gateClosed[r] is latched TRUE, gate.mjs & pending.mjs reject with PENDING_ABORTED without writing pending.json.
LateReviewFallbackBlockedByClose ==
  \E r \in Runners :
    /\ rPhase[r] \in {"Reconnecting", "Cleaning"}
    /\ gateClosed[r]
    /\ UNCHANGED vars

SendSteer ==
  \E r \in Runners :
    /\ rPhase[r] = "Running"
    /\ rTurnActive[r]
    /\ rSteerState[r] = "none"
    /\ rSteerState' = [rSteerState EXCEPT ![r] = "queued"]
    /\ rPhase' = [rPhase EXCEPT ![r] = "SteerQueued"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rTurnActive, rTurnOutcome, rLastOutcome>>

DrainSteer ==
  \E r \in Runners :
    /\ rPhase[r] = "SteerQueued"
    /\ rSteerState' = [rSteerState EXCEPT ![r] = "drained"]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Running"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rTurnActive, rTurnOutcome, rLastOutcome>>

SteerStartNowFail ==
  \E r \in Runners :
    /\ rPhase[r] = "SteerQueued"
    /\ rSteerState' = [rSteerState EXCEPT ![r] = "failed"]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Running"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rTurnActive, rTurnOutcome, rLastOutcome>>

-----------------------------------------------------------------------------
\* 5. Cancel, Timeout, Completion, and Child Crash

TriggerCancel ==
  \E r \in Runners :
    /\ (rPhase[r] \in {"Running", "SteerQueued"} \/ (rPhase[r] = "Blocked" /\ ~pendingGateWedged[r]))
    /\ rCancelSeen' = [rCancelSeen EXCEPT ![r] = TRUE]
    /\ pendingFile' = FALSE
    /\ rPhase' = [rPhase EXCEPT ![r] = "Cancelling"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

CancelSettleCancelled ==
  \E r \in Runners :
    /\ rPhase[r] = "Cancelling"
    /\ ~rSignaled[r]
    /\ queueItems' = IF queueItems > 0 THEN queueItems - 1 ELSE 0
    /\ gateClosed' = [gateClosed EXCEPT ![r] = TRUE]
    /\ rTurnActive' = [rTurnActive EXCEPT ![r] = FALSE]
    /\ rTurnOutcome' = [rTurnOutcome EXCEPT ![r] = "cancelled"]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "cancelled"]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Cleaning"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, attempts, pendingFile, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState>>

CancelSettleRacedDone ==
  \E r \in Runners :
    /\ rPhase[r] = "Cancelling"
    /\ ~rSignaled[r]
    /\ queueItems' = IF queueItems > 0 THEN queueItems - 1 ELSE 0
    /\ gateClosed' = [gateClosed EXCEPT ![r] = TRUE]
    /\ rTurnActive' = [rTurnActive EXCEPT ![r] = FALSE]
    /\ rTurnOutcome' = [rTurnOutcome EXCEPT ![r] = "done"]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "done"]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Cleaning"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, attempts, pendingFile, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState>>

TurnCompleteSuccess ==
  \E r \in Runners :
    /\ rPhase[r] \in {"Running", "SteerQueued"}
    /\ ~rCancelSeen[r]
    /\ ~rSignaled[r]
    /\ queueItems' = IF queueItems > 0 THEN queueItems - 1 ELSE 0
    /\ gateClosed' = [gateClosed EXCEPT ![r] = TRUE]
    /\ rTurnActive' = [rTurnActive EXCEPT ![r] = FALSE]
    /\ rTurnOutcome' = [rTurnOutcome EXCEPT ![r] = "done"]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "done"]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Connected"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, attempts, pendingFile, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState>>

TurnTimeout ==
  \E r \in Runners :
    /\ rPhase[r] \in {"Running", "Blocked", "SteerQueued"}
    /\ ~rCancelSeen[r]
    /\ rPhase' = [rPhase EXCEPT ![r] = "TimedOut"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

\* F4 fix (lib/run.mjs + lib/pending.mjs + lib/gate.mjs):
\* session.send().finally() calls gate.close() (aborting pending, rejecting tail & late review fallbacks),
\* then on timeout breaks out of inner loop: if more items remain, closes old connection and reconnects with a fresh gate!
SettleTimeout ==
  \E r \in Runners :
    /\ rPhase[r] = "TimedOut"
    /\ ~rSignaled[r]
    /\ LET rem == IF queueItems > 0 THEN queueItems - 1 ELSE 0 IN
       /\ queueItems' = rem
       /\ gateClosed' = [gateClosed EXCEPT ![r] = TRUE]
       /\ pendingGateWedged' = [pendingGateWedged EXCEPT ![r] = FALSE]
       /\ pendingFile' = FALSE
       /\ rTurnActive' = [rTurnActive EXCEPT ![r] = FALSE]
       /\ rTurnOutcome' = [rTurnOutcome EXCEPT ![r] = "timeout"]
       /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "timeout"]
       /\ rPhase' = [rPhase EXCEPT ![r] = IF rem > 0 THEN "Reconnecting" ELSE "Cleaning"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, attempts, childAlive, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState>>

CloseForReconnect ==
  \E r \in Runners :
    /\ rPhase[r] = "Reconnecting"
    /\ ~rSignaled[r]
    /\ childAlive' = [childAlive EXCEPT ![r] = FALSE]
    /\ providerKeyFile' = [providerKeyFile EXCEPT ![r] = FALSE]
    /\ rPhase' = [rPhase EXCEPT ![r] = "LockHeld"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, gateClosed, pendingGateWedged, rLockHeld, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

ChildCrash ==
  \E r \in Runners :
    /\ rPhase[r] \in {"Running", "Blocked", "SteerQueued"}
    /\ ~rCancelSeen[r]
    /\ ~rSignaled[r]
    /\ childAlive' = [childAlive EXCEPT ![r] = FALSE]
    /\ gateClosed' = [gateClosed EXCEPT ![r] = TRUE]
    /\ pendingFile' = FALSE
    /\ pendingGateWedged' = [pendingGateWedged EXCEPT ![r] = FALSE]
    /\ rTurnActive' = [rTurnActive EXCEPT ![r] = FALSE]
    /\ rTurnOutcome' = [rTurnOutcome EXCEPT ![r] = "exited"]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "exited"]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Cleaning"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, providerKeyFile, rLockHeld, rCancelSeen, rSignaled, rSteerState>>

-----------------------------------------------------------------------------
\* 6. Cleanup & Signal paths (lib/run.mjs:545-563, 103-146)

FinallyCleanup ==
  \E r \in Runners :
    /\ rPhase[r] = "Cleaning"
    /\ ~rSignaled[r] \* F2 fix: signaled path hands exclusive cleanup ownership to onSignal
    /\ childAlive' = [childAlive EXCEPT ![r] = FALSE]
    /\ providerKeyFile' = [providerKeyFile EXCEPT ![r] = FALSE]
    /\ pendingGateWedged' = [pendingGateWedged EXCEPT ![r] = FALSE]
    /\ pendingFile' = FALSE
    /\ lockOwner' = IF lockOwner = r /\ rLockHeld[r] THEN "none" ELSE lockOwner
    /\ rLockHeld' = [rLockHeld EXCEPT ![r] = FALSE]
    /\ rPhase' = [rPhase EXCEPT ![r] =
         CASE rTurnOutcome[r] = "done"      -> "Settled"
           [] rTurnOutcome[r] = "cancelled" -> "Cancelled"
           [] rTurnOutcome[r] = "timeout"   -> "TimeoutSettled"
           [] rTurnOutcome[r] = "exited"    -> "Exited"
           [] rTurnOutcome[r] = "dropped"   -> "Failed"
           [] rTurnOutcome[r] = "spawn_err" -> "Failed"
           [] OTHER -> "Settled"]
    /\ UNCHANGED <<reclaimOwner, reclaimFresh, queueItems, attempts, gateClosed, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

\* F2 fix (lib/run.mjs:onSignal): works from LockHeld (spawn window) through Running/Blocked/SteerQueued/Reconnecting,
\* sets rSignaled[r] so runSession finally & queue loop halt, keeps lock held until child closes.
ReceiveSignal ==
  \E r \in Runners :
    /\ AllowSignal
    /\ ~rSignaled[r]
    /\ rPhase[r] \in {"LockHeld", "Connected", "CheckingAttempts", "Running", "Blocked", "SteerQueued", "Cancelling", "TimedOut", "Reconnecting"}
    /\ rSignaled' = [rSignaled EXCEPT ![r] = TRUE]
    /\ rCancelSeen' = [rCancelSeen EXCEPT ![r] = TRUE]
    /\ gateClosed' = [gateClosed EXCEPT ![r] = TRUE]
    /\ rTurnActive' = [rTurnActive EXCEPT ![r] = FALSE]
    /\ rLastOutcome' = [rLastOutcome EXCEPT ![r] = "cancelled"]
    /\ rPhase' = [rPhase EXCEPT ![r] = "SignalClosing"]
    /\ UNCHANGED <<lockOwner, reclaimOwner, reclaimFresh, queueItems, attempts, pendingFile, pendingGateWedged, childAlive, providerKeyFile, rLockHeld, rSteerState, rTurnOutcome>>

SignalCleanupExit ==
  \E r \in Runners :
    /\ AllowSignal
    /\ rPhase[r] = "SignalClosing"
    /\ childAlive' = [childAlive EXCEPT ![r] = FALSE]
    /\ providerKeyFile' = [providerKeyFile EXCEPT ![r] = FALSE]
    /\ pendingFile' = FALSE
    /\ pendingGateWedged' = [pendingGateWedged EXCEPT ![r] = FALSE]
    /\ lockOwner' = IF lockOwner = r /\ rLockHeld[r] THEN "none" ELSE lockOwner
    /\ rLockHeld' = [rLockHeld EXCEPT ![r] = FALSE]
    /\ rPhase' = [rPhase EXCEPT ![r] = "Cancelled"]
    /\ UNCHANGED <<reclaimOwner, reclaimFresh, queueItems, attempts, gateClosed, rCancelSeen, rSignaled, rSteerState, rTurnActive, rTurnOutcome, rLastOutcome>>

Done ==
  /\ \A r \in Runners : rPhase[r] \in TerminalPhases
  /\ UNCHANGED vars

Next ==
  \/ TryAcquireLockSuccess
  \/ TryAcquireLockContendedLive
  \/ ObserveDeadLock
  \/ AcquireReclaimLock
  \/ AcquireReclaimContended
  \/ ReverifyLiveAndAbort
  \/ ReverifyDead
  \/ UnlinkDeadLock
  \/ ReacquireAfterUnlinkSuccess
  \/ ReacquireAfterUnlinkLost
  \/ SpawnAndAttach
  \/ SpawnOrAttachFail
  \/ TakeQueueItem
  \/ StartTurn
  \/ DropMaxAttempts
  \/ QueueEmptyFinish
  \/ EnterBlocked
  \/ BlockedOnWedgedGate
  \/ AnswerBlocked
  \/ LateReviewFallbackBlockedByClose
  \/ SendSteer
  \/ DrainSteer
  \/ SteerStartNowFail
  \/ TriggerCancel
  \/ CancelSettleCancelled
  \/ CancelSettleRacedDone
  \/ TurnCompleteSuccess
  \/ TurnTimeout
  \/ SettleTimeout
  \/ CloseForReconnect
  \/ ChildCrash
  \/ FinallyCleanup
  \/ ReceiveSignal
  \/ SignalCleanupExit
  \/ Done

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* Invariants (safety properties, never weakened)

InvMutexSingleLockHolder ==
  Cardinality({ r \in Runners : rLockHeld[r] }) <= 1

InvMutexAtMostOneActiveTurn ==
  Cardinality({ r \in Runners : rTurnActive[r] }) <= 1

InvTerminalReleasesLock ==
  \A r \in Runners :
    rPhase[r] \in TerminalPhases => (~rLockHeld[r] /\ lockOwner # r /\ reclaimOwner # r)

InvTerminalZeroOrphans ==
  \A r \in Runners :
    rPhase[r] \in TerminalPhases => ~childAlive[r]

InvTerminalZeroTempKeyFiles ==
  \A r \in Runners :
    rPhase[r] \in TerminalPhases => ~providerKeyFile[r]

InvTerminalNoActiveTurn ==
  \A r \in Runners :
    rPhase[r] \in TerminalPhases => ~rTurnActive[r]

InvSteerCancelExplicitSettlement ==
  \A r \in Runners :
    (rPhase[r] \in TerminalPhases /\ rCancelSeen[r] /\ rSteerState[r] = "queued")
      => (rLastOutcome[r] \in {"cancelled", "done"} /\ rPhase[r] \in {"Cancelled", "Settled"})

InvQueueAttemptBound ==
  \A r \in Runners : rTurnActive[r] => attempts <= MaxAttempts

InvNoWedgedGate ==
  \A r \in Runners :
    /\ (rPhase[r] = "Blocked" => ~pendingGateWedged[r])
    /\ ((lockOwner = r /\ gateClosed[r]) => ~pendingFile)

=============================================================================
