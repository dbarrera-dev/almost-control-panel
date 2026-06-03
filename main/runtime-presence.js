const os = require('os');
const crypto = require('crypto');
const { resolveKickRouting } = require('./kick-utils');

const PRESENCE_KEY_PREFIX = 'runtime_presence_v1:';
const REMOTE_COMMAND_KEY_PREFIX = 'runtime_remote_cmd_v1:';
const HEARTBEAT_MS = 5000;
const FULL_REFRESH_MS = 15000;
const STALE_AFTER_MS = 20000;
const MAX_INSTANCES = 128;
const REMOTE_COMMAND_SCAN_LIMIT = 80;
const REMOTE_COMMAND_TTL_MS = 8 * 60 * 60 * 1000;
const REMOTE_COMMAND_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function safeString(value) {
  return String(value == null ? '' : value).trim();
}

function parseIsoTimestamp(value) {
  const s = safeString(value);
  if (!s) return 0;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

function normalizePresenceValue(raw, fallbackId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const instanceId = safeString(raw.instanceId || fallbackId);
  if (!instanceId) return null;
  const host = safeString(raw.host);
  const user = safeString(raw.user);
  const mode = raw?.kick?.mode === 'dev' ? 'dev' : 'prod';
  const lastSeen = safeString(raw.lastSeen) || new Date().toISOString();
  const project = safeString(raw.project || raw.projectId || '');
  return {
    instanceId,
    project,
    host,
    user,
    label: safeString(raw.label) || (host || user ? `${host || '?'}${user ? ` (${user})` : ''}` : instanceId),
    appVersion: safeString(raw.appVersion),
    platform: safeString(raw.platform),
    arch: safeString(raw.arch),
    mode,
    lastSeen,
    kick: {
      connected: !!raw?.kick?.connected,
      mode,
      channel: safeString(raw?.kick?.channel),
      hasBroadcasterToken: !!raw?.kick?.hasBroadcasterToken,
      hasBotToken: !!raw?.kick?.hasBotToken,
    },
    songrequest: {
      enabled: raw?.songrequest?.enabled !== false,
      kickEnabled: raw?.songrequest?.kickEnabled !== false,
      rewardId: safeString(raw?.songrequest?.rewardId),
      queuePending: Number.isFinite(Number(raw?.songrequest?.queuePending)) ? Number(raw.songrequest.queuePending) : 0,
      activeRequesterNick: safeString(raw?.songrequest?.activeRequesterNick),
    },
    overlays: {
      key: !!raw?.overlays?.key,
      spotify: !!raw?.overlays?.spotify,
      rl: !!raw?.overlays?.rl,
      teams: !!raw?.overlays?.teams,
    },
    runtime: {
      queueProcessing: !!raw?.runtime?.queueProcessing,
      queueLength: Number.isFinite(Number(raw?.runtime?.queueLength)) ? Number(raw.runtime.queueLength) : 0,
      commandFailed: Number.isFinite(Number(raw?.runtime?.commandFailed)) ? Number(raw.runtime.commandFailed) : 0,
      commandTimeouts: Number.isFinite(Number(raw?.runtime?.commandTimeouts)) ? Number(raw.runtime.commandTimeouts) : 0,
    },
  };
}

function createRuntimePresenceService({
  ipcMain,
  app,
  loadConfig,
  saveConfig,
  saveLog,
  state,
  connectKickBot,
  disconnectKickBot,
}) {
  let instanceId = '';
  let projectId = '';
  let fullRefreshTimer = null;
  let heartbeatTimer = null;
  let keepRealtimeTimer = null;
  let remoteCommandSweepTimer = null;
  let realtimeChannel = null;
  let realtimeSupabaseRef = null;
  let realtimeStatus = 'CLOSED';
  let lastFullRefreshAt = 0;
  const presenceByInstance = new Map();
  const processedRemoteCommands = new Map();

  function ensureInstanceId() {
    if (instanceId) return instanceId;
    const cfg = loadConfig();
    const existing = safeString(cfg.runtimeInstanceId);
    if (existing) {
      instanceId = existing;
      return instanceId;
    }
    const generated = (typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
    instanceId = `pc-${generated}`;
    cfg.runtimeInstanceId = instanceId;
    saveConfig(cfg);
    return instanceId;
  }

  function ensureProjectId() {
    if (projectId) return projectId;
    const cfg = loadConfig();
    const existing = safeString(cfg.runtimeProjectId);
    if (existing) {
      projectId = existing;
      return projectId;
    }
    const fallback = safeString(app?.name || app?.getName?.() || 'almost-control')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'almost-control';
    projectId = fallback;
    cfg.runtimeProjectId = projectId;
    saveConfig(cfg);
    return projectId;
  }

  function localPresenceKey() {
    return `${PRESENCE_KEY_PREFIX}${ensureInstanceId()}`;
  }

  function isPresenceKey(key) {
    const normalized = safeString(key);
    return normalized.startsWith(PRESENCE_KEY_PREFIX);
  }

  function extractInstanceIdFromKey(key) {
    const normalized = safeString(key);
    if (!isPresenceKey(normalized)) return '';
    return safeString(normalized.slice(PRESENCE_KEY_PREFIX.length));
  }

  function isRemoteCommandKey(key) {
    const normalized = safeString(key);
    return normalized.startsWith(REMOTE_COMMAND_KEY_PREFIX);
  }

  function extractRemoteCommandIdFromKey(key) {
    const normalized = safeString(key);
    if (!isRemoteCommandKey(normalized)) return '';
    return safeString(normalized.slice(REMOTE_COMMAND_KEY_PREFIX.length));
  }

  function upsertPresenceEntry(value, source = 'local') {
    const normalized = normalizePresenceValue(value);
    if (!normalized) return false;
    const prev = presenceByInstance.get(normalized.instanceId);
    const prevTs = parseIsoTimestamp(prev?.lastSeen);
    const nextTs = parseIsoTimestamp(normalized.lastSeen);
    if (prev && nextTs && prevTs && nextTs < prevTs) return false;
    presenceByInstance.set(normalized.instanceId, normalized);
    if (source !== 'silent') broadcastPresence(source);
    return true;
  }

  function removePresenceEntry(instance, source = 'supabase') {
    const id = safeString(instance);
    if (!id) return false;
    const removed = presenceByInstance.delete(id);
    if (removed) broadcastPresence(source);
    return removed;
  }

  function buildPresenceSnapshot() {
    const now = Date.now();
    const localId = ensureInstanceId();
    const instances = Array.from(presenceByInstance.values())
      .map((entry) => {
        const lastSeenTs = parseIsoTimestamp(entry.lastSeen);
        const ageMs = lastSeenTs ? Math.max(0, now - lastSeenTs) : Number.MAX_SAFE_INTEGER;
        return {
          ...entry,
          isLocal: entry.instanceId === localId,
          ageMs,
          online: ageMs <= STALE_AFTER_MS,
        };
      })
      .sort((a, b) => {
        if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
        if (a.online !== b.online) return a.online ? -1 : 1;
        return a.ageMs - b.ageMs;
      })
      .slice(0, MAX_INSTANCES);
    return {
      localInstanceId: localId,
      staleAfterMs: STALE_AFTER_MS,
      generatedAt: new Date().toISOString(),
      instances,
    };
  }

  function broadcastPresence(source = 'local') {
    const payload = buildPresenceSnapshot();
    state.mainWindow?.webContents.send('runtime-presence-updated', {
      source,
      ...payload,
    });
  }

  function markRemoteCommandProcessed(commandId) {
    const key = safeString(commandId);
    if (!key) return;
    processedRemoteCommands.set(key, Date.now());
    if (processedRemoteCommands.size > 1000) {
      const now = Date.now();
      for (const [id, ts] of processedRemoteCommands.entries()) {
        if ((now - Number(ts || 0)) > REMOTE_COMMAND_RESULT_MAX_AGE_MS) {
          processedRemoteCommands.delete(id);
        }
      }
    }
  }

  function wasRemoteCommandProcessed(commandId) {
    const key = safeString(commandId);
    if (!key) return false;
    const ts = Number(processedRemoteCommands.get(key) || 0);
    if (!ts) return false;
    if ((Date.now() - ts) > REMOTE_COMMAND_RESULT_MAX_AGE_MS) {
      processedRemoteCommands.delete(key);
      return false;
    }
    return true;
  }

  function normalizeRemoteCommand(raw, fallbackId = '') {
    if (!raw || typeof raw !== 'object') return null;
    const commandId = safeString(raw.commandId || fallbackId);
    if (!commandId) return null;
    const createdAt = safeString(raw.createdAt) || new Date().toISOString();
    const action = safeString(raw.action || '').toLowerCase();
    if (!action) return null;
    return {
      commandId,
      createdAt,
      expiresAt: safeString(raw.expiresAt),
      sourceProject: safeString(raw.sourceProject),
      sourceLabel: safeString(raw.sourceLabel),
      targetProject: safeString(raw.targetProject),
      targetInstanceId: safeString(raw.targetInstanceId),
      action,
      payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
      results: raw.results && typeof raw.results === 'object' ? raw.results : {},
    };
  }

  function shouldExecuteRemoteCommand(command) {
    if (!command) return false;
    const localProject = ensureProjectId();
    const localInstance = ensureInstanceId();
    if (command.targetProject && command.targetProject !== localProject) return false;
    if (command.targetInstanceId && command.targetInstanceId !== localInstance) return false;
    if (command.expiresAt) {
      const expTs = Date.parse(command.expiresAt);
      if (Number.isFinite(expTs) && expTs < Date.now()) return false;
    }
    const existing = command.results?.[localInstance];
    const existingStatus = safeString(existing?.status).toLowerCase();
    if (existingStatus === 'done' || existingStatus === 'error' || existingStatus === 'ignored') return false;
    return true;
  }

  async function updateRemoteCommandResult(command, patch) {
    const supabase = state.supabase;
    if (!supabase || !command?.commandId) return { ok: false, error: 'Sin Supabase' };
    const key = `${REMOTE_COMMAND_KEY_PREFIX}${command.commandId}`;
    const localInstance = ensureInstanceId();
    const nowIso = new Date().toISOString();
    const nextResult = {
      status: safeString(patch?.status || 'done') || 'done',
      message: safeString(patch?.message || ''),
      updatedAt: nowIso,
      meta: patch?.meta && typeof patch.meta === 'object' ? patch.meta : {},
    };

    try {
      const { data, error } = await supabase
        .from('overlay_settings')
        .select('key,value')
        .eq('key', key)
        .maybeSingle();
      if (error) return { ok: false, error: error.message || 'No pude leer comando remoto' };

      const current = normalizeRemoteCommand(data?.value, command.commandId) || command;
      const merged = {
        ...current,
        results: {
          ...(current.results || {}),
          [localInstance]: nextResult,
        },
      };
      const row = { key, value: merged };
      const { error: upsertErr } = await supabase.from('overlay_settings').upsert(row, { onConflict: 'key' });
      if (upsertErr) return { ok: false, error: upsertErr.message || 'No pude actualizar resultado remoto' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async function executeRemoteCommand(command) {
    const action = safeString(command?.action).toLowerCase();
    const payload = command?.payload && typeof command.payload === 'object' ? command.payload : {};
    const modeRaw = safeString(payload.mode).toLowerCase();
    const mode = modeRaw === 'dev' ? 'dev' : (modeRaw === 'prod' ? 'prod' : null);

    if (action === 'kick.connect') {
      if (typeof connectKickBot !== 'function') return { ok: false, message: 'connectKickBot no disponible' };
      const res = await connectKickBot(mode || undefined);
      return {
        ok: !!res?.ok,
        message: res?.ok ? `Kick conectado${mode ? ` (${mode})` : ''}` : (res?.error || 'No se pudo conectar Kick'),
        meta: res && typeof res === 'object' ? res : {},
      };
    }
    if (action === 'kick.disconnect') {
      if (typeof disconnectKickBot !== 'function') return { ok: false, message: 'disconnectKickBot no disponible' };
      const res = await disconnectKickBot(mode || undefined, { cleanupRemote: true });
      return {
        ok: !!res?.ok,
        message: res?.ok ? `Kick desconectado${mode ? ` (${mode})` : ''}` : (res?.error || 'No se pudo desconectar Kick'),
        meta: res && typeof res === 'object' ? res : {},
      };
    }
    if (action === 'kick.reconnect') {
      if (typeof disconnectKickBot !== 'function' || typeof connectKickBot !== 'function') {
        return { ok: false, message: 'Funciones de reconnect Kick no disponibles' };
      }
      await disconnectKickBot(mode || undefined, { cleanupRemote: true }).catch(() => {});
      const res = await connectKickBot(mode || undefined);
      return {
        ok: !!res?.ok,
        message: res?.ok ? `Kick reconectado${mode ? ` (${mode})` : ''}` : (res?.error || 'No se pudo reconectar Kick'),
        meta: res && typeof res === 'object' ? res : {},
      };
    }
    if (action === 'runtime.presence.ping') {
      await runHeartbeat('remote-command').catch(() => {});
      return { ok: true, message: 'Heartbeat ejecutado', meta: {} };
    }
    if (action === 'command.health.reset') {
      if (typeof state.resetCommandHealth === 'function') state.resetCommandHealth();
      return { ok: true, message: 'Métricas de comandos reseteadas', meta: {} };
    }
    return { ok: false, message: `Acción no soportada: ${action}`, meta: {} };
  }

  async function processRemoteCommandRow(row) {
    const key = safeString(row?.key);
    const commandId = extractRemoteCommandIdFromKey(key);
    if (!commandId) return;
    if (wasRemoteCommandProcessed(commandId)) return;
    const command = normalizeRemoteCommand(row?.value, commandId);
    if (!command) return;
    if (!shouldExecuteRemoteCommand(command)) return;

    markRemoteCommandProcessed(commandId);
    await updateRemoteCommandResult(command, {
      status: 'running',
      message: 'Ejecutando comando remoto...',
      meta: { startedAt: new Date().toISOString() },
    }).catch(() => {});

    let execResult = null;
    try {
      execResult = await executeRemoteCommand(command);
    } catch (e) {
      execResult = { ok: false, message: e?.message || String(e), meta: {} };
    }
    await updateRemoteCommandResult(command, {
      status: execResult?.ok ? 'done' : 'error',
      message: safeString(execResult?.message || (execResult?.ok ? 'Comando ejecutado' : 'Fallo ejecutando comando')),
      meta: execResult?.meta && typeof execResult.meta === 'object' ? execResult.meta : {},
    }).catch(() => {});

    if (!execResult?.ok) {
      saveLog('warn', `[runtime-remote] ${command.action} fallo: ${execResult?.message || 'desconocido'}`);
    } else {
      saveLog('info', `[runtime-remote] ${command.action} ok`);
    }
  }

  async function pullRemoteCommandsFromSupabase(trigger = 'manual') {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin Supabase' };
    const { data, error } = await supabase
      .from('overlay_settings')
      .select('key,value')
      .ilike('key', `${REMOTE_COMMAND_KEY_PREFIX}%`)
      .limit(REMOTE_COMMAND_SCAN_LIMIT);
    if (error) return { ok: false, error: error.message || 'No pude leer comandos remotos' };
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const key = safeString(row?.key);
      const commandId = extractRemoteCommandIdFromKey(key);
      if (!commandId) continue;
      const command = normalizeRemoteCommand(row?.value, commandId);
      if (!command) continue;
      const createdTs = Date.parse(command.createdAt || '');
      if (Number.isFinite(createdTs) && (Date.now() - createdTs) > REMOTE_COMMAND_TTL_MS) continue;
      await processRemoteCommandRow(row).catch(() => {});
    }
    return { ok: true, trigger };
  }

  function buildLocalPresenceValue() {
    const cfg = loadConfig();
    const routing = resolveKickRouting(cfg);
    const mode = routing.mode === 'dev' ? 'dev' : 'prod';
    const activeChannel = safeString(routing.activeChannel);
    const hasBroadcasterToken = !!safeString(state.kickAccessToken);
    const hasBotToken = !!safeString(state.kickBotAccessToken);
    const queueLength = Array.isArray(state.queue) ? state.queue.length : 0;
    const requesterQueueLength = Array.isArray(state.spotifyRequesterQueue) ? state.spotifyRequesterQueue.length : 0;
    const activeRequesterNick = safeString(state.spotifyActiveRequester?.nick);
    const healthSnapshot = typeof state.getCommandHealthSnapshot === 'function'
      ? state.getCommandHealthSnapshot()
      : null;
    const healthTotals = healthSnapshot?.totals || {};
    const host = safeString(os.hostname());
    let user = '';
    try {
      user = safeString(os.userInfo?.().username);
    } catch {
      user = safeString(process.env.USERNAME || process.env.USER || '');
    }
    return {
      instanceId: ensureInstanceId(),
      project: ensureProjectId(),
      host,
      user,
      label: host && user ? `${host} (${user})` : (host || user || ensureInstanceId()),
      appVersion: safeString(app?.getVersion?.()),
      platform: `${process.platform || ''}`,
      arch: `${process.arch || ''}`,
      lastSeen: new Date().toISOString(),
      kick: {
        connected: !!state.kickPollTimer,
        mode,
        channel: activeChannel,
        hasBroadcasterToken,
        hasBotToken,
      },
      songrequest: {
        enabled: state.songRequestEnabled !== false,
        kickEnabled: state.songRequestKickEnabled !== false,
        rewardId: safeString(state.songRequestRewardId),
        queuePending: requesterQueueLength,
        activeRequesterNick,
      },
      overlays: {
        key: !!state.keyOverlayRunning,
        spotify: !!state.spotifyOverlayRunning,
        rl: !!state.rlOverlayRunning,
        teams: !!state.teamsOverlayRunning,
      },
      runtime: {
        queueProcessing: !!state.processing,
        queueLength,
        commandFailed: Number(healthTotals.failed || 0),
        commandTimeouts: Number(healthTotals.timeouts || 0),
      },
    };
  }

  async function pushLocalPresenceToSupabase(trigger = 'heartbeat') {
    const value = buildLocalPresenceValue();
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin Supabase' };
    const row = { key: localPresenceKey(), value };
    const { error } = await supabase.from('overlay_settings').upsert(row, { onConflict: 'key' });
    if (error) return { ok: false, error: error.message || 'No pude guardar presencia' };
    return { ok: true, trigger };
  }

  async function pullPresenceFromSupabase(trigger = 'manual') {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin Supabase' };
    const { data, error } = await supabase
      .from('overlay_settings')
      .select('key,value')
      .ilike('key', `${PRESENCE_KEY_PREFIX}%`)
      .limit(MAX_INSTANCES);
    if (error) return { ok: false, error: error.message || 'No pude leer presencia' };
    const seen = new Set();
    for (const row of (Array.isArray(data) ? data : [])) {
      const key = safeString(row?.key);
      const rowInstanceId = extractInstanceIdFromKey(key);
      if (!rowInstanceId) continue;
      const normalized = normalizePresenceValue(row?.value, rowInstanceId);
      if (!normalized) continue;
      normalized.instanceId = rowInstanceId;
      seen.add(rowInstanceId);
      upsertPresenceEntry(normalized, 'silent');
    }
    for (const existing of Array.from(presenceByInstance.keys())) {
      if (existing === ensureInstanceId()) continue;
      if (!seen.has(existing)) {
        presenceByInstance.delete(existing);
      }
    }
    lastFullRefreshAt = Date.now();
    broadcastPresence(`pull:${trigger}`);
    return { ok: true };
  }

  function stopRealtimePresence() {
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

  function ensureRealtimePresence() {
    const supabase = state.supabase;
    if (!supabase) {
      stopRealtimePresence();
      return;
    }
    const healthy = (
      realtimeChannel
      && realtimeSupabaseRef === supabase
      && (realtimeStatus === 'SUBSCRIBED' || realtimeStatus === 'JOINING')
    );
    if (healthy) return;
    stopRealtimePresence();
    realtimeSupabaseRef = supabase;
    realtimeStatus = 'JOINING';
    realtimeChannel = supabase
      .channel(`runtime-presence-${Date.now()}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'overlay_settings',
        },
        (payload) => {
          const eventType = safeString(payload?.eventType).toUpperCase();
          const row = payload?.new || payload?.record || payload?.old || payload?.old_record || null;
          const key = safeString(row?.key);
          if (isPresenceKey(key)) {
            const rowInstanceId = extractInstanceIdFromKey(key);
            if (!rowInstanceId) return;
            if (eventType === 'DELETE') {
              removePresenceEntry(rowInstanceId, 'supabase');
              return;
            }
            const normalized = normalizePresenceValue(row?.value, rowInstanceId);
            if (!normalized) return;
            normalized.instanceId = rowInstanceId;
            upsertPresenceEntry(normalized, 'supabase');
            return;
          }
          if (!isRemoteCommandKey(key)) return;
          if (eventType === 'DELETE') return;
          processRemoteCommandRow(row).catch(() => {});
        }
      )
      .subscribe((status) => {
        realtimeStatus = safeString(status).toUpperCase() || 'UNKNOWN';
        if (realtimeStatus === 'SUBSCRIBED') {
          pullPresenceFromSupabase('subscribed').catch(() => {});
          pullRemoteCommandsFromSupabase('subscribed').catch(() => {});
          return;
        }
        if (
          realtimeStatus === 'CHANNEL_ERROR'
          || realtimeStatus === 'TIMED_OUT'
          || realtimeStatus === 'CLOSED'
        ) {
          stopRealtimePresence();
          setTimeout(() => ensureRealtimePresence(), 1500);
        }
      });
  }

  async function runHeartbeat(trigger = 'heartbeat') {
    const localValue = buildLocalPresenceValue();
    upsertPresenceEntry(localValue, 'local');
    ensureRealtimePresence();
    const shouldFullRefresh = (Date.now() - lastFullRefreshAt) >= FULL_REFRESH_MS;
    if (shouldFullRefresh) {
      pullPresenceFromSupabase(trigger).catch(() => {});
    }
    const res = await pushLocalPresenceToSupabase(trigger).catch((e) => ({ ok: false, error: e?.message || String(e) }));
    if (!res.ok && trigger !== 'heartbeat') {
      saveLog('warn', `[runtime-presence] sync error: ${res.error || 'desconocido'}`);
    }
    return res;
  }

  function start() {
    ensureInstanceId();
    ensureProjectId();
    upsertPresenceEntry(buildLocalPresenceValue(), 'local');
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        runHeartbeat('interval').catch(() => {});
      }, HEARTBEAT_MS);
    }
    if (!fullRefreshTimer) {
      fullRefreshTimer = setInterval(() => {
        pullPresenceFromSupabase('interval').catch(() => {});
      }, FULL_REFRESH_MS);
    }
    if (!keepRealtimeTimer) {
      keepRealtimeTimer = setInterval(() => {
        ensureRealtimePresence();
      }, 4000);
    }
    if (!remoteCommandSweepTimer) {
      remoteCommandSweepTimer = setInterval(() => {
        pullRemoteCommandsFromSupabase('interval').catch(() => {});
      }, 6000);
    }
    runHeartbeat('start').catch(() => {});
    pullRemoteCommandsFromSupabase('start').catch(() => {});
  }

  function stop() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (fullRefreshTimer) clearInterval(fullRefreshTimer);
    if (keepRealtimeTimer) clearInterval(keepRealtimeTimer);
    if (remoteCommandSweepTimer) clearInterval(remoteCommandSweepTimer);
    heartbeatTimer = null;
    fullRefreshTimer = null;
    keepRealtimeTimer = null;
    remoteCommandSweepTimer = null;
    stopRealtimePresence();
  }

  function registerIpcHandlers() {
    ipcMain.handle('runtime-presence-get', async () => {
      upsertPresenceEntry(buildLocalPresenceValue(), 'silent');
      if (state.supabase) {
        await pullPresenceFromSupabase('ipc-get').catch(() => {});
      }
      return { ok: true, ...buildPresenceSnapshot() };
    });
    ipcMain.handle('runtime-presence-ping', async () => {
      const sync = await runHeartbeat('ipc-ping');
      return { ok: !!sync?.ok, error: sync?.error || null, ...buildPresenceSnapshot() };
    });
    ipcMain.handle('runtime-presence-meta', async () => ({
      ok: true,
      instanceId: ensureInstanceId(),
      projectId: ensureProjectId(),
    }));
    ipcMain.handle('runtime-remote-command-refresh', async () => {
      const res = await pullRemoteCommandsFromSupabase('ipc-refresh');
      return { ok: !!res?.ok, error: res?.error || null };
    });
  }

  return {
    start,
    stop,
    registerIpcHandlers,
  };
}

module.exports = { createRuntimePresenceService };
