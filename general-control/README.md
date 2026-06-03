# general-control

Panel local para observar y controlar instancias remotas de `almost-control` y `aguz-control` usando Supabase.

## Requisitos

- Node.js 18+
- Credenciales Supabase para cada proyecto (URL + KEY)

## Ejecutar

Desde la raíz de `almost-control`:

```powershell
npm run general:start
```

O directamente:

```powershell
npm --prefix general-control run start
```

## Cómo funciona

- Lee presencia desde `overlay_settings` con prefijo:
  - `runtime_presence_v1:*`
- Envía comandos remotos creando filas con:
  - `runtime_remote_cmd_v1:*`

Cada instancia responde en `value.results[instanceId]` con estado (`running`, `done`, `error`).

## Comandos remotos soportados (instancia destino)

- `kick.connect`
- `kick.disconnect`
- `kick.reconnect`
- `runtime.presence.ping`
- `command.health.reset`
