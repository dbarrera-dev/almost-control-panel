function registerOverlayIpc({ ipcMain, state }) {
  ipcMain.handle('overlay-load-all', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión' };
    try {
      const { data: settings } = await supabase.from('overlay_settings').select('key, value');
      const { data: bracket } = await supabase.from('tournament_bracket').select('*').order('round').order('match_index');
      const result = {};
      (settings || []).forEach(s => result[s.key] = s.value);
      return { ok: true, settings: result, bracket: bracket || [] };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('overlay-update', async (_, { key, value }) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { error } = await supabase.from('overlay_settings').upsert({ key, value }, { onConflict: 'key' });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

  ipcMain.handle('bracket-update', async (_, { id, data }) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { error } = await supabase.from('tournament_bracket').update(data).eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

  ipcMain.handle('bracket-reset', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data: matches } = await supabase.from('tournament_bracket').select('id');
    if (matches) {
      for (const m of matches) {
        await supabase.from('tournament_bracket').update({ team_a: '', team_b: '', score_a: 0, score_b: 0, winner: null }).eq('id', m.id);
      }
    }
    return { ok: true };
  });
}

module.exports = { registerOverlayIpc };