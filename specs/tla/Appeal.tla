---------------------------- MODULE Appeal ----------------------------
(***************************************************************************)
(* Разбан по кнопке против бана по сроку парилки *)
(* и решения админа. Один участник, одна запись бани.                       *)
(*                                                                         *)
(* Действие модели -> код:                                                 *)
(*   TimerFires  -> src/sanctions.ts:scheduleDueBans                       *)
(*   BanCheck    -> src/sanctions.ts:banStillDue                           *)
(*   BanClaim    -> src/ops.ts:execOp (UPDATE ... AND BAN_STILL_DUE)       *)
(*   BanCall     -> src/ops.ts:finish (ctx.tg.banChatMember)               *)
(*   BanRecord   -> src/sanctions.ts:banRecord                             *)
(*   Click       -> src/appeal.ts:submitAppeal (UPDATE ... 'accepted')     *)
(*   Resume      -> src/appeal.ts:resumeAccepted                           *)
(*   UnbanWait   -> src/sanctions.ts:othersSettled                         *)
(*   UnbanLift   -> src/sanctions.ts:appealStep(liftStep)                  *)
(*   UnbanRecord -> src/sanctions.ts:appealStep(unbanRecord)               *)
(*   AdminStart  -> moderation.ts:moderate и card-actions.ts:startAction:  *)
(*                  при идущем разбане админу отказ (busy)               *)
(*   AdminApply  -> app_ban (source 'admin') или card_ban (appeal          *)
(*                  'rejected'): бан в Telegram, нажатие больше не в силе *)
(*                                                                         *)
(* Допущения: каждый шаг потока - одна транзакция или один вызов Telegram; *)
(* между шагами разных потоков возможна любая очерёдность. unbanChatMember *)
(* идёт с only_if_banned. Вне модели: outcome_unknown у бана (карточка     *)
(* op_failed админам), каналы (разбана через приложение нет), повторное    *)
(* попадание в баню (bans_count > 1, кнопка недоступна, тест appeal).      *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS WaitForBan,   \* шаг othersSettled в потоке разбана
          GuardSource,  \* шаги кнопки идут, пока запись auto и нажатие в силе
          OneClick      \* кнопка срабатывает только при appeal = none

VARIABLES rec,      \* запись бани: none | steam | banned
          src,      \* auto | admin
          appeal,   \* none | accepted | rejected
          tg,       \* Telegram: free | restricted | banned
          banPc,    \* поток бана по сроку: idle | check | op | record | done
          banOp,    \* операция ban: none | running | done | cancelled
          unPc,     \* поток разбана: idle | wait | lift | record | done
          accepts,  \* сколько раз кнопка дала разбан
          adminPc   \* поток админа: idle | run | done

vars == <<rec, src, appeal, tg, banPc, banOp, unPc, accepts, adminPc>>

Init == /\ rec = "steam" /\ src = "auto" /\ appeal = "none" /\ tg = "restricted"
        /\ banPc = "idle" /\ banOp = "none" /\ unPc = "idle" /\ accepts = 0 /\ adminPc = "idle"

Due == rec = "steam" /\ src = "auto" /\ appeal # "accepted"

TimerFires == /\ banPc = "idle" /\ Due
              /\ banPc' = "check" /\ UNCHANGED <<rec, src, appeal, tg, banOp, unPc, accepts, adminPc>>

BanCheck == /\ banPc = "check"
            /\ banPc' = IF Due THEN "op" ELSE "done"
            /\ UNCHANGED <<rec, src, appeal, tg, banOp, unPc, accepts, adminPc>>

BanClaim == /\ banPc = "op" /\ banOp = "none"
            /\ IF Due THEN banOp' = "running" /\ banPc' = "op"
                      ELSE banOp' = "cancelled" /\ banPc' = "done"
            /\ UNCHANGED <<rec, src, appeal, tg, unPc, accepts, adminPc>>

BanCall == /\ banOp = "running"
           /\ banOp' = "done" /\ tg' = "banned" /\ banPc' = "record"
           /\ UNCHANGED <<rec, src, appeal, unPc, accepts, adminPc>>

BanRecord == /\ banPc = "record"
             /\ rec' = IF rec = "steam" /\ src = "auto" THEN "banned" ELSE rec
             /\ banPc' = "done"
             /\ UNCHANGED <<src, appeal, tg, banOp, unPc, accepts, adminPc>>

Click == /\ rec # "none" /\ src = "auto"
         /\ (OneClick => appeal = "none") /\ appeal # "rejected"
         /\ appeal' = "accepted" /\ accepts' = accepts + 1
         /\ unPc' = IF unPc \in {"idle", "done"} THEN "wait" ELSE unPc
         /\ UNCHANGED <<rec, src, tg, banPc, banOp, adminPc>>

Resume == /\ appeal = "accepted" /\ rec # "none" /\ src = "auto" /\ unPc = "done"
          /\ unPc' = "wait"
          /\ UNCHANGED <<rec, src, appeal, tg, banPc, banOp, accepts, adminPc>>

BanBusy == banPc \in {"check", "op", "record"}

UnbanWait == /\ unPc = "wait" /\ (WaitForBan => ~BanBusy /\ adminPc # "run")
             /\ unPc' = "lift" /\ UNCHANGED <<rec, src, appeal, tg, banPc, banOp, accepts, adminPc>>

Mine == rec # "none" /\ (GuardSource => src = "auto" /\ appeal = "accepted")

UnbanLift == /\ unPc = "lift"
             /\ IF Mine
                  THEN /\ tg' = CASE rec = "banned" /\ tg = "banned" -> "free"
                                  [] rec = "steam" /\ tg = "restricted" -> "free"
                                  [] OTHER -> tg
                       /\ unPc' = "record"
                  ELSE /\ unPc' = "done" /\ UNCHANGED tg
             /\ UNCHANGED <<rec, src, appeal, banPc, banOp, accepts, adminPc>>

UnbanRecord == /\ unPc = "record"
               /\ rec' = IF Mine THEN "none" ELSE rec
               /\ unPc' = "done"
               /\ UNCHANGED <<src, appeal, tg, banPc, banOp, accepts, adminPc>>

AdminStart == /\ adminPc = "idle" /\ ~BanBusy /\ unPc \in {"idle", "done"}
              /\ adminPc' = "run" /\ UNCHANGED <<rec, src, appeal, tg, banPc, banOp, unPc, accepts>>

AdminApply == /\ adminPc = "run"
              /\ rec' = "banned" /\ src' = "admin" /\ appeal' = "none" /\ tg' = "banned" /\ adminPc' = "done"
              /\ UNCHANGED <<banPc, banOp, unPc, accepts>>

Next == TimerFires \/ BanCheck \/ BanClaim \/ BanCall \/ BanRecord
        \/ Click \/ Resume \/ UnbanWait \/ UnbanLift \/ UnbanRecord \/ AdminStart \/ AdminApply

Spec == Init /\ [][Next]_vars

TypeOK == /\ rec \in {"none", "steam", "banned"} /\ src \in {"auto", "admin"}
          /\ appeal \in {"none", "accepted", "rejected"} /\ tg \in {"free", "restricted", "banned"}
          /\ accepts \in 0..3

(* Кнопка срабатывает один раз на запись. *)
OneAppeal == accepts <= 1

(* Бан в Telegram всегда виден в бане: нет бана без записи. *)
NoHiddenBan == tg = "banned" => rec # "none"

(* Наказание админа кнопка участника не снимает. *)
AdminWins == adminPc = "done" => tg = "banned" /\ rec = "banned"

Quiet == banPc \in {"idle", "done"} /\ unPc \in {"idle", "done"} /\ adminPc # "run"

(* Нажал кнопку и админ не вмешался: в конце участник свободен и записи нет. *)
ClickFrees == Quiet /\ accepts >= 1 /\ adminPc = "idle" => tg = "free" /\ rec = "none"
=============================================================================
