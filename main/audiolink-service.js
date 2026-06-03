// Audio Link Service — Voicemeeter control + VBAN monitoring
// Direction: PC Streaming (emitter) → PC Gaming (receiver)
// Music plays on PC Streaming, sent via VBAN so gamer can hear it
// without it going through the capture card

let Voicemeeter = null;
let VBANServer = null;

try { ({ Voicemeeter } = require('voicemeeter-connector')); } catch {}
try { ({ VBANServer } = require('vban')); } catch {}

function createAudiolinkService({ loadConfig, saveConfig, saveLog, state }) {
  let vm = null;
  let vmConnected = false;
  let vmType = null;
  let vbanServer = null;
  let vbanListening = false;
  let levelsInterval = null;
  let statusInterval = null;
  let lastLevels = { left: 0, right: 0 };
  let vbanStats = { packetsReceived: 0, packetsLost: 0, lastPacketTime: 0, streamDetected: false };

  function log(msg) {
    try { saveLog('audiolink', msg); } catch {}
  }

  // ── Voicemeeter ────────────────────────────────────────────────

  async function connectVoicemeeter() {
    if (!Voicemeeter) {
      log('voicemeeter-connector no disponible');
      return { ok: false, error: 'Voicemeeter no está instalado o el módulo no se cargó.' };
    }
    try {
      vm = await Voicemeeter.init();
      vm.connect();
      vmConnected = true;

      // Detect version
      const type = vm.voicemeeterType;
      if (type === 1) vmType = 'Voicemeeter';
      else if (type === 2) vmType = 'Banana';
      else if (type === 3) vmType = 'Potato';
      else vmType = 'Desconocido';

      log(`Voicemeeter conectado (${vmType})`);
      return { ok: true, type: vmType };
    } catch (err) {
      vmConnected = false;
      log('Error conectando Voicemeeter: ' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    }
  }

  function disconnectVoicemeeter() {
    stopLevelsPolling();
    if (vm) {
      try { vm.disconnect(); } catch {}
      vm = null;
    }
    vmConnected = false;
    vmType = null;
    log('Voicemeeter desconectado');
  }

  function getVmStrips() {
    if (!vmConnected || !vm) return [];
    try {
      const strips = [];
      // Banana: 3 hardware + 2 virtual = 5 strips
      // Potato: 5 hardware + 3 virtual = 8 strips
      const count = vmType === 'Potato' ? 8 : vmType === 'Banana' ? 5 : 3;
      for (let i = 0; i < count; i++) {
        try {
          const label = vm.getStripParameter(i, 'Label') || `Strip ${i}`;
          const gain = vm.getStripParameter(i, 'Gain');
          const mute = vm.getStripParameter(i, 'Mute');
          strips.push({ index: i, label: String(label), gain, mute: mute === 1 });
        } catch {}
      }
      return strips;
    } catch { return []; }
  }

  function getVmBuses() {
    if (!vmConnected || !vm) return [];
    try {
      const buses = [];
      const count = vmType === 'Potato' ? 8 : vmType === 'Banana' ? 5 : 3;
      for (let i = 0; i < count; i++) {
        try {
          const label = vm.getBusParameter(i, 'Label') || `Bus ${i}`;
          const gain = vm.getBusParameter(i, 'Gain');
          const mute = vm.getBusParameter(i, 'Mute');
          buses.push({ index: i, label: String(label), gain, mute: mute === 1 });
        } catch {}
      }
      return buses;
    } catch { return []; }
  }

  // ── VBAN Control via Voicemeeter ──────────────────────────────

  function configureVbanOutstream(opts) {
    if (!vmConnected || !vm) return { ok: false, error: 'Voicemeeter no conectado' };
    try {
      const idx = opts.index ?? 0;
      const prefix = `vban.outstream[${idx}]`;
      if (opts.name) vm.setParameter(prefix + '.name', opts.name);
      if (opts.ip) vm.setParameter(prefix + '.ip', opts.ip);
      if (opts.port) vm.setParameter(prefix + '.port', opts.port);
      if (opts.sr) vm.setParameter(prefix + '.sr', opts.sr);
      if (opts.channel != null) vm.setParameter(prefix + '.channel', opts.channel);
      if (opts.bit != null) vm.setParameter(prefix + '.bit', opts.bit);
      if (opts.quality != null) vm.setParameter(prefix + '.quality', opts.quality);
      if (opts.on != null) vm.setParameter(prefix + '.on', opts.on ? 1 : 0);
      log(`VBAN outstream[${idx}] configurado: ${JSON.stringify(opts)}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  function configureVbanInstream(opts) {
    if (!vmConnected || !vm) return { ok: false, error: 'Voicemeeter no conectado' };
    try {
      const idx = opts.index ?? 0;
      const prefix = `vban.instream[${idx}]`;
      if (opts.name) vm.setParameter(prefix + '.name', opts.name);
      if (opts.ip) vm.setParameter(prefix + '.ip', opts.ip);
      if (opts.port) vm.setParameter(prefix + '.port', opts.port);
      if (opts.sr) vm.setParameter(prefix + '.sr', opts.sr);
      if (opts.channel != null) vm.setParameter(prefix + '.channel', opts.channel);
      if (opts.bit != null) vm.setParameter(prefix + '.bit', opts.bit);
      if (opts.quality != null) vm.setParameter(prefix + '.quality', opts.quality);
      if (opts.on != null) vm.setParameter(prefix + '.on', opts.on ? 1 : 0);
      log(`VBAN instream[${idx}] configurado: ${JSON.stringify(opts)}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  function toggleVbanStream(mode, index, on) {
    if (!vmConnected || !vm) return { ok: false, error: 'Voicemeeter no conectado' };
    try {
      const prefix = mode === 'emitter' ? `vban.outstream[${index}]` : `vban.instream[${index}]`;
      vm.setParameter(prefix + '.on', on ? 1 : 0);
      log(`VBAN ${mode} stream[${index}] ${on ? 'activado' : 'desactivado'}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // Route a strip to a specific bus (e.g., route music strip to Bus B1)
  function routeStripToBus(stripIndex, busName, enabled) {
    if (!vmConnected || !vm) return { ok: false, error: 'Voicemeeter no conectado' };
    try {
      vm.setStripParameter(stripIndex, busName, enabled ? 1 : 0);
      log(`Strip ${stripIndex} → ${busName}: ${enabled ? 'ON' : 'OFF'}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  // ── Levels ────────────────────────────────────────────────────

  function startLevelsPolling(busIndex) {
    stopLevelsPolling();
    levelsInterval = setInterval(() => {
      if (!vmConnected || !vm) return;
      try {
        vm.isParametersDirty();
        const left = vm.getBusLevel(0, busIndex * 8);
        const right = vm.getBusLevel(0, busIndex * 8 + 1);
        lastLevels = { left, right };
      } catch {}
    }, 50);
  }

  function stopLevelsPolling() {
    if (levelsInterval) { clearInterval(levelsInterval); levelsInterval = null; }
  }

  function getLevels() { return lastLevels; }

  // ── VBAN Monitor (npm vban package) ───────────────────────────

  function startVbanMonitor(port) {
    stopVbanMonitor();
    if (!VBANServer) {
      log('Módulo VBAN no disponible');
      return { ok: false, error: 'Módulo VBAN no cargado' };
    }
    try {
      vbanServer = new VBANServer({
        application: {
          applicationName: 'Almost Control',
          manufacturerName: 'Almost98',
          deviceName: 'AudioLink Monitor'
        }
      });

      vbanServer.on('error', (err) => {
        log('Error VBAN monitor: ' + (err?.message || err));
      });

      vbanServer.on('message', (packet) => {
        vbanStats.packetsReceived++;
        vbanStats.lastPacketTime = Date.now();
        if (packet.streamName) vbanStats.streamDetected = true;
      });

      vbanServer.on('listening', () => {
        const addr = vbanServer.address();
        log(`VBAN monitor escuchando en ${addr.address}:${addr.port}`);
        vbanListening = true;
      });

      vbanServer.bind(port || 6980);
      return { ok: true };
    } catch (err) {
      log('Error iniciando VBAN monitor: ' + (err?.message || err));
      return { ok: false, error: err?.message || String(err) };
    }
  }

  function stopVbanMonitor() {
    if (vbanServer) {
      try { vbanServer.close(); } catch {}
      vbanServer = null;
    }
    vbanListening = false;
    vbanStats = { packetsReceived: 0, packetsLost: 0, lastPacketTime: 0, streamDetected: false };
  }

  function getVbanStats() {
    const now = Date.now();
    const timeSincePacket = vbanStats.lastPacketTime ? now - vbanStats.lastPacketTime : -1;
    return {
      ...vbanStats,
      listening: vbanListening,
      active: timeSincePacket >= 0 && timeSincePacket < 3000,
      latencyMs: timeSincePacket >= 0 ? timeSincePacket : null
    };
  }

  // ── Full Setup ────────────────────────────────────────────────

  async function applyProfile(config) {
    const mode = config.audiolinkMode || 'emitter';

    if (!vmConnected) {
      const res = await connectVoicemeeter();
      if (!res.ok) return res;
    }

    if (mode === 'emitter') {
      // PC Streaming: configure VBAN outstream to send music
      configureVbanOutstream({
        index: config.audiolinkVbanIndex ?? 0,
        name: config.audiolinkStreamName || 'MUSIC_STREAM',
        ip: config.audiolinkTargetIp || '192.168.1.100',
        port: config.audiolinkPort || 6980,
        sr: config.audiolinkSampleRate || 48000,
        channel: (config.audiolinkChannels || 2) - 1,
        bit: 1, // PCM 16-bit
        quality: 4,
        on: config.audiolinkSendEnabled ?? false
      });
      log('Perfil emisor aplicado');
    } else {
      // PC Gaming: configure VBAN instream to receive music
      configureVbanInstream({
        index: config.audiolinkVbanIndex ?? 0,
        name: config.audiolinkStreamName || 'MUSIC_STREAM',
        ip: config.audiolinkSourceIp || '192.168.1.50',
        port: config.audiolinkPort || 6980,
        sr: config.audiolinkSampleRate || 48000,
        channel: (config.audiolinkChannels || 2) - 1,
        bit: 1,
        quality: 4,
        on: true
      });
      // Start VBAN monitor for stats
      startVbanMonitor(config.audiolinkPort || 6980);
      log('Perfil receptor aplicado');
    }

    return { ok: true };
  }

  // ── Status ────────────────────────────────────────────────────

  function getFullStatus() {
    return {
      voicemeeter: {
        available: !!Voicemeeter,
        connected: vmConnected,
        type: vmType
      },
      vban: {
        available: !!VBANServer,
        ...getVbanStats()
      },
      levels: lastLevels
    };
  }

  // ── Cleanup ───────────────────────────────────────────────────

  function destroy() {
    stopLevelsPolling();
    stopVbanMonitor();
    disconnectVoicemeeter();
    log('Audio Link service destruido');
  }

  return {
    connectVoicemeeter, disconnectVoicemeeter,
    getVmStrips, getVmBuses,
    configureVbanOutstream, configureVbanInstream,
    toggleVbanStream, routeStripToBus,
    startLevelsPolling, stopLevelsPolling, getLevels,
    startVbanMonitor, stopVbanMonitor, getVbanStats,
    applyProfile, getFullStatus, destroy,
    isVmConnected: () => vmConnected,
    getVmType: () => vmType
  };
}

module.exports = { createAudiolinkService };
