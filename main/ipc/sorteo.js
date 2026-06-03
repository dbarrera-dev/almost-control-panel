function registerSorteoIpc({ ipcMain, saveLog, state }) {
  ipcMain.handle('sorteo-set-cmd', (_, cmd) => {
    state.currentSorteoCmd = String(cmd || '').trim().toLowerCase() || '!sorteo';
    return { ok: true };
  });

  ipcMain.handle('sorteo-get-state', () => ({
    ok: true,
    cmd: state.currentSorteoCmd || '!sorteo',
    activo: !!state.sorteoActivo,
  }));

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

  ipcMain.handle('sorteo-add-participantes', async (_, payload) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Supabase no conectado', added: 0, duplicates: 0, data: [] };

    const raw = Array.isArray(payload?.participantes)
      ? payload.participantes
      : Array.isArray(payload)
        ? payload
        : [];

    const uniqueInput = [];
    const seenInput = new Set();
    for (const item of raw) {
      let nick = String(item?.nick ?? item ?? '').trim();
      nick = nick.replace(/^@+/, '').trim();
      if (!nick) continue;
      if (nick.length > 40) nick = nick.slice(0, 40);
      const key = nick.toLowerCase();
      if (seenInput.has(key)) continue;
      seenInput.add(key);
      uniqueInput.push({ nick });
      if (uniqueInput.length >= 500) break;
    }

    if (!uniqueInput.length) {
      return { ok: false, error: 'No hay participantes válidos', added: 0, duplicates: 0, data: [] };
    }

    const { data: existingRows, error: existingError } = await supabase
      .from('sorteo_participantes')
      .select('nick');
    if (existingError) {
      return { ok: false, error: existingError.message || 'No se pudieron validar duplicados', added: 0, duplicates: 0, data: [] };
    }

    const existing = new Set((existingRows || []).map(r => String(r?.nick || '').trim().toLowerCase()).filter(Boolean));
    const toInsert = [];
    let duplicates = 0;
    for (const row of uniqueInput) {
      const key = row.nick.toLowerCase();
      if (existing.has(key)) {
        duplicates += 1;
        continue;
      }
      existing.add(key);
      toInsert.push(row);
    }

    if (!toInsert.length) {
      return { ok: true, added: 0, duplicates: uniqueInput.length, data: [] };
    }

    const { data: inserted, error: insertError } = await supabase
      .from('sorteo_participantes')
      .insert(toInsert)
      .select('*');
    if (insertError) {
      return { ok: false, error: insertError.message || 'No se pudo insertar', added: 0, duplicates, data: [] };
    }

    saveLog('info', `Sorteo: ${toInsert.length} participante(s) agregados manualmente`);
    return { ok: true, added: toInsert.length, duplicates, data: inserted || [] };
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
