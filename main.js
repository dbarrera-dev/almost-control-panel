const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');
let autoUpdater = null;

function isSafeExternalUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function openSafeExternalUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
}

function lockWindowNavigation(win) {
  if (!win?.webContents) return;
  win.webContents.setWindowOpenHandler(({ url }) => {
    openSafeExternalUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(String(url || '')).protocol === 'file:') return;
    } catch {}
    event.preventDefault();
    openSafeExternalUrl(url);
  });
}

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

  win.webContents.on('console-message', (event) => {
    const level = event?.level ?? 'info';
    const message = event?.message ?? '';
    const line = event?.lineNumber ?? 0;
    const sourceId = event?.sourceId ?? '';
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
const {
  getSpotifyTokenRowId,
  getKickBroadcasterRowId,
  getKickBotRowId,
} = require('./main/kick-utils');
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
const { registerDuelosIpc } = require('./main/ipc/duelos');
const { registerTodosIpc } = require('./main/ipc/todos');
const { registerSorteoIpc } = require('./main/ipc/sorteo');
const { registerLogsIpc } = require('./main/ipc/logs');
const { registerKeyOverlayIpc } = require('./main/ipc/keyoverlay');
const { registerSpotifyOverlayIpc } = require('./main/ipc/spotify-overlay');
const { registerTeamsOverlayIpc } = require('./main/ipc/teams-overlay');
const { registerRlOverlayIpc } = require('./main/ipc/rl-overlay');
const { createOverlays } = require('./main/overlays');
const { createAudiolinkService } = require('./main/audiolink-service');
const { createObsService } = require('./main/obs-service');
const { registerAudiolinkIpc } = require('./main/ipc/audiolink');
const { createObsDualService } = require('./main/obs-dual-service');
const { registerObsDualIpc } = require('./main/ipc/obs-dual');
const { createObsDualRemoteService } = require('./main/obs-dual-remote');
const { registerObsDualRemoteIpc } = require('./main/ipc/obs-dual-remote');
const { createSoundboardService } = require('./main/soundboard-service');
const { registerSoundboardIpc } = require('./main/ipc/soundboard');
const { createKickService } = require('./main/kick-service');
const { createRuntimePresenceService } = require('./main/runtime-presence');
const { createRocketLeagueLiveService } = require('./main/rocket-league-live-service');
const {
  getSpotifyAccessToken,
  parseSpotifyResource,
  parseSpotifyLink,
  parseYouTubeLink,
  parseYouTubeResource,
  youtubeToSpotifyMetadata,
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
let _kickOAuthExpectedState = null;
function getKickCodeVerifier() { return _kickCodeVerifier; }


function startKickOAuthFlow(clientId) {
  const crypto = require('crypto');
  _kickCodeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(_kickCodeVerifier).digest('base64url');
  const oauthState = crypto.randomBytes(16).toString('hex');
  _kickOAuthExpectedState = oauthState;

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
      ['state', oauthState]
    ]);
    const authUrl = `https://id.kick.com/oauth/authorize?${params}`;

    const okHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Kick conectado</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#f0f0f0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}.card{background:#111;border:1px solid #1a1a1a;border-radius:16px;padding:40px 48px;display:inline-flex;flex-direction:column;align-items:center;gap:16px}.icon{width:64px;height:64px;background:#53FC1820;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px}.title{font-size:22px;font-weight:700;color:#53FC18}.sub{font-size:13px;color:#555;line-height:1.6}</style></head><body><div class="card"><div class="icon">&#10003;</div><div class="title">Kick conectado</div><div class="sub">Ya podes cerrar esta pestana y volver al panel.</div></div></body></html>`;
    const errHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Error</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#f0f0f0;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}.card{background:#111;border:1px solid #1a1a1a;border-radius:16px;padding:40px 48px;display:inline-flex;flex-direction:column;align-items:center;gap:16px}.icon{width:64px;height:64px;background:#ff6b6b20;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:32px}.title{font-size:22px;font-weight:700;color:#ff6b6b}.sub{font-size:13px;color:#555;line-height:1.6}</style></head><body><div class="card"><div class="icon">&#10005;</div><div class="title">Error al conectar</div><div class="sub">Cerra esta pestana y volvé a intentarlo.</div></div></body></html>`;

    const timeout = setTimeout(() => {
      _kickOAuthExpectedState = null;
      server.close();
      reject(new Error('Timeout'));
    }, 5 * 60 * 1000);

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${KICK_OAUTH_PORT}`);
      if (url.pathname !== '/callback') { res.end(); return; }
      clearTimeout(timeout);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const returnedState = url.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      const stateMismatch = !_kickOAuthExpectedState || !returnedState || returnedState !== _kickOAuthExpectedState;
      if (error || !code || stateMismatch) {
        _kickOAuthExpectedState = null;
        const errMsg = stateMismatch ? 'State OAuth inválido o ausente' : (error || 'Sin código');
        res.end(errHtml);
        server.close();
        reject(new Error(errMsg));
        return;
      }
      _kickOAuthExpectedState = null;
      res.end(okHtml);
      server.close();
      resolve(code);
    });

    server.on('error', () => {
      _kickOAuthExpectedState = null;
      clearTimeout(timeout);
      reject(new Error(`Puerto ${KICK_OAUTH_PORT} ocupado.`));
    });
    server.listen(KICK_OAUTH_PORT, '127.0.0.1', () => shell.openExternal(authUrl));
  });
}

const SPOTIFY_TOKEN_ROW_CACHE_MS = 15000;
const SPOTIFY_ACCESS_TOKEN_SKEW_MS = 5000;
let _spotifyAuthCache = {
  rowId: null,
  row: null,
  rowFetchedAt: 0,
  accessToken: '',
  accessTokenExpAt: 0,
};

function clearSpotifyAccessTokenCache() {
  _spotifyAuthCache.accessToken = '';
  _spotifyAuthCache.accessTokenExpAt = 0;
}

function clearSpotifyAuthCache() {
  _spotifyAuthCache = {
    rowId: null,
    row: null,
    rowFetchedAt: 0,
    accessToken: '',
    accessTokenExpAt: 0,
  };
}

function updateSpotifyTokenRowCache(rowId, row) {
  const prev = _spotifyAuthCache.row;
  const credsChanged =
    !prev
    || String(prev.client_id || '') !== String(row?.client_id || '')
    || String(prev.client_secret || '') !== String(row?.client_secret || '')
    || String(prev.refresh_token || '') !== String(row?.refresh_token || '');

  _spotifyAuthCache.rowId = rowId;
  _spotifyAuthCache.row = row || null;
  _spotifyAuthCache.rowFetchedAt = Date.now();
  if (credsChanged) clearSpotifyAccessTokenCache();
}

async function getCachedSpotifyTokenRow(options = {}) {
  const opts = (options && typeof options === 'object') ? options : {};
  const force = !!opts.force;
  if (!supabase) return { ok: false, error: 'Sin conexión a Supabase' };

  const rowId = getSpotifyTokenRowId(loadConfig());
  const now = Date.now();
  const hasFreshRow =
    !force
    && _spotifyAuthCache.row
    && _spotifyAuthCache.rowId === rowId
    && (now - _spotifyAuthCache.rowFetchedAt) < SPOTIFY_TOKEN_ROW_CACHE_MS;

  if (hasFreshRow) {
    return { ok: true, rowId, row: _spotifyAuthCache.row };
  }

  const { data } = await supabase
    .from('spotify_tokens')
    .select('*')
    .eq('id', rowId)
    .maybeSingle();

  if (!data?.refresh_token) {
    clearSpotifyAuthCache();
    return { ok: false, error: 'Sin refresh token' };
  }

  updateSpotifyTokenRowCache(rowId, data);
  return { ok: true, rowId, row: data };
}

async function getSpotifyApiAccessToken(options = {}) {
  const opts = (options && typeof options === 'object') ? options : {};
  const forceRefresh = !!opts.forceRefresh;
  const now = Date.now();

  const rowRes = await getCachedSpotifyTokenRow({ force: forceRefresh });
  if (!rowRes.ok) return rowRes;

  const tokenValid =
    !forceRefresh
    && _spotifyAuthCache.accessToken
    && _spotifyAuthCache.rowId === rowRes.rowId
    && now < (_spotifyAuthCache.accessTokenExpAt - SPOTIFY_ACCESS_TOKEN_SKEW_MS);

  if (tokenValid) {
    return {
      ok: true,
      accessToken: _spotifyAuthCache.accessToken,
      row: rowRes.row,
      rowId: rowRes.rowId,
    };
  }

  const tokenData = await getSpotifyAccessToken(
    rowRes.row.client_id,
    rowRes.row.client_secret,
    rowRes.row.refresh_token
  );
  if (!tokenData?.access_token) {
    clearSpotifyAccessTokenCache();
    return { ok: false, error: tokenData?.error_description || tokenData?.error || 'No se pudo obtener access token' };
  }

  const expiresInSec = Math.max(30, Number(tokenData.expires_in) || 3600);
  _spotifyAuthCache.accessToken = tokenData.access_token;
  _spotifyAuthCache.accessTokenExpAt = Date.now() + (expiresInSec * 1000);
  return {
    ok: true,
    accessToken: tokenData.access_token,
    row: rowRes.row,
    rowId: rowRes.rowId,
  };
}

async function spotifyApiRequest(method, endpoint, body = null, options = {}) {
  const opts = (options && typeof options === 'object') ? options : {};
  const authRes = await getSpotifyApiAccessToken({ forceRefresh: !!opts.forceRefreshToken });
  if (!authRes.ok) {
    return { ok: false, status: 0, data: null, error: authRes.error || 'No se pudo autenticar en Spotify' };
  }

  const headers = { Authorization: `Bearer ${authRes.accessToken}` };
  if (body !== null) headers['Content-Type'] = 'application/json';
  const payload = body === null ? null : JSON.stringify(body);
  const r = await httpsRequest(method, 'api.spotify.com', endpoint, headers, payload);
  const status = Number(r?.status || 0);

  if (status === 401 && opts.retryOn401 !== false) {
    clearSpotifyAccessTokenCache();
    return spotifyApiRequest(method, endpoint, body, {
      ...opts,
      retryOn401: false,
      forceRefreshToken: true,
    });
  }

  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    data: r?.data || null,
    error: ok ? null : (r?.data?.error?.message || r?.data?.message || `HTTP ${status}`),
  };
}

async function spotifyNowPlayingData() {
  const r = await spotifyApiRequest('GET', '/v1/me/player', null);
  if (r.status === 0) throw new Error(r.error || 'Sin conexión a Supabase');
  if (r.status === 401) throw new Error('Token inválido o expirado (401)');
  if (r.status === 403) throw new Error('Sin permisos suficientes en Spotify (403)');
  if (r.status !== 200 && r.status !== 204) throw new Error(`Respuesta inesperada de Spotify: ${r.status}`);
  return r.data;
}

async function spotifyPlayerCommand(method, endpoint, body) {
  if (!supabase) return { ok: false, error: 'Sin conexión a Supabase' };
  const payload = (body === undefined || body === null) ? null : body;
  const r = await spotifyApiRequest(method, endpoint, payload);
  return { ok: r.ok, status: r.status, error: r.ok ? null : r.error };
}

async function spotifyGetQueueData() {
  const r = await spotifyApiRequest('GET', '/v1/me/player/queue', null);
  const ok = r.status === 200;
  return { ok, status: r.status, data: ok ? r.data : null, error: ok ? null : r.error };
}

const SPOTIFY_TRACK_LABEL_CACHE_MS = 6 * 60 * 60 * 1000;
const _spotifyTrackLabelCache = new Map();

function spotifyArtistsLabel(item) {
  const artists = Array.isArray(item?.artists) ? item.artists.map(a => a?.name).filter(Boolean) : [];
  if (artists.length) return artists.join(', ');
  return String(item?.show?.name || item?.album?.name || '').trim();
}

function spotifyItemDisplayLabel(item) {
  const name = String(item?.name || '').trim();
  if (!name) return '';
  const secondary = spotifyArtistsLabel(item);
  return secondary ? `${name} — ${secondary}` : name;
}

function spotifyContextOpenUrl(context) {
  const direct = String(context?.external_urls?.spotify || '').trim();
  if (/^https:\/\/open\.spotify\.com\//i.test(direct)) return direct;

  const type = String(context?.type || '').trim().toLowerCase();
  const uri = String(context?.uri || '').trim();
  const match = uri.match(/^spotify:([a-z]+):([a-zA-Z0-9]+)$/i);
  if (!match) return '';

  const uriType = String(match[1] || '').toLowerCase();
  const id = String(match[2] || '').trim();
  const finalType = type || uriType;
  if (!id || !/^(playlist|album|artist)$/.test(finalType)) return '';
  return `https://open.spotify.com/${finalType}/${id}`;
}

function cleanSongRequestTrackName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^spotify:(?:track|episode):/i.test(raw)) return '';
  if (/^https?:\/\/(?:open|play)\.spotify\.com\//i.test(raw)) return '';
  if (raw.length > 180) return `${raw.slice(0, 177)}...`;
  return raw;
}

function getCachedSpotifyTrackLabel(trackId) {
  const key = String(trackId || '').trim();
  if (!key) return '';
  const cached = _spotifyTrackLabelCache.get(key);
  if (!cached) return '';
  if ((Date.now() - cached.at) > SPOTIFY_TRACK_LABEL_CACHE_MS) {
    _spotifyTrackLabelCache.delete(key);
    return '';
  }
  return cached.label || '';
}

function setCachedSpotifyTrackLabel(trackId, label) {
  const key = String(trackId || '').trim();
  const clean = cleanSongRequestTrackName(label);
  if (!key || !clean) return;
  _spotifyTrackLabelCache.set(key, { label: clean, at: Date.now() });
  if (_spotifyTrackLabelCache.size > 2000) {
    let removed = 0;
    for (const [cacheKey, entry] of _spotifyTrackLabelCache.entries()) {
      if ((Date.now() - Number(entry?.at || 0)) > SPOTIFY_TRACK_LABEL_CACHE_MS) {
        _spotifyTrackLabelCache.delete(cacheKey);
        removed++;
      }
      if (removed >= 300) break;
    }
  }
}

async function resolveSpotifyTrackLabel(trackUri, options = {}) {
  const trackId = normalizeTrackId(trackUri);
  if (!trackId) return '';

  const cached = getCachedSpotifyTrackLabel(trackId);
  if (cached) return cached;

  const endpoint = `/v1/tracks/${encodeURIComponent(trackId)}`;
  const accessToken = String(options?.accessToken || '').trim();
  let data = null;

  if (accessToken) {
    const direct = await httpsRequest('GET', 'api.spotify.com', endpoint, {
      Authorization: `Bearer ${accessToken}`,
    });
    const directStatus = Number(direct?.status || 0);
    if (directStatus >= 200 && directStatus < 300) data = direct.data;
  }

  if (!data) {
    const fallback = await spotifyApiRequest('GET', endpoint, null);
    if (fallback.ok) data = fallback.data;
  }

  const label = cleanSongRequestTrackName(spotifyItemDisplayLabel(data));
  if (label) setCachedSpotifyTrackLabel(trackId, label);
  return label || '';
}


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
let torneoNicks = new Set(); // Nicks ya inscriptos en el torneo actual (Kick)
let currentSorteoCmd = '!sorteo';
let sorteoActivo = false;
let songRequestEnabled = false;
let songRequestKickEnabled = true;
let songRequestRewardId = '';
let kickCommandConfig = {
  song: true,
  playlist: true,
  queue: true,
  skip: true,
};


let keyOverlayRunning = false;
let koDetecting = false;
let keyOverlayConfig = {
  selectedKeys: [42,16,17,18,30,31,32,23,24,37,38,57],
  customKeys: [], // [{keycode, label, row}] - teclas detectadas manualmente
  style: { fontSize: 'md', keyColor: '#ffffff', bgColor: 'rgba(15,15,20,0.9)', accentColor: '#f97316', fadeDelay: 0, inactiveOpacity: 0.3 },
  background: { type: 'default', value: '', name: '' },
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

let teamsOverlayRunning    = false;

let rlOverlayConfig = {
  platform: 'epic', // epic | steam | psn | xbl
  username: '',
  playlistId: 13, // Ranked Doubles por defecto
  realtimeEnabled: true,
  statsApiPort: 49123,
  style: { bg: 'rgba(15,15,20,0.92)', text: '#ffffff', accent: '#2563eb', radius: 12 }
};
let rlStats      = null; // { mmr, rank, tier, wins, losses, matches, winRate }
let rlSessionStart = null; // snapshot at session start
let rlSessionSummary = { wins: 0, losses: 0, goals: 0, streak: 0, lastResult: null, matches: 0 };
let rlOverlayRunning    = false;


const state = {
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
  get torneoNicks() { return torneoNicks; },
  set torneoNicks(v) { torneoNicks = v; },
  get currentSorteoCmd() { return currentSorteoCmd; },
  set currentSorteoCmd(v) { currentSorteoCmd = v; },
  get sorteoActivo() { return sorteoActivo; },
  set sorteoActivo(v) { sorteoActivo = v; },
  get songRequestEnabled() { return songRequestEnabled; },
  set songRequestEnabled(v) { songRequestEnabled = v; },
  get songRequestKickEnabled() { return songRequestKickEnabled; },
  set songRequestKickEnabled(v) { songRequestKickEnabled = v; },
  get songRequestRewardId() { return songRequestRewardId; },
  set songRequestRewardId(v) { songRequestRewardId = v; },
  get kickCommandConfig() { return kickCommandConfig; },
  set kickCommandConfig(v) { kickCommandConfig = v; },
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
  get rlSessionSummary() { return rlSessionSummary; },
  set rlSessionSummary(v) { rlSessionSummary = v; },
  getCommandHealthSnapshot: () => getCommandHealthSnapshot(),
  resetCommandHealth: () => resetCommandHealth(),
};

const {
  startKeyOverlay,
  stopKeyOverlay,
  getKeyOverlayStatus,
  broadcastOverlay,
  configMsg,
  configRefreshMsg,
  startSpotifyOverlay,
  getSpotifyOverlayStatus,
  broadcastSpotify,
  startTeamsOverlay,
} = createOverlays({ state, http, fs, path, os, saveLog, spotifyNowPlayingData, loadConfig });

const rocketLeagueLiveService = createRocketLeagueLiveService({
  app,
  saveLog,
  getMainWindow: () => mainWindow,
  overlayPath: resolveAppPath(path.join('src', 'overlay-rl.html')),
  statsOverlayPath: resolveAppPath(path.join('src', 'overlay-rl-stats.html'))
});

const {
  kickApiRequest,
  kickRefreshAccessToken,
  kickChatSend,
  connectKickBot,
  disconnectKickBot,
  stopKickPolling,
} = createKickService({ loadConfig, saveConfig, httpsRequest, saveLog, state, processQueue });

const audiolinkService = createAudiolinkService({ loadConfig, saveConfig, saveLog, state });
const obsService = createObsService({ loadConfig, saveLog });
const obsDualService = createObsDualService({ loadConfig, saveConfig, saveLog, getMainWindow: () => mainWindow });
const obsDualRemoteService = createObsDualRemoteService({
  getSupabase: () => state.supabase,
  obsDualService,
  loadConfig,
  saveLog,
  getMainWindow: () => mainWindow,
});
const soundboardService = createSoundboardService({
  loadConfig,
  saveConfig,
  saveLog,
  state,
  getMainWindow: () => mainWindow,
});
const runtimePresenceService = createRuntimePresenceService({
  ipcMain,
  app,
  loadConfig,
  saveConfig,
  saveLog,
  state,
  connectKickBot,
  disconnectKickBot,
});

function registerIpcHandlers() {
  registerWindowIpc({ ipcMain, app, state });
  registerConfigIpc({ ipcMain, app, loadConfig, saveConfig, applyWindowIcon, state, soundboardService });
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
    kickRefreshAccessToken,
    connectKickBot,
    disconnectKickBot,
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
    parseSpotifyResource,
    parseSpotifyLink,
    spotifyGetTrackName,
    saveLog,
    state,
  });
  registerDuelosIpc({ ipcMain, saveLog, state });
  registerTodosIpc({ ipcMain, saveLog, state });
  registerSorteoIpc({ ipcMain, saveLog, state });
  registerLogsIpc({ ipcMain, state });
  registerKeyOverlayIpc({ ipcMain, loadConfig, saveConfig, startKeyOverlay, stopKeyOverlay, getKeyOverlayStatus, broadcastOverlay, configMsg, configRefreshMsg, state });
  registerSpotifyOverlayIpc({ ipcMain, loadConfig, saveConfig, startSpotifyOverlay, getSpotifyOverlayStatus, broadcastSpotify, state });
  registerTeamsOverlayIpc({ ipcMain, state });
  registerRlOverlayIpc({ ipcMain, rlLiveService: rocketLeagueLiveService });
  registerAudiolinkIpc({ ipcMain, loadConfig, saveConfig, saveLog, audiolinkService, obsService, state });
  registerObsDualIpc({ ipcMain, loadConfig, saveConfig, saveLog, obsDualService, state });
  registerObsDualRemoteIpc({ ipcMain, loadConfig, saveConfig, saveLog, obsDualRemoteService, state });
  registerSoundboardIpc({ ipcMain, soundboardService });
  ipcMain.handle('runtime-command-health-get', async () => ({ ok: true, ...getCommandHealthSnapshot() }));
  ipcMain.handle('runtime-command-health-reset', async () => {
    resetCommandHealth();
    return { ok: true, ...getCommandHealthSnapshot() };
  });
  runtimePresenceService.registerIpcHandlers();
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
    width: 1400, height: 860,
    minWidth: 1280, minHeight: 720,
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
  lockWindowNavigation(mainWindow);
  mainWindow.loadFile(indexPath);

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createSplash() {
  const preloadCandidates = [
    path.join(process.cwd(), 'splash-preload.js'),
    path.join(app.getAppPath(), 'splash-preload.js'),
    path.join(__dirname, 'splash-preload.js'),
    path.join(process.resourcesPath || '', 'app.asar', 'splash-preload.js'),
    path.join(process.resourcesPath || '', 'app', 'splash-preload.js'),
  ];
  const splashPath = resolveAppPath(path.join('src', 'splash.html'));
  splashWindow = new BrowserWindow({
    width: 480, height: 320,
    frame: false,
    resizable: false,
    center: true,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: resolvePreloadPath(preloadCandidates),
    }
  });
  lockWindowNavigation(splashWindow);
  splashWindow.loadFile(splashPath);
}

function sendToSplash(channel, data) {
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.webContents.send(channel, data);
}

function closeSplashAndShowMain() {
  if (splashWindow && !splashWindow.isDestroyed()) { splashWindow.close(); splashWindow = null; }
  mainWindow?.show();
}

async function autoLoadKickFromSupabase() {
  if (!supabase) return;
  try {
    const cfg = loadConfig();
    const mode = cfg.kickBotMode === 'dev' ? 'dev' : 'prod';
    const activeRowId = getKickBroadcasterRowId({ ...cfg, kickBotMode: mode });
    const activeBotRowId = getKickBotRowId({ ...cfg, kickBotMode: mode });
    const [activeRes, activeBotRes, prodRes, devRes] = await Promise.all([
      supabase.from('kick_tokens').select('client_id, channel, access_token').eq('id', activeRowId).maybeSingle(),
      supabase.from('kick_tokens').select('access_token').eq('id', activeBotRowId).maybeSingle(),
      supabase.from('kick_tokens').select('id').eq('id', 1).maybeSingle(),
      supabase.from('kick_tokens').select('id').eq('id', 3).maybeSingle(),
    ]);
    const activeRow = activeRes?.data || null;
    const activeBotRow = activeBotRes?.data || null;
    const hasAnyKickRow = !!(prodRes?.data || devRes?.data);

    if (hasAnyKickRow) {
      mainWindow?.webContents.send('kick-config-loaded', {});
    }

    const canAutoconnect = !!(activeRow?.access_token && activeRow?.client_id && activeRow?.channel && activeBotRow?.access_token);
    if (cfg.autoConnectKickBot !== false && canAutoconnect && !kickPollTimer) {
      saveLog('info', `Kick: auto-conectando bot (${mode})...`);
      connectKickBot(mode);
    } else if (cfg.autoConnectKickBot !== false && !canAutoconnect) {
      saveLog('info', `Kick: auto-connect omitido (${mode}) por configuración incompleta (falta token broadcaster o bot).`);
    }
  } catch (e) {
    saveLog('warn', `[autoLoadKick] error: ${e?.message || e}`);
  }
}

function stripKickCredentialsFromConfig(cfg) {
  const out = { ...cfg };
  let changed = false;
  const fields = [
    'kickClientId',
    'kickClientSecret',
    'kickChannel',
    'kickChatroomId',
    'kickAccessToken',
    'kickRefreshToken',
    'kickBotAccessToken',
    'kickBotRefreshToken',
    'kickSongRequestRewardId',
    'kickClientIdDev',
    'kickClientSecretDev',
    'kickDevChannel',
    'kickChatroomIdDev',
    'kickAccessTokenDev',
    'kickRefreshTokenDev',
    'kickBotAccessTokenDev',
    'kickBotRefreshTokenDev',
    'kickSongRequestRewardIdDev',
    'songRequestRewardId',
  ];
  for (const field of fields) {
    if (String(out[field] || '') !== '') {
      out[field] = '';
      changed = true;
    }
  }
  return { cfg: out, changed };
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  tray = new Tray(iconPath);
  tray.setToolTip('Almost Control');
  const showMainWindowFromTray = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar', click: showMainWindowFromTray },
    { type: 'separator' },
    { label: 'Salir', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('click', showMainWindowFromTray);
  tray.on('double-click', showMainWindowFromTray);
}

app.whenReady().then(async () => {
  createWindow();
  createTray();
  let cfg = loadConfig();
  let bootCfgChanged = false;
  const startupMode = cfg.kickStartupMode === 'dev' ? 'dev' : 'prod';
  if (cfg.kickStartupMode !== startupMode) {
    cfg.kickStartupMode = startupMode;
    bootCfgChanged = true;
  }
  // Al iniciar, el modo activo siempre sigue el modo de inicio configurado.
  if (cfg.kickBotMode !== startupMode) {
    cfg.kickBotMode = startupMode;
    bootCfgChanged = true;
  }
  const stripped = stripKickCredentialsFromConfig(cfg);
  cfg = stripped.cfg;
  if (stripped.changed) {
    bootCfgChanged = true;
    saveLog('warn', '[Kick migration] Se detectaron credenciales locales legacy y fueron limpiadas. La app usa Supabase como fuente única.');
  }
  if (bootCfgChanged) {
    saveConfig(cfg);
  }
  if (cfg.logoUrl) applyWindowIcon(cfg.logoUrl, mainWindow);
  if (cfg.keyOverlayConfig) {
    keyOverlayConfig = {
      ...keyOverlayConfig,
      ...cfg.keyOverlayConfig,
      style: { ...keyOverlayConfig.style, ...(cfg.keyOverlayConfig.style || {}) },
      background: { ...keyOverlayConfig.background, ...(cfg.keyOverlayConfig.background || {}) },
    };
  }
  if (cfg.spotifyOverlayConfig)  spotifyOverlayConfig  = cfg.spotifyOverlayConfig;
  if (cfg.rlOverlayConfig)       rlOverlayConfig       = cfg.rlOverlayConfig;
  songRequestEnabled        = cfg.songRequestEnabled        ?? true;
  songRequestKickEnabled    = cfg.songRequestKickEnabled    ?? true;
  // Kick es la única plataforma activa para song request
  if (songRequestKickEnabled && !songRequestEnabled) {
    songRequestEnabled = true;
    const fixCfg = loadConfig();
    fixCfg.songRequestEnabled = true;
    saveConfig(fixCfg);
  }
  songRequestRewardId       = cfg.songRequestRewardId       ?? '';
  if (cfg.kickCommandConfig && typeof cfg.kickCommandConfig === 'object') {
    kickCommandConfig = {
      ...kickCommandConfig,
      ...cfg.kickCommandConfig,
    };
  }
  if (cfg.supabaseUrl && cfg.supabaseKey && !supabase) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(cfg.supabaseUrl, cfg.supabaseKey);
  }
  soundboardService.ensureReady().catch((err) => {
    saveLog('warn', `[Soundboard] No se pudo iniciar: ${err?.message || err}`);
  });
  startSpotifyOverlay();
  rocketLeagueLiveService.start();
  state.rlOverlayRunning = true;
  startKeyOverlay();
  startTeamsOverlay();
  runtimePresenceService.start();
  setTimeout(syncRequesterFromSupabase, 3000);
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
  state.rlOverlayRunning = false;
  rocketLeagueLiveService.destroy();
  soundboardService.destroy();
  audiolinkService.destroy();
  obsService.disconnect();
  obsDualService.destroy();
  obsDualRemoteService.destroy();
  runtimePresenceService.stop();
  if (_commandHealthBroadcastDebounce) clearTimeout(_commandHealthBroadcastDebounce);
  if (_syncRequesterInterval) clearInterval(_syncRequesterInterval);
  if (_queueWatchdogInterval) clearInterval(_queueWatchdogInterval);
});

// -- IPC handlers (modularizados) ---------------------------------------------
registerIpcHandlers();

// ── Log helper ────────────────────────────────────────────────────
const LOG_INFO_SUPPRESS_PATTERNS = [
  /^\[Kick chat\] @/i,
  /^\[songrequest\] pick /i,
  /^Kick GET \/channels\(self\)/i,
  /^Kick GET \/channels\(self\) retry/i,
  /^Kick realtime activo/i,
  /^Kick eventos suscritos:/i,
];
const LOG_DEDUPE_WINDOW_MS = 3500;
const LOG_RECENT_CACHE = new Map();

function maskSecretValue(value, start = 3, end = 3) {
  const str = String(value || '');
  if (!str) return '';
  if (str.length <= 8) return '***';
  const left = str.slice(0, Math.max(0, start));
  const right = str.slice(Math.max(0, str.length - end));
  return `${left}***${right}`;
}

function sanitizeLogMessage(rawMsg) {
  let msg = String(rawMsg ?? '');
  if (!msg) return '';

  if (msg.length > 1200) msg = `${msg.slice(0, 1200)}...`;

  msg = msg.replace(
    /("(?:access_token|refresh_token|client_secret|supabaseKey|api[_-]?key|authorization|token)"\s*:\s*")([^"]+)(")/gi,
    (_, p1, p2, p3) => `${p1}${maskSecretValue(p2, 4, 2)}${p3}`
  );
  msg = msg.replace(
    /((?:access_token|refresh_token|client_secret|supabaseKey|api[_-]?key|authorization|token)\s*[=:]\s*)([^\s,;]+)/gi,
    (_, p1, p2) => `${p1}${maskSecretValue(p2, 4, 2)}`
  );
  msg = msg.replace(
    /(Bearer\s+)([A-Za-z0-9._~-]{12,})/gi,
    (_, p1, p2) => `${p1}${maskSecretValue(p2, 4, 2)}`
  );
  msg = msg.replace(
    /([?&](?:token|sig|signature|apikey|access_token|refresh_token)=)([^&\s]+)/gi,
    (_, p1, p2) => `${p1}${maskSecretValue(p2, 4, 2)}`
  );
  msg = msg.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g,
    (jwt) => maskSecretValue(jwt, 6, 4)
  );
  return msg;
}

function shouldSuppressLog(type, msg) {
  if (!msg) return true;
  if (type !== 'info') return false;
  return LOG_INFO_SUPPRESS_PATTERNS.some((re) => re.test(msg));
}

function isDuplicateRecentLog(type, msg) {
  const key = `${type}|${msg}`;
  const now = Date.now();
  const prev = LOG_RECENT_CACHE.get(key);
  LOG_RECENT_CACHE.set(key, now);
  if (LOG_RECENT_CACHE.size > 400) {
    for (const [k, ts] of LOG_RECENT_CACHE.entries()) {
      if ((now - ts) > 30000) LOG_RECENT_CACHE.delete(k);
    }
  }
  return !!prev && (now - prev) <= LOG_DEDUPE_WINDOW_MS;
}

function saveLog(type, msg) {
  const safeType = String(type || 'info');
  const safeMsg = sanitizeLogMessage(msg);
  if (shouldSuppressLog(safeType, safeMsg)) return;
  if (isDuplicateRecentLog(safeType, safeMsg)) return;

  mainWindow?.webContents.send('bot-log', { type: safeType, msg: safeMsg });
  if (supabase) {
    supabase.from('app_logs').insert({ type: safeType, msg: safeMsg }).then(() => {}).catch(() => {});
  }
}

async function syncRequesterFromSupabase() {
  if (!supabase) return;
  try {
    const nowIso = new Date().toISOString();
    const normalizeTrackId = (v) => {
      const s = String(v || '').trim();
      if (!s) return '';
      if (s.includes(':')) {
        const id = s.split(':')[2];
        return String(id || '').trim();
      }
      return s;
    };

    const since = _syncRequesterCursorIso || new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const doneSince = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: srRows } = await supabase
      .from('app_logs')
      .select('msg,created_at')
      .eq('type', 'sr')
      .gte('created_at', since)
      .lte('created_at', nowIso)
      .order('created_at', { ascending: true })
      .limit(800);
    const { data: doneRows } = await supabase
      .from('app_logs')
      .select('msg')
      .eq('type', 'sr-done')
      .gte('created_at', doneSince);
    if (!srRows?.length) {
      // Evita volver a escanear una ventana de 6h en cada ciclo sin cambios.
      _syncRequesterCursorIso = nowIso;
      return;
    }
    const doneIds = new Set([
      ...(doneRows || []).map(r => normalizeTrackId(r.msg)), // sr-done de Supabase
      ..._sessionDoneIds                    // reproducidos en esta sesión (safeguard local)
    ]);
    const inQueue = new Set([
      ...spotifyRequesterQueue.map(r => normalizeTrackId(r?.trackId)),
      ...(spotifyActiveRequester ? [normalizeTrackId(spotifyActiveRequester.trackId)] : [])
    ]);
    let added = 0;
    const MAX_ADDED_PER_SYNC = 80;
    let lastProcessedCreatedAt = '';
    for (const row of srRows) {
      try {
        const req = JSON.parse(row.msg);
        req.trackId = normalizeTrackId(req.trackId || req.uri || req.trackUri);
        req.nick = String(req.nick || req.requester || req.user || '').trim() || 'unknown';
        const rawTrackName = String(req.trackName || req.track || req.name || '').trim();
        req.trackName = cleanSongRequestTrackName(rawTrackName) || req.trackId;
        if (!req.trackId || doneIds.has(req.trackId) || inQueue.has(req.trackId)) continue;
        if (!req._addedAt) req._addedAt = Date.now(); // fallback para entradas sin timestamp
        spotifyRequesterQueue.push(req);
        inQueue.add(req.trackId);
        added++;
        lastProcessedCreatedAt = String(row?.created_at || '') || lastProcessedCreatedAt;
        if (added >= MAX_ADDED_PER_SYNC) break;
      } catch {}
    }
    if (added >= MAX_ADDED_PER_SYNC) {
      saveLog('warn', `[syncRequester] se alcanzó el máximo por ciclo (${MAX_ADDED_PER_SYNC}). Continúo en el próximo sync.`);
    }
    if (added > 0) {
      mainWindow?.webContents.send('request-queue-update', { queue: spotifyRequesterQueue, active: spotifyActiveRequester });
    }
    if (added >= MAX_ADDED_PER_SYNC && lastProcessedCreatedAt) {
      // Importante: no saltar requests pendientes del mismo bloque temporal.
      _syncRequesterCursorIso = lastProcessedCreatedAt;
    } else {
      _syncRequesterCursorIso = nowIso;
    }
  } catch (e) {
    saveLog('warn', `[syncRequester] error: ${e?.message || e}`);
  }
}

let _syncRequesterCursorIso = null;
let _syncRequesterInterval = setInterval(syncRequesterFromSupabase, 15000);
let _queueWatchdogInterval = setInterval(() => {
  if (!queue.length) return;
  if (processing && _processingStartedAt && (Date.now() - _processingStartedAt > 120000)) {
    saveLog('warn', 'queue-watchdog: detecté processQueue atascado >2min, fuerzo recuperación');
    processing = false;
    _processingStartedAt = 0;
  }
  if (!processing) {
    processQueue().catch((e) => saveLog('warn', `queue-watchdog: ${e?.message || e}`));
  }
}, 4000);

const COMMAND_HEALTH_ALERT_FAIL_STREAK = 3;
const COMMAND_HEALTH_MAX_ALERTS = 120;
let commandHealthByAction = {};
let commandHealthAlerts = [];
let _commandHealthBroadcastDebounce = null;

function commandHealthNowIso() {
  return new Date().toISOString();
}

function sanitizeHealthError(err) {
  return String(err || '').trim().slice(0, 260);
}

function ensureCommandHealthAction(action) {
  const key = String(action || 'unknown').trim() || 'unknown';
  if (!commandHealthByAction[key]) {
    commandHealthByAction[key] = {
      action: key,
      total: 0,
      ok: 0,
      failed: 0,
      softFailed: 0,
      timeouts: 0,
      retries: 0,
      consecutiveFailures: 0,
      lastStartedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastDurationMs: 0,
      avgDurationMs: 0,
      totalDurationMs: 0,
      lastError: '',
      lastErrorAt: null,
      lastSoftError: '',
      lastSoftErrorAt: null,
      lastAlertAt: null,
    };
  }
  return commandHealthByAction[key];
}

function queueCommandHealthBroadcast(source = 'local') {
  if (_commandHealthBroadcastDebounce) return;
  _commandHealthBroadcastDebounce = setTimeout(() => {
    _commandHealthBroadcastDebounce = null;
    const payload = getCommandHealthSnapshot();
    state.mainWindow?.webContents.send('runtime-command-health-updated', {
      source,
      ...payload,
    });
  }, 180);
}

function recordCommandStart(action) {
  const metric = ensureCommandHealthAction(action);
  metric.total += 1;
  metric.lastStartedAt = commandHealthNowIso();
  queueCommandHealthBroadcast('start');
}

function recordCommandRetry(action) {
  const metric = ensureCommandHealthAction(action);
  metric.retries += 1;
  queueCommandHealthBroadcast('retry');
}

function pushCommandAlert(action, message, level = 'warn') {
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    action: String(action || 'unknown'),
    level: String(level || 'warn'),
    message: sanitizeHealthError(message || 'Fallo de comando'),
    at: commandHealthNowIso(),
  };
  commandHealthAlerts.unshift(item);
  if (commandHealthAlerts.length > COMMAND_HEALTH_MAX_ALERTS) {
    commandHealthAlerts = commandHealthAlerts.slice(0, COMMAND_HEALTH_MAX_ALERTS);
  }
  queueCommandHealthBroadcast('alert');
}

function recordCommandSoftFailure(action, message) {
  const metric = ensureCommandHealthAction(action);
  metric.softFailed += 1;
  metric.lastSoftError = sanitizeHealthError(message);
  metric.lastSoftErrorAt = commandHealthNowIso();
  queueCommandHealthBroadcast('soft-fail');
}

function recordCommandResult(action, result = {}) {
  const metric = ensureCommandHealthAction(action);
  const ok = result.ok !== false;
  const timeout = !!result.timeout;
  const durationMs = Math.max(0, Number(result.durationMs || 0));
  metric.lastDurationMs = durationMs;
  metric.totalDurationMs += durationMs;
  metric.avgDurationMs = metric.total > 0
    ? Math.round(metric.totalDurationMs / metric.total)
    : 0;

  if (ok) {
    metric.ok += 1;
    metric.consecutiveFailures = 0;
    metric.lastSuccessAt = commandHealthNowIso();
    queueCommandHealthBroadcast('ok');
    return;
  }

  metric.failed += 1;
  metric.consecutiveFailures += 1;
  if (timeout) metric.timeouts += 1;
  metric.lastFailureAt = commandHealthNowIso();
  metric.lastError = sanitizeHealthError(result.error || (timeout ? 'Timeout' : 'Error'));
  metric.lastErrorAt = metric.lastFailureAt;

  if (metric.consecutiveFailures >= COMMAND_HEALTH_ALERT_FAIL_STREAK) {
    const msg = `[health] ${metric.action} acumula ${metric.consecutiveFailures} fallos seguidos. Último error: ${metric.lastError || 'desconocido'}`;
    const now = Date.now();
    const lastAlertMs = Date.parse(metric.lastAlertAt || '');
    const canAlert = Number.isNaN(lastAlertMs) || (now - lastAlertMs) > 60000;
    if (canAlert) {
      metric.lastAlertAt = commandHealthNowIso();
      saveLog('warn', msg);
      pushCommandAlert(metric.action, msg, 'warn');
    }
  }
  queueCommandHealthBroadcast('fail');
}

function getCommandHealthSnapshot() {
  const actions = Object.values(commandHealthByAction)
    .map((row) => ({ ...row }))
    .sort((a, b) => {
      if (a.consecutiveFailures !== b.consecutiveFailures) return b.consecutiveFailures - a.consecutiveFailures;
      return b.total - a.total;
    });
  const totals = actions.reduce((acc, row) => {
    acc.total += row.total;
    acc.ok += row.ok;
    acc.failed += row.failed;
    acc.softFailed += row.softFailed;
    acc.timeouts += row.timeouts;
    acc.retries += row.retries;
    return acc;
  }, { total: 0, ok: 0, failed: 0, softFailed: 0, timeouts: 0, retries: 0 });
  return {
    generatedAt: commandHealthNowIso(),
    totals,
    actions,
    alerts: [...commandHealthAlerts],
  };
}

function resetCommandHealth() {
  commandHealthByAction = {};
  commandHealthAlerts = [];
  queueCommandHealthBroadcast('reset');
}

// ── Bot/ops helper (timeout + retry + métricas) ───────────────────
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms)`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableKickChatResult(result) {
  const status = Number(result?.status || 0);
  if (!status) return true;
  return status === 429 || status >= 500;
}

function isRetryableSpotifyResult(result) {
  const status = Number(result?.status || 0);
  if (!status) return true;
  return status === 429 || status >= 500;
}

function isRetryableError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  if (!msg) return false;
  return (
    msg.includes('timeout')
    || msg.includes('timed out')
    || msg.includes('econnreset')
    || msg.includes('econnaborted')
    || msg.includes('socket hang up')
    || msg.includes('temporarily unavailable')
  );
}

async function runOperationWithPolicy({
  action = 'unknown',
  op = 'op',
  run,
  timeoutMs = 12000,
  retries = 0,
  retryDelayMs = 350,
  shouldRetryResult = null,
}) {
  let lastError = '';
  let timedOut = false;
  for (let attempt = 1; attempt <= (retries + 1); attempt++) {
    try {
      const value = await withTimeout(Promise.resolve().then(() => run()), timeoutMs);
      const retryResult = typeof shouldRetryResult === 'function' ? shouldRetryResult(value) : false;
      if (!retryResult) {
        return { ok: true, value, attempts: attempt, timeout: false, error: null };
      }
      lastError = sanitizeHealthError(`${op}: resultado transitorio, reintento`);
      if (attempt <= retries) {
        recordCommandRetry(action);
        await delay(retryDelayMs * attempt);
        continue;
      }
      return { ok: false, value, attempts: attempt, timeout: false, error: lastError };
    } catch (error) {
      const msg = sanitizeHealthError(error?.message || error || `${op} error`);
      lastError = `${op}: ${msg}`;
      timedOut = msg.toLowerCase().includes('timeout');
      const canRetry = attempt <= retries && isRetryableError(msg);
      if (canRetry) {
        recordCommandRetry(action);
        await delay(retryDelayMs * attempt);
        continue;
      }
      return { ok: false, attempts: attempt, timeout: timedOut, error: lastError };
    }
  }
  return { ok: false, attempts: retries + 1, timeout: timedOut, error: lastError || `${op}: fallo` };
}

async function botSay(channel, msg, options = {}) {
  if (channel !== '__kick__') {
    const err = `botSay: canal no soportado (${channel})`;
    saveLog('warn', err);
    throw new Error(err);
  }
  const action = String(options?.action || _activeQueueActionForChat || 'chat_send').trim() || 'chat_send';
  const timeoutMs = Number(options?.timeoutMs || 6500);
  const retries = Number.isInteger(options?.retries) ? Math.max(0, options.retries) : 1;
  const op = await runOperationWithPolicy({
    action,
    op: 'kick-chat-send',
    timeoutMs,
    retries,
    retryDelayMs: 180,
    shouldRetryResult: isRetryableKickChatResult,
    run: async () => {
      const result = await kickChatSend(msg);
      return result && typeof result === 'object' ? result : { ok: true, status: 200, via: 'legacy' };
    },
  });
  if (op.ok && op.value?.ok !== false) return op.value;
  const status = Number(op?.value?.status || 0);
  const err = op.error || sanitizeHealthError(op?.value?.error || `Kick chat fallo (status=${status || 'n/a'})`);
  saveLog('warn', `[chat] ${action}: ${err}`);
  throw new Error(err);
}

function songRequestUnsupportedSpotifyMessage(type) {
  switch (type) {
    case 'album':
      return 'Ese link es de un álbum. Pasame un track específico o "artista - canción".';
    case 'playlist':
      return 'Ese link es de una playlist. Solo acepto canciones individuales (track).';
    case 'artist':
      return 'Ese link es de un artista. Pasame una canción puntual o un link de track.';
    case 'episode':
    case 'show':
      return 'Ese link no es una canción. Solo acepto tracks de Spotify.';
    default:
      return 'Ese link de Spotify no es válido para songrequest. Pasame un track.';
  }
}

function songRequestUnsupportedYouTubeMessage(type) {
  if (type === 'playlist') {
    return 'Ese enlace de YouTube es una playlist. Pasame un video puntual o artista y canción.';
  }
  if (type === 'album') {
    return 'Ese enlace de YouTube parece un álbum completo. Pasame un tema puntual.';
  }
  return 'Ese enlace de YouTube no parece una canción puntual. Probá con otro video.';
}

function songRequestQueueErrorMessage(result) {
  if (!result) return 'hubo un problema inesperado';
  if (result.status === 401) return 'la sesión de Spotify se venció y necesita reconexión';
  if (result.status === 403) return 'faltan permisos en Spotify para manejar la lista';
  if (result.status === 404) return 'Spotify no detecta un dispositivo activo reproduciendo';
  if (result.status === 429) return 'Spotify está recibiendo muchas peticiones; probá de nuevo en unos segundos';
  return result.error || 'Spotify no dejó agregar la canción en este momento';
}

function normalizeSongRequestText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function songRequestTokens(value) {
  return normalizeSongRequestText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

function songRequestOverlap(a, b) {
  const left = songRequestTokens(a);
  const right = new Set(songRequestTokens(b));
  if (!left.length || !right.size) return 0;
  const hit = left.filter((token) => right.has(token)).length;
  return hit / left.length;
}

function songRequestFuzzyRatio(a, b) {
  const left = normalizeSongRequestText(a);
  const right = normalizeSongRequestText(b);
  if (!left || !right) return 0;
  const n = left.length;
  const m = right.length;
  const maxLen = Math.max(n, m);
  if (!maxLen) return 0;

  const prev = new Array(m + 1).fill(0);
  const curr = new Array(m + 1).fill(0);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const leftChar = left.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = leftChar === right.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= m; j++) prev[j] = curr[j];
  }
  const dist = prev[m];
  return Math.max(0, 1 - (dist / maxLen));
}

function isSongRequestTextMismatch(rawQuery, picked) {
  if (!picked || !rawQuery) return false;
  const cleanedQuery = String(rawQuery || '').trim();
  if (!cleanedQuery || /https?:\/\//i.test(cleanedQuery)) return false;
  // Cuando viene bien especificado con separador ("artista - canción"), confiamos más.
  if (/[|:]/.test(cleanedQuery) || /\s-\s/.test(cleanedQuery)) return false;

  const words = songRequestTokens(cleanedQuery);
  if (words.length < 2 || cleanedQuery.length < 7) return false;

  const pickedTitle = String(picked?.name || '').trim();
  const pickedArtists = Array.isArray(picked?.artists)
    ? picked.artists.map((artist) => String(artist?.name || '').trim()).filter(Boolean).join(' ')
    : '';
  const combined = `${pickedTitle} ${pickedArtists}`.trim();
  if (!combined) return false;

  const fuzzy = Math.max(
    songRequestFuzzyRatio(cleanedQuery, pickedTitle),
    songRequestFuzzyRatio(cleanedQuery, combined)
  );
  const overlap = Math.max(
    songRequestOverlap(cleanedQuery, pickedTitle),
    songRequestOverlap(cleanedQuery, combined)
  );

  return fuzzy < 0.60 && overlap < 0.58;
}

function detectSongRequestGibberish(rawQuery) {
  const raw = String(rawQuery || '').trim();
  if (!raw || /^https?:\/\//i.test(raw)) return { blocked: false, reason: '' };

  const cleaned = normalizeSongRequestText(raw);
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2 || cleaned.length < 8) {
    return { blocked: true, reason: 'need_artist_song' };
  }

  const letters = cleaned.replace(/[^a-z]/g, '');
  if (letters.length >= 6) {
    const vowelCount = (letters.match(/[aeiou]/g) || []).length;
    const vowelRatio = vowelCount / letters.length;
    if (vowelRatio < 0.22) {
      return { blocked: true, reason: 'low_vowel_ratio' };
    }
  }

  const longNoVowel = words.some((word) => word.length >= 6 && !/[aeiou]/.test(word));
  if (longNoVowel) {
    return { blocked: true, reason: 'long_no_vowel' };
  }

  return { blocked: false, reason: '' };
}

function isSongRequestLowConfidence({ source, confidence, rawQuery, picked = null }) {
  if (source === 'youtube') return confidence < 80;
  if (source === 'text') {
    const cleaned = String(rawQuery || '').trim();
    if (cleaned.length < 4) return true;
    const hasStructuredHint = (
      /[|:]/.test(cleaned)
      || /\s-\s/.test(cleaned)
      || /\bby\b/i.test(cleaned)
      || /\bpor\b/i.test(cleaned)
    );
    if (isSongRequestTextMismatch(cleaned, picked)) return true;

    const words = cleaned.split(/\s+/).filter(Boolean);
    const strongPick =
      !!picked
      && (
        picked._source === 'strict_first'
        || Number(picked._score || 0) >= 150
        || confidence >= (hasStructuredHint ? 72 : 84)
      );
    if (strongPick) return false;

    // Texto libre sin estructura (sin "artista - canción") requiere mayor certeza.
    if (!hasStructuredHint) {
      if (words.length < 2 || cleaned.length < 8) return true;
      return confidence < 84;
    }

    if (words.length >= 3 && cleaned.length >= 12) {
      return confidence < 62;
    }
    if (words.length >= 2 && cleaned.length >= 8) {
      return confidence < 58;
    }
    return confidence < 66;
  }
  return false;
}

function normalizeTrackId(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const parsed = parseSpotifyResource(s);
  if (parsed?.id && (parsed.type === 'track' || parsed.type === 'episode')) {
    return String(parsed.id || '').trim();
  }
  if (/^spotify:(?:track|episode):/i.test(s)) {
    const id = s.split(':')[2];
    return String(id || '').trim();
  }
  if (/^[a-zA-Z0-9]{10,}$/.test(s)) return s;
  return '';
}

const PARTICIPANTE_ORIGIN_COL = 'twitch_nick'; // columna legacy en Supabase

// ── Queue ─────────────────────────────────────────────────────────
let _processingStartedAt = 0;
let _activeQueueActionForChat = '';

function queueActionPriority(action) {
  const key = String(action || '').trim().toLowerCase();
  if (key === 'song' || key === 'playlist' || key === 'queue' || key === 'skip') return 0;
  if (key === 'join' || key === 'leave' || key === 'sorteo') return 1;
  if (key === 'songrequest') return 2;
  return 1;
}

function dequeueNextQueueItem() {
  if (!Array.isArray(queue) || queue.length === 0) return null;
  let bestIdx = 0;
  let bestPriority = queueActionPriority(queue[0]?.action);
  for (let i = 1; i < queue.length; i += 1) {
    const prio = queueActionPriority(queue[i]?.action);
    if (prio < bestPriority) {
      bestPriority = prio;
      bestIdx = i;
    }
  }
  const [picked] = queue.splice(bestIdx, 1);
  return picked || null;
}

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
      const item = dequeueNextQueueItem();
      if (!item) break;
      const actionName = String(item?.action || 'unknown').trim() || 'unknown';
      recordCommandStart(actionName);
      const itemStartedAt = Date.now();
      let itemOk = true;
      let itemTimeout = false;
      let itemError = '';
      try {
        _activeQueueActionForChat = actionName;
        const { nick, channel, action, link, gameNick } = item;
        if (channel === '__kick__' && !kickPollTimer) {
          saveLog('warn', `Descarté comando Kick !${actionName} de ${nick || 'unknown'} porque el bot está desconectado`);
          continue;
        }
    if (action === 'sorteo') {
      if (!sorteoActivo) {
        saveLog('warn', `${nick} usó el comando de sorteo pero está cerrado`);
        continue;
      }
      if (!supabase) { continue; }
      try {
        const normalizedNick = String(nick || '').trim();
        const { data: existingRow, error: existingErr } = await supabase
          .from('sorteo_participantes')
          .select('nick')
          .ilike('nick', normalizedNick)
          .limit(1)
          .maybeSingle();
        if (existingErr) {
          saveLog('warn', `Error validando sorteo para ${nick}: ${existingErr.message || existingErr}`);
          await botSay(channel, `@${nick} No pude anotarte ahora mismo. Intentá de nuevo en unos segundos.`);
          continue;
        }
        if (existingRow?.nick) {
          saveLog('warn', `${nick} ya está en el sorteo`);
          await botSay(channel, `@${nick} Ya estás anotado en el sorteo.`);
          continue;
        }

        const { error } = await supabase.from('sorteo_participantes').insert({ nick: normalizedNick });
        if (error?.code === '23505') {
          saveLog('warn', `${nick} ya está en el sorteo`);
          await botSay(channel, `@${nick} Ya estás anotado en el sorteo.`);
        } else if (!error) {
          saveLog('join', `${nick} entró al sorteo 🎁`);
          mainWindow?.webContents.send('new-sorteo-part', { nick, joined_at: new Date() });
          await botSay(channel, `@${nick} ✅ Quedaste anotado en el sorteo.`);
        } else {
          saveLog('warn', `Error al insertar en sorteo: ${error.message || error}`);
          await botSay(channel, `@${nick} No pude anotarte ahora mismo. Intentá de nuevo en unos segundos.`);
        }
      } catch (e) {
        saveLog('warn', `Error al insertar en sorteo: ${e.message}`);
        await botSay(channel, `@${nick} No pude anotarte ahora mismo. Intentá de nuevo en unos segundos.`);
      }
      continue;
    }

    if (action === 'song') {
      try {
        const nowPlayingOp = await runOperationWithPolicy({
          action: actionName,
          op: 'spotify-now-playing',
          timeoutMs: 9000,
          retries: 1,
          retryDelayMs: 300,
          run: () => spotifyNowPlayingData(),
        });
        if (!nowPlayingOp.ok) throw new Error(nowPlayingOp.error || 'No se pudo obtener now playing');
        const track = nowPlayingOp.value;
        if (track?.item) {
          const label = spotifyItemDisplayLabel(track.item);
          if (label) await botSay(channel, `🎵 ${label}`);
          else await botSay(channel, '🎵 Hay reproducción activa, pero no pude leer los metadatos.');
        } else {
          await botSay(channel, '🎵 No hay nada reproduciéndose ahora.');
        }
      } catch { await botSay(channel, '🎵 No se pudo obtener la canción.'); }
      continue;
    }

    if (action === 'queue') {
      try {
        const queueOp = await runOperationWithPolicy({
          action: actionName,
          op: 'spotify-get-queue',
          timeoutMs: 9000,
          retries: 1,
          retryDelayMs: 300,
          shouldRetryResult: (result) => !result?.ok && isRetryableSpotifyResult(result),
          run: () => spotifyGetQueueData(),
        });
        if (!queueOp.ok) throw new Error(queueOp.error || 'No se pudo consultar cola de Spotify');
        const queueRes = queueOp.value;
        if (!queueRes.ok) {
          recordCommandSoftFailure(actionName, `spotify-get-queue: ${queueRes.error || queueRes.status || 'fallo'}`);
          await botSay(channel, '🎵 No se pudo obtener la cola.');
          continue;
        }
        const next = (queueRes.data?.queue || []).slice(0, 5);
        if (next.length === 0) {
          await botSay(channel, '🎵 No hay canciones en cola.');
        } else {
          const list = next
            .map((t, i) => `${i + 1}. ${spotifyItemDisplayLabel(t) || String(t?.name || 'Sin título')}`)
            .join(' | ');
          await botSay(channel, `🎵 Próximas (${next.length}): ${list}`);
        }
      } catch { await botSay(channel, '🎵 No se pudo obtener la cola.'); }
      continue;
    }

    if (action === 'skip') {
      try {
        const skipOp = await runOperationWithPolicy({
          action: actionName,
          op: 'spotify-next',
          timeoutMs: 9000,
          retries: 1,
          retryDelayMs: 300,
          shouldRetryResult: (result) => !result?.ok && isRetryableSpotifyResult(result),
          run: () => spotifyPlayerCommand('POST', '/v1/me/player/next'),
        });
        if (!skipOp.ok) throw new Error(skipOp.error || 'No se pudo ejecutar skip en Spotify');
        const res = skipOp.value;
        if (res?.ok) {
          await botSay(channel, `@${nick} ⏭️ canción salteada.`);
        } else {
          recordCommandSoftFailure(actionName, `spotify-next: ${res?.error || res?.status || 'fallo'}`);
          const err = String(res?.error || '').toLowerCase();
          if (err.includes('404')) {
            await botSay(channel, `@${nick} No hay reproducción activa para saltear.`);
          } else {
            await botSay(channel, `@${nick} No pude saltear la canción ahora mismo.`);
          }
        }
      } catch {
        await botSay(channel, `@${nick} No pude saltear la canción ahora mismo.`);
      }
      continue;
    }

    if (action === 'playlist') {
      try {
        const nowPlayingOp = await runOperationWithPolicy({
          action: actionName,
          op: 'spotify-now-playing',
          timeoutMs: 9000,
          retries: 1,
          retryDelayMs: 300,
          run: () => spotifyNowPlayingData(),
        });
        if (!nowPlayingOp.ok) throw new Error(nowPlayingOp.error || 'No se pudo obtener contexto actual');
        const track = nowPlayingOp.value;
        if (!track?.item) { await botSay(channel, '🎵 No hay nada reproduciéndose ahora.'); continue; }
        const context = track.context;
        const contextType = String(context?.type || '').trim().toLowerCase();
        const contextUrl = spotifyContextOpenUrl(context);
        if (contextType === 'playlist' && contextUrl) {
          await botSay(channel, `🎵 Playlist actual: ${contextUrl}`);
        } else if (contextType === 'album' && contextUrl) {
          await botSay(channel, `💿 Esto viene de un álbum, no de una playlist: ${contextUrl}`);
        } else if (contextType === 'artist' && contextUrl) {
          await botSay(channel, `📻 Esto viene de radio/artista, no de una playlist: ${contextUrl}`);
        } else if (contextType) {
          await botSay(channel, `🎵 Spotify no reporta una playlist activa ahora mismo (contexto: ${contextType}).`);
        } else {
          await botSay(channel, '🎵 No detecto una playlist activa. Puede estar sonando desde cola, búsqueda, radio o una canción suelta.');
        }
      } catch { await botSay(channel, '🎵 No se pudo obtener la playlist.'); }
      continue;
    }

    if (action === 'songrequest') {
      if (!songRequestEnabled || !songRequestKickEnabled) {
        await botSay(channel, `@${nick} Song Request está desactivado en este momento.`);
        continue;
      }
      const rawInput = String(link || '').trim();

      if (!rawInput) {
        await botSay(channel, `@${nick} Escribime artista y canción, o pasame un link de track de Spotify.`);
        continue;
      }

      const spotifyResource = parseSpotifyResource(rawInput);
      if (spotifyResource && spotifyResource.type !== 'track') {
        const msg = songRequestUnsupportedSpotifyMessage(spotifyResource.type);
        await botSay(channel, `@${nick} ${msg}`);
        continue;
      }

      const ytResource = parseYouTubeResource(rawInput);
      if (ytResource && ytResource.kind !== 'video') {
        await botSay(channel, `@${nick} ${songRequestUnsupportedYouTubeMessage(ytResource.kind)}`);
        continue;
      }

      let source = spotifyResource ? 'spotify_track' : 'text';
      let trackUri = spotifyResource?.uri || parseSpotifyLink(rawInput);
      let trackName = null;
      let trackLookupAccessToken = '';

      if (!trackUri) {
        try {
          const authRes = await getSpotifyApiAccessToken();
          if (!authRes.ok) {
            const authErr = String(authRes.error || '').toLowerCase();
            if (authErr.includes('refresh token')) {
              await botSay(channel, `@${nick} Todavía no tengo Spotify listo para song request.`);
            } else {
              await botSay(channel, `@${nick} Ahora mismo no tengo conexión para procesar pedidos. Probá de nuevo en un ratito.`);
            }
            continue;
          }
          trackLookupAccessToken = String(authRes.accessToken || '').trim();

          let searchQuery = rawInput;
          if (ytResource && ytResource.kind === 'video') {
            source = 'youtube';
            const ytMeta = await youtubeToSpotifyMetadata(rawInput);
            if (!ytMeta?.ok || !ytMeta?.query) {
              const ytReason = String(ytMeta?.reason || '').toLowerCase();
              if (ytReason.includes('parody') || ytReason.includes('unreliable')) {
                await botSay(
                  channel,
                  `@${nick} Ese link parece una versión alternativa/parodia y prefiero no arriesgar un tema equivocado. Pasame "artista - canción" para agregar la original.`
                );
              } else {
                await botSay(
                  channel,
                  `@${nick} No pude sacar artista y canción de ese video de YouTube con suficiente claridad, así que prefiero no agregar algo incorrecto.`
                );
              }
              continue;
            }
            if (ytMeta?.reason === 'parody_original_hint') {
              saveLog(
                'info',
                `[songrequest] youtube parody->original query="${ytMeta.query}" rawTitle="${ytMeta.rawTitle || ''}" rawAuthor="${ytMeta.rawAuthor || ''}"`
              );
            }
            searchQuery = ytMeta.query;
          } else if (parseYouTubeLink(rawInput)) {
            await botSay(channel, `@${nick} Ese enlace de YouTube no apunta a un video puntual, así que no lo agregué.`);
            continue;
          } else if (/^https?:\/\//i.test(rawInput)) {
            await botSay(channel, `@${nick} Ese link no me sirve para song request. Pasame un track de Spotify, un video de YouTube o artista y canción.`);
            continue;
          } else {
            source = 'text';
            const gibberishCheck = detectSongRequestGibberish(searchQuery);
            if (gibberishCheck.blocked) {
              await botSay(
                channel,
                `@${nick} Ese texto no parece un pedido válido. Escribí "artista - canción" o pegá un link directo de track para evitar canciones random.`
              );
              saveLog('warn', `[songrequest] texto rechazado por validación previa (${gibberishCheck.reason}) query="${searchQuery}" nick=${nick}`);
              continue;
            }
          }

          const found = await searchSpotifyTrack(searchQuery, authRes.accessToken);
          if (found) {
            const confidence = Number(found._confidence || 0);
            saveLog('info', `[songrequest] pick source=${found._source || 'n/a'} score=${found._score ?? 'n/a'} conf=${confidence}% query="${searchQuery}" result="${found.name || '(sin nombre)'}"`);
            if (isSongRequestLowConfidence({ source, confidence, rawQuery: searchQuery, picked: found })) {
              await botSay(
                channel,
                `@${nick} No lo agregué porque la coincidencia no fue suficientemente confiable. Probá con "artista - canción" o un link directo de track para evitar errores.`
              );
              saveLog('warn', `[songrequest] baja confianza (${confidence}%) para "${searchQuery}" de ${nick}`);
              continue;
            }
            trackUri = found.uri;
            trackName = `${found.name} — ${(found.artists || []).map(a => a?.name).filter(Boolean).join(', ')}`;
          }
        } catch (srSearchErr) {
          saveLog('warn', `[songrequest] Error buscando canción: ${srSearchErr?.message || srSearchErr}`);
        }
        if (!trackUri) {
          await botSay(channel, `@${nick} No encontré esa canción en Spotify.`);
          continue;
        }
      }

      const trackId = normalizeTrackId(trackUri);
      if (!trackId) {
        saveLog('warn', `[songrequest] trackId vacío para URI: ${trackUri}`);
        await botSay(channel, `@${nick} No pude procesar ese pedido como canción.`);
        continue;
      }

      trackName = cleanSongRequestTrackName(trackName);
      if (!trackName) {
        trackName = await resolveSpotifyTrackLabel(trackUri, { accessToken: trackLookupAccessToken }).catch(() => '');
      }
      const queueTrackName = cleanSongRequestTrackName(trackName) || trackId;

      const inLocalQueue = spotifyRequesterQueue.some(r => normalizeTrackId(r?.trackId) === trackId)
        || (spotifyActiveRequester && normalizeTrackId(spotifyActiveRequester.trackId) === trackId);
      if (inLocalQueue) {
        await botSay(channel, `@${nick} Esa canción ya está en la lista, así que no la duplico.`);
        continue;
      }

      const queueRes = await spotifyGetQueueData();
      if (queueRes.ok) {
        const queueItems = [queueRes.data?.currently_playing, ...(queueRes.data?.queue || [])].filter(Boolean);
        const alreadyQueued = queueItems.some(t => t.id === trackId);
        if (alreadyQueued) {
          await botSay(channel, `@${nick} Esa canción ya estaba en la lista.`);
          continue;
        }
      }

      const addQueueOp = await runOperationWithPolicy({
        action: actionName,
        op: 'spotify-queue-add',
        timeoutMs: 12000,
        retries: 1,
        retryDelayMs: 350,
        shouldRetryResult: (result) => !result?.ok && isRetryableSpotifyResult(result),
        run: () => spotifyPlayerCommand('POST', `/v1/me/player/queue?uri=${encodeURIComponent(trackUri)}`, null),
      });
      if (!addQueueOp.ok) throw new Error(addQueueOp.error || 'No se pudo agregar canción a la cola');
      const result = addQueueOp.value;
      if (result.ok) {
        const msg = queueTrackName && queueTrackName !== trackId
          ? `@${nick} - \"${queueTrackName}\" quedó agregado a la lista.`
          : `@${nick} - Tu pedido quedó agregado a la lista.`;
        await botSay(channel, msg);
        const requesterNick = String(nick || '').trim() || 'unknown';
        const newReq = { nick: requesterNick, trackId, trackName: queueTrackName, _addedAt: Date.now() };
        spotifyRequesterQueue.push(newReq);
        mainWindow?.webContents.send('song-requested', newReq);
        mainWindow?.webContents.send('request-queue-update', { queue: spotifyRequesterQueue, active: spotifyActiveRequester });
        if (supabase) supabase.from('app_logs').insert({ type: 'sr', msg: JSON.stringify(newReq) }).then(() => {}).catch(() => {});
      } else {
        const errMsg = songRequestQueueErrorMessage(result);
        recordCommandSoftFailure(actionName, `spotify-queue-add: ${result.error || result.status || 'fallo'}`);
        await botSay(channel, `@${nick} Esta vez no pude agregar la canción: ${errMsg}.`);
        saveLog('warn', `Song request de ${nick} fallo: ${result.error}`);
      }
      continue;
    }

    if (!currentTorneoId && (action === 'join' || action === 'leave')) {
      saveLog('warn', `${nick} usó !${action} pero no hay torneo activo`);
      continue;
    }
    if (action === 'join') {
      const requestedNick = String(gameNick || '').trim();
      if (!requestedNick) {
        await botSay(channel, `@${nick} Para anotarte al torneo tenés que poner tu usuario además del !join. Ejemplo: !join tu_usuario`);
        saveLog('warn', `${nick} usó !join sin usuario`);
        continue;
      }
      const finalGameNick = requestedNick.replace(/\s+/g, ' ').slice(0, 40);
      if (!finalGameNick) continue;
      const nickSet = torneoNicks;
      const nickLower = nick.toLowerCase();
      if (nickSet.has(nickLower)) {
        await botSay(channel, `@${nick} ¡Ya estás apuntado al torneo! 😄`);
        saveLog('warn', `${nick} intentó inscribirse dos veces`);
        continue;
      }
      if (!supabase) { continue; }
      if (currentTorneoMax > 0) {
        const { count: dbCount } = await supabase
          .from('participantes')
          .select('id', { count: 'exact', head: true })
          .eq('torneo_id', currentTorneoId);
        const joinedCount = Number.isFinite(dbCount) ? dbCount : nickSet.size;
        if (joinedCount >= currentTorneoMax) {
          await botSay(channel, `@${nick} El torneo ya está completo (${currentTorneoMax} participantes). ¡Para la próxima! 🏆`);
          saveLog('warn', `${nick} intentó unirse pero el torneo está lleno (${currentTorneoMax})`);
          continue;
        }
      }
      const { error } = await supabase.from('participantes').insert({ nick: finalGameNick, [PARTICIPANTE_ORIGIN_COL]: nickLower, torneo_id: currentTorneoId });
      if (error?.code === '23505') {
        await botSay(channel, `@${nick} ¡Ese nick de juego ya está apuntado! 😄`);
        saveLog('warn', `${nick} ya estaba apuntado (${finalGameNick})`);
      } else if (!error) {
        nickSet.add(nickLower);
        await botSay(channel, `@${nick} ✅ ¡Te has unido al torneo como "${finalGameNick}"!`);
        saveLog('join', `${nick} se unió como ${finalGameNick} ✅`);
        mainWindow?.webContents.send('new-participante', { nick: finalGameNick, senderNick: nick, joined_at: new Date() });
      }
    }
    if (action === 'leave') {
      if (!supabase) { continue; }
      const nickSet = torneoNicks;
      const nickLower = nick.toLowerCase();
      const { data: leavingRow } = await supabase
        .from('participantes')
        .select('nick')
        .eq(PARTICIPANTE_ORIGIN_COL, nickLower)
        .eq('torneo_id', currentTorneoId)
        .order('joined_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const { count } = await supabase.from('participantes').delete({ count: 'exact' }).eq(PARTICIPANTE_ORIGIN_COL, nickLower).eq('torneo_id', currentTorneoId);
      if (count > 0) {
        nickSet.delete(nickLower);
        await botSay(channel, `@${nick} 👋 Has abandonado el torneo.`);
        saveLog('leave', `${nick} abandonó el torneo`);
        mainWindow?.webContents.send('remove-participante', {
          nick: leavingRow?.nick || nick,
          senderNick: nick
        });
      } else {
        await botSay(channel, `@${nick} No estabas anotado en este torneo.`);
      }
    }
      } catch (e) {
        itemOk = false;
        itemError = sanitizeHealthError(e?.message || e || 'Queue error');
        itemTimeout = String(itemError).toLowerCase().includes('timeout');
        saveLog('warn', `Queue error (${actionName}): ${itemError}`);
      } finally {
        _activeQueueActionForChat = '';
        recordCommandResult(actionName, {
          ok: itemOk,
          timeout: itemTimeout,
          error: itemError,
          durationMs: Date.now() - itemStartedAt,
        });
      }
    }
  } finally {
    processing = false;
    _processingStartedAt = 0;
  }
}

