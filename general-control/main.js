const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const PRESENCE_KEY_PREFIX = 'runtime_presence_v1:';
const COMMAND_KEY_PREFIX = 'runtime_remote_cmd_v1:';
const SOURCE_REFRESH_MS = 7000;
const COMMAND_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_COMMANDS = 200;

let mainWindow = null;
let refreshTimer = null;
const sourceState = new Map();
let appConfig = null;

function nowIso() {
  return new Date().toISOString();
}

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function configPath() {
  return path.join(app.getPath('userData'), 'general-control.config.json');
}

function defaultConfig() {
  return {
    uiLabel: 'general-control',
    sources: [
      { id: 'almost', label: 'Almost Control', projectId: 'almost-control', supabaseUrl: '', supabaseKey: '' },
      { id: 'aguz', label: 'Aguz Control', projectId: 'aguz-control', supabaseUrl: '', supabaseKey: '' },
    ],
  };
}

function normalizeConfig(raw) {
  const base = defaultConfig();
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    uiLabel: safeString(src.uiLabel) || base.uiLabel,
    sources: [],
  };
  const list = Array.isArray(src.sources) ? src.sources : base.sources;
  for (const row of list) {
    const id = safeString(row?.id).toLowerCase();
    if (!id) continue;
    out.sources.push({
      id,
      label: safeString(row?.label) || id,
      projectId: safeString(row?.projectId) || id,
      supabaseUrl: safeString(row?.supabaseUrl),
      supabaseKey: safeString(row?.supabaseKey),
    });
  }
  if (!out.sources.length) out.sources = base.sources;
  return out;
}

function loadConfig() {
  if (appConfig) return appConfig;
  appConfig = normalizeConfig(readJsonFile(configPath(), defaultConfig()));
  return appConfig;
}

function saveConfig(nextCfg) {
  appConfig = normalizeConfig(nextCfg);
  writeJsonFile(configPath(), appConfig);
  return appConfig;
}

function makeSourceRuntime(source) {
  return {
    sourceId: source.id,
    label: source.label,
    projectId: source.projectId,
    ready: false,
    lastError: '',
    lastSyncAt: null,
    client: null,
    realtimeChannel: null,
    realtimeStatus: 'CLOSED',
    presenceByInstance: new Map(),
    commandById: new Map(),
  };
}

function ensureSourceRuntime(source) {
  const id = source.id;
  if (!sourceState.has(id)) sourceState.set(id, makeSourceRuntime(source));
  const runtime = sourceState.get(id);
  runtime.label = source.label;
  runtime.projectId = source.projectId;
  return runtime;
}

function normalizePresenceRow(source, row) {
  const key = safeString(row?.key);
  if (!key.startsWith(PRESENCE_KEY_PREFIX)) return null;
  const instanceId = safeString(key.slice(PRESENCE_KEY_PREFIX.length));
  if (!instanceId) return null;
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  const lastSeen = safeString(value.lastSeen);
  const lastSeenTs = Date.parse(lastSeen);
  const ageMs = Number.isFinite(lastSeenTs) ? Math.max(0, Date.now() - lastSeenTs) : Number.MAX_SAFE_INTEGER;
  return {
    sourceId: source.id,
    sourceLabel: source.label,
    instanceId,
    project: safeString(value.project || value.projectId || source.projectId),
    label: safeString(value.label) || safeString(value.host) || instanceId,
    host: safeString(value.host),
    user: safeString(value.user),
    mode: safeString(value.mode || value?.kick?.mode || 'prod'),
    online: ageMs <= 20000,
    ageMs,
    lastSeen: lastSeen || null,
    kick: {
      connected: !!value?.kick?.connected,
      mode: safeString(value?.kick?.mode || 'prod'),
      channel: safeString(value?.kick?.channel),
      hasBroadcasterToken: !!value?.kick?.hasBroadcasterToken,
      hasBotToken: !!value?.kick?.hasBotToken,
    },
    songrequest: {
      enabled: value?.songrequest?.enabled !== false,
      kickEnabled: value?.songrequest?.kickEnabled !== false,
      rewardId: safeString(value?.songrequest?.rewardId),
      queuePending: Number(value?.songrequest?.queuePending || 0),
    },
    runtime: {
      queueProcessing: !!value?.runtime?.queueProcessing,
      queueLength: Number(value?.runtime?.queueLength || 0),
      commandFailed: Number(value?.runtime?.commandFailed || 0),
      commandTimeouts: Number(value?.runtime?.commandTimeouts || 0),
    },
  };
}

function normalizeCommandRow(source, row) {
  const key = safeString(row?.key);
  if (!key.startsWith(COMMAND_KEY_PREFIX)) return null;
  const commandId = safeString(key.slice(COMMAND_KEY_PREFIX.length));
  if (!commandId) return null;
  const value = row?.value && typeof row.value === 'object' ? row.value : {};
  const createdAt = safeString(value.createdAt) || null;
  const createdTs = Date.parse(createdAt || '');
  if (Number.isFinite(createdTs) && (Date.now() - createdTs) > COMMAND_TTL_MS) return null;
  return {
    sourceId: source.id,
    sourceLabel: source.label,
    commandId,
    action: safeString(value.action).toLowerCase(),
    sourceProject: safeString(value.sourceProject),
    targetProject: safeString(value.targetProject),
    targetInstanceId: safeString(value.targetInstanceId),
    createdAt,
    expiresAt: safeString(value.expiresAt) || null,
    results: value.results && typeof value.results === 'object' ? value.results : {},
    payload: value.payload && typeof value.payload === 'object' ? value.payload : {},
  };
}

async function withRetry(fn, retries = 2, delayMs = 250) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
    }
  }
  throw lastErr || new Error('Operation failed');
}

async function pullSourceRows(source, runtime) {
  if (!runtime.client) return;
  const client = runtime.client;
  const [presenceRes, commandRes] = await Promise.all([
    withRetry(() => client.from('overlay_settings').select('key,value').ilike('key', `${PRESENCE_KEY_PREFIX}%`).limit(200)),
    withRetry(() => client.from('overlay_settings').select('key,value').ilike('key', `${COMMAND_KEY_PREFIX}%`).limit(300)),
  ]);
  if (presenceRes.error) throw new Error(presenceRes.error.message || 'No se pudo leer presencia');
  if (commandRes.error) throw new Error(commandRes.error.message || 'No se pudo leer comandos');

  runtime.presenceByInstance.clear();
  for (const row of (presenceRes.data || [])) {
    const parsed = normalizePresenceRow(source, row);
    if (!parsed) continue;
    runtime.presenceByInstance.set(parsed.instanceId, parsed);
  }

  runtime.commandById.clear();
  const parsedCommands = [];
  for (const row of (commandRes.data || [])) {
    const parsed = normalizeCommandRow(source, row);
    if (!parsed) continue;
    parsedCommands.push(parsed);
  }
  parsedCommands
    .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
    .slice(0, MAX_COMMANDS)
    .forEach((row) => runtime.commandById.set(row.commandId, row));
}

function ensureRealtimeSource(source, runtime) {
  const client = runtime.client;
  if (!client) return;
  const healthy = runtime.realtimeChannel && (runtime.realtimeStatus === 'SUBSCRIBED' || runtime.realtimeStatus === 'JOINING');
  if (healthy) return;
  if (runtime.realtimeChannel) {
    Promise.resolve(client.removeChannel(runtime.realtimeChannel)).catch(() => {});
    runtime.realtimeChannel = null;
  }
  runtime.realtimeStatus = 'JOINING';
  runtime.realtimeChannel = client
    .channel(`gc-${source.id}-${Date.now()}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'overlay_settings' },
      (payload) => {
        const row = payload?.new || payload?.record || payload?.old || null;
        const key = safeString(row?.key);
        if (!key.startsWith(PRESENCE_KEY_PREFIX) && !key.startsWith(COMMAND_KEY_PREFIX)) return;
        syncSource(source).catch(() => {});
      }
    )
    .subscribe((status) => {
      runtime.realtimeStatus = safeString(status).toUpperCase() || 'UNKNOWN';
      if (runtime.realtimeStatus === 'SUBSCRIBED') {
        syncSource(source).catch(() => {});
      }
      if (runtime.realtimeStatus === 'CHANNEL_ERROR' || runtime.realtimeStatus === 'TIMED_OUT' || runtime.realtimeStatus === 'CLOSED') {
        runtime.realtimeChannel = null;
      }
      broadcastState('realtime-status');
    });
}

async function syncSource(source) {
  const runtime = ensureSourceRuntime(source);
  const hasCreds = !!(source.supabaseUrl && source.supabaseKey);
  if (!hasCreds) {
    runtime.ready = false;
    runtime.lastError = 'Faltan credenciales';
    runtime.client = null;
    runtime.presenceByInstance.clear();
    runtime.commandById.clear();
    broadcastState('missing-creds');
    return;
  }
  if (!runtime.client) {
    runtime.client = createClient(source.supabaseUrl, source.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  try {
    await pullSourceRows(source, runtime);
    runtime.ready = true;
    runtime.lastError = '';
    runtime.lastSyncAt = nowIso();
    ensureRealtimeSource(source, runtime);
  } catch (e) {
    runtime.ready = false;
    runtime.lastError = safeString(e?.message || e || 'Sync falló');
  }
  broadcastState('sync');
}

function getStateSnapshot() {
  const cfg = loadConfig();
  const sources = cfg.sources.map((source) => {
    const runtime = ensureSourceRuntime(source);
    return {
      sourceId: source.id,
      label: source.label,
      projectId: source.projectId,
      ready: !!runtime.ready,
      lastError: safeString(runtime.lastError),
      lastSyncAt: runtime.lastSyncAt,
      realtimeStatus: safeString(runtime.realtimeStatus),
      instances: Array.from(runtime.presenceByInstance.values()).sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (a.ageMs || 0) - (b.ageMs || 0);
      }),
      commands: Array.from(runtime.commandById.values())
        .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''))
        .slice(0, MAX_COMMANDS),
    };
  });
  return {
    generatedAt: nowIso(),
    uiLabel: cfg.uiLabel,
    sources,
  };
}

function broadcastState(source = 'local') {
  mainWindow?.webContents.send('gc-state-updated', {
    source,
    ...getStateSnapshot(),
  });
}

function createRemoteCommand(action, options = {}) {
  const id = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + COMMAND_TTL_MS).toISOString();
  return {
    commandId: id,
    createdAt,
    expiresAt,
    sourceProject: 'general-control',
    sourceLabel: safeString(loadConfig().uiLabel || 'general-control'),
    targetProject: safeString(options.targetProject),
    targetInstanceId: safeString(options.targetInstanceId),
    action: safeString(action).toLowerCase(),
    payload: options.payload && typeof options.payload === 'object' ? options.payload : {},
    results: {},
  };
}

async function sendRemoteCommand({ sourceId, action, targetProject, targetInstanceId, payload }) {
  const cfg = loadConfig();
  const source = cfg.sources.find((row) => row.id === sourceId);
  if (!source) return { ok: false, error: `Fuente inválida: ${sourceId}` };
  const runtime = ensureSourceRuntime(source);
  if (!runtime.client) {
    await syncSource(source);
  }
  if (!runtime.client) return { ok: false, error: 'Sin cliente Supabase para la fuente' };
  const command = createRemoteCommand(action, { targetProject, targetInstanceId, payload });
  const key = `${COMMAND_KEY_PREFIX}${command.commandId}`;
  const { error } = await runtime.client.from('overlay_settings').upsert({ key, value: command }, { onConflict: 'key' });
  if (error) return { ok: false, error: error.message || 'No pude enviar comando remoto' };
  await syncSource(source);
  return { ok: true, commandId: command.commandId };
}

async function pruneOldCommandsForSource(source) {
  const runtime = ensureSourceRuntime(source);
  if (!runtime.client) return { ok: true, removed: 0 };
  const oldRows = Array.from(runtime.commandById.values()).filter((cmd) => {
    const ts = Date.parse(cmd.createdAt || '');
    return Number.isFinite(ts) && (Date.now() - ts) > COMMAND_TTL_MS;
  });
  if (!oldRows.length) return { ok: true, removed: 0 };
  let removed = 0;
  for (const row of oldRows) {
    const key = `${COMMAND_KEY_PREFIX}${row.commandId}`;
    const { error } = await runtime.client.from('overlay_settings').delete().eq('key', key);
    if (!error) removed += 1;
  }
  await syncSource(source);
  return { ok: true, removed };
}

async function syncAllSources() {
  const cfg = loadConfig();
  for (const source of cfg.sources) {
    await syncSource(source);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1200,
    minHeight: 760,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

function registerIpc() {
  ipcMain.handle('gc-get-config', async () => ({ ok: true, config: loadConfig() }));
  ipcMain.handle('gc-save-config', async (_, nextCfg) => {
    const cfg = saveConfig(nextCfg);
    const sources = cfg.sources.map((row) => row.id);
    for (const [id, runtime] of sourceState.entries()) {
      if (!sources.includes(id) && runtime.client && runtime.realtimeChannel) {
        Promise.resolve(runtime.client.removeChannel(runtime.realtimeChannel)).catch(() => {});
      }
      if (!sources.includes(id)) sourceState.delete(id);
    }
    await syncAllSources();
    return { ok: true, config: cfg };
  });
  ipcMain.handle('gc-get-state', async () => ({ ok: true, ...getStateSnapshot() }));
  ipcMain.handle('gc-refresh', async () => {
    await syncAllSources();
    return { ok: true, ...getStateSnapshot() };
  });
  ipcMain.handle('gc-send-command', async (_, payload = {}) => {
    const result = await sendRemoteCommand({
      sourceId: safeString(payload.sourceId),
      action: safeString(payload.action),
      targetProject: safeString(payload.targetProject),
      targetInstanceId: safeString(payload.targetInstanceId),
      payload: payload.payload && typeof payload.payload === 'object' ? payload.payload : {},
    });
    return result;
  });
  ipcMain.handle('gc-prune-old-commands', async (_, sourceId) => {
    const cfg = loadConfig();
    const source = cfg.sources.find((row) => row.id === safeString(sourceId));
    if (!source) return { ok: false, error: 'Fuente inválida' };
    return pruneOldCommandsForSource(source);
  });
}

app.whenReady().then(async () => {
  loadConfig();
  createWindow();
  registerIpc();
  await syncAllSources();
  refreshTimer = setInterval(() => {
    syncAllSources().catch(() => {});
  }, SOURCE_REFRESH_MS);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (refreshTimer) clearInterval(refreshTimer);
  for (const runtime of sourceState.values()) {
    if (runtime.client && runtime.realtimeChannel) {
      Promise.resolve(runtime.client.removeChannel(runtime.realtimeChannel)).catch(() => {});
    }
  }
});
