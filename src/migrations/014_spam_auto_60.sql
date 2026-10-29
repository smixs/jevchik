-- Section 3.6: from 0.6 a judged message is removed and its author goes to the steam room.
-- A stored threshold above 0.6 gets a new version equal to 0.6, with an audit record by nobody (changed_by NULL); the review
-- thresholds follow, since a review threshold may not exceed the automatic one.
WITH latest AS (
  SELECT DISTINCT ON (chat_id, key) chat_id, key, version, value FROM chat_settings
  WHERE key IN ('spam_auto_threshold', 'spam_review_delete_threshold', 'spam_review_threshold') ORDER BY chat_id, key, version DESC
), capped AS (
  INSERT INTO chat_settings (chat_id, key, version, value, changed_by, created_at)
  SELECT chat_id, key, version + 1, '0.6'::jsonb, NULL, now() FROM latest WHERE (value #>> '{}')::numeric > 0.6
  RETURNING chat_id, key, version, created_at
)
INSERT INTO settings_audit (chat_id, key, version, old_value, new_value, changed_by, changed_at)
SELECT c.chat_id, c.key, c.version, l.value, '0.6'::jsonb, NULL, c.created_at FROM capped c JOIN latest l USING (chat_id, key);
