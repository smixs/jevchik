-- Section 3.6.5: an administrator sanctions a member from the Mini App. Such a record keeps who made it; its steam room ends
-- by itself and never turns into a ban. Every action of an administrator is kept in a journal.
ALTER TABLE bans ADD COLUMN source text NOT NULL DEFAULT 'auto';
ALTER TABLE bans ADD COLUMN by_admin_id bigint;
ALTER TABLE bans ADD COLUMN by_admin_name text;

CREATE TABLE mod_actions (
  action_id bigserial PRIMARY KEY,
  chat_id bigint NOT NULL,
  flow_key text NOT NULL,
  admin_id bigint NOT NULL,
  admin_name text NOT NULL,
  target_user_id bigint NOT NULL,
  target_name text NOT NULL,
  action text NOT NULL,
  hours int,
  ok boolean NOT NULL,
  summary text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (chat_id, flow_key)
);
