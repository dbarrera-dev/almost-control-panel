// ── Torneo ────────────────────────────────────────────────────────
async function restaurarTorneoActivo() {
  try {
    const r = await api.getTorneoActivo();
    if (!r.ok) return;
  const { torneo, participantes } = r;
  torneoId = torneo.id;
  pCount = participantes.length;
  joins = participantes.length;
  pEmpty = participantes.length === 0;
  document.getElementById('noT').classList.add('hidden');
  document.getElementById('actT').classList.remove('hidden');
  document.getElementById('tNombreA').textContent = torneo.nombre;
  document.getElementById('pList').innerHTML = pEmpty
    ? `<div class="empty" style="padding:16px"><div class="empty-ico"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div><p>Esperando !join en el chat</p></div>`
    : '';
  participantes.forEach(p => addP(p.nick, p.joined_at));
  updateStats();
  log('info', `Torneo "${torneo.nombre}" restaurado (${pCount} participantes)`);
  loadHistorial();
  } catch (e) {
    log('warn', 'Error restaurando torneo: ' + (e.message || e));
  }
}

async function crearTorneo() {
  const nombre=document.getElementById('tNombre').value.trim();
  if(!nombre) return;
  const maxVal = parseInt(document.getElementById('tMax').value) || 0;
  const btn = document.querySelector('#noT .btn-orange');
  if (btn) { btn.disabled = true; btn.textContent = 'Creando...'; }
  try {
    const r=await api.crearTorneo({ nombre, maxParticipantes: maxVal });
    if (btn) { btn.disabled = false; btn.textContent = 'Crear Torneo'; }
    if(!r.ok){log('warn','Error: '+r.error);return;}
    torneoId=r.torneo.id; pCount=0; joins=0; pEmpty=true;
    document.getElementById('noT').classList.add('hidden');
    document.getElementById('actT').classList.remove('hidden');
    document.getElementById('tNombreA').textContent=nombre;
    document.getElementById('pList').innerHTML=`<div class="empty" style="padding:16px"><div class="empty-ico"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div><p>Esperando !join en el chat</p></div>`;
    document.getElementById('eResult').classList.add('hidden');
    updateStats();
    const maxMsg = maxVal > 0 ? ` · límite: ${maxVal} jugadores` : '';
    log('info',`Torneo "${nombre}" creado${maxMsg}`);
    loadHistorial();
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Crear Torneo'; }
    toast('Error al crear torneo', 'err');
  }
}

function confirmarGenerarEquipos() {
  if (!torneoId) return;
  if (equiposData.length > 0) {
    showModal(
      'Regenerar equipos',
      '<div style="font-size:12px;color:var(--text2);line-height:1.7">Ya hay equipos generados.<br><span style="color:#f87171">¿Regenerar? Esto borrará el sorteo actual.</span></div>' +
      '<button class="btn btn-orange" style="width:100%;margin-top:14px" onclick="generarEquipos();closeModal()">Sí, regenerar</button>'
    );
  } else {
    showModal(
      'Sortear equipos',
      '<div style="font-size:12px;color:var(--text2);line-height:1.7">Se van a generar equipos con los <strong style="color:var(--text)">' + pCount + '</strong> participantes actuales.</div>' +
      '<button class="btn btn-orange" style="width:100%;margin-top:14px" onclick="generarEquipos();closeModal()">Sortear</button>'
    );
  }
}

async function cerrarTorneo() {
  showModal(
    'Cerrar torneo',
    '<div style="font-size:12px;color:var(--text2);line-height:1.7">¿Cerrar el torneo activo?<br><span style="color:#f87171">Quedará registrado como finalizado en el historial.</span></div>' +
    '<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doCerrarTorneo()">Sí, cerrar</button>'
  );
}
async function _doCerrarTorneo() {
  await api.cerrarTorneoDb(torneoId);
  torneoId=null; pCount=0; joins=0;
  document.getElementById('noT').classList.remove('hidden');
  document.getElementById('actT').classList.add('hidden');
  document.getElementById('tNombre').value='';
  document.getElementById('tMax').value='';
  document.getElementById('tbadge').classList.add('hidden');
  log('info','Torneo cerrado');
  loadHistorial();
}

function updateStats() {
  document.getElementById('sN').textContent=pCount;
  document.getElementById('sJ').textContent=joins;
  document.getElementById('pCount').textContent=pCount;
  document.getElementById('tbadge').textContent=pCount;
  if(pCount>0) document.getElementById('tbadge').classList.remove('hidden');
  const sz=parseInt(document.getElementById('tSizeVal').value)||2;
  document.getElementById('sE').textContent=pCount>0?Math.ceil(pCount/sz):'—';
  document.getElementById('tSubA').textContent=pCount===0?'Esperando participantes...':`${pCount} jugadores · !join activo`;
}

const COLORS=['#D96B00','#0891b2','#059669','#d97706','#7c3aed','#0e7490','#dc2626','#047857'];
function getColor(nick){let h=0;for(let c of nick)h+=c.charCodeAt(0);return COLORS[h%COLORS.length];}

function _h(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _pRowId(nick) {
  return 'p-' + encodeURIComponent(String(nick || '').trim());
}

function addP(nick, joinedAt, senderNick) {
  const safeNick = String(nick || '').trim();
  if (!safeNick) return;
  const list=document.getElementById('pList');
  if(pEmpty){list.innerHTML='';pEmpty=false;}
  const rowId = _pRowId(safeNick);
  if (document.getElementById(rowId)) return;

  const item=document.createElement('div'); item.className='pitem'; item.id=rowId; item.dataset.nick = safeNick;
  const t=joinedAt?new Date(joinedAt).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'';

  const pav = document.createElement('div');
  pav.className = 'pav';
  pav.style.background = getColor(safeNick);
  pav.textContent = (safeNick[0] || '?').toUpperCase();

  const pnick = document.createElement('div');
  pnick.className = 'pnick';
  if (senderNick && senderNick !== safeNick) {
    const tw = document.createElement('span');
    tw.style.color = 'var(--text3)';
    tw.style.fontWeight = '400';
    tw.textContent = senderNick;
    const sep = document.createElement('span');
    sep.style.color = 'var(--text3)';
    sep.style.fontWeight = '400';
    sep.textContent = ' : ';
    pnick.appendChild(tw);
    pnick.appendChild(sep);
    pnick.appendChild(document.createTextNode(safeNick));
  } else {
    pnick.textContent = safeNick;
  }

  const ptime = document.createElement('div');
  ptime.className = 'ptime';
  ptime.textContent = t;

  const rmBtn = document.createElement('button');
  rmBtn.className = 'prm';
  rmBtn.title = 'Eliminar';
  rmBtn.textContent = '✕';
  rmBtn.onclick = () => elimP(safeNick);

  item.appendChild(pav);
  item.appendChild(pnick);
  item.appendChild(ptime);
  item.appendChild(rmBtn);
  list.insertBefore(item,list.firstChild);
}

function removeP(nick) {
  const el=document.getElementById(_pRowId(nick));
  if(el){el.style.opacity='0';el.style.transform='translateX(10px)';el.style.transition='all .2s';setTimeout(()=>el.remove(),200);}
}

let _elimPNick = null;
function elimP(nick) {
  if(!torneoId) return;
  _elimPNick = nick;
  showModal(
    'Eliminar participante',
    `<div style="font-size:12px;color:var(--text2);line-height:1.7">¿Eliminar a <strong style="color:var(--text)">${_h(nick)}</strong> del torneo?</div>` +
    '<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doElimP()">Sí, eliminar</button>'
  );
}
async function _doElimP() {
  const nick = _elimPNick;
  if(!nick || !torneoId) return;
  const r = await api.eliminarParticipante({nick, torneoId});
  if (!r?.ok) {
    toast('No se pudo eliminar participante', 'err');
    log('warn', 'Error al eliminar participante: ' + (r?.error || 'desconocido'));
    return;
  }
  removeP(nick); pCount=Math.max(0,pCount-1); updateStats();
  log('warn',`${nick} eliminado manualmente`);
}


// ── Gestión de participantes ─────────────────────────
function filterParticipantes(q) {
  const items = document.querySelectorAll('#pList .pitem');
  const term = q.toLowerCase().trim();
  items.forEach(el => {
    const text = el.querySelector('.pnick')?.textContent?.toLowerCase() || '';
    el.style.display = (!term || text.includes(term)) ? '' : 'none';
  });
}

function exportarParticipantes() {
  const items = document.querySelectorAll('#pList .pitem');
  const nicks = [];
  items.forEach(el => {
    const nick = (el.dataset.nick || '').trim();
    if (nick) nicks.push(nick);
  });
  if (!nicks.length) return;
  navigator.clipboard.writeText(nicks.join('\n'));
  toast('✓ ' + nicks.length + ' nicks copiados', 'ok');
}

// ── Gestión de equipos ───────────────────────────────
let equiposData = [];

function exportarEquipos() {
  if (!equiposData.length) return;
  const txt = equiposData.map((eq, i) =>
    'Equipo ' + (i+1) + ':\n' + eq.members.map(m => '  ' + m).join('\n')
  ).join('\n\n');
  navigator.clipboard.writeText(txt);
  toast('✓ Equipos copiados', 'ok');
}

function moverJugador(nick, fromIdx) {
  const nickEnc = encodeURIComponent(String(nick || ''));
  const opts = equiposData.map(function(eq, i) {
    if (i === fromIdx) return '';
    const preview = eq.members.slice(0,3).join(', ') + (eq.members.length > 3 ? '...' : '');
    return '<button class="btn btn-ghost" data-to="' + i + '" data-nick="' + nickEnc + '" data-from="' + fromIdx + '" onclick="confirmarMover(decodeURIComponent(this.dataset.nick),+this.dataset.from,+this.dataset.to);closeModal()" style="width:100%;margin-bottom:6px;justify-content:flex-start;gap:10px">' +
      '<span>Equipo ' + (i+1) + '</span>' +
      '<span style="color:var(--text3);font-size:11px;margin-left:auto;font-weight:400">' + _h(preview) + '</span>' +
      '</button>';
  }).join('');
  showModal(
    'Mover jugador',
    '<div style="font-size:11px;color:var(--text2);margin-bottom:12px">¿A qué equipo mover a <strong style="color:var(--orange2)">' + _h(nick) + '</strong>?</div>' + opts
  );
}

function confirmarMover(nick, fromIdx, toIdx) {
  equiposData[fromIdx].members = equiposData[fromIdx].members.filter(m => m !== nick);
  equiposData[toIdx].members.push(nick);
  renderEquiposGrid();
  log('info', nick + ' movido a Equipo ' + (toIdx+1));
}

function renderEquiposGrid() {
  const grid = document.getElementById('tGrid');
  grid.innerHTML = '';
  equiposData.forEach(function(eq, i) {
    const c = document.createElement('div');
    c.className = 'tcard';
    const members = eq.members.map(function(m) {
      const nickEnc = encodeURIComponent(String(m || ''));
      const btn = equiposData.length > 1
        ? '<button data-nick="' + nickEnc + '" data-from="' + i + '" onclick="moverJugador(decodeURIComponent(this.dataset.nick),+this.dataset.from)" style="background:none;border:none;color:var(--text3);cursor:pointer;font-size:12px;padding:0 3px;opacity:.5;transition:opacity .15s" title="Mover" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.5">⇄</button>'
        : '';
      return '<div class="tmember" style="justify-content:space-between"><span>▸ ' + _h(m) + '</span>' + btn + '</div>';
    }).join('');
    c.innerHTML = '<div class="thead-c">Equipo ' + (i+1) + '</div><div class="tmembers">' + members + '</div>';
    grid.appendChild(c);
  });
}

// ── Modal helper ─────────────────────────────────────
function showModal(title, content) {
  let m = document.getElementById('gModal');
  if (!m) {
    m = document.createElement('div');
    m.id = 'gModal';
    m.style.cssText = 'position:fixed;inset:0;z-index:9990;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(4px)';
    m.onclick = function(e) { if (e.target === m) closeModal(); };
    document.body.appendChild(m);
  }
  const inner = document.createElement('div');
  inner.style.cssText = 'background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:22px 24px;min-width:300px;max-width:420px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,.6)';
  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-family:Bebas Neue,cursive;font-size:18px;letter-spacing:2px;color:var(--text);margin-bottom:16px';
  titleEl.textContent = title;
  const bodyEl = document.createElement('div');
  bodyEl.innerHTML = content;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.style.cssText = 'width:100%;margin-top:8px';
  cancelBtn.textContent = 'Cancelar';
  cancelBtn.onclick = closeModal;
  inner.appendChild(titleEl);
  inner.appendChild(bodyEl);
  inner.appendChild(cancelBtn);
  m.innerHTML = '';
  m.appendChild(inner);
  m.style.display = 'flex';
}

function closeModal() {
  const m = document.getElementById('gModal');
  if (m) m.style.display = 'none';
}

async function generarEquipos() {
  if(!torneoId) return;
  const tamanio=parseInt(document.getElementById('tSizeVal').value)||2;
  const r=await api.generarEquipos({torneoId,tamanio});
  if(!r.ok){log('warn',r.error||'Sin participantes');return;}
  const equipos = Array.isArray(r.equipos) ? r.equipos : (Array.isArray(r.teams) ? r.teams : []);
  if(!equipos.length){log('warn','No se pudieron generar equipos');return;}
  const grid=document.getElementById('tGrid'); grid.innerHTML='';
  equiposData = equipos.map((ms, i) => ({ nombre: 'Equipo ' + (i+1), members: ms }));
  renderEquiposGrid();
  document.getElementById('eResult').classList.remove('hidden');
  log('info', equipos.length + ' equipos generados');
}

async function loadHistorial() {
  const ts=await api.getTorneos();
  const tbody=document.getElementById('hBody');
  if(!ts.length){tbody.innerHTML=`<tr><td colspan="5" style="text-align:center;padding:20px;color:var(--text3);font-size:11px">Sin torneos todavía</td></tr>`;return;}
  tbody.innerHTML=ts.map(t=>{
    const f=new Date(t.creado_at).toLocaleDateString('es',{day:'2-digit',month:'short',year:'numeric'});
    const cnt=t.participantes?.[0]?.count??'—';
    const badge=t.activo?`<span class="badge badge-on">● Activo</span>`:`<span class="badge badge-off">Finalizado</span>`;
    const delBtn = t.activo ? '' : `<button class="btn btn-danger" style="padding:4px 10px;font-size:10px;margin-left:4px" onclick="eliminarTorneoHistorial('${t.id}','${encodeURIComponent(String(t.nombre || ''))}')">Eliminar</button>`;
    return `<tr id="hr-${t.id}"><td style="font-weight:700">${_h(t.nombre)}</td><td style="color:var(--text2);font-size:11px">${f}</td><td>${badge}</td><td style="color:var(--orange2);font-family:'Bebas Neue',cursive;font-size:20px">${cnt}</td><td style="white-space:nowrap"><button class="btn btn-ghost" style="padding:4px 10px;font-size:10px" onclick="verT('${t.id}')">Ver</button>${delBtn}</td></tr><tr id="hd-${t.id}" class="h-detail hidden"><td colspan="5"><div id="hp-${t.id}" class="h-ptags"></div></td></tr>`;
  }).join('');
}

async function verT(id) {
  const detailRow=document.getElementById('hd-'+id);
  if(!detailRow) return;
  const isOpen=!detailRow.classList.contains('hidden');
  if(isOpen){detailRow.classList.add('hidden');return;}
  const container=document.getElementById('hp-'+id);
  container.innerHTML=`<span style="font-size:11px;color:var(--text3)">Cargando...</span>`;
  detailRow.classList.remove('hidden');
  const ps=await api.getParticipantes(id);
  if(!ps.length){container.innerHTML=`<span style="font-size:11px;color:var(--text3)">Sin participantes</span>`;return;}
  container.innerHTML=ps.map(p=>`<span class="h-ptag">${p.nick}</span>`).join('');
}

let _delTorneoId=null, _delTorneoNombre='';
async function eliminarTorneoHistorial(id, nombreEnc) {
  let nombre = '';
  try { nombre = decodeURIComponent(String(nombreEnc || '')); }
  catch { nombre = String(nombreEnc || ''); }
  _delTorneoId=id; _delTorneoNombre=nombre;
  showModal(
    'Eliminar torneo',
    `<div style="font-size:12px;color:var(--text2);line-height:1.7">¿Eliminar <strong style="color:var(--text)">"${_h(nombre)}"</strong>?<br><span style="color:#f87171">Se borran todos sus participantes y equipos permanentemente.</span></div>` +
    '<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doEliminarTorneo()">Sí, eliminar</button>'
  );
}
async function _doEliminarTorneo() {
  const id=_delTorneoId, nombre=_delTorneoNombre;
  const r = await api.eliminarTorneo(id);
  if(!r.ok){
    log('warn','Error al eliminar torneo: '+(r.error||'desconocido'));
    if(r.errors?.length) r.errors.forEach(e=>log('warn','  → '+e));
    return;
  }
  if(r.warnings?.length) r.warnings.forEach(e=>log('warn','Advertencia: '+e));
  document.getElementById('hr-'+id)?.remove();
  document.getElementById('hd-'+id)?.remove();
  log('info',`Torneo "${nombre}" eliminado`);
}
