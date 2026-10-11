-- Claimed and archived-but-unresolved threads remain open in this table.
-- Fail rather than discard any legacy duplicate ticket or its history.
create unique index if not exists idx_caretaker_one_open_ticket
  on discord.tickets (bot_id, guild_id, opener_id)
  where status = 'open';
