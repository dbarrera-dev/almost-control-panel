// ── Todos ─────────────────────────────────────────────────────────
let todosData = [];
let todoFilter = 'all';

async function loadTodos() {
  try {
    const r = await api.todosGet();
    if (!r.ok) { todoRender([]); return; }
    todosData = r.data || [];
    todoRender(todosData);
    todoUpdateBadge();
  } catch (e) {
    todoRender([]);
    log('warn', 'Error cargando tareas');
  }
}

function todoSetFilter(f) {
  todoFilter = f;
  ['all','pending','in_progress','done'].forEach(k => {
    document.getElementById('tf-'+k).classList.toggle('on', k === f);
  });
  todoRender(todosData);
}

function todoSearchRefresh() {
  todoRender(todosData);
}

function todoRender(data) {
  const list = document.getElementById('todoList');
  const searchTerm = (document.getElementById('todoSearchInput')?.value || '').toLowerCase().trim();
  const byStatus = todoFilter === 'all' ? data : data.filter(t => t.status === todoFilter);
  const filtered = byStatus.filter((t) => {
    if (!searchTerm) return true;
    const title = String(t.title || '').toLowerCase();
    const desc = String(t.description || '').toLowerCase();
    return title.includes(searchTerm) || desc.includes(searchTerm);
  });

  const countLabel = document.getElementById('todoCountLabel');
  if (countLabel) {
    const totalStatus = byStatus.length;
    if (searchTerm && filtered.length !== totalStatus) {
      countLabel.textContent = `${filtered.length} de ${totalStatus}`;
    } else {
      countLabel.textContent = `${filtered.length} tarea${filtered.length !== 1 ? 's' : ''}`;
    }
  }

  todoUpdateStats(data);

  if (!filtered.length) {
    const msgs = {
      all: 'No hay tareas todavía.<br>Agregá una arriba para empezar.',
      pending: 'Sin tareas pendientes.',
      in_progress: 'Sin tareas en progreso.',
      done: 'Sin tareas completadas.'
    };
    const msg = searchTerm ? 'No hay tareas que coincidan con la búsqueda.' : msgs[todoFilter];
    list.innerHTML = `<div class="empty" style="padding:40px 20px"><div class="empty-ico"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></div><p>${msg}</p></div>`;
    return;
  }

  // Sort: pending + in_progress first (priority order), done at bottom
  const order = { high: 0, medium: 1, low: 2 };
  const statusOrder = { pending: 0, in_progress: 1, done: 2 };
  const sorted = [...filtered].sort((a, b) => {
    const sd = statusOrder[a.status] - statusOrder[b.status];
    if (sd !== 0) return sd;
    return (order[a.priority] ?? 1) - (order[b.priority] ?? 1);
  });

  list.innerHTML = sorted.map(t => todoItemHTML(t)).join('');
}

function todoUpdateStats(data) {
  const pending = data.filter(t => t.status === 'pending').length;
  const progress = data.filter(t => t.status === 'in_progress').length;
  const done = data.filter(t => t.status === 'done').length;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  };
  set('todoStatPending', pending);
  set('todoStatProgress', progress);
  set('todoStatDone', done);
}

function todoItemHTML(t) {
  const priorityLabel = { high: 'Alta', medium: 'Media', low: 'Baja' };
  const statusLabel   = { pending: 'Pendiente', in_progress: 'En progreso', done: 'Hecho' };
  const nextStatus    = { pending: 'in_progress', in_progress: 'done', done: 'pending' };
  const nextLabel     = { pending: 'Iniciar', in_progress: 'Completar', done: 'Reabrir' };

  const isDone = t.status === 'done';
  const isProgress = t.status === 'in_progress';
  const itemClass = isDone ? 'todo-done' : isProgress ? 'todo-inprogress' : '';

  const checkIcon = isDone ? '✓' : isProgress ? '▶' : '';

  let dueHtml = '';
  if (t.due_date) {
    const due = new Date(t.due_date);
    const now = new Date();
    const isOverdue = !isDone && due < now;
    const dateStr = due.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' });
    dueHtml = `<span class="todo-due${isOverdue ? ' overdue' : ''}">${dateStr}</span>`;
  }

  const descHtml = t.description
    ? `<div class="todo-desc">${escHtml(t.description)}</div>`
    : '';

  return `<div class="todo-item ${itemClass}" id="todo-${t.id}">
    <button class="todo-check" onclick="todoCycleStatus('${t.id}')" title="Cambiar estado">${checkIcon}</button>
    <div class="todo-body">
      <div class="todo-title">${escHtml(t.title)}</div>
      ${descHtml}
      <div class="todo-meta">
        <span class="todo-priority ${t.priority}">${priorityLabel[t.priority] || t.priority}</span>
        <span class="todo-status-pill ${t.status}">${statusLabel[t.status] || t.status}</span>
        ${dueHtml}
        <button class="todo-cycle-btn" onclick="todoCycleStatus('${t.id}')">${nextLabel[t.status]}</button>
      </div>
    </div>
    <div class="todo-actions">
      <button class="todo-action-btn del" onclick="todoDelete('${t.id}')" title="Eliminar">✕</button>
    </div>
  </div>`;
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function todoAdd() {
  const title = document.getElementById('todoTitle').value.trim();
  if (!title) {
    const msg = document.getElementById('todoAddMsg');
    msg.style.color = 'var(--red)';
    msg.textContent = 'El título es obligatorio.';
    setTimeout(() => msg.textContent = '', 2000);
    return;
  }
  const todo = {
    title,
    description: document.getElementById('todoDesc').value.trim() || null,
    priority:    document.getElementById('todoPriority').value,
    status:      document.getElementById('todoStatus').value,
    due_date:    document.getElementById('todoDueDate').value || null
  };
  const btn = document.getElementById('todoAddSubmit');
  if (btn) btn.disabled = true;
  try {
    const r = await api.todosAdd(todo);
    if (btn) btn.disabled = false;
    if (!r.ok) {
      const msg = document.getElementById('todoAddMsg');
      msg.style.color = 'var(--red)';
      msg.textContent = 'Error: ' + (r.error || 'Revisá la conexión con Supabase.');
      return;
    }
    document.getElementById('todoTitle').value = '';
    document.getElementById('todoDesc').value = '';
    document.getElementById('todoDueDate').value = '';
    document.getElementById('todoPriority').value = 'medium';
    document.getElementById('todoStatus').value = 'pending';
    // Notificar al dropdown custom (.uisel) que el valor cambió por código
    ['todoPriority', 'todoStatus'].forEach((id) => {
      document.getElementById(id).dispatchEvent(new Event('change'));
    });
    document.getElementById('todoAddMsg').textContent = '';
    todosData.unshift(r.data);
    todoRender(todosData);
    todoUpdateBadge();
    todoCloseModal();
    toast('Tarea agregada', 'ok');
  } catch (e) {
    if (btn) btn.disabled = false;
    toast('Error al agregar tarea', 'err');
  }
}

// ── Modal nueva tarea ─────────────────────────────────────────
function todoOpenModal() {
  const m = document.getElementById('todoModal');
  if (!m) return;
  document.getElementById('todoAddMsg').textContent = '';
  m.classList.remove('hidden');
  document.addEventListener('keydown', _todoModalEscClose);
  setTimeout(() => document.getElementById('todoTitle')?.focus(), 40);
}

function todoCloseModal() {
  const m = document.getElementById('todoModal');
  if (!m) return;
  m.classList.add('hidden');
  document.removeEventListener('keydown', _todoModalEscClose);
}

function _todoModalEscClose(e) {
  if (e.key === 'Escape') todoCloseModal();
}

async function todoCycleStatus(id) {
  const next = { pending: 'in_progress', in_progress: 'done', done: 'pending' };
  const todo = todosData.find(t => t.id === id);
  if (!todo) return;
  const newStatus = next[todo.status] || 'pending';
  todo.status = newStatus;
  todo.updated_at = new Date().toISOString();
  todoRender(todosData);
  todoUpdateBadge();
  await api.todosUpdate(id, { status: newStatus }, todo.title);
}

async function todoDelete(id) {
  const todo = todosData.find(t => t.id === id);
  const nombre = todo ? `"${todo.title}"` : 'esta tarea';
  showModal(
    'Eliminar tarea',
    `<div style="font-size:12px;color:var(--text2);line-height:1.7">¿Eliminar ${escHtml(nombre)}?<br><span style="color:#f87171">Esta acción no se puede deshacer.</span></div>` +
    `<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doTodoDelete('${id}')">Sí, eliminar</button>`
  );
}

async function _doTodoDelete(id) {
  try {
    const r = await api.todosDelete(id);
    if (!r.ok) { toast('Error al eliminar', 'err'); return; }
    todosData = todosData.filter(t => t.id !== id);
    todoRender(todosData);
    todoUpdateBadge();
    toast('Tarea eliminada', 'ok');
  } catch (e) {
    toast('Error al eliminar', 'err');
  }
}

function todoUpdateBadge() {
  const pending = todosData.filter(t => t.status !== 'done').length;
  const badge = document.getElementById('todosBadge');
  if (!badge) return;
  badge.textContent = pending;
  badge.classList.toggle('hidden', pending === 0);
}

api.onKeyOverlayStatus((s) => {
  const tog = document.getElementById('koToggle');
  const statusText = document.getElementById('koStatusText');
  const urlRow = document.getElementById('koUrlRow');
  const localUrlEl = document.getElementById('koUrlInput');
  const lanRow = document.getElementById('koLanUrlRow');
  const lanUrlEl = document.getElementById('koLanUrlInput');
  if (!tog) return;
  tog.checked = s.running;
  if (s.running) {
    const localUrl = s.url || 'http://localhost:9001';
    statusText.textContent = 'Activo en ' + localUrl;
    if (localUrlEl) localUrlEl.textContent = localUrl;
    if (urlRow) urlRow.classList.remove('hidden');
    if (lanRow && lanUrlEl) {
      if (s.lanUrl) {
        lanRow.classList.remove('hidden');
        lanUrlEl.textContent = s.lanUrl;
      } else {
        lanRow.classList.add('hidden');
        lanUrlEl.textContent = '—';
      }
    }
  } else {
    statusText.textContent = s.error ? 'Error: ' + s.error : 'Desactivado';
    if (urlRow) urlRow.classList.add('hidden');
    if (lanRow && lanUrlEl) {
      lanRow.classList.add('hidden');
      lanUrlEl.textContent = '—';
    }
    koPreviewClear();
  }
});
