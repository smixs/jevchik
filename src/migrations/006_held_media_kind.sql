-- Section 3.6.1: a card about a message without text names the kind of attachment next to the caption.
-- The kind lives next to the held text and goes away with it (section 3.10).
ALTER TABLE held_texts ADD COLUMN media_kind text;
