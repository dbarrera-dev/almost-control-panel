function registerSorteoIpc({ ipcMain, saveLog, state }) {
  ipcMain.handle('sorteo-set-cmd', (_, cmd) => {
    state.currentSorteoCmd = cmd.trim() || '!sorteo';
    return { ok: true };
  });

  ipcMain.handle('sorteo-toggle', (_, activo) => {
    state.sorteoActivo = !!activo;
    saveLog('info', activo ? 'Sorteo activado' : 'Sorteo desactivado');
    return { ok: true };
  });

  ipcMain.handle('sorteo-get-participantes', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, data: [] };
    const { data, error } = await supabase.from('sorteo_participantes').select('*').order('created_at', { ascending: true });
    if (error) return { ok: false, data: [] };
    return { ok: true, data: data || [] };
  });

  ipcMain.handle('sorteo-limpiar', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    await supabase.from('sorteo_participantes').delete().neq('id', -1);
    saveLog('warn', 'Sorteo: participantes limpiados');
    return { ok: true };
  });

  ipcMain.handle('sorteo-guardar-y-limpiar', async (_, { ganadores, total }) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    await supabase.from('sorteo_historial').insert({
      ganadores,
      total,
      fecha: new Date().toISOString()
    });
    await supabase.from('sorteo_participantes').delete().neq('id', -1);
    saveLog('info', 'Sorteo guardado en historial');
    return { ok: true };
  });

  ipcMain.handle('sorteo-get-historial', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, data: [] };
    const { data, error } = await supabase.from('sorteo_historial').select('*').order('fecha', { ascending: false }).limit(30);
    if (error) return { ok: false, data: [] };
    return { ok: true, data: data || [] };
  });
}

module.exports = { registerSorteoIpc };