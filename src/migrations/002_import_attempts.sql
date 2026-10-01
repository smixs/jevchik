-- Attempts made for the message at the import cursor (Jev calls per logical evaluation, at most three).
ALTER TABLE import_jobs ADD COLUMN attempts int NOT NULL DEFAULT 0;
