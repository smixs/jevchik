CREATE TABLE kv (key text PRIMARY KEY, value jsonb NOT NULL);

CREATE TABLE processed_updates (update_id bigint PRIMARY KEY, received_at timestamptz NOT NULL);

CREATE TABLE chats (
  chat_id bigint PRIMARY KEY,
  title text,
  username text,
  observation_started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  last_author_id bigint,
  run_length int NOT NULL DEFAULT 0
);

CREATE TABLE members (
  chat_id bigint NOT NULL REFERENCES chats(chat_id),
  user_id bigint NOT NULL,
  public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  username text,
  is_bot boolean NOT NULL DEFAULT false,
  karma numeric(12,4) NOT NULL DEFAULT 0,
  first_message_id bigint,
  last_active_at timestamptz,
  hidden boolean NOT NULL DEFAULT false,
  bans_count int NOT NULL DEFAULT 0,
  probation_left int NOT NULL DEFAULT 0,
  mute_until timestamptz,
  punish_level int NOT NULL DEFAULT 0,
  status text,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE UNIQUE INDEX members_public_id ON members (public_id);

CREATE TABLE member_weeks (
  chat_id bigint NOT NULL,
  user_id bigint NOT NULL,
  week text NOT NULL,
  PRIMARY KEY (chat_id, user_id, week)
);

CREATE TABLE messages (
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  author_id bigint NOT NULL,
  posted_at timestamptz NOT NULL,
  reply_to_message_id bigint,
  reply_to_author_id bigint,
  has_quote boolean NOT NULL DEFAULT false,
  media_kind text,
  run_k int NOT NULL DEFAULT 1,
  excerpt text,
  karma_sum numeric(12,4) NOT NULL DEFAULT 0,
  reply_count int NOT NULL DEFAULT 0,
  signal_count int NOT NULL DEFAULT 0,
  deleted boolean NOT NULL DEFAULT false,
  eval_gen int NOT NULL DEFAULT 0,
  usefulness_level int,
  is_answer boolean NOT NULL DEFAULT false,
  jev_awarded numeric(12,4) NOT NULL DEFAULT 0,
  facts jsonb,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX messages_author ON messages (chat_id, author_id, posted_at DESC);

CREATE TABLE karma_events (
  event_id bigserial PRIMARY KEY,
  chat_id bigint NOT NULL,
  user_id bigint NOT NULL,
  delta numeric(12,4) NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,
  message_id bigint,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (chat_id, idempotency_key)
);
CREATE INDEX karma_events_user ON karma_events (chat_id, user_id, created_at);

CREATE TABLE reactions (
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  actor_kind text NOT NULL,
  actor_id bigint NOT NULL,
  reaction_type text NOT NULL,
  target_user_id bigint NOT NULL,
  active boolean NOT NULL,
  awarded numeric(12,4) NOT NULL,
  cycle int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (chat_id, message_id, actor_kind, actor_id, reaction_type)
);

CREATE TABLE reaction_counts (
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  reaction_type text NOT NULL,
  count int NOT NULL,
  awarded numeric(12,4) NOT NULL DEFAULT 0,
  last_date timestamptz NOT NULL,
  PRIMARY KEY (chat_id, message_id, reaction_type)
);

CREATE TABLE links (
  chat_id bigint NOT NULL,
  from_message_id bigint NOT NULL,
  to_message_id bigint NOT NULL,
  actor_id bigint NOT NULL,
  target_user_id bigint NOT NULL,
  signal text,
  awarded numeric(12,4) NOT NULL DEFAULT 0,
  factor numeric(12,6) NOT NULL DEFAULT 1,
  gen int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (chat_id, from_message_id, to_message_id)
);

CREATE TABLE evaluations (
  evaluation_id text PRIMARY KEY,
  seq bigserial UNIQUE,
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  attempt_count int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  request jsonb,
  media jsonb,
  meta jsonb,
  settings_seq bigint NOT NULL DEFAULT 0,
  result jsonb,
  last_error text
);
CREATE INDEX evaluations_queue ON evaluations (chat_id, seq) WHERE status IN ('pending', 'running');

CREATE TABLE operations (
  operation_id bigserial PRIMARY KEY,
  chat_id bigint NOT NULL,
  operation_kind text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  result jsonb,
  status text NOT NULL,
  attempt_count int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL,
  last_error_code text,
  last_error_at timestamptz,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (chat_id, idempotency_key)
);

CREATE TABLE flows (
  flow_id bigserial PRIMARY KEY,
  chat_id bigint NOT NULL,
  kind text NOT NULL,
  idempotency_key text NOT NULL,
  data jsonb NOT NULL,
  step int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running',
  next_attempt_at timestamptz NOT NULL,
  settings_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  UNIQUE (chat_id, idempotency_key)
);

CREATE TABLE bans (
  ban_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id bigint NOT NULL,
  user_id bigint NOT NULL,
  category text NOT NULL,
  joke_idx int NOT NULL,
  explanation_idx int NOT NULL,
  image_idx int NOT NULL,
  state text NOT NULL,
  steam_until timestamptz NOT NULL,
  appeal_status text NOT NULL DEFAULT 'none',
  appeal_claimed_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (chat_id, user_id)
);

CREATE TABLE held_texts (
  chat_id bigint NOT NULL,
  message_id bigint NOT NULL,
  author_id bigint NOT NULL,
  author_name text NOT NULL,
  text text NOT NULL,
  reason text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE admin_cards (
  card_id bigserial PRIMARY KEY,
  chat_id bigint NOT NULL,
  idempotency_key text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'open',
  resolution text,
  delivered_count int NOT NULL DEFAULT 0,
  delivery text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL,
  UNIQUE (chat_id, idempotency_key)
);

CREATE TABLE reports (
  report_id bigserial PRIMARY KEY,
  chat_id bigint NOT NULL,
  target_message_id bigint NOT NULL,
  target_user_id bigint NOT NULL,
  reporter_id bigint NOT NULL,
  privileged boolean NOT NULL,
  status text NOT NULL DEFAULT 'open',
  card_id bigint,
  created_at timestamptz NOT NULL,
  UNIQUE (chat_id, target_message_id)
);

CREATE TABLE chat_settings (
  chat_id bigint NOT NULL,
  key text NOT NULL,
  version int NOT NULL,
  value jsonb NOT NULL,
  changed_by bigint,
  seq bigserial NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (chat_id, key, version)
);

CREATE TABLE settings_audit (
  audit_id bigserial PRIMARY KEY,
  chat_id bigint NOT NULL,
  key text NOT NULL,
  version int NOT NULL,
  old_value jsonb,
  new_value jsonb NOT NULL,
  changed_by bigint,
  changed_at timestamptz NOT NULL
);

CREATE TABLE media_descriptions (
  file_unique_id text PRIMARY KEY,
  description text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE import_jobs (
  job_id bigserial PRIMARY KEY,
  chat_id bigint NOT NULL,
  status text NOT NULL,
  file_path text,
  cursor_index int NOT NULL DEFAULT 0,
  total int NOT NULL DEFAULT 0,
  created_by bigint,
  error text,
  retry_at timestamptz,
  created_at timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE UNIQUE INDEX import_one_active ON import_jobs (chat_id) WHERE status IN ('pending', 'running');

CREATE TABLE job_runs (
  job text NOT NULL,
  period text NOT NULL,
  subject text NOT NULL,
  ran_at timestamptz NOT NULL,
  PRIMARY KEY (job, period, subject)
);
