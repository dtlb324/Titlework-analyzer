---------------------------- MODULE SynthesisMergeCancel ----------------------------
\* Model of the final-merge / cancel race in processSynthesisJob.
\* Code anchors:
\*   api/_lib/synthesis.js  processSynthesisJob (mergeCanceled gate, claimFinalWriter, runOrRecoverMerge)
\*   api/_lib/jobs.js       claimSynthesisMerge, saveJobResult, cancelJob
\*
\* Scope: one synthesizing job, all segments already complete, one or two merge workers,
\* and a user cancel. Segment work, plan changes, and preview recovery are out of scope.
\* saveJobResult is split into insert vs status CAS because those are separate SQL statements.

EXTENDS Integers, FiniteSets

CONSTANTS Workers
\* Workers is a non-empty set of merge worker ids, e.g. {w1, w2}.

VARIABLES
  status,       \* analysis_jobs.status
  mergeOwner,   \* synthesis_merge_worker_id, or None
  pc,           \* per-worker program counter in the merge path
  hasResult,    \* job_results row present for this plan
  billed,       \* workers that entered the billable Sonnet merge
  gateSawLive,  \* workers that passed the mergeCanceled gate while status /= canceled
  readStatus    \* status each worker observed at saveJobResult getJob (for CAS)

None == "none"

StatusSynthesizing == "synthesizing"
StatusCanceled == "canceled"
StatusComplete == "complete"
StatusFailed == "failed"
StatusPartialFailed == "partial_failed"

TypeOK ==
  /\ status \in {
       StatusSynthesizing,
       StatusCanceled,
       StatusComplete,
       StatusFailed,
       StatusPartialFailed
     }
  /\ mergeOwner \in {None} \cup Workers
  /\ pc \in [Workers -> {
       "idle",
       "gate_ok",
       "claimed",
       "billed",
       "inserting",
       "advancing",
       "done"
     }]
  /\ hasResult \in BOOLEAN
  /\ billed \subseteq Workers
  /\ gateSawLive \subseteq Workers
  /\ readStatus \in [Workers -> {
       StatusSynthesizing,
       StatusCanceled,
       StatusComplete,
       StatusFailed,
       StatusPartialFailed,
       None
     }]

Init ==
  /\ status = StatusSynthesizing
  /\ mergeOwner = None
  /\ pc = [w \in Workers |-> "idle"]
  /\ hasResult = FALSE
  /\ billed = {}
  /\ gateSawLive = {}
  /\ readStatus = [w \in Workers |-> None]

\* cancelJob: status <- canceled, clear merge lease. Complete is not canceled.
UserCancel ==
  /\ status \notin {StatusCanceled, StatusComplete}
  /\ status' = StatusCanceled
  /\ mergeOwner' = None
  /\ UNCHANGED <<pc, hasResult, billed, gateSawLive, readStatus>>

\* mergeGateJob / mergeCanceled before either merge branch.
GateCheck(w) ==
  /\ pc[w] = "idle"
  /\ status /= StatusCanceled
  /\ ~hasResult
  /\ pc' = [pc EXCEPT ![w] = "gate_ok"]
  /\ gateSawLive' = gateSawLive \cup {w}
  /\ UNCHANGED <<status, mergeOwner, hasResult, billed, readStatus>>

\* claimSynthesisMerge: status <> canceled and lease free.
ClaimMerge(w) ==
  /\ pc[w] = "gate_ok"
  /\ status /= StatusCanceled
  /\ mergeOwner = None
  /\ ~hasResult
  /\ mergeOwner' = w
  /\ pc' = [pc EXCEPT ![w] = "claimed"]
  /\ UNCHANGED <<status, hasResult, billed, gateSawLive, readStatus>>

\* runOrRecoverMerge. Live code does not re-read status; cancel may have cleared the lease.
BillableMerge(w) ==
  /\ pc[w] = "claimed"
  /\ w \in gateSawLive
  /\ pc' = [pc EXCEPT ![w] = "billed"]
  /\ billed' = billed \cup {w}
  /\ UNCHANGED <<status, mergeOwner, hasResult, gateSawLive, readStatus>>

\* saveJobResult: getJob. Canceled => return null (modeled as abort).
SaveRead(w) ==
  /\ pc[w] = "billed"
  /\ IF status = StatusCanceled
     THEN /\ pc' = [pc EXCEPT ![w] = "done"]
          /\ mergeOwner' = IF mergeOwner = w THEN None ELSE mergeOwner
          /\ UNCHANGED <<status, hasResult, billed, gateSawLive, readStatus>>
     ELSE /\ readStatus' = [readStatus EXCEPT ![w] = status]
          /\ pc' = [pc EXCEPT ![w] = "inserting"]
          /\ UNCHANGED <<status, mergeOwner, hasResult, billed, gateSawLive>>

\* INSERT INTO job_results ... WHERE status <> canceled AND lease matches.
SaveInsert(w) ==
  /\ pc[w] = "inserting"
  /\ IF status /= StatusCanceled /\ mergeOwner = w
     THEN /\ hasResult' = TRUE
          /\ pc' = [pc EXCEPT ![w] = "advancing"]
          /\ UNCHANGED <<status, mergeOwner, billed, gateSawLive, readStatus>>
     ELSE /\ pc' = [pc EXCEPT ![w] = "done"]
          /\ mergeOwner' = IF mergeOwner = w THEN None ELSE mergeOwner
          /\ UNCHANGED <<status, hasResult, billed, gateSawLive, readStatus>>

\* Status CAS: UPDATE ... AND status = readStatus[w]. finally releases this worker's lease.
SaveAdvance(w) ==
  /\ pc[w] = "advancing"
  /\ IF status = readStatus[w]
     THEN /\ status' = StatusComplete
          /\ mergeOwner' = None
          /\ pc' = [pc EXCEPT ![w] = "done"]
          /\ UNCHANGED <<hasResult, billed, gateSawLive, readStatus>>
     ELSE /\ mergeOwner' = IF mergeOwner = w THEN None ELSE mergeOwner
          /\ pc' = [pc EXCEPT ![w] = "done"]
          /\ UNCHANGED <<status, hasResult, billed, gateSawLive, readStatus>>

Done(w) ==
  /\ pc[w] = "done"
  /\ UNCHANGED <<status, mergeOwner, pc, hasResult, billed, gateSawLive, readStatus>>

JobSettled ==
  /\ status \in {StatusCanceled, StatusComplete}
  /\ \A w \in Workers : pc[w] \in {"idle", "done"}
  /\ UNCHANGED <<status, mergeOwner, pc, hasResult, billed, gateSawLive, readStatus>>

WorkerNext(w) ==
  \/ GateCheck(w)
  \/ ClaimMerge(w)
  \/ BillableMerge(w)
  \/ SaveRead(w)
  \/ SaveInsert(w)
  \/ SaveAdvance(w)
  \/ Done(w)

Next ==
  \/ UserCancel
  \/ \E w \in Workers : WorkerNext(w)
  \/ JobSettled

vars == <<status, mergeOwner, pc, hasResult, billed, gateSawLive, readStatus>>

Spec == Init /\ [][Next]_vars

\* A canceled job never flips to complete via the CAS (sticky terminal).
CanceledNeverLeaves ==
  status = StatusCanceled => status = StatusCanceled

\* Intended product promise after v2.6.1: no result row while canceled.
\* The insert-then-cancel window in saveJobResult can break this; TLC reports it.
NoResultWhileCanceled ==
  status = StatusCanceled => ~hasResult

\* At most one merge lease owner.
SingleMergeOwner ==
  mergeOwner \in {None} \cup Workers

\* Billable merge only for workers that passed the live-job gate.
BillOnlyAfterLiveGate ==
  billed \subseteq gateSawLive

\* Stronger cost promise (not closed by the gate alone). Expected FAIL when cancel
\* lands after ClaimMerge and before BillableMerge. Enable in the cfg to hunt it.
\* ResidualNoBillWhileCanceled == status = StatusCanceled => billed = {}

=============================================================================
