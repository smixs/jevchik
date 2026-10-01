-- Section 3.6.2: after every press the card gets the line "Решение: ..."; the decisions stay for the admin screen.
ALTER TABLE admin_cards ADD COLUMN decision text;
-- Section 3.6.3: there are no "would do" cards any more. Open ones are closed and, being closed, are never delivered.
UPDATE admin_cards SET status = 'resolved', resolution = 'obsolete' WHERE status = 'open' AND kind = 'would_do';
