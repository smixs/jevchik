-- Karma tag (section 3.12): the last tag text set in Telegram and when, and why the member gets no tag:
-- 'target_admin' (Telegram answered administrator or owner, lifted when the role changes) or 'human_tag' (a person set the tag).
ALTER TABLE members
  ADD COLUMN tag_text text,
  ADD COLUMN tag_set_at timestamptz,
  ADD COLUMN tag_exempt text;

-- One waiting tag operation per member, found by the karma change that would add another.
CREATE INDEX operations_pending_tag ON operations (chat_id, ((payload->>'userId')::bigint))
  WHERE operation_kind = 'set_tag' AND status = 'pending';

-- The per-chat pace of tag calls.
CREATE INDEX operations_tag_calls ON operations (chat_id, claimed_at) WHERE operation_kind = 'set_tag';
