-- Karma events written by an import were dated by the import run, so the week and month boards counted old history as fresh.
-- An imported event gets the time of its message. Only the import generation (0) of a message whose evaluation is an import:
-- the reaction counter events, the Jev event jev:<message>:0, and the ladder event link:<from>:<to>:0 whose answering message
-- was imported. Live edits of imported messages (a newer generation), decay and events of live messages keep their time.
UPDATE karma_events e SET created_at = m.posted_at
FROM messages m, evaluations v
WHERE (e.source = 'import' OR (e.source = 'jev' AND e.idempotency_key = 'jev:' || e.message_id || ':0'))
  AND m.chat_id = e.chat_id AND m.message_id = e.message_id
  AND v.chat_id = e.chat_id AND v.message_id = e.message_id AND v.kind = 'import';

UPDATE karma_events e SET created_at = m.posted_at
FROM messages m, evaluations v
WHERE e.source = 'ladder' AND e.idempotency_key ~ '^link:[0-9]+:[0-9]+:0$'
  AND m.chat_id = e.chat_id AND m.message_id = split_part(e.idempotency_key, ':', 2)::bigint
  AND v.chat_id = e.chat_id AND v.message_id = m.message_id AND v.kind = 'import';
