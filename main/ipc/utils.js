function registerUtilsIpc({ ipcMain, shell }) {
  ipcMain.handle('open-url', (_, url) => {
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false, error: 'URL inválida' };
  });

  ipcMain.handle('open-external', (_, url) => {
    shell.openExternal(url);
  });
}

module.exports = { registerUtilsIpc };