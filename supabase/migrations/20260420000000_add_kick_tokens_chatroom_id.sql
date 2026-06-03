-- Kick: soporte de chatroom_id por ambiente en kick_tokens
alter table if exists public.kick_tokens
  add column if not exists chatroom_id text not null default '';
