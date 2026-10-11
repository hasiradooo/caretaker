-- Portable PostgreSQL 15+ baseline for an EMPTY database namespace.
-- Applied transactionally by db:init, which refuses an existing discord schema.
-- Retains the original column names so legacy table data can be imported.
-- No dependency on Supabase auth roles or extensions.

create schema discord;

-- ─── Extensions ───────────────────────────────────────────────────────────────



-- ─── Enums ────────────────────────────────────────────────────────────────────

create type discord.bot_status as enum ('provisioning', 'running', 'stopped', 'error');
create type discord.tx_type    as enum ('add', 'remove');

-- ─── updated_at trigger ───────────────────────────────────────────────────────

create or replace function discord.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- =============================================================================
-- TABLES
-- =============================================================================

-- ─── platform_users ───────────────────────────────────────────────────────────
-- Dashboard accounts. Login via Discord OAuth.

create table discord.platform_users (
  id         text        primary key,          -- Discord user ID
  username   text        not null,
  email      text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_platform_users_updated_at
  before update on discord.platform_users
  for each row execute function discord.set_updated_at();

-- ─── bots ─────────────────────────────────────────────────────────────────────
-- SECURITY: encrypted_token is AES-256-GCM ciphertext — never plaintext.
--   Decrypted exactly once at container provisioning, injected as DISCORD_TOKEN.
--   bots_safe view excludes encrypted_token for all non-provisioning reads.

create table discord.bots (
  id              text               primary key,   -- Discord application/bot ID
  owner_id        text               not null references discord.platform_users(id) on delete cascade,
  name            text               not null,
  encrypted_token text               not null,
  avatar_url      text,
  status          discord.bot_status not null default 'provisioning',
  container_id    text,
  error_msg       text,
  created_at      timestamptz        not null default now(),
  updated_at      timestamptz        not null default now()
);

create trigger trg_bots_updated_at
  before update on discord.bots
  for each row execute function discord.set_updated_at();

create view discord.bots_safe with (security_invoker = true) as
  select id, owner_id, name, avatar_url, status, container_id, error_msg,
         created_at, updated_at
  from discord.bots;

-- ─── guilds ───────────────────────────────────────────────────────────────────

create table discord.guilds (
  bot_id       text        not null references discord.bots(id) on delete cascade,
  guild_id     text        not null,
  name         text        not null,
  icon_url     text,
  member_count integer     not null default 0,
  is_premium   boolean     not null default false,
  joined_at    timestamptz not null default now(),
  primary key (bot_id, guild_id)
);

create index idx_guilds_bot_id on discord.guilds(bot_id);

-- ─── plugins ──────────────────────────────────────────────────────────────────
-- One row per plugin per guild. enabled is a top-level column for fast queries.

create table discord.plugins (
  bot_id      text        not null,
  guild_id    text        not null,
  plugin_name text        not null,
  enabled     boolean     not null default false,
  config      jsonb       not null default '{}',
  updated_at  timestamptz not null default now(),
  primary key (bot_id, guild_id, plugin_name)
);

create trigger trg_plugins_updated_at
  before update on discord.plugins
  for each row execute function discord.set_updated_at();

create index idx_plugins_guild   on discord.plugins(bot_id, guild_id);
create index idx_plugins_enabled on discord.plugins(bot_id, guild_id, enabled);

-- ─── bot_stats ────────────────────────────────────────────────────────────────
-- Generic key/value counters per bot. No hardcoded plugin columns.
-- e.g. ('bot123', 'tickets_opened', 42)

create table discord.bot_stats (
  bot_id     text        not null references discord.bots(id) on delete cascade,
  stat       text        not null,
  value      bigint      not null default 0,
  updated_at timestamptz not null default now(),
  primary key (bot_id, stat)
);

-- ─── user_levels ──────────────────────────────────────────────────────────────

create table discord.user_levels (
  bot_id     text        not null,
  guild_id   text        not null,
  user_id    text        not null,
  xp         integer     not null default 0,
  level      integer     not null default 0,
  messages   integer     not null default 0,
  updated_at timestamptz not null default now(),
  primary key (bot_id, guild_id, user_id)
);

create index idx_user_levels_xp on discord.user_levels(bot_id, guild_id, xp desc);

-- ─── user_bdays ───────────────────────────────────────────────────────────────
-- Explicit int columns for direct WHERE day = x AND month = y queries.

create table discord.user_bdays (
  bot_id   text     not null,
  guild_id text     not null,
  user_id  text     not null,
  day      smallint not null check (day   between 1 and 31),
  month    smallint not null check (month between 1 and 12),
  year     smallint,
  primary key (bot_id, guild_id, user_id)
);

create index idx_user_bdays_date on discord.user_bdays(bot_id, guild_id, month, day);

-- ─── user_balances ────────────────────────────────────────────────────────────

create table discord.user_balances (
  bot_id     text        not null,
  guild_id   text        not null,
  user_id    text        not null,
  amount     bigint      not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bot_id, guild_id, user_id)
);

create trigger trg_user_balances_updated_at
  before update on discord.user_balances
  for each row execute function discord.set_updated_at();

-- ─── currency_transactions ────────────────────────────────────────────────────

create table discord.currency_transactions (
  id         text             primary key,    -- nanoid generated by application
  bot_id     text             not null,
  guild_id   text             not null,
  user_id    text             not null,
  amount     bigint           not null,
  type       discord.tx_type  not null,
  reason     text             not null,
  created_at timestamptz      not null default now()
);

create index idx_currency_tx_user on discord.currency_transactions(bot_id, guild_id, user_id);

-- ─── linked_accounts ──────────────────────────────────────────────────────────
-- Social platform links per Discord user per guild.

create table discord.linked_accounts (
  bot_id   text not null,
  guild_id text not null,
  user_id  text not null,

  youtube_id text,
  twitter_id text,
  tiktok_id  text,
  twitch_id  text,
  github_id  text,

  youtube_verified boolean not null default false,
  twitter_verified boolean not null default false,
  tiktok_verified  boolean not null default false,
  twitch_verified  boolean not null default false,
  github_verified  boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bot_id, guild_id, user_id)
);

create trigger trg_linked_accounts_updated_at
  before update on discord.linked_accounts
  for each row execute function discord.set_updated_at();

-- ─── verification_tokens ──────────────────────────────────────────────────────
-- Short-lived tokens for OAuth social account linking flows.
-- Expired rows should be cleaned up by a scheduled job.

create table discord.verification_tokens (
  token       text        primary key,
  bot_id      text        not null,
  guild_id    text        not null,
  user_id     text        not null,
  platform    text        not null,   -- 'github' | 'youtube' | 'twitch' | 'twitter' | 'tiktok'
  platform_id text        not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

create index idx_verification_tokens_expiry on discord.verification_tokens(expires_at);

-- ─── starboards ───────────────────────────────────────────────────────────────

create table discord.starboards (
  bot_id               text        not null,
  guild_id             text        not null,
  source_message_id    text        not null,
  source_channel_id    text        not null,
  starboard_message_id text        not null,
  star_count           integer     not null default 0,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (bot_id, guild_id, source_message_id)
);

create trigger trg_starboards_updated_at
  before update on discord.starboards
  for each row execute function discord.set_updated_at();

-- ─── tickets ──────────────────────────────────────────────────────────────────

create table discord.tickets (
  bot_id       text        not null,
  guild_id     text        not null,
  thread_id    text        not null,
  opener_id    text        not null,
  claimed_by   text,
  closed_by    text,
  close_reason text,
  rating       smallint    check (rating between 1 and 5),
  status       text        not null default 'open' check (status in ('open', 'closed')),
  metadata     jsonb       not null default '{}',
  closed_at    timestamptz,
  created_at   timestamptz not null default now(),
  primary key (bot_id, guild_id, thread_id)
);

create index idx_tickets_status on discord.tickets(bot_id, guild_id, status);

-- ─── temp_voice_channels ──────────────────────────────────────────────────────

create table discord.temp_voice_channels (
  bot_id     text        not null,
  guild_id   text        not null,
  channel_id text        not null,
  creator_id text        not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (bot_id, guild_id, channel_id)
);

create index idx_tempvc_expires on discord.temp_voice_channels(expires_at);

-- =============================================================================

-- Only the schema owner may access data unless an operator grants access.
alter table discord.platform_users        enable row level security;
alter table discord.bots                  enable row level security;
alter table discord.guilds                enable row level security;
alter table discord.plugins               enable row level security;
alter table discord.bot_stats             enable row level security;
alter table discord.user_levels           enable row level security;
alter table discord.user_bdays            enable row level security;
alter table discord.user_balances         enable row level security;
alter table discord.currency_transactions enable row level security;
alter table discord.linked_accounts       enable row level security;
alter table discord.verification_tokens   enable row level security;
alter table discord.starboards            enable row level security;
alter table discord.tickets               enable row level security;
alter table discord.temp_voice_channels   enable row level security;
