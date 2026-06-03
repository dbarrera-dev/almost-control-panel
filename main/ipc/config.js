const { getKickBroadcasterRowId } = require('../kick-utils');

function stripKickCredentialsFromConfig(cfg) {
  const out = { ...cfg };
  const fields = [
    'kickClientId',
    'kickClientSecret',
    'kickChannel',
    'kickChatroomId',
    'kickAccessToken',
    'kickRefreshToken',
    'kickBotAccessToken',
    'kickBotRefreshToken',
    'kickSongRequestRewardId',
    'kickClientIdDev',
    'kickClientSecretDev',
    'kickDevChannel',
    'kickChatroomIdDev',
    'kickAccessTokenDev',
    'kickRefreshTokenDev',
    'kickBotAccessTokenDev',
    'kickBotRefreshTokenDev',
    'kickSongRequestRewardIdDev',
    'songRequestRewardId',
  ];
  for (const field of fields) out[field] = '';
  return out;
}

function registerConfigIpc({ ipcMain, app, loadConfig, saveConfig, applyWindowIcon, state, soundboardService }) {
  function upsertKickTokenRowSafe(row) {
    if (!state.supabase) return;
    state.supabase.from('kick_tokens').upsert(row).then(({ error }) => {
      const errMsg = String(error?.message || '').toLowerCase();
      if (!error || !row || row.chatroom_id === undefined) return;
      if (!errMsg.includes('chatroom_id')) return;
      const fallback = { ...row };
      delete fallback.chatroom_id;
      state.supabase.from('kick_tokens').upsert(fallback).then(() => {}).catch(() => {});
    }).catch(() => {});
  }

  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('save-config', (_, cfg) => {
    const prev = loadConfig();
    const merged = { ...prev, ...cfg };
    const next = stripKickCredentialsFromConfig(merged);
    saveConfig(next);
    if (cfg.logoUrl) applyWindowIcon(cfg.logoUrl, state.mainWindow);
    if (cfg.openAtLogin !== undefined) {
      app.setLoginItemSettings({ openAtLogin: cfg.openAtLogin });
    }
    // Re-crear Supabase client si cambia la URL o la key
    if (cfg.supabaseUrl !== undefined || cfg.supabaseKey !== undefined) {
      const prevUrl = prev.supabaseUrl || '';
      const prevKey = prev.supabaseKey || '';
      const nextUrl = next.supabaseUrl || '';
      const nextKey = next.supabaseKey || '';
      if (nextUrl && nextKey && (prevUrl !== nextUrl || prevKey !== nextKey || !state.supabase)) {
        try {
          const { createClient } = require('@supabase/supabase-js');
          state.supabase = createClient(nextUrl, nextKey);
        } catch {}
      }
      if (!nextUrl || !nextKey) state.supabase = null;
    }
    // Sincronizar campos Kick a Supabase por ambiente.
    // Importante: reward_id NO se sincroniza desde save-config para evitar borrados accidentales.
    // El reward_id se gestiona solo desde el flujo de Rewards (kick IPC).
    if (state.supabase) {
      const nowIso = new Date().toISOString();

      const syncProd =
        cfg.kickChannel !== undefined ||
        cfg.kickChatroomId !== undefined ||
        cfg.kickClientId !== undefined ||
        cfg.kickClientSecret !== undefined;
      if (syncProd) {
        const updProd = { id: 1, updated_at: nowIso };
        if (cfg.kickClientId !== undefined) updProd.client_id = cfg.kickClientId || '';
        if (cfg.kickClientSecret !== undefined) updProd.client_secret = cfg.kickClientSecret || '';
        if (cfg.kickChannel !== undefined) updProd.channel = cfg.kickChannel || '';
        if (cfg.kickChatroomId !== undefined) updProd.chatroom_id = cfg.kickChatroomId || '';
        upsertKickTokenRowSafe(updProd);
      }

      const syncDev =
        cfg.kickDevChannel !== undefined ||
        cfg.kickChatroomIdDev !== undefined ||
        cfg.kickClientIdDev !== undefined ||
        cfg.kickClientSecretDev !== undefined;
      if (syncDev) {
        const devCfg = { ...next, kickBotMode: 'dev' };
        const devRowId = getKickBroadcasterRowId(devCfg);
        const updDev = { id: devRowId, updated_at: nowIso };
        if (cfg.kickClientIdDev !== undefined) updDev.client_id = cfg.kickClientIdDev || '';
        if (cfg.kickClientSecretDev !== undefined) updDev.client_secret = cfg.kickClientSecretDev || '';
        if (cfg.kickDevChannel !== undefined) updDev.channel = cfg.kickDevChannel || '';
        if (cfg.kickChatroomIdDev !== undefined) updDev.chatroom_id = cfg.kickChatroomIdDev || '';
        upsertKickTokenRowSafe(updDev);
      }
    }
    if (soundboardService?.refreshAndRegisterHotkeys) {
      soundboardService.refreshAndRegisterHotkeys({ force: true }).catch(() => {});
    }
    return { ok: true };
  });

  ipcMain.handle('get-login-item-settings', () => {
    return app.getLoginItemSettings();
  });
}

module.exports = { registerConfigIpc };
