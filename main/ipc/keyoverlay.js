const KEY_OVERLAY_ROW_KEY = 'key_overlay';
const REMOTE_POLL_MS = 2500;
const LOCAL_REMOTE_GRACE_MS = 1800;
const BG_TYPE_SET = new Set(['default', 'url', 'upload']);
const KO_BG_MAX_BYTES = 3 * 1024 * 1024;
const KO_BG_ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);
const KO_BG_EXT_BY_MIME = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};

function clampOpacity(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function normalizeBackground(raw) {
  const bg = raw && typeof raw === 'object' ? raw : {};
  const type = BG_TYPE_SET.has(String(bg.type || '').toLowerCase())
    ? String(bg.type || '').toLowerCase()
    : 'default';
  const value = String(bg.value || '').trim();
  if (!value || type === 'default') {
    return { type: 'default', value: '', name: '' };
  }
  const name = String(bg.name || '').trim().slice(0, 255);
  const bucket = String(bg.bucket || '').trim();
  const storagePath = String(bg.storagePath || '').trim().replace(/\\/g, '/');
  return { type, value, name, bucket, storagePath };
}

function normalizeKeyOverlayConfig(incoming, previous) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const cfg = incoming && typeof incoming === 'object' ? incoming : {};

  const prevStyle = prev.style && typeof prev.style === 'object' ? prev.style : {};
  const styleIn = cfg.style && typeof cfg.style === 'object' ? cfg.style : {};
  const fontSize = ['sm', 'md', 'lg', 'xl'].includes(String(styleIn.fontSize || '').toLowerCase())
    ? String(styleIn.fontSize || '').toLowerCase()
    : (['sm', 'md', 'lg', 'xl'].includes(String(prevStyle.fontSize || '').toLowerCase()) ? String(prevStyle.fontSize || '').toLowerCase() : 'md');

  const selectedRaw = Array.isArray(cfg.selectedKeys) ? cfg.selectedKeys : (Array.isArray(prev.selectedKeys) ? prev.selectedKeys : []);
  const selectedKeys = [];
  const selectedSeen = new Set();
  for (const v of selectedRaw) {
    const val = (typeof v === 'number' && Number.isFinite(v))
      ? v
      : (/^-?\d+$/.test(String(v || '').trim()) ? Number(String(v).trim()) : String(v || '').trim());
    const key = String(val);
    if (!key || selectedSeen.has(key)) continue;
    selectedSeen.add(key);
    selectedKeys.push(val);
  }

  const customRaw = Array.isArray(cfg.customKeys) ? cfg.customKeys : (Array.isArray(prev.customKeys) ? prev.customKeys : []);
  const customKeys = [];
  const customSeen = new Set();
  for (const item of customRaw) {
    if (!item || typeof item !== 'object') continue;
    const keycode = (/^-?\d+$/.test(String(item.keycode || '').trim()))
      ? Number(String(item.keycode).trim())
      : String(item.keycode || '').trim();
    if (keycode === '' || keycode == null) continue;
    const key = String(keycode);
    if (customSeen.has(key)) continue;
    customSeen.add(key);
    customKeys.push({
      keycode,
      label: String(item.label || `#${keycode}`).slice(0, 30),
      row: Number.isFinite(Number(item.row)) ? Number(item.row) : 8,
    });
  }

  const prevBg = normalizeBackground(prev.background);
  const nextBg = normalizeBackground(cfg.background || prevBg);

  return {
    selectedKeys,
    customKeys,
    style: {
      fontSize,
      keyColor: String(styleIn.keyColor || prevStyle.keyColor || '#ffffff'),
      bgColor: String(styleIn.bgColor || prevStyle.bgColor || 'rgba(15,15,20,0.9)'),
      accentColor: String(styleIn.accentColor || prevStyle.accentColor || '#f97316'),
      fadeDelay: Number.isFinite(Number(styleIn.fadeDelay)) ? Number(styleIn.fadeDelay) : (Number.isFinite(Number(prevStyle.fadeDelay)) ? Number(prevStyle.fadeDelay) : 0),
      inactiveOpacity: clampOpacity(styleIn.inactiveOpacity, clampOpacity(prevStyle.inactiveOpacity, 0.3)),
    },
    gamepadEnabled: cfg.gamepadEnabled !== undefined ? !!cfg.gamepadEnabled : !!prev.gamepadEnabled,
    gamepadButtons: (cfg.gamepadButtons && typeof cfg.gamepadButtons === 'object')
      ? { ...cfg.gamepadButtons }
      : ((prev.gamepadButtons && typeof prev.gamepadButtons === 'object') ? { ...prev.gamepadButtons } : {}),
    background: nextBg,
  };
}

function registerKeyOverlayIpc({ ipcMain, loadConfig, saveConfig, startKeyOverlay, stopKeyOverlay, getKeyOverlayStatus, broadcastOverlay, configMsg, configRefreshMsg, state }) {
  let realtimeChannel = null;
  let realtimeSupabaseRef = null;
  let realtimeStatus = 'CLOSED';
  let syncRetryTimer = null;
  let syncRetryBackoffMs = 0;
  let syncInFlight = false;
  let lastSyncedConfigHash = '';
  let lastRemoteConfigHash = '';
  let lastLocalWriteAt = 0;
  let remotePollInFlight = false;

  function persistLocalConfig(cfg) {
    const appCfg = loadConfig();
    appCfg.keyOverlayConfig = cfg;
    saveConfig(appCfg);
  }

  function applyConfig(cfg, options = {}) {
    const next = normalizeKeyOverlayConfig(cfg, state.keyOverlayConfig);
    const nextHash = configHash(next);
    state.keyOverlayConfig = next;
    if (options.markLocalChange) lastLocalWriteAt = Date.now();
    if (options.source === 'supabase') {
      lastRemoteConfigHash = nextHash;
      lastSyncedConfigHash = nextHash;
    }
    if (options.persistLocal !== false) persistLocalConfig(next);
    if (options.broadcast !== false) {
      const refresh = (typeof configRefreshMsg === 'function') ? configRefreshMsg() : { type: 'config-refresh' };
      broadcastOverlay(refresh);
    }
    if (options.notifyRenderer) {
      state.mainWindow?.webContents.send('keyoverlay-config-updated', {
        source: options.source || 'local',
        config: next,
      });
    }
    return next;
  }

  function getBackgroundBucket() {
    const cfg = loadConfig();
    const bucket = String(cfg?.keyOverlayStorageBucket || '').trim();
    return bucket || 'overlays';
  }

  function normalizeStoragePath(value, bucketName = '') {
    let raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!raw) return '';
    const bucket = String(bucketName || '').trim();
    if (bucket && raw.toLowerCase().startsWith(`${bucket.toLowerCase()}/`)) {
      raw = raw.slice(bucket.length + 1);
    }
    return raw;
  }

  function parseDataUrl(input) {
    const raw = String(input || '').trim();
    const m = raw.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
    if (!m) return { ok: false, error: 'Formato inválido: esperábamos data URL base64.' };
    const mimeType = String(m[1] || '').trim().toLowerCase();
    if (!KO_BG_ALLOWED_MIME.has(mimeType)) {
      return { ok: false, error: 'Formato de imagen no soportado. Usá JPG, PNG, WEBP, GIF o SVG.' };
    }
    const base64 = String(m[2] || '').replace(/\s+/g, '');
    if (!base64) return { ok: false, error: 'Imagen vacía.' };
    let body = null;
    try {
      body = Buffer.from(base64, 'base64');
    } catch {
      return { ok: false, error: 'No se pudo decodificar la imagen.' };
    }
    if (!body || !body.length) return { ok: false, error: 'Imagen vacía.' };
    if (body.length > KO_BG_MAX_BYTES) {
      return { ok: false, error: 'La imagen supera 3MB. Elegí una más liviana.' };
    }
    return { ok: true, mimeType, body };
  }

  async function uploadBackgroundToBucket(payload) {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase' };

    const parsed = parseDataUrl(payload?.dataUrl);
    if (!parsed.ok) return parsed;

    const fileName = String(payload?.fileName || '').trim();
    const mimeType = parsed.mimeType;
    const ext = KO_BG_EXT_BY_MIME[mimeType] || '.bin';
    const bucket = getBackgroundBucket();
    const storagePath = normalizeStoragePath(
      payload?.storagePath || `key-overlay/background/current${ext}`,
      bucket
    );
    if (!storagePath) {
      return { ok: false, error: 'Ruta de archivo inválida para el bucket.' };
    }

    const up = await supabase.storage.from(bucket).upload(storagePath, parsed.body, {
      contentType: mimeType,
      upsert: true,
      cacheControl: '3600',
    });
    if (up?.error) {
      const msg = [up.error.message, up.error.code, up.error.details, up.error.hint]
        .filter(Boolean)
        .join(' | ');
      return { ok: false, error: msg || 'No se pudo subir la imagen al bucket.' };
    }

    const pub = supabase.storage.from(bucket).getPublicUrl(storagePath);
    const publicUrl = String(pub?.data?.publicUrl || '').trim();
    if (!publicUrl) {
      return { ok: false, error: 'No se pudo obtener la URL pública del archivo.' };
    }
    const versionedUrl = `${publicUrl}${publicUrl.includes('?') ? '&' : '?'}v=${Date.now()}`;

    return {
      ok: true,
      background: {
        type: 'upload',
        value: versionedUrl,
        name: fileName.slice(0, 255),
        bucket,
        storagePath,
      },
    };
  }

  async function pushConfigToSupabase(cfg) {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase' };
    const { error } = await supabase
      .from('overlay_settings')
      .upsert({ key: KEY_OVERLAY_ROW_KEY, value: cfg }, { onConflict: 'key' });
    if (error) return { ok: false, error: error.message || 'No se pudo guardar en Supabase' };
    return { ok: true };
  }

  function configHash(cfg) {
    try {
      return JSON.stringify(cfg || {});
    } catch {
      return '';
    }
  }

  function applyRemoteConfig(cfg, options = {}) {
    const next = normalizeKeyOverlayConfig(cfg, state.keyOverlayConfig);
    const nextHash = configHash(next);
    if (!nextHash) return false;

    const currentHash = configHash(normalizeKeyOverlayConfig(state.keyOverlayConfig, state.keyOverlayConfig));
    if (nextHash === currentHash) {
      lastRemoteConfigHash = nextHash;
      lastSyncedConfigHash = nextHash;
      return false;
    }

    if ((Date.now() - lastLocalWriteAt) < LOCAL_REMOTE_GRACE_MS) {
      return false;
    }

    applyConfig(next, {
      persistLocal: true,
      broadcast: true,
      notifyRenderer: options.notifyRenderer !== false,
      source: 'supabase',
    });
    return true;
  }

  function clearSyncRetryTimer() {
    if (!syncRetryTimer) return;
    clearTimeout(syncRetryTimer);
    syncRetryTimer = null;
  }

  function scheduleConfigSyncRetry() {
    if (syncRetryTimer) return;
    syncRetryBackoffMs = syncRetryBackoffMs ? Math.min(syncRetryBackoffMs * 2, 30000) : 1500;
    syncRetryTimer = setTimeout(() => {
      syncRetryTimer = null;
      syncConfigToSupabase('retry').catch(() => {});
    }, syncRetryBackoffMs);
  }

  async function syncConfigToSupabase(trigger = 'manual') {
    if (syncInFlight) return { ok: false, skipped: true, error: 'Sync en progreso' };
    const currentCfg = normalizeKeyOverlayConfig(state.keyOverlayConfig, state.keyOverlayConfig);
    const currentHash = configHash(currentCfg);
    if (trigger !== 'retry' && currentHash && currentHash === lastSyncedConfigHash) {
      return { ok: true, skipped: true };
    }

    syncInFlight = true;
    try {
      const res = await pushConfigToSupabase(currentCfg);
      if (res.ok) {
        lastSyncedConfigHash = currentHash;
        syncRetryBackoffMs = 0;
        clearSyncRetryTimer();
        return { ok: true };
      }
      scheduleConfigSyncRetry();
      return res;
    } finally {
      syncInFlight = false;
    }
  }

  function closeRealtimeChannel() {
    if (!realtimeChannel || !realtimeSupabaseRef) {
      realtimeChannel = null;
      realtimeSupabaseRef = null;
      realtimeStatus = 'CLOSED';
      return;
    }
    const sb = realtimeSupabaseRef;
    const ch = realtimeChannel;
    realtimeChannel = null;
    realtimeSupabaseRef = null;
    realtimeStatus = 'CLOSED';
    Promise.resolve(sb.removeChannel(ch)).catch(() => {});
  }

  function ensureRealtimeSync() {
    const supabase = state.supabase;
    if (!supabase) {
      closeRealtimeChannel();
      return;
    }
    const channelHealthy = (
      realtimeChannel
      && realtimeSupabaseRef === supabase
      && (realtimeStatus === 'SUBSCRIBED' || realtimeStatus === 'JOINING')
    );
    if (channelHealthy) return;
    closeRealtimeChannel();

    realtimeSupabaseRef = supabase;
    realtimeStatus = 'JOINING';
    realtimeChannel = supabase
      .channel(`key-overlay-sync-${Date.now()}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'overlay_settings',
          filter: `key=eq.${KEY_OVERLAY_ROW_KEY}`,
        },
        (payload) => {
          const nextValue = payload?.new?.value ?? payload?.record?.value ?? null;
          if (!nextValue) return;
          applyRemoteConfig(nextValue, {
            notifyRenderer: true,
          });
        }
      )
      .subscribe((status) => {
        realtimeStatus = String(status || '').toUpperCase() || 'UNKNOWN';
        if (realtimeStatus === 'SUBSCRIBED') {
          pullConfigFromSupabase().then((remote) => {
            if (!remote) return;
            applyRemoteConfig(remote, {
              notifyRenderer: true,
            });
          }).catch(() => {});
          return;
        }
        if (realtimeStatus === 'CHANNEL_ERROR' || realtimeStatus === 'TIMED_OUT' || realtimeStatus === 'CLOSED') {
          closeRealtimeChannel();
          setTimeout(() => ensureRealtimeSync(), 1500);
        }
      });
  }

  async function pullConfigFromSupabase() {
    const supabase = state.supabase;
    if (!supabase) return null;
    try {
      const { data, error } = await supabase
        .from('overlay_settings')
        .select('value')
        .eq('key', KEY_OVERLAY_ROW_KEY)
        .maybeSingle();
      if (error || !data?.value) return null;
      return data.value;
    } catch {
      return null;
    }
  }

  async function pollConfigFromSupabase() {
    if (remotePollInFlight || !state.supabase) return;
    remotePollInFlight = true;
    try {
      const remote = await pullConfigFromSupabase();
      if (!remote) return;
      const remoteHash = configHash(normalizeKeyOverlayConfig(remote, state.keyOverlayConfig));
      if (remoteHash && remoteHash === lastRemoteConfigHash) return;
      applyRemoteConfig(remote, { notifyRenderer: true });
    } finally {
      remotePollInFlight = false;
    }
  }

  setInterval(() => ensureRealtimeSync(), 4000);
  setInterval(() => pollConfigFromSupabase().catch(() => {}), REMOTE_POLL_MS);
  ensureRealtimeSync();
  Promise.resolve().then(async () => {
    const remote = await pullConfigFromSupabase();
    if (!remote) return;
    applyRemoteConfig(remote, {
      notifyRenderer: false,
    });
  }).catch(() => {});

  ipcMain.handle('keyoverlay-start', () => { startKeyOverlay(); return { ok: true }; });
  ipcMain.handle('keyoverlay-stop',  () => { stopKeyOverlay();  return { ok: true }; });

  ipcMain.handle('keyoverlay-status', () => {
    ensureRealtimeSync();
    return { ok: true, ...(getKeyOverlayStatus ? getKeyOverlayStatus() : { running: state.keyOverlayRunning, url: 'http://localhost:9001' }) };
  });

  ipcMain.handle('keyoverlay-get-config', async () => {
    ensureRealtimeSync();
    const remote = await pullConfigFromSupabase();
    if (remote) {
      applyRemoteConfig(remote, {
        notifyRenderer: false,
      });
    } else {
      applyConfig(state.keyOverlayConfig, {
        persistLocal: true,
        broadcast: false,
        notifyRenderer: false,
      });
    }
    return { ok: true, config: state.keyOverlayConfig };
  });

  ipcMain.handle('keyoverlay-set-config', async (_, cfg) => {
    ensureRealtimeSync();
    applyConfig(cfg, {
      persistLocal: true,
      broadcast: true,
      notifyRenderer: false,
      source: 'local',
      markLocalChange: true,
    });
    const syncRes = await syncConfigToSupabase('set-config');
    if (!syncRes.ok) return { ok: true, synced: false, error: syncRes.error || 'No se pudo sincronizar en Supabase' };
    return { ok: true, synced: true };
  });

  ipcMain.handle('keyoverlay-upload-background', async (_, payload) => {
    ensureRealtimeSync();
    const uploaded = await uploadBackgroundToBucket(payload);
    if (!uploaded.ok) return uploaded;

    const baseCfg = normalizeKeyOverlayConfig(state.keyOverlayConfig, state.keyOverlayConfig);
    const nextCfg = applyConfig({
      ...baseCfg,
      background: uploaded.background,
    }, {
      persistLocal: true,
      broadcast: true,
      notifyRenderer: false,
      source: 'local',
      markLocalChange: true,
    });

    const syncRes = await syncConfigToSupabase('upload-background');
    if (!syncRes.ok) return { ok: true, synced: false, error: syncRes.error || 'No se pudo sincronizar en Supabase', background: nextCfg.background };
    return { ok: true, synced: true, background: nextCfg.background };
  });

  ipcMain.handle('keyoverlay-detect-next', () => {
    if (!state.keyOverlayRunning) return { ok: false, error: 'Activá el overlay primero' };
    state.koDetecting = true;
    return { ok: true };
  });

  ipcMain.handle('keyoverlay-detect-stop', () => {
    state.koDetecting = false;
    return { ok: true };
  });
}

module.exports = { registerKeyOverlayIpc };
