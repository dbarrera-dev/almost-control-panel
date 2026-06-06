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
  onTrayNavigate: (cb) => ipcRenderer.on('tray-navigate', (_, tab) => cb(tab)),

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
  spotifyGetQueue:        (opts) => ipcRenderer.invoke('spotify-get-queue', opts),
  spotifySongrequestToggle:       (v)  => ipcRenderer.invoke('spotify-songrequest-toggle', v),
  spotifySongrequestToggleKick:   (v)  => ipcRenderer.invoke('spotify-songrequest-toggle-kick', v),
  spotifySongrequestSetReward:    (id) => ipcRenderer.invoke('spotify-songrequest-set-reward', id),
  spotifyGetSongrequestConfig: ()   => ipcRenderer.invoke('spotify-get-songrequest-config'),
  spotifyAddToQueue:             (uri, nick, trackName, options) => ipcRenderer.invoke('spotify-add-to-queue', uri, nick, trackName, options),
  spotifyRemoveQueueItem:        (uriOrTrackId) => ipcRenderer.invoke('spotify-remove-queue-item', uriOrTrackId),
  spotifyGetRequestQueue:        ()        => ipcRenderer.invoke('spotify-get-request-queue'),
  spotifyRemoveFromRequestQueue: (trackId, options) => ipcRenderer.invoke('spotify-remove-from-request-queue', trackId, options),
  spotifyClearRequestQueue:      ()        => ipcRenderer.invoke('spotify-clear-request-queue'),

  spotifyDisconnect:     ()      => ipcRenderer.invoke('spotify-disconnect'),
  spotifyConnectOAuth:   (creds) => ipcRenderer.invoke('spotify-connect-oauth', creds),
  spotifyGetCredentials: ()      => ipcRenderer.invoke('spotify-get-credentials'),
  onSpotifySongrequestUpdated: (cb) => ipcRenderer.on('spotify-songrequest-updated', (_, d) => cb(d)),

  // Kick
  kickConnectOAuth:  (data) => ipcRenderer.invoke('kick-connect-oauth', data),
  kickBotOAuth:      (opts) => ipcRenderer.invoke('kick-bot-oauth', opts),
  kickBotConnect:    (opts) => ipcRenderer.invoke('kick-bot-connect', opts),
  kickBotDisconnect: ()     => ipcRenderer.invoke('kick-bot-disconnect'),
  kickBotStatus:     (opts) => ipcRenderer.invoke('kick-bot-status', opts),
  kickGetConfig:       (opts) => ipcRenderer.invoke('kick-get-config', opts),
  kickGetIdentities:   (opts) => ipcRenderer.invoke('kick-get-identities', opts),
  kickMonitorGet:      (opts) => ipcRenderer.invoke('kick-monitor-get', opts),
  kickRewardToggle:    (enabled) => ipcRenderer.invoke('kick-reward-toggle', enabled),
  kickRewardGetStatus: (opts)    => ipcRenderer.invoke('kick-reward-get-status', opts),
  kickRewardGet:       (rewardId) => ipcRenderer.invoke('kick-reward-get', rewardId),
  kickRewardUpdate:    (payload)  => ipcRenderer.invoke('kick-reward-update', payload),
  kickRewardList:      (opts)     => ipcRenderer.invoke('kick-reward-list', opts),
  kickRewardCreate:    (payload)  => ipcRenderer.invoke('kick-reward-create', payload),
  kickRewardDelete:    (rewardId) => ipcRenderer.invoke('kick-reward-delete', rewardId),
  kickRewardSetPrimary:(rewardId) => ipcRenderer.invoke('kick-reward-set-primary', rewardId),
  kickSubsList:        (opts)     => ipcRenderer.invoke('kick-subs-list', opts),
  kickSubsClear:       (opts)     => ipcRenderer.invoke('kick-subs-clear', opts),
  kickUsersGet:        (opts)     => ipcRenderer.invoke('kick-users-get', opts),
  kickResetTokens:     (opts)     => ipcRenderer.invoke('kick-reset-tokens', opts),
  kickCommandsGetConfig: ()       => ipcRenderer.invoke('kick-commands-get-config'),
  kickCommandsSetConfig: (cfg)    => ipcRenderer.invoke('kick-commands-set-config', cfg),
  kickChatSendManual:   (message) => ipcRenderer.invoke('kick-chat-send-manual', { message }),
  runtimePresenceGet:     ()      => ipcRenderer.invoke('runtime-presence-get'),
  runtimePresencePing:    ()      => ipcRenderer.invoke('runtime-presence-ping'),
  runtimePresenceMeta:    ()      => ipcRenderer.invoke('runtime-presence-meta'),
  runtimeRemoteCommandRefresh: () => ipcRenderer.invoke('runtime-remote-command-refresh'),
  runtimeCommandHealthGet: ()     => ipcRenderer.invoke('runtime-command-health-get'),
  runtimeCommandHealthReset: ()   => ipcRenderer.invoke('runtime-command-health-reset'),
  onKickBotStatus:      (cb) => ipcRenderer.on('kick-bot-status',    (_, d) => cb(d)),
  onKickOAuthStatus:    (cb) => ipcRenderer.on('kick-oauth-status',  (_, d) => cb(d)),
  onKickConfigLoaded:   (cb) => ipcRenderer.on('kick-config-loaded', (_, d) => cb(d)),
  onKickCommandsUpdated:(cb) => ipcRenderer.on('kick-commands-updated', (_, d) => cb(d)),
  onRuntimePresenceUpdated: (cb) => ipcRenderer.on('runtime-presence-updated', (_, d) => cb(d)),
  onRuntimeCommandHealthUpdated: (cb) => ipcRenderer.on('runtime-command-health-updated', (_, d) => cb(d)),

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

  // Content / Ideas
  contentUploadImage: (payload) => ipcRenderer.invoke('content-upload-image', payload),
  ideasGet:    ()           => ipcRenderer.invoke('content-ideas-get'),
  ideasAdd:    (idea)       => ipcRenderer.invoke('content-ideas-add', idea),
  ideasUpdate: (id, data)   => ipcRenderer.invoke('content-ideas-update', { id, data }),
  ideasDelete: (id)         => ipcRenderer.invoke('content-ideas-delete', id),

  // Discord Announcements
  discordSettingsGet:    ()       => ipcRenderer.invoke('discord-settings-get'),
  discordSettingsSet:    (data)   => ipcRenderer.invoke('discord-settings-set', data),
  discordWebhooksGet:    ()       => ipcRenderer.invoke('discord-webhooks-get'),
  discordWebhooksAdd:    (data)   => ipcRenderer.invoke('discord-webhooks-add', data),
  discordWebhooksDelete: (id)     => ipcRenderer.invoke('discord-webhooks-delete', id),
  discordWebhooksTest:   (id)     => ipcRenderer.invoke('discord-webhooks-test', id),
  discordAnnouncementsGet:      ()         => ipcRenderer.invoke('discord-announcements-get'),
  discordAnnouncementsSend:     (data)     => ipcRenderer.invoke('discord-announcements-send', data),
  discordAnnouncementsSchedule: (data)     => ipcRenderer.invoke('discord-announcements-schedule', data),
  discordAnnouncementsUpdate:   (id, data) => ipcRenderer.invoke('discord-announcements-update', { id, data }),
  discordAnnouncementsSendNow:  (id)       => ipcRenderer.invoke('discord-announcements-send-now', id),
  discordAnnouncementsDelete:   (id)       => ipcRenderer.invoke('discord-announcements-delete', id),
  onDiscordAnnouncementsChanged:(cb)       => ipcRenderer.on('discord-announcements-changed', (_, d) => cb(d)),

  // Duelos
  duelosGet:    ()             => ipcRenderer.invoke('duelos-get'),
  duelosAdd:    (nick)         => ipcRenderer.invoke('duelos-add', nick),
  duelosToggle: (id, done, nick) => ipcRenderer.invoke('duelos-toggle', { id, done, nick }),
  duelosDelete: (id)           => ipcRenderer.invoke('duelos-delete', id),

  // Sorteo
  sorteoSetCmd:           (cmd)  => ipcRenderer.invoke('sorteo-set-cmd', cmd),
  sorteoGetState:         ()     => ipcRenderer.invoke('sorteo-get-state'),
  sorteoToggle:           (v)    => ipcRenderer.invoke('sorteo-toggle', v),
  sorteoGetParticipantes: ()     => ipcRenderer.invoke('sorteo-get-participantes'),
  sorteoAddParticipantes: (data) => ipcRenderer.invoke('sorteo-add-participantes', data),
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
  rlOverlaySeriesAction: (action) => ipcRenderer.invoke('rl-overlay-series-action', action),
  rlOverlayClearLive:   ()    => ipcRenderer.invoke('rl-overlay-clear-live'),
  onRLStatsUpdate:      (cb)  => ipcRenderer.on('rl-stats-update', (_, d) => cb(d)),

  // Key Overlay
  keyOverlayStart:      ()    => ipcRenderer.invoke('keyoverlay-start'),
  keyOverlayStop:       ()    => ipcRenderer.invoke('keyoverlay-stop'),
  keyOverlayGetStatus:  ()    => ipcRenderer.invoke('keyoverlay-status'),
  keyOverlayGetConfig:  ()    => ipcRenderer.invoke('keyoverlay-get-config'),
  keyOverlaySetConfig:  (cfg) => ipcRenderer.invoke('keyoverlay-set-config', cfg),
  keyOverlayPreviewConfig: (cfg) => ipcRenderer.invoke('keyoverlay-preview-config', cfg),
  keyOverlayUploadBackground: (payload) => ipcRenderer.invoke('keyoverlay-upload-background', payload),
  keyOverlayListBackgrounds: () => ipcRenderer.invoke('keyoverlay-list-backgrounds'),
  keyOverlayUploadKeyImage: (payload) => ipcRenderer.invoke('keyoverlay-upload-key-image', payload),
  keyOverlayListKeyImages: () => ipcRenderer.invoke('keyoverlay-list-key-images'),
  keyOverlayDetectNext: ()    => ipcRenderer.invoke('keyoverlay-detect-next'),
  keyOverlayDetectStop: ()    => ipcRenderer.invoke('keyoverlay-detect-stop'),
  onKeyOverlayStatus:   (cb)  => ipcRenderer.on('keyoverlay-status',   (_, d) => cb(d)),
  onKeyOverlayKey:      (cb)  => ipcRenderer.on('keyoverlay-key',      (_, d) => cb(d)),
  onKeyOverlayDetected: (cb)  => ipcRenderer.on('keyoverlay-detected', (_, d) => cb(d)),
  onKeyOverlayConfigUpdated: (cb) => ipcRenderer.on('keyoverlay-config-updated', (_, d) => cb(d)),

  // Audio Link (VBAN)
  audiolinkGetStatus:     ()     => ipcRenderer.invoke('audiolink-get-status'),
  audiolinkGetConfig:     ()     => ipcRenderer.invoke('audiolink-get-config'),
  audiolinkGetLocalIp:    ()     => ipcRenderer.invoke('audiolink-get-local-ip'),
  audiolinkSaveConfig:    (data) => ipcRenderer.invoke('audiolink-save-config', data),
  audiolinkVmConnect:     ()     => ipcRenderer.invoke('audiolink-vm-connect'),
  audiolinkVmDisconnect:  ()     => ipcRenderer.invoke('audiolink-vm-disconnect'),
  audiolinkVmStrips:      ()     => ipcRenderer.invoke('audiolink-vm-strips'),
  audiolinkVmBuses:       ()     => ipcRenderer.invoke('audiolink-vm-buses'),
  audiolinkApplyProfile:  ()     => ipcRenderer.invoke('audiolink-apply-profile'),
  audiolinkToggleSend:    (on)   => ipcRenderer.invoke('audiolink-toggle-send', on),
  audiolinkToggleMonitor: (on)   => ipcRenderer.invoke('audiolink-toggle-monitor', on),
  audiolinkReconnect:     ()     => ipcRenderer.invoke('audiolink-reconnect'),
  audiolinkGetLevels:     ()     => ipcRenderer.invoke('audiolink-get-levels'),
  audiolinkObsConnect:    ()     => ipcRenderer.invoke('audiolink-obs-connect'),
  audiolinkObsDisconnect: ()     => ipcRenderer.invoke('audiolink-obs-disconnect'),
  audiolinkObsSources:    ()     => ipcRenderer.invoke('audiolink-obs-sources'),
  audiolinkObsMute:       (data) => ipcRenderer.invoke('audiolink-obs-mute', data),
  audiolinkObsScenes:     ()     => ipcRenderer.invoke('audiolink-obs-scenes'),
  audiolinkSetPlatformRule: (data) => ipcRenderer.invoke('audiolink-set-platform-rule', data),

  // OBS Dual
  obsDualGetConfig:             ()              => ipcRenderer.invoke('obs-dual-get-config'),
  obsDualSaveConfig:            (data)          => ipcRenderer.invoke('obs-dual-save-config', data),
  obsDualGetStatus:             ()              => ipcRenderer.invoke('obs-dual-get-status'),
  obsDualConnect:               (side)          => ipcRenderer.invoke('obs-dual-connect', side),
  obsDualConnectBoth:           ()              => ipcRenderer.invoke('obs-dual-connect-both'),
  obsDualDisconnect:            (side)          => ipcRenderer.invoke('obs-dual-disconnect', side),
  obsDualDisconnectBoth:        ()              => ipcRenderer.invoke('obs-dual-disconnect-both'),
  obsDualLaunch:                (side)          => ipcRenderer.invoke('obs-dual-launch', side),
  obsDualLaunchBoth:            ()              => ipcRenderer.invoke('obs-dual-launch-both'),
  obsDualGetScenes:             (side)          => ipcRenderer.invoke('obs-dual-get-scenes', side),
  obsDualSetScene:              (side, s, prop) => ipcRenderer.invoke('obs-dual-set-scene', side, s, prop),
  obsDualGetSceneMap:           ()              => ipcRenderer.invoke('obs-dual-get-scene-map'),
  obsDualSaveSceneMap:          (map)           => ipcRenderer.invoke('obs-dual-save-scene-map', map),
  obsDualSetSync:               (enabled)       => ipcRenderer.invoke('obs-dual-set-sync', enabled),
  obsDualGetStreamRecordStatus: (side)          => ipcRenderer.invoke('obs-dual-get-stream-record-status', side),
  obsDualStartStream:           (side)          => ipcRenderer.invoke('obs-dual-start-stream', side),
  obsDualStopStream:            (side)          => ipcRenderer.invoke('obs-dual-stop-stream', side),
  obsDualStartRecord:           (side)          => ipcRenderer.invoke('obs-dual-start-record', side),
  obsDualStopRecord:            (side)          => ipcRenderer.invoke('obs-dual-stop-record', side),
  onObsDualStatus:              (cb) => ipcRenderer.on('obs-dual-status',       (_, d) => cb(d)),
  onObsDualSceneChanged:        (cb) => ipcRenderer.on('obs-dual-scene-changed',(_, d) => cb(d)),
  onObsDualStreamState:         (cb) => ipcRenderer.on('obs-dual-stream-state', (_, d) => cb(d)),
  onObsDualRecordState:         (cb) => ipcRenderer.on('obs-dual-record-state', (_, d) => cb(d)),

  // OBS Dual Remote Control
  obsDualRemoteGetConfig:    ()         => ipcRenderer.invoke('obs-dual-remote-get-config'),
  obsDualRemoteSaveConfig:   (data)     => ipcRenderer.invoke('obs-dual-remote-save-config', data),
  obsDualRemoteGetStatus:    ()         => ipcRenderer.invoke('obs-dual-remote-get-status'),
  obsDualRemoteStart:        ()         => ipcRenderer.invoke('obs-dual-remote-start'),
  obsDualRemoteStop:         ()         => ipcRenderer.invoke('obs-dual-remote-stop'),
  obsDualRemoteSetMode:      (mode)     => ipcRenderer.invoke('obs-dual-remote-set-mode', mode),
  obsDualRemoteSendScene:    (side, sc) => ipcRenderer.invoke('obs-dual-remote-send-scene', side, sc),
  obsDualRemoteRequestState: ()         => ipcRenderer.invoke('obs-dual-remote-request-state'),
  obsDualRemoteGetHotkeys:   ()         => ipcRenderer.invoke('obs-dual-remote-get-hotkeys'),
  obsDualRemoteSaveHotkeys:  (hks)      => ipcRenderer.invoke('obs-dual-remote-save-hotkeys', hks),
  obsDualRemoteToggleHotkeys:(enabled)  => ipcRenderer.invoke('obs-dual-remote-toggle-hotkeys', enabled),
  obsDualRemoteClearHotkeys: ()         => ipcRenderer.invoke('obs-dual-remote-clear-hotkeys'),
  onObsDualRemoteStatus:     (cb) => ipcRenderer.on('obs-dual-remote-status',       (_, d) => cb(d)),
  onObsDualRemoteAnnounce:   (cb) => ipcRenderer.on('obs-dual-remote-announce',     (_, d) => cb(d)),
  onObsDualRemoteHeartbeat:  (cb) => ipcRenderer.on('obs-dual-remote-heartbeat',    (_, d) => cb(d)),
  onObsDualRemoteHotkeyFired:(cb) => ipcRenderer.on('obs-dual-remote-hotkey-fired', (_, d) => cb(d)),
  onObsDualRemoteReconnecting:(cb)=> ipcRenderer.on('obs-dual-remote-reconnecting', (_, d) => cb(d)),

  // Soundboard
  soundboardGetState:            ()             => ipcRenderer.invoke('soundboard-get-state'),
  soundboardRefresh:             ()             => ipcRenderer.invoke('soundboard-refresh'),
  soundboardSetHotkeysEnabled:   (enabled)      => ipcRenderer.invoke('soundboard-set-hotkeys-enabled', enabled),
  soundboardSetStorageMode:      (mode)         => ipcRenderer.invoke('soundboard-set-storage-mode', mode),
  soundboardMigrateSupabaseToLocal: ()          => ipcRenderer.invoke('soundboard-migrate-supabase-to-local'),
  soundboardUpload:              (payload)      => ipcRenderer.invoke('soundboard-upload', payload),
  soundboardUpdate:              (id, patch)    => ipcRenderer.invoke('soundboard-update', id, patch),
  soundboardDelete:              (id)           => ipcRenderer.invoke('soundboard-delete', id),
  soundboardPlay:                (id)           => ipcRenderer.invoke('soundboard-play', id),
  soundboardGetAudio:            (id)           => ipcRenderer.invoke('soundboard-get-audio', id),
  onSoundboardPlay:              (cb) => ipcRenderer.on('soundboard-play',         (_, d) => cb(d)),
  onSoundboardHotkeyFired:       (cb) => ipcRenderer.on('soundboard-hotkey-fired', (_, d) => cb(d)),

  // Events
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
