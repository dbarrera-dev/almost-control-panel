function registerTorneoIpc({ ipcMain, saveLog, state }) {
  ipcMain.handle('crear-torneo', async (_, { nombre, maxParticipantes }) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase' };
    await supabase.from('torneos').update({ activo: false }).eq('activo', true);
    const { data, error } = await supabase.from('torneos').insert({ nombre, activo: true }).select().single();
    if (error) return { ok: false, error: error.message };
    state.currentTorneoId = data.id;
    state.currentTorneoMax = maxParticipantes || 0;
    state.torneoTwitchNicks.clear(); state.torneoKickNicks.clear();
    saveLog('info', `Torneo "${nombre}" creado${maxParticipantes ? ` (máx. ${maxParticipantes})` : ''}`);
    return { ok: true, torneo: data };
  });

  ipcMain.handle('get-torneo-activo', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data: torneo } = await supabase.from('torneos').select('*').eq('activo', true).order('creado_at', { ascending: false }).limit(1).maybeSingle();
    if (!torneo) return { ok: false };
    state.currentTorneoId = torneo.id;
    state.torneoTwitchNicks.clear(); state.torneoKickNicks.clear();
    const { data: participantes } = await supabase.from('participantes').select('*').eq('torneo_id', torneo.id).order('joined_at', { ascending: true });
    return { ok: true, torneo, participantes: participantes || [] };
  });

  ipcMain.handle('cerrar-torneo-db', async (_, torneoId) => {
    const supabase = state.supabase;
    if (!supabase || !torneoId) return;
    await supabase.from('torneos').update({ activo: false }).eq('id', torneoId);
    state.currentTorneoId = null;
    state.currentTorneoMax = 0;
    state.torneoTwitchNicks.clear(); state.torneoKickNicks.clear();
    saveLog('info', 'Torneo cerrado y registrado en historial');
  });

  ipcMain.handle('get-participantes', async (_, torneoId) => {
    const supabase = state.supabase;
    if (!supabase) return [];
    const { data } = await supabase.from('participantes').select('*').eq('torneo_id', torneoId).order('joined_at', { ascending: true });
    return data || [];
  });

  ipcMain.handle('get-torneos', async () => {
    const supabase = state.supabase;
    if (!supabase) return [];
    const { data } = await supabase.from('torneos').select('*, participantes(count)').order('creado_at', { ascending: false }).limit(30);
    return data || [];
  });

  ipcMain.handle('generar-equipos', async (_, { torneoId, tamanio }) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data } = await supabase.from('participantes').select('nick').eq('torneo_id', torneoId);
    if (!data?.length) return { ok: false, error: 'No hay participantes' };

    const arr = [...data];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    const teams = [];
    for (let i = 0; i < arr.length; i += tamanio) {
      const teamMembers = arr.slice(i, i + tamanio).map(x => x.nick);
      teams.push(teamMembers);
    }
    return { ok: true, teams };
  });

  ipcMain.handle('eliminar-participante', async (_, { nick, torneoId }) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { error } = await supabase.from('participantes').delete().eq('nick', nick).eq('torneo_id', torneoId);
    if (error) return { ok: false, error: error.message };
    saveLog('warn', `Participante eliminado: ${nick}`);
    return { ok: true };
  });

  ipcMain.handle('eliminar-torneo', async (_, torneoId) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const errors = [];

    const delP = await supabase.from('participantes').delete().eq('torneo_id', torneoId);
    if (delP.error) errors.push(delP.error.message);

    const delT = await supabase.from('torneos').delete().eq('id', torneoId);
    if (delT.error) errors.push(delT.error.message);

    if (state.currentTorneoId === torneoId) state.currentTorneoId = null;
    saveLog('warn', 'Torneo eliminado del historial');
    return { ok: true, warnings: errors };
  });
}

module.exports = { registerTorneoIpc };