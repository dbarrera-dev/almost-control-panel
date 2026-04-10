function registerTwitchIpc({ ipcMain, loadConfig, saveConfig, getTwitchBroadcasterId, twitchHelixGet, twitchHelixPatch }) {
  ipcMain.handle('twitch-reward-toggle', async (_, enabled) => {
    try {
      const cfg = loadConfig();
      const clientId = cfg.twitchClientId?.trim();
      const token    = cfg.broadcasterToken?.trim().replace(/^oauth:/, '');
      const rewardId = cfg.songRequestRewardId?.trim();
      const channel  = cfg.twitchChannel?.trim();
      if (!clientId || !token) return { ok: false, error: 'Falta el Client ID o el token del broadcaster.' };
      if (!rewardId)           return { ok: false, error: 'No hay ID de recompensa configurado.' };
      const broadcasterId = await getTwitchBroadcasterId(channel, clientId, token);
      if (!broadcasterId)      return { ok: false, error: 'No se pudo obtener el broadcaster ID. Verificá el token y el Client ID.' };
      const r = await twitchHelixPatch(
        `/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`,
        clientId, token, { is_enabled: enabled }
      );
      if (r.status === 200) return { ok: true, enabled };
      return { ok: false, error: r.data?.message || `Error ${r.status}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('twitch-reward-get-status', async () => {
    try {
      const cfg = loadConfig();
      const clientId = cfg.twitchClientId?.trim();
      const token    = cfg.broadcasterToken?.trim().replace(/^oauth:/, '');
      const rewardId = cfg.songRequestRewardId?.trim();
      const channel  = cfg.twitchChannel?.trim();
      if (!clientId || !token || !rewardId) return { ok: false, error: 'config_missing' };
      const broadcasterId = await getTwitchBroadcasterId(channel, clientId, token);
      if (!broadcasterId) return { ok: false, error: 'broadcaster_not_found' };
      const r = await twitchHelixGet(
        `/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${rewardId}`,
        clientId, token
      );
      if (r.status === 200) return { ok: true, enabled: r.data?.data?.[0]?.is_enabled ?? null };
      return { ok: false, error: r.data?.message || `Error ${r.status}` };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('twitch-save-credentials', (_, { clientId, broadcasterToken }) => {
    const cfg = loadConfig();
    cfg.twitchClientId    = clientId.trim();
    cfg.broadcasterToken  = broadcasterToken.trim();
    saveConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('twitch-get-credentials', () => {
    const cfg = loadConfig();
    return { ok: true, clientId: cfg.twitchClientId || '', broadcasterToken: cfg.broadcasterToken || '' };
  });
}

module.exports = { registerTwitchIpc };