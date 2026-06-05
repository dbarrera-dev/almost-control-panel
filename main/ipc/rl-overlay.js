function registerRlOverlayIpc({ ipcMain, rlLiveService }) {
  ipcMain.handle('rl-overlay-status', () => rlLiveService.getStatus());

  ipcMain.handle('rl-overlay-start', () => {
    const state = rlLiveService.start();
    return { ok: true, state, ...rlLiveService.getStatus() };
  });

  ipcMain.handle('rl-overlay-get-config', () => rlLiveService.getConfig());

  ipcMain.handle('rl-overlay-set-config', (_event, cfg) => {
    const state = rlLiveService.setConfig(cfg || {});
    return { ok: true, state, config: state.config };
  });

  ipcMain.handle('rl-overlay-refresh', () => {
    const state = rlLiveService.refresh();
    return { ok: true, state, stats: state.currentMatch, session: state.dailyStats };
  });

  ipcMain.handle('rl-overlay-reset-session', () => {
    const state = rlLiveService.resetSession();
    return { ok: true, state, session: state.dailyStats };
  });

  ipcMain.handle('rl-overlay-series-action', (_event, action) => {
    const state = rlLiveService.applySeriesAction(action || {});
    return { ok: true, state, series: state.seriesState, scoreboard: state.scoreboard };
  });

  ipcMain.handle('rl-overlay-clear-live', () => {
    const state = rlLiveService.clearLiveMatch();
    return { ok: true, state };
  });
}

module.exports = { registerRlOverlayIpc };
