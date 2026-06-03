function registerSpotifyOverlayIpc({ ipcMain, loadConfig, saveConfig, startSpotifyOverlay, getSpotifyOverlayStatus, broadcastSpotify, state }) {
  const fallbackStatus = () => ({
    running: !!state.spotifyOverlayRunning,
    url: 'http://localhost:9002',
    requesterUrl: 'http://localhost:9002/requester',
    lanUrl: null,
    lanRequesterUrl: null,
    wsClients: 0,
    error: null,
    bindHost: '127.0.0.1',
  });

  ipcMain.handle('spotify-overlay-status', () => {
    if (typeof getSpotifyOverlayStatus === 'function') {
      const s = getSpotifyOverlayStatus();
      if (s && typeof s === 'object') return s;
    }
    return fallbackStatus();
  });

  ipcMain.handle('spotify-overlay-start', () => {
    startSpotifyOverlay();
    return {
      ok: true,
      status: (typeof getSpotifyOverlayStatus === 'function' ? getSpotifyOverlayStatus() : fallbackStatus()),
    };
  });
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
