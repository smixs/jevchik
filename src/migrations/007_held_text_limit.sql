-- Section 3.10: removed and carded message texts live at most 30 days. The schema now caps held_text_days at 30.
-- A stored value above 30 gets a new version equal to 30, with an audit record by nobody (changed_by NULL).
WITH latest AS (
  SELECT DISTINCT ON (chat_id) chat_id, version, value FROM chat_settings
  WHERE key = 'held_text_days' ORDER BY chat_id, version DESC
), capped AS (
  INSERT INTO chat_settings (chat_id, key, version, value, changed_by, created_at)
  SELECT chat_id, 'held_text_days', version + 1, '30'::jsonb, NULL, now() FROM latest WHERE (value #>> '{}')::numeric > 30
  RETURNING chat_id, version, created_at
)
INSERT INTO settings_audit (chat_id, key, version, old_value, new_value, changed_by, changed_at)
SELECT c.chat_id, 'held_text_days', c.version, l.value, '30'::jsonb, NULL, c.created_at FROM capped c JOIN latest l USING (chat_id);

-- Texts already kept with a longer term: at most 30 days from when they were written.
UPDATE held_texts SET expires_at = created_at + interval '30 days' WHERE expires_at > created_at + interval '30 days';
