-- Section 3.6.0: spam by text is judged only for a newcomer, a member with at most spam_newcomer_messages messages in the chat
-- (imported ones included; 0 judges everybody). Open cards about messages of other members ("would do", review, protected)
-- are closed with the resolution not_newcomer, by the current number of the author's messages.
WITH limits AS (
  SELECT c.chat_id,
         COALESCE((SELECT (s.value #>> '{}')::int FROM chat_settings s
                   WHERE s.chat_id = c.chat_id AND s.key = 'spam_newcomer_messages' ORDER BY s.version DESC LIMIT 1), 5) AS newcomer_messages
  FROM (SELECT DISTINCT chat_id FROM admin_cards WHERE status = 'open') c
)
UPDATE admin_cards a SET status = 'resolved', resolution = 'not_newcomer'
FROM limits l
WHERE a.chat_id = l.chat_id
  AND l.newcomer_messages > 0
  AND a.status = 'open'
  AND a.kind IN ('would_do', 'review', 'protected')
  AND (SELECT count(*) FROM messages m
       WHERE m.chat_id = a.chat_id AND m.author_id = (a.payload->>'targetUserId')::bigint) > l.newcomer_messages;
