const { app, BrowserWindow, ipcMain, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
let autoUpdater = null;

function resolveAppPath(relPath) {
  const appRoot = app.getAppPath();
  const candidates = [
    path.join(process.cwd(), relPath),
    path.join(appRoot, relPath),
    path.join(__dirname, relPath),
    path.join(process.resourcesPath || '', 'app.asar', relPath),
    path.join(process.resourcesPath || '', 'app', relPath),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return candidates[0];
}

function resolvePreloadPath(preloadCandidates) {
  for (const p of preloadCandidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return preloadCandidates[0];
}

function setupDiagnostics(win) {
  let diagPath = null;
  try {
    diagPath = path.join(app.getPath('userData'), 'diagnostic.log');
  } catch {}
  if (!diagPath || !win?.webContents) return;

  const log = (msg) => {
    try {
      fs.appendFileSync(diagPath, `${new Date().toISOString()} ${msg}\n`);
    } catch {}
  };

  log('--- app start ---');
  try {
    const prefs = win.webContents.getLastWebPreferences?.();
    if (prefs?.preload) log(`preload path: ${prefs.preload}`);
    if (prefs?.contextIsolation != null) log(`contextIsolation: ${prefs.contextIsolation}`);
    if (prefs?.nodeIntegration != null) log(`nodeIntegration: ${prefs.nodeIntegration}`);
  } catch {}

  win.webContents.on('console-message', (_, level, message, line, sourceId) => {
    log(`console[${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('did-fail-load', (_, code, desc, url) => {
    log(`did-fail-load ${code} ${desc} ${url}`);
  });
  win.webContents.on('render-process-gone', (_, details) => {
    log(`render-process-gone ${JSON.stringify(details)}`);
  });
  win.webContents.on('did-finish-load', async () => {
    log('did-finish-load');
    try {
      const apiType = await win.webContents.executeJavaScript('typeof window.api', true);
      log(`window.api typeof: ${apiType}`);
    } catch (e) {
      log(`executeJavaScript error: ${e && e.message ? e.message : e}`);
    }
  });
}
const { createConfigStore } = require('./main/config');
const { httpsRequest } = require('./main/net');
const { applyWindowIcon } = require('./main/window-icon');
const { registerWindowIpc } = require('./main/ipc/window');
const { registerConfigIpc } = require('./main/ipc/config');
const { registerUtilsIpc } = require('./main/ipc/utils');
const { registerBotIpc } = require('./main/ipc/bot');
const { registerKickIpc } = require('./main/ipc/kick');
const { registerTorneoIpc } = require('./main/ipc/torneo');
const { registerOverlayIpc } = require('./main/ipc/overlay');
const { registerSpotifyIpc } = require('./main/ipc/spotify');
const { registerTwitchIpc } = require('./main/ipc/twitch');
const { registerDuelosIpc } = require('./main/ipc/duelos');
const { registerTodosIpc } = require('./main/ipc/todos');
const { registerSorteoIpc } = require('./main/ipc/sorteo');
const { registerLogsIpc } = require('./main/ipc/logs');
const { registerKeyOverlayIpc } = require('./main/ipc/keyoverlay');
const { registerSpotifyOverlayIpc } = require('./main/ipc/spotify-overlay');
const { registerTeamsOverlayIpc } = require('./main/ipc/teams-overlay');
const { registerRlOverlayIpc } = require('./main/ipc/rl-overlay');
const { createOverlays } = require('./main/overlays');
const { createKickService } = require('./main/kick-service');
const { createTwitchHelix } = require('./main/twitch-helix');
const {
  getSpotifyAccessToken,
  parseSpotifyLink,
  parseYouTubeLink,
  youtubeToSpotifyQuery,
  searchSpotifyTrack,
  spotifyGetTrackName,
} = require('./main/spotify-utils');

const { loadConfig, saveConfig } = createConfigStore(app);

// ── Single instance lock ───────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  // Si alguien intenta abrir una segunda instancia, traer la ventana al frente
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// ── Spotify OAuth flow ────────────────────────────────────────────
const SPOTIFY_OAUTH_PORT = 8888;
const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_OAUTH_PORT}/callback`;
const SPOTIFY_SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative';

// ── Kick OAuth ────────────────────────────────────────────────────
const KICK_OAUTH_PORT = 8889;
const KICK_REDIRECT_URI = `http://127.0.0.1:${KICK_OAUTH_PORT}/callback`;
const KICK_SCOPES = 'user:read channel:read channel:rewards:read channel:rewards:write events:subscribe chat:write';

function startSpotifyOAuthFlow(clientId) {
  return new Promise((resolve, reject) => {
    const authUrl = `https://accounts.spotify.com/authorize?${new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: SPOTIFY_REDIRECT_URI,
      scope: SPOTIFY_SCOPES
    })}`;

    const okHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Spotify conectado</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#f0f0f0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}.card{background:#111;border:1px solid #1a1a1a;border-radius:16px;padding:40px 48px;display:inline-flex;flex-direction:column;align-items:center;gap:16px}.icon{width:64px;height:64px;background:#1DB95420;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px}.title{font-size:22px;font-weight:700;color:#1DB954}.sub{font-size:13px;color:#555;line-height:1.6}</style></head><body><div class="card"><div class="icon">&#10003;</div><div class="title">Cuenta conectada</div><div class="sub">Ya podes cerrar esta pestana y volver al panel.</div></div></body></html>`;
    const errHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Error</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#f0f0f0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}.card{background:#111;border:1px solid #1a1a1a;border-radius:16px;padding:40px 48px;display:inline-flex;flex-direction:column;align-items:center;gap:16px}.icon{width:64px;height:64px;background:#ff6b6b20;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px}.title{font-size:22px;font-weight:700;color:#ff6b6b}.sub{font-size:13px;color:#555;line-height:1.6}</style></head><body><div class="card"><div class="icon">&#10005;</div><div class="title">Error al conectar</div><div class="sub">Cerra esta pestana y volvé a intentarlo.</div></div></body></html>`;

    const timeout = setTimeout(() => { server.close(); reject(new Error('Timeout: no se completó la autorización')); }, 5 * 60 * 1000);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${SPOTIFY_OAUTH_PORT}`);
      if (url.pathname !== '/callback') { res.end(); return; }

      clearTimeout(timeout);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (error || !code) {
        res.end(errHtml);
        server.close();
        reject(new Error(error || 'Sin código de autorización'));
        return;
      }
      res.end(okHtml);
      server.close();
      resolve(code);
    });

    server.on('error', () => {
      clearTimeout(timeout);
      reject(new Error(`Puerto ${SPOTIFY_OAUTH_PORT} ocupado. Cerrá otras instancias e intentá de nuevo.`));
    });

    server.listen(SPOTIFY_OAUTH_PORT, () => shell.openExternal(authUrl));
  });
}

// ── Kick OAuth flow (PKCE) ────────────────────────────────────────
let _kickCodeVerifier = null;
function getKickCodeVerifier() { return _kickCodeVerifier; }


function startKickOAuthFlow(clientId) {
  const crypto = require('crypto');
  _kickCodeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(_kickCodeVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    // Workaround: parámetro "redirect" sacrificial antes de redirect_uri
    // para evitar bug de NextJS que reemplaza 127.0.0.1 por localhost
    const params = new URLSearchParams([
      ['response_type', 'code'],
      ['client_id', clientId],
      ['redirect', '127.0.0.1'],
      ['redirect_uri', KICK_REDIRECT_URI],
      ['scope', KICK_SCOPES],
      ['code_challenge', codeChallenge],
      ['code_challenge_method', 'S256'],
      ['state', state]
    ]);
    const authUrl = `https://id.kick.com/oauth/authorize?${params}`;

    const okHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Kick conectado</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#f0f0f0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}.card{background:#111;border:1px solid #1a1a1a;border-radius:16px;padding:40px 48px;display:inline-flex;flex-direction:column;align-items:center;gap:16px}.icon{width:64px;height:64px;background:#53FC1820;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px}.title{font-size:22px;font-weight:700;color:#53FC18}.sub{font-size:13px;color:#555;line-height:1.6}</style></head><body><div class="card"><div class="icon">&#10003;</div><div class="title">Kick conectado</div><div class="sub">Ya podes cerrar esta pestana y volver al panel.</div></div></body></html>`;
    const errHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Error</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#f0f0f0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}.card{background:#111;border:1px solid #1a1a1a;border-radius:16px;padding:40px 48px;display:inline-flex;flex-direction:column;align-items:center;gap:16px}.icon{width:64px;height:64px;background:#ff6b6b20;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px}.title{font-size:22px;font-weight:700;color:#ff6b6b}.sub{font-size:13px;color:#555;line-height:1.6}</style></head><body><div class="card"><div class="icon">&#10005;</div><div class="title">Error al conectar</div><div class="sub">Cerra esta pestana y volvé a intentarlo.</div></div></body></html>`;

    const timeout = setTimeout(() => { server.close(); reject(new Error('Timeout')); }, 5 * 60 * 1000);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${KICK_OAUTH_PORT}`);
      if (url.pathname !== '/callback') { res.end(); return; }
      clearTimeout(timeout);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (error || !code) { res.end(errHtml); server.close(); reject(new Error(error || 'Sin código')); return; }
      res.end(okHtml);
      server.close();
      resolve(code);
    });

    server.on('error', () => { clearTimeout(timeout); reject(new Error(`Puerto ${KICK_OAUTH_PORT} ocupado.`)); });
    server.listen(KICK_OAUTH_PORT, '127.0.0.1', () => shell.openExternal(authUrl));
  });
}

async function spotifyNowPlayingData() {
  if (!supabase) throw new Error('Sin conexión a Supabase');
  const { data } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
  if (!data?.refresh_token) throw new Error('No hay tokens guardados en Supabase');
  const tokenData = await getSpotifyAccessToken(data.client_id, data.client_secret, data.refresh_token);
  if (!tokenData?.access_token) throw new Error(tokenData?.error_description || tokenData?.error || 'No se pudo obtener access token');
  const r = await httpsRequest('GET', 'api.spotify.com', '/v1/me/player',
    { 'Authorization': `Bearer ${tokenData.access_token}` });
  if (r.status === 401) throw new Error('Token inválido o expirado (401)');
  if (r.status === 403) throw new Error('Sin permisos suficientes en Spotify (403)');
  if (r.status !== 200 && r.status !== 204) throw new Error(`Respuesta inesperada de Spotify: ${r.status}`);
  return r.data;
}

async function spotifyPlayerCommand(method, endpoint, body) {
  if (!supabase) return { ok: false, error: 'Sin conexión a Supabase' };
  const { data } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
  if (!data?.refresh_token) return { ok: false, error: 'Sin refresh token' };
  const tokenData = await getSpotifyAccessToken(data.client_id, data.client_secret, data.refresh_token);
  if (!tokenData?.access_token) return { ok: false, error: 'No se pudo obtener access token' };
  const headers = { 'Authorization': `Bearer ${tokenData.access_token}`, 'Content-Type': 'application/json' };
  const r = await httpsRequest(method, 'api.spotify.com', endpoint, headers, body !== null ? JSON.stringify(body ?? {}) : null);
  const ok = r.status >= 200 && r.status < 300;
  return { ok, status: r.status, error: ok ? null : (r.data?.error?.message || `HTTP ${r.status}`) };
}

async function spotifyGetQueueData() {
  if (!supabase) return { ok: false, error: 'Sin conexi?n a Supabase' };
  const { data } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
  if (!data?.refresh_token) return { ok: false, error: 'Sin refresh token' };
  const tokenData = await getSpotifyAccessToken(data.client_id, data.client_secret, data.refresh_token);
  if (!tokenData?.access_token) return { ok: false, error: 'No se pudo obtener access token' };
  const r = await httpsRequest('GET', 'api.spotify.com', '/v1/me/player/queue',
    { 'Authorization': `Bearer ${tokenData.access_token}` });
  const ok = r.status === 200;
  return { ok, status: r.status, data: ok ? r.data : null, error: ok ? null : (r.data?.error?.message || `HTTP ${r.status}`) };
}


let tmiClient = null;
let kickAccessToken = null;
let kickBotAccessToken = null;
let kickChannelId = null;
let kickChatroomId = null;
let kickPollTimer = null;
let kickLastEventId = null;
let supabase = null;
let mainWindow = null;
let splashWindow = null;
let tray = null;
let isQuitting = false;
let queue = [];
let processing = false;
let currentTorneoId = null;
let currentTorneoMax = 0; // 0 = sin límite
let torneoTwitchNicks = new Set(); // Twitch nicks ya inscriptos en el torneo actual
let torneoKickNicks   = new Set(); // Kick nicks ya inscriptos en el torneo actual
let currentSorteoCmd = '!sorteo';
let sorteoActivo = false;
let songRequestEnabled = false;
let songRequestTwitchEnabled = true;
let songRequestKickEnabled = true;
let songRequestRewardId = '';


let keyOverlayRunning = false;
let koDetecting = false;
let keyOverlayConfig = {
  selectedKeys: [42,16,17,18,30,31,32,23,24,37,38,57],
  customKeys: [], // [{keycode, label, row}] - teclas detectadas manualmente
  style: { fontSize: 'md', keyColor: '#ffffff', bgColor: 'rgba(15,15,20,0.9)', accentColor: '#f97316', fadeDelay: 0, inactiveOpacity: 0.3 },
  gamepadEnabled: false,
  gamepadButtons: {} // e.g. { "0": 57 } = button 0 -> Space
};

let spotifyOverlayConfig = {
  layout:   'row', // row | col | compact | minimal | full
  fontSize: 'md',  // sm | md | lg | xl
  show: { art: true, title: true, artist: true, album: false, progress: true, time: true, eq: true },
  style:  { bg: 'rgba(15,15,20,0.92)', text: '#ffffff', accent: '#1DB954', radius: 12 }
};
let spotifyOverlayRunning    = false;
let spotifyRequesterQueue    = []; // pending requests [{ nick, trackId }, ...]
let spotifyActiveRequester   = null; // { nick, trackId } - currently playing requested track
let _sessionDoneIds          = new Set(); // trackIds ya reproducidos en esta sesión (safeguard local)
let skipVotes                = new Set(); // nicks that voted !skip for the current song
let skipVotesTrackId         = null;     // track id the current skip vote is for

let teamsOverlayRunning    = false;

let rlOverlayConfig = {
  platform: 'epic', // epic | steam | psn | xbl
  username: '',
  style: { bg: 'rgba(15,15,20,0.92)', text: '#ffffff', accent: '#2563eb', radius: 12 }
};
let rlStats      = null; // { mmr, rank, tier, wins, losses, matches, winRate }
let rlSessionStart = null; // snapshot at session start
let rlOverlayRunning    = false;


const state = {
  get tmiClient() { return tmiClient; },
  set tmiClient(v) { tmiClient = v; },
  get kickAccessToken() { return kickAccessToken; },
  set kickAccessToken(v) { kickAccessToken = v; },
  get kickBotAccessToken() { return kickBotAccessToken; },
  set kickBotAccessToken(v) { kickBotAccessToken = v; },
  get kickChannelId() { return kickChannelId; },
  set kickChannelId(v) { kickChannelId = v; },
  get kickChatroomId() { return kickChatroomId; },
  set kickChatroomId(v) { kickChatroomId = v; },
  get kickPollTimer() { return kickPollTimer; },
  set kickPollTimer(v) { kickPollTimer = v; },
  get kickLastEventId() { return kickLastEventId; },
  set kickLastEventId(v) { kickLastEventId = v; },
  get supabase() { return supabase; },
  set supabase(v) { supabase = v; },
  get mainWindow() { return mainWindow; },
  set mainWindow(v) { mainWindow = v; },
  get splashWindow() { return splashWindow; },
  set splashWindow(v) { splashWindow = v; },
  get tray() { return tray; },
  set tray(v) { tray = v; },
  get isQuitting() { return isQuitting; },
  set isQuitting(v) { isQuitting = v; },
  get queue() { return queue; },
  set queue(v) { queue = v; },
  get processing() { return processing; },
  set processing(v) { processing = v; },
  get currentTorneoId() { return currentTorneoId; },
  set currentTorneoId(v) { currentTorneoId = v; },
  get currentTorneoMax() { return currentTorneoMax; },
  set currentTorneoMax(v) { currentTorneoMax = v; },
  get torneoTwitchNicks() { return torneoTwitchNicks; },
  set torneoTwitchNicks(v) { torneoTwitchNicks = v; },
  get torneoKickNicks() { return torneoKickNicks; },
  set torneoKickNicks(v) { torneoKickNicks = v; },
  get currentSorteoCmd() { return currentSorteoCmd; },
  set currentSorteoCmd(v) { currentSorteoCmd = v; },
  get sorteoActivo() { return sorteoActivo; },
  set sorteoActivo(v) { sorteoActivo = v; },
  get songRequestEnabled() { return songRequestEnabled; },
  set songRequestEnabled(v) { songRequestEnabled = v; },
  get songRequestTwitchEnabled() { return songRequestTwitchEnabled; },
  set songRequestTwitchEnabled(v) { songRequestTwitchEnabled = v; },
  get songRequestKickEnabled() { return songRequestKickEnabled; },
  set songRequestKickEnabled(v) { songRequestKickEnabled = v; },
  get songRequestRewardId() { return songRequestRewardId; },
  set songRequestRewardId(v) { songRequestRewardId = v; },
  get keyOverlayRunning() { return keyOverlayRunning; },
  set keyOverlayRunning(v) { keyOverlayRunning = v; },
  get keyOverlayConfig() { return keyOverlayConfig; },
  set keyOverlayConfig(v) { keyOverlayConfig = v; },
  get koDetecting() { return koDetecting; },
  set koDetecting(v) { koDetecting = v; },
  get spotifyOverlayConfig() { return spotifyOverlayConfig; },
  set spotifyOverlayConfig(v) { spotifyOverlayConfig = v; },
  get spotifyOverlayRunning() { return spotifyOverlayRunning; },
  set spotifyOverlayRunning(v) { spotifyOverlayRunning = v; },
  get spotifyRequesterQueue() { return spotifyRequesterQueue; },
  set spotifyRequesterQueue(v) { spotifyRequesterQueue = v; },
  get spotifyActiveRequester() { return spotifyActiveRequester; },
  set spotifyActiveRequester(v) { spotifyActiveRequester = v; },
  get sessionDoneIds() { return _sessionDoneIds; },
  get teamsOverlayRunning() { return teamsOverlayRunning; },
  set teamsOverlayRunning(v) { teamsOverlayRunning = v; },
  get rlOverlayConfig() { return rlOverlayConfig; },
  set rlOverlayConfig(v) { rlOverlayConfig = v; },
  get rlOverlayRunning() { return rlOverlayRunning; },
  set rlOverlayRunning(v) { rlOverlayRunning = v; },
  get rlStats() { return rlStats; },
  set rlStats(v) { rlStats = v; },
  get rlSessionStart() { return rlSessionStart; },
  set rlSessionStart(v) { rlSessionStart = v; },
};

const {
  startKeyOverlay,
  stopKeyOverlay,
  broadcastOverlay,
  configMsg,
  startSpotifyOverlay,
  broadcastSpotify,
  startTeamsOverlay,
  startRLOverlay,
  refreshRLStats,
  broadcastRL,
} = createOverlays({ state, http, fs, path, os, saveLog, spotifyNowPlayingData });

const {
  kickApiRequest,
  kickChatSend,
  connectKickBot,
  stopKickPolling,
} = createKickService({ loadConfig, saveConfig, httpsRequest, saveLog, state, processQueue });

const { twitchHelixGet, twitchHelixPatch, getTwitchBroadcasterId } = createTwitchHelix({ httpsRequest });

function registerIpcHandlers() {
  registerWindowIpc({ ipcMain, app, state });
  registerConfigIpc({ ipcMain, app, loadConfig, saveConfig, applyWindowIcon, state });
  registerUtilsIpc({ ipcMain, shell });
  registerBotIpc({ ipcMain, loadConfig, saveConfig, saveLog, processQueue, state });
  registerKickIpc({
    ipcMain,
    loadConfig,
    saveConfig,
    startKickOAuthFlow,
    getKickCodeVerifier,
    KICK_REDIRECT_URI,
    httpsRequest,
    kickApiRequest,
    connectKickBot,
    stopKickPolling,
    saveLog,
    state,
  });
  registerTorneoIpc({ ipcMain, saveLog, state });
  registerOverlayIpc({ ipcMain, state });
  registerSpotifyIpc({
    ipcMain,
    loadConfig,
    saveConfig,
    spotifyNowPlayingData,
    spotifyPlayerCommand,
    startSpotifyOAuthFlow,
    SPOTIFY_REDIRECT_URI,
    httpsRequest,
    getSpotifyAccessToken,
    parseSpotifyLink,
    spotifyGetTrackName,
    saveLog,
    state,
  });
  registerTwitchIpc({ ipcMain, loadConfig, saveConfig, getTwitchBroadcasterId, twitchHelixGet, twitchHelixPatch });
  registerDuelosIpc({ ipcMain, saveLog, state });
  registerTodosIpc({ ipcMain, saveLog, state });
  registerSorteoIpc({ ipcMain, saveLog, state });
  registerLogsIpc({ ipcMain, state });
  registerKeyOverlayIpc({ ipcMain, loadConfig, saveConfig, startKeyOverlay, stopKeyOverlay, broadcastOverlay, configMsg, state });
  registerSpotifyOverlayIpc({ ipcMain, loadConfig, saveConfig, startSpotifyOverlay, broadcastSpotify, state });
  registerTeamsOverlayIpc({ ipcMain, state });
  registerRlOverlayIpc({ ipcMain, loadConfig, saveConfig, startRLOverlay, refreshRLStats, broadcastRL, state });
}

// ── Window ────────────────────────────────────────────────────────
function createWindow() {
  const preloadCandidates = [
    path.join(process.cwd(), 'preload.js'),
    path.join(app.getAppPath(), 'preload.js'),
    path.join(__dirname, 'preload.js'),
    path.join(process.resourcesPath || '', 'app.asar', 'preload.js'),
    path.join(process.resourcesPath || '', 'app', 'preload.js'),
  ];
  const preloadPath = resolvePreloadPath(preloadCandidates);
  const indexPath = resolveAppPath(path.join('src', 'index.html'));
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 1000, minHeight: 650,
    frame: false,
    show: false,
    backgroundColor: '#0e0e0e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: preloadPath
    }
  });
  setupDiagnostics(mainWindow);
  mainWindow.loadFile(indexPath);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createSplash() {
  const splashPath = resolveAppPath(path.join('src', 'splash.html'));
  splashWindow = new BrowserWindow({
    width: 400, height: 260,
    frame: false,
    resizable: false,
    center: true,
    backgroundColor: '#0e0e0e',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  splashWindow.loadFile(splashPath);
}

function sendToSplash(channel, data) {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send(channel, data);
}

function closeSplashAndShowMain() {
  if (splashWindow && !splashWindow.isDestroyed()) { splashWindow.close(); splashWindow = null; }
  mainWindow?.show();
}

async function autoLoadBotFromSupabase() {
  if (!supabase) return;
  try {
    const { data: bt } = await supabase.from('bot_config').select('*').eq('id', 1).maybeSingle();
    if (!bt) return;
    const cfg = loadConfig();
    let changed = false;
    // Sobrescribir siempre desde Supabase si hay datos (para sincronizar entre dispositivos)
    if (bt.bot_username   && bt.bot_username   !== cfg.botUsername)   { cfg.botUsername   = bt.bot_username;   changed = true; }
    if (bt.bot_oauth      && bt.bot_oauth      !== cfg.botOauth)      { cfg.botOauth      = bt.bot_oauth;      changed = true; }
    if (bt.twitch_channel && bt.twitch_channel !== cfg.twitchChannel) { cfg.twitchChannel = bt.twitch_channel; changed = true; }
    if (changed) {
      saveConfig(cfg);
      saveLog('info', 'Bot Twitch: credenciales actualizadas desde Supabase');
      mainWindow?.webContents.send('bot-config-loaded', {});
    }
  } catch {}
}

async function autoLoadKickFromSupabase() {
  if (!supabase) return;
  try {
    const { data: kt } = await supabase.from('kick_tokens').select('*').eq('id', 1).maybeSingle();
    if (kt) {
      const cfg = loadConfig();
      let changed = false;
      if (kt.client_id     && !cfg.kickClientId)            { cfg.kickClientId            = kt.client_id;     changed = true; }
      if (kt.client_secret && !cfg.kickClientSecret)        { cfg.kickClientSecret        = kt.client_secret; changed = true; }
      if (kt.channel       && !cfg.kickChannel)             { cfg.kickChannel             = kt.channel;       changed = true; }
      if (kt.access_token  && !cfg.kickAccessToken)         { cfg.kickAccessToken         = kt.access_token;  changed = true; }
      if (kt.refresh_token && !cfg.kickRefreshToken)        { cfg.kickRefreshToken        = kt.refresh_token; changed = true; }
      if (kt.reward_id     && kt.reward_id !== cfg.kickSongRequestRewardId) { cfg.kickSongRequestRewardId = kt.reward_id;     changed = true; }
      if (changed) {
        saveConfig(cfg);
        saveLog('info', 'Kick: credenciales cargadas desde Supabase');
        mainWindow?.webContents.send('kick-config-loaded', {});
      }
    }
    // Auto-connect si está habilitado y aún no está conectado (independiente de si había datos en Supabase)
    const latestCfg = loadConfig();
    if (latestCfg.autoConnectKickBot !== false && latestCfg.kickAccessToken && latestCfg.kickChannel && latestCfg.kickClientId && !kickPollTimer) {
      saveLog('info', 'Kick: auto-conectando bot...');
      connectKickBot();
    }
  } catch (e) {
    saveLog('warn', `[autoLoadKick] error: ${e?.message || e}`);
  }
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  tray = new Tray(iconPath);
  tray.setToolTip('Almost Control');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Salir', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => mainWindow?.show());
}

app.whenReady().then(async () => {
  createWindow();
  createTray();
  const cfg = loadConfig();
  if (cfg.logoUrl) applyWindowIcon(cfg.logoUrl, mainWindow);
  if (cfg.keyOverlayConfig) {
    keyOverlayConfig = {
      ...keyOverlayConfig,
      ...cfg.keyOverlayConfig,
      style: { ...keyOverlayConfig.style, ...(cfg.keyOverlayConfig.style || {}) }
    };
  }
  if (cfg.spotifyOverlayConfig)  spotifyOverlayConfig  = cfg.spotifyOverlayConfig;
  if (cfg.rlOverlayConfig)       rlOverlayConfig       = cfg.rlOverlayConfig;
  songRequestEnabled        = cfg.songRequestEnabled        ?? true;
  songRequestTwitchEnabled  = cfg.songRequestTwitchEnabled  ?? true;
  songRequestKickEnabled    = cfg.songRequestKickEnabled    ?? true;
  // Si alguna plataforma está activa, el master tiene que estar activo
  if ((songRequestTwitchEnabled || songRequestKickEnabled) && !songRequestEnabled) {
    songRequestEnabled = true;
    const fixCfg = loadConfig(); fixCfg.songRequestEnabled = true; saveConfig(fixCfg);
  }
  songRequestRewardId       = cfg.songRequestRewardId       ?? '';
  if (cfg.supabaseUrl && cfg.supabaseKey && !supabase) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey);
  }
  startSpotifyOverlay();
  startRLOverlay();
  startKeyOverlay();
  startTeamsOverlay();
  setTimeout(syncRequesterFromSupabase, 3000);
  setTimeout(autoLoadBotFromSupabase, 1000);
  setTimeout(autoLoadKickFromSupabase, 2000);

  if (!app.isPackaged) { mainWindow.show(); return; }

  if (!autoUpdater) {
    ({ autoUpdater } = require('electron-updater'));
  }

  createSplash();
  const fallback = setTimeout(() => closeSplashAndShowMain(), 120000);
  const done = () => { clearTimeout(fallback); closeSplashAndShowMain(); };

  autoUpdater.on('checking-for-update', () => sendToSplash('splash-status', { msg: 'Buscando actualizaciones...' }));
  autoUpdater.on('update-not-available', () => {
    sendToSplash('splash-status', { msg: 'Todo al día ✓', type: 'ok' });
    setTimeout(done, 800);
  });
  autoUpdater.on('update-available', (info) => {
    sendToSplash('splash-status', { msg: `Nueva versión ${info.version} disponible` });
  });
  autoUpdater.on('download-progress', (p) => sendToSplash('splash-progress', p.percent));
  autoUpdater.on('update-downloaded', () => {
    sendToSplash('splash-status', { msg: 'Actualizando, un momento...' });
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 2000);
  });
  autoUpdater.on('error', () => done());

  splashWindow.webContents.on('did-finish-load', () => {
    sendToSplash('splash-version', app.getVersion());
    autoUpdater.checkForUpdates();
  });
});
app.on('window-all-closed', () => { /* no quit on close — tray keeps app alive */ });
app.on('before-quit', () => {
  stopKeyOverlay();
  if (_syncRequesterInterval) clearInterval(_syncRequesterInterval);
});

// -- IPC handlers (modularizados) ---------------------------------------------
registerIpcHandlers();

// ── Log helper ────────────────────────────────────────────────────
function saveLog(type, msg) {
  mainWindow?.webContents.send('bot-log', { type, msg });
  if (supabase) {
    supabase.from('app_logs').insert({ type, msg }).then(() => {}).catch(() => {});
  }
}

async function syncRequesterFromSupabase() {
  if (!supabase) return;
  try {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: srRows } = await supabase.from('app_logs').select('msg').eq('type', 'sr').gte('created_at', since);
    const { data: doneRows } = await supabase.from('app_logs').select('msg').eq('type', 'sr-done').gte('created_at', since);
    if (!srRows?.length) return;
    const doneIds = new Set([
      ...(doneRows || []).map(r => r.msg), // sr-done de Supabase
      ..._sessionDoneIds                    // reproducidos en esta sesión (safeguard local)
    ]);
    const inQueue = new Set([
      ...spotifyRequesterQueue.map(r => r.trackId),
      ...(spotifyActiveRequester ? [spotifyActiveRequester.trackId] : [])
    ]);
    let added = 0;
    for (const row of srRows) {
      try {
        const req = JSON.parse(row.msg);
        if (!req.trackId || doneIds.has(req.trackId) || inQueue.has(req.trackId)) continue;
        if (!req._addedAt) req._addedAt = Date.now(); // fallback para entradas sin timestamp
        spotifyRequesterQueue.push(req);
        inQueue.add(req.trackId);
        added++;
      } catch {}
    }
    if (added > 0) {
      mainWindow?.webContents.send('request-queue-update', { queue: spotifyRequesterQueue, active: spotifyActiveRequester });
      saveLog('info', `[syncRequester] ${added} request(s) restaurados desde Supabase`);
    }
  } catch (e) {
    saveLog('warn', `[syncRequester] error: ${e?.message || e}`);
  }
}

let _syncRequesterInterval = setInterval(syncRequesterFromSupabase, 15000);

// ── Bot say helper (awaitable, con retry y catch) ─────────────────
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms)`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function botSay(channel, msg) {
  if (channel === '__kick__') { await withTimeout(kickChatSend(msg), 10000).catch(e => saveLog('warn', `Kick chat timeout: ${e.message}`)); return; }
  if (!tmiClient) { saveLog('warn', 'botSay: tmiClient es null, no se puede responder'); return; }
  try {
    await withTimeout(tmiClient.say(channel, msg), 8000);
  } catch (e) {
    try {
      await new Promise(r => setTimeout(r, 600));
      await withTimeout(tmiClient.say(channel, msg), 8000);
    } catch (e2) {
      saveLog('warn', `Bot no pudo responder: ${e2.message || e2}`);
    }
  }
}

// ── Queue ─────────────────────────────────────────────────────────
let _processingStartedAt = 0;

async function processQueue() {
  // Safeguard: si processing lleva más de 2 minutos, forzar reset
  if (processing && _processingStartedAt && (Date.now() - _processingStartedAt > 120000)) {
    saveLog('warn', 'processQueue: forzando reset de processing (stuck > 2min)');
    processing = false;
  }
  if (processing || !queue.length) return;
  processing = true;
  _processingStartedAt = Date.now();
  try {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        const { nick, channel, action, link, gameNick } = item;
    if (action === 'sorteo') {
      if (!supabase) { continue; }
      try {
        const { error } = await supabase.from('sorteo_participantes').insert({ nick });
        if (error?.code === '23505') {
          saveLog('warn', `${nick} ya está en el sorteo`);
        } else if (!error) {
          saveLog('join', `${nick} entró al sorteo 🎁`);
          mainWindow?.webContents.send('new-sorteo-part', { nick, joined_at: new Date() });
        }
      } catch (e) {
        saveLog('warn', `Error al insertar en sorteo: ${e.message}`);
      }
      continue;
    }

    if (action === 'song') {
      try {
        const track = await spotifyNowPlayingData();
        if (track?.item) {
          const name = track.item.name;
          const artists = track.item.artists.map(a => a.name).join(', ');
          await botSay(channel, `🎵 ${name} — ${artists}`);
        } else {
          await botSay(channel, '🎵 No hay nada reproduciéndose ahora.');
        }
      } catch { await botSay(channel, '🎵 No se pudo obtener la canción.'); }
      continue;
    }

    if (action === 'queue') {
      try {
        const queueRes = await spotifyGetQueueData();
        if (!queueRes.ok) { await botSay(channel, '🎵 No se pudo obtener la cola.'); continue; }
        const next = (queueRes.data?.queue || []).slice(0, 3);
        if (next.length === 0) {
          await botSay(channel, '🎵 No hay canciones en cola.');
        } else {
          const list = next.map((t, i) => `${i + 1}. ${t.name} — ${t.artists.map(a => a.name).join(', ')}`).join(' | ');
          await botSay(channel, `🎵 Próximas: ${list}`);
        }
      } catch { await botSay(channel, '🎵 No se pudo obtener la cola.'); }
      continue;
    }

    if (action === 'skip') {
      try {
        const track = await spotifyNowPlayingData();
        if (!track?.item) { await botSay(channel, '🎵 No hay nada reproduciéndose ahora.'); continue; }
        const currentTrackId = track.item.id;

        // Reset votes if the song changed
        if (skipVotesTrackId !== currentTrackId) {
          skipVotes.clear();
          skipVotesTrackId = currentTrackId;
        }

        if (skipVotes.has(nick)) {
          await botSay(channel, `@${nick} Ya votaste para saltear esta canción.`);
          continue;
        }

        skipVotes.add(nick);
        const SKIP_THRESHOLD = 3;
        const count = skipVotes.size;

        if (count >= SKIP_THRESHOLD) {
          skipVotes.clear();
          skipVotesTrackId = null;
          await spotifyPlayerCommand('POST', '/v1/me/player/next');
          const songName = `${track.item.name} — ${track.item.artists.map(a => a.name).join(', ')}`;
          await botSay(channel, `⏭️ Canción saltada: ${songName}`);
        } else {
          await botSay(channel, `⏭️ Skipear canción (${count}/${SKIP_THRESHOLD}) — votá !skip para saltarla`);
        }
      } catch { await botSay(channel, '🎵 No se pudo procesar el skip.'); }
      continue;
    }

    if (action === 'playlist') {
      try {
        const track = await spotifyNowPlayingData();
        if (!track?.item) { await botSay(channel, '🎵 No hay nada reproduciéndose ahora.'); continue; }
        const trackInfo = `${track.item.name} — ${track.item.artists.map(a => a.name).join(', ')}`;
        const context = track.context;
        const uri = context?.uri?.split(':').pop();
        if (!context || !uri) {
          await botSay(channel, `🎵 Estamos escuchando: ${trackInfo}`);
        } else if (context.type === 'playlist') {
          await botSay(channel, `🎵 Estamos escuchando esta playlist: https://open.spotify.com/playlist/${uri}`);
        } else if (context.type === 'album') {
          await botSay(channel, `💿 Estamos escuchando este álbum: https://open.spotify.com/album/${uri}`);
        } else if (context.type === 'artist') {
          await botSay(channel, `📻 Estamos escuchando: https://open.spotify.com/artist/${uri}`);
        } else {
          await botSay(channel, `🎵 Estamos escuchando: ${trackInfo}`);
        }
      } catch { await botSay(channel, '🎵 No se pudo obtener la playlist.'); }
      continue;
    }

    if (action === 'songrequest') {
      saveLog('info', `[processQueue] songrequest de ${nick} (${channel}): link="${(link || '').slice(0, 80)}"`);
      let trackUri = parseSpotifyLink(link);
      let trackName = null;
      if (!trackUri) {
        try {
          const { data: tokenRow } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
          if (tokenRow?.refresh_token) {
            const tokenData = await getSpotifyAccessToken(tokenRow.client_id, tokenRow.client_secret, tokenRow.refresh_token);
            if (tokenData?.access_token) {
              let searchQuery = link;
              const ytType = parseYouTubeLink(link);
              if (ytType) {
                const ytQuery = await youtubeToSpotifyQuery(link);
                if (!ytQuery) {
                  await botSay(channel, `@${nick} [ERROR] No se pudo leer el link de YouTube.`);
                  continue;
                }
                searchQuery = ytQuery;
              } else if (/^https?:\/\//i.test(link)) {
                await botSay(channel, `@${nick} [ERROR] Solo se aceptan links de Spotify o YouTube Music.`);
                continue;
              }
              const found = await searchSpotifyTrack(searchQuery, tokenData.access_token);
              if (found) {
                if (typeof found._score === 'number' && found._score < 28) {
                  await botSay(channel, `@${nick} [ERROR] No encontre una coincidencia clara. Proba con \"Artista - Cancion\" o un link de Spotify/YouTube Music.`);
                  continue;
                }
                trackUri = found.uri;
                trackName = `${found.name} - ${found.artists[0]?.name}`;
              }
            }
          }
        } catch (srSearchErr) {
          saveLog('warn', `[songrequest] Error buscando cancion: ${srSearchErr?.message || srSearchErr}`);
        }
        if (!trackUri) {
          await botSay(channel, `@${nick} [ERROR] No se encontro la cancion.`);
          continue;
        }
      }

      const trackId = trackUri.includes(':') ? trackUri.split(':')[2] : trackUri;
      if (!trackId) {
        saveLog('warn', `[songrequest] trackId vacio para URI: ${trackUri}`);
        await botSay(channel, `@${nick} [ERROR] No se pudo procesar la cancion.`);
        continue;
      }
      const inLocalQueue = spotifyRequesterQueue.some(r => r.trackId === trackId)
        || (spotifyActiveRequester && spotifyActiveRequester.trackId === trackId);
      if (inLocalQueue) {
        await botSay(channel, `@${nick} [INFO] Esa cancion ya esta en la cola.`);
        continue;
      }

      const queueRes = await spotifyGetQueueData();
      if (queueRes.ok) {
        const queueItems = [queueRes.data?.currently_playing, ...(queueRes.data?.queue || [])].filter(Boolean);
        const alreadyQueued = queueItems.some(t => t.id === trackId);
        if (alreadyQueued) {
          await botSay(channel, `@${nick} [INFO] Esa cancion ya esta en la cola.`);
          continue;
        }
      }

      const result = await spotifyPlayerCommand('POST', `/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`, null);
      if (result.ok) {
        if (!trackName && supabase) {
          const { data: tokenRow } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
          if (tokenRow?.refresh_token) trackName = await spotifyGetTrackName(tokenRow.client_id, tokenRow.client_secret, tokenRow.refresh_token, trackUri);
        }
        const msg = trackName
          ? `@${nick} [OK] \"${trackName}\" fue anadida a la cola.`
          : `@${nick} [OK] Tu cancion fue anadida a la cola.`;
        await botSay(channel, msg);
        saveLog('song', `${nick} solicito: ${trackName || trackUri}`);
        const newReq = { nick, trackId, trackName: trackName || trackUri, _addedAt: Date.now() };
        spotifyRequesterQueue.push(newReq);
        mainWindow?.webContents.send('song-requested', newReq);
        mainWindow?.webContents.send('request-queue-update', { queue: spotifyRequesterQueue, active: spotifyActiveRequester });
        if (supabase) supabase.from('app_logs').insert({ type: 'sr', msg: JSON.stringify(newReq) }).then(() => {}).catch(() => {});
      } else {
        const errMsg = result.status === 404
          ? 'Esta Spotify abierto y reproduciendo?'
          : result.error || 'error desconocido';
        await botSay(channel, `@${nick} [ERROR] No se pudo anadir la cancion (${errMsg})`);
        saveLog('warn', `Song request de ${nick} fallo: ${result.error}`);
      }
      continue;
    }

    if (!currentTorneoId) {
      saveLog('warn', `${nick} usó !join pero no hay torneo activo`);
      if (action === 'join') {
        await botSay(channel, `@${nick} No hay torneo activo en este momento.`);
      }
      continue;
    }
    if (action === 'join') {
      if (!gameNick || gameNick.trim() === '') {
        await botSay(channel, `@${nick} Usá !join TuNickEnElJuego para apuntarte 😊`);
        continue;
      }
      const isKick = channel === '__kick__';
      const nickSet = isKick ? torneoKickNicks : torneoTwitchNicks;
      const totalRegistered = torneoTwitchNicks.size + torneoKickNicks.size;
      if (currentTorneoMax > 0 && totalRegistered >= currentTorneoMax) {
        await botSay(channel, `@${nick} El torneo ya está completo (${currentTorneoMax} participantes). ¡Para la próxima! 🏆`);
        saveLog('warn', `${nick} intentó unirse pero el torneo está lleno (${currentTorneoMax})`);
        continue;
      }
      const nickLower = nick.toLowerCase();
      if (nickSet.has(nickLower)) {
        await botSay(channel, `@${nick} ¡Ya estás apuntado al torneo! 😄`);
        saveLog('warn', `${nick} intentó inscribirse dos veces`);
        continue;
      }
      if (!supabase) { continue; }
      const { error } = await supabase.from('participantes').insert({ nick: gameNick, twitch_nick: nickLower, torneo_id: currentTorneoId });
      if (error?.code === '23505') {
        await botSay(channel, `@${nick} ¡Ese nick de juego ya está apuntado! 😄`);
        saveLog('warn', `${nick} ya estaba apuntado (${gameNick})`);
      } else if (!error) {
        nickSet.add(nickLower);
        await botSay(channel, `@${nick} ✅ ¡Te has unido al torneo como "${gameNick}"!`);
        saveLog('join', `${nick} se unió como ${gameNick} ✅`);
        mainWindow?.webContents.send('new-participante', { nick: gameNick, twitchNick: nick, joined_at: new Date() });
      }
    }
    if (action === 'leave') {
      if (!supabase) { continue; }
      const isKick = channel === '__kick__';
      const nickSet = isKick ? torneoKickNicks : torneoTwitchNicks;
      const nickLower = nick.toLowerCase();
      const { count } = await supabase.from('participantes').delete({ count: 'exact' }).eq('twitch_nick', nickLower).eq('torneo_id', currentTorneoId);
      if (count > 0) {
        nickSet.delete(nickLower);
        await botSay(channel, `@${nick} 👋 Has abandonado el torneo.`);
        saveLog('leave', `${nick} abandonó el torneo`);
        mainWindow?.webContents.send('remove-participante', { nick });
      }
    }
      } catch (e) {
        saveLog('warn', `Queue error: ${e?.message || e}`);
      }
    }
  } finally {
    processing = false;
    _processingStartedAt = 0;
  }
}
