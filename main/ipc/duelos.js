function registerDuelosIpc({ ipcMain, saveLog, state }) {
  ipcMain.handle('duelos-get', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, data: [] };
    const { data, error } = await supabase.from('duelos').select('*').order('added_at', { ascending: false });
    if (error) return { ok: false, data: [] };
    return { ok: true, data: data || [] };
  });

  ipcMain.handle('duelos-add', async (_, nick) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data, error } = await supabase.from('duelos').insert({ nick, done: false, added_at: new Date().toISOString() }).select().single();
    if (error) return { ok: false, error: error.message };
    saveLog('join', `1v1 agregado: ${nick}`);
    return { ok: true, data };
  });

  ipcMain.handle('duelos-toggle', async (_, { id, done, nick }) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { error } = await supabase.from('duelos').update({ done }).eq('id', id);
    if (error) return { ok: false, error: error.message };
    if (done && nick) saveLog('info', `1v1 completado: ${nick}`);
    return { ok: true };
  });

  ipcMain.handle('duelos-delete', async (_, id) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data: duel } = await supabase.from('duelos').select('nick').eq('id', id).maybeSingle();
    const { error } = await supabase.from('duelos').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    saveLog('warn', `1v1 eliminado: ${duel?.nick || id}`);
    return { ok: true };
  });
}

module.exports = { registerDuelosIpc };