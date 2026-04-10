function registerConfigIpc({ ipcMain, app, loadConfig, saveConfig, applyWindowIcon, state }) {
  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('save-config', (_, cfg) => {
    const prev = loadConfig();
    const next = { ...prev, ...cfg };
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
    // Sincronizar campos Kick a Supabase
    if (state.supabase && (cfg.kickSongRequestRewardId || cfg.kickChannel)) {
      const upd = { id: 1, updated_at: new Date().toISOString() };
      if (cfg.kickSongRequestRewardId) upd.reward_id = cfg.kickSongRequestRewardId;
      if (cfg.kickChannel) upd.channel = cfg.kickChannel;
      state.supabase.from('kick_tokens').upsert(upd).then(() => {}).catch(() => {});
    }
    // Sincronizar credenciales bot Twitch a Supabase
    if (state.supabase && (cfg.botUsername || cfg.botOauth || cfg.twitchChannel)) {
      const upd = { id: 1, updated_at: new Date().toISOString() };
      if (next.botUsername)   upd.bot_username   = next.botUsername;
      if (next.botOauth)      upd.bot_oauth      = next.botOauth;
      if (next.twitchChannel) upd.twitch_channel = next.twitchChannel;
      state.supabase.from('bot_config').upsert(upd).then(() => {}).catch(() => {});
    }
    return { ok: true };
  });

  ipcMain.handle('get-login-item-settings', () => {
    return app.getLoginItemSettings();
  });
}

module.exports = { registerConfigIpc };
