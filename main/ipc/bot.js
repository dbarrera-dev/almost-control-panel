function registerBotIpc({ ipcMain, saveLog }) {
  const disabledMessage = 'El bot legacy fue retirado. Usá Kick Bot desde la pestaña Kick.';

  ipcMain.handle('connect-bot', async () => {
    saveLog('warn', '[bot] connect-bot ignorado: integración legacy removida');
    return { ok: false, error: disabledMessage };
  });

  ipcMain.handle('disconnect-bot', async () => {
    return { ok: true, message: 'Sin bot legacy activo.' };
  });
}

module.exports = { registerBotIpc };
