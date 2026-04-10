// ── Sorteos ────────────────────────────────────────────────────────
async function loadSorteo() {
  try {
    const cmd = document.getElementById('sorteoCmd').value;
    await api.sorteoSetCmd(cmd);
    const data = await api.sorteoGetParticipantes();
    sorteoParticipantes = data || [];
    renderSorteoList();
    loadSorteoHistorial();
  } catch (e) {
    log('warn', 'Error cargando sorteo: ' + (e.message || e));
  }
}

function updateSorteoCmd(val) {
  api.sorteoSetCmd(val.trim() || '!sorteo');
}

async function toggleSorteo() {
  const btn = document.getElementById('sorteoToggleBtn');
  if (btn) btn.disabled = true;
  try {
    sorteoActivo = !sorteoActivo;
    await api.sorteoToggle(sorteoActivo);
    const bar = document.getElementById('sorteoStatusBar');
    const txt = document.getElementById('sorteoStatusTxt');
    bar.classList.toggle('activo', sorteoActivo);
    txt.textContent = sorteoActivo ? 'SORTEO ABIERTO — ANOTANDO PARTICIPANTES' : 'SORTEO CERRADO';
    if (btn) { btn.textContent = sorteoActivo ? 'Cerrar sorteo' : 'Abrir sorteo'; btn.className = sorteoActivo ? 'btn btn-danger' : 'btn btn-orange'; }
    document.getElementById('sorteoBadge').classList.toggle('hidden', !sorteoActivo);
  } catch (e) {
    sorteoActivo = !sorteoActivo;
    toast('Error al cambiar estado del sorteo', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function addSorteoParticipante({nick, joined_at}) {
  if (sorteoParticipantes.find(p => p.nick === nick)) return;
  sorteoParticipantes.push({nick, joined_at});
  renderSorteoList();
}

function renderSorteoList() {
  const list = document.getElementById('sorteoPartList');
  const count = sorteoParticipantes.length;
  document.getElementById('sorteoCountBig').textContent = count;
  document.getElementById('sorteoPartCount').textContent = count;
  document.getElementById('sorteoBadge').textContent = count;
  document.getElementById('sortearBtn').disabled = count === 0;
  if (!count) {
    list.innerHTML = '<div class="empty" style="padding:20px"><div class="empty-ico"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12v10H4V12"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg></div><p>Abrí el sorteo · la gente escribe el comando para entrar</p></div>';
    return;
  }
  list.innerHTML = sorteoParticipantes.map((p,i) => {
    const t = new Date(p.joined_at);
    const time = t.toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
    return `<div class="sorteo-part-row">
      <span class="sorteo-part-num">${i+1}</span>
      <span class="sorteo-part-nick">${p.nick}</span>
      <span class="sorteo-part-time">${time}</span>
    </div>`;
  }).join('');
}

function filterSorteoList(query) {
  const rows = document.querySelectorAll('#sorteoPartList .sorteo-part-row');
  const term = query.toLowerCase().trim();
  rows.forEach(row => {
    const nick = row.querySelector('.sorteo-part-nick')?.textContent?.toLowerCase() || '';
    row.style.display = (!term || nick.includes(term)) ? '' : 'none';
  });
}

function sortear() {
  if (!sorteoParticipantes.length) return;
  const n = Math.min(sorteoWinCount, sorteoParticipantes.length);
  const pool = [...sorteoParticipantes];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  sorteoCurrentWinners = pool.slice(0, n);
  const medals = ['1°','2°','3°','4°','5°','6°'];
  document.getElementById('sorteoWinnersList').innerHTML = sorteoCurrentWinners.map((w,i) =>
    `<div class="sorteo-winner-item">
      <span class="sorteo-winner-medal">${medals[i]||'—'}</span>
      <span class="sorteo-winner-nick">${w.nick}</span>
    </div>`
  ).join('');
  document.getElementById('sorteoWinnersWrap').classList.remove('hidden');
  document.getElementById('limpiarBtn').textContent = 'Guardar ganadores y limpiar';
}

function limpiarSorteo() {
  const tieneGanadores = sorteoCurrentWinners.length > 0;
  const msg = tieneGanadores
    ? 'Se guardarán los ganadores actuales y se vaciará la lista.'
    : 'Se vaciará la lista de participantes.';
  showModal(
    'Limpiar sorteo',
    `<div style="font-size:12px;color:var(--text2);line-height:1.7">${msg}<br><span style="color:#f87171">Esta acción no se puede deshacer.</span></div>` +
    '<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doLimpiarSorteo()">Sí, limpiar</button>'
  );
}
async function _doLimpiarSorteo() {
  try {
    await api.sorteoGuardarYLimpiar({
      ganadores: sorteoCurrentWinners.map(w => w.nick),
      total: sorteoParticipantes.length
    });
    sorteoParticipantes = [];
    sorteoCurrentWinners = [];
    renderSorteoList();
    document.getElementById('sorteoWinnersWrap').classList.add('hidden');
    document.getElementById('sorteoBadge').textContent = '0';
    document.getElementById('limpiarBtn').textContent = 'Limpiar participantes';
    loadSorteoHistorial();
  } catch (e) {
    toast('Error al limpiar sorteo', 'err');
  }
}

async function loadSorteoHistorial() {
  try {
    const data = await api.sorteoGetHistorial();
    renderSorteoHistorial(data || []);
  } catch (e) {
    log('warn', 'Error cargando historial de sorteos');
  }
}

function renderSorteoHistorial(registros) {
  const wrap = document.getElementById('sorteoHistorialWrap');
  const body = document.getElementById('sorteoHistorialBody');
  if (!registros.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const medals = ['1°','2°','3°','4°'];
  body.innerHTML = registros.map(r => {
    const fecha = new Date(r.fecha);
    const fechaStr = fecha.toLocaleDateString('es-AR', {day:'2-digit',month:'2-digit',year:'numeric'});
    const horaStr  = fecha.toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit'});
    const gans = (r.ganadores||[]).map((g,i) => `<span style="color:var(--gold);font-weight:700">${medals[i]||'—'} ${g}</span>`).join('  ');
    return `<tr>
      <td style="color:var(--text2)">${fechaStr}</td>
      <td style="color:var(--text3);font-size:11px">${horaStr}</td>
      <td>${gans}</td>
      <td style="color:var(--text3);text-align:center">${r.total||'—'}</td>
    </tr>`;
  }).join('');
}

