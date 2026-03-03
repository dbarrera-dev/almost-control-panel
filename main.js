const { app, BrowserWindow, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

// ── Config ────────────────────────────────────────────────────────
const configPath = path.join(app.getPath('userData'), 'almost-config.json');

const DEFAULT_CONFIG = {
  supabaseUrl:   'https://fyfqwlxogdwhhsefjuhf.supabase.co',
  supabaseKey:   'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5ZnF3bHhvZ2R3aGhzZWZqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwNDMyODUsImV4cCI6MjA4NjYxOTI4NX0.i7VuuB4z0TMv0J421snb4wYo2ixtApZuZxtJVmORBZI',
  botUsername:   'BotAlmost',
  botOauth:      'oauth:h5uip5akuviavo0mtqwqw0o4uw6p6o',
  twitchChannel: 'almost',
  logoUrl:       'https://fyfqwlxogdwhhsefjuhf.supabase.co/storage/v1/object/sign/alerts/almost_avatar_a1%20(1).png?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84YmQwY2E2OS1jMGRlLTRmOGQtYjhhMi0wYmY0NjA0YmIyOTciLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJhbGVydHMvYWxtb3N0X2F2YXRhcl9hMSAoMSkucG5nIiwiaWF0IjoxNzcyNTM3NDM1LCJleHAiOjU1MjUzMjE0MzV9.L1vYdRyWcvR4QOEul_d7OVwNjHglsricRUYUNM0wvF4'
};

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch (e) {}
  return { ...DEFAULT_CONFIG };
}
function saveConfig(cfg) { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2)); }

// ── Spotify helpers ────────────────────────────────────────────────
const https = require('https');

function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = body ? Buffer.from(body) : null;
    const opts = { hostname, path, method, headers: { ...headers, ...(buf ? { 'Content-Length': buf.length } : {}) } };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 204) { resolve({ status: 204, data: null }); return; }
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

async function getSpotifyAccessToken(clientId, clientSecret, refreshToken) {
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await httpsRequest('POST', 'accounts.spotify.com', '/api/token',
    { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  return r.data;
}

// ── Window icon helper ─────────────────────────────────────────────
async function downloadImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const follow = (u) => {
      const p = new URL(u);
      mod.get({ hostname: p.hostname, path: p.pathname + (p.search || ''), headers: { 'User-Agent': 'AlmostControl/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return follow(res.headers.location);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject);
    };
    follow(url);
  });
}

async function applyWindowIcon(url) {
  if (!url || !mainWindow) return;
  try {
    const buf = await downloadImageBuffer(url);
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) mainWindow.setIcon(img);
  } catch(e) { /* silently fail if URL is unreachable */ }
}

async function spotifyNowPlayingData() {
  if (!supabase) return null;
  const { data } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
  if (!data?.refresh_token) return null;
  const tokenData = await getSpotifyAccessToken(data.client_id, data.client_secret, data.refresh_token);
  if (!tokenData?.access_token) return null;
  const r = await httpsRequest('GET', 'api.spotify.com', '/v1/me/player/currently-playing',
    { 'Authorization': `Bearer ${tokenData.access_token}` });
  return r.data;
}

// ── State ─────────────────────────────────────────────────────────
let tmiClient = null;
let supabase = null;
let mainWindow = null;
let queue = [];
let processing = false;
let currentTorneoId = null;

// ── Window ────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 1000, minHeight: 650,
    frame: false,
    backgroundColor: '#0e0e0e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(async () => {
  createWindow();
  const cfg = loadConfig();
  if (cfg.logoUrl) applyWindowIcon(cfg.logoUrl);
  if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── Window controls ───────────────────────────────────────────────
ipcMain.handle('window-minimize', () => mainWindow?.minimize());
ipcMain.handle('window-maximize', () => mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize());
ipcMain.handle('window-close', () => app.quit());

// ── Config IPC ────────────────────────────────────────────────────
ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('save-config', (_, cfg) => {
  saveConfig(cfg);
  if (cfg.logoUrl) applyWindowIcon(cfg.logoUrl);
  return { ok: true };
});

// ── Bot IPC ───────────────────────────────────────────────────────
ipcMain.handle('connect-bot', async (_, config) => {
  const tmi = require('tmi.js');
  const { createClient } = require('@supabase/supabase-js');

  if (tmiClient) { try { await tmiClient.disconnect(); } catch (e) {} tmiClient = null; }

  saveConfig(config);
  supabase = createClient(config.supabaseUrl, config.supabaseKey);

  try {
    tmiClient = new tmi.Client({
      identity: {
        username: config.botUsername,
        password: config.botOauth.startsWith('oauth:') ? config.botOauth : `oauth:${config.botOauth}`
      },
      channels: [config.twitchChannel]
    });

    await tmiClient.connect();

    tmiClient.on('message', (channel, tags, message, self) => {
      if (self) return;
      const cmd = message.trim().toLowerCase();
      const nick = tags['display-name'];
      if (['!join', '!torneo', '!unirse'].includes(cmd)) queue.push({ nick, channel, action: 'join' });
      if (['!salir', '!leave'].includes(cmd)) queue.push({ nick, channel, action: 'leave' });
      if (['!song', '!cancion', '!playlist'].includes(cmd)) queue.push({ nick, channel, action: 'song' });
      processQueue();
    });

    tmiClient.on('disconnected', (reason) => {
      mainWindow?.webContents.send('bot-status', { connected: false, reason });
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('disconnect-bot', async () => {
  if (tmiClient) { try { await tmiClient.disconnect(); } catch (e) {} tmiClient = null; }
  currentTorneoId = null;
  return { ok: true };
});

// ── Torneo IPC ────────────────────────────────────────────────────
ipcMain.handle('crear-torneo', async (_, nombre) => {
  if (!supabase) return { ok: false, error: 'Sin conexión a Supabase' };
  await supabase.from('torneos').update({ activo: false }).eq('activo', true);
  const { data, error } = await supabase.from('torneos').insert({ nombre, activo: true }).select().single();
  if (error) return { ok: false, error: error.message };
  currentTorneoId = data.id;
  return { ok: true, torneo: data };
});

ipcMain.handle('get-torneo-activo', async () => {
  if (!supabase) return { ok: false };
  const { data: torneo } = await supabase.from('torneos').select('*').eq('activo', true).order('creado_at', { ascending: false }).limit(1).maybeSingle();
  if (!torneo) return { ok: false };
  currentTorneoId = torneo.id;
  const { data: participantes } = await supabase.from('participantes').select('*').eq('torneo_id', torneo.id).order('joined_at', { ascending: true });
  return { ok: true, torneo, participantes: participantes || [] };
});

ipcMain.handle('cerrar-torneo-db', async (_, torneoId) => {
  if (!supabase || !torneoId) return;
  await supabase.from('torneos').update({ activo: false }).eq('id', torneoId);
  currentTorneoId = null;
});

ipcMain.handle('get-participantes', async (_, torneoId) => {
  if (!supabase) return [];
  const { data } = await supabase.from('participantes').select('*').eq('torneo_id', torneoId).order('joined_at', { ascending: true });
  return data || [];
});

ipcMain.handle('get-torneos', async () => {
  if (!supabase) return [];
  const { data } = await supabase.from('torneos').select('*, participantes(count)').order('creado_at', { ascending: false }).limit(30);
  return data || [];
});

ipcMain.handle('generar-equipos', async (_, { torneoId, tamanio }) => {
  if (!supabase) return { ok: false };
  const { data } = await supabase.from('participantes').select('nick').eq('torneo_id', torneoId);
  if (!data?.length) return { ok: false, error: 'No hay participantes' };

  const arr = [...data];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const equipos = [];
  for (let i = 0; i < arr.length; i += tamanio) equipos.push(arr.slice(i, i + tamanio).map(p => p.nick));

  for (let i = 0; i < equipos.length; i++) {
    const { data: eq } = await supabase.from('equipos').insert({ torneo_id: torneoId, nombre: `Equipo ${i + 1}` }).select().single();
    if (eq) await supabase.from('equipo_miembros').insert(equipos[i].map(nick => ({ equipo_id: eq.id, nick })));
  }
  return { ok: true, equipos };
});

ipcMain.handle('eliminar-participante', async (_, { nick, torneoId }) => {
  if (!supabase) return { ok: false };
  await supabase.from('participantes').delete().eq('nick', nick).eq('torneo_id', torneoId);
  return { ok: true };
});

ipcMain.handle('eliminar-torneo', async (_, torneoId) => {
  if (!supabase || !torneoId) return { ok: false, error: 'Sin conexión o ID inválido' };
  const errors = [];

  const r1 = await supabase.from('participantes').delete().eq('torneo_id', torneoId);
  if (r1.error) errors.push('participantes: ' + r1.error.message);

  const { data: eqs } = await supabase.from('equipos').select('id').eq('torneo_id', torneoId);
  const eqIds = eqs?.map(e => e.id) || [];
  if (eqIds.length > 0) {
    const r2 = await supabase.from('equipo_miembros').delete().in('equipo_id', eqIds);
    if (r2.error) errors.push('equipo_miembros: ' + r2.error.message);
  }

  const r3 = await supabase.from('equipos').delete().eq('torneo_id', torneoId);
  if (r3.error) errors.push('equipos: ' + r3.error.message);

  const r4 = await supabase.from('torneos').delete().eq('id', torneoId);
  if (r4.error) return { ok: false, error: r4.error.message, errors };

  if (currentTorneoId === torneoId) currentTorneoId = null;
  return { ok: true, warnings: errors };
});

// ── Overlay IPC ───────────────────────────────────────────────────
ipcMain.handle('overlay-load-all', async () => {
  if (!supabase) return { ok: false, error: 'Sin conexión' };
  try {
    const { data: settings } = await supabase.from('overlay_settings').select('key, value');
    const { data: bracket } = await supabase.from('tournament_bracket').select('*').order('round').order('match_index');
    const result = {};
    (settings || []).forEach(s => result[s.key] = s.value);
    return { ok: true, settings: result, bracket: bracket || [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('overlay-update', async (_, { key, value }) => {
  if (!supabase) return { ok: false };
  const { error } = await supabase.from('overlay_settings').upsert({ key, value }, { onConflict: 'key' });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
});

ipcMain.handle('bracket-update', async (_, { id, data }) => {
  if (!supabase) return { ok: false };
  const { error } = await supabase.from('tournament_bracket').update(data).eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
});

ipcMain.handle('bracket-reset', async () => {
  if (!supabase) return { ok: false };
  const { data: matches } = await supabase.from('tournament_bracket').select('id');
  if (matches) {
    for (const m of matches) {
      await supabase.from('tournament_bracket').update({ team_a: '', team_b: '', score_a: 0, score_b: 0, winner: null }).eq('id', m.id);
    }
  }
  return { ok: true };
});

// ── Spotify IPC ───────────────────────────────────────────────────
ipcMain.handle('get-spotify-status', async () => {
  if (!supabase) return { ok: false, connected: false };
  const { data } = await supabase.from('spotify_tokens').select('id').eq('id', 1).maybeSingle();
  return { ok: true, connected: !!data };
});

ipcMain.handle('spotify-now-playing', async () => {
  try {
    const track = await spotifyNowPlayingData();
    if (!track || !track.item) return { ok: true, playing: false };
    return {
      ok: true,
      playing: track.is_playing,
      track: {
        name: track.item.name,
        artist: track.item.artists.map(a => a.name).join(', '),
        album: track.item.album.name,
        image: track.item.album.images[1]?.url || track.item.album.images[0]?.url || ''
      }
    };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('open-spotify-connect', () => {
  shell.openExternal('https://www.almostcoach.com/spotify');
  return { ok: true };
});

ipcMain.handle('open-url', (_, url) => {
  if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
    shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false, error: 'URL inválida' };
});

// ── Queue ─────────────────────────────────────────────────────────
async function processQueue() {
  if (processing || !queue.length) return;
  processing = true;
  while (queue.length > 0) {
    const { nick, channel, action } = queue.shift();
    if (!currentTorneoId) {
      mainWindow?.webContents.send('bot-log', { type: 'warn', msg: `${nick} usó !join pero no hay torneo activo` });
      continue;
    }
    if (action === 'join') {
      const { error } = await supabase.from('participantes').insert({ nick, torneo_id: currentTorneoId });
      if (error?.code === '23505') {
        tmiClient?.say(channel, `@${nick} ¡Ya estás apuntado! 😄`);
        mainWindow?.webContents.send('bot-log', { type: 'warn', msg: `${nick} ya estaba apuntado` });
      } else if (!error) {
        tmiClient?.say(channel, `@${nick} ✅ ¡Te has unido al torneo!`);
        mainWindow?.webContents.send('bot-log', { type: 'join', msg: `${nick} se unió ✅` });
        mainWindow?.webContents.send('new-participante', { nick, joined_at: new Date() });
      }
    }
    if (action === 'song') {
      try {
        const track = await spotifyNowPlayingData();
        if (track?.item) {
          const name = track.item.name;
          const artists = track.item.artists.map(a => a.name).join(', ');
          tmiClient?.say(channel, `🎵 ${name} — ${artists}`);
        } else {
          tmiClient?.say(channel, '🎵 No hay nada reproduciéndose ahora.');
        }
      } catch { tmiClient?.say(channel, '🎵 No se pudo obtener la canción.'); }
    }
    if (action === 'leave') {
      const { count } = await supabase.from('participantes').delete({ count: 'exact' }).eq('nick', nick).eq('torneo_id', currentTorneoId);
      if (count > 0) {
        tmiClient?.say(channel, `@${nick} 👋 Has abandonado el torneo.`);
        mainWindow?.webContents.send('bot-log', { type: 'leave', msg: `${nick} abandonó el torneo` });
        mainWindow?.webContents.send('remove-participante', { nick });
      }
    }
  }
  processing = false;
}
