-- Additive upgrade for the existing discord schema. No rows are deleted or reset.
alter table discord.user_levels add column if not exists last_xp_at timestamptz;
alter table discord.tickets add column if not exists last_activity_at timestamptz not null default now();

create index if not exists idx_caretaker_level_rank
  on discord.user_levels (bot_id, guild_id, level desc, xp desc, user_id);
create index if not exists idx_caretaker_ticket_activity
  on discord.tickets (bot_id, guild_id, last_activity_at) where status = 'open';
create index if not exists idx_caretaker_voice_creator
  on discord.temp_voice_channels (bot_id, guild_id, creator_id);

create table if not exists discord.plugin_state (
  bot_id text not null,
  guild_id text not null,
  plugin_name text not null,
  key text not null,
  expires_at timestamptz not null,
  primary key (bot_id, guild_id, plugin_name, key)
);
create index if not exists idx_caretaker_state_expiry on discord.plugin_state (bot_id, expires_at);

create table if not exists discord.channel_slowmodes (
  bot_id text not null,
  guild_id text not null,
  channel_id text not null,
  previous_rate integer not null check (previous_rate between 0 and 21600),
  applied_rate integer not null check (applied_rate between 0 and 21600),
  expires_at timestamptz not null,
  primary key (bot_id, guild_id, channel_id)
);

alter table discord.plugin_state enable row level security;
alter table discord.channel_slowmodes enable row level security;
create table if not exists discord.runtime_leases (
  bot_id text primary key,
  owner text not null,
  expires_at timestamptz not null
);
alter table discord.runtime_leases enable row level security;
-- Supabase service_role bypasses RLS; anon/authenticated receive no new privileges.
do $$ begin
  if exists (select 1 from pg_roles where rolname='service_role') then
    grant select, insert, update, delete on discord.plugin_state, discord.channel_slowmodes, discord.runtime_leases to service_role;
  end if;
end $$;
