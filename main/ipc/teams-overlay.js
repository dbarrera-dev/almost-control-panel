function registerTeamsOverlayIpc({ ipcMain, state }) {
  ipcMain.handle('teams-overlay-status', () => ({ running: state.teamsOverlayRunning, url: 'http://localhost:9004' }));
}

module.exports = { registerTeamsOverlayIpc };
