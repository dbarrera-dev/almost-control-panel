# Almost Control Panel 🏆

Panel de control unificado para Almost98 — Torneos + Overlays.

## Para generar el .exe (una sola vez en tu PC)

```bash
cd almost-control
npm install
npm run build
```

El instalador aparece en `dist/Almost Control Setup 1.0.0.exe`

## Módulos

### 🏆 Torneos
- Bot conectado al chat de Twitch
- Los viewers escriben `!join` y se guardan en Supabase
- Generación de equipos random del tamaño que quieras
- Historial de torneos

### 🎬 Overlays
- Ya Comenzamos (título, mensaje, timer)
- BRB / Vuelvo Enseguida
- Fin del Stream
- Bracket Rocket League (cuartos, semis, gran final)
- Todo se guarda en Supabase → se refleja en OBS al instante

### ⚙️ Config
- Credenciales de Supabase y Twitch guardadas localmente

## Comandos del chat
- `!join` / `!torneo` / `!unirse` → Unirse al torneo
- `!salir` / `!leave` → Abandonar el torneo
