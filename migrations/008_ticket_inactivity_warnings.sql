-- A delivered warning and its deadline survive restarts. Existing tickets retain
-- their activity timestamp and receive a warning before any automatic closure.
alter table discord.tickets
  add column inactivity_warned_at timestamptz,
  add column inactivity_close_at timestamptz,
  add column inactivity_policy text,
  add column inactivity_warning_message_id text;
