// IPC handlers for OBS Dual (dual OBS instance management with scene sync)

function registerObsDualIpc({ ipcMain, loadConfig, saveConfig, saveLog, obsDualService, state }) {

  // ── Config ─────────────────────────────────────────────────────
  ipcMain.handle('obs-dual-get-config', () => {
    const cfg = loadConfig();
    return {
      ok: true,
      hAddress:    cfg.obsDualHAddress    || 'ws://127.0.0.1:4455',
      hPassword:   cfg.obsDualHPassword   || '',
      hProfile:    cfg.obsDualHProfile    || '',
      hCollection: cfg.obsDualHCollection || '',
      hExePath:    cfg.obsDualHExePath    || '',
      vAddress:    cfg.obsDualVAddress    || 'ws://127.0.0.1:4456',
      vPassword:   cfg.obsDualVPassword   || '',
      vProfile:    cfg.obsDualVProfile    || '',
      vCollection: cfg.obsDualVCollection || '',
      vExePath:    cfg.obsDualVExePath    || '',
      syncEnabled:  cfg.obsDualSyncEnabled !== false,
      autoConnect:  cfg.obsDualAutoConnect !== false,
      sceneMap:     cfg.obsDualSceneMap   || {},
    };
  });

  ipcMain.handle('obs-dual-save-config', (_, data) => {
    try {
      const cfg = loadConfig();
      if (data.hAddress    !== undefined) cfg.obsDualHAddress    = data.hAddress;
      if (data.hPassword   !== undefined) cfg.obsDualHPassword   = data.hPassword;
      if (data.hProfile    !== undefined) cfg.obsDualHProfile    = data.hProfile;
      if (data.hCollection !== undefined) cfg.obsDualHCollection = data.hCollection;
      if (data.hExePath    !== undefined) cfg.obsDualHExePath    = data.hExePath;
      if (data.vAddress    !== undefined) cfg.obsDualVAddress    = data.vAddress;
      if (data.vPassword   !== undefined) cfg.obsDualVPassword   = data.vPassword;
      if (data.vProfile    !== undefined) cfg.obsDualVProfile    = data.vProfile;
      if (data.vCollection !== undefined) cfg.obsDualVCollection = data.vCollection;
      if (data.vExePath    !== undefined) cfg.obsDualVExePath    = data.vExePath;
      if (data.syncEnabled !== undefined) cfg.obsDualSyncEnabled = data.syncEnabled;
      if (data.autoConnect !== undefined) cfg.obsDualAutoConnect = data.autoConnect;
      if (data.sceneMap    !== undefined) cfg.obsDualSceneMap    = data.sceneMap;
      saveConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── Status ────────────────────────────────────────────────────
  ipcMain.handle('obs-dual-get-status', () => {
    return { ok: true, ...obsDualService.getStatus() };
  });

  // ── Connection ───────────────────────────────────────────────
  ipcMain.handle('obs-dual-connect', async (_, side) => {
    try {
      const cfg = loadConfig();
      const sKey = side === 'h' ? 'H' : 'V';
      const address  = cfg[`obsDual${sKey}Address`]  || (side === 'h' ? 'ws://127.0.0.1:4455' : 'ws://127.0.0.1:4456');
      const password = cfg[`obsDual${sKey}Password`] || '';
      return await obsDualService.connectSide(side, address, password);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('obs-dual-connect-both', async () => {
    try {
      const cfg = loadConfig();
      const [rH, rV] = await Promise.all([
        obsDualService.connectSide('h', cfg.obsDualHAddress || 'ws://127.0.0.1:4455', cfg.obsDualHPassword || ''),
        obsDualService.connectSide('v', cfg.obsDualVAddress || 'ws://127.0.0.1:4456', cfg.obsDualVPassword || ''),
      ]);
      return { ok: rH.ok || rV.ok, h: rH, v: rV };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('obs-dual-disconnect', (_, side) => {
    obsDualService.disconnectSide(side);
    return { ok: true };
  });

  ipcMain.handle('obs-dual-disconnect-both', () => {
    obsDualService.disconnectSide('h');
    obsDualService.disconnectSide('v');
    return { ok: true };
  });

  // ── Launch OBS ────────────────────────────────────────────────
  ipcMain.handle('obs-dual-launch', (_, side) => {
    return obsDualService.launchObs(side);
  });

  ipcMain.handle('obs-dual-launch-both', async () => {
    const rH = obsDualService.launchObs('h');
    await new Promise(r => setTimeout(r, 800)); // slight delay between launches
    const rV = obsDualService.launchObs('v');
    return { ok: rH.ok || rV.ok, h: rH, v: rV };
  });

  // ── Scene Control ─────────────────────────────────────────────
  ipcMain.handle('obs-dual-get-scenes', async (_, side) => {
    return obsDualService.getScenes(side);
  });

  ipcMain.handle('obs-dual-set-scene', async (_, side, sceneName, propagate) => {
    return obsDualService.setScene(side, sceneName, propagate !== false);
  });

  // ── Scene Mapping ─────────────────────────────────────────────
  ipcMain.handle('obs-dual-get-scene-map', () => {
    const cfg = loadConfig();
    return { ok: true, sceneMap: cfg.obsDualSceneMap || {} };
  });

  ipcMain.handle('obs-dual-save-scene-map', (_, sceneMap) => {
    try {
      const cfg = loadConfig();
      cfg.obsDualSceneMap = sceneMap;
      saveConfig(cfg);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  // ── Sync Toggle ───────────────────────────────────────────────
  ipcMain.handle('obs-dual-set-sync', (_, enabled) => {
    obsDualService.setSyncEnabled(enabled);
    const cfg = loadConfig();
    cfg.obsDualSyncEnabled = enabled;
    saveConfig(cfg);
    return { ok: true, syncEnabled: enabled };
  });

  // ── Stream/Record Controls ────────────────────────────────────
  ipcMain.handle('obs-dual-get-stream-record-status', async (_, side) => {
    return obsDualService.getStreamRecordStatus(side);
  });

  ipcMain.handle('obs-dual-start-stream', async (_, side) => {
    return obsDualService.startStream(side);
  });

  ipcMain.handle('obs-dual-stop-stream', async (_, side) => {
    return obsDualService.stopStream(side);
  });

  ipcMain.handle('obs-dual-start-record', async (_, side) => {
    return obsDualService.startRecord(side);
  });

  ipcMain.handle('obs-dual-stop-record', async (_, side) => {
    return obsDualService.stopRecord(side);
  });

  // ── Auto-connect on startup ───────────────────────────────────
  async function autoConnect() {
    const cfg = loadConfig();
    if (!cfg.obsDualAutoConnect) return;
    const sides = [];
    if (cfg.obsDualHAddress) sides.push('h');
    if (cfg.obsDualVAddress) sides.push('v');
    for (const side of sides) {
      const sKey = side === 'h' ? 'H' : 'V';
      const address  = cfg[`obsDual${sKey}Address`];
      const password = cfg[`obsDual${sKey}Password`] || '';
      if (address) {
        obsDualService.connectSide(side, address, password).catch(() => {});
      }
    }
  }

  // Delay auto-connect to let the app fully load
  setTimeout(autoConnect, 3000);
}

module.exports = { registerObsDualIpc };
