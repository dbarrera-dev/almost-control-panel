// OBS WebSocket Service — Reusable OBS control via obs-websocket-js v5
const OBSWebSocket = require('obs-websocket-js').default;

function createObsService({ loadConfig, saveLog }) {
  let obs = null;
  let connected = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_DELAY = 30000;

  function log(msg) {
    try { saveLog('obs', msg); } catch {}
  }

  async function connect(address, password) {
    disconnect();
    obs = new OBSWebSocket();

    obs.on('ConnectionClosed', () => {
      connected = false;
      log('OBS desconectado');
      scheduleReconnect(address, password);
    });

    obs.on('ConnectionError', (err) => {
      connected = false;
      log('Error de conexión OBS: ' + (err?.message || err));
    });

    try {
      const connectObj = { rpcVersion: 1 };
      if (password) connectObj.authentication = password;
      await obs.connect(address, password || undefined, { rpcVersion: 1 });
      connected = true;
      reconnectAttempts = 0;
      log('Conectado a OBS');
      return { ok: true };
    } catch (err) {
      connected = false;
      log('No se pudo conectar a OBS: ' + (err?.message || err));
      scheduleReconnect(address, password);
      return { ok: false, error: err?.message || String(err) };
    }
  }

  function scheduleReconnect(address, password) {
    if (reconnectTimer) return;
    reconnectAttempts++;
    const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (!connected) await connect(address, password);
    }, delay);
  }

  function disconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectAttempts = 0;
    if (obs) {
      try { obs.disconnect(); } catch {}
      obs = null;
    }
    connected = false;
  }

  async function getAudioSources() {
    if (!connected || !obs) return [];
    try {
      const { inputs } = await obs.call('GetInputList');
      const audioSources = [];
      for (const input of inputs) {
        try {
          const { inputVolumeMul, inputVolumDb, inputMuted } = await obs.call('GetInputVolume', { inputName: input.inputName });
          audioSources.push({
            name: input.inputName,
            kind: input.inputKind,
            volume: inputVolumDb,
            muted: inputMuted
          });
        } catch {}
      }
      return audioSources;
    } catch (err) {
      log('Error al obtener fuentes: ' + (err?.message || err));
      return [];
    }
  }

  async function setSourceMute(sourceName, muted) {
    if (!connected || !obs) return { ok: false, error: 'No conectado a OBS' };
    try {
      await obs.call('SetInputMute', { inputName: sourceName, inputMuted: muted });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function getSourceMute(sourceName) {
    if (!connected || !obs) return { ok: false, error: 'No conectado a OBS' };
    try {
      const { inputMuted } = await obs.call('GetInputMute', { inputName: sourceName });
      return { ok: true, muted: inputMuted };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function setSourceVolume(sourceName, volumeDb) {
    if (!connected || !obs) return { ok: false, error: 'No conectado a OBS' };
    try {
      await obs.call('SetInputVolume', { inputName: sourceName, inputVolumeDb: volumeDb });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async function getScenes() {
    if (!connected || !obs) return [];
    try {
      const { scenes } = await obs.call('GetSceneList');
      return scenes.map(s => s.sceneName);
    } catch { return []; }
  }

  function isConnected() { return connected; }

  function getStatus() {
    return { connected, reconnectAttempts };
  }

  return {
    connect, disconnect, isConnected, getStatus,
    getAudioSources, setSourceMute, getSourceMute,
    setSourceVolume, getScenes
  };
}

module.exports = { createObsService };
