-- Kick webhook hardening + RLS/policies + retention cron
-- Idempotent migration.

create extension if not exists pg_cron with schema extensions;

alter table if exists public.kick_events
  add column if not exists event_id text,
  add column if not exists source text not null default 'unknown',
  add column if not exists received_at timestamptz not null default now(),
  add column if not exists signature text not null default '',
  add column if not exists signature_valid boolean not null default false,
  add column if not exists webhook_timestamp text not null default '',
  add column if not exists processed_error text not null default '';

create unique index if not exists idx_kick_events_event_id_unique
  on public.kick_events (event_id)
  where event_id is not null and btrim(event_id) <> '';

create index if not exists idx_kick_events_received_at
  on public.kick_events (received_at desc);

alter table if exists public.kick_events enable row level security;
alter table if exists public.kick_subscribers enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'kick_events' and policyname = 'kick_events_select_client'
  ) then
    create policy kick_events_select_client
      on public.kick_events
      for select
      using (auth.role() in ('anon', 'authenticated', 'service_role'));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'kick_events' and policyname = 'kick_events_delete_client'
  ) then
    create policy kick_events_delete_client
      on public.kick_events
      for delete
      using (auth.role() in ('anon', 'authenticated', 'service_role'));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'kick_events' and policyname = 'kick_events_insert_service'
  ) then
    create policy kick_events_insert_service
      on public.kick_events
      for insert
      with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'kick_events' and policyname = 'kick_events_update_service'
  ) then
    create policy kick_events_update_service
      on public.kick_events
      for update
      using (auth.role() = 'service_role')
      with check (auth.role() = 'service_role');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'kick_subscribers' and policyname = 'kick_subscribers_select_client'
  ) then
    create policy kick_subscribers_select_client
      on public.kick_subscribers
      for select
      using (auth.role() in ('anon', 'authenticated', 'service_role'));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'kick_subscribers' and policyname = 'kick_subscribers_modify_client'
  ) then
    create policy kick_subscribers_modify_client
      on public.kick_subscribers
      for all
      using (auth.role() in ('anon', 'authenticated', 'service_role'))
      with check (auth.role() in ('anon', 'authenticated', 'service_role'));
  end if;
end
$$;

grant select, delete on table public.kick_events to anon, authenticated;
grant insert, update, select, delete on table public.kick_events to service_role;
grant select, insert, update, delete on table public.kick_subscribers to anon, authenticated, service_role;
grant usage, select on sequence public.kick_events_id_seq to service_role;

create or replace function public.kick_runtime_cleanup(
  p_events_days integer default 14,
  p_subscribers_days integer default 90,
  p_logs_days integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted_events integer := 0;
  v_deleted_subs integer := 0;
  v_deleted_logs integer := 0;
begin
  delete from public.kick_events
  where created_at < (now() - make_interval(days => greatest(1, p_events_days)));
  get diagnostics v_deleted_events = row_count;

  delete from public.kick_subscribers
  where coalesce(expires_at, updated_at, created_at) < (now() - make_interval(days => greatest(1, p_subscribers_days)));
  get diagnostics v_deleted_subs = row_count;

  if to_regclass('public.app_logs') is not null then
    delete from public.app_logs
    where created_at < (now() - make_interval(days => greatest(1, p_logs_days)))
      and (
        lower(coalesce(type, '')) in ('warn', 'error', 'song', 'sr', 'sr-done', 'info')
        or lower(coalesce(msg, '')) like '%kick%'
        or lower(coalesce(msg, '')) like '%songrequest%'
      );
    get diagnostics v_deleted_logs = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'deleted_events', v_deleted_events,
    'deleted_subscribers', v_deleted_subs,
    'deleted_logs', v_deleted_logs,
    'at', now()
  );
end;
$$;

create or replace function public.schedule_kick_runtime_cleanup_cron(
  p_job_name text default 'kick-runtime-cleanup-daily',
  p_schedule text default '25 4 * * *'
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
    'select public.kick_runtime_cleanup();'
  );
end;
$$;

create or replace function public.unschedule_kick_runtime_cleanup_cron(
  p_job_name text default 'kick-runtime-cleanup-daily'
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

revoke all on function public.kick_runtime_cleanup(integer, integer, integer) from public;
revoke all on function public.schedule_kick_runtime_cleanup_cron(text, text) from public;
revoke all on function public.unschedule_kick_runtime_cleanup_cron(text) from public;

grant execute on function public.kick_runtime_cleanup(integer, integer, integer) to service_role;
grant execute on function public.schedule_kick_runtime_cleanup_cron(text, text) to service_role;
grant execute on function public.unschedule_kick_runtime_cleanup_cron(text) to service_role;

select public.schedule_kick_runtime_cleanup_cron();
