# Kick Token Refresh (24/7)

This Edge Function refreshes Kick OAuth tokens for:

- `prod` broadcaster (`kick_tokens.id = 1`)
- `prod` bot (`kick_tokens.id = 2`)
- `dev` broadcaster (`kick_tokens.id = 3`)
- `dev` bot (`kick_tokens.id = 4`)

It is designed to run from `pg_cron` even when the desktop app is closed.

## 1) Deploy migration

Run your Supabase migration workflow so `2026-05-26_kick_token_refresh_cron.sql` is applied.

## 2) Set required secrets

In Supabase:

- Database table `public.internal_secrets`:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `KICK_CRON_SECRET` (strong random string)
- Edge Function secret:
  - `KICK_CRON_SECRET` (same exact value as `public.internal_secrets`)
  - `SUPABASE_SERVICE_ROLE_KEY` (if not already provided in your environment)

Example CLI:

```bash
supabase secrets set KICK_CRON_SECRET="your-very-long-random-secret"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"
```

For database secrets, use SQL in Supabase SQL editor:

```sql
insert into public.internal_secrets(name, secret)
values
  ('SUPABASE_URL', 'https://<project-ref>.supabase.co'),
  ('SUPABASE_ANON_KEY', '<your-anon-key>'),
  ('KICK_CRON_SECRET', '<same-kick-cron-secret>')
on conflict (name) do update
set secret = excluded.secret,
    updated_at = now();
```

## 3) Deploy function

```bash
supabase functions deploy kick-token-refresh
```

## 4) Schedule cron

This schedules every 15 minutes:

```sql
select public.schedule_kick_token_refresh_cron('kick-token-refresh-15m', '*/15 * * * *');
```

## 5) Manual test

```sql
select public.invoke_kick_token_refresh_cron();
```

Then check logs:

```sql
select *
from public.kick_token_refresh_logs
order by created_at desc
limit 50;
```

## Notes

- Tokens cannot be made truly permanent; this setup keeps them renewed automatically.
- If Kick revokes a refresh token, manual OAuth reauthorization is still required.
