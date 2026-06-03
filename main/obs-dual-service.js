// OBS Dual Service — manage two OBS instances with scene sync
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const OBSWebSocket = require('obs-websocket-js').default;

function createObsDualService({ loadConfig, saveConfig, saveLog, getMainWindow }) {
  // ── State ────────────────────────────────────────────────────────
  const instances = {
    h: { obs: null, connected: false, currentScene: null, scenes: [], reconnectTimer: null, reconnectAttempts: 0, process: null },
    v: { obs: null, connected: false, currentScene: null, scenes: [], reconnectTimer: null, reconnectAttempts: 0, process: null },
  };

  let syncEnabled = true;
  let _syncing = false; // prevent feedback loops during programmatic scene switch

  const MAX_RECONNECT_DELAY = 30000;
  const SIDE_LABEL = { h: 'Horizontal', v: 'Vertical' };

  // ── Helpers ──────────────────────────────────────────────────────
  function log(msg) { try { saveLog('obs-dual', msg); } catch {} }

  function emit(channel, data) {
    try { getMainWindow()?.webContents.send(channel, data); } catch {}
  }

  function emitStatus() {
    emit('obs-dual-status', {
      h: { connected: instances.h.connected, scene: instances.h.currentScene, scenes: instances.h.scenes, reconnectAttempts: instances.h.reconnectAttempts },
      v: { connected: instances.v.connected, scene: instances.v.currentScene, scenes: instances.v.scenes, reconnectAttempts: instances.v.reconnectAttempts },
      syncEnabled,
    });
  }

  // ── Scene Sync ───────────────────────────────────────────────────
  function getMapping() {
    const cfg = loadConfig();
    return cfg.obsDualSceneMap || {};
  }

  function getReverseMapping() {
    const map = getMapping();
    const rev = {};
    for (const [k, v] of Object.entries(map)) rev[v] = k;
    return rev;
  }

  async function syncScene(sourceSide, sceneName) {
    if (!syncEnabled || _syncing) return;
    const targetSide = sourceSide === 'h' ? 'v' : 'h';
    const target = instances[targetSide];
    if (!target.connected || !target.obs) return;

    const map = sourceSide === 'h' ? getMapping() : getReverseMapping();
    const mappedScene = map[sceneName];
    if (!mappedScene) return;

    _syncing = true;
    try {
      await target.obs.call('SetCurrentProgramScene', { sceneName: mappedScene });
      target.currentScene = mappedScene;
      log(`Sync: ${SIDE_LABEL[sourceSide]} "${sceneName}" → ${SIDE_LABEL[targetSide]} "${mappedScene}"`);
      emitStatus();
    } catch (err) {
      log(`Error sync escena ${SIDE_LABEL[targetSide]}: ${err?.message || err}`);
    } finally {
      // Small delay before allowing another sync to prevent rapid bounce
      setTimeout(() => { _syncing = false; }, 300);
    }
  }

  // ── Connection ───────────────────────────────────────────────────
  async function refreshScenes(side) {
    const inst = instances[side];
    if (!inst.connected || !inst.obs) return;
    try {
      const { scenes } = await inst.obs.call('GetSceneList');
      inst.scenes = scenes.map(s => s.sceneName).reverse(); // OBS returns bottom-first
    } catch { inst.scenes = []; }
  }

  async function refreshCurrentScene(side) {
    const inst = instances[side];
    if (!inst.connected || !inst.obs) return;
    try {
      const { currentProgramSceneName } = await inst.obs.call('GetCurrentProgramScene');
      inst.currentScene = currentProgramSceneName;
    } catch {}
  }

  async function connectSide(side, address, password) {
    const inst = instances[side];
    disconnectSide(side, false); // clean previous

    inst.obs = new OBSWebSocket();

    inst.obs.on('ConnectionClosed', () => {
      inst.connected = false;
      log(`OBS ${SIDE_LABEL[side]} desconectado`);
      emitStatus();
      scheduleReconnect(side, address, password);
    });

    inst.obs.on('ConnectionError', (err) => {
      inst.connected = false;
      log(`OBS ${SIDE_LABEL[side]} error: ${err?.message || err}`);
      emitStatus();
    });

    inst.obs.on('CurrentProgramSceneChanged', async ({ sceneName }) => {
      const prev = inst.currentScene;
      inst.currentScene = sceneName;
      emitStatus();
      emit('obs-dual-scene-changed', { side, scene: sceneName, prev });
      if (sceneName !== prev) await syncScene(side, sceneName);
    });

    inst.obs.on('SceneListChanged', async () => {
      await refreshScenes(side);
      emitStatus();
    });

    inst.obs.on('StreamStateChanged', ({ outputActive, outputState }) => {
      emit('obs-dual-stream-state', { side, active: outputActive, state: outputState });
    });

    inst.obs.on('RecordStateChanged', ({ outputActive, outputState }) => {
      emit('obs-dual-record-state', { side, active: outputActive, state: outputState });
    });

    try {
      await inst.obs.connect(address, password || undefined, { rpcVersion: 1 });
      inst.connected = true;
      inst.reconnectAttempts = 0;
      log(`OBS ${SIDE_LABEL[side]} conectado en ${address}`);

      await refreshScenes(side);
      await refreshCurrentScene(side);
      emitStatus();
      return { ok: true };
    } catch (err) {
      inst.connected = false;
      log(`OBS ${SIDE_LABEL[side]} no se pudo conectar: ${err?.message || err}`);
      emitStatus();
      scheduleReconnect(side, address, password);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  function scheduleReconnect(side, address, password) {
    const inst = instances[side];
    if (inst.reconnectTimer) return;
    inst.reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(1.5, inst.reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    log(`OBS ${SIDE_LABEL[side]}: reintentando en ${Math.round(delay / 1000)}s (intento ${inst.reconnectAttempts})`);
    inst.reconnectTimer = setTimeout(async () => {
      inst.reconnectTimer = null;
      if (!inst.connected) await connectSide(side, address, password);
    }, delay);
  }

  function disconnectSide(side, permanent = true) {
    const inst = instances[side];
    if (inst.reconnectTimer) { clearTimeout(inst.reconnectTimer); inst.reconnectTimer = null; }
    if (permanent) inst.reconnectAttempts = 0;
    if (inst.obs) {
      try { inst.obs.disconnect(); } catch {}
      inst.obs = null;
    }
    inst.connected = false;
    if (permanent) emitStatus();
  }

  // ── Process Launch ───────────────────────────────────────────────
  function findObsExecutable(customPath) {
    if (customPath && fs.existsSync(customPath)) return customPath;
    const candidates = [
      'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe',
      'C:\\Program Files (x86)\\obs-studio\\bin\\64bit\\obs64.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'obs-studio', 'bin', '64bit', 'obs64.exe'),
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    return null;
  }

  function launchObs(side) {
    const cfg = loadConfig();
    const sideKey = side === 'h' ? 'H' : 'V';
    const obsPath = findObsExecutable(cfg[`obsDual${sideKey}ExePath`]);
    if (!obsPath) return { ok: false, error: 'No se encontró OBS. Configurá la ruta en Ajustes.' };

    const inst = instances[side];
    if (inst.process && !inst.process.killed) {
      try { inst.process.kill(); } catch {}
    }

    const args = ['--multi'];
    const profile = cfg[`obsDual${sideKey}Profile`];
    const collection = cfg[`obsDual${sideKey}Collection`];
    if (profile) args.push('--profile', profile);
    if (collection) args.push('--collection', collection);
    args.push('--minimize-to-tray');

    try {
      const proc = spawn(obsPath, args, {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(obsPath),
      });
      proc.unref();
      inst.process = proc;
      log(`OBS ${SIDE_LABEL[side]} lanzado (PID: ${proc.pid}), perfil: "${profile || 'default'}", colección: "${collection || 'default'}"`);
      return { ok: true, pid: proc.pid };
    } catch (err) {
      log(`Error al lanzar OBS ${SIDE_LABEL[side]}: ${err?.message || err}`);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // ── Scene Control ─────────────────────────────────────────────────
  async function setScene(side, sceneName, propagate = true) {
    const inst = instances[side];
    if (!inst.connected || !inst.obs) return { ok: false, error: `OBS ${SIDE_LABEL[side]} no conectado` };
    try {
      _syncing = !propagate; // suppress sync if not propagating
      await inst.obs.call('SetCurrentProgramScene', { sceneName });
      inst.currentScene = sceneName;
      emitStatus();
      if (propagate && syncEnabled) await syncScene(side, sceneName);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    } finally {
      if (!propagate) setTimeout(() => { _syncing = false; }, 300);
    }
  }

  async function getScenes(side) {
    const inst = instances[side];
    if (!inst.connected || !inst.obs) return { ok: false, scenes: [], error: `OBS ${SIDE_LABEL[side]} no conectado` };
    await refreshScenes(side);
    return { ok: true, scenes: inst.scenes };
  }

  // ── Streaming & Recording ─────────────────────────────────────────
  async function getStreamRecordStatus(side) {
    const inst = instances[side];
    if (!inst.connected || !inst.obs) return { ok: false };
    try {
      const [streamRes, recordRes] = await Promise.all([
        inst.obs.call('GetStreamStatus').catch(() => null),
        inst.obs.call('GetRecordStatus').catch(() => null),
      ]);
      return {
        ok: true,
        streaming: streamRes?.outputActive || false,
        recording: recordRes?.outputActive || false,
      };
    } catch { return { ok: false }; }
  }

  async function startStream(side) {
    const inst = instances[side];
    if (!inst.connected || !inst.obs) return { ok: false, error: `OBS ${SIDE_LABEL[side]} no conectado` };
    try { await inst.obs.call('StartStream'); return { ok: true }; }
    catch (err) { return { ok: false, error: err?.message || String(err) }; }
  }

  async function stopStream(side) {
    const inst = instances[side];
    if (!inst.connected || !inst.obs) return { ok: false, error: `OBS ${SIDE_LABEL[side]} no conectado` };
    try { await inst.obs.call('StopStream'); return { ok: true }; }
    catch (err) { return { ok: false, error: err?.message || String(err) }; }
  }

  async function startRecord(side) {
    const inst = instances[side];
    if (!inst.connected || !inst.obs) return { ok: false, error: `OBS ${SIDE_LABEL[side]} no conectado` };
    try { await inst.obs.call('StartRecord'); return { ok: true }; }
    catch (err) { return { ok: false, error: err?.message || String(err) }; }
  }

  async function stopRecord(side) {
    const inst = instances[side];
    if (!inst.connected || !inst.obs) return { ok: false, error: `OBS ${SIDE_LABEL[side]} no conectado` };
    try { await inst.obs.call('StopRecord'); return { ok: true }; }
    catch (err) { return { ok: false, error: err?.message || String(err) }; }
  }

  // ── Public API ───────────────────────────────────────────────────
  function getStatus() {
    return {
      h: { connected: instances.h.connected, scene: instances.h.currentScene, scenes: instances.h.scenes, reconnectAttempts: instances.h.reconnectAttempts },
      v: { connected: instances.v.connected, scene: instances.v.currentScene, scenes: instances.v.scenes, reconnectAttempts: instances.v.reconnectAttempts },
      syncEnabled,
    };
  }

  function setSyncEnabled(val) {
    syncEnabled = !!val;
    emitStatus();
  }

  function destroy() {
    disconnectSide('h');
    disconnectSide('v');
  }

  return {
    connectSide, disconnectSide, launchObs,
    setScene, getScenes, getStatus,
    getStreamRecordStatus, startStream, stopStream, startRecord, stopRecord,
    setSyncEnabled, getSyncEnabled: () => syncEnabled,
    destroy,
  };
}

module.exports = { createObsDualService };
