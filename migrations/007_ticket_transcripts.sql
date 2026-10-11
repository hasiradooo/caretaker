-- Keep the captured conversation and original archive destination so a later
-- rating can update the same message/files, even after the thread is deleted.
create table discord.ticket_transcripts (
  bot_id text not null,
  guild_id text not null,
  thread_id text not null,
  channel_id text not null,
  message_id text,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  revision integer not null default 1,
  published_revision integer not null default 0,
  published_rating smallint,
  primary key (bot_id, guild_id, thread_id),
  foreign key (bot_id, guild_id, thread_id)
    references discord.tickets (bot_id, guild_id, thread_id) on delete cascade
);
alter table discord.ticket_transcripts enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on discord.ticket_transcripts to service_role;
  end if;
end $$;
