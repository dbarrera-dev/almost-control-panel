function registerKickIpc({
  ipcMain,
  loadConfig,
  saveConfig,
  startKickOAuthFlow,
  getKickCodeVerifier,
  KICK_REDIRECT_URI,
  httpsRequest,
  kickApiRequest,
  connectKickBot,
  stopKickPolling,
  saveLog,
  state,
}) {
  ipcMain.handle('kick-connect-oauth', async (_, { clientId, clientSecret, kickChannel }) => {
    try {
      const code = await startKickOAuthFlow(clientId);
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: KICK_REDIRECT_URI,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: (getKickCodeVerifier && getKickCodeVerifier()) || ''
      }).toString();
      const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token',
        { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
      if (!r.data?.access_token) return { ok: false, error: r.data?.error_description || 'No se recibió token' };
      const cfg = loadConfig();
      cfg.kickClientId = clientId;
      cfg.kickClientSecret = clientSecret;
      cfg.kickChannel = kickChannel;
      cfg.kickAccessToken = r.data.access_token;
      if (r.data.refresh_token) cfg.kickRefreshToken = r.data.refresh_token;
      saveConfig(cfg);
      state.kickAccessToken = r.data.access_token;
      // Guardar en Supabase para que otros instancias lo carguen automáticamente
      if (state.supabase) {
        await state.supabase.from('kick_tokens').upsert({
          id: 1,
          client_id: clientId,
          client_secret: clientSecret,
          channel: kickChannel,
          access_token: r.data.access_token,
          refresh_token: r.data.refresh_token || '',
          updated_at: new Date().toISOString()
        }).then(() => {}).catch(() => {});
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('kick-bot-connect', () => connectKickBot());

  ipcMain.handle('kick-bot-oauth', async () => {
    try {
      const cfg = loadConfig();
      const clientId = cfg.kickClientId;
      const clientSecret = cfg.kickClientSecret;
      if (!clientId || !clientSecret) return { ok: false, error: 'Guardá el Client ID y Secret primero' };
      const code = await startKickOAuthFlow(clientId);
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: KICK_REDIRECT_URI,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: (getKickCodeVerifier && getKickCodeVerifier()) || ''
      }).toString();
      const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token',
        { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
      if (!r.data?.access_token) return { ok: false, error: r.data?.error_description || 'No se recibió token' };
      cfg.kickBotAccessToken = r.data.access_token;
      if (r.data.refresh_token) cfg.kickBotRefreshToken = r.data.refresh_token;
      saveConfig(cfg);
      state.kickBotAccessToken = r.data.access_token;
      if (state.supabase) {
        try {
          await state.supabase.from('kick_tokens').upsert({
            id: 2,
            access_token: r.data.access_token,
            refresh_token: r.data.refresh_token || '',
            updated_at: new Date().toISOString()
          });
        } catch (_) {}
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('kick-bot-disconnect', () => {
    stopKickPolling();
    state.kickChannelId = null;
    state.kickAccessToken = null;
    state.mainWindow?.webContents.send('kick-bot-status', { connected: false });
    saveLog('info', 'Kick bot desconectado manualmente');
    return { ok: true };
  });

  ipcMain.handle('kick-bot-status', () => ({
    connected: !!state.kickPollTimer
  }));

  ipcMain.handle('kick-get-config', () => {
    const cfg = loadConfig();
    return { ok: true, clientId: cfg.kickClientId || '', kickChannel: cfg.kickChannel || '', chatroomId: cfg.kickChatroomId || '', hasToken: !!cfg.kickAccessToken, hasBotToken: !!cfg.kickBotAccessToken, rewardId: cfg.kickSongRequestRewardId || '', autoConnectKickBot: cfg.autoConnectKickBot !== false, connected: !!state.kickPollTimer };
  });

  ipcMain.handle('kick-reward-toggle', async (_, enabled) => {
    try {
      const cfg = loadConfig();
      const rewardId = cfg.kickSongRequestRewardId?.trim();
      if (!state.kickAccessToken)  return { ok: false, error: 'Bot de Kick no conectado.' };
      if (!rewardId)               return { ok: false, error: 'No hay ID de recompensa configurado.' };
      const r = await kickApiRequest('PATCH', `/public/v1/channels/rewards/${rewardId}`, { is_enabled: enabled }, state.kickAccessToken);
      if (r.status === 200) return { ok: true, enabled };
      if (r.status === 403) return { ok: false, error: 'Solo se puede modificar una reward creada por esta app.' };
      return { ok: false, error: r.data?.message || `Error ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('kick-reward-get-status', async () => {
    try {
      const cfg = loadConfig();
      const rewardId = cfg.kickSongRequestRewardId?.trim();
      if (!state.kickAccessToken || !rewardId) return { ok: false, error: 'config_missing' };
      const r = await kickApiRequest('GET', `/public/v1/channels/rewards`, null, state.kickAccessToken);
      if (r.status === 200) {
        const reward = (r.data?.data || []).find(rw => rw.id === rewardId);
        return { ok: true, enabled: reward?.is_enabled ?? null };
      }
      return { ok: false, error: r.data?.message || `Error ${r.status}` };
    } catch (e) { return { ok: false, error: e.message }; }
  });
}

module.exports = { registerKickIpc };
