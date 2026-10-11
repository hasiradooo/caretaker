-- Keep existing highlights editable after an administrator changes the destination.
-- Legacy rows use the configured destination until first updated by Caretaker.
alter table discord.starboards add column if not exists starboard_channel_id text;
