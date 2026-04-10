function registerSpotifyOverlayIpc({ ipcMain, loadConfig, saveConfig, startSpotifyOverlay, broadcastSpotify, state }) {
  ipcMain.handle('spotify-overlay-status',     () => ({ running: state.spotifyOverlayRunning, url: 'http://localhost:9002' }));
  ipcMain.handle('spotify-overlay-start',      () => { startSpotifyOverlay(); return { ok: true }; });
  ipcMain.handle('spotify-overlay-get-config', () => ({ config: state.spotifyOverlayConfig }));
  ipcMain.handle('spotify-overlay-set-config', (_, cfg) => {
    state.spotifyOverlayConfig = cfg;
    broadcastSpotify({ type: 'config', data: state.spotifyOverlayConfig });
    const appCfg = loadConfig();
    appCfg.spotifyOverlayConfig = cfg;
    saveConfig(appCfg);
    return { ok: true };
  });
}

module.exports = { registerSpotifyOverlayIpc };