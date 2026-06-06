// ── Spotify ───────────────────────────────────────────────────────
let spConnected   = false;
let spPollInterval = null;
let spIsPlaying   = false;
let spIsShuffle   = false;
let spRepeatState = 'off'; // 'off' | 'context' | 'track'
let spLastTrackName = null;
let spVolume      = 50;
let spVolumeTimer = null;
let _spVolumeCommitting = false;
let _spVolumeCommitSeq = 0;
let _spLastVolumeTouchAt = 0;
let spProgressMs  = 0;
let spDurationMs  = 0;
let spProgressInterval = null;
let _spPollFailCount = 0;
const _SP_POLL_BASE = 3000;
const _SP_POLL_MAX  = 12000;
let spQueueCache = [];
let srKickEnabled = false;
let _syncSrKickInFlight = null;
let _loadSpotifyInFlight = null;
let _srKickLastSyncAt = 0;
const _SR_KICK_SYNC_MS = 15000;
let _spSearchReqSeq = 0;
let _spQueueSyncInFlight = null;
let _spQueueLastSyncAt = 0;
const _SP_QUEUE_SYNC_MS = 5000;
let _spTransportInFlight = false;
let _spTransportLastAt = 0;
const _SP_TRANSPORT_COOLDOWN_MS = 900;

function _spClampVolume(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function _spApplyVolumeUi(value) {
  spVolume = _spClampVolume(value);
  const slider = document.getElementById('spVolumeSlider');
  const lbl = document.getElementById('spVolumeLabel');
  if (slider) slider.value = spVolume;
  if (lbl) lbl.textContent = spVolume + '%';
}

function _spCanAcceptRemoteVolume() {
  return !spVolumeTimer && !_spVolumeCommitting && (Date.now() - _spLastVolumeTouchAt) > 900;
}

function _spotifyUiReady() {
  return !!(
    document.getElementById('view-spotify')
    && document.getElementById('spClientId')
    && document.getElementById('spStatusBadge')
    && document.getElementById('spConnected')
    && document.getElementById('spNotConnected')
  );
}

async function _waitForSpotifyUiReady(maxAttempts = 12, delayMs = 80) {
  for (let i = 0; i <= maxAttempts; i++) {
    if (_spotifyUiReady()) return true;
    if (i < maxAttempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function _spIsTabActive(name) {
  return !!document.getElementById('spview-' + name)?.classList.contains('on');
}

async function _syncSpotifyQueueAuto(opts = {}) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  const force = !!options.force;
  if (!spConnected) return;
  const now = Date.now();
  if (!force && (now - _spQueueLastSyncAt) < _SP_QUEUE_SYNC_MS) return;
  if (_spQueueSyncInFlight) return _spQueueSyncInFlight;
  const renderMain = _spIsTabActive('cola');
  _spQueueSyncInFlight = loadSpotifyQueue({ renderMain, silent: true })
    .catch(() => {})
    .finally(() => { _spQueueSyncInFlight = null; });
  return _spQueueSyncInFlight;
}

async function _syncSongRequestKickState() {
  if (_syncSrKickInFlight) return _syncSrKickInFlight;
  _syncSrKickInFlight = (async () => {
    const srCfg = await api.spotifyGetSongrequestConfig().catch(() => ({ enabled: false, kickEnabled: false, rewardId: '' }));
    const rewardStatus = await api.kickRewardGetStatus().catch((e) => ({ ok: false, error: e?.message || String(e) }));

    const currentKickEnabled = srCfg?.kickEnabled !== false;
    const currentEnabled = srCfg?.enabled !== false;
    let rewardEnabled = currentKickEnabled;
    let canSyncByRewardState = false;

    if (rewardStatus?.ok) {
      rewardEnabled = rewardStatus.enabled === true;
      canSyncByRewardState = true;
    } else {
      // Si no pudimos leer estado de reward (por ejemplo Kick desconectado),
      // no forzamos cambios ni limpiamos el ID: mantenemos el último estado conocido.
      srKickEnabled = currentKickEnabled;
      _setSongRequestKickMasterUI(srKickEnabled);
      const detail = rewardStatus?.error ? ` ${rewardStatus.error}` : '';
      _setSongRequestKickMasterMsg(`No pude validar la reward de Kick.${detail}`, 'warn');
      return;
    }

    // Sincronizar estado del módulo con el estado real de la reward.
    if (canSyncByRewardState && (currentKickEnabled !== rewardEnabled || currentEnabled !== rewardEnabled)) {
      await api.spotifySongrequestToggleKick(rewardEnabled).catch(() => {});
    }

    srKickEnabled = rewardEnabled;
    _setSongRequestKickMasterUI(srKickEnabled);

    if (rewardEnabled) {
      _setSongRequestKickMasterMsg('Song Request activo (reward habilitada en Kick).', 'ok');
    } else {
      const detail = rewardStatus?.error ? ` ${rewardStatus.error}` : '';
      _setSongRequestKickMasterMsg(`Song Request inactivo (reward deshabilitada o no disponible).${detail}`, 'warn');
    }
  })();
  try { return await _syncSrKickInFlight; }
  finally { _syncSrKickInFlight = null; }
}

// ── Spotify sub-tab navigation (se controla desde el aside) ─────────
function _spUpdateSubnav(connected) {
  const subnav = document.getElementById('subnav-spotify');
  if (subnav) subnav.classList.toggle('is-locked', !connected);
}

function goSpTab(name) {
  if (!spConnected) return; // subcategorías deshabilitadas sin conexión
  ['player','explorar','cola'].forEach(n => {
    const view = document.getElementById('spview-' + n);
    if (view) view.classList.toggle('on', n === name);
    const nav = document.getElementById('spnav-' + n);
    if (nav) nav.classList.toggle('on', n === name);
    const tab = document.getElementById('sptab-' + n); // legacy (ya no existe)
    if (tab) tab.classList.toggle('on', n === name);
  });
  if (name === 'player'   && spConnected) { _syncSpotifyQueueAuto({ force: true }).catch(() => {}); }
  if (name === 'explorar' && spConnected) {
    const meta = document.getElementById('spSearchMeta');
    const results = document.getElementById('spSearchResults');
    if (meta) meta.textContent = 'Tip: también podés pegar links de Spotify (track, playlist, álbum o artista) en el buscador.';
    if (results && !results.innerHTML.trim()) {
      results.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:20px 0">Escribí algo y buscá para ver resultados.</div>`;
    }
  }
  if (name === 'cola'     && spConnected) { _syncSpotifyQueueAuto({ force: true }).catch(() => {}); }
}

// ── Spotify load ───────────────────────────────────────────────────
async function loadSpotify() {
  if (_loadSpotifyInFlight) return _loadSpotifyInFlight;
  _loadSpotifyInFlight = _loadSpotifyImpl().finally(() => { _loadSpotifyInFlight = null; });
  return _loadSpotifyInFlight;
}

async function _loadSpotifyImpl() {
  try {
    const uiReady = await _waitForSpotifyUiReady();
    if (!uiReady) {
      log('warn', 'Spotify: UI todavía no está lista, reintentá abrir la pestaña.');
      return;
    }

    await spovInit();
    const creds = await api.spotifyGetCredentials();
    if (creds.clientId)     document.getElementById('spClientId').value     = creds.clientId;
    if (creds.clientSecret) document.getElementById('spClientSecret').value = creds.clientSecret;

    const r = await api.getSpotifyStatus();
    spConnected = r.ok && r.connected;
    const dot = document.getElementById('spStatusDot');
    if (dot) dot.classList.toggle('on', spConnected);
    const modeLabel = r.mode === 'dev' ? ' [DEV]' : '';
    document.getElementById('spStatusBadge').textContent = (spConnected ? '● Conectado' : 'Sin conectar') + modeLabel;
    document.getElementById('spStatusBadge').className   = spConnected ? 'badge badge-on' : 'badge badge-off';
    document.getElementById('spNotConnected').classList.toggle('hidden',  spConnected);
    document.getElementById('spConnected').classList.toggle('hidden',    !spConnected);
    document.getElementById('spBadgeTab')?.classList.toggle('hidden',    !spConnected);
    document.getElementById('spConnectedWrap').classList.toggle('hidden', !spConnected);
    _spUpdateSubnav(spConnected);

    if (spConnected) {
      // Si ninguna sub-vista está activa, entrar a Player por defecto
      if (!_spIsTabActive('player') && !_spIsTabActive('explorar') && !_spIsTabActive('cola')) {
        goSpTab('player');
      }
      await loadNowPlaying();
      _syncSpotifyQueueAuto({ force: true }).catch(() => {});
      const srKick = document.getElementById('srKickToggle');
      await _syncSongRequestKickState();
      _srKickLastSyncAt = Date.now();
      if (srKick) srKick.checked = srKickEnabled;
      loadRequestQueue();
      _spPollFailCount = 0;
      if (spPollInterval) { clearInterval(spPollInterval); spPollInterval = null; }
      spPollInterval = setInterval(pollNowPlaying, _SP_POLL_BASE);
    } else {
      _stopProgressTimer();
      if (spPollInterval) { clearInterval(spPollInterval); spPollInterval = null; }
      _spQueueLastSyncAt = 0;
    }
  } catch (e) {
    log('warn', 'Error cargando Spotify: ' + (e.message || e));
  }
}

async function pollNowPlaying() {
  try {
    const r = await api.spotifyNowPlaying();
    if (!r.ok) {
      _spPollFailCount++;
      _rescheduleSpPoll();
      return;
    }
    if (_spPollFailCount > 0) { _spPollFailCount = 0; _rescheduleSpPoll(); }
    // Always sync volume (skip if user is actively changing it)
    if (r.volume !== null && r.volume !== undefined && _spCanAcceptRemoteVolume()) {
      _spApplyVolumeUi(r.volume);
    }
    if (r.progress_ms !== undefined) {
      spProgressMs = r.progress_ms;
      spDurationMs = r.duration_ms || 0;
      _updateProgressBar();
    }

    const now = Date.now();
    if ((now - _srKickLastSyncAt) >= _SR_KICK_SYNC_MS) {
      _srKickLastSyncAt = now;
      _syncSongRequestKickState().catch(() => {});
    }

    const newTrack   = r.track?.name || null;
    const stateChanged = r.playing !== spIsPlaying;
    if (newTrack === spLastTrackName && !stateChanged) {
      _syncSpotifyQueueAuto().catch(() => {});
      return;
    }
    spLastTrackName = newTrack;
    _applyNowPlaying(r);
    _syncSpotifyQueueAuto({ force: true }).catch(() => {});
  } catch (e) {
    _spPollFailCount++;
    _rescheduleSpPoll();
  }
}

function _rescheduleSpPoll() {
  clearInterval(spPollInterval);
  spPollInterval = null;
  if (!spConnected) return;
  const delay = Math.min(_SP_POLL_MAX, _SP_POLL_BASE * Math.pow(2, _spPollFailCount));
  spPollInterval = setInterval(pollNowPlaying, delay);
}

async function loadNowPlaying() {
  const r = await api.spotifyNowPlaying();
  if (!r.ok) {
    const trackRow = document.getElementById('spTrackRow');
    const nothingMsg = document.getElementById('spNothingMsg');
    const nothingText = document.getElementById('spNothingText');
    if (trackRow) trackRow.style.display = 'none';
    if (nothingText) nothingText.textContent = 'Error: ' + (r.error || 'No se pudo conectar con Spotify.');
    if (nothingText) nothingText.style.color = 'var(--red)';
    if (nothingMsg) nothingMsg.classList.remove('hidden');
    return;
  }
  const nothingText = document.getElementById('spNothingText');
  if (nothingText) {
    if (r.reason === '204') nothingText.textContent = 'Spotify no reporta dispositivo activo (sesión privada o sin dispositivo).';
    else if (r.reason === 'no_item') nothingText.textContent = 'Reproduciendo pero sin pista detectada (¿podcast o archivo local?).';
    else nothingText.textContent = 'No hay nada reproduciéndose.';
    nothingText.style.color = '';
  }
  spLastTrackName = r.track?.name || null;
  _applyNowPlaying(r);
}

function _applyNowPlaying(r) {
  const card       = document.getElementById('spNowPlayingCard');
  const trackRow   = document.getElementById('spTrackRow');
  const nothingMsg = document.getElementById('spNothingMsg');
  const pausedMsg  = document.getElementById('spPausedMsg');
  const playingRow = document.getElementById('spPlayingRow');
  const progressWp = document.getElementById('spProgressWrap');
  const art        = document.getElementById('spAlbumArt');

  if (!r.playing && !r.track) {
    trackRow.style.display = 'none';
    nothingMsg.classList.remove('hidden');
    if (progressWp) progressWp.classList.add('hidden');
    _stopProgressTimer();
    card.classList.remove('playing');
    art.classList.remove('playing');
    spIsPlaying = false;
    _updateSpControls();
    return;
  }

  trackRow.style.display = '';
  nothingMsg.classList.add('hidden');
  const t = r.track;
  art.src = t.image || '';
  art.classList.toggle('playing', r.playing);
  document.getElementById('spTrackName').textContent = t.name   || '—';
  document.getElementById('spArtist').textContent    = t.artist || '—';
  document.getElementById('spAlbum').textContent     = t.album  || '—';
  playingRow.classList.toggle('hidden', !r.playing);
  pausedMsg.classList.toggle('hidden',   r.playing);
  card.classList.toggle('playing', r.playing);
  spIsPlaying   = r.playing;
  spIsShuffle   = r.shuffle || false;
  spRepeatState = r.repeat  || 'off';

  // Progreso
  if (r.progress_ms !== undefined && r.duration_ms) {
    spProgressMs = r.progress_ms;
    spDurationMs = r.duration_ms;
    if (progressWp) progressWp.classList.remove('hidden');
    _updateProgressBar();
    if (r.playing) _startProgressTimer(); else _stopProgressTimer();
  }

  // Dispositivo
  if (r.device) {
    const deviceSvgs = {
      Computer: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></svg>',
      Smartphone: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>',
      Speaker: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>',
      TV: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>'
    };
    const fallbackSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v8m-2-6h4"/></svg>';
    const icon = document.getElementById('spDeviceIcon');
    const name = document.getElementById('spDeviceName');
    if (icon) icon.innerHTML = deviceSvgs[r.device.type] || fallbackSvg;
    if (name) name.textContent = r.device.name;
  }

  // Volumen
  if (r.volume !== null && r.volume !== undefined && _spCanAcceptRemoteVolume()) {
    _spApplyVolumeUi(r.volume);
  }
  _updateSpControls();
}

// ── Progress bar helpers ───────────────────────────────────────────
function _msToTime(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function _updateProgressBar() {
  if (!spDurationMs) return;
  const pct = Math.min(100, (spProgressMs / spDurationMs) * 100);
  const fill = document.getElementById('spProgressFill');
  const pt   = document.getElementById('spProgressTime');
  const dt   = document.getElementById('spDurationTime');
  if (fill) fill.style.width = pct + '%';
  if (pt)   pt.textContent   = _msToTime(spProgressMs);
  if (dt)   dt.textContent   = _msToTime(spDurationMs);
}
function _startProgressTimer() {
  _stopProgressTimer();
  spProgressInterval = setInterval(() => {
    spProgressMs = Math.min(spDurationMs, spProgressMs + 1000);
    _updateProgressBar();
  }, 1000);
}
function _stopProgressTimer() {
  clearInterval(spProgressInterval);
  spProgressInterval = null;
}

// ── Spotify controls ───────────────────────────────────────────────
function _updateSpControls() {
  const ppBtn = document.getElementById('spPlayPauseBtn');
  if (ppBtn) ppBtn.innerHTML = spIsPlaying
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>';
  const shBtn = document.getElementById('spShuffleBtn');
  if (shBtn) shBtn.classList.toggle('sp-active', spIsShuffle);
  _updateRepeatBtn();
}

function _updateRepeatBtn() {
  const btn = document.getElementById('spRepeatBtn');
  if (!btn) return;
  const map = { off: 'REPETIR', context: 'PLAYLIST', track: 'CANCIÓN' };
  btn.textContent = map[spRepeatState] || map.off;
  btn.classList.toggle('sp-active', spRepeatState !== 'off');
}

async function spCycleRepeat() {
  const next = { off: 'context', context: 'track', track: 'off' };
  spRepeatState = next[spRepeatState] || 'off';
  _updateRepeatBtn();
  await api.spotifySetRepeat(spRepeatState);
}

async function startSpotifyConnect() {
  const clientId     = document.getElementById('spClientId').value.trim();
  const clientSecret = document.getElementById('spClientSecret').value.trim();
  if (!clientId || !clientSecret) { showSpotifyError('Completá el Client ID y el Client Secret'); return; }

  const btn = document.getElementById('spConnectBtn');
  const statusEl = document.getElementById('spOAuthStatus');
  btn.disabled = true;
  statusEl.style.display = 'block';
  statusEl.textContent = '⏳ Esperando autorización en el navegador...';

  const r = await api.spotifyConnectOAuth({ clientId, clientSecret });
  btn.disabled = false;
  statusEl.style.display = 'none';

  if (!r.ok) { showSpotifyError(r.error || 'Error al conectar'); return; }
  spCloseConnect();
  await loadSpotify();
}

// ── Modal de conexión ─────────────────────────────────────────────
function spOpenConnect() {
  const m = document.getElementById('spConnectModal');
  if (!m) return;
  const status = document.getElementById('spOAuthStatus');
  if (status) status.style.display = 'none';
  m.classList.remove('hidden');
  document.addEventListener('keydown', _spConnectEsc);
  setTimeout(() => document.getElementById('spClientId')?.focus(), 40);
}
function spCloseConnect() {
  const m = document.getElementById('spConnectModal');
  if (!m) return;
  m.classList.add('hidden');
  document.removeEventListener('keydown', _spConnectEsc);
}
function _spConnectEsc(e) {
  if (e.key === 'Escape') spCloseConnect();
}

// Reconectar = reabrir el modal de credenciales
function showSpReconnect() {
  spOpenConnect();
}

async function spotifyDisconnect() {
  const r = await api.spotifyDisconnect();
  if (!r.ok) { toast('Error al desconectar', 'err'); return; }
  await loadSpotify();
}

// ── Modal de comandos del chat ────────────────────────────────────
function spShowCommands() {
  const m = document.getElementById('spCommandsModal');
  if (!m) return;
  m.classList.remove('hidden');
  document.addEventListener('keydown', _spCommandsEsc);
}
function spCloseCommands() {
  const m = document.getElementById('spCommandsModal');
  if (!m) return;
  m.classList.add('hidden');
  document.removeEventListener('keydown', _spCommandsEsc);
}
function _spCommandsEsc(e) {
  if (e.key === 'Escape') spCloseCommands();
}

api.onSpotifyOAuthStatus(({ step }) => {
  const el = document.getElementById('spOAuthStatus');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = step === 'exchanging' ? '🔄 Guardando tokens...' : '⏳ Esperando autorización en el navegador...';
});

function updateSpControls() { _updateSpControls(); }

function _spSetTransportButtonsBusy(busy) {
  const playPauseBtn = document.getElementById('spPlayPauseBtn');
  const prevBtn = document.getElementById('spPrevBtn');
  const nextBtn = document.getElementById('spNextBtn');
  if (playPauseBtn) playPauseBtn.disabled = !!busy;
  if (prevBtn) prevBtn.disabled = !!busy;
  if (nextBtn) nextBtn.disabled = !!busy;
}

async function _spAfterTransportSync() {
  // Evita quedar en polling lento después de errores transitorios durante next/prev.
  _spPollFailCount = 0;
  _rescheduleSpPoll();

  await loadNowPlaying().catch(() => {});
  _syncSpotifyQueueAuto({ force: true }).catch(() => {});

  // Segundo refresh para cubrir delay típico de Spotify al aplicar saltos.
  setTimeout(() => {
    loadNowPlaying().catch(() => {});
    _syncSpotifyQueueAuto({ force: true }).catch(() => {});
  }, 1200);
}

async function _spRunTransport(action) {
  const now = Date.now();
  if (_spTransportInFlight) return { ok: false, throttled: true };
  if ((now - _spTransportLastAt) < _SP_TRANSPORT_COOLDOWN_MS) return { ok: false, throttled: true };

  _spTransportInFlight = true;
  _spTransportLastAt = now;
  _spSetTransportButtonsBusy(true);
  try {
    const r = action === 'prev' ? await api.spotifyPrev() : await api.spotifyNext();
    if (!r?.ok) return r || { ok: false, error: 'Error al cambiar canción' };
    await _spAfterTransportSync();
    return r;
  } finally {
    setTimeout(() => {
      _spTransportInFlight = false;
      _spSetTransportButtonsBusy(false);
    }, 350);
  }
}

async function spAction(action) {
  const r = await _spRunTransport(action);
  if (!r?.ok && !r?.throttled) {
    showSpotifyError(r?.error || 'Error al cambiar canción');
  }
}

async function spTogglePlayPause() {
  if (_spTransportInFlight) return;
  const btn = document.getElementById('spPlayPauseBtn');
  btn.disabled = true;
  _spTransportInFlight = true;
  try {
    const r = spIsPlaying ? await api.spotifyPause() : await api.spotifyPlay();
    if (!r?.ok) {
      const msg = r?.status === 404
        ? 'Sin dispositivo activo — abrí Spotify primero'
        : (r?.error || 'Error al controlar Spotify');
      showSpotifyError(msg);
      setTimeout(() => loadNowPlaying().catch(() => {}), 500);
      return;
    }
    spIsPlaying = !spIsPlaying;
    _updateSpControls();
    await _spAfterTransportSync();
  } catch (e) {
    showSpotifyError(e?.message || 'Error al controlar Spotify');
    setTimeout(() => loadNowPlaying().catch(() => {}), 500);
  } finally {
    _spTransportInFlight = false;
    btn.disabled = false;
  }
}

function showSpotifyError(msg) {
  const el = document.createElement('div');
  el.textContent = '⚠ ' + msg;
  el.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1a1a1a;border:1px solid #ef4444;color:#fca5a5;padding:10px 16px;border-radius:8px;font-size:12px;z-index:9999;max-width:320px;box-shadow:0 4px 20px rgba(0,0,0,.5)';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function spSeek(e) {
  if (!spDurationMs) return;
  const track = e.currentTarget;
  const rect = track.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const posMs = Math.round(ratio * spDurationMs);
  // Update UI immediately for snappy feedback
  spProgressMs = posMs;
  _updateProgressBar();
  _stopProgressTimer();
  await api.spotifySeek(posMs);
  // Resume local timer after a brief delay to let Spotify catch up
  setTimeout(() => { if (spIsPlaying) _startProgressTimer(); }, 500);
}

async function spToggleShuffle() {
  spIsShuffle = !spIsShuffle;
  await api.spotifyShuffle(spIsShuffle);
  _updateSpControls();
}

function spVolumeInput(val) {
  _spLastVolumeTouchAt = Date.now();
  _spApplyVolumeUi(val);
  clearTimeout(spVolumeTimer);
  spVolumeTimer = setTimeout(() => spVolumeCommit(spVolume), 400);
}

async function spVolumeCommit(val) {
  clearTimeout(spVolumeTimer);
  spVolumeTimer = null;
  const requested = _spClampVolume(val);
  const seq = ++_spVolumeCommitSeq;
  _spLastVolumeTouchAt = Date.now();
  _spApplyVolumeUi(requested);
  _spVolumeCommitting = true;
  try {
    const r = await api.spotifySetVolume(requested);
    if (seq !== _spVolumeCommitSeq) return;

    if (r?.ok && r.volume !== null && r.volume !== undefined) {
      _spApplyVolumeUi(r.volume);
      if (r.verified === false && Math.abs(_spClampVolume(r.volume) - requested) > 1) {
        showSpotifyError(r.warning || `Spotify reporta ${r.volume}% después de pedir ${requested}%`);
      }
      return;
    }

    if (r && r.ok === false) {
      showSpotifyError(r.error || 'No se pudo cambiar el volumen');
    }

    const state = await api.spotifyNowPlaying().catch(() => null);
    if (seq !== _spVolumeCommitSeq) return;
    if (state?.ok && state.volume !== null && state.volume !== undefined) {
      _spApplyVolumeUi(state.volume);
    }
  } finally {
    if (seq === _spVolumeCommitSeq) {
      _spVolumeCommitting = false;
      _spLastVolumeTouchAt = Date.now();
      setTimeout(() => {
        if (seq === _spVolumeCommitSeq) pollNowPlaying().catch(() => {});
      }, 900);
    }
  }
}

// ── Spotify Overlay UI ──────────────────────────────────────
let spovCfg = {
  layout: 'row', fontSize: 'md',
  show: { art: true, title: true, artist: true, album: false, progress: true, time: true, eq: true },
  style: { bg: 'rgba(15,15,20,0.92)', text: '#ffffff', accent: '#1DB954', radius: 12 }
};
let spovLoaded = false;
let spovInitPromise = null;

function _spovUiReady() {
  return !!(
    document.getElementById('spovAccent')
    && document.getElementById('spovTextColor')
    && document.getElementById('spovRadius')
    && document.getElementById('spovBgOpacity')
  );
}

function spovApplyStatus(st = {}) {
  const badge = document.getElementById('spovStatusBadge');
  if (badge) {
    if (st.running) { badge.textContent = '● Activo'; badge.className = 'badge'; badge.style.background = '#1DB954'; badge.style.color = '#000'; }
    else            { badge.textContent = 'Inactivo'; badge.className = 'badge badge-off'; badge.style = ''; }
  }

  const baseUrl = String(st.url || 'http://localhost:9002').replace(/\/+$/, '');
  const requesterUrl = st.requesterUrl || `${baseUrl}/requester`;
  const spovUrl = document.getElementById('spovUrl');
  const spovReq = document.getElementById('spovRequesterUrl');
  if (spovUrl) spovUrl.textContent = baseUrl;
  if (spovReq) spovReq.textContent = requesterUrl;

  const lanWrap = document.getElementById('spovLanWrap');
  const lanReqWrap = document.getElementById('spovLanReqWrap');
  const lanUrlEl = document.getElementById('spovLanUrl');
  const lanReqUrlEl = document.getElementById('spovLanRequesterUrl');
  if (lanWrap && lanUrlEl) {
    if (st.lanUrl) {
      lanWrap.classList.remove('hidden');
      lanUrlEl.textContent = st.lanUrl;
    } else lanWrap.classList.add('hidden');
  }
  if (lanReqWrap && lanReqUrlEl) {
    if (st.lanRequesterUrl) {
      lanReqWrap.classList.remove('hidden');
      lanReqUrlEl.textContent = st.lanRequesterUrl;
    } else lanReqWrap.classList.add('hidden');
  }

  const connMsg = document.getElementById('spovConnMsg');
  if (!connMsg) return;
  if (st.running && st.error) {
    connMsg.style.color = 'var(--orange2)';
    connMsg.textContent = st.error;
    return;
  }
  if (!st.running && st.error) {
    connMsg.style.color = 'var(--red)';
    connMsg.textContent = st.error;
    return;
  }
  if (st.running && Number(st.wsClients || 0) === 0) {
    connMsg.style.color = 'var(--text3)';
    connMsg.textContent = 'Overlay activo, sin cliente OBS conectado todavía.';
    return;
  }
  if (st.running && Number(st.wsClients || 0) > 0) {
    connMsg.style.color = 'var(--green)';
    connMsg.textContent = `Cliente OBS conectado (${st.wsClients}).`;
    return;
  }
  connMsg.style.color = 'var(--text3)';
  connMsg.textContent = '';
}

async function spovInit(attempt = 0) {
  if (spovLoaded) return;
  if (!_spovUiReady()) {
    if (attempt < 12) setTimeout(() => { spovInit(attempt + 1).catch(() => {}); }, 80);
    return;
  }
  if (spovInitPromise) return spovInitPromise;
  spovInitPromise = (async () => {
    const st = await api.spotifyOverlayStatus();
    const r  = await api.spotifyOverlayGetConfig();
    spovCfg  = r.config || spovCfg;
    spovApplyStatus(st || {});
    spovApplyUI();
    spovLoaded = true;
  })()
    .catch((e) => {
      spovLoaded = false;
      throw e;
    })
    .finally(() => {
      spovInitPromise = null;
    });
  return spovInitPromise;
}

api.onSpotifyOverlayStatus((st) => {
  spovApplyStatus(st || {});
});

function spovApplyUI() {
  // Layout buttons
  document.querySelectorAll('.spov-lay').forEach(b => {
    b.classList.toggle('btn-orange', b.id === `spov-lay-${spovCfg.layout}`);
  });
  // Show toggles
  document.querySelectorAll('.spov-show').forEach(b => {
    const key = b.dataset.key;
    b.classList.toggle('btn-orange', !!spovCfg.show[key]);
  });
  // Size buttons
  document.querySelectorAll('.spov-sz').forEach(b => {
    b.classList.toggle('btn-orange', b.id === `spov-sz-${spovCfg.fontSize}`);
  });
  // Style inputs
  document.getElementById('spovAccent').value    = spovCfg.style.accent  || '#1DB954';
  document.getElementById('spovTextColor').value = spovCfg.style.text    || '#ffffff';
  const radius = spovCfg.style.radius ?? 12;
  document.getElementById('spovRadius').value    = radius;
  document.getElementById('spovRadiusVal').textContent = radius + 'px';
  // Bg opacity
  const match = (spovCfg.style.bg || '').match(/[\d.]+\)$/);
  const op = match ? parseFloat(match[0]) : 0.92;
  document.getElementById('spovBgOpacity').value = op;
  document.getElementById('spovBgOpacityVal').textContent = Math.round(op * 100) + '%';
}

function spovSave() { api.spotifyOverlaySetConfig(spovCfg); }

function spovSetLayout(lay) {
  spovCfg.layout = lay;
  spovApplyUI();
  spovSave();
}

function spovToggleShow(key) {
  spovCfg.show[key] = !spovCfg.show[key];
  spovApplyUI();
  spovSave();
}

function spovSetSize(sz) {
  spovCfg.fontSize = sz;
  spovApplyUI();
  spovSave();
}

function spovSaveStyle() {
  const op = parseFloat(document.getElementById('spovBgOpacity').value);
  spovCfg.style.accent = document.getElementById('spovAccent').value;
  spovCfg.style.text   = document.getElementById('spovTextColor').value;
  spovCfg.style.bg     = `rgba(15,15,20,${op})`;
  spovSave();
}

function spovOnRadius(val) {
  spovCfg.style.radius = parseInt(val);
  document.getElementById('spovRadiusVal').textContent = val + 'px';
  spovSave();
}

function spovOnBgOpacity(val) {
  document.getElementById('spovBgOpacityVal').textContent = Math.round(val * 100) + '%';
  spovSaveStyle();
}

function spovCopyUrl(btn, id = 'spovUrl') {
  const url = document.getElementById(id)?.textContent?.trim();
  if (!url) return;
  const ta = document.createElement('textarea');
  ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  const orig = btn.textContent;
  btn.textContent = '✓ Copiado'; btn.style.color = '#4ade80';
  setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1500);
}

function _hSp(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _spQueueRowHtml(track, index, compact) {
  const n = Number(index) + 1;
  const name = _hSp(track?.name || '—');
  const artist = _hSp(track?.artist || '');
  const image = String(track?.image || '');
  if (compact) {
    return `
      <div class="sp-queue-row-compact">
        <span class="sp-queue-row-num">${n}</span>
        ${image
          ? `<img class="sp-item-art" style="width:30px;height:30px" src="${image}" alt="" />`
          : `<div class="sp-item-ph" style="width:30px;height:30px">♪</div>`}
        <div class="sp-item-info">
          <div class="sp-item-name">${name}</div>
          <div class="sp-item-sub">${artist}</div>
        </div>
      </div>
    `;
  }
  return `
    <div class="sp-item">
      <span style="font-size:10px;color:var(--text3);min-width:16px;text-align:center;flex-shrink:0;font-family:'Bebas Neue',cursive;font-size:14px">${n}</span>
      ${image
        ? `<img class="sp-item-art" style="width:32px;height:32px" src="${image}" alt="" />`
        : `<div class="sp-item-ph" style="width:32px;height:32px">♪</div>`}
      <div class="sp-item-info">
        <div class="sp-item-name">${name}</div>
        <div class="sp-item-sub">${artist}</div>
      </div>
      <button class="todo-action-btn del"
        onclick="spRemoveFromSpotifyQueue(decodeURIComponent('${encodeURIComponent(String(track?.uri || track?.id || ''))}'), decodeURIComponent('${encodeURIComponent(String(track?.name || ''))}'))"
        title="Quitar esta canción de la cola">✕</button>
    </div>
  `;
}

function _renderSpotifyQueueMain(queue, opts = {}) {
  const { silent = false } = opts;
  const list = document.getElementById('spQueueList');
  if (!list) return;
  if (!Array.isArray(queue) || !queue.length) {
    list.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0">${silent ? 'La cola está vacía.' : 'La cola está vacía.'}</div>`;
    return;
  }
  list.innerHTML = queue.map((t, i) => _spQueueRowHtml(t, i, false)).join('');
}

function _renderSpotifyQueuePreview(queue) {
  const preview = document.getElementById('spQueuePreviewList');
  if (!preview) return;
  if (!Array.isArray(queue) || !queue.length) {
    preview.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:10px 0">La cola está vacía.</div>`;
    return;
  }
  const top = queue.slice(0, 5);
  preview.innerHTML = top.map((t, i) => _spQueueRowHtml(t, i, true)).join('');
}

function _spSetQueueMessage(text, color) {
  ['spQueueMsg', 'spQueueMsgPlayer'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.color = color || 'var(--text3)';
    el.textContent = text || '';
  });
}

function _spGetQueueInputBySource(source) {
  const fromPlayer = source === 'player';
  const id = fromPlayer ? 'spQueueInputPlayer' : 'spQueueInput';
  return document.getElementById(id);
}

async function spAddToQueue(source = 'cola') {
  const input = _spGetQueueInputBySource(source);
  if (!input) return;
  const link = input.value.trim();
  if (!link) return;

  _spSetQueueMessage('Añadiendo...', 'var(--text3)');
  const r = await api.spotifyAddToQueue(link, null, null, { trackAsRequest: false });
  if (r.ok) {
    _spSetQueueMessage(r.message || 'Añadido a la lista', '#4ade80');
    input.value = '';
    loadSpotifyQueue({ renderMain: true, silent: true }).catch(() => {});
    setTimeout(() => _spSetQueueMessage('', 'var(--text3)'), 3000);
  } else {
    _spSetQueueMessage((r.error || 'No se pudo añadir. ¿Spotify está reproduciendo?'), '#f87171');
  }
}

async function spRemoveFromSpotifyQueue(uriOrTrackId, name = '') {
  const target = String(uriOrTrackId || '').trim();
  if (!target) return;
  const r = await api.spotifyRemoveQueueItem(target);
  if (!r?.ok) {
    toast(`No se pudo quitar de la lista: ${r?.error || 'error desconocido'}`, 'err');
    return;
  }
  const trackId = String(target).includes(':') ? String(target).split(':')[2] : String(target);
  if (trackId) {
    await api.spotifyRemoveFromRequestQueue(trackId, { removeFromSpotify: false }).catch(() => {});
  }
  toast(`Quitada de la lista${name ? `: ${name}` : ''}`, 'ok');
  await loadSpotifyQueue();
  await loadRequestQueue();
}

function _spGetSearchOptions() {
  const typeTrack = !!document.getElementById('spTypeTrack')?.checked;
  const typeArtist = !!document.getElementById('spTypeArtist')?.checked;
  const typeAlbum = !!document.getElementById('spTypeAlbum')?.checked;
  const typePlaylist = !!document.getElementById('spTypePlaylist')?.checked;
  const sort = (document.getElementById('spSearchSort')?.value || 'relevance').toLowerCase();
  const limitRaw = Number(document.getElementById('spSearchLimit')?.value || 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(10, Math.round(limitRaw))) : 10;
  const types = [];
  if (typeTrack) types.push('track');
  if (typeArtist) types.push('artist');
  if (typeAlbum) types.push('album');
  if (typePlaylist) types.push('playlist');
  return {
    types: types.length ? types : ['track'],
    sort: sort === 'popularity' ? 'popularity' : 'relevance',
    limit,
  };
}

function _spSearchSection(title, count, html) {
  return `
    <div style="border:1px solid var(--border);border-radius:10px;padding:10px;background:rgba(255,255,255,.02)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <strong style="font-size:11px;color:var(--text2)">${_hSp(title)}</strong>
        <span style="font-size:10px;color:var(--text3)">${count}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px">${html}</div>
    </div>
  `;
}

function _spOpenExternal(url) {
  if (!url) return;
  api.openExternal(url).catch(() => {});
}

async function spPlayContextFromSearch(uri, btnId) {
  const btn = document.getElementById(btnId);
  if (btn) { btn.textContent = '...'; btn.disabled = true; }
  const r = await api.spotifyPlayContext(uri);
  if (btn) {
    btn.textContent = r?.ok === false ? '✕' : '▶';
    btn.disabled = false;
  }
  if (r?.ok !== false) setTimeout(loadNowPlaying, 800);
}

async function spSearch() {
  const query = document.getElementById('spSearchInput')?.value.trim() || '';
  const meta = document.getElementById('spSearchMeta');
  const results = document.getElementById('spSearchResults');
  if (!query || !results) return;

  const opts = _spGetSearchOptions();
  const reqSeq = ++_spSearchReqSeq;
  if (meta) meta.textContent = `Buscando "${query}"...`;
  results.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0">Buscando...</div>`;

  let r = null;
  try {
    r = await api.spotifySearch({ query, ...opts });
  } catch (e) {
    r = { ok: false, error: e?.message || String(e) };
  }
  if (reqSeq !== _spSearchReqSeq) return;
  if (!r?.ok) {
    if (meta) meta.textContent = 'Error en la búsqueda';
    results.innerHTML = `<div style="font-size:11px;color:#f87171;text-align:center;padding:12px 0">Error: ${_hSp(r?.error || 'desconocido')}</div>`;
    return;
  }

  const tracks = Array.isArray(r.tracks) ? r.tracks : [];
  const artists = Array.isArray(r.artists) ? r.artists : [];
  const albums = Array.isArray(r.albums) ? r.albums : [];
  const playlists = Array.isArray(r.playlists) ? r.playlists : [];
  const total = tracks.length + artists.length + albums.length + playlists.length;

  if (meta) {
    meta.textContent = `Resultados: ${total} · Tracks ${tracks.length} · Artistas ${artists.length} · Álbumes ${albums.length} · Playlists ${playlists.length}`;
  }
  if (!total) {
    results.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0">Sin resultados para "${_hSp(query)}".</div>`;
    return;
  }

  const tracksHtml = tracks.length
    ? tracks.map((t, idx) => {
      const rowId = `sr-track-btn-${t.id || idx}`;
      const trackLabel = `${t.name || 'Track'} - ${t.artist || ''}`.trim();
      return `
        <div class="sp-item">
          ${t.image ? `<img class="sp-item-art" src="${_hSp(t.image)}" alt="" />` : `<div class="sp-item-ph">♪</div>`}
          <div class="sp-item-info">
            <div class="sp-item-name">${_hSp(t.name || 'Sin título')}</div>
            <div class="sp-item-sub">${_hSp(t.artist || '—')} · ${_hSp(t.album || '—')}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
            <button class="btn btn-ghost" id="${rowId}" style="padding:4px 10px;font-size:11px"
              onclick="spSearchAddToQueue(decodeURIComponent('${encodeURIComponent(t.uri || '')}'),'${rowId}',decodeURIComponent('${encodeURIComponent(trackLabel)}'))">+ Cola</button>
            <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px"
              onclick="_spOpenExternal('${_hSp(t.url || '')}')">Abrir</button>
          </div>
        </div>
      `;
    }).join('')
    : `<div style="font-size:10px;color:var(--text3);text-align:center;padding:8px 0">Sin tracks.</div>`;

  const artistsHtml = artists.length
    ? artists.map((a, idx) => {
      const playId = `sr-artist-play-${a.id || idx}`;
      return `
        <div class="sp-item">
          ${a.image ? `<img class="sp-item-art" src="${_hSp(a.image)}" alt="" />` : `<div class="sp-item-ph">🎤</div>`}
          <div class="sp-item-info">
            <div class="sp-item-name">${_hSp(a.name || 'Sin nombre')}</div>
            <div class="sp-item-sub">Popularidad ${Number(a.popularity) || 0} · Seguidores ${(Number(a.followers) || 0).toLocaleString('es-UY')}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
            <button class="btn btn-ghost" id="${playId}" style="padding:4px 10px;font-size:11px"
              onclick="spPlayContextFromSearch(decodeURIComponent('${encodeURIComponent(a.uri || '')}'),'${playId}')">▶</button>
            <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px"
              onclick="_spOpenExternal('${_hSp(a.url || '')}')">Abrir</button>
          </div>
        </div>
      `;
    }).join('')
    : `<div style="font-size:10px;color:var(--text3);text-align:center;padding:8px 0">Sin artistas.</div>`;

  const albumsHtml = albums.length
    ? albums.map((a, idx) => {
      const playId = `sr-album-play-${a.id || idx}`;
      return `
        <div class="sp-item">
          ${a.image ? `<img class="sp-item-art" src="${_hSp(a.image)}" alt="" />` : `<div class="sp-item-ph">💿</div>`}
          <div class="sp-item-info">
            <div class="sp-item-name">${_hSp(a.name || 'Sin nombre')}</div>
            <div class="sp-item-sub">${_hSp(a.artist || '—')} · ${_hSp(a.year || '—')} · ${Number(a.totalTracks) || 0} temas</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
            <button class="btn btn-ghost" id="${playId}" style="padding:4px 10px;font-size:11px"
              onclick="spPlayContextFromSearch(decodeURIComponent('${encodeURIComponent(a.uri || '')}'),'${playId}')">▶</button>
            <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px"
              onclick="_spOpenExternal('${_hSp(a.url || '')}')">Abrir</button>
          </div>
        </div>
      `;
    }).join('')
    : `<div style="font-size:10px;color:var(--text3);text-align:center;padding:8px 0">Sin álbumes.</div>`;

  const playlistsHtml = playlists.length
    ? playlists.map((p, idx) => {
      const addId = `sr-playlist-add-${p.id || idx}`;
      const playlistLabel = `${p.name || 'Playlist'}${p.owner ? ` - ${p.owner}` : ''}`.trim();
      return `
        <div class="sp-item">
          ${p.image ? `<img class="sp-item-art" src="${_hSp(p.image)}" alt="" />` : `<div class="sp-item-ph">♫</div>`}
          <div class="sp-item-info">
            <div class="sp-item-name">${_hSp(p.name || 'Sin nombre')}</div>
            <div class="sp-item-sub">${_hSp(p.owner || '—')} · ${Number(p.totalTracks) || 0} temas</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
            <button class="btn btn-ghost" id="${addId}" style="padding:4px 10px;font-size:11px"
              onclick="spSearchAddToQueue(decodeURIComponent('${encodeURIComponent(p.uri || '')}'),'${addId}',decodeURIComponent('${encodeURIComponent(playlistLabel)}'))">+ Cola</button>
            <button class="btn btn-ghost" style="padding:4px 10px;font-size:11px"
              onclick="_spOpenExternal('${_hSp(p.url || '')}')">Abrir</button>
          </div>
        </div>
      `;
    }).join('')
    : `<div style="font-size:10px;color:var(--text3);text-align:center;padding:8px 0">Sin playlists.</div>`;

  results.innerHTML = [
    _spSearchSection('Tracks', tracks.length, tracksHtml),
    _spSearchSection('Artistas', artists.length, artistsHtml),
    _spSearchSection('Álbumes', albums.length, albumsHtml),
    _spSearchSection('Playlists', playlists.length, playlistsHtml),
  ].join('');
}

async function spSearchAddToQueue(uri, btnId, trackName) {
  const btn = document.getElementById(btnId);
  if (btn) { btn.textContent = '...'; btn.disabled = true; }
  const r = await api.spotifyAddToQueue(uri, null, trackName, { trackAsRequest: false });
  if (btn) {
    btn.textContent = r?.ok ? '✓' : '✕';
    if (r?.ok) setTimeout(() => { if (btn) { btn.textContent = '+ Cola'; btn.disabled = false; } }, 2500);
    else btn.disabled = false;
  }
  if (r?.ok) {
    toast(r?.message || 'Añadido a la lista', 'ok');
    setTimeout(loadSpotifyQueue, 1000);
  }
}

async function loadSpotifyQueue(opts = {}) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  const renderMain = options.renderMain !== false;
  const silent = !!options.silent;

  const list = document.getElementById('spQueueList');
  const r = await api.spotifyGetQueue({ limit: 80 });
  if (!r.ok) {
    if (renderMain && list) {
      list.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0">No se pudo cargar la cola.</div>`;
    }
    if (!silent) {
      const preview = document.getElementById('spQueuePreviewList');
      if (preview) preview.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:10px 0">No se pudo cargar la cola.</div>`;
    }
    return;
  }

  spQueueCache = Array.isArray(r.queue) ? r.queue : [];
  _spQueueLastSyncAt = Date.now();
  _renderSpotifyQueuePreview(spQueueCache);
  if (renderMain) _renderSpotifyQueueMain(spQueueCache, { silent });
}

async function toggleSongRequestKick(enabled) {
  const prev = srKickEnabled;
  const btn = document.getElementById('srKickMasterBtn');
  if (btn) btn.disabled = true;
  _setSongRequestKickMasterMsg(enabled ? 'Activando Song Request en Kick...' : 'Desactivando Song Request en Kick...', 'muted');

  const cfgRes = await api.spotifySongrequestToggleKick(enabled).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  const rewardRes = await kickRewardSet(enabled).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  const cfgOk = cfgRes?.ok !== false;
  const rewardOk = rewardRes?.ok !== false;

  if (!cfgOk || !rewardOk) {
    if (cfgOk && !rewardOk) await api.spotifySongrequestToggleKick(prev).catch(() => {});
    srKickEnabled = prev;
    _setSongRequestKickMasterUI(srKickEnabled);
    const errorMsg = (!cfgOk && cfgRes?.error)
      ? cfgRes.error
      : (rewardRes?.error || 'No se pudo cambiar el estado en Kick.');
    _setSongRequestKickMasterMsg(errorMsg, 'err');
    toast('No se pudo actualizar Song Request en Kick', 'err');
    if (btn) btn.disabled = false;
    return { ok: false, error: errorMsg };
  }

  srKickEnabled = !!enabled;
  _setSongRequestKickMasterUI(srKickEnabled);
  _setSongRequestKickMasterMsg(
    srKickEnabled
      ? 'Song Request activado y reward habilitada en Kick.'
      : 'Song Request desactivado y reward deshabilitada en Kick.',
    srKickEnabled ? 'ok' : 'warn'
  );
  toast(srKickEnabled ? 'Song Request Kick activado' : 'Song Request Kick desactivado', 'ok');
  if (btn) btn.disabled = false;
  return { ok: true, enabled: srKickEnabled };
}

function _setSongRequestKickMasterMsg(text, tone = 'muted') {
  const el = document.getElementById('srKickMasterMsg');
  if (!el) return;
  el.textContent = text || '';
  if (tone === 'ok') el.style.color = 'var(--green)';
  else if (tone === 'warn') el.style.color = 'var(--orange2)';
  else if (tone === 'err') el.style.color = 'var(--red)';
  else el.style.color = 'var(--text3)';
}

function _setSongRequestKickMasterUI(enabled) {
  const badge = document.getElementById('srKickMasterBadge');
  const btn = document.getElementById('srKickMasterBtn');
  const srKick = document.getElementById('srKickToggle');
  if (srKick) srKick.checked = !!enabled;
  if (badge) {
    if (enabled) {
      badge.textContent = 'Activo';
      badge.style.background = 'rgba(83,208,103,.15)';
      badge.style.color = '#53d067';
    } else {
      badge.textContent = 'Inactivo';
      badge.style.background = 'rgba(248,113,113,.1)';
      badge.style.color = '#f87171';
    }
  }
  if (btn) {
    btn.textContent = enabled ? 'Deshabilitar Song Request' : 'Habilitar Song Request';
    btn.style.color = enabled ? '#f87171' : '#53d067';
    btn.style.borderColor = enabled ? 'rgba(248,113,113,.25)' : 'rgba(83,208,103,.35)';
    btn.disabled = false;
  }
}

function _applySongRequestRealtimeConfig(config, source = 'local') {
  if (!config || typeof config !== 'object') return;
  srKickEnabled = config.kickEnabled !== false;
  _setSongRequestKickMasterUI(srKickEnabled);
  _srKickLastSyncAt = Date.now();
  if (source === 'supabase') {
    _setSongRequestKickMasterMsg(
      srKickEnabled
        ? 'Song Request activado desde otra PC (Supabase realtime).'
        : 'Song Request desactivado desde otra PC (Supabase realtime).',
      srKickEnabled ? 'ok' : 'warn'
    );
  }
}

function toggleSongRequestKickFromButton() {
  toggleSongRequestKick(!srKickEnabled).catch(() => {});
}

// ── Song Request Queue ────────────────────────────────────────────
let srRequestQueue = [];   // [{ nick, trackId, trackName }]
let srActiveRequester = null; // { nick, trackId, trackName }

function _hSr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _srDisplayTrackName(entry) {
  const rawName = String(entry?.trackName || '').trim();
  if (
    rawName
    && !/^spotify:(?:track|episode):/i.test(rawName)
    && !/^https?:\/\/(?:open|play)\.spotify\.com\//i.test(rawName)
  ) {
    return rawName;
  }
  return String(entry?.trackId || '').trim() || '—';
}

async function loadRequestQueue() {
  try {
    const r = await api.spotifyGetRequestQueue();
    srRequestQueue  = Array.isArray(r?.queue) ? r.queue : [];
    srActiveRequester = r?.active || null;
  } catch {
    srRequestQueue = [];
    srActiveRequester = null;
  }
  _renderRequestQueue();
}

function _renderRequestQueue() {
  if (!Array.isArray(srRequestQueue)) srRequestQueue = [];
  // Badge en el tab
  const badge = document.getElementById('spSongreqBadge');
  const total = srRequestQueue.length + (srActiveRequester ? 1 : 0);
  if (badge) { badge.textContent = total; badge.classList.toggle('hidden', total === 0); }

  // Canción activa
  const activeWrap = document.getElementById('srActiveWrap');
  if (activeWrap) {
    if (srActiveRequester) {
      activeWrap.classList.remove('hidden');
      document.getElementById('srActiveTrack').textContent = _srDisplayTrackName(srActiveRequester);
      document.getElementById('srActiveNick').textContent  = '@' + srActiveRequester.nick;
    } else {
      activeWrap.classList.add('hidden');
    }
  }

  // Lista de pendientes
  const list = document.getElementById('srPendingList');
  const countEl = document.getElementById('srPendingCount');
  if (countEl) countEl.textContent = srRequestQueue.length ? `(${srRequestQueue.length})` : '';
  if (!list) return;
  if (!srRequestQueue.length) {
    list.innerHTML = `<div style="text-align:center;padding:20px;font-size:11px;color:var(--text3)">Sin requests pendientes</div>`;
    return;
  }
  list.innerHTML = srRequestQueue.map((r, i) => `
    <div class="sp-item" style="gap:10px">
      <span style="font-family:'Bebas Neue',cursive;font-size:16px;color:var(--text3);min-width:18px;text-align:center;flex-shrink:0">${i + 1}</span>
      <div class="sp-item-info">
        <div class="sp-item-name">${_hSr(_srDisplayTrackName(r))}</div>
        <div class="sp-item-sub">pedida por <strong style="color:var(--text2)">@${_hSr(r.nick)}</strong></div>
      </div>
      <button class="todo-action-btn del" onclick="srRemoveFromQueue(decodeURIComponent('${encodeURIComponent(String(r.trackId || ''))}'))"
        title="Quitar del tracking y de la cola de Spotify">✕</button>
    </div>
  `).join('');
}

async function srSkipActive() {
  if (!srActiveRequester) return;
  if (_spTransportInFlight) return;
  await api.spotifyRemoveFromRequestQueue(srActiveRequester.trackId, { removeFromSpotify: false });
  srActiveRequester = null;
  _renderRequestQueue();
  const r = await _spRunTransport('next'); // saltear la canción actual
  if (!r?.ok && !r?.throttled) {
    showSpotifyError(r?.error || 'No se pudo saltear la canción');
  }
}

async function srRemoveFromQueue(trackId) {
  const res = await api.spotifyRemoveFromRequestQueue(trackId, { removeFromSpotify: true }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (!res?.ok) {
    toast(`No se pudo quitar: ${res?.error || 'error desconocido'}`, 'err');
    return;
  }
  srRequestQueue = srRequestQueue.filter(r => r.trackId !== trackId);
  _renderRequestQueue();
  if (res.warning) toast(`Quitado del tracking (aviso: ${res.warning})`, 'warn');
  else toast('Quitado del tracking y de la cola de Spotify', 'ok');
  loadSpotifyQueue().catch(() => {});
}

// Evento push desde main.js cuando llega un nuevo request o cambia el activo
api.onRequestQueueUpdate(({ queue, active }) => {
  srRequestQueue    = queue  || [];
  srActiveRequester = active || null;
  _renderRequestQueue();
});

if (typeof api.onSpotifySongrequestUpdated === 'function') {
  api.onSpotifySongrequestUpdated((payload) => {
    const config = payload?.config;
    if (!config) return;
    _applySongRequestRealtimeConfig(config, payload?.source || 'local');
  });
}

// Compatibilidad con el evento viejo (por si llegan fuera del flujo normal)
api.onSongRequested(({ nick, trackName, trackId }) => {
  _renderRequestQueue();
});
