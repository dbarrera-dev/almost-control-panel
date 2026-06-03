-- Kick events + subscribers base schema
-- Idempotent migration for consistent installs across PCs/projects.

create table if not exists public.kick_events (
  id bigint generated always as identity primary key,
  event_type text not null default '',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table if exists public.kick_events
  add column if not exists event_type text not null default '',
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists processed_at timestamptz;

create index if not exists idx_kick_events_created_at
  on public.kick_events (created_at asc);

create index if not exists idx_kick_events_processed_at
  on public.kick_events (processed_at);

create index if not exists idx_kick_events_unprocessed_created_at
  on public.kick_events (created_at asc)
  where processed_at is null;

create index if not exists idx_kick_events_event_type_created_at
  on public.kick_events (event_type, created_at desc);

create table if not exists public.kick_subscribers (
  id text primary key,
  mode text not null default 'prod',
  channel_slug text not null default '',
  user_id text,
  username text,
  is_active boolean not null default true,
  duration_months integer,
  expires_at timestamptz,
  last_event_at timestamptz,
  last_event_type text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.kick_subscribers
  add column if not exists mode text not null default 'prod',
  add column if not exists channel_slug text not null default '',
  add column if not exists user_id text,
  add column if not exists username text,
  add column if not exists is_active boolean not null default true,
  add column if not exists duration_months integer,
  add column if not exists expires_at timestamptz,
  add column if not exists last_event_at timestamptz,
  add column if not exists last_event_type text not null default '',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'kick_subscribers_mode_check'
  ) then
    alter table public.kick_subscribers
      add constraint kick_subscribers_mode_check
      check (mode in ('prod', 'dev'));
  end if;
end
$$;

create index if not exists idx_kick_subscribers_mode_channel
  on public.kick_subscribers (mode, channel_slug);

create index if not exists idx_kick_subscribers_mode_channel_expires_user
  on public.kick_subscribers (mode, channel_slug, expires_at asc, username asc);

create index if not exists idx_kick_subscribers_mode_channel_active
  on public.kick_subscribers (mode, channel_slug, is_active);

create index if not exists idx_kick_subscribers_mode_channel_user_id
  on public.kick_subscribers (mode, channel_slug, user_id);

create or replace function public.kick_subscribers_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_kick_subscribers_touch_updated_at on public.kick_subscribers;

create trigger trg_kick_subscribers_touch_updated_at
before update on public.kick_subscribers
for each row
execute function public.kick_subscribers_touch_updated_at();
