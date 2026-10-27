-- Only channels created by this plugin are managed or removed. Names and the
-- rename interval survive restarts, as do pending creation tokens.
create table discord.server_stat_channels (
  bot_id text not null,
  guild_id text not null,
  counter text not null check (counter in ('members','humans','bots','goal','supporters','boosts','staff_online')),
  creation_token text not null,
  channel_id text,
  last_name text,
  renamed_at timestamptz,
  primary key (bot_id, guild_id, counter),
  unique (bot_id, guild_id, channel_id)
);
alter table discord.server_stat_channels enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant select, insert, update, delete on discord.server_stat_channels to service_role;
  end if;
end $$;
