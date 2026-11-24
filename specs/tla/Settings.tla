--------------------------- MODULE Settings ---------------------------
(***************************************************************************
 Settings write in this task: only the selected chat, one version + audit.
 Commit -> settings/settings.ts:changeSetting (chat lock, version check,
           two INSERTs in db.tx); Abort -> db.ts:runTx ROLLBACK.
 Two requests race on baseVersion 0; a failed audit aborts the whole write.
 Each Commit is one DB transaction; internal INSERTs are invisible outside it.
 The spam classifiers are pure and covered by stop-phrases.test.ts.
 Code correspondence: settings.test.ts, including the audit-failure trigger,
 same-version race, per-chat isolation and the 31.10 threshold regression.
***************************************************************************)
EXTENDS Naturals, FiniteSets
CONSTANTS GuardVersion, AtomicAudit, IsolateChat
VARIABLES versions, audits, pending, committed, values
vars == <<versions, audits, pending, committed, values>>
Chats == {"target", "other"}
Init == /\ versions = [c \in Chats |-> 0]
        /\ audits = [c \in Chats |-> 0]
        /\ pending = {1, 2}
        /\ committed = 0
        /\ values = [c \in Chats |-> 600]
Commit(r) == /\ r \in pending
             /\ (GuardVersion => versions["target"] = 0)
             /\ versions' = IF IsolateChat THEN [versions EXCEPT !["target"] = @ + 1]
                            ELSE [c \in Chats |-> versions[c] + 1]
             /\ audits' = IF AtomicAudit THEN [audits EXCEPT !["target"] = @ + 1] ELSE audits
             /\ pending' = pending \ {r}
             /\ committed' = committed + 1
             /\ values' = IF IsolateChat THEN [values EXCEPT !["target"] = 460]
                          ELSE [c \in Chats |-> 460]
Abort(r) == /\ r \in pending /\ pending' = pending \ {r}
            /\ UNCHANGED <<versions, audits, committed, values>>
Next == \E r \in {1, 2}: Commit(r) \/ Abort(r)
Spec == Init /\ [][Next]_vars
TypeOK == /\ versions \in [Chats -> 0..2] /\ audits \in [Chats -> 0..2]
          /\ pending \subseteq {1, 2} /\ committed \in 0..2
          /\ values \in [Chats -> {460, 600}]
ChatIsolation == versions["other"] = 0 /\ audits["other"] = 0 /\ values["other"] = 600
AuditAtomic == versions = audits
OneVersion == committed <= 1
(* Review 450, unused delete 600; target auto may be 460 with both unchanged. *)
ActiveThresholds == values["target"] >= 450 /\ values["other"] >= 600
=============================================================================
