function registerTodosIpc({ ipcMain, saveLog, state }) {
  ipcMain.handle('todos-get', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, data: [] };
    const { data, error } = await supabase.from('todos').select('*').order('created_at', { ascending: false });
    if (error) return { ok: false, data: [] };
    return { ok: true, data: data || [] };
  });

  ipcMain.handle('todos-add', async (_, todo) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data, error } = await supabase.from('todos').insert({
      title: todo.title,
      description: todo.description || null,
      priority: todo.priority || 'medium',
      status: todo.status || 'pending',
      due_date: todo.due_date || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).select().single();
    if (error) return { ok: false, error: error.message };
    saveLog('info', `Tarea agregada: ${todo.title}`);
    return { ok: true, data };
  });

  ipcMain.handle('todos-update', async (_, { id, data, title }) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { error } = await supabase.from('todos').update({ ...data, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) return { ok: false, error: error.message };
    if (data.status && title) saveLog('info', `Tarea "${title}" → ${data.status}`);
    return { ok: true };
  });

  ipcMain.handle('todos-delete', async (_, id) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data: todo } = await supabase.from('todos').select('title').eq('id', id).maybeSingle();
    const { error } = await supabase.from('todos').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    saveLog('warn', `Tarea eliminada: ${todo?.title || id}`);
    return { ok: true };
  });
}

module.exports = { registerTodosIpc };