function registerRlOverlayIpc({ ipcMain, loadConfig, saveConfig, startRLOverlay, refreshRLStats, resetRLSessionTracking, broadcastRL, state }) {
  ipcMain.handle('rl-overlay-status', () => ({ running: state.rlOverlayRunning, url: 'http://localhost:9003' }));
  ipcMain.handle('rl-overlay-start',  () => { startRLOverlay(); return { ok: true }; });
  ipcMain.handle('rl-overlay-get-config', () => ({
    config: state.rlOverlayConfig,
    stats: state.rlStats,
    delta: state.rlStats && state.rlSessionStart
      ? {
          mmr: (state.rlStats.mmr || 0) - (state.rlSessionStart.mmr || 0),
          wins: (state.rlStats.wins || 0) - (state.rlSessionStart.wins || 0),
          losses: (state.rlStats.losses || 0) - (state.rlSessionStart.losses || 0),
          matches: (state.rlStats.matches || 0) - (state.rlSessionStart.matches || 0),
          goals: (state.rlStats.goals || 0) - (state.rlSessionStart.goals || 0),
        }
      : { mmr: 0, wins: 0, losses: 0, matches: 0, goals: 0 },
    session: state.rlSessionSummary || { wins: 0, losses: 0, goals: 0, streak: 0, lastResult: null, matches: 0 }
  }));
  ipcMain.handle('rl-overlay-set-config', (_, cfg) => {
    const usernameChanged = cfg.username !== state.rlOverlayConfig.username || cfg.platform !== state.rlOverlayConfig.platform;
    const playlistChanged = Number(cfg.playlistId || 13) !== Number(state.rlOverlayConfig.playlistId || 13);
    const realtimeChanged = (cfg.realtimeEnabled !== false) !== (state.rlOverlayConfig.realtimeEnabled !== false);
    const portChanged = Number(cfg.statsApiPort || 49123) !== Number(state.rlOverlayConfig.statsApiPort || 49123);
    state.rlOverlayConfig = {
      platform: cfg.platform || 'epic',
      username: cfg.username || '',
      playlistId: Number(cfg.playlistId || 13),
      realtimeEnabled: cfg.realtimeEnabled !== false,
      statsApiPort: Number(cfg.statsApiPort || 49123),
      style: {
        bg: cfg.style?.bg || 'rgba(15,15,20,0.92)',
        text: cfg.style?.text || '#ffffff',
        accent: cfg.style?.accent || '#2563eb',
        radius: Number.isFinite(Number(cfg.style?.radius)) ? Number(cfg.style.radius) : 12
      }
    };
    broadcastRL({ type: 'config', data: state.rlOverlayConfig });
    const appCfg = loadConfig();
    appCfg.rlOverlayConfig = state.rlOverlayConfig;
    saveConfig(appCfg);
    if (usernameChanged) {
      state.rlSessionStart = null;
      state.rlStats = null;
      state.rlSessionSummary = { wins: 0, losses: 0, goals: 0, streak: 0, lastResult: null, matches: 0 };
      if (typeof resetRLSessionTracking === 'function') {
        resetRLSessionTracking();
      }
      refreshRLStats();
    } else if (playlistChanged && state.rlOverlayConfig.username) {
      refreshRLStats();
    }
    if (realtimeChanged || portChanged) {
      refreshRLStats();
    }
    return { ok: true };
  });
  ipcMain.handle('rl-overlay-refresh', async () => {
    const payload = await refreshRLStats();
    if (payload) return { ok: true, ...payload };
    return { ok: true, stats: state.rlStats, session: state.rlSessionSummary };
  });
  ipcMain.handle('rl-overlay-reset-session', () => {
    if (typeof resetRLSessionTracking === 'function') {
      resetRLSessionTracking();
    } else {
      state.rlSessionStart = state.rlStats ? { ...state.rlStats } : null;
      state.rlSessionSummary = { wins: 0, losses: 0, goals: 0, streak: 0, lastResult: null, matches: 0 };
      broadcastRL({
        type: 'stats',
        data: {
          stats: state.rlStats,
          delta: { mmr: 0, wins: 0, losses: 0, matches: 0, goals: 0 },
          session: state.rlSessionSummary,
          config: state.rlOverlayConfig
        }
      });
    }
    return { ok: true };
  });
}

module.exports = { registerRlOverlayIpc };
