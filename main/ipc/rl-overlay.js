function registerRlOverlayIpc({ ipcMain, loadConfig, saveConfig, startRLOverlay, refreshRLStats, broadcastRL, state }) {
  ipcMain.handle('rl-overlay-status', () => ({ running: state.rlOverlayRunning, url: 'http://localhost:9003' }));
  ipcMain.handle('rl-overlay-start',  () => { startRLOverlay(); return { ok: true }; });
  ipcMain.handle('rl-overlay-get-config', () => ({ config: state.rlOverlayConfig, stats: state.rlStats }));
  ipcMain.handle('rl-overlay-set-config', (_, cfg) => {
    const usernameChanged = cfg.username !== state.rlOverlayConfig.username || cfg.platform !== state.rlOverlayConfig.platform;
    state.rlOverlayConfig = cfg;
    broadcastRL({ type: 'config', data: state.rlOverlayConfig });
    const appCfg = loadConfig();
    appCfg.rlOverlayConfig = cfg;
    saveConfig(appCfg);
    if (usernameChanged) { state.rlSessionStart = null; state.rlStats = null; if (cfg.username) refreshRLStats(); }
    return { ok: true };
  });
  ipcMain.handle('rl-overlay-refresh', async () => {
    await refreshRLStats();
    return { ok: true, stats: state.rlStats };
  });
  ipcMain.handle('rl-overlay-reset-session', () => {
    state.rlSessionStart = state.rlStats ? { ...state.rlStats } : null;
    broadcastRL({ type: 'stats', data: { stats: state.rlStats, delta: { mmr:0, wins:0, losses:0, matches:0 }, config: state.rlOverlayConfig } });
    return { ok: true };
  });
}

module.exports = { registerRlOverlayIpc };