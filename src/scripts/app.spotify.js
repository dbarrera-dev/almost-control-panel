// ── Spotify ───────────────────────────────────────────────────────
let spConnected   = false;
let spPollInterval = null;
let spIsPlaying   = false;
let spIsShuffle   = false;
let spRepeatState = 'off'; // 'off' | 'context' | 'track'
let spLastTrackName = null;
let spVolume      = 50;
let spVolumeTimer = null;
let spProgressMs  = 0;
let spDurationMs  = 0;
let spProgressInterval = null;
let _spPollFailCount = 0;
const _SP_POLL_BASE = 5000;
const _SP_POLL_MAX  = 60000;

// ── Spotify sub-tab navigation ─────────────────────────────────────
function goSpTab(name) {
  ['player','explorar','cola','overlay'].forEach(n => {
    document.getElementById('spview-' + n).classList.toggle('on', n === name);
    const tab = document.getElementById('sptab-' + n);
    if (tab) tab.classList.toggle('on', n === name);
  });
  if (name === 'explorar' && spConnected) { loadSpotifyPlaylists(); }
  if (name === 'cola'     && spConnected) { loadSpotifyQueue(); }
}

// ── Spotify load ───────────────────────────────────────────────────
async function loadSpotify() {
  try {
    await spovInit();
    const creds = await api.spotifyGetCredentials();
    if (creds.clientId)     document.getElementById('spClientId').value     = creds.clientId;
    if (creds.clientSecret) document.getElementById('spClientSecret').value = creds.clientSecret;

    const r = await api.getSpotifyStatus();
    spConnected = r.ok && r.connected;
    const dot = document.getElementById('spStatusDot');
    if (dot) dot.classList.toggle('on', spConnected);
    document.getElementById('spStatusBadge').textContent = spConnected ? '● Conectado' : 'Sin conectar';
    document.getElementById('spStatusBadge').className   = spConnected ? 'badge badge-on' : 'badge badge-off';
    document.getElementById('spNotConnected').classList.toggle('hidden',  spConnected);
    document.getElementById('spConnected').classList.toggle('hidden',    !spConnected);
    document.getElementById('spBadgeTab').classList.toggle('hidden',     !spConnected);
    document.getElementById('spConnectedWrap').classList.toggle('hidden', !spConnected);

    if (spConnected) {
      await loadNowPlaying();
      const srCfg = await api.spotifyGetSongrequestConfig();
      const srInput  = document.getElementById('songRewardIdInput');
      document.getElementById('srTwitchToggle').checked = srCfg.twitchEnabled !== false;
      document.getElementById('srKickToggle').checked   = srCfg.kickEnabled   !== false;
      if (srInput && srCfg.rewardId) srInput.value = srCfg.rewardId;
      api.twitchGetCredentials().then(cr => {
        if (cr.clientId)        document.getElementById('twitchClientIdInput').value    = cr.clientId;
        if (cr.broadcasterToken) document.getElementById('broadcasterTokenInput').value = cr.broadcasterToken;
        if (cr.clientId && cr.broadcasterToken) twitchRewardRefresh();
      }).catch(() => {});
      loadRequestQueue();
      _spPollFailCount = 0;
      if (spPollInterval) clearInterval(spPollInterval);
      spPollInterval = setInterval(pollNowPlaying, _SP_POLL_BASE);
    } else {
      _stopProgressTimer();
      clearInterval(spPollInterval); spPollInterval = null;
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
    if (r.volume !== null && r.volume !== undefined && !spVolumeTimer && !_spVolumeCommitting) {
      spVolume = r.volume;
      const slider = document.getElementById('spVolumeSlider');
      const lbl    = document.getElementById('spVolumeLabel');
      if (slider) slider.value = spVolume;
      if (lbl)    lbl.textContent = spVolume + '%';
    }
    if (r.progress_ms !== undefined) {
      spProgressMs = r.progress_ms;
      spDurationMs = r.duration_ms || 0;
      _updateProgressBar();
    }
    const newTrack   = r.track?.name || null;
    const stateChanged = r.playing !== spIsPlaying;
    if (newTrack === spLastTrackName && !stateChanged) return;
    spLastTrackName = newTrack;
    _applyNowPlaying(r);
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
  if (r.volume !== null && r.volume !== undefined) {
    spVolume = r.volume;
    const slider = document.getElementById('spVolumeSlider');
    const lbl    = document.getElementById('spVolumeLabel');
    if (slider) slider.value = spVolume;
    if (lbl)    lbl.textContent = spVolume + '%';
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
  await loadSpotify();
}

function showSpReconnect() {
  document.getElementById('spConnected').classList.add('hidden');
  document.getElementById('spNotConnected').classList.remove('hidden');
}

async function spotifyDisconnect() {
  const r = await api.spotifyDisconnect();
  if (!r.ok) { toast('Error al desconectar', 'err'); return; }
  await loadSpotify();
}

api.onSpotifyOAuthStatus(({ step }) => {
  const el = document.getElementById('spOAuthStatus');
  if (!el) return;
  el.style.display = 'block';
  el.textContent = step === 'exchanging' ? '🔄 Guardando tokens...' : '⏳ Esperando autorización en el navegador...';
});

function updateSpControls() { _updateSpControls(); }

async function spAction(action) {
  const r = action === 'prev' ? await api.spotifyPrev() : await api.spotifyNext();
  if (!r?.ok) { showSpotifyError(r?.error || 'Error al cambiar canción'); return; }
  setTimeout(loadNowPlaying, 600);
}

async function spTogglePlayPause() {
  const btn = document.getElementById('spPlayPauseBtn');
  btn.disabled = true;
  const r = spIsPlaying ? await api.spotifyPause() : await api.spotifyPlay();
  btn.disabled = false;
  if (!r?.ok) {
    const msg = r?.status === 404
      ? 'Sin dispositivo activo — abrí Spotify primero'
      : (r?.error || 'Error al controlar Spotify');
    showSpotifyError(msg);
    setTimeout(loadNowPlaying, 500);
    return;
  }
  spIsPlaying = !spIsPlaying;
  _updateSpControls();
  setTimeout(loadNowPlaying, 600);
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

let _spVolumeCommitting = false;

function spVolumeInput(val) {
  spVolume = parseInt(val);
  const lbl = document.getElementById('spVolumeLabel');
  if (lbl) lbl.textContent = spVolume + '%';
  clearTimeout(spVolumeTimer);
  spVolumeTimer = setTimeout(() => spVolumeCommit(spVolume), 400);
}

async function spVolumeCommit(val) {
  clearTimeout(spVolumeTimer);
  spVolume = parseInt(val);
  _spVolumeCommitting = true;
  const r = await api.spotifySetVolume(spVolume);
  _spVolumeCommitting = false;
  if (r && r.ok === false) {
    // API failed — re-sync from Spotify's real state
    const state = await api.spotifyNowPlaying();
    if (state?.ok && state.volume !== null && state.volume !== undefined) {
      spVolume = state.volume;
      const slider = document.getElementById('spVolumeSlider');
      const lbl    = document.getElementById('spVolumeLabel');
      if (slider) slider.value = spVolume;
      if (lbl)    lbl.textContent = spVolume + '%';
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

async function spovInit() {
  if (spovLoaded) return;
  spovLoaded = true;
  const st = await api.spotifyOverlayStatus();
  const r  = await api.spotifyOverlayGetConfig();
  spovCfg  = r.config || spovCfg;
  const badge = document.getElementById('spovStatusBadge');
  if (st.running) { badge.textContent = '● Activo'; badge.className = 'badge'; badge.style.background = '#1DB954'; badge.style.color = '#000'; }
  else            { badge.textContent = 'Inactivo'; badge.className = 'badge badge-off'; badge.style = ''; }
  spovApplyUI();
}

api.onSpotifyOverlayStatus((st) => {
  const badge = document.getElementById('spovStatusBadge');
  if (!badge) return;
  if (st.running) { badge.textContent = '● Activo'; badge.className = 'badge'; badge.style.background = '#1DB954'; badge.style.color = '#000'; }
  else            { badge.textContent = 'Inactivo'; badge.className = 'badge badge-off'; badge.style = ''; }
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

function spovCopyUrl(btn) {
  const url = document.getElementById('spovUrl').textContent;
  const ta = document.createElement('textarea');
  ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  const orig = btn.textContent;
  btn.textContent = '✓ Copiado'; btn.style.color = '#4ade80';
  setTimeout(() => { btn.textContent = orig; btn.style.color = ''; }, 1500);
}

async function spAddToQueue() {
  const inp = document.getElementById('spQueueInput');
  const msg = document.getElementById('spQueueMsg');
  const link = inp.value.trim();
  if (!link) return;
  msg.style.color = 'var(--text3)';
  msg.textContent = 'Añadiendo...';
  const r = await api.spotifyAddToQueue(link, 'dqiuqui');
  if (r.ok) {
    msg.style.color = '#4ade80';
    msg.textContent = 'Canción añadida a la cola';
    inp.value = '';
    setTimeout(() => { msg.textContent = ''; }, 3000);
  } else {
    msg.style.color = '#f87171';
    msg.textContent = (r.error || 'No se pudo añadir. ¿Spotify está reproduciendo?');
  }
}

async function loadSpotifyPlaylists() {
  const list = document.getElementById('spPlaylistList');
  list.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:16px 0">Cargando playlists...</div>`;
  const r = await api.spotifyGetPlaylists();
  if (!r.ok) {
    list.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:16px 0">No se pudieron cargar las playlists.<br><span style="font-size:10px;opacity:.6">Si acabas de conectar la cuenta, reconectala para actualizar los permisos.</span></div>`;
    return;
  }
  if (!r.playlists.length) {
    list.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:16px 0">No se encontraron playlists guardadas.</div>`;
    return;
  }
  list.innerHTML = r.playlists.map(p => `
    <div class="sp-item" id="pl-${p.id}" onclick="spPlayPlaylist('${p.uri}','${p.id}')">
      ${p.image
        ? `<img class="sp-item-art" src="${p.image}" alt="" />`
        : `<div class="sp-item-ph">♪</div>`}
      <div class="sp-item-info">
        <div class="sp-item-name">${p.name}</div>
        <div class="sp-item-sub">${p.tracks} canciones</div>
      </div>
      <button class="btn btn-ghost" id="pl-btn-${p.id}" style="padding:4px 10px;font-size:11px;flex-shrink:0">▶</button>
    </div>
  `).join('');
}

async function spPlayPlaylist(uri, id) {
  const btn = document.getElementById('pl-btn-' + id);
  if (btn) { btn.textContent = '...'; btn.disabled = true; }
  const r = await api.spotifyPlayContext(uri);
  if (btn) {
    btn.textContent = r?.ok === false ? '✕' : '▶';
    btn.disabled = false;
  }
  if (r?.ok !== false) setTimeout(loadNowPlaying, 800);
}

async function spSearch() {
  const query = document.getElementById('spSearchInput').value.trim();
  if (!query) return;
  const results = document.getElementById('spSearchResults');
  results.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0">Buscando...</div>`;
  const r = await api.spotifySearch(query);
  if (!r.ok) {
    results.innerHTML = `<div style="font-size:11px;color:#f87171;text-align:center;padding:12px 0">Error: ${r.error || 'desconocido'}</div>`;
    return;
  }
  if (!r.tracks.length) {
    results.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0">Sin resultados.</div>`;
    return;
  }
  results.innerHTML = r.tracks.map(t => `
    <div class="sp-item">
      ${t.image
        ? `<img class="sp-item-art" src="${t.image}" alt="" />`
        : `<div class="sp-item-ph">♪</div>`}
      <div class="sp-item-info">
        <div class="sp-item-name">${t.name}</div>
        <div class="sp-item-sub">${t.artist}</div>
      </div>
      <button class="btn btn-ghost" id="sr-btn-${t.id}" style="padding:4px 10px;font-size:11px;flex-shrink:0"
        onclick="spSearchAddToQueue('${t.uri}','${t.id}','${t.name.replace(/'/g,"\\'")} - ${t.artist.replace(/'/g,"\\'")}')">+ Cola</button>
    </div>
  `).join('');
}

async function spSearchAddToQueue(uri, id, trackName) {
  const btn = document.getElementById('sr-btn-' + id);
  if (btn) { btn.textContent = '...'; btn.disabled = true; }
  const r = await api.spotifyAddToQueue(uri, 'dqiuqui', trackName);
  if (btn) {
    btn.textContent = r?.ok ? '✓' : '✕';
    if (r?.ok) setTimeout(() => { if (btn) { btn.textContent = '+ Cola'; btn.disabled = false; } }, 2000);
    else btn.disabled = false;
  }
  if (r?.ok) setTimeout(loadSpotifyQueue, 1000);
}

async function loadSpotifyQueue() {
  const list = document.getElementById('spQueueList');
  const r = await api.spotifyGetQueue();
  if (!r.ok) {
    list.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0">No se pudo cargar la cola.</div>`;
    return;
  }
  if (!r.queue.length) {
    list.innerHTML = `<div style="font-size:11px;color:var(--text3);text-align:center;padding:12px 0">La cola está vacía.</div>`;
    return;
  }
  list.innerHTML = r.queue.map((t, i) => `
    <div class="sp-item">
      <span style="font-size:10px;color:var(--text3);min-width:16px;text-align:center;flex-shrink:0;font-family:'Bebas Neue',cursive;font-size:14px">${i + 1}</span>
      ${t.image
        ? `<img class="sp-item-art" style="width:32px;height:32px" src="${t.image}" alt="" />`
        : `<div class="sp-item-ph" style="width:32px;height:32px">♪</div>`}
      <div class="sp-item-info">
        <div class="sp-item-name">${t.name}</div>
        <div class="sp-item-sub">${t.artist}</div>
      </div>
    </div>
  `).join('');
}

async function toggleSongRequestTwitch(enabled) {
  await api.spotifySongrequestToggleTwitch(enabled);
  twitchRewardSet(enabled).catch(() => {});
  toast(enabled ? 'Song Request Twitch activado' : 'Song Request Twitch desactivado', 'ok');
}

async function toggleSongRequestKick(enabled) {
  await api.spotifySongrequestToggleKick(enabled);
  kickRewardSet(enabled).catch(() => {});
  toast(enabled ? 'Song Request Kick activado' : 'Song Request Kick desactivado', 'ok');
}

async function saveSongRewardId() {
  const id = document.getElementById('songRewardIdInput').value.trim();
  await api.spotifySongrequestSetReward(id);
}

function toggleRewardIdVisibility() {
  const input = document.getElementById('songRewardIdInput');
  const btn = event.target;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Ocultar' : 'Mostrar';
}

function toggleTwitchClientIdVisibility() {
  const input = document.getElementById('twitchClientIdInput');
  const btn = event.target;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Ocultar' : 'Mostrar';
}

function toggleBroadcasterTokenVisibility() {
  const input = document.getElementById('broadcasterTokenInput');
  const btn = event.target;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? 'Ocultar' : 'Mostrar';
}

let _saveTwitchCfgTimer = null;
async function saveTwitchCredentials() {
  clearTimeout(_saveTwitchCfgTimer);
  _saveTwitchCfgTimer = setTimeout(async () => {
    const clientId        = document.getElementById('twitchClientIdInput').value;
    const broadcasterToken = document.getElementById('broadcasterTokenInput').value;
    await api.twitchSaveCredentials({ clientId, broadcasterToken });
  }, 800);
}

function _setRewardStatusBadge(enabled) {
  const badge = document.getElementById('rewardStatusBadge');
  if (!badge) return;
  if (enabled === true)  { badge.className = 'badge badge-on';  badge.textContent = 'Habilitada'; }
  else if (enabled === false) { badge.className = 'badge badge-off'; badge.textContent = 'Deshabilitada'; }
  else                   { badge.className = 'badge';            badge.textContent = '—'; }
}

async function twitchRewardRefresh() {
  const msg = document.getElementById('rewardToggleMsg');
  msg.textContent = 'Consultando...';
  msg.style.color = 'var(--text3)';
  const r = await api.twitchRewardGetStatus();
  if (r.ok) {
    _setRewardStatusBadge(r.enabled);
    msg.textContent = '';
  } else {
    msg.textContent = r.error === 'config_missing' ? 'Falta Client ID o token.' : (r.error || 'Error al consultar.');
    msg.style.color = 'var(--red)';
  }
}

async function twitchRewardSet(enabled) {
  const msg = document.getElementById('rewardToggleMsg');
  msg.textContent = enabled ? 'Habilitando...' : 'Deshabilitando...';
  msg.style.color = 'var(--text3)';
  const r = await api.twitchRewardToggle(enabled);
  if (r.ok) {
    _setRewardStatusBadge(enabled);
    msg.textContent = enabled ? 'Recompensa habilitada.' : 'Recompensa deshabilitada.';
    msg.style.color = enabled ? 'var(--green)' : 'var(--red)';
  } else {
    msg.textContent = 'Error: ' + (r.error || 'no se pudo cambiar.');
    msg.style.color = 'var(--red)';
  }
}

// ── Song Request Queue ────────────────────────────────────────────
let srRequestQueue = [];   // [{ nick, trackId, trackName }]
let srActiveRequester = null; // { nick, trackId, trackName }

async function loadRequestQueue() {
  const r = await api.spotifyGetRequestQueue();
  srRequestQueue  = r.queue  || [];
  srActiveRequester = r.active || null;
  _renderRequestQueue();
}

function _renderRequestQueue() {
  // Badge en el tab
  const badge = document.getElementById('spSongreqBadge');
  const total = srRequestQueue.length + (srActiveRequester ? 1 : 0);
  if (badge) { badge.textContent = total; badge.classList.toggle('hidden', total === 0); }

  // Canción activa
  const activeWrap = document.getElementById('srActiveWrap');
  if (activeWrap) {
    if (srActiveRequester) {
      activeWrap.classList.remove('hidden');
      document.getElementById('srActiveTrack').textContent = srActiveRequester.trackName || srActiveRequester.trackId || '—';
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
        <div class="sp-item-name">${r.trackName || r.trackId}</div>
        <div class="sp-item-sub">pedida por <strong style="color:var(--text2)">@${r.nick}</strong></div>
      </div>
      <button class="todo-action-btn del" onclick="srRemoveFromQueue('${r.trackId}')"
        title="Quitar del tracking (la canción ya está en la cola de Spotify)">✕</button>
    </div>
  `).join('');
}

async function srSkipActive() {
  if (!srActiveRequester) return;
  await api.spotifyRemoveFromRequestQueue(srActiveRequester.trackId);
  srActiveRequester = null;
  _renderRequestQueue();
  await api.spotifyNext(); // saltear la canción actual
  setTimeout(loadNowPlaying, 800);
}

async function srRemoveFromQueue(trackId) {
  await api.spotifyRemoveFromRequestQueue(trackId);
  srRequestQueue = srRequestQueue.filter(r => r.trackId !== trackId);
  _renderRequestQueue();
  toast('Quitado del tracking', 'ok');
}

// Evento push desde main.js cuando llega un nuevo request o cambia el activo
api.onRequestQueueUpdate(({ queue, active }) => {
  srRequestQueue    = queue  || [];
  srActiveRequester = active || null;
  _renderRequestQueue();
});

// Compatibilidad con el evento viejo (por si llegan fuera del flujo normal)
api.onSongRequested(({ nick, trackName, trackId }) => {
  _renderRequestQueue();
});

