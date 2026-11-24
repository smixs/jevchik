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
(*   Withdraw   -> человек сам отозвал заявку (боту об этом не пишут)      *)
(*   Replace    -> src/gate.ts:receiveJoinRequest: новая заявка того же    *)
(*                 человека; висящая проверка закрыта, неотправленный      *)
(*                 ответ старой снят (send = skipped)                      *)
(*                                                                         *)
(* Допущения: шаг - одна транзакция или один вызов Telegram; вызов по      *)
(* query_id и запасной вызов по заявке в одном шаге Call. Telegram         *)
(* применяет решение только к открытой заявке, иначе отвечает ошибкой.     *)
(* Запасной вызов адресуется парой чат/человек, то есть текущей заявке.    *)
(* Проверка «есть ли новее» и вызов по паре идут под одной блокировкой     *)
(* pg_advisory_xact_lock(чат, человек), её же берёт Replace, поэтому в     *)
(* модели они один шаг. Новая заявка возможна, только когда старая не      *)
(* открыта (Telegram не даёт второй открытой заявки).                      *)
(* Вне модели: лимит трёх проверок в сутки, личка (та же отправка без      *)
(* query_id), разбан кнопкой (своя модель Appeal).                         *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Cas,       \* решение меняет только pending
          Fallback,  \* протухший query_id - вызов по самой заявке
          Fresh      \* отказ старой проверки не идёт по паре к новой заявке

Senders == {"web", "bot"}

VARIABLES status,    \* pending | passed | failed | timeout | gone
          send,      \* none | todo | sending | done | skipped
          owner,     \* кто держит аренду: none | web | bot
          leaseOver, \* аренда истекла
          pc,        \* у отправителя: idle | call | finish
          tg,        \* заявка в Telegram: open | approved | declined | withdrawn
          req,       \* какая заявка сейчас у пары чат/человек: old | new
          tgNew,     \* новая заявка того же человека: none | open | approved | declined
          stray,     \* решение старой проверки попало в новую заявку
          alive,     \* query_id ещё действует
          joined,    \* пришёл chat_member о входе
          decisions, \* сколько раз решение сменило pending
          calls,     \* успешные вызовы бота
          sent       \* что бот применил в Telegram: none | approve | decline

vars == <<status, send, owner, leaseOver, pc, tg, req, tgNew, stray, alive, joined, decisions, calls, sent>>
newer == <<req, tgNew, stray>>

Init == /\ status = "pending" /\ send = "none" /\ owner = "none" /\ leaseOver = FALSE
        /\ pc = [d \in Senders |-> "idle"] /\ tg = "open" /\ alive = TRUE
        /\ req = "old" /\ tgNew = "none" /\ stray = FALSE
        /\ joined = FALSE /\ decisions = 0 /\ calls = 0 /\ sent = "none"

Open == IF Cas THEN status = "pending" ELSE decisions < 3

Decide(s, toSend) == /\ status' = s /\ decisions' = decisions + 1
                     /\ send' = IF toSend THEN "todo" ELSE send

Pick == /\ Open
        /\ \E ok \in BOOLEAN : Decide(IF ok THEN "passed" ELSE "failed", TRUE)
        /\ UNCHANGED <<req, tgNew, stray, owner, leaseOver, pc, tg, alive, joined, calls, sent>>

Timeout == /\ Open /\ Decide("timeout", TRUE)
           /\ UNCHANGED <<req, tgNew, stray, owner, leaseOver, pc, tg, alive, joined, calls, sent>>

AdminOk == /\ tg = "open" /\ tg' = "approved" /\ joined' = TRUE
           /\ UNCHANGED <<req, tgNew, stray, status, send, owner, leaseOver, pc, alive, decisions, calls, sent>>

AdminNo == /\ tg = "open" /\ tg' = "declined"
           /\ UNCHANGED <<req, tgNew, stray, status, send, owner, leaseOver, pc, alive, joined, decisions, calls, sent>>

JoinSeen == /\ joined /\ Open /\ Decide("gone", FALSE) /\ joined' = FALSE
            /\ UNCHANGED <<req, tgNew, stray, owner, leaseOver, pc, tg, alive, calls, sent>>

Expire == /\ alive /\ alive' = FALSE
          /\ UNCHANGED <<req, tgNew, stray, status, send, owner, leaseOver, pc, tg, joined, decisions, calls, sent>>

Claim(d) == /\ pc[d] = "idle"
            /\ \/ send = "todo"
               \/ send = "sending" /\ leaseOver
            /\ send' = "sending" /\ owner' = d /\ leaseOver' = FALSE
            /\ pc' = [pc EXCEPT ![d] = "call"]
            /\ UNCHANGED <<req, tgNew, stray, status, tg, alive, joined, decisions, calls, sent>>

LeaseOver == /\ send = "sending" /\ ~leaseOver /\ leaseOver' = TRUE
             /\ UNCHANGED <<req, tgNew, stray, status, send, owner, pc, tg, alive, joined, decisions, calls, sent>>

Decision == IF status = "passed" THEN "approve" ELSE "decline"

ApplyOld == /\ tg' = IF Decision = "approve" THEN "approved" ELSE "declined"
            /\ calls' = calls + 1 /\ sent' = Decision /\ UNCHANGED <<tgNew, stray>>

ApplyNew == /\ tgNew' = IF Decision = "approve" THEN "approved" ELSE "declined"
            /\ stray' = TRUE
            /\ calls' = calls + 1 /\ sent' = Decision /\ UNCHANGED tg

Idle == UNCHANGED <<tg, tgNew, stray, calls, sent>>

\* Сначала query_id (он принадлежит старой заявке), при отказе - вызов по паре чат/человек, то есть к текущей заявке.
\* С Fresh вызов по паре не уходит, если у пары уже новая заявка: проверка и вызов под одной блокировкой.
ByPair == IF req = "old"
          THEN IF tg = "open" THEN ApplyOld ELSE Idle
          ELSE IF Fresh THEN Idle
               ELSE IF tgNew = "open" THEN ApplyNew ELSE Idle

Call(d) == /\ pc[d] = "call"
           /\ IF tg = "open" /\ alive THEN ApplyOld
              ELSE IF Fallback THEN ByPair ELSE Idle
           /\ pc' = [pc EXCEPT ![d] = "finish"]
           /\ UNCHANGED <<req, status, send, owner, leaseOver, alive, joined, decisions>>

CallFail(d) == /\ pc[d] = "call"
               /\ send' = IF owner = d THEN "todo" ELSE send
               /\ owner' = IF owner = d THEN "none" ELSE owner
               /\ pc' = [pc EXCEPT ![d] = "idle"]
               /\ UNCHANGED <<req, tgNew, stray, status, leaseOver, tg, alive, joined, decisions, calls, sent>>

Finish(d) == /\ pc[d] = "finish"
             /\ send' = IF owner = d THEN "done" ELSE send
             /\ owner' = IF owner = d THEN "none" ELSE owner
             /\ pc' = [pc EXCEPT ![d] = "idle"]
             /\ UNCHANGED <<req, tgNew, stray, status, leaseOver, tg, alive, joined, decisions, calls, sent>>

Withdraw == /\ tg = "open" /\ tg' = "withdrawn"
            /\ UNCHANGED <<req, tgNew, stray, status, send, owner, leaseOver, pc, alive, joined, decisions, calls, sent>>

\* Новая заявка того же человека: висящая проверка закрыта, неотправленный ответ старой снят (с Fresh).
Replace == /\ req = "old" /\ tg # "open"
           /\ req' = "new" /\ tgNew' = "open"
           /\ status' = IF status = "pending" THEN "gone" ELSE status
           /\ decisions' = IF status = "pending" THEN decisions + 1 ELSE decisions
           /\ send' = IF Fresh /\ send = "todo" THEN "skipped" ELSE send
           /\ UNCHANGED <<stray, owner, leaseOver, pc, tg, alive, joined, calls, sent>>

Next == \/ Withdraw \/ Replace \/ Pick \/ Timeout \/ AdminOk \/ AdminNo \/ JoinSeen \/ Expire \/ LeaseOver
        \/ \E d \in Senders : Claim(d) \/ Call(d) \/ CallFail(d) \/ Finish(d)

Spec == Init /\ [][Next]_vars

TypeOK == /\ status \in {"pending", "passed", "failed", "timeout", "gone"}
          /\ send \in {"none", "todo", "sending", "done", "skipped"}
          /\ owner \in {"none"} \cup Senders
          /\ pc \in [Senders -> {"idle", "call", "finish"}]
          /\ tg \in {"open", "approved", "declined", "withdrawn"}
          /\ req \in {"old", "new"}
          /\ tgNew \in {"none", "open", "approved", "declined"}
          /\ stray \in BOOLEAN
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

\* Решение старой проверки не попадает в новую заявку того же человека: её решает своя проверка.
NoStray == ~stray
=============================================================================
