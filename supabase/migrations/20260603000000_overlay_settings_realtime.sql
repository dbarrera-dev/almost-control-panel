create table if not exists public.overlay_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.overlay_settings
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.set_overlay_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_overlay_settings_updated_at on public.overlay_settings;
create trigger trg_overlay_settings_updated_at
before update on public.overlay_settings
for each row
execute function public.set_overlay_settings_updated_at();

alter table public.overlay_settings replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.overlay_settings;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
