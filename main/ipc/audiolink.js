// IPC handlers for Audio Link (VBAN) module
const os = require('os');

function registerAudiolinkIpc({ ipcMain, loadConfig, saveConfig, saveLog, audiolinkService, obsService, state }) {

  // ── Local IP Detection ─────────────────────────────────────────

  ipcMain.handle('audiolink-get-local-ip', async () => {
    try {
      const nets = os.networkInterfaces();
      const results = [];
      for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
          if (net.family === 'IPv4' && !net.internal) {
            results.push({ name, address: net.address });
          }
        }
      }
      return { ok: true, interfaces: results };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── Status ─────────────────────────────────────────────────────

  ipcMain.handle('audiolink-get-status', async () => {
    try {
      const alStatus = audiolinkService.getFullStatus();
      const obsStatus = obsService.getStatus();
      const cfg = loadConfig();
      return {
        ok: true,
        audiolink: alStatus,
        obs: obsStatus,
        config: {
          enabled: cfg.audiolinkEnabled,
          mode: cfg.audiolinkMode,
          streamName: cfg.audiolinkStreamName,
          sampleRate: cfg.audiolinkSampleRate,
          targetIp: cfg.audiolinkTargetIp,
          sourceIp: cfg.audiolinkSourceIp,
          port: cfg.audiolinkPort,
          sendEnabled: cfg.audiolinkSendEnabled,
          monitorEnabled: cfg.audiolinkMonitorEnabled,
          obsEnabled: cfg.audiolinkObsEnabled,
          obsSourceName: cfg.audiolinkObsSourceName,
          platformRules: cfg.audiolinkPlatformRules || {}
        }
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── Config ─────────────────────────────────────────────────────

  ipcMain.handle('audiolink-get-config', async () => {
    const cfg = loadConfig();
    return {
      ok: true,
      audiolinkEnabled:       cfg.audiolinkEnabled ?? false,
      audiolinkMode:          cfg.audiolinkMode ?? 'emitter',
      audiolinkStreamName:    cfg.audiolinkStreamName ?? 'MUSIC_STREAM',
      audiolinkSampleRate:    cfg.audiolinkSampleRate ?? 48000,
      audiolinkChannels:      cfg.audiolinkChannels ?? 2,
      audiolinkPort:          cfg.audiolinkPort ?? 6980,
      audiolinkVbanIndex:     cfg.audiolinkVbanIndex ?? 0,
      audiolinkTargetIp:      cfg.audiolinkTargetIp ?? '192.168.1.100',
      audiolinkSourceIp:      cfg.audiolinkSourceIp ?? '192.168.1.50',
      audiolinkSendEnabled:   cfg.audiolinkSendEnabled ?? false,
      audiolinkMonitorEnabled: cfg.audiolinkMonitorEnabled ?? false,
      audiolinkObsEnabled:    cfg.audiolinkObsEnabled ?? false,
      audiolinkObsAddress:    cfg.audiolinkObsAddress ?? 'ws://127.0.0.1:4455',
      audiolinkObsPassword:   cfg.audiolinkObsPassword ?? '',
      audiolinkObsSourceName: cfg.audiolinkObsSourceName ?? 'Music VBAN',
      audiolinkPlatformRules: cfg.audiolinkPlatformRules ?? {
        kick: { includeMusic: true }, tiktok: { includeMusic: true },
        youtube: { includeMusic: true }
      }
    };
  });

  ipcMain.handle('audiolink-save-config', async (_, data) => {
    try {
      const cfg = loadConfig();
      const keys = [
        'audiolinkEnabled', 'audiolinkMode', 'audiolinkStreamName',
        'audiolinkSampleRate', 'audiolinkChannels', 'audiolinkPort',
        'audiolinkVbanIndex', 'audiolinkTargetIp', 'audiolinkSourceIp',
        'audiolinkSendEnabled', 'audiolinkMonitorEnabled',
        'audiolinkObsEnabled', 'audiolinkObsAddress', 'audiolinkObsPassword',
        'audiolinkObsSourceName', 'audiolinkPlatformRules'
      ];
      for (const k of keys) {
        if (data[k] !== undefined) cfg[k] = data[k];
      }
      saveConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── Voicemeeter ────────────────────────────────────────────────

  ipcMain.handle('audiolink-vm-connect', async () => {
    return await audiolinkService.connectVoicemeeter();
  });

  ipcMain.handle('audiolink-vm-disconnect', async () => {
    audiolinkService.disconnectVoicemeeter();
    return { ok: true };
  });

  ipcMain.handle('audiolink-vm-strips', async () => {
    return { ok: true, strips: audiolinkService.getVmStrips() };
  });

  ipcMain.handle('audiolink-vm-buses', async () => {
    return { ok: true, buses: audiolinkService.getVmBuses() };
  });

  // ── VBAN Control ──────────────────────────────────────────────

  ipcMain.handle('audiolink-apply-profile', async () => {
    const cfg = loadConfig();
    return await audiolinkService.applyProfile(cfg);
  });

  ipcMain.handle('audiolink-toggle-send', async (_, enabled) => {
    const cfg = loadConfig();
    const mode = cfg.audiolinkMode || 'emitter';
    const idx = cfg.audiolinkVbanIndex ?? 0;
    const res = audiolinkService.toggleVbanStream(mode, idx, enabled);
    if (res.ok) {
      cfg.audiolinkSendEnabled = enabled;
      saveConfig(cfg);
    }
    return res;
  });

  ipcMain.handle('audiolink-toggle-monitor', async (_, enabled) => {
    const cfg = loadConfig();
    cfg.audiolinkMonitorEnabled = enabled;
    saveConfig(cfg);
    // If receiver, start/stop VBAN monitor
    if (cfg.audiolinkMode === 'receiver') {
      if (enabled) audiolinkService.startVbanMonitor(cfg.audiolinkPort || 6980);
      else audiolinkService.stopVbanMonitor();
    }
    return { ok: true };
  });

  ipcMain.handle('audiolink-reconnect', async () => {
    try {
      audiolinkService.disconnectVoicemeeter();
      const cfg = loadConfig();
      const res = await audiolinkService.applyProfile(cfg);
      return res;
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('audiolink-get-levels', async () => {
    return { ok: true, levels: audiolinkService.getLevels() };
  });

  // ── OBS ────────────────────────────────────────────────────────

  ipcMain.handle('audiolink-obs-connect', async () => {
    const cfg = loadConfig();
    return await obsService.connect(
      cfg.audiolinkObsAddress || 'ws://127.0.0.1:4455',
      cfg.audiolinkObsPassword || ''
    );
  });

  ipcMain.handle('audiolink-obs-disconnect', async () => {
    obsService.disconnect();
    return { ok: true };
  });

  ipcMain.handle('audiolink-obs-sources', async () => {
    const sources = await obsService.getAudioSources();
    return { ok: true, sources };
  });

  ipcMain.handle('audiolink-obs-mute', async (_, { sourceName, muted }) => {
    return await obsService.setSourceMute(sourceName, muted);
  });

  ipcMain.handle('audiolink-obs-scenes', async () => {
    const scenes = await obsService.getScenes();
    return { ok: true, scenes };
  });

  // ── Platform Rules ─────────────────────────────────────────────

  ipcMain.handle('audiolink-set-platform-rule', async (_, { platform, includeMusic }) => {
    try {
      const cfg = loadConfig();
      if (!cfg.audiolinkPlatformRules) cfg.audiolinkPlatformRules = {};
      cfg.audiolinkPlatformRules[platform] = { includeMusic };
      saveConfig(cfg);

      // If OBS connected and this rule changes mute state, apply it
      if (obsService.isConnected() && cfg.audiolinkObsSourceName) {
        // We don't auto-mute here — the UI calls mute when switching platforms
      }

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

module.exports = { registerAudiolinkIpc };
