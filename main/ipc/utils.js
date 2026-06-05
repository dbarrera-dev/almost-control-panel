function registerUtilsIpc({ ipcMain, shell }) {
  function openSafeExternal(url) {
    try {
      const parsed = new URL(String(url || ''));
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'URL inválida' };
      }
      shell.openExternal(parsed.toString());
      return { ok: true };
    } catch {
      return { ok: false, error: 'URL inválida' };
    }
  }

  ipcMain.handle('open-url', (_, url) => {
    return openSafeExternal(url);
  });

  ipcMain.handle('open-external', (_, url) => {
    return openSafeExternal(url);
  });
}

module.exports = { registerUtilsIpc };
