create extension if not exists pgcrypto;

create table if not exists public.content_ideas (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default 'General',
  notes_html text not null default '',
  notes_text text not null default '',
  reference_links jsonb not null default '[]'::jsonb,
  images jsonb not null default '[]'::jsonb,
  status text not null default 'idea',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.discord_webhooks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  webhook_url text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.discord_announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null default '',
  image_url text,
  footer_text text,
  embed_color text not null default '#e07000',
  webhook_id uuid references public.discord_webhooks(id) on delete set null,
  channel_name text,
  bot_name text,
  bot_avatar_url text,
  status text not null default 'sent',
  error_text text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.almost_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_content_ideas_updated_at on public.content_ideas;
create trigger trg_content_ideas_updated_at
before update on public.content_ideas
for each row execute function public.almost_set_updated_at();

drop trigger if exists trg_discord_webhooks_updated_at on public.discord_webhooks;
create trigger trg_discord_webhooks_updated_at
before update on public.discord_webhooks
for each row execute function public.almost_set_updated_at();

drop trigger if exists trg_discord_announcements_updated_at on public.discord_announcements;
create trigger trg_discord_announcements_updated_at
before update on public.discord_announcements
for each row execute function public.almost_set_updated_at();

create index if not exists idx_content_ideas_updated_at
  on public.content_ideas (updated_at desc);

create index if not exists idx_content_ideas_category
  on public.content_ideas (category);

create index if not exists idx_discord_announcements_created_at
  on public.discord_announcements (created_at desc);

create index if not exists idx_discord_announcements_webhook_id
  on public.discord_announcements (webhook_id);

alter table public.content_ideas enable row level security;
alter table public.discord_webhooks enable row level security;
alter table public.discord_announcements enable row level security;

drop policy if exists "almost_content_ideas_all" on public.content_ideas;
create policy "almost_content_ideas_all"
on public.content_ideas for all to anon, authenticated
using (true) with check (true);

drop policy if exists "almost_discord_webhooks_all" on public.discord_webhooks;
create policy "almost_discord_webhooks_all"
on public.discord_webhooks for all to anon, authenticated
using (true) with check (true);

drop policy if exists "almost_discord_announcements_all" on public.discord_announcements;
create policy "almost_discord_announcements_all"
on public.discord_announcements for all to anon, authenticated
using (true) with check (true);

grant select, insert, update, delete on public.content_ideas to anon, authenticated;
grant select, insert, update, delete on public.discord_webhooks to anon, authenticated;
grant select, insert, update, delete on public.discord_announcements to anon, authenticated;

do $$
begin
  alter publication supabase_realtime add table public.content_ideas;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.discord_announcements;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'almost-content',
  'almost-content',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "almost_content_storage_select" on storage.objects;
create policy "almost_content_storage_select"
on storage.objects for select to anon, authenticated
using (bucket_id = 'almost-content');

drop policy if exists "almost_content_storage_insert" on storage.objects;
create policy "almost_content_storage_insert"
on storage.objects for insert to anon, authenticated
with check (bucket_id = 'almost-content');

drop policy if exists "almost_content_storage_update" on storage.objects;
create policy "almost_content_storage_update"
on storage.objects for update to anon, authenticated
using (bucket_id = 'almost-content')
with check (bucket_id = 'almost-content');

drop policy if exists "almost_content_storage_delete" on storage.objects;
create policy "almost_content_storage_delete"
on storage.objects for delete to anon, authenticated
using (bucket_id = 'almost-content');
