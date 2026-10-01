-- Section 3.6: only an edited_message whose content changed (text, caption or attachment) is an edit. Telegram also sends
-- edited_message when a member tag changes. The hash of the content tells the two apart; the text itself is not kept.
-- Rows written before this migration stay NULL: their first edited_message only stores the hash.
ALTER TABLE messages ADD COLUMN content_hash bytea;
