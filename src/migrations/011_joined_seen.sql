-- Section 3.6.0: a newcomer is somebody the bot saw joining the chat. Whoever was in the chat before the bot came is not one,
-- however few messages of theirs the bot knows. NULL means the join was not seen.
ALTER TABLE members ADD COLUMN joined_seen_at timestamptz;

-- Joins the bot already saw as a membership update before this migration: a member row that appeared after the chat was
-- connected, with a status from Telegram, and with no message older than the row itself.
UPDATE members m SET joined_seen_at = m.created_at
FROM chats c
WHERE c.chat_id = m.chat_id AND m.status IN ('member', 'restricted') AND m.created_at > c.created_at + interval '1 minute'
  AND NOT EXISTS (SELECT 1 FROM messages s WHERE s.chat_id = m.chat_id AND s.author_id = m.user_id AND s.posted_at < m.created_at);
