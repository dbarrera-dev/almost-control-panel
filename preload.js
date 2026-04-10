const { contextBridge, ipcRenderer } = require('electron');
let fs = null;
let path = null;
try { fs = require('fs'); } catch {}
try { path = require('path'); } catch {}

try { globalThis.__preloadOk = true; } catch {}

function diag(msg) {
  try {
    if (!fs || !path) return;
    const base = process.env.APPDATA || process.env.LOCALAPPDATA || process.cwd();
    const dir = path.join(base, 'almost-control');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const file = path.join(dir, 'preload-diag.log');
    fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

diag(`preload start (electron=${process.versions?.electron || 'n/a'} contextIsolated=${String(process.contextIsolated)})`);

function resolveSrcRoot() {
  if (!fs || !path) return null;
  const candidates = [
    path.resolve(process.cwd(), 'src'),
    path.resolve(__dirname, 'src'),
    path.resolve(process.resourcesPath || '', 'app.asar', 'src'),
    path.resolve(process.resourcesPath || '', 'app', 'src'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return candidates[0];
}

const api = {
  // Window
  minimize:   () => ipcRenderer.invoke('window-minimize'),
  maximize:   () => ipcRenderer.invoke('window-maximize'),
  close:      () => ipcRenderer.invoke('window-close'),
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Config
  getConfig:            ()    => ipcRenderer.invoke('get-config'),
  saveConfig:           (cfg) => ipcRenderer.invoke('save-config', cfg),
  getLoginItemSettings: ()    => ipcRenderer.invoke('get-login-item-settings'),

  // Bot
  connectBot:    (cfg) => ipcRenderer.invoke('connect-bot', cfg),
  disconnectBot: ()    => ipcRenderer.invoke('disconnect-bot'),

  // Torneo
  crearTorneo:          (data)    => ipcRenderer.invoke('crear-torneo', data),
  getTorneoActivo:      ()        => ipcRenderer.invoke('get-torneo-activo'),
  cerrarTorneoDb:       (id)      => ipcRenderer.invoke('cerrar-torneo-db', id),
  getParticipantes:     (id)      => ipcRenderer.invoke('get-participantes', id),
  getTorneos:           ()        => ipcRenderer.invoke('get-torneos'),
  generarEquipos:       (data)    => ipcRenderer.invoke('generar-equipos', data),
  eliminarParticipante: (data)    => ipcRenderer.invoke('eliminar-participante', data),
  eliminarTorneo:       (id)      => ipcRenderer.invoke('eliminar-torneo', id),

  // Spotify
  getSpotifyStatus:    () => ipcRenderer.invoke('get-spotify-status'),
  spotifyNowPlaying:   () => ipcRenderer.invoke('spotify-now-playing'),
  spotifyPlay:         () => ipcRenderer.invoke('spotify-play'),
  spotifyPause:        () => ipcRenderer.invoke('spotify-pause'),
  spotifyNext:         () => ipcRenderer.invoke('spotify-next'),
  spotifyPrev:         () => ipcRenderer.invoke('spotify-prev'),
  spotifyShuffle:           (st)       => ipcRenderer.invoke('spotify-shuffle', st),
  spotifySetVolume:         (vol)      => ipcRenderer.invoke('spotify-set-volume', vol),
  spotifyPlayContext:       (uri)      => ipcRenderer.invoke('spotify-play-context', uri),
  spotifySetRepeat:         (state)    => ipcRenderer.invoke('spotify-set-repeat', state),
  spotifyGetDevices:        ()         => ipcRenderer.invoke('spotify-get-devices'),
  spotifyTransferPlayback:  (deviceId) => ipcRenderer.invoke('spotify-transfer-playback', deviceId),
  spotifySeek:              (posMs)    => ipcRenderer.invoke('spotify-seek', posMs),
  spotifyGetPlaylists:    () => ipcRenderer.invoke('spotify-get-playlists'),
  spotifySearch:          (q) => ipcRenderer.invoke('spotify-search', q),
  spotifyGetQueue:        () => ipcRenderer.invoke('spotify-get-queue'),
  spotifySongrequestToggle:       (v)  => ipcRenderer.invoke('spotify-songrequest-toggle', v),
  spotifySongrequestToggleTwitch: (v)  => ipcRenderer.invoke('spotify-songrequest-toggle-twitch', v),
  spotifySongrequestToggleKick:   (v)  => ipcRenderer.invoke('spotify-songrequest-toggle-kick', v),
  spotifySongrequestSetReward:    (id) => ipcRenderer.invoke('spotify-songrequest-set-reward', id),
  spotifyGetSongrequestConfig: ()   => ipcRenderer.invoke('spotify-get-songrequest-config'),
  spotifyAddToQueue:             (uri, nick, trackName) => ipcRenderer.invoke('spotify-add-to-queue', uri, nick, trackName),
  spotifyGetRequestQueue:        ()        => ipcRenderer.invoke('spotify-get-request-queue'),
  spotifyRemoveFromRequestQueue: (trackId) => ipcRenderer.invoke('spotify-remove-from-request-queue', trackId),
  spotifyClearRequestQueue:      ()        => ipcRenderer.invoke('spotify-clear-request-queue'),

  spotifyDisconnect:     ()      => ipcRenderer.invoke('spotify-disconnect'),
  spotifyConnectOAuth:   (creds) => ipcRenderer.invoke('spotify-connect-oauth', creds),
  spotifyGetCredentials: ()      => ipcRenderer.invoke('spotify-get-credentials'),

  // Kick
  kickConnectOAuth:  (data) => ipcRenderer.invoke('kick-connect-oauth', data),
  kickBotOAuth:      () => ipcRenderer.invoke('kick-bot-oauth'),
  kickBotConnect:    ()     => ipcRenderer.invoke('kick-bot-connect'),
  kickBotDisconnect: ()     => ipcRenderer.invoke('kick-bot-disconnect'),
  kickBotStatus:     ()     => ipcRenderer.invoke('kick-bot-status'),
  kickGetConfig:       ()        => ipcRenderer.invoke('kick-get-config'),
  kickRewardToggle:    (enabled) => ipcRenderer.invoke('kick-reward-toggle', enabled),
  kickRewardGetStatus: ()        => ipcRenderer.invoke('kick-reward-get-status'),
  onKickBotStatus:      (cb) => ipcRenderer.on('kick-bot-status',    (_, d) => cb(d)),
  onKickOAuthStatus:    (cb) => ipcRenderer.on('kick-oauth-status',  (_, d) => cb(d)),
  onKickConfigLoaded:   (cb) => ipcRenderer.on('kick-config-loaded', (_, d) => cb(d)),

  // Twitch Helix
  twitchRewardToggle:     (enabled) => ipcRenderer.invoke('twitch-reward-toggle', enabled),
  twitchRewardGetStatus:  ()        => ipcRenderer.invoke('twitch-reward-get-status'),
  twitchSaveCredentials:  (data)    => ipcRenderer.invoke('twitch-save-credentials', data),
  twitchGetCredentials:   ()        => ipcRenderer.invoke('twitch-get-credentials'),

  // Utils
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  readLocalHtml: (relPath) => {
    try {
      if (typeof relPath !== 'string') return '';
      const srcRoot = resolveSrcRoot();
      if (!srcRoot) return '';
      const cleaned = relPath.replace(/^[.\\/]+/, '');
      const fullPath = path.resolve(srcRoot, cleaned);
      if (!(fullPath === srcRoot || fullPath.startsWith(srcRoot + path.sep))) return '';
      return fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
      return '';
    }
  },

  // Overlay
  overlayLoadAll:  ()           => ipcRenderer.invoke('overlay-load-all'),
  overlayUpdate:   (key, value) => ipcRenderer.invoke('overlay-update', { key, value }),
  bracketUpdate:   (id, data)   => ipcRenderer.invoke('bracket-update', { id, data }),
  bracketReset:    ()           => ipcRenderer.invoke('bracket-reset'),

  // Todos
  todosGet:    ()           => ipcRenderer.invoke('todos-get'),
  todosAdd:    (todo)       => ipcRenderer.invoke('todos-add', todo),
  todosUpdate: (id, data, title) => ipcRenderer.invoke('todos-update', { id, data, title }),
  todosDelete: (id)         => ipcRenderer.invoke('todos-delete', id),

  // Duelos
  duelosGet:    ()             => ipcRenderer.invoke('duelos-get'),
  duelosAdd:    (nick)         => ipcRenderer.invoke('duelos-add', nick),
  duelosToggle: (id, done, nick) => ipcRenderer.invoke('duelos-toggle', { id, done, nick }),
  duelosDelete: (id)           => ipcRenderer.invoke('duelos-delete', id),

  // Sorteo
  sorteoSetCmd:           (cmd)  => ipcRenderer.invoke('sorteo-set-cmd', cmd),
  sorteoToggle:           (v)    => ipcRenderer.invoke('sorteo-toggle', v),
  sorteoGetParticipantes: ()     => ipcRenderer.invoke('sorteo-get-participantes'),
  sorteoLimpiar:          ()     => ipcRenderer.invoke('sorteo-limpiar'),
  sorteoGuardarYLimpiar:  (data) => ipcRenderer.invoke('sorteo-guardar-y-limpiar', data),
  sorteoGetHistorial:     ()     => ipcRenderer.invoke('sorteo-get-historial'),

  // Spotify Overlay
  spotifyOverlayStatus:    ()    => ipcRenderer.invoke('spotify-overlay-status'),
  spotifyOverlayStart:     ()    => ipcRenderer.invoke('spotify-overlay-start'),
  spotifyOverlayGetConfig: ()    => ipcRenderer.invoke('spotify-overlay-get-config'),
  spotifyOverlaySetConfig: (cfg) => ipcRenderer.invoke('spotify-overlay-set-config', cfg),
  onSpotifyOverlayStatus:  (cb)  => ipcRenderer.on('spotify-overlay-status', (_, d) => cb(d)),

  // Teams Overlay
  teamsOverlayStatus: () => ipcRenderer.invoke('teams-overlay-status'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Rocket League Overlay
  rlOverlayStatus:      ()    => ipcRenderer.invoke('rl-overlay-status'),
  rlOverlayStart:       ()    => ipcRenderer.invoke('rl-overlay-start'),
  rlOverlayGetConfig:   ()    => ipcRenderer.invoke('rl-overlay-get-config'),
  rlOverlaySetConfig:   (cfg) => ipcRenderer.invoke('rl-overlay-set-config', cfg),
  rlOverlayRefresh:     ()    => ipcRenderer.invoke('rl-overlay-refresh'),
  rlOverlayResetSession: ()   => ipcRenderer.invoke('rl-overlay-reset-session'),
  onRLStatsUpdate:      (cb)  => ipcRenderer.on('rl-stats-update', (_, d) => cb(d)),

  // Key Overlay
  keyOverlayStart:      ()    => ipcRenderer.invoke('keyoverlay-start'),
  keyOverlayStop:       ()    => ipcRenderer.invoke('keyoverlay-stop'),
  keyOverlayGetStatus:  ()    => ipcRenderer.invoke('keyoverlay-status'),
  keyOverlayGetConfig:  ()    => ipcRenderer.invoke('keyoverlay-get-config'),
  keyOverlaySetConfig:  (cfg) => ipcRenderer.invoke('keyoverlay-set-config', cfg),
  keyOverlayDetectNext: ()    => ipcRenderer.invoke('keyoverlay-detect-next'),
  keyOverlayDetectStop: ()    => ipcRenderer.invoke('keyoverlay-detect-stop'),
  onKeyOverlayStatus:   (cb)  => ipcRenderer.on('keyoverlay-status',   (_, d) => cb(d)),
  onKeyOverlayKey:      (cb)  => ipcRenderer.on('keyoverlay-key',      (_, d) => cb(d)),
  onKeyOverlayDetected: (cb)  => ipcRenderer.on('keyoverlay-detected', (_, d) => cb(d)),

  // Events
  onBotStatus:          (cb) => ipcRenderer.on('bot-status',          (_, d) => cb(d)),
  onBotConfigLoaded:    (cb) => ipcRenderer.on('bot-config-loaded',   (_, d) => cb(d)),
  logsGet:              ()   => ipcRenderer.invoke('logs-get'),
  onBotLog:             (cb) => ipcRenderer.on('bot-log',             (_, d) => cb(d)),
  onNewParticipante:    (cb) => ipcRenderer.on('new-participante',    (_, d) => cb(d)),
  onRemoveParticipante: (cb) => ipcRenderer.on('remove-participante', (_, d) => cb(d)),
  onNewSorteoPart:      (cb) => ipcRenderer.on('new-sorteo-part',     (_, d) => cb(d)),
  onSongRequested:        (cb) => ipcRenderer.on('song-requested',        (_, d) => cb(d)),
  onRequestQueueUpdate:   (cb) => ipcRenderer.on('request-queue-update', (_, d) => cb(d)),
  onSpotifyOAuthStatus:   (cb) => ipcRenderer.on('spotify-oauth-status', (_, d) => cb(d)),
};

diag('api object built');
try {
  contextBridge.exposeInMainWorld('api', api);
  diag('contextBridge expose ok');
} catch (e) {
  diag(`contextBridge expose fail: ${e && e.message ? e.message : e}`);
  try { console.error('[preload] contextBridge failed:', e && e.message ? e.message : e); } catch {}
}
try {
  if (!globalThis.api) globalThis.api = api;
  if (typeof window !== 'undefined' && !window.api) window.api = api;
  diag('window/global api assigned');
} catch (e) {
  diag(`window/global api assign fail: ${e && e.message ? e.message : e}`);
}
