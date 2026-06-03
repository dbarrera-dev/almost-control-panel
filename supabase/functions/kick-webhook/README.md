# kick-webhook (Supabase Edge Function)

Ingesta robusta de webhooks de Kick hacia `public.kick_events` con:

- Verificacion criptografica de `Kick-Event-Signature` (RSA SHA-256, PKCS1-v1_5).
- Idempotencia por `Kick-Event-Message-Id`.
- Escritura con `service_role` (evita inserts directos inseguros desde cliente).

## Requisitos

1. Aplicar migraciones (incluye columnas nuevas + indice unico de `event_id`):
   - `supabase/migrations/20260601000000_kick_events_and_subscribers.sql`
   - `supabase/migrations/20260601020000_kick_webhook_security_and_retention.sql`
2. Configurar la URL webhook de tu app en Kick apuntando a:
   - `https://<PROJECT_REF>.supabase.co/functions/v1/kick-webhook`

## Deploy

```bash
supabase functions deploy kick-webhook
```

## Secrets

Normalmente no hace falta nada extra: la funcion intenta leer la clave publica oficial desde `https://api.kick.com/public/v1/public-key`.

Opcionalmente podes fijarla manualmente:

```bash
supabase secrets set KICK_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
```

## Smoke test local

```bash
supabase functions serve kick-webhook --no-verify-jwt
```

Luego enviar un POST de prueba firmado (o usar un evento real desde Kick).

## Comportamiento esperado

- Firma invalida: `401`.
- Evento duplicado (mismo `Kick-Event-Message-Id`): `200` con `duplicate=true`.
- Evento valido: `200` e insercion en `kick_events`.
