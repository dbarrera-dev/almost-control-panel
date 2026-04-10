function registerWindowIpc({ ipcMain, app, state }) {
  ipcMain.handle('window-minimize', () => state.mainWindow?.minimize());
  ipcMain.handle('window-maximize', () => state.mainWindow?.isMaximized() ? state.mainWindow.unmaximize() : state.mainWindow?.maximize());
  ipcMain.handle('window-close', () => state.mainWindow?.hide());
  ipcMain.handle('get-version', () => app.getVersion());
}

module.exports = { registerWindowIpc };