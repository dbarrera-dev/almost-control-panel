// ── Dashboard ─────────────────────────────────────────────────────
// Panel de inicio: estado general (Kick, Spotify, torneo, song request),
// estado de overlays y accesos rápidos. Lee de las mismas APIs que el resto
// de la app y se actualiza en vivo con el evento de estado del bot de Kick.

function _dashEl(id) { return document.getElementById(id); }
function _dashText(id, v) { const el = _dashEl(id); if (el) el.textContent = v; }
function _dashDot(id, on) { const el = _dashEl(id); if (el) el.classList.toggle('on', !!on); }
function _dashOnline(id, on) { const el = _dashEl(id); if (el) el.classList.toggle('online', !!on); }

async function loadDashboard() {
  try {
    const v = await api.getVersion();
    _dashText('dashVersion', 'v' + (typeof v === 'string' ? v : (v?.version || '—')));
  } catch {}
  dashLoadKick();
  dashLoadSpotify();
  dashLoadTorneo();
  dashLoadSongRequest();
  dashLoadOverlays();
  dashLoadCounts();
}

// ── Kick ──────────────────────────────────────────────────────────
async function dashLoadKick() {
  try {
    const r = await api.kickGetConfig();
    if (!r?.ok) return dashRenderKick(false, '', 'prod', false);
    const mode = r.kickBotMode === 'dev' ? 'dev' : 'prod';
    const bucket = (mode === 'dev' ? r.dev : r.prod) || {};
    dashRenderKick(!!r.connected, bucket.channel || '', mode, !!bucket.hasToken);
  } catch {
    dashRenderKick(false, '', 'prod', false);
  }
}

function dashRenderKick(connected, channel, mode, hasToken) {
  _dashDot('dashKickDot', connected);
  _dashOnline('dashKickCard', connected);
  _dashText('dashKickStatus', connected ? 'Conectado' : (hasToken ? 'Listo para conectar' : 'Sin autorizar'));
  _dashText('dashKickChannel', channel ? `@${channel} · ${mode.toUpperCase()}` : `Modo ${mode.toUpperCase()}`);
  const btn = _dashEl('dashKickBtn');
  if (btn) {
    btn.textContent = connected ? 'Desconectar' : 'Conectar';
    btn.classList.toggle('danger', connected);
  }
}

// ── Spotify ───────────────────────────────────────────────────────
async function dashLoadSpotify() {
  try {
    const r = await api.getSpotifyStatus();
    const connected = !!(r?.ok && r.connected);
    _dashDot('dashSpotifyDot', connected);
    _dashOnline('dashSpotifyCard', connected);
    _dashText('dashSpotifyStatus', connected ? 'Conectado' : 'Sin conectar');
    if (!connected) {
      _dashText('dashSpotifyTrack', 'Conectá Spotify en Música');
      return;
    }
    try {
      const np = await api.spotifyNowPlaying();
      const name = np?.track?.name || '';
      const artist = np?.track?.artist || '';
      _dashText('dashSpotifyTrack', name ? (artist ? `${name} — ${artist}` : name) : 'Nada sonando');
    } catch {
      _dashText('dashSpotifyTrack', '—');
    }
  } catch {
    _dashText('dashSpotifyStatus', 'Sin conectar');
  }
}

// ── Torneo activo ─────────────────────────────────────────────────
async function dashLoadTorneo() {
  try {
    const r = await api.getTorneoActivo();
    if (r?.ok && r.torneo) {
      const n = Array.isArray(r.participantes) ? r.participantes.length : 0;
      _dashDot('dashTorneoDot', true);
      _dashOnline('dashTorneoCard', true);
      _dashText('dashTorneoStatus', r.torneo.nombre || 'Torneo activo');
      _dashText('dashTorneoSub', `${n} participante${n === 1 ? '' : 's'}`);
      _dashText('dashPart', n);
    } else {
      _dashDot('dashTorneoDot', false);
      _dashOnline('dashTorneoCard', false);
      _dashText('dashTorneoStatus', 'Sin torneo activo');
      _dashText('dashTorneoSub', 'Creá uno en Torneos');
      _dashText('dashPart', 0);
    }
  } catch {}
}

// ── Song Request ──────────────────────────────────────────────────
async function dashLoadSongRequest() {
  try {
    const r = await api.spotifyGetSongrequestConfig();
    const enabled = !!(r?.enabled || r?.kickEnabled);
    _dashDot('dashSrDot', enabled);
    _dashOnline('dashSrCard', enabled);
    _dashText('dashSrStatus', enabled ? 'Activo' : 'Desactivado');
    _dashText('dashSrSub', r?.rewardId ? 'Reward configurada' : 'Pedidos de canciones');
  } catch {
    _dashText('dashSrStatus', '—');
  }
}

// ── Overlays ──────────────────────────────────────────────────────
function dashLoadOverlays() {
  dashOvRow('dashOv-keys', () => api.keyOverlayGetStatus(), 9001);
  dashOvRow('dashOv-spotify', () => api.spotifyOverlayStatus(), 9002);
  dashOvRow('dashOv-rl', () => api.rlOverlayStatus(), 9003);
}

async function dashOvRow(prefix, statusFn, port) {
  try {
    const s = await statusFn();
    const running = !!s?.running;
    const url = s?.url || `http://localhost:${port}`;
    _dashDot(`${prefix}-dot`, running);
    _dashText(`${prefix}-status`, running ? 'Activo' : 'Inactivo');
    const btn = _dashEl(`${prefix}-btn`);
    if (btn) {
      btn.disabled = !running;
      btn.onclick = running ? () => api.openUrl(url) : null;
    }
  } catch {
    _dashText(`${prefix}-status`, '—');
  }
}

// ── Resumen / contadores ──────────────────────────────────────────
async function dashLoadCounts() {
  let todosPending = 0;
  let duelosPending = 0;
  try {
    const r = await api.todosGet();
    if (r?.ok) todosPending = (r.data || []).filter((t) => t.status !== 'done').length;
  } catch {}
  try {
    const r = await api.duelosGet();
    if (r?.ok) duelosPending = (r.data || []).filter((d) => !d.done).length;
  } catch {}
  _dashText('dashTodos', todosPending);
  _dashText('dashDuelos', duelosPending);
}

// ── Actualización en vivo del estado de Kick ──────────────────────
if (typeof api?.onKickBotStatus === 'function') {
  api.onKickBotStatus(() => {
    if (_dashEl('dashKickCard')) dashLoadKick();
  });
}
