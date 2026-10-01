-- Section 3.6.0: a member past spam_newcomer_messages gets no card by the text score, a card after a softer edit included.
-- Open edit_lowered cards about messages of such members are closed with not_newcomer, as migration 008 does for the others.
WITH limits AS (
  SELECT c.chat_id,
         COALESCE((SELECT (s.value #>> '{}')::int FROM chat_settings s
                   WHERE s.chat_id = c.chat_id AND s.key = 'spam_newcomer_messages' ORDER BY s.version DESC LIMIT 1), 5) AS newcomer_messages
  FROM (SELECT DISTINCT chat_id FROM admin_cards WHERE status = 'open' AND kind = 'edit_lowered') c
)
UPDATE admin_cards a SET status = 'resolved', resolution = 'not_newcomer'
FROM limits l
WHERE a.chat_id = l.chat_id
  AND l.newcomer_messages > 0
  AND a.status = 'open'
  AND a.kind = 'edit_lowered'
  AND (SELECT count(*) FROM messages m
       WHERE m.chat_id = a.chat_id AND m.author_id = (a.payload->>'targetUserId')::bigint) > l.newcomer_messages;
