const { getActiveSongRequestRewardId, getSongRequestRewardField, getSongRequestRewardSupabaseColumn, getSpotifyTokenRowId, getKickBroadcasterRowId } = require('../kick-utils');
const SPOTIFY_SONGREQUEST_ROW_KEY = 'spotify_songrequest';
const DEFAULT_SPOTIFY_SONGREQUEST_CONFIG = Object.freeze({
  enabled: true,
  kickEnabled: true,
  rewardId: '',
});

function registerSpotifyIpc({
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
}) {
  let spotifySongrequestRealtimeChannel = null;
  let spotifySongrequestRealtimeSupabaseRef = null;
  let spotifySongrequestRealtimeStatus = 'CLOSED';
  let songrequestSyncRetryTimer = null;
  let songrequestSyncRetryBackoffMs = 0;
  let songrequestSyncInFlight = false;
  let lastSyncedSongrequestHash = '';
  let songrequestRemoteBootstrapped = false;
  let songrequestBootstrapPromise = null;

  function getSpotifyTokenRow() {
    return getSpotifyTokenRowId(loadConfig());
  }

  function normalizeSpotifySongrequestConfig(raw, fallback = DEFAULT_SPOTIFY_SONGREQUEST_CONFIG) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_SPOTIFY_SONGREQUEST_CONFIG;
    const rewardId = String(src.rewardId ?? base.rewardId ?? '').trim();
    let kickEnabled = src.kickEnabled !== undefined ? src.kickEnabled !== false : base.kickEnabled !== false;
    let enabled = src.enabled !== undefined ? src.enabled !== false : base.enabled !== false;
    if (!kickEnabled && enabled) enabled = false;
    if (kickEnabled && !enabled) enabled = true;
    return { enabled, kickEnabled, rewardId };
  }

  function currentSongrequestSnapshot() {
    const cfg = loadConfig();
    const fallback = {
      enabled: state.songRequestEnabled !== false,
      kickEnabled: state.songRequestKickEnabled !== false,
      rewardId: String(state.songRequestRewardId || cfg.songRequestRewardId || '').trim(),
    };
    return normalizeSpotifySongrequestConfig(fallback, DEFAULT_SPOTIFY_SONGREQUEST_CONFIG);
  }

  function defaultSongrequestSnapshot() {
    const cfg = loadConfig();
    return normalizeSpotifySongrequestConfig({
      ...DEFAULT_SPOTIFY_SONGREQUEST_CONFIG,
      rewardId: String(state.songRequestRewardId || getActiveSongRequestRewardId(cfg) || '').trim(),
    }, DEFAULT_SPOTIFY_SONGREQUEST_CONFIG);
  }

  function broadcastSpotifySongrequestConfig(config, source = 'local') {
    state.mainWindow?.webContents.send('spotify-songrequest-updated', {
      source,
      config,
    });
  }

  function applySpotifySongrequestConfig(nextCfg, options = {}) {
    const normalized = normalizeSpotifySongrequestConfig(nextCfg, currentSongrequestSnapshot());
    state.songRequestEnabled = normalized.enabled !== false;
    state.songRequestKickEnabled = normalized.kickEnabled !== false;
    state.songRequestRewardId = String(normalized.rewardId || '').trim();

    if (options.persistLocal !== false) {
      const cfg = loadConfig();
      cfg.songRequestEnabled = state.songRequestEnabled;
      cfg.songRequestKickEnabled = state.songRequestKickEnabled;
      cfg.songRequestRewardId = state.songRequestRewardId || '';
      if (state.songRequestRewardId) {
        const rewardField = getSongRequestRewardField(cfg);
        cfg[rewardField] = state.songRequestRewardId;
      }
      saveConfig(cfg);
    }

    if (options.broadcast !== false) {
      broadcastSpotifySongrequestConfig(
        {
          enabled: state.songRequestEnabled !== false,
          kickEnabled: state.songRequestKickEnabled !== false,
          rewardId: String(state.songRequestRewardId || '').trim(),
        },
        options.source || 'local'
      );
    }
    return {
      enabled: state.songRequestEnabled !== false,
      kickEnabled: state.songRequestKickEnabled !== false,
      rewardId: String(state.songRequestRewardId || '').trim(),
    };
  }

  async function pushSpotifySongrequestToSupabase(cfg) {
    if (!state.supabase) return { ok: false, error: 'Sin conexión a Supabase' };
    const { error } = await state.supabase
      .from('overlay_settings')
      .upsert({ key: SPOTIFY_SONGREQUEST_ROW_KEY, value: cfg }, { onConflict: 'key' });
    if (error) return { ok: false, error: error.message || 'No se pudo guardar Song Request en Supabase' };
    return { ok: true };
  }

  function songrequestHash(cfg) {
    try {
      return JSON.stringify(cfg || {});
    } catch {
      return '';
    }
  }

  function clearSongrequestSyncRetryTimer() {
    if (!songrequestSyncRetryTimer) return;
    clearTimeout(songrequestSyncRetryTimer);
    songrequestSyncRetryTimer = null;
  }

  function scheduleSongrequestSyncRetry() {
    if (songrequestSyncRetryTimer) return;
    songrequestSyncRetryBackoffMs = songrequestSyncRetryBackoffMs
      ? Math.min(songrequestSyncRetryBackoffMs * 2, 30000)
      : 1500;
    songrequestSyncRetryTimer = setTimeout(() => {
      songrequestSyncRetryTimer = null;
      syncSongrequestToSupabase('retry').catch(() => {});
    }, songrequestSyncRetryBackoffMs);
  }

  async function syncSongrequestToSupabase(trigger = 'manual') {
    await ensureSpotifySongrequestBootstrap(false);
    if (songrequestSyncInFlight) return { ok: false, skipped: true, error: 'Sync en progreso' };
    const snapshot = currentSongrequestSnapshot();
    const hash = songrequestHash(snapshot);
    if (trigger !== 'retry' && hash && hash === lastSyncedSongrequestHash) {
      return { ok: true, skipped: true };
    }
    songrequestSyncInFlight = true;
    try {
      const res = await pushSpotifySongrequestToSupabase(snapshot);
      if (res.ok) {
        lastSyncedSongrequestHash = hash;
        songrequestSyncRetryBackoffMs = 0;
        clearSongrequestSyncRetryTimer();
        return { ok: true };
      }
      scheduleSongrequestSyncRetry();
      return res;
    } finally {
      songrequestSyncInFlight = false;
    }
  }

  async function pullSpotifySongrequestFromSupabase() {
    if (!state.supabase) return null;
    try {
      const { data, error } = await state.supabase
        .from('overlay_settings')
        .select('value')
        .eq('key', SPOTIFY_SONGREQUEST_ROW_KEY)
        .maybeSingle();
      if (error || !data?.value) return null;
      return data.value;
    } catch {
      return null;
    }
  }

  async function ensureSpotifySongrequestBootstrap(broadcast = false) {
    if (songrequestRemoteBootstrapped) return { ok: true };
    if (songrequestBootstrapPromise) return songrequestBootstrapPromise;
    songrequestBootstrapPromise = (async () => {
      const remote = await pullSpotifySongrequestFromSupabase();
      if (remote) {
        const applied = applySpotifySongrequestConfig(remote, {
          persistLocal: true,
          broadcast,
          source: 'supabase',
        });
        lastSyncedSongrequestHash = songrequestHash(applied);
        songrequestRemoteBootstrapped = true;
        return { ok: true, source: 'remote' };
      }

      const seed = defaultSongrequestSnapshot();
      const seedRes = await pushSpotifySongrequestToSupabase(seed);
      if (seedRes.ok) {
        const applied = applySpotifySongrequestConfig(seed, {
          persistLocal: true,
          broadcast: false,
          source: 'supabase-seed',
        });
        lastSyncedSongrequestHash = songrequestHash(applied);
        songrequestRemoteBootstrapped = true;
        return { ok: true, source: 'seeded' };
      }

      // Sin fila remota y sin poder sembrarla: usar default en memoria sin romper flujo.
      applySpotifySongrequestConfig(seed, {
        persistLocal: false,
        broadcast: false,
        source: 'default-fallback',
      });
      return { ok: false, error: seedRes.error || 'No se pudo bootstrappear Song Request desde Supabase' };
    })().finally(() => {
      songrequestBootstrapPromise = null;
    });
    return songrequestBootstrapPromise;
  }

  function stopSpotifySongrequestRealtime() {
    if (!spotifySongrequestRealtimeChannel || !spotifySongrequestRealtimeSupabaseRef) {
      spotifySongrequestRealtimeChannel = null;
      spotifySongrequestRealtimeSupabaseRef = null;
      spotifySongrequestRealtimeStatus = 'CLOSED';
      return;
    }
    const sb = spotifySongrequestRealtimeSupabaseRef;
    const ch = spotifySongrequestRealtimeChannel;
    spotifySongrequestRealtimeChannel = null;
    spotifySongrequestRealtimeSupabaseRef = null;
    spotifySongrequestRealtimeStatus = 'CLOSED';
    Promise.resolve(sb.removeChannel(ch)).catch(() => {});
  }

  function ensureSpotifySongrequestRealtime() {
    const supabase = state.supabase;
    if (!supabase) {
      stopSpotifySongrequestRealtime();
      return;
    }
    const channelHealthy = (
      spotifySongrequestRealtimeChannel
      && spotifySongrequestRealtimeSupabaseRef === supabase
      && (spotifySongrequestRealtimeStatus === 'SUBSCRIBED' || spotifySongrequestRealtimeStatus === 'JOINING')
    );
    if (channelHealthy) return;
    stopSpotifySongrequestRealtime();
    spotifySongrequestRealtimeSupabaseRef = supabase;
    spotifySongrequestRealtimeStatus = 'JOINING';
    spotifySongrequestRealtimeChannel = supabase
      .channel(`spotify-songrequest-sync-${Date.now()}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'overlay_settings',
          filter: `key=eq.${SPOTIFY_SONGREQUEST_ROW_KEY}`,
        },
        (payload) => {
          const remoteValue = payload?.new?.value ?? payload?.record?.value ?? null;
          if (!remoteValue) return;
          const applied = applySpotifySongrequestConfig(remoteValue, {
            persistLocal: true,
            broadcast: true,
            source: 'supabase',
          });
          lastSyncedSongrequestHash = songrequestHash(applied);
          songrequestRemoteBootstrapped = true;
        }
      )
      .subscribe((status) => {
        spotifySongrequestRealtimeStatus = String(status || '').toUpperCase() || 'UNKNOWN';
        if (spotifySongrequestRealtimeStatus === 'SUBSCRIBED') {
          ensureSpotifySongrequestBootstrap(true).catch(() => {});
          return;
        }
        if (
          spotifySongrequestRealtimeStatus === 'CHANNEL_ERROR'
          || spotifySongrequestRealtimeStatus === 'TIMED_OUT'
          || spotifySongrequestRealtimeStatus === 'CLOSED'
        ) {
          stopSpotifySongrequestRealtime();
          setTimeout(() => ensureSpotifySongrequestRealtime(), 1500);
        }
      });
  }

  applySpotifySongrequestConfig(defaultSongrequestSnapshot(), {
    persistLocal: false,
    broadcast: false,
  });
  ensureSpotifySongrequestRealtime();
  setInterval(() => ensureSpotifySongrequestRealtime(), 4000);
  Promise.resolve().then(async () => {
    await ensureSpotifySongrequestBootstrap(false);
  }).catch(() => {});

  async function getSpotifyTokenData() {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin Supabase' };
    const { data } = await supabase.from('spotify_tokens').select('*').eq('id', getSpotifyTokenRow()).maybeSingle();
    if (!data?.refresh_token) return { ok: false, error: 'Sin token' };
    return { ok: true, data };
  }

  async function getCurrentSpotifyAccessToken() {
    const tokenRowRes = await getSpotifyTokenData();
    if (!tokenRowRes.ok) return tokenRowRes;
    const tokenData = await getSpotifyAccessToken(
      tokenRowRes.data.client_id,
      tokenRowRes.data.client_secret,
      tokenRowRes.data.refresh_token
    );
    if (!tokenData?.access_token) return { ok: false, error: 'Sin access token' };
    return { ok: true, accessToken: tokenData.access_token, tokenRow: tokenRowRes.data };
  }

  function spotifyNextPath(nextUrl) {
    try {
      if (!nextUrl) return '';
      const u = new URL(nextUrl);
      return `${u.pathname}${u.search}`;
    } catch {
      return '';
    }
  }

  async function spotifyApiRequestWithAccessToken(method, endpoint, accessToken, body = null) {
    const headers = { Authorization: `Bearer ${accessToken}` };
    if (body !== null) headers['Content-Type'] = 'application/json';
    const payload = body === null ? null : JSON.stringify(body);
    return httpsRequest(method, 'api.spotify.com', endpoint, headers, payload);
  }

  const SPOTIFY_SEARCH_MAX_LIMIT = 10;
  const SPOTIFY_TRACK_LABEL_CACHE_MS = 6 * 60 * 60 * 1000;
  const _spotifyTrackLabelCache = new Map();

  function clampSearchLimit(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return SPOTIFY_SEARCH_MAX_LIMIT;
    return Math.max(1, Math.min(SPOTIFY_SEARCH_MAX_LIMIT, Math.round(num)));
  }

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

  function cleanTrackLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^spotify:(?:track|episode):/i.test(raw)) return '';
    if (/^https?:\/\/(?:open|play)\.spotify\.com\//i.test(raw)) return '';
    if (raw.length > 180) return `${raw.slice(0, 177)}...`;
    return raw;
  }

  function getCachedTrackLabel(trackId) {
    const key = String(trackId || '').trim();
    if (!key) return '';
    const cached = _spotifyTrackLabelCache.get(key);
    if (!cached) return '';
    if ((Date.now() - Number(cached?.at || 0)) > SPOTIFY_TRACK_LABEL_CACHE_MS) {
      _spotifyTrackLabelCache.delete(key);
      return '';
    }
    return String(cached.label || '').trim();
  }

  function setCachedTrackLabel(trackId, label) {
    const key = String(trackId || '').trim();
    const clean = cleanTrackLabel(label);
    if (!key || !clean) return;
    _spotifyTrackLabelCache.set(key, { label: clean, at: Date.now() });
  }

  function toTrackUri(input) {
    const parsed = parseSpotifyResource(input);
    if (parsed?.type === 'track') return parsed.uri;
    const normalized = normalizeTrackId(input);
    if (normalized) return `spotify:track:${normalized}`;
    return '';
  }

  async function removeFromPlaybackQueueByTrackId(trackId) {
    const uri = toTrackUri(trackId);
    if (!uri) return { ok: false, error: 'trackId inválido' };
    return spotifyPlayerCommand('DELETE', `/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, null);
  }

  async function fetchPlaylistTrackUris(accessToken, playlistId) {
    const allUris = [];
    let endpoint = `/v1/playlists/${encodeURIComponent(playlistId)}/items?limit=50&offset=0&additional_types=track,episode`;
    let safety = 0;
    while (endpoint && safety < 100) {
      safety++;
      const r = await spotifyApiRequestWithAccessToken('GET', endpoint, accessToken);
      if (Number(r?.status || 0) >= 400) {
        return { ok: false, error: r?.data?.error?.message || r?.data?.message || `HTTP ${r.status}` };
      }
      const items = Array.isArray(r?.data?.items) ? r.data.items : [];
      items.forEach((it) => {
        const playable = it?.item || it?.track;
        if (!playable?.uri) return;
        if (playable.type === 'track' || playable.type === 'episode') allUris.push(playable.uri);
      });
      endpoint = spotifyNextPath(r?.data?.next);
    }
    return { ok: true, uris: allUris };
  }

  function normalizeTrackId(input) {
    const s = String(input || '').trim();
    if (!s) return '';
    const parsed = parseSpotifyResource(s);
    if (parsed?.id && (parsed.type === 'track' || parsed.type === 'episode')) return String(parsed.id).trim();
    if (/^spotify:(?:track|episode):/i.test(s)) {
      const id = s.split(':')[2];
      return String(id || '').trim();
    }
    if (/^[a-zA-Z0-9]{10,}$/.test(s)) return s;
    return '';
  }

  async function fetchTrackDisplayName(accessToken, trackUriOrId) {
    const trackId = normalizeTrackId(trackUriOrId);
    if (!trackId) return '';
    const cached = getCachedTrackLabel(trackId);
    if (cached) return cached;

    const endpoint = `/v1/tracks/${encodeURIComponent(trackId)}`;
    const r = await spotifyApiRequestWithAccessToken('GET', endpoint, accessToken, null);
    const status = Number(r?.status || 0);
    if (status < 200 || status >= 300) return '';
    const label = cleanTrackLabel(spotifyItemDisplayLabel(r.data));
    if (label) setCachedTrackLabel(trackId, label);
    return label;
  }

  function markTrackAsDone(trackId) {
    const normalized = normalizeTrackId(trackId);
    if (!normalized) return;
    state.sessionDoneIds.add(normalized);
    if (state.supabase) {
      state.supabase.from('app_logs').insert({ type: 'sr-done', msg: normalized }).then(() => {}).catch(() => {});
    }
  }

  const transportLastAt = { next: 0, prev: 0 };
  const TRANSPORT_COOLDOWN_MS = 1000;

  async function runTransportCommand(kind, method, endpoint) {
    const now = Date.now();
    if ((now - (transportLastAt[kind] || 0)) < TRANSPORT_COOLDOWN_MS) {
      return { ok: true, status: 202, throttled: true };
    }
    transportLastAt[kind] = now;
    const res = await spotifyPlayerCommand(method, endpoint);
    if (res?.ok === false) {
      saveLog('warn', `[Spotify transport:${kind}] status=${res?.status || 'n/a'} error=${res?.error || 'desconocido'}`);
    }
    return res;
  }

  ipcMain.handle('get-spotify-status', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, connected: false };
    const rowId = getSpotifyTokenRowId(loadConfig());
    const { data } = await supabase.from('spotify_tokens').select('id').eq('id', rowId).maybeSingle();
    return { ok: true, connected: !!data, mode: rowId === 2 ? 'dev' : 'prod' };
  });

  ipcMain.handle('spotify-now-playing', async () => {
    try {
      const track = await spotifyNowPlayingData();
      if (!track) return { ok: true, playing: false, reason: '204' };
      if (!track.item) return { ok: true, playing: false, reason: 'no_item' };
      const item = track.item;
      const itemType = String(item?.type || 'track');
      const artistLabel = spotifyArtistsLabel(item);
      const albumName = String(item?.album?.name || item?.show?.name || '').trim();
      const albumImages = Array.isArray(item?.album?.images) ? item.album.images : [];
      const showImages = Array.isArray(item?.show?.images) ? item.show.images : [];
      return {
        ok: true,
        playing: track.is_playing,
        shuffle: track.shuffle_state || false,
        repeat: track.repeat_state || 'off',
        volume: track.device?.volume_percent ?? null,
        progress_ms: track.progress_ms || 0,
        duration_ms: item?.duration_ms || 0,
        device: track.device ? { id: track.device.id, name: track.device.name, type: track.device.type } : null,
        track: {
          type: itemType,
          name: String(item?.name || ''),
          artist: artistLabel,
          album: albumName,
          image: albumImages[1]?.url || albumImages[0]?.url || showImages[1]?.url || showImages[0]?.url || ''
        },
        label: spotifyItemDisplayLabel(item),
      };
    } catch(e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('spotify-play',          async ()       => spotifyPlayerCommand('PUT',  '/v1/me/player/play'));
  ipcMain.handle('spotify-pause',         async ()       => spotifyPlayerCommand('PUT',  '/v1/me/player/pause'));
  ipcMain.handle('spotify-next',          async ()       => runTransportCommand('next', 'POST', '/v1/me/player/next'));
  ipcMain.handle('spotify-prev',          async ()       => runTransportCommand('prev', 'POST', '/v1/me/player/previous'));
  ipcMain.handle('spotify-shuffle',            async (_, st)       => spotifyPlayerCommand('PUT',  `/v1/me/player/shuffle?state=${st}`));
  ipcMain.handle('spotify-set-volume',         async (_, vol)      => spotifyPlayerCommand('PUT',  `/v1/me/player/volume?volume_percent=${Math.max(0, Math.min(100, Math.round(vol)))}`));
  ipcMain.handle('spotify-play-context',       async (_, uri)      => spotifyPlayerCommand('PUT',  '/v1/me/player/play', { context_uri: uri }));
  ipcMain.handle('spotify-set-repeat',         async (_, repeatState)    => spotifyPlayerCommand('PUT',  `/v1/me/player/repeat?state=${repeatState}`));
  ipcMain.handle('spotify-transfer-playback',  async (_, deviceId) => spotifyPlayerCommand('PUT',  '/v1/me/player', { device_ids: [deviceId], play: true }));
  ipcMain.handle('spotify-seek',               async (_, posMs)    => spotifyPlayerCommand('PUT',  `/v1/me/player/seek?position_ms=${Math.max(0, Math.round(posMs))}`));

  ipcMain.handle('spotify-get-devices', async () => {
    const tokenRes = await getCurrentSpotifyAccessToken();
    if (!tokenRes.ok) return { ok: false };
    const r = await httpsRequest('GET', 'api.spotify.com', '/v1/me/player/devices',
      { 'Authorization': `Bearer ${tokenRes.accessToken}` });
    if (!r.data?.devices) return { ok: false };
    return {
      ok: true,
      devices: r.data.devices.map(d => ({
        id: d.id, name: d.name, type: d.type,
        isActive: d.is_active, volume: d.volume_percent ?? 0
      }))
    };
  });

  ipcMain.handle('spotify-get-playlists', async () => {
    const tokenRes = await getCurrentSpotifyAccessToken();
    if (!tokenRes.ok) return { ok: false };
    const r = await httpsRequest('GET', 'api.spotify.com', '/v1/me/playlists?limit=30',
      { 'Authorization': `Bearer ${tokenRes.accessToken}` });
    if (!r.data?.items) return { ok: false };
    return {
      ok: true,
      playlists: r.data.items.map(p => ({
        id: p.id, name: p.name, uri: p.uri,
        tracks: Number(p.tracks?.total ?? p.items?.total) || 0,
        image: p.images?.[0]?.url || ''
      }))
    };
  });

  ipcMain.handle('spotify-songrequest-toggle', async (_, enabled) => {
    ensureSpotifySongrequestRealtime();
    await ensureSpotifySongrequestBootstrap(false);
    const current = currentSongrequestSnapshot();
    const nextEnabled = enabled !== false;
    const nextCfg = normalizeSpotifySongrequestConfig({
      ...current,
      enabled: nextEnabled,
      kickEnabled: nextEnabled ? current.kickEnabled : false,
    }, current);
    const applied = applySpotifySongrequestConfig(nextCfg, {
      persistLocal: true,
      broadcast: true,
      source: 'local',
    });
    const sync = await syncSongrequestToSupabase('toggle');
    return {
      ok: true,
      enabled: applied.enabled,
      kickEnabled: applied.kickEnabled,
      synced: !!sync.ok,
      error: sync.ok ? null : (sync.error || 'No se pudo sincronizar en Supabase'),
    };
  });

  ipcMain.handle('spotify-songrequest-toggle-kick', async (_, enabled) => {
    ensureSpotifySongrequestRealtime();
    await ensureSpotifySongrequestBootstrap(false);
    const current = currentSongrequestSnapshot();
    const next = enabled !== false;
    const nextCfg = normalizeSpotifySongrequestConfig({
      ...current,
      kickEnabled: next,
      enabled: next,
    }, current);
    const applied = applySpotifySongrequestConfig(nextCfg, {
      persistLocal: true,
      broadcast: true,
      source: 'local',
    });
    const sync = await syncSongrequestToSupabase('toggle-kick');
    return {
      ok: true,
      kickEnabled: applied.kickEnabled,
      enabled: applied.enabled,
      synced: !!sync.ok,
      error: sync.ok ? null : (sync.error || 'No se pudo sincronizar en Supabase'),
    };
  });

  ipcMain.handle('spotify-songrequest-set-reward', async (_, input) => {
    await ensureSpotifySongrequestBootstrap(false);
    const payload = (input && typeof input === 'object' && !Array.isArray(input))
      ? input
      : { rewardId: input };
    const cleaned = String(payload.rewardId || '').trim();
    if (!cleaned) {
      return { ok: false, error: 'No se permite vaciar reward_id por esta ruta.' };
    }
    state.songRequestRewardId = cleaned;
    const cfg = loadConfig();
    cfg.songRequestRewardId = cleaned; // compat legado
    const field = getSongRequestRewardField(cfg);
    const column = getSongRequestRewardSupabaseColumn(cfg);
    cfg[field] = cleaned || cfg[field] || '';
    saveConfig(cfg);
    if (state.supabase) {
      const upd = {
        id: getKickBroadcasterRowId(cfg),
        updated_at: new Date().toISOString(),
        [column]: cleaned,
      };
      state.supabase.from('kick_tokens').upsert(upd).then(() => {}).catch(() => {});
    }
    const applied = applySpotifySongrequestConfig({
      ...currentSongrequestSnapshot(),
      rewardId: cleaned,
    }, {
      persistLocal: true,
      broadcast: true,
      source: 'local',
    });
    const sync = await syncSongrequestToSupabase('set-reward');
    return { ok: true, synced: !!sync.ok, error: sync.ok ? null : (sync.error || 'No se pudo sincronizar en Supabase') };
  });

  ipcMain.handle('spotify-get-songrequest-config', async () => {
    ensureSpotifySongrequestRealtime();
    await ensureSpotifySongrequestBootstrap(false);
    const cfg = loadConfig();
    let rewardId = getActiveSongRequestRewardId(cfg) || state.songRequestRewardId || '';
    if (state.supabase) {
      try {
        const rowId = getKickBroadcasterRowId(cfg);
        const { data } = await state.supabase
          .from('kick_tokens')
          .select('reward_id')
          .eq('id', rowId)
          .maybeSingle();
        const dbRewardId = String(data?.reward_id || '').trim();
        if (dbRewardId) rewardId = dbRewardId;
      } catch (_) {}
    }
    const applied = applySpotifySongrequestConfig({
      enabled: state.songRequestEnabled !== false,
      kickEnabled: state.songRequestKickEnabled !== false,
      rewardId,
    }, {
      persistLocal: true,
      broadcast: false,
    });
    return applied;
  });

  // Devuelve la queue de requests interna + el requester activo
  ipcMain.handle('spotify-get-request-queue', () => ({
    queue:  state.spotifyRequesterQueue,
    active: state.spotifyActiveRequester
  }));

  // Elimina una entrada de la queue interna por trackId
  // (la canción ya está en la cola de Spotify, pero dejamos de trackearla)
  ipcMain.handle('spotify-remove-from-request-queue', async (_, trackId, options) => {
    const normalized = normalizeTrackId(trackId);
    if (!normalized) return { ok: false, error: 'trackId inválido' };
    const removeFromSpotify = !options || options.removeFromSpotify !== false;
    let spotifyRemoveWarning = '';

    if (removeFromSpotify) {
      const rm = await removeFromPlaybackQueueByTrackId(normalized);
      if (!rm?.ok) spotifyRemoveWarning = rm?.error || 'No se pudo quitar de la cola de Spotify';
    }

    const idx = state.spotifyRequesterQueue.findIndex(r => normalizeTrackId(r.trackId) === normalized);
    if (idx !== -1) state.spotifyRequesterQueue.splice(idx, 1);
    if (normalizeTrackId(state.spotifyActiveRequester?.trackId) === normalized) state.spotifyActiveRequester = null;
    markTrackAsDone(normalized);

    state.mainWindow?.webContents.send('request-queue-update', {
      queue: state.spotifyRequesterQueue,
      active: state.spotifyActiveRequester
    });
    return { ok: true, warning: spotifyRemoveWarning || null };
  });

  // Limpia toda la queue de requests (reset manual de emergencia)
  ipcMain.handle('spotify-clear-request-queue', () => {
    const doneIds = new Set();
    state.spotifyRequesterQueue.forEach(r => {
      const id = normalizeTrackId(r.trackId);
      if (id) doneIds.add(id);
    });
    if (state.spotifyActiveRequester) {
      const activeId = normalizeTrackId(state.spotifyActiveRequester.trackId);
      if (activeId) doneIds.add(activeId);
    }
    doneIds.forEach(id => state.sessionDoneIds.add(id));
    if (doneIds.size && state.supabase) {
      state.supabase
        .from('app_logs')
        .insert([...doneIds].map(id => ({ type: 'sr-done', msg: id })))
        .then(() => {})
        .catch(() => {});
    }

    state.spotifyRequesterQueue = [];
    state.spotifyActiveRequester = null;
    state.mainWindow?.webContents.send('request-queue-update', { queue: [], active: null });
    saveLog('info', '[Requester] Queue limpiada manualmente');
    return { ok: true };
  });

  ipcMain.handle('spotify-remove-queue-item', async (_, input) => {
    const uri = toTrackUri(input);
    if (!uri) return { ok: false, error: 'URI/track inválido' };
    const res = await spotifyPlayerCommand('DELETE', `/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, null);
    if (!res?.ok) return { ok: false, error: res?.error || 'No se pudo quitar de la cola' };
    return { ok: true, uri };
  });

  ipcMain.handle('spotify-add-to-queue', async (_, trackUri, nick, trackName, options) => {
    const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
    const shouldTrackRequest = !!nick && opts.trackAsRequest !== false;
    const parsed = parseSpotifyResource(trackUri);
    if (parsed && parsed.type !== 'track' && parsed.type !== 'episode' && parsed.type !== 'playlist') {
      const typeLabel = {
        album: 'álbum',
        artist: 'artista',
        episode: 'episodio',
        show: 'podcast',
      }[parsed.type] || parsed.type;
      return { ok: false, error: `Ese link es de ${typeLabel}. Solo se permiten tracks, episodios o playlists.` };
    }

    if (parsed?.type === 'playlist') {
      if (shouldTrackRequest) {
        return { ok: false, error: 'Las playlists solo se pueden agregar manualmente desde la app.' };
      }
      const tokenRes = await getCurrentSpotifyAccessToken();
      if (!tokenRes.ok) return { ok: false, error: tokenRes.error || 'No se pudo autenticar en Spotify' };

      const metaRes = await spotifyApiRequestWithAccessToken(
        'GET',
        `/v1/playlists/${encodeURIComponent(parsed.id)}?fields=name`,
        tokenRes.accessToken
      );
      const playlistName = String(metaRes?.data?.name || 'Playlist');

      const listRes = await fetchPlaylistTrackUris(tokenRes.accessToken, parsed.id);
      if (!listRes.ok) return { ok: false, error: listRes.error || 'No se pudo leer la playlist' };
      const uris = Array.isArray(listRes.uris) ? listRes.uris : [];
      if (!uris.length) return { ok: false, error: 'La playlist no tiene tracks reproducibles.' };

      let queuedCount = 0;
      let lastError = '';
      for (const uri of uris) {
        const q = await spotifyApiRequestWithAccessToken(
          'POST',
          `/v1/me/player/queue?uri=${encodeURIComponent(uri)}`,
          tokenRes.accessToken
        );
        if (Number(q?.status || 0) >= 200 && Number(q?.status || 0) < 300) queuedCount++;
        else lastError = q?.data?.error?.message || q?.data?.message || `HTTP ${q?.status}`;
      }
      if (!queuedCount) return { ok: false, error: lastError || 'No se pudo agregar la playlist a la cola.' };
      const failed = Math.max(0, uris.length - queuedCount);
      const msg = failed
        ? `Playlist agregada parcialmente: ${queuedCount}/${uris.length} tracks.`
        : `Playlist agregada: ${queuedCount} tracks en lista.`;
      return {
        ok: true,
        type: 'playlist',
        playlistName,
        queuedCount,
        totalCount: uris.length,
        failedCount: failed,
        message: msg,
      };
    }

    if (shouldTrackRequest && parsed?.type === 'episode') {
      return { ok: false, error: 'Los song requests solo aceptan tracks de música.' };
    }

    let uri = '';
    if (parsed?.type === 'track' || parsed?.type === 'episode') uri = parsed.uri;
    if (!uri) uri = parseSpotifyLink(trackUri);
    if (!uri) return { ok: false, error: 'URI inválida. Usá un track, episodio o playlist de Spotify.' };

    const result = await spotifyPlayerCommand('POST', `/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, null);
    if (result.ok && shouldTrackRequest) {
      let resolvedName = cleanTrackLabel(trackName);
      const trackId = normalizeTrackId(uri);
      if (!trackId) return { ok: false, error: 'No se pudo extraer trackId del URI.' };
      if (!resolvedName) {
        const accessTokenRes = await getCurrentSpotifyAccessToken();
        if (accessTokenRes.ok) {
          resolvedName = await fetchTrackDisplayName(accessTokenRes.accessToken, uri);
        }
      }
      if (!resolvedName) {
        const tokenRes = await getSpotifyTokenData();
        if (tokenRes.ok && tokenRes.data?.refresh_token) {
          resolvedName = await spotifyGetTrackName(
            tokenRes.data.client_id,
            tokenRes.data.client_secret,
            tokenRes.data.refresh_token,
            uri
          ).catch(() => null);
        }
      }
      const safeTrackName = cleanTrackLabel(resolvedName) || trackId;
      const newReq = { nick, trackId, trackName: safeTrackName, _addedAt: Date.now() };
      state.spotifyRequesterQueue.push(newReq);
      state.mainWindow?.webContents.send('request-queue-update', { queue: state.spotifyRequesterQueue, active: state.spotifyActiveRequester });
      saveLog('join', `${nick} agregó a la lista: ${newReq.trackName}`);
      if (state.supabase) state.supabase.from('app_logs').insert({ type: 'sr', msg: JSON.stringify(newReq) }).then(() => {}).catch(() => {});
    }
    if (!result.ok) return result;
    return { ...result, type: 'track', queuedCount: 1, totalCount: 1, message: 'Canción agregada a la lista.' };
  });

  ipcMain.handle('spotify-search', async (_, input) => {
    try {
      const payload = (input && typeof input === 'object' && !Array.isArray(input))
        ? input
        : { query: String(input || '') };
      const query = String(payload.query || '').trim();
      if (!query) return { ok: false, error: 'Query vacía' };

      const allowedTypes = new Set(['track', 'artist', 'album', 'playlist']);
      let types = Array.isArray(payload.types)
        ? payload.types.map(t => String(t || '').trim().toLowerCase()).filter(t => allowedTypes.has(t))
        : ['track'];
      if (!types.length) types = ['track'];

      const sort = String(payload.sort || 'relevance').toLowerCase() === 'popularity' ? 'popularity' : 'relevance';
      const limitRaw = Number(payload.limit || SPOTIFY_SEARCH_MAX_LIMIT);
      const limit = clampSearchLimit(limitRaw);

      const tokenRes = await getCurrentSpotifyAccessToken();
      if (!tokenRes.ok) return { ok: false, error: tokenRes.error || 'Sin access token' };

      const typeParam = types.join(',');
      const endpoint = `/v1/search?q=${encodeURIComponent(query)}&type=${encodeURIComponent(typeParam)}&limit=${limit}`;
      const r = await httpsRequest('GET', 'api.spotify.com', endpoint, {
        'Authorization': `Bearer ${tokenRes.accessToken}`,
      });
      if (Number(r?.status || 0) >= 400) {
        return { ok: false, error: r?.data?.error?.message || r?.data?.message || `HTTP ${r.status}` };
      }

      const tracksRaw = Array.isArray(r.data?.tracks?.items) ? r.data.tracks.items : [];
      const artistsRaw = Array.isArray(r.data?.artists?.items) ? r.data.artists.items : [];
      const albumsRaw = Array.isArray(r.data?.albums?.items) ? r.data.albums.items : [];
      const playlistsRaw = Array.isArray(r.data?.playlists?.items) ? r.data.playlists.items : [];

      const tracks = tracksRaw
        .filter(t => t && typeof t === 'object')
        .map(t => ({
          id: t.id,
          uri: t.uri,
          name: t.name,
          artist: (t.artists || []).map(a => a.name).join(', '),
          album: t.album?.name || '',
          durationMs: Number(t.duration_ms) || 0,
          popularity: Number(t.popularity) || 0,
          explicit: !!t.explicit,
          isPlayable: t.is_playable !== false,
          image: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || '',
          url: t.external_urls?.spotify || '',
        }));
      const artists = artistsRaw
        .filter(a => a && typeof a === 'object')
        .map(a => ({
          id: a.id,
          uri: a.uri,
          name: a.name,
          popularity: Number(a.popularity) || 0,
          followers: Number(a.followers?.total) || 0,
          genres: Array.isArray(a.genres) ? a.genres : [],
          image: a.images?.[2]?.url || a.images?.[0]?.url || '',
          url: a.external_urls?.spotify || '',
        }));
      const albums = albumsRaw
        .filter(a => a && typeof a === 'object')
        .map(a => ({
          id: a.id,
          uri: a.uri,
          name: a.name,
          artist: (a.artists || []).map(x => x.name).join(', '),
          year: String(a.release_date || '').slice(0, 4),
          totalTracks: Number(a.total_tracks) || 0,
          albumType: a.album_type || '',
          image: a.images?.[2]?.url || a.images?.[0]?.url || '',
          url: a.external_urls?.spotify || '',
        }));
      const playlists = playlistsRaw
        .filter(p => p && typeof p === 'object')
        .map((p) => ({
          id: p.id,
          uri: p.uri,
          name: p.name,
          owner: p.owner?.display_name || p.owner?.id || '',
          totalTracks: Number(p.tracks?.total ?? p.items?.total) || 0,
          image: p.images?.[2]?.url || p.images?.[0]?.url || '',
          url: p.external_urls?.spotify || '',
        }));

      if (sort === 'popularity') {
        tracks.sort((a, b) => (Number(b.popularity) || 0) - (Number(a.popularity) || 0));
        artists.sort((a, b) => (Number(b.popularity) || 0) - (Number(a.popularity) || 0));
      }

      return {
        ok: true,
        query,
        types,
        sort,
        limit,
        tracks,
        artists,
        albums,
        playlists,
      };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('spotify-get-queue', async (_, input = {}) => {
    const limitRaw = Number(input?.limit || 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.round(limitRaw))) : 50;
    const tokenRes = await getCurrentSpotifyAccessToken();
    if (!tokenRes.ok) return { ok: false };
    const r = await httpsRequest('GET', 'api.spotify.com', '/v1/me/player/queue',
      { 'Authorization': `Bearer ${tokenRes.accessToken}` });
    if (Number(r?.status || 0) >= 400 || !r.data) return { ok: false };
    return {
      ok: true,
      queue: (r.data.queue || []).slice(0, limit).map(t => ({
        id: t.id,
        uri: t.uri,
        name: t.name,
        artist: spotifyArtistsLabel(t),
        image:
          t.album?.images?.[2]?.url
          || t.album?.images?.[0]?.url
          || t.show?.images?.[2]?.url
          || t.show?.images?.[0]?.url
          || ''
      })),
      total: Array.isArray(r.data.queue) ? r.data.queue.length : 0,
    };
  });

  ipcMain.handle('spotify-connect-oauth', async (_, { clientId, clientSecret }) => {
    try {
      state.mainWindow?.webContents.send('spotify-oauth-status', { step: 'waiting' });
      const code = await startSpotifyOAuthFlow(clientId);

      state.mainWindow?.webContents.send('spotify-oauth-status', { step: 'exchanging' });
      const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT_URI)}`;
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const r = await httpsRequest('POST', 'accounts.spotify.com', '/api/token',
        { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);

      if (!r.data?.refresh_token) return { ok: false, error: r.data?.error_description || 'No se recibió refresh token' };

      if (!state.supabase) return { ok: false, error: 'Sin conexión a Supabase' };
      const rowId = getSpotifyTokenRow();
      const { error } = await state.supabase.from('spotify_tokens').upsert({
        id: rowId, client_id: clientId, client_secret: clientSecret,
        refresh_token: r.data.refresh_token, updated_at: new Date().toISOString()
      });
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('spotify-disconnect', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { error } = await supabase.from('spotify_tokens').delete().eq('id', getSpotifyTokenRow());
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

  ipcMain.handle('spotify-get-credentials', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data } = await supabase.from('spotify_tokens').select('client_id, client_secret').eq('id', getSpotifyTokenRow()).maybeSingle();
    return { ok: true, clientId: data?.client_id || '', clientSecret: data?.client_secret || '' };
  });

}

module.exports = { registerSpotifyIpc };
