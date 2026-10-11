-- Reuse the legacy rating column (1–5). Existing closed tickets stay untouched;
-- only future successful closures request a review, never a historical DM burst.
alter table discord.tickets
  add column review_token uuid,
  add column review_requested_at timestamptz,
  add column review_dm_message_id text,
  add column review_delivery_status text check (
    review_delivery_status in ('sending', 'sent', 'unavailable', 'failed')
  ),
  add column reviewed_at timestamptz;

create unique index idx_caretaker_ticket_review_token
  on discord.tickets (bot_id, review_token) where review_token is not null;
