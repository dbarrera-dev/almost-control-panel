// ── 1v1 Duelos ────────────────────────────────────────────────────
let duelos = [];

function _renderDuelosData() {
  const pending = duelos.filter(d => !d.done);
  const done    = duelos.filter(d =>  d.done);

  document.getElementById('dueloPendCount').textContent = pending.length ? `(${pending.length})` : '';
  document.getElementById('dueloDoneCount').textContent = done.length    ? `(${done.length})`    : '';

  const mkItem = (d) => {
    const dateStr = new Date(d.added_at).toLocaleDateString('es',{day:'2-digit',month:'short'});
    const checkLabel = d.done ? '↩ Pendiente' : '✓ Listo';
    return `<div class="duelo-item${d.done?' done':''}" id="di-${d.id}">
      <div class="duelo-av">${d.nick[0].toUpperCase()}</div>
      <div class="duelo-nick">${d.nick}</div>
      <div class="duelo-date">${dateStr}</div>
      <button class="duelo-check" onclick="toggleDuelo(${d.id},${d.done},'${d.nick.replace(/'/g,"\\'")}')">${checkLabel}</button>
      <button class="duelo-del" onclick="deleteDuelo(${d.id})" title="Eliminar">✕</button>
    </div>`;
  };

  const pendEl = document.getElementById('dueloPendList');
  const doneEl = document.getElementById('dueloDoneList');
  pendEl.innerHTML = pending.length ? pending.map(mkItem).join('') : `<div class="duelo-empty">Sin pendientes</div>`;
  doneEl.innerHTML = done.length    ? done.map(mkItem).join('')    : `<div class="duelo-empty" style="padding:12px">—</div>`;

  _updateDueloBadge(pending.length);
}

function _updateDueloBadge(count) {
  if (count === undefined) count = duelos.filter(d => !d.done).length;
  const badge = document.getElementById('dueloBadge');
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
}

async function renderDuelos() {
  try {
    const r = await api.duelosGet();
    duelos = r.data || [];
    _renderDuelosData();
  } catch(e) {
    console.error('renderDuelos error:', e);
  }
}

async function addDuelo() {
  const inp = document.getElementById('dueloInput');
  const nick = inp.value.trim();
  if (!nick) return;
  try {
    const r = await api.duelosAdd(nick);
    if (r.ok) { inp.value = ''; inp.focus(); await renderDuelos(); }
    else { log('warn', 'Error duelo: ' + (r.error || 'sin conexión a Supabase')); }
  } catch (e) {
    toast('Error al agregar duelo', 'err');
  }
}

async function toggleDuelo(id, currentDone, nick) {
  await api.duelosToggle(id, !currentDone, nick);
  await renderDuelos();
}

let _deleteDueloId = null;
function deleteDuelo(id) {
  _deleteDueloId = id;
  showModal(
    'Eliminar duelo',
    '<div style="font-size:12px;color:var(--text2);line-height:1.7">¿Eliminar este duelo?<br><span style="color:#f87171">Esta acción no se puede deshacer.</span></div>' +
    '<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doDeleteDuelo()">Sí, eliminar</button>'
  );
}
async function _doDeleteDuelo() {
  if (_deleteDueloId === null) return;
  await api.duelosDelete(_deleteDueloId);
  await renderDuelos();
}

