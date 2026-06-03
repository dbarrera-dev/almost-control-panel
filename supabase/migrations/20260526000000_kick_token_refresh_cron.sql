-- Kick token refresh 24/7 (cron + edge function)
-- This migration is idempotent and safe to run multiple times.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

alter table if exists public.kick_tokens
  add column if not exists last_refresh_at timestamptz,
  add column if not exists last_refresh_status text not null default '',
  add column if not exists last_refresh_error text not null default '',
  add column if not exists refresh_fail_count integer not null default 0;

create table if not exists public.kick_token_refresh_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  run_id text not null default '',
  source text not null default '',
  mode text not null default '',
  token_kind text not null default '',
  row_id integer,
  success boolean not null default false,
  status_code integer,
  error text not null default '',
  details jsonb not null default '{}'::jsonb
);

create index if not exists idx_kick_token_refresh_logs_created_at
  on public.kick_token_refresh_logs (created_at desc);

create index if not exists idx_kick_token_refresh_logs_run_id
  on public.kick_token_refresh_logs (run_id);

alter table public.kick_token_refresh_logs enable row level security;

create table if not exists public.internal_secrets (
  name text primary key,
  secret text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.internal_secrets enable row level security;

create or replace function public.invoke_kick_token_refresh_cron()
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_project_url text;
  v_anon_key text;
  v_cron_secret text;
  v_request_id bigint;
begin
  select secret
    into v_project_url
  from public.internal_secrets
  where name = 'SUPABASE_URL'
  limit 1;

  select secret
    into v_anon_key
  from public.internal_secrets
  where name = 'SUPABASE_ANON_KEY'
  limit 1;

  select secret
    into v_cron_secret
  from public.internal_secrets
  where name = 'KICK_CRON_SECRET'
  limit 1;

  if coalesce(v_project_url, '') = '' then
    raise exception 'Missing Vault secret: SUPABASE_URL';
  end if;
  if coalesce(v_anon_key, '') = '' then
    raise exception 'Missing Vault secret: SUPABASE_ANON_KEY';
  end if;
  if coalesce(v_cron_secret, '') = '' then
    raise exception 'Missing Vault secret: KICK_CRON_SECRET';
  end if;

  select net.http_post(
    url := rtrim(v_project_url, '/') || '/functions/v1/kick-token-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', v_anon_key,
      'x-kick-cron-secret', v_cron_secret
    ),
    body := jsonb_build_object(
      'source', 'pg_cron',
      'requested_at', now()::text
    )
  )
  into v_request_id;

  return v_request_id;
end;
$$;

create or replace function public.schedule_kick_token_refresh_cron(
  p_job_name text default 'kick-token-refresh-15m',
  p_schedule text default '*/15 * * * *'
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname = p_job_name
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    p_job_name,
    p_schedule,
    'select public.invoke_kick_token_refresh_cron();'
  );
end;
$$;

create or replace function public.unschedule_kick_token_refresh_cron(
  p_job_name text default 'kick-token-refresh-15m'
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid
    from cron.job
    where jobname = p_job_name
  loop
    perform cron.unschedule(v_job_id);
  end loop;
end;
$$;

revoke all on function public.invoke_kick_token_refresh_cron() from public;
revoke all on function public.schedule_kick_token_refresh_cron(text, text) from public;
revoke all on function public.unschedule_kick_token_refresh_cron(text) from public;
revoke all on table public.internal_secrets from public;
