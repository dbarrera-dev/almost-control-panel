-- Programación de anuncios de Discord.
-- Agrega la columna scheduled_at y el índice que usa el scheduler del proceso principal.
-- El campo status sigue siendo texto libre: ahora admite además
-- 'scheduled' (programado), 'sending' (en envío) y mantiene 'sent' / 'failed'.

alter table public.discord_announcements
  add column if not exists scheduled_at timestamptz;

-- Índice para que el scheduler encuentre rápido los anuncios pendientes
-- (status = 'scheduled' and scheduled_at <= now()).
create index if not exists idx_discord_announcements_schedule
  on public.discord_announcements (status, scheduled_at);
