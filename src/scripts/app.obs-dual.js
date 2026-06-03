// ── OBS Dual ──────────────────────────────────────────────────────────────────

// ── State ──────────────────────────────────────────────────────────────────────
const odState = {
  h: { connected: false, scene: null, scenes: [], streaming: false, recording: false, reconnectAttempts: 0 },
  v: { connected: false, scene: null, scenes: [], streaming: false, recording: false, reconnectAttempts: 0 },
  syncEnabled: true,
  sceneMap: {},          // { "H scene": "V scene" }
  dirty: { h: false, v: false },
};

// ── Init ──────────────────────────────────────────────────────────────────────
async function loadObsDual() {
  await odLoadConfig();
  await odRefreshStatus();

  // Register events (idempotent: safe to call on each tab open)
  if (!window._odEventsRegistered) {
    window._odEventsRegistered = true;

    api.onObsDualStatus(data => {
      odApplyStatus(data);
    });

    api.onObsDualSceneChanged(({ side, scene }) => {
      odState[side].scene = scene;
      odRenderSceneDisplay(side);
      odFlashSync(side);
    });

    api.onObsDualStreamState(({ side, active, state: st }) => {
      odState[side].streaming = active;
      odRenderMediaChips(side);
    });

    api.onObsDualRecordState(({ side, active }) => {
      odState[side].recording = active;
      odRenderMediaChips(side);
    });
  }

  // Init remote control section
  await loadObsDualRemote();
}

// ── Config ────────────────────────────────────────────────────────────────────
async function odLoadConfig() {
  try {
    const r = await api.obsDualGetConfig();
    if (!r.ok) return;

    document.getElementById('od-h-addr').value       = r.hAddress    || 'ws://127.0.0.1:4455';
    document.getElementById('od-h-pass').value       = r.hPassword   || '';
    document.getElementById('od-h-profile').value    = r.hProfile    || '';
    document.getElementById('od-h-collection').value = r.hCollection || '';
    document.getElementById('od-h-exe').value        = r.hExePath    || '';

    document.getElementById('od-v-addr').value       = r.vAddress    || 'ws://127.0.0.1:4456';
    document.getElementById('od-v-pass').value       = r.vPassword   || '';
    document.getElementById('od-v-profile').value    = r.vProfile    || '';
    document.getElementById('od-v-collection').value = r.vCollection || '';
    document.getElementById('od-v-exe').value        = r.vExePath    || '';

    odState.syncEnabled = r.syncEnabled !== false;
    document.getElementById('odSyncToggle').checked = odState.syncEnabled;

    odState.sceneMap = r.sceneMap || {};
    odRenderMap();
    odUpdateAddrs();
    odState.dirty = { h: false, v: false };
  } catch (e) {
    log('warn', 'OBS Dual: error cargando config: ' + (e.message || e));
  }
}

function odMarkDirty(side) {
  odState.dirty[side] = true;
}

async function odSaveConfig(side) {
  const data = {};
  if (side === 'h') {
    data.hAddress    = document.getElementById('od-h-addr').value.trim();
    data.hPassword   = document.getElementById('od-h-pass').value;
    data.hProfile    = document.getElementById('od-h-profile').value.trim();
    data.hCollection = document.getElementById('od-h-collection').value.trim();
    data.hExePath    = document.getElementById('od-h-exe').value.trim();
  } else {
    data.vAddress    = document.getElementById('od-v-addr').value.trim();
    data.vPassword   = document.getElementById('od-v-pass').value;
    data.vProfile    = document.getElementById('od-v-profile').value.trim();
    data.vCollection = document.getElementById('od-v-collection').value.trim();
    data.vExePath    = document.getElementById('od-v-exe').value.trim();
  }
  try {
    const r = await api.obsDualSaveConfig(data);
    if (r.ok) {
      toast('Configuración guardada', 'ok');
      odState.dirty[side] = false;
      odUpdateAddrs();
    } else {
      toast('Error al guardar: ' + (r.error || '?'), 'err');
    }
  } catch (e) {
    toast('Error: ' + (e.message || e), 'err');
  }
}

function odUpdateAddrs() {
  const hAddr = document.getElementById('od-h-addr').value || 'ws://127.0.0.1:4455';
  const vAddr = document.getElementById('od-v-addr').value || 'ws://127.0.0.1:4456';
  document.getElementById('od-addr-h').textContent = hAddr;
  document.getElementById('od-addr-v').textContent = vAddr;
}

// ── Status Rendering ──────────────────────────────────────────────────────────
async function odRefreshStatus() {
  try {
    const r = await api.obsDualGetStatus();
    if (r.ok) odApplyStatus(r);
    await odRefreshStreamRecord('h');
    await odRefreshStreamRecord('v');
  } catch {}
}

function odApplyStatus(data) {
  for (const side of ['h', 'v']) {
    const s = data[side];
    if (!s) continue;
    odState[side].connected = s.connected;
    odState[side].scene     = s.scene;
    odState[side].scenes    = s.scenes || [];
    odState[side].reconnectAttempts = s.reconnectAttempts || 0;
    odRenderCard(side);
  }
  if (data.syncEnabled !== undefined) {
    odState.syncEnabled = data.syncEnabled;
    document.getElementById('odSyncToggle').checked = odState.syncEnabled;
  }
  odUpdateMapSelects();
}

function odRenderCard(side) {
  const s = odState[side];
  const card   = document.getElementById(`od-card-${side}`);
  const status = document.getElementById(`od-status-${side}`);
  const label  = document.getElementById(`od-status-label-${side}`);
  const reconn = document.getElementById(`od-reconnect-${side}`);
  const reconnNum = document.getElementById(`od-reconnect-num-${side}`);

  card.classList.toggle('connected',  s.connected);
  card.classList.toggle('connecting', !s.connected && s.reconnectAttempts > 0);

  if (s.connected) {
    status.className = 'od-inst-status on';
    label.textContent = 'Conectado';
  } else if (s.reconnectAttempts > 0) {
    status.className = 'od-inst-status';
    label.textContent = 'Reconectando…';
  } else {
    status.className = 'od-inst-status';
    label.textContent = 'Desconectado';
  }

  reconn.classList.toggle('hidden', !(!s.connected && s.reconnectAttempts > 0));
  if (reconnNum) reconnNum.textContent = s.reconnectAttempts;

  odRenderSceneDisplay(side);
  odRenderSceneButtons(side);
  odRenderMediaChips(side);
}

function odRenderSceneDisplay(side) {
  const s = odState[side];
  const el = document.getElementById(`od-scene-${side}`);
  const badge = document.getElementById(`od-syncbadge-${side}`);

  if (s.connected && s.scene) {
    el.textContent = s.scene;
    el.className = 'od-scene-name';
  } else if (s.connected) {
    el.textContent = 'Sin escena activa';
    el.className = 'od-scene-empty';
  } else {
    el.textContent = 'Sin conexión';
    el.className = 'od-scene-empty';
  }

  // Show sync badge if sync is enabled and there's a mapping
  const targetSide = side === 'h' ? 'v' : 'h';
  const isMapped = s.scene && (
    side === 'h' ? !!odState.sceneMap[s.scene] : !!odGetReverseMap()[s.scene]
  );
  badge.classList.toggle('hidden', !(odState.syncEnabled && isMapped && odState[targetSide].connected));
}

function odRenderSceneButtons(side) {
  const s = odState[side];
  const container = document.getElementById(`od-scenes-${side}`);

  if (!s.connected || !s.scenes.length) {
    container.innerHTML = `<div class="od-empty" style="width:100%">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/></svg>
      ${s.connected ? 'Sin escenas en esta instancia' : 'Conectate para ver las escenas'}
    </div>`;
    return;
  }

  container.innerHTML = s.scenes.map(name => {
    const isActive = name === s.scene;
    const targetSide = side === 'h' ? 'v' : 'h';
    const mapEntry = side === 'h' ? odState.sceneMap[name] : odGetReverseMap()[name];
    const syncDot = mapEntry && odState.syncEnabled && odState[targetSide].connected
      ? `<span style="display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--green);margin-left:5px;vertical-align:middle;"></span>`
      : '';
    return `<button class="od-scene-btn${isActive ? ' active' : ''}" onclick="odSetScene('${side}','${name.replace(/'/g,"\\'")}')">
      ${odEsc(name)}${syncDot}
    </button>`;
  }).join('');
}

function odRenderMediaChips(side) {
  const s = odState[side];
  const streamBtn = document.getElementById(`od-stream-${side}`);
  const recordBtn = document.getElementById(`od-record-${side}`);

  streamBtn.disabled = !s.connected;
  recordBtn.disabled = !s.connected;

  streamBtn.className = `od-media-chip${s.streaming ? ' active-stream' : ''}`;
  recordBtn.className = `od-media-chip${s.recording ? ' active-record' : ''}`;

  streamBtn.innerHTML = `<span class="dot"></span> ${s.streaming ? 'Detener Stream' : 'Iniciar Stream'}`;
  recordBtn.innerHTML = `<span class="dot"></span> ${s.recording ? 'Detener Grab.' : 'Iniciar Grab.'}`;
}

async function odRefreshStreamRecord(side) {
  try {
    const r = await api.obsDualGetStreamRecordStatus(side);
    if (r.ok) {
      odState[side].streaming = r.streaming || false;
      odState[side].recording = r.recording || false;
      odRenderMediaChips(side);
    }
  } catch {}
}

function odFlashSync(side) {
  const badge = document.getElementById(`od-syncbadge-${side}`);
  badge.classList.remove('hidden');
  clearTimeout(badge._syncTimer);
  badge._syncTimer = setTimeout(() => odRenderSceneDisplay(side), 2000);
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function odLaunch(side) {
  const r = await api.obsDualLaunch(side);
  if (r.ok) toast(`OBS ${side === 'h' ? 'Horizontal' : 'Vertical'} lanzado`, 'ok');
  else toast('Error: ' + (r.error || 'No se pudo lanzar OBS'), 'err');
}

async function odLaunchBoth() {
  const r = await api.obsDualLaunchBoth();
  if (r.ok) toast('Ambas instancias de OBS lanzadas', 'ok');
  else toast('Error al lanzar OBS: ' + (r.error || ''), 'err');
}

async function odConnect(side) {
  toast(`Conectando OBS ${side === 'h' ? 'Horizontal' : 'Vertical'}…`, 'ok');
  const r = await api.obsDualConnect(side);
  if (r.ok) toast('Conectado', 'ok');
  else toast('Error: ' + (r.error || 'No se pudo conectar'), 'err');
}

async function odConnectBoth() {
  toast('Conectando a ambas instancias…', 'ok');
  const r = await api.obsDualConnectBoth();
  const msgs = [];
  if (r.h?.ok) msgs.push('Horizontal ✓');
  else if (r.h) msgs.push('Horizontal ✗');
  if (r.v?.ok) msgs.push('Vertical ✓');
  else if (r.v) msgs.push('Vertical ✗');
  toast(msgs.join('  |  ') || 'Error al conectar', r.ok ? 'ok' : 'err');
}

async function odDisconnect(side) {
  await api.obsDualDisconnect(side);
  toast(`OBS ${side === 'h' ? 'Horizontal' : 'Vertical'} desconectado`, 'ok');
}

async function odDisconnectBoth() {
  await api.obsDualDisconnectBoth();
  toast('Ambas instancias desconectadas', 'ok');
}

async function odSetScene(side, sceneName) {
  const r = await api.obsDualSetScene(side, sceneName, true);
  if (!r.ok) toast('Error al cambiar escena: ' + (r.error || '?'), 'err');
}

async function odToggleStream(side) {
  const s = odState[side];
  if (!s.connected) return;
  const r = s.streaming ? await api.obsDualStopStream(side) : await api.obsDualStartStream(side);
  if (r.ok) {
    s.streaming = !s.streaming;
    odRenderMediaChips(side);
  } else {
    toast('Error: ' + (r.error || '?'), 'err');
  }
}

async function odToggleRecord(side) {
  const s = odState[side];
  if (!s.connected) return;
  const r = s.recording ? await api.obsDualStopRecord(side) : await api.obsDualStartRecord(side);
  if (r.ok) {
    s.recording = !s.recording;
    odRenderMediaChips(side);
  } else {
    toast('Error: ' + (r.error || '?'), 'err');
  }
}

async function odToggleSync(val) {
  odState.syncEnabled = val;
  document.getElementById('odSyncToggle').checked = val;
  await api.obsDualSetSync(val);
  toast(val ? 'Sync de escenas activado' : 'Sync de escenas desactivado', 'ok');
  // Re-render to update sync badges
  odRenderSceneDisplay('h');
  odRenderSceneDisplay('v');
  odRenderSceneButtons('h');
  odRenderSceneButtons('v');
}

// ── Settings toggle ───────────────────────────────────────────────────────────
function odToggleSettings(side) {
  const toggle = document.getElementById(`od-stoggle-${side}`);
  const body   = document.getElementById(`od-sbody-${side}`);
  toggle.classList.toggle('open');
  body.classList.toggle('open');
}

// ── Scene Map ─────────────────────────────────────────────────────────────────
function odGetReverseMap() {
  const rev = {};
  for (const [k, v] of Object.entries(odState.sceneMap)) rev[v] = k;
  return rev;
}

function odRenderMap() {
  const tbody = document.getElementById('od-map-body');
  const empty = document.getElementById('od-map-empty');
  const wrap  = document.getElementById('od-map-wrap');

  const entries = Object.entries(odState.sceneMap);
  if (!entries.length) {
    empty.style.display = 'flex';
    wrap.style.display  = 'none';
    return;
  }
  empty.style.display = 'none';
  wrap.style.display  = '';

  tbody.innerHTML = entries.map(([h, v]) => `
    <tr>
      <td>
        <select class="od-map-sel" onchange="odUpdateMapEntry('${odEscAttr(h)}','h',this.value)">
          ${odSceneOptions('h', h)}
        </select>
      </td>
      <td class="od-map-arrow">→</td>
      <td>
        <select class="od-map-sel" onchange="odUpdateMapEntry('${odEscAttr(h)}','v',this.value)">
          ${odSceneOptions('v', v)}
        </select>
      </td>
      <td>
        <button class="od-map-del" onclick="odDeleteMapEntry('${odEscAttr(h)}')" title="Eliminar">×</button>
      </td>
    </tr>
  `).join('');
}

function odSceneOptions(side, selected) {
  const scenes = odState[side].scenes;
  if (!scenes.length && selected) {
    return `<option value="${odEscAttr(selected)}" selected>${odEsc(selected)}</option>`;
  }
  const opts = scenes.map(s =>
    `<option value="${odEscAttr(s)}"${s === selected ? ' selected' : ''}>${odEsc(s)}</option>`
  ).join('');
  return `<option value="">— Escena —</option>${opts}`;
}

function odUpdateMapSelects() {
  const selH = document.getElementById('od-map-sel-h');
  const selV = document.getElementById('od-map-sel-v');
  selH.innerHTML = `<option value="">— Escena Horizontal —</option>${odState.h.scenes.map(s => `<option value="${odEscAttr(s)}">${odEsc(s)}</option>`).join('')}`;
  selV.innerHTML = `<option value="">— Escena Vertical —</option>${odState.v.scenes.map(s => `<option value="${odEscAttr(s)}">${odEsc(s)}</option>`).join('')}`;
  odRenderMap(); // re-render table with updated scene lists
}

function odUpdateMapEntry(oldHScene, changedSide, newVal) {
  if (changedSide === 'h') {
    const vScene = odState.sceneMap[oldHScene];
    delete odState.sceneMap[oldHScene];
    if (newVal) odState.sceneMap[newVal] = vScene || '';
  } else {
    odState.sceneMap[oldHScene] = newVal;
  }
  odRenderMap();
}

function odDeleteMapEntry(hScene) {
  delete odState.sceneMap[hScene];
  odRenderMap();
}

function odAddMapEntry() {
  const h = document.getElementById('od-map-sel-h').value;
  const v = document.getElementById('od-map-sel-v').value;
  if (!h || !v) { toast('Seleccioná una escena de cada instancia', 'err'); return; }
  if (odState.sceneMap[h]) { toast(`Ya existe un mapeo para "${h}"`, 'err'); return; }
  odState.sceneMap[h] = v;
  odRenderMap();
  // Reset selects
  document.getElementById('od-map-sel-h').value = '';
  document.getElementById('od-map-sel-v').value = '';
}

async function odSaveMap() {
  try {
    const r = await api.obsDualSaveSceneMap(odState.sceneMap);
    if (r.ok) toast('Mapa de escenas guardado', 'ok');
    else toast('Error al guardar: ' + (r.error || '?'), 'err');
  } catch (e) {
    toast('Error: ' + (e.message || e), 'err');
  }
}

function odAutoMap() {
  const hScenes = odState.h.scenes;
  const vScenes = odState.v.scenes;

  if (!hScenes.length || !vScenes.length) {
    toast('Conectate a ambas instancias primero para auto-mapear', 'err');
    return;
  }

  // Match by exact name first, then by normalized name (lowercase, no whitespace)
  const normalize = s => s.toLowerCase().replace(/[\s_-]+/g, '');
  const vByNorm = {};
  for (const v of vScenes) vByNorm[normalize(v)] = v;

  let mapped = 0;
  for (const h of hScenes) {
    if (odState.sceneMap[h]) continue; // don't overwrite
    const exact = vScenes.find(v => v === h);
    const norm  = vByNorm[normalize(h)];
    const match = exact || norm;
    if (match) {
      odState.sceneMap[h] = match;
      mapped++;
    }
  }

  odRenderMap();
  toast(mapped > 0 ? `${mapped} escena${mapped > 1 ? 's' : ''} mapeadas automáticamente` : 'No se encontraron coincidencias de nombres', mapped > 0 ? 'ok' : 'err');
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function odEsc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function odEscAttr(str) {
  return String(str).replace(/'/g,"\\'").replace(/"/g,'&quot;');
}

// ── OBS Dual Remote Control ───────────────────────────────────────────────────

const odrState = {
  subscribed:     false,
  mode:           'streaming',
  roomId:         '',
  hotkeys:        [],       // [{ scene, side, key }]
  hotkeysEnabled: true,
  hotkeyStatuses: {},       // { 'Alt+1': 'ok'|'conflict' }
  remoteScenes:   [],       // scenes announced by streaming PC
  remoteCurrent:  null,     // current scene on streaming PC
  dirty:          false,
  recordingIdx:   null,     // index of hotkey row being recorded (-1 = add row)
  lastHeartbeat:  null,
};

// ── Init ─────────────────────────────────────────────────────────────────────
async function loadObsDualRemote() {
  await odrLoadConfig();

  if (!window._odrEventsRegistered) {
    window._odrEventsRegistered = true;

    api.onObsDualRemoteStatus(data => {
      odrApplyStatus(data);
    });

    api.onObsDualRemoteAnnounce(data => {
      odrApplyAnnounce(data);
    });

    api.onObsDualRemoteHeartbeat(data => {
      odrState.lastHeartbeat = Date.now();
      odrUpdateHbBadge();
    });

    api.onObsDualRemoteHotkeyFired(({ scene, side, key }) => {
      toast(`Atajo: "${scene}" [${side}] - ${key}`, 'ok');
    });

    api.onObsDualRemoteReconnecting(({ attempt }) => {
      document.getElementById('odr-reconnect').classList.remove('hidden');
      document.getElementById('odr-reconnect-num').textContent = attempt;
    });

    // Keep heartbeat badge updated
    setInterval(odrUpdateHbBadge, 5000);
  }
}

// ── Config ────────────────────────────────────────────────────────────────────
async function odrLoadConfig() {
  try {
    const r = await api.obsDualRemoteGetConfig();
    if (!r.ok) return;

    odrState.mode           = r.mode           || 'streaming';
    odrState.roomId         = r.roomId         || '';
    odrState.hotkeys        = r.hotkeys        || [];
    odrState.hotkeysEnabled = r.hotkeysEnabled !== false;
    odrState.dirty          = false;

    document.getElementById('odr-room-id').value = odrState.roomId;
    document.getElementById('odr-hk-enabled').checked = odrState.hotkeysEnabled;

    odrRenderModeTabs();
    odrRenderHotkeyTable();
    odrUpdateAddSceneSelect();

    // Restore active status
    const st = await api.obsDualRemoteGetStatus();
    if (st.ok) odrApplyStatus(st);

    if (r.enabled) {
      // Was active before — reflect that in UI even before events arrive
      odrApplyStatus({ subscribed: st.subscribed, mode: odrState.mode, roomId: odrState.roomId });
    }
  } catch (e) {
    log('warn', 'OBS Remote: error cargando config: ' + (e.message || e));
  }
}

function odrMarkDirty() {
  odrState.dirty = true;
  document.getElementById('odr-btn-save-cfg').style.display = '';
}

async function odrSaveRemoteConfig() {
  const roomId = document.getElementById('odr-room-id').value.trim();
  const r = await api.obsDualRemoteSaveConfig({ mode: odrState.mode, roomId });
  if (r.ok) {
    odrState.roomId = roomId;
    odrState.dirty  = false;
    document.getElementById('odr-btn-save-cfg').style.display = 'none';
    toast('Configuración guardada', 'ok');
  } else {
    toast('Error: ' + (r.error || '?'), 'err');
  }
}

// ── Status ────────────────────────────────────────────────────────────────────
function odrApplyStatus(data) {
  odrState.subscribed = data.subscribed || false;
  if (data.mode)   odrState.mode   = data.mode;
  if (data.roomId) odrState.roomId = data.roomId;

  if (data.registeredHotkeys) {
    // Update statuses from registered list
    const reg = new Set(data.registeredHotkeys);
    for (const hk of odrState.hotkeys) {
      if (hk.key) odrState.hotkeyStatuses[hk.key] = reg.has(hk.key) ? 'ok' : 'conflict';
    }
  }

  odrRenderStatus();
  odrRenderModeTabs();
  odrRenderHotkeyTable();
}

function odrRenderStatus() {
  const pill  = document.getElementById('odr-status');
  const label = document.getElementById('odr-status-label');
  const btnStart = document.getElementById('odr-btn-start');
  const btnStop  = document.getElementById('odr-btn-stop');
  const reconnect = document.getElementById('odr-reconnect');

  if (odrState.subscribed) {
    pill.className  = 'od-remote-status on';
    label.textContent = odrState.mode === 'gaming' ? 'Gaming — Conectado' : 'Streaming — Conectado';
    btnStart.style.display = 'none';
    btnStop.style.display  = '';
    reconnect.classList.add('hidden');
  } else {
    pill.className  = 'od-remote-status';
    label.textContent = 'Inactivo';
    btnStart.style.display = '';
    btnStop.style.display  = 'none';
  }

  // Show gaming section only in gaming mode
  document.getElementById('odr-gaming-section').style.display =
    odrState.mode === 'gaming' ? '' : 'none';
}

function odrRenderModeTabs() {
  document.getElementById('odr-mode-streaming').classList.toggle('on', odrState.mode === 'streaming');
  document.getElementById('odr-mode-gaming').classList.toggle('on', odrState.mode === 'gaming');
  document.getElementById('odr-gaming-section').style.display = odrState.mode === 'gaming' ? '' : 'none';
}

// ── Mode ──────────────────────────────────────────────────────────────────────
async function odrSetMode(mode) {
  odrState.mode = mode;
  odrRenderModeTabs();
  odrMarkDirty();
  const r = await api.obsDualRemoteSetMode(mode);
  if (!r.ok) toast('Error: ' + (r.error || '?'), 'err');
}

// ── Connect ───────────────────────────────────────────────────────────────────
async function odrStart() {
  // Auto-save config first
  const roomId = document.getElementById('odr-room-id').value.trim();
  if (!roomId) { toast('Configurá el Room ID primero', 'err'); return; }
  await api.obsDualRemoteSaveConfig({ mode: odrState.mode, roomId });
  odrState.roomId = roomId;

  const btn = document.getElementById('odr-btn-start');
  btn.disabled = true; btn.textContent = 'Activando…';
  try {
    const r = await api.obsDualRemoteStart();
    if (r.ok) {
      toast('Control remoto activado', 'ok');
      document.getElementById('odr-reconnect').classList.add('hidden');
    } else {
      toast('Error: ' + (r.error || 'no se pudo activar'), 'err');
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Activar';
  }
}

async function odrStop() {
  await api.obsDualRemoteStop();
  toast('Control remoto desactivado', 'ok');
}

// ── Announce handling (Gaming PC receives) ────────────────────────────────────
function odrApplyAnnounce(data) {
  // Merge scenes from H and V (deduplicated by name)
  const allScenes = new Set();
  if (data.h?.scenes) data.h.scenes.forEach(s => allScenes.add(s));
  if (data.v?.scenes) data.v.scenes.forEach(s => allScenes.add(s));
  odrState.remoteScenes  = [...allScenes];
  odrState.remoteCurrent = data.h?.current || data.v?.current || null;

  odrRenderRemoteScenes();
  odrUpdateAddSceneSelect();
}

function odrRenderRemoteScenes() {
  const grid = document.getElementById('odr-scenes-grid');
  if (!odrState.remoteScenes.length) {
    grid.innerHTML = '<span class="od-remote-scene-empty">Sin escenas disponibles. Pedí el estado para actualizar.</span>';
    return;
  }

  // Build hotkey lookup: scene → key
  const hkMap = {};
  for (const hk of odrState.hotkeys) if (hk.scene && hk.key) hkMap[hk.scene] = hk.key;

  grid.innerHTML = odrState.remoteScenes.map(scene => {
    const isActive = scene === odrState.remoteCurrent;
    const hkBadge  = hkMap[scene] ? `<span class="hk-badge">${odEsc(hkMap[scene])}</span>` : '';
    return `<button class="od-remote-scene-btn${isActive ? ' active' : ''}" onclick="odrSendScene('${odEscAttr(scene)}')">
      ${odEsc(scene)}${hkBadge}
    </button>`;
  }).join('');
}

async function odrRequestState() {
  const r = await api.obsDualRemoteRequestState();
  if (!r.ok) toast('No se pudo pedir el estado (¿conectado?)', 'err');
}

async function odrSendScene(scene) {
  const r = await api.obsDualRemoteSendScene('both', scene);
  if (r.ok) {
    odrState.remoteCurrent = scene;
    odrRenderRemoteScenes();
  } else {
    toast('No se pudo enviar el comando', 'err');
  }
}

// ── Heartbeat badge ───────────────────────────────────────────────────────────
function odrUpdateHbBadge() {
  const badge = document.getElementById('odr-hb-badge');
  if (!odrState.subscribed || odrState.mode !== 'gaming') { badge.classList.add('hidden'); return; }

  if (!odrState.lastHeartbeat) { badge.classList.add('hidden'); return; }
  const secAgo = Math.round((Date.now() - odrState.lastHeartbeat) / 1000);
  badge.classList.remove('hidden');

  if (secAgo < 60) {
    badge.className = 'od-remote-last-hb online';
    badge.textContent = `PC Streaming en linea (${secAgo}s)`;
  } else {
    badge.className = 'od-remote-last-hb';
    badge.textContent = `Ultima senal: ${secAgo}s`;
  }
}

// ── Hotkeys ───────────────────────────────────────────────────────────────────
function odrRenderHotkeyTable() {
  const tbody = document.getElementById('odr-hk-body');
  if (!odrState.hotkeys.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:14px;font-size:11px;font-style:italic">Sin atajos configurados. Agrega uno abajo.</td></tr>`;
    return;
  }

  tbody.innerHTML = odrState.hotkeys.map((hk, idx) => {
    const status = odrState.hotkeyStatuses[hk.key];
    const statusIcon = status === 'ok' ? '<span style="color:var(--green)" title="Registrado">✓</span>'
      : status === 'conflict' ? '<span style="color:var(--red)" title="Puerto en uso">✗</span>'
      : '<span style="color:var(--text3)">—</span>';
    const sideLabel = hk.side === 'h' ? '📺 H' : hk.side === 'v' ? '📱 V' : '↔ Ambos';
    const keyClass = status === 'ok' ? 'ok' : status === 'conflict' ? 'conflict' : '';

    return `<tr>
      <td style="font-size:12px;font-weight:600;color:var(--text)">${odEsc(hk.scene || '-')}</td>
      <td>
        <select class="od-hk-side" onchange="odrUpdateHotkey(${idx},'side',this.value)">
          <option value="both"${hk.side==='both'?' selected':''}>Ambos</option>
          <option value="h"${hk.side==='h'?' selected':''}>Horizontal</option>
          <option value="v"${hk.side==='v'?' selected':''}>Vertical</option>
        </select>
      </td>
      <td>
        <input class="od-key-input ${keyClass}" id="odr-hk-key-${idx}" type="text" readonly
          value="${odEscAttr(hk.key || '')}" placeholder="Click para grabar..."
          onfocus="odrStartRecord(${idx})" onblur="odrStopRecord(${idx})"
          onkeydown="return odrHandleKeyRecord(event,${idx})" />
      </td>
      <td style="text-align:center">${statusIcon}</td>
      <td style="text-align:center">
        <button class="od-map-del" onclick="odrDeleteHotkey(${idx})" title="Eliminar">x</button>
      </td>
    </tr>`;
  }).join('');
}

function odrUpdateAddSceneSelect() {
  const sel = document.getElementById('odr-hk-add-scene');
  // Combine scenes from both OBS instances + remote scenes
  const all = new Set([
    ...odState.h.scenes,
    ...odState.v.scenes,
    ...odrState.remoteScenes,
  ]);
  sel.innerHTML = '<option value="">-- Selecciona una escena --</option>' +
    [...all].map(s => `<option value="${odEscAttr(s)}">${odEsc(s)}</option>`).join('');
}

function odrUpdateHotkey(idx, field, value) {
  if (!odrState.hotkeys[idx]) return;
  odrState.hotkeys[idx][field] = value;
}

function odrDeleteHotkey(idx) {
  odrState.hotkeys.splice(idx, 1);
  odrRenderHotkeyTable();
}

function odrAddHotkey() {
  const scene = document.getElementById('odr-hk-add-scene').value;
  const side  = document.getElementById('odr-hk-add-side').value;
  const key   = document.getElementById('odr-hk-add-key').value.trim();

  if (!scene) { toast('Seleccioná una escena', 'err'); return; }
  if (!key)   { toast('Grabá una tecla primero', 'err'); return; }

  if (odrState.hotkeys.find(h => h.key === key)) {
    toast(`La tecla "${key}" ya esta asignada`, 'err'); return;
  }

  odrState.hotkeys.push({ scene, side, key });
  odrRenderHotkeyTable();

  // Reset add row
  document.getElementById('odr-hk-add-scene').value = '';
  document.getElementById('odr-hk-add-side').value  = 'both';
  document.getElementById('odr-hk-add-key').value   = '';
}

async function odrToggleHotkeys(enabled) {
  odrState.hotkeysEnabled = enabled;
  const r = await api.obsDualRemoteToggleHotkeys(enabled);
  toast(enabled ? 'Atajos activados' : 'Atajos desactivados', 'ok');
  if (r.errors?.length) {
    document.getElementById('odr-hk-errors').textContent =
      'Conflictos: ' + r.errors.map(e => `"${e.key}" (${e.reason})`).join(', ');
    document.getElementById('odr-hk-errors').classList.remove('hidden');
  } else {
    document.getElementById('odr-hk-errors').classList.add('hidden');
  }
  // Update statuses
  if (r.registered !== undefined) {
    const registered = new Set(odrState.hotkeys.slice(0, r.registered).map(h => h.key));
    for (const hk of odrState.hotkeys) {
      if (hk.key) odrState.hotkeyStatuses[hk.key] = enabled && registered.has(hk.key) ? 'ok' : '';
    }
    odrRenderHotkeyTable();
  }
}

async function odrSaveHotkeys() {
  const r = await api.obsDualRemoteSaveHotkeys(odrState.hotkeys);
  if (r.ok) {
    toast(`Atajos guardados y aplicados (${r.registered || 0} activos)`, 'ok');
    document.getElementById('odr-hk-errors').classList.add('hidden');

    // Mark statuses
    const errKeys = new Set((r.errors || []).map(e => e.key));
    for (const hk of odrState.hotkeys) {
      if (!hk.key) continue;
      odrState.hotkeyStatuses[hk.key] = errKeys.has(hk.key) ? 'conflict' : 'ok';
    }

    if (r.errors?.length) {
      document.getElementById('odr-hk-errors').textContent =
      'Conflictos: ' + r.errors.map(e => `"${e.key}" (${e.reason})`).join(', ');
      document.getElementById('odr-hk-errors').classList.remove('hidden');
    }

    odrRenderHotkeyTable();
    odrRenderRemoteScenes(); // update badges
  } else {
    toast('Error: ' + (r.error || '?'), 'err');
  }
}

// ── Key recording ─────────────────────────────────────────────────────────────
function odrStartRecord(idx) {
  odrState.recordingIdx = idx;
  const el = document.getElementById(`odr-hk-key-${idx}`);
  if (el) { el.classList.add('recording'); el.value = 'Presiona el combo...'; }
}

function odrStopRecord(idx) {
  if (odrState.recordingIdx !== idx) return;
  odrState.recordingIdx = null;
  const el = document.getElementById(`odr-hk-key-${idx}`);
  if (!el) return;
  el.classList.remove('recording');
  // Restore actual value
  const current = odrState.hotkeys[idx]?.key || '';
  if (!current) el.value = '';
}

function odrHandleKeyRecord(e, idx) {
  if (odrState.recordingIdx !== idx) return true;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') {
    document.getElementById(`odr-hk-key-${idx}`)?.blur();
    return false;
  }

  const combo = odrKeyEventToElectron(e);
  if (!combo) return false;

  // Check duplicate
  const existing = odrState.hotkeys.findIndex((h, i) => i !== idx && h.key === combo);
  if (existing !== -1) {
    toast(`"${combo}" ya esta asignado a "${odrState.hotkeys[existing].scene}"`, 'err');
    return false;
  }

  odrState.hotkeys[idx].key = combo;
  delete odrState.hotkeyStatuses[combo]; // reset status until saved

  const el = document.getElementById(`odr-hk-key-${idx}`);
  if (el) { el.value = combo; el.classList.remove('recording'); }
  el?.blur();
  return false;
}

// For the "add" row key input
document.addEventListener('focusin', e => {
  if (e.target.id === 'odr-hk-add-key') {
    e.target.value = 'Presioná el combo…';
    e.target._recording = true;
  }
});
document.addEventListener('focusout', e => {
  if (e.target.id === 'odr-hk-add-key') {
    e.target._recording = false;
    if (e.target.value === 'Presioná el combo…') e.target.value = '';
  }
});
document.addEventListener('keydown', e => {
  const addKey = document.getElementById('odr-hk-add-key');
  if (!addKey?._recording) return;
  if (document.activeElement !== addKey) return;

  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape') { addKey.value = ''; addKey.blur(); return; }

  const combo = odrKeyEventToElectron(e);
  if (!combo) return;

  // Check duplicate
  const existing = odrState.hotkeys.find(h => h.key === combo);
  if (existing) {
    toast(`"${combo}" ya esta asignado a "${existing.scene}"`, 'err');
    addKey.value = '';
    return;
  }

  addKey.value = combo;
  addKey._recording = false;
  addKey.blur();
}, true);

// ── Key event → Electron accelerator string ──────────────────────────────────
function odrKeyEventToElectron(e) {
  const mods = [];
  if (e.ctrlKey)  mods.push('Ctrl');
  if (e.altKey)   mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey)  mods.push('Super');

  // Ignore standalone modifiers
  if (['Control','Alt','Shift','Meta'].includes(e.key)) return null;

  // Need at least one modifier to avoid conflicts with games
  if (!mods.length) return null;

  // Map browser key names to Electron accelerator keys
  const keyMap = {
    'F1':'F1','F2':'F2','F3':'F3','F4':'F4','F5':'F5','F6':'F6',
    'F7':'F7','F8':'F8','F9':'F9','F10':'F10','F11':'F11','F12':'F12',
    'F13':'F13','F14':'F14','F15':'F15','F16':'F16',
    'F17':'F17','F18':'F18','F19':'F19','F20':'F20',
    'F21':'F21','F22':'F22','F23':'F23','F24':'F24',
    ' ':'Space','Enter':'Return','Backspace':'Backspace',
    'Tab':'Tab','Escape':'Escape','Delete':'Delete',
    'Insert':'Insert','Home':'Home','End':'End',
    'PageUp':'PageUp','PageDown':'PageDown',
    'ArrowUp':'Up','ArrowDown':'Down','ArrowLeft':'Left','ArrowRight':'Right',
    '+':'Plus',
  };

  const key = keyMap[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : null);
  if (!key) return null;

  return [...mods, key].join('+');
}
