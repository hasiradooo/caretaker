-- Remember the exact message and its original channel; settings may change later.
alter table discord.tickets
  add column staff_alert_channel_id text,
  add column staff_alert_message_id text,
  add column staff_alert_deleted_at timestamptz,
  add constraint caretaker_ticket_alert_pair check (
    (staff_alert_channel_id is null) = (staff_alert_message_id is null)
  );

-- Failed Discord deletions remain queued across restarts, even with tickets paused.
create index idx_caretaker_pending_ticket_alerts
  on discord.tickets (bot_id, guild_id, closed_at)
  where status = 'closed' and staff_alert_message_id is not null
    and staff_alert_deleted_at is null;
