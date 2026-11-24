----------------------------- MODULE Gate -----------------------------
(***************************************************************************)
(* Вход по заявке (решение владельца 24.11): одна проверка с лягушонком    *)
(* против срока, входа, одобренного админом руками, и двух отправителей    *)
(* ответа в Telegram (веб сразу после нажатия и бот по тику).              *)
(*                                                                         *)
(* Действие модели -> код:                                                 *)
(*   Pick       -> src/gate.ts:pick (UPDATE ... WHERE status = 'pending')  *)
(*   Timeout    -> src/gate.ts:expireChecks (тот же условный UPDATE)       *)
(*   AdminOk    -> админ одобрил заявку в Telegram сам                     *)
(*   AdminNo    -> админ отклонил заявку в Telegram сам                    *)
(*   JoinSeen   -> src/gate.ts:joinedChat (chat_member, условный UPDATE)   *)
(*   Expire     -> query_id стража протух (10 секунд и дольше)             *)
(*   Claim      -> src/gate.ts:claimSend (send todo или аренда истекла)    *)
(*   LeaseOver  -> аренда 30 секунд истекла у медленного отправителя       *)
(*   Call       -> src/gate.ts:callTelegram: query_id, при отказе - вызов  *)
(*                 по заявке (approve/declineChatJoinRequest)              *)
(*   CallFail   -> сеть или 5xx: send снова todo, повтор позже             *)
(*   Finish     -> src/gate.ts:finishSend (только у владельца аренды)      *)
(*                                                                         *)
(* Допущения: шаг - одна транзакция или один вызов Telegram; вызов по      *)
(* query_id и запасной вызов по заявке в одном шаге Call. Telegram         *)
(* применяет решение только к открытой заявке, иначе отвечает ошибкой.     *)
(* Вне модели: лимит трёх проверок в сутки, личка (та же отправка без      *)
(* query_id), разбан кнопкой (своя модель Appeal).                         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Cas,       \* решение меняет только pending
          Fallback   \* протухший query_id - вызов по самой заявке

Senders == {"web", "bot"}

VARIABLES status,    \* pending | passed | failed | timeout | gone
          send,      \* none | todo | sending | done
          owner,     \* кто держит аренду: none | web | bot
          leaseOver, \* аренда истекла
          pc,        \* у отправителя: idle | call | finish
          tg,        \* заявка в Telegram: open | approved | declined
          alive,     \* query_id ещё действует
          joined,    \* пришёл chat_member о входе
          decisions, \* сколько раз решение сменило pending
          calls,     \* успешные вызовы бота
          sent       \* что бот применил в Telegram: none | approve | decline

vars == <<status, send, owner, leaseOver, pc, tg, alive, joined, decisions, calls, sent>>

Init == /\ status = "pending" /\ send = "none" /\ owner = "none" /\ leaseOver = FALSE
        /\ pc = [d \in Senders |-> "idle"] /\ tg = "open" /\ alive = TRUE
        /\ joined = FALSE /\ decisions = 0 /\ calls = 0 /\ sent = "none"

Open == IF Cas THEN status = "pending" ELSE decisions < 3

Decide(s, toSend) == /\ status' = s /\ decisions' = decisions + 1
                     /\ send' = IF toSend THEN "todo" ELSE send

Pick == /\ Open
        /\ \E ok \in BOOLEAN : Decide(IF ok THEN "passed" ELSE "failed", TRUE)
        /\ UNCHANGED <<owner, leaseOver, pc, tg, alive, joined, calls, sent>>

Timeout == /\ Open /\ Decide("timeout", TRUE)
           /\ UNCHANGED <<owner, leaseOver, pc, tg, alive, joined, calls, sent>>

AdminOk == /\ tg = "open" /\ tg' = "approved" /\ joined' = TRUE
           /\ UNCHANGED <<status, send, owner, leaseOver, pc, alive, decisions, calls, sent>>

AdminNo == /\ tg = "open" /\ tg' = "declined"
           /\ UNCHANGED <<status, send, owner, leaseOver, pc, alive, joined, decisions, calls, sent>>

JoinSeen == /\ joined /\ Open /\ Decide("gone", FALSE) /\ joined' = FALSE
            /\ UNCHANGED <<owner, leaseOver, pc, tg, alive, calls, sent>>

Expire == /\ alive /\ alive' = FALSE
          /\ UNCHANGED <<status, send, owner, leaseOver, pc, tg, joined, decisions, calls, sent>>

Claim(d) == /\ pc[d] = "idle"
            /\ \/ send = "todo"
               \/ send = "sending" /\ leaseOver
            /\ send' = "sending" /\ owner' = d /\ leaseOver' = FALSE
            /\ pc' = [pc EXCEPT ![d] = "call"]
            /\ UNCHANGED <<status, tg, alive, joined, decisions, calls, sent>>

LeaseOver == /\ send = "sending" /\ ~leaseOver /\ leaseOver' = TRUE
             /\ UNCHANGED <<status, send, owner, pc, tg, alive, joined, decisions, calls, sent>>

Decision == IF status = "passed" THEN "approve" ELSE "decline"

Apply == /\ tg' = IF Decision = "approve" THEN "approved" ELSE "declined"
         /\ calls' = calls + 1 /\ sent' = Decision

Call(d) == /\ pc[d] = "call"
           /\ IF tg = "open" /\ (alive \/ Fallback) THEN Apply ELSE UNCHANGED <<tg, calls, sent>>
           /\ pc' = [pc EXCEPT ![d] = "finish"]
           /\ UNCHANGED <<status, send, owner, leaseOver, alive, joined, decisions>>

CallFail(d) == /\ pc[d] = "call"
               /\ send' = IF owner = d THEN "todo" ELSE send
               /\ owner' = IF owner = d THEN "none" ELSE owner
               /\ pc' = [pc EXCEPT ![d] = "idle"]
               /\ UNCHANGED <<status, leaseOver, tg, alive, joined, decisions, calls, sent>>

Finish(d) == /\ pc[d] = "finish"
             /\ send' = IF owner = d THEN "done" ELSE send
             /\ owner' = IF owner = d THEN "none" ELSE owner
             /\ pc' = [pc EXCEPT ![d] = "idle"]
             /\ UNCHANGED <<status, leaseOver, tg, alive, joined, decisions, calls, sent>>

Next == \/ Pick \/ Timeout \/ AdminOk \/ AdminNo \/ JoinSeen \/ Expire \/ LeaseOver
        \/ \E d \in Senders : Claim(d) \/ Call(d) \/ CallFail(d) \/ Finish(d)

Spec == Init /\ [][Next]_vars

TypeOK == /\ status \in {"pending", "passed", "failed", "timeout", "gone"}
          /\ send \in {"none", "todo", "sending", "done"}
          /\ owner \in {"none"} \cup Senders
          /\ pc \in [Senders -> {"idle", "call", "finish"}]
          /\ tg \in {"open", "approved", "declined"}
          /\ sent \in {"none", "approve", "decline"}

\* Решение по проверке принимается один раз.
OneDecision == decisions <= 1

\* Что бот применил в Telegram, совпадает с решением проверки.
SentMatches == /\ sent = "approve" => status = "passed"
               /\ sent = "decline" => status \in {"failed", "timeout"}

\* Бот применяет решение в Telegram не больше одного раза.
OneCall == calls <= 1

\* Отправка закрыта - заявка в Telegram уже не висит открытой.
NoHanging == send = "done" => tg # "open"
=============================================================================
