-- Section 3.6.4: a channel that writes in the group is a member, stored under the negative id of its sender_chat, with the
-- title as its name and the channel username. It gets karma like a person; no tag and no karma punishment.
ALTER TABLE members ADD COLUMN is_channel boolean NOT NULL DEFAULT false;
