function registerKeyOverlayIpc({ ipcMain, loadConfig, saveConfig, startKeyOverlay, stopKeyOverlay, broadcastOverlay, configMsg, state }) {
  ipcMain.handle('keyoverlay-start',  () => { startKeyOverlay(); return { ok: true }; });
  ipcMain.handle('keyoverlay-stop',   () => { stopKeyOverlay();  return { ok: true }; });
  ipcMain.handle('keyoverlay-status', () => ({ ok: true, running: state.keyOverlayRunning, url: 'http://localhost:9001' }));
  ipcMain.handle('keyoverlay-get-config', () => ({ ok: true, config: state.keyOverlayConfig }));
  ipcMain.handle('keyoverlay-set-config', (_, cfg) => {
    state.keyOverlayConfig = cfg;
    broadcastOverlay(configMsg());
    const appCfg = loadConfig();
    appCfg.keyOverlayConfig = cfg;
    saveConfig(appCfg);
    return { ok: true };
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