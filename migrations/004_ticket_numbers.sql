-- Human-readable ticket numbers are scoped to a bot and server, not a member.
-- Keep the counter separately so closing/deleting tickets never reuses a number.
alter table discord.tickets add column ticket_number bigint;

create table discord.ticket_counters (
  bot_id text not null,
  guild_id text not null,
  last_number bigint not null check (last_number > 0),
  primary key (bot_id, guild_id)
);
alter table discord.ticket_counters enable row level security;

-- Give existing open AND closed tickets stable numbers in creation order.
with numbered as (
  select bot_id, guild_id, thread_id,
    row_number() over (
      partition by bot_id, guild_id order by created_at, thread_id
    ) as number
  from discord.tickets
)
update discord.tickets as ticket set ticket_number = numbered.number
from numbered
where ticket.bot_id = numbered.bot_id
  and ticket.guild_id = numbered.guild_id
  and ticket.thread_id = numbered.thread_id;

insert into discord.ticket_counters (bot_id, guild_id, last_number)
select bot_id, guild_id, max(ticket_number)
from discord.tickets group by bot_id, guild_id;

alter table discord.tickets alter column ticket_number set not null;
alter table discord.tickets add constraint caretaker_ticket_number_positive
  check (ticket_number > 0);
create unique index idx_caretaker_ticket_number
  on discord.tickets (bot_id, guild_id, ticket_number);

-- The UPSERT takes a row lock per server. Parallel inserts cannot share a number.
-- Allocate in the INSERT transaction so a failed insert also rolls back its counter.
-- Doing this in the database keeps old bot code compatible during deployment.
create function discord.assign_ticket_number() returns trigger
language plpgsql as $$
begin
  insert into discord.ticket_counters (bot_id, guild_id, last_number)
  values (new.bot_id, new.guild_id, 1)
  on conflict (bot_id, guild_id) do update
    set last_number = discord.ticket_counters.last_number + 1
  returning last_number into new.ticket_number;
  return new;
end;
$$;

create trigger caretaker_assign_ticket_number
  before insert on discord.tickets
  for each row execute function discord.assign_ticket_number();

-- This function uses the caller's permissions. No public access is introduced.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on discord.ticket_counters to service_role;
  end if;
end $$;
