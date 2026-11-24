-- Section 3.6.8 (decision of the owner 24.11): the frog on the door. One row is one check with the frog: a join request
-- (purpose 'join') or the press of «Разбанить меня» (purpose 'appeal'). The decision leaves 'pending' once, by a conditional
-- UPDATE; the answer to Telegram is sent by whoever holds the lease of `send`.
CREATE TABLE gate_checks (
  check_id     bigserial PRIMARY KEY,
  chat_id      bigint NOT NULL,
  user_id      bigint NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('join', 'appeal')),
  via          text CHECK (via IN ('guard', 'dm')),
  query_id     text,
  user_chat_id bigint,
  token        text NOT NULL UNIQUE,
  puzzle       jsonb NOT NULL,
  misses       smallint NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'passed', 'failed', 'timeout', 'gone', 'used')),
  -- Why the check closed: missed, daily_limit, joined (an admin let them in), door_failed (no window), replaced.
  reason       text,
  -- The window of a join check: todo (written, not opened yet), opening (being opened), open (the guard or the private
  -- message took it), lost (neither did). A check whose window was not surely open is never declined for silence.
  door         text NOT NULL DEFAULT 'none' CHECK (door IN ('none', 'todo', 'opening', 'open', 'lost')),
  -- skipped: the answer of an old check is not sent once a newer request of the same person came (it would reach the new one).
  -- missing: Telegram said the request is no longer there; an approval that met no request is not «let in».
  send         text NOT NULL DEFAULT 'none' CHECK (send IN ('none', 'todo', 'sending', 'done', 'failed', 'skipped', 'missing')),
  send_until   timestamptz,
  send_tries   smallint NOT NULL DEFAULT 0,
  -- The last refusal of Telegram for the answer, when there was one.
  send_note    text,
  created_at   timestamptz NOT NULL,
  decided_at   timestamptz
);
CREATE UNIQUE INDEX gate_checks_one_pending ON gate_checks (chat_id, user_id, purpose) WHERE status = 'pending';
CREATE INDEX gate_checks_due ON gate_checks (send, send_until) WHERE send IN ('todo', 'sending');
CREATE INDEX gate_checks_recent ON gate_checks (chat_id, user_id, created_at);
