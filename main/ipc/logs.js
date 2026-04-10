function registerLogsIpc({ ipcMain, state }) {
  ipcMain.handle('logs-get', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, data: [] };
    try {
      const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      await supabase.from('app_logs').delete().lt('created_at', week);
      const { data, error } = await supabase.from('app_logs').select('*')
        .gte('created_at', week)
        .not('type', 'in', '("sr","sr-done")')
        .order('created_at', { ascending: true });
      if (error) return { ok: false, data: [] };
      return { ok: true, data: data || [] };
    } catch (_) {
      return { ok: false, data: [] };
    }
  });
}

module.exports = { registerLogsIpc };