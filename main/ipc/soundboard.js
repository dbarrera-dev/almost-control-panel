function registerSoundboardIpc({ ipcMain, soundboardService }) {
  function stripRendererFilePaths(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const clean = { ...payload };
    delete clean.sourceFilePath;
    return clean;
  }

  ipcMain.handle('soundboard-get-state', async () => {
    const ready = await soundboardService.ensureReady();
    if (!ready.ok) return ready;
    return soundboardService.getState();
  });

  ipcMain.handle('soundboard-refresh', async () => {
    const res = await soundboardService.refreshAndRegisterHotkeys({ force: true });
    if (!res.ok) return res;
    return soundboardService.getState();
  });

  ipcMain.handle('soundboard-set-hotkeys-enabled', async (_, enabled) => {
    soundboardService.setHotkeysEnabled(enabled);
    const res = await soundboardService.refreshAndRegisterHotkeys();
    if (!res.ok) return res;
    return soundboardService.getState();
  });

  ipcMain.handle('soundboard-set-storage-mode', async (_, mode) => {
    const result = await soundboardService.setStorageModeAndReload(mode);
    if (!result.ok) return result;
    return soundboardService.getState();
  });

  ipcMain.handle('soundboard-migrate-supabase-to-local', async () => {
    const result = await soundboardService.migrateSupabaseToLocal();
    if (!result.ok) return result;
    const refreshed = await soundboardService.refreshAndRegisterHotkeys({ force: true });
    if (!refreshed.ok) return refreshed;
    return { ok: true, migrated: result.migrated, state: soundboardService.getState() };
  });

  ipcMain.handle('soundboard-upload', async (_, payload) => {
    const result = await soundboardService.insertSound(stripRendererFilePaths(payload));
    if (!result.ok) return result;
    return { ...result, state: soundboardService.getState() };
  });

  ipcMain.handle('soundboard-update', async (_, id, patch) => {
    const result = await soundboardService.updateSound(id, stripRendererFilePaths(patch));
    if (!result.ok) return result;
    return { ...result, state: soundboardService.getState() };
  });

  ipcMain.handle('soundboard-delete', async (_, id) => {
    const result = await soundboardService.deleteSound(id);
    if (!result.ok) return result;
    return { ...result, state: soundboardService.getState() };
  });

  ipcMain.handle('soundboard-play', async (_, id) => {
    return soundboardService.playSoundById(id, 'manual');
  });

  ipcMain.handle('soundboard-get-audio', async (_, id) => {
    return soundboardService.getAudioPayload(id);
  });
}

module.exports = { registerSoundboardIpc };
