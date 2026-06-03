-- Keep Kick cron/runtime history compact across installations.
-- Deletes old rows and keeps only the latest N entries.

create extension if not exists pg_cron with schema extensions;

create or replace function public.prune_kick_refresh_artifacts(
  p_keep integer default 10,
  p_target_job_names text[] default array[
    'kick-token-refresh-15m',
    'kick-runtime-cleanup-daily'
  ]
)
returns jsonb
language plpgsql
security definer
set search_path = public, cron, extensions
as $$
declare
  v_keep integer := greatest(1, coalesce(p_keep, 10));
  v_deleted_refresh_logs integer := 0;
  v_deleted_cron_runs integer := 0;
begin
  if to_regclass('public.kick_token_refresh_logs') is not null then
    delete from public.kick_token_refresh_logs t
    where t.id in (
      select id
      from (
        select id,
               row_number() over (order by id desc) as rn
        from public.kick_token_refresh_logs
      ) ranked
      where ranked.rn > v_keep
    );
    get diagnostics v_deleted_refresh_logs = row_count;
  end if;

  if to_regclass('cron.job') is not null and to_regclass('cron.job_run_details') is not null then
    delete from cron.job_run_details d
    where d.runid in (
      select runid
      from (
        select d2.runid,
               row_number() over (
                 partition by d2.jobid
                 order by coalesce(d2.start_time, d2.end_time) desc nulls last, d2.runid desc
               ) as rn
        from cron.job_run_details d2
        join cron.job j on j.jobid = d2.jobid
        where j.jobname = any(p_target_job_names)
      ) ranked
      where ranked.rn > v_keep
    );
    get diagnostics v_deleted_cron_runs = row_count;
  end if;

  return jsonb_build_object(
    'ok', true,
    'keep', v_keep,
    'deleted_refresh_logs', v_deleted_refresh_logs,
    'deleted_cron_job_runs', v_deleted_cron_runs,
    'at', now()
  );
end;
$$;

create or replace function public.schedule_kick_cron_history_prune(
  p_job_name text default 'kick-cron-history-prune-5m',
  p_schedule text default '*/5 * * * *',
  p_keep integer default 10
)
returns void
language plpgsql
security definer
set search_path = public, cron, extensions
as $$
declare
  v_job_id bigint;
  v_keep integer := greatest(1, coalesce(p_keep, 10));
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
    format('select public.prune_kick_refresh_artifacts(%s);', v_keep)
  );
end;
$$;

create or replace function public.unschedule_kick_cron_history_prune(
  p_job_name text default 'kick-cron-history-prune-5m'
)
returns void
language plpgsql
security definer
set search_path = public, cron, extensions
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

revoke all on function public.prune_kick_refresh_artifacts(integer, text[]) from public;
revoke all on function public.schedule_kick_cron_history_prune(text, text, integer) from public;
revoke all on function public.unschedule_kick_cron_history_prune(text) from public;

grant execute on function public.prune_kick_refresh_artifacts(integer, text[]) to service_role;
grant execute on function public.schedule_kick_cron_history_prune(text, text, integer) to service_role;
grant execute on function public.unschedule_kick_cron_history_prune(text) to service_role;

-- Run once now and keep running automatically.
select public.prune_kick_refresh_artifacts(10);
select public.schedule_kick_cron_history_prune('kick-cron-history-prune-5m', '*/5 * * * *', 10);
