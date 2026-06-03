// OBS Dual Remote Service — Supabase Realtime bridge + global hotkeys
const { globalShortcut } = require('electron');

function createObsDualRemoteService({ getSupabase, obsDualService, loadConfig, saveLog, getMainWindow }) {
  // ── State ─────────────────────────────────────────────────────
  let channel       = null;
  let subscribed    = false;
  let mode          = 'streaming'; // 'streaming' | 'gaming'
  let roomId        = null;
  let _heartbeatTimer  = null;
  let _announceTimer   = null;
  let _reconnectTimer  = null;
  let _reconnectAttempts = 0;
  let _registeredHotkeys = []; // list of registered key strings
  let _lastCfg      = null;    // store last start config for reconnect

  const MAX_RECONNECT_DELAY = 30000;

  // ── Logging & IPC emit ────────────────────────────────────────
  function log(msg) { try { saveLog('obs-remote', msg); } catch {} }
  function emit(ch, data) { try { getMainWindow()?.webContents.send(ch, data); } catch {} }
  function emitStatus() { emit('obs-dual-remote-status', getStatus()); }

  function getStatus() {
    return { subscribed, mode, roomId, registeredHotkeys: [..._registeredHotkeys] };
  }

  // ── Channel ───────────────────────────────────────────────────
  async function start(cfg) {
    _lastCfg = cfg;
    mode     = cfg.mode    || 'streaming';
    roomId   = cfg.roomId  || '';

    if (!roomId) {
      return { ok: false, error: 'Room ID vacío. Usá tu canal de Kick como Room ID.' };
    }

    await _teardownChannel(); // clean previous without resetting reconnect state

    const supabase = getSupabase();
    if (!supabase) {
      log('Remote: Supabase no disponible. Conectá el bot primero.');
      return { ok: false, error: 'Supabase no disponible. Conectá el bot primero para inicializar la conexión.' };
    }

    const channelName = `obs-remote-${roomId}`;
    log(`Remote: conectando al canal "${channelName}" (modo: ${mode})`);

    channel = supabase.channel(channelName, {
      config: { broadcast: { self: false, ack: false } },
    });

    // ── Incoming messages ──
    channel.on('broadcast', { event: 'cmd' }, ({ payload }) => {
      _handleCommand(payload);
    });

    channel.on('broadcast', { event: 'announce' }, ({ payload }) => {
      if (mode === 'gaming') {
        emit('obs-dual-remote-announce', payload);
      }
    });

    channel.on('broadcast', { event: 'heartbeat' }, ({ payload }) => {
      emit('obs-dual-remote-heartbeat', { ...payload, ts: Date.now() });
    });

    // ── Subscribe ──
    channel.subscribe(async (status, err) => {
      if (status === 'SUBSCRIBED') {
        subscribed = true;
        _reconnectAttempts = 0;
        log(`Remote: suscrito a "${channelName}"`);
        emitStatus();

        if (mode === 'streaming') _startAnnouncing();
        _startHeartbeat();

        // On gaming mode: immediately request the current state from streaming PC
        if (mode === 'gaming') {
          setTimeout(() => _broadcast('cmd', { type: 'get-state', ts: Date.now() }), 500);
        }

      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        subscribed = false;
        log(`Remote: error en canal (${status}): ${err?.message || err || 'sin detalle'}`);
        emitStatus();
        _scheduleReconnect();

      } else if (status === 'CLOSED') {
        subscribed = false;
        log('Remote: canal cerrado');
        emitStatus();
      }
    });

    return { ok: true };
  }

  async function stop() {
    _lastCfg = null;
    _reconnectAttempts = 0;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    await _teardownChannel();
    clearHotkeys();
    emitStatus();
  }

  async function _teardownChannel() {
    _stopHeartbeat();
    _stopAnnouncing();
    if (channel) {
      try { await channel.unsubscribe(); } catch {}
      channel = null;
    }
    subscribed = false;
  }

  function _scheduleReconnect() {
    if (_reconnectTimer || !_lastCfg) return;
    _reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(1.5, _reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    log(`Remote: reintentando en ${Math.round(delay / 1000)}s (intento ${_reconnectAttempts})`);
    emit('obs-dual-remote-reconnecting', { attempt: _reconnectAttempts, delayMs: delay });
    _reconnectTimer = setTimeout(() => {
      _reconnectTimer = null;
      if (!subscribed && _lastCfg) start(_lastCfg).catch(() => {});
    }, delay);
  }

  // ── Command handling (Streaming PC) ──────────────────────────
  async function _handleCommand(payload) {
    if (!payload?.type) return;

    if (mode === 'streaming') {
      log(`Remote: comando recibido → ${payload.type} side=${payload.side || '-'} scene="${payload.scene || '-'}"`);

      if (payload.type === 'set-scene') {
        const { side, scene } = payload;
        if (!scene) return;

        if (side === 'h' || side === 'both') {
          await obsDualService.setScene('h', scene, side !== 'h').catch(() => {});
        }
        if (side === 'v') {
          await obsDualService.setScene('v', scene, true).catch(() => {});
        }
        // After applying, announce updated state back to gaming PCs
        setTimeout(() => _broadcastAnnounce(), 200);
      }

      if (payload.type === 'get-state') {
        _broadcastAnnounce();
      }
    }

    // Both modes receive ack
    emit('obs-dual-remote-cmd-received', payload);
  }

  // ── Broadcasting ──────────────────────────────────────────────
  async function _broadcast(event, payload) {
    if (!channel || !subscribed) return false;
    try {
      await channel.send({ type: 'broadcast', event, payload });
      return true;
    } catch (err) {
      log(`Remote: error al broadcast (${event}): ${err?.message || err}`);
      return false;
    }
  }

  function _broadcastAnnounce() {
    const status = obsDualService.getStatus();
    _broadcast('announce', {
      h: { scenes: status.h.scenes, current: status.h.scene, connected: status.h.connected },
      v: { scenes: status.v.scenes, current: status.v.scene, connected: status.v.connected },
      syncEnabled: status.syncEnabled,
      ts: Date.now(),
    });
  }

  function _startAnnouncing() {
    _stopAnnouncing();
    _broadcastAnnounce(); // immediate
    _announceTimer = setInterval(_broadcastAnnounce, 8000);
  }

  function _stopAnnouncing() {
    if (_announceTimer) { clearInterval(_announceTimer); _announceTimer = null; }
  }

  function _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatTimer = setInterval(() => {
      _broadcast('heartbeat', { role: mode, ts: Date.now() });
    }, 20000);
  }

  function _stopHeartbeat() {
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  }

  // ── Scene commands (Gaming PC → sends) ───────────────────────
  async function sendSetScene(side, scene) {
    const ok = await _broadcast('cmd', { type: 'set-scene', side, scene, ts: Date.now() });
    if (!ok) log(`Remote: no se pudo enviar set-scene (desconectado)`);
    return { ok };
  }

  async function sendGetState() {
    return { ok: await _broadcast('cmd', { type: 'get-state', ts: Date.now() }) };
  }

  // ── Global Hotkeys ────────────────────────────────────────────
  function registerHotkeys(hotkeys) {
    clearHotkeys();
    if (!Array.isArray(hotkeys) || !hotkeys.length) return { ok: true, registered: 0, errors: [] };

    let registered = 0;
    const errors   = [];

    for (const hk of hotkeys) {
      if (!hk.key || !hk.scene) continue;
      try {
        const success = globalShortcut.register(hk.key, () => {
          const side = hk.side || 'both';
          if (mode === 'gaming' && subscribed) {
            sendSetScene(side, hk.scene);
            emit('obs-dual-remote-hotkey-fired', { scene: hk.scene, side, key: hk.key });
          } else if (mode === 'streaming') {
            // Direct apply on streaming PC (no Supabase needed)
            if (side === 'h' || side === 'both') obsDualService.setScene('h', hk.scene, side !== 'h').catch(() => {});
            if (side === 'v') obsDualService.setScene('v', hk.scene, true).catch(() => {});
            emit('obs-dual-remote-hotkey-fired', { scene: hk.scene, side, key: hk.key });
          }
        });

        if (success) {
          _registeredHotkeys.push(hk.key);
          registered++;
        } else {
          errors.push({ key: hk.key, reason: 'en_uso' });
          log(`Remote: atajo "${hk.key}" ya está en uso por otra aplicación`);
        }
      } catch (err) {
        errors.push({ key: hk.key, reason: err?.message || String(err) });
        log(`Remote: error al registrar "${hk.key}": ${err?.message || err}`);
      }
    }

    log(`Remote: ${registered}/${hotkeys.length} atajos registrados`);
    emitStatus();
    return { ok: true, registered, errors };
  }

  function clearHotkeys() {
    for (const key of _registeredHotkeys) {
      try { globalShortcut.unregister(key); } catch {}
    }
    _registeredHotkeys = [];
  }

  // ── Public API ────────────────────────────────────────────────
  function destroy() {
    stop().catch(() => {});
  }

  return {
    start, stop,
    sendSetScene, sendGetState,
    registerHotkeys, clearHotkeys,
    getStatus, destroy,
    get mode() { return mode; },
    set mode(v) { mode = v; },
    get subscribed() { return subscribed; },
  };
}

module.exports = { createObsDualRemoteService };
