// ── Soundboard ───────────────────────────────────────────────────
let sbLoaded = false;
let sbSounds = [];
let sbFilter = 'all';
let sbPendingFile = null;
let sbRowPendingFiles = new Map();
let sbCaptureCtx = null; // { mode: 'new'|'row', soundId, el, prev }
let sbAudioVoices = new Set();
let sbMasterVolume = 100;
let sbMuted = false;
let sbVoiceSeq = 1;
let sbPlayerTicker = null;
let sbVoiceMetaById = new Map(); // voiceId -> { id, soundId, name, audio, baseVolume, startedAt, duration }
let sbVoiceIdsBySound = new Map(); // soundId -> Set(voiceId)
let sbAudioCache = new Map(); // soundId -> { mimeType, blobUrl, updatedAt, fetchedAt }
let sbAudioFetchInFlight = new Map(); // soundId -> Promise
let sbPrewarmRun = 0;
let sbRecentHotkeyStarts = new Map(); // soundId -> ts
let sbResumePositionBySound = new Map(); // soundId -> seconds
const SB_IPC_TIMEOUT_MS = 30000;
const SB_HOTKEY_START_GRACE_MS = 350;

async function loadSoundboard() {
  if (!window.api?.soundboardGetState) return;
  if (!sbLoaded) {
    sbLoaded = true;
    sbBindEventsOnce();
    sbEnsurePlayerTicker();
    sbSyncPlayerControls();
  }
  await sbRefresh(false);
}

function sbBindEventsOnce() {
  if (window._sbEventsRegistered) return;
  window._sbEventsRegistered = true;

  api.onSoundboardPlay((payload) => {
    sbHandlePlayTrigger(payload).catch(() => {});
  });

  api.onSoundboardHotkeyFired((payload) => {
    if (!payload) return;
    const sid = String(payload.id || '');
    if (!sid) return;
    if (sbIsSoundPlaying(sid)) {
      if (sbWasRecentHotkeyStart(sid)) return;
      sbStopSoundVoices(sid, { preservePosition: true, silent: true });
      toast(`Detenido: ${payload?.name || 'sonido'}`, 'ok');
      return;
    }
    sbMarkLastPlay(payload, true);
  });

  document.addEventListener('keydown', (e) => {
    if (!sbCaptureCtx?.el) return;
    if (document.activeElement !== sbCaptureCtx.el) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      sbCaptureCtx.el.value = sbCaptureCtx.prev || '';
      sbCaptureCtx.el.blur();
      sbCaptureCtx = null;
      return;
    }

    const combo = sbKeyEventToElectron(e);
    if (!combo) return;

    sbCaptureCtx.el.value = combo;
    sbCaptureCtx.el.blur();
    sbCaptureCtx = null;
  }, true);

  window.addEventListener('beforeunload', () => {
    if (sbPlayerTicker) {
      clearInterval(sbPlayerTicker);
      sbPlayerTicker = null;
    }
    for (const sid of Array.from(sbAudioCache.keys())) sbDisposeAudioCacheEntry(sid);
    sbAudioFetchInFlight.clear();
  });
}

function sbEnsurePlayerTicker() {
  if (sbPlayerTicker) return;
  sbPlayerTicker = setInterval(() => {
    sbRenderPlayer();
  }, 180);
}

function sbSyncPlayerControls() {
  const range = document.getElementById('sbMasterVolumeRange');
  const input = document.getElementById('sbMasterVolumeInput');
  if (range) range.value = String(sbMasterVolume);
  if (input) input.value = String(sbMasterVolume);
  sbUpdateMuteBtn();
  sbRenderPlayer();
}

function sbDisposeAudioCacheEntry(soundId) {
  const key = String(soundId || '');
  const entry = sbAudioCache.get(key);
  if (!entry) return;
  try {
    if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  } catch {}
  sbAudioCache.delete(key);
}

function sbPruneAudioCacheByState() {
  const index = new Map();
  for (const s of sbSounds) {
    index.set(String(s.id), String(s.updatedAt || ''));
  }

  for (const [sid, entry] of sbAudioCache.entries()) {
    const stateUpdated = index.get(String(sid));
    if (!stateUpdated || String(entry.updatedAt || '') !== stateUpdated) {
      sbDisposeAudioCacheEntry(sid);
    }
  }
}

function sbBase64ToBlob(base64, mimeType) {
  const clean = String(base64 || '').replace(/\s+/g, '');
  const bin = atob(clean);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || 'audio/mpeg' });
}

async function sbFetchAudioToCache(soundId) {
  const sid = String(soundId || '');
  if (!sid) return { ok: false, error: 'Sonido inválido.' };
  if (sbAudioCache.has(sid)) return { ok: true, cache: sbAudioCache.get(sid) };
  if (sbAudioFetchInFlight.has(sid)) return sbAudioFetchInFlight.get(sid);

  const promise = (async () => {
    try {
      const r = await sbWithTimeout(api.soundboardGetAudio(sid), SB_IPC_TIMEOUT_MS, 'carga de audio');
      if (!r?.ok || !r.payload?.audioBase64) {
        return { ok: false, error: r?.error || 'No se pudo cargar el audio.' };
      }

      const mimeType = String(r.payload.mimeType || 'audio/mpeg').trim();
      const blob = sbBase64ToBlob(r.payload.audioBase64, mimeType);
      const blobUrl = URL.createObjectURL(blob);
      const cache = {
        mimeType,
        blobUrl,
        updatedAt: String(r.payload.updatedAt || ''),
        fetchedAt: Date.now(),
      };
      sbAudioCache.set(sid, cache);
      return { ok: true, cache };
    } catch (e) {
      return { ok: false, error: e?.message || 'No se pudo cargar el audio.' };
    } finally {
      sbAudioFetchInFlight.delete(sid);
    }
  })();

  sbAudioFetchInFlight.set(sid, promise);
  return promise;
}

function sbPrewarmAudioCache() {
  const run = ++sbPrewarmRun;
  const targets = sbSounds.filter((s) => s.enabled !== false).map((s) => String(s.id));
  const maxConcurrent = 2;
  let cursor = 0;
  let active = 0;

  function next() {
    if (run !== sbPrewarmRun) return;
    while (active < maxConcurrent && cursor < targets.length) {
      const sid = targets[cursor++];
      if (!sid || sbAudioCache.has(sid) || sbAudioFetchInFlight.has(sid)) continue;
      active++;
      sbFetchAudioToCache(sid).catch(() => {}).finally(() => {
        active--;
        next();
      });
    }
  }

  next();
}

function sbClampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function sbEffectiveVolume(baseVolume) {
  if (sbMuted) return 0;
  return Math.max(0, Math.min(1, (sbClampVolume(baseVolume) / 100) * (sbMasterVolume / 100)));
}

function sbApplyVolumesToAllVoices() {
  for (const meta of sbVoiceMetaById.values()) {
    try {
      meta.audio.volume = sbEffectiveVolume(meta.baseVolume);
    } catch {}
  }
}

function sbUpdateMuteBtn() {
  const btn = document.getElementById('sbMuteBtn');
  if (!btn) return;
  btn.textContent = sbMuted ? 'Activar audio' : 'Silenciar';
  btn.classList.toggle('is-active', sbMuted);
}

async function sbRefresh(force) {
  try {
    const r = force
      ? await sbWithTimeout(api.soundboardRefresh(), SB_IPC_TIMEOUT_MS, 'refresh de soundboard')
      : await sbWithTimeout(api.soundboardGetState(), SB_IPC_TIMEOUT_MS, 'carga de soundboard');
    if (!r?.ok) {
      sbRenderList([]);
      sbShowInlineMsg('sbUploadMsg', r?.error || 'No se pudo cargar la botonera.', 'err');
      return;
    }
    sbApplyState(r);
  } catch (e) {
    sbRenderList([]);
    sbShowInlineMsg('sbUploadMsg', 'Error cargando soundboard.', 'err');
  }
}

function sbApplyState(state) {
  sbSounds = Array.isArray(state?.sounds) ? state.sounds : [];
  const validIds = new Set(sbSounds.map((s) => String(s.id || '')));
  for (const sid of Array.from(sbResumePositionBySound.keys())) {
    if (!validIds.has(String(sid))) sbResumePositionBySound.delete(String(sid));
  }

  const toggle = document.getElementById('sbHotkeysToggle');
  if (toggle) toggle.checked = state.hotkeysEnabled !== false;
  const bucketInput = document.getElementById('sbStorageBucketInput');
  if (bucketInput && !bucketInput.value.trim()) {
    bucketInput.value = String(state?.soundboardBucket || 'soundboard');
  }
  sbUpdateStorageHint();
  sbPruneAudioCacheByState();

  sbUpdateStats();
  sbRenderFilterTabs();
  sbRenderList(sbFilterSounds());
  sbRenderPlayer();
  sbPrewarmAudioCache();
}

function sbUpdateStats() {
  const total = sbSounds.length;
  const withHotkey = sbSounds.filter((s) => !!s.hotkey).length;
  const enabled = sbSounds.filter((s) => s.enabled !== false).length;
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(val);
  };
  set('sbStatsTotal', total);
  set('sbStatsHotkeys', withHotkey);
  set('sbStatsEnabled', enabled);
}

function sbSetFilter(next) {
  sbFilter = ['all', 'enabled', 'hotkey'].includes(next) ? next : 'all';
  sbRenderFilterTabs();
  sbRenderList(sbFilterSounds());
}

function sbRenderFilterTabs() {
  ['all', 'enabled', 'hotkey'].forEach((k) => {
    const el = document.getElementById('sbFilter-' + k);
    if (el) el.classList.toggle('on', k === sbFilter);
  });
}

function sbFilterSounds() {
  if (sbFilter === 'enabled') return sbSounds.filter((s) => s.enabled !== false);
  if (sbFilter === 'hotkey') return sbSounds.filter((s) => !!s.hotkey);
  return [...sbSounds];
}

function sbIsSoundPlaying(soundId) {
  if (!soundId) return false;
  const ids = sbVoiceIdsBySound.get(String(soundId));
  return !!(ids && ids.size);
}

function sbHasResumePosition(soundId) {
  const sid = String(soundId || '');
  if (!sid) return false;
  const sec = Number(sbResumePositionBySound.get(sid) || 0);
  return Number.isFinite(sec) && sec > 0;
}

function sbGetResumePosition(soundId) {
  const sid = String(soundId || '');
  if (!sid) return 0;
  const sec = Number(sbResumePositionBySound.get(sid) || 0);
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return sec;
}

function sbSetResumePosition(soundId, seconds) {
  const sid = String(soundId || '');
  if (!sid) return;
  const sec = Number(seconds || 0);
  if (!Number.isFinite(sec) || sec <= 0) {
    sbResumePositionBySound.delete(sid);
    return;
  }
  sbResumePositionBySound.set(sid, sec);
}

function sbClearResumePosition(soundId) {
  const sid = String(soundId || '');
  if (!sid) return;
  sbResumePositionBySound.delete(sid);
}

function sbMarkHotkeyStart(soundId) {
  if (!soundId) return;
  sbRecentHotkeyStarts.set(String(soundId), Date.now());
}

function sbWasRecentHotkeyStart(soundId) {
  const sid = String(soundId || '');
  if (!sid) return false;
  const ts = Number(sbRecentHotkeyStarts.get(sid) || 0);
  if (!ts) return false;
  const recent = (Date.now() - ts) <= SB_HOTKEY_START_GRACE_MS;
  if (!recent) sbRecentHotkeyStarts.delete(sid);
  return recent;
}

function sbRenderList(list) {
  const wrap = document.getElementById('sbList');
  if (!wrap) return;

  if (!list.length) {
    wrap.innerHTML = `<div class="empty" style="padding:34px 20px">
      <div class="empty-ico" style="font-size:30px">🔈</div>
      <p>No hay sonidos para este filtro.</p>
    </div>`;
    return;
  }

  wrap.innerHTML = list.map((s) => sbSoundRowHTML(s)).join('');
}

function sbRenderPlayer() {
  const total = sbVoiceMetaById.size;
  const stateEl = document.getElementById('sbPlayerState');
  const countEl = document.getElementById('sbPlayerCount');
  const listEl = document.getElementById('sbNowPlayingList');
  if (stateEl) stateEl.textContent = total ? 'Reproduciendo sonidos' : 'Sin reproducción activa';
  if (countEl) countEl.textContent = `${total} activo${total === 1 ? '' : 's'}`;
  if (!listEl) return;

  if (!total) {
    listEl.innerHTML = '<div class="sb-now-empty">No hay sonidos reproduciéndose.</div>';
    return;
  }

  const rows = Array.from(sbVoiceMetaById.values())
    .sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0))
    .map((meta) => {
      const audio = meta.audio;
      const cur = Number(audio?.currentTime || 0);
      const durRaw = Number.isFinite(audio?.duration) && audio.duration > 0 ? Number(audio.duration) : Number(meta.duration || 0);
      const dur = Number.isFinite(durRaw) ? durRaw : 0;
      const progress = dur > 0 ? Math.max(0, Math.min(100, (cur / dur) * 100)) : 0;
      const timeText = dur > 0 ? `${sbFmtTime(cur)} / ${sbFmtTime(dur)}` : `${sbFmtTime(cur)} / --:--`;
      return `
        <div class="sb-now-row">
          <div class="sb-now-head">
            <span class="sb-now-name">${sbEsc(meta.name || 'Sonido')}</span>
            <span class="sb-now-time">${timeText}</span>
          </div>
          <div class="sb-now-bar"><span style="width:${progress.toFixed(1)}%"></span></div>
        </div>
      `;
    });

  listEl.innerHTML = rows.join('');
}

function sbFmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function sbSoundRowHTML(s) {
  const sizeMb = (Number(s.sizeBytes || 0) / (1024 * 1024)).toFixed(2);
  const hkClass = s.hotkeyError ? 'err' : s.hotkeyRegistered ? 'ok' : 'muted';
  const hkStatus = s.hotkey
    ? (s.hotkeyError ? `Conflicto: ${sbEsc(s.hotkeyError)}` : (s.hotkeyRegistered ? 'Atajo activo' : 'Atajo pendiente'))
    : 'Sin atajo';
  const isPlaying = sbIsSoundPlaying(s.id);
  const hasResume = sbHasResumePosition(s.id);
  const playLabel = isPlaying ? '⏸ Pausar' : (hasResume ? '▶ Reanudar' : '▶ Reproducir');
  const storagePath = String(s.storagePath || '');
  const storageBucket = String(s.storageBucket || 'soundboard');

  return `<div class="sb-row ${s.enabled === false ? 'is-disabled' : ''}" id="sb-row-${sbEscAttr(s.id)}">
    <div class="sb-row-top">
      <div class="sb-row-title">${sbEsc(s.name)}</div>
      <div class="sb-row-meta">${sbEsc(s.originalName || 'audio')} · ${sizeMb} MB · ${sbEsc((s.mimeType || '').replace('audio/', ''))} · ${sbEsc(storageBucket)}/${sbEsc(storagePath || '-')}</div>
    </div>

    <div class="sb-row-grid">
      <div class="ig" style="margin-bottom:0">
        <label>Nombre</label>
        <input id="sb-row-name-${sbEscAttr(s.id)}" type="text" maxlength="80" value="${sbEscAttr(s.name)}" />
      </div>
      <div class="ig" style="margin-bottom:0">
        <label>Volumen</label>
        <input id="sb-row-volume-${sbEscAttr(s.id)}" type="number" min="0" max="100" step="1" value="${sbEscAttr(s.volume)}" oninput="sbSetSoundLiveVolume('${sbEscAttr(s.id)}', this.value)" />
      </div>
      <div class="ig" style="margin-bottom:0">
        <label>Atajo global</label>
        <input id="sb-row-hotkey-${sbEscAttr(s.id)}" type="text" readonly value="${sbEscAttr(s.hotkey || '')}" placeholder="Sin atajo" onfocus="sbStartRowHotkeyCapture('${sbEscAttr(s.id)}')" onblur="sbStopRowHotkeyCapture('${sbEscAttr(s.id)}')" />
      </div>
      <div class="ig" style="margin-bottom:0">
        <label>Bucket</label>
        <input id="sb-row-storage-bucket-${sbEscAttr(s.id)}" type="text" value="${sbEscAttr(storageBucket)}" placeholder="soundboard" />
      </div>
      <div class="ig" style="margin-bottom:0">
        <label>Ruta en bucket</label>
        <input id="sb-row-storage-path-${sbEscAttr(s.id)}" type="text" value="${sbEscAttr(storagePath)}" placeholder="sounds/archivo.mp3" />
      </div>
    </div>

    <div class="sb-row-status ${hkClass}">${sbEsc(hkStatus)}</div>

    <div class="sb-row-actions">
      <label class="sb-check-inline">
        <input id="sb-row-enabled-${sbEscAttr(s.id)}" type="checkbox" ${s.enabled === false ? '' : 'checked'}>
        <span>Habilitado</span>
      </label>
      <button id="sb-play-btn-${sbEscAttr(s.id)}" class="btn btn-ghost sb-mini-btn" onclick="sbPlay('${sbEscAttr(s.id)}')">${playLabel}</button>
      <button class="btn btn-ghost sb-mini-btn" onclick="sbClearRowHotkey('${sbEscAttr(s.id)}')">Limpiar atajo</button>
      <button class="btn btn-ghost sb-mini-btn" onclick="document.getElementById('sb-row-file-${sbEscAttr(s.id)}').click()">Reemplazar audio</button>
      <button class="btn btn-orange sb-mini-btn" onclick="sbSaveRow('${sbEscAttr(s.id)}')">Guardar</button>
      <button class="btn btn-danger sb-mini-btn" onclick="sbDelete('${sbEscAttr(s.id)}')">Eliminar</button>
      <input id="sb-row-file-${sbEscAttr(s.id)}" type="file" accept="audio/*" class="hidden" onchange="sbOnRowFileSelected('${sbEscAttr(s.id)}', event)">
    </div>
  </div>`;
}

function sbOnFileSelected(ev) {
  const file = ev?.target?.files?.[0] || null;
  sbPendingFile = file;
  if (file && !document.getElementById('sbNameInput')?.value.trim()) {
    const autoName = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 80);
    document.getElementById('sbNameInput').value = autoName;
  }
  if (file) {
    const pathInput = document.getElementById('sbStoragePathInput');
    if (pathInput && !pathInput.value.trim()) {
      pathInput.value = `sounds/${String(file.name || '').trim().replace(/\\/g, '/').replace(/^\/+/, '')}`;
    }
  }
}

function sbOnRowFileSelected(soundId, ev) {
  const file = ev?.target?.files?.[0] || null;
  if (!file) {
    sbRowPendingFiles.delete(soundId);
    return;
  }
  sbRowPendingFiles.set(soundId, file);
  const pathInput = document.getElementById('sb-row-storage-path-' + soundId);
  if (pathInput && !String(pathInput.value || '').trim()) {
    pathInput.value = `sounds/${String(file.name || '').trim().replace(/\\/g, '/').replace(/^\/+/, '')}`;
  }
  toast('Audio seleccionado. Guardá para aplicar.', 'ok');
}

function sbStartHotkeyCapture() {
  const el = document.getElementById('sbHotkeyInput');
  if (!el) return;
  sbCaptureCtx = { mode: 'new', el, prev: el.value || '' };
  el.value = 'Presioná el combo...';
}

function sbStopHotkeyCapture() {
  const el = document.getElementById('sbHotkeyInput');
  if (!el) return;
  if (!sbCaptureCtx || sbCaptureCtx.el !== el) return;
  if (el.value === 'Presioná el combo...') el.value = sbCaptureCtx.prev || '';
  sbCaptureCtx = null;
}

function sbStartRowHotkeyCapture(soundId) {
  const el = document.getElementById('sb-row-hotkey-' + soundId);
  if (!el) return;
  sbCaptureCtx = { mode: 'row', soundId, el, prev: el.value || '' };
  el.value = 'Presioná el combo...';
}

function sbStopRowHotkeyCapture(soundId) {
  const el = document.getElementById('sb-row-hotkey-' + soundId);
  if (!el) return;
  if (!sbCaptureCtx || sbCaptureCtx.el !== el) return;
  if (el.value === 'Presioná el combo...') el.value = sbCaptureCtx.prev || '';
  sbCaptureCtx = null;
}

function sbClearHotkeyInput() {
  const el = document.getElementById('sbHotkeyInput');
  if (el) el.value = '';
}

function sbClearRowHotkey(soundId) {
  const el = document.getElementById('sb-row-hotkey-' + soundId);
  if (el) el.value = '';
}

function sbSetSoundLiveVolume(soundId, value) {
  const next = sbClampVolume(value);
  const input = document.getElementById('sb-row-volume-' + soundId);
  if (input) input.value = String(next);

  const sound = sbSounds.find((s) => s.id === soundId);
  if (sound) sound.volume = next;

  const ids = sbVoiceIdsBySound.get(soundId);
  if (!ids || !ids.size) return;
  for (const voiceId of ids) {
    const meta = sbVoiceMetaById.get(voiceId);
    if (!meta) continue;
    meta.baseVolume = next;
    try {
      meta.audio.volume = sbEffectiveVolume(meta.baseVolume);
    } catch {}
  }
}

function sbSetMasterVolume(value, source) {
  const next = sbClampVolume(value);
  sbMasterVolume = next;
  const range = document.getElementById('sbMasterVolumeRange');
  const input = document.getElementById('sbMasterVolumeInput');
  if (source !== 'range' && range) range.value = String(next);
  if (source !== 'input' && input) input.value = String(next);
  if (source === 'range' && input) input.value = String(next);
  if (source === 'input' && range) range.value = String(next);
  sbApplyVolumesToAllVoices();
}

function sbToggleMute() {
  sbMuted = !sbMuted;
  sbUpdateMuteBtn();
  sbApplyVolumesToAllVoices();
}

function sbKeyEventToElectron(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;

  const keyMap = {
    ' ': 'Space',
    Enter: 'Return',
    Backspace: 'Backspace',
    Tab: 'Tab',
    Escape: 'Escape',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    '+': 'Plus',
  };

  const key = keyMap[e.key] || (/^F([1-9]|1[0-9]|2[0-4])$/i.test(e.key) ? e.key.toUpperCase() : (e.key.length === 1 ? e.key.toUpperCase() : null));
  if (!key) return null;

  if (!mods.length) {
    const safeWithoutMods = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
    if (!safeWithoutMods) return null;
  }

  return [...mods, key].join('+');
}

async function sbToggleGlobalHotkeys(enabled) {
  let r = null;
  try {
    r = await sbWithTimeout(api.soundboardSetHotkeysEnabled(enabled), SB_IPC_TIMEOUT_MS, 'toggle de hotkeys');
  } catch (e) {
    toast(e?.message || 'No se pudo actualizar atajos globales.', 'err');
    const toggle = document.getElementById('sbHotkeysToggle');
    if (toggle) toggle.checked = !enabled;
    return;
  }
  if (!r?.ok) {
    toast(r?.error || 'No se pudo actualizar atajos globales.', 'err');
    const toggle = document.getElementById('sbHotkeysToggle');
    if (toggle) toggle.checked = !enabled;
    return;
  }
  sbApplyState(r);
  toast(enabled ? 'Atajos globales activados' : 'Atajos globales desactivados', 'ok');
}

async function sbUploadSound() {
  const name = document.getElementById('sbNameInput')?.value?.trim() || '';
  const hotkey = document.getElementById('sbHotkeyInput')?.value?.trim() || '';
  const volume = sbClampVolume(document.getElementById('sbVolumeInput')?.value || '100');
  const storagePath = document.getElementById('sbStoragePathInput')?.value?.trim() || '';
  const btn = document.getElementById('sbUploadBtn');

  if (!name) {
    sbShowInlineMsg('sbUploadMsg', 'El nombre es obligatorio.', 'err');
    return;
  }
  if (!sbPendingFile && !storagePath) {
    sbShowInlineMsg('sbUploadMsg', 'Subí archivo o indicá la ruta en bucket.', 'err');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Subiendo...';
  sbShowInlineMsg('sbUploadMsg', '', 'ok');

  try {
    const fileName = sbPendingFile ? String(sbPendingFile.name || '') : '';
    const fileMime = sbPendingFile ? String(sbPendingFile.type || '').toLowerCase() : '';
    const payload = {
      name,
      originalName: fileName || storagePath.split('/').pop() || '',
      mimeType: fileMime,
      hotkey,
      volume,
      enabled: true,
      storageBucket: document.getElementById('sbStorageBucketInput')?.value?.trim() || '',
      storagePath,
    };

    if (sbPendingFile) {
      const sourcePath = sbGetFilePath(sbPendingFile);
      if (sourcePath) {
        payload.sourceFilePath = sourcePath;
        payload.mimeType = String(sbPendingFile.type || '').toLowerCase();
      } else {
        const read = await sbReadFileAsBase64(sbPendingFile);
        if (!read.ok) {
          sbShowInlineMsg('sbUploadMsg', read.error || 'No se pudo leer el archivo.', 'err');
          return;
        }
        payload.mimeType = read.mimeType;
        payload.audioBase64 = read.base64;
      }
    }

    const r = await sbWithTimeout(api.soundboardUpload(payload), SB_IPC_TIMEOUT_MS, 'subida de sonido');

    if (!r?.ok) {
      sbShowInlineMsg('sbUploadMsg', r?.error || 'No se pudo subir el sonido.', 'err');
      return;
    }

    sbShowInlineMsg('sbUploadMsg', 'Sonido subido correctamente.', 'ok');
    sbResetCreateForm();
    if (r.state?.ok) sbApplyState(r.state);
    else await sbRefresh(true);
    toast('Sonido subido', 'ok');
  } catch (e) {
    sbShowInlineMsg('sbUploadMsg', e?.message || 'Error subiendo sonido.', 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Subir sonido';
  }
}

function sbResetCreateForm() {
  sbPendingFile = null;
  const file = document.getElementById('sbFileInput');
  if (file) file.value = '';
  const name = document.getElementById('sbNameInput');
  if (name) name.value = '';
  const hotkey = document.getElementById('sbHotkeyInput');
  if (hotkey) hotkey.value = '';
  const volume = document.getElementById('sbVolumeInput');
  if (volume) volume.value = '100';
  const storagePath = document.getElementById('sbStoragePathInput');
  if (storagePath) storagePath.value = '';
  const storageBucket = document.getElementById('sbStorageBucketInput');
  if (storageBucket && !storageBucket.value.trim()) storageBucket.value = 'soundboard';
}

async function sbSaveRow(soundId) {
  const name = document.getElementById('sb-row-name-' + soundId)?.value?.trim() || '';
  const hotkey = document.getElementById('sb-row-hotkey-' + soundId)?.value?.trim() || '';
  const volume = sbClampVolume(document.getElementById('sb-row-volume-' + soundId)?.value || '100');
  const storagePath = document.getElementById('sb-row-storage-path-' + soundId)?.value?.trim() || '';
  const storageBucket = document.getElementById('sb-row-storage-bucket-' + soundId)?.value?.trim() || '';
  const enabled = !!document.getElementById('sb-row-enabled-' + soundId)?.checked;
  const current = sbSounds.find((s) => s.id === soundId) || null;

  const patch = { name, hotkey, volume, enabled };
  if (storagePath || String(current?.storagePath || '').trim()) patch.storagePath = storagePath;
  if (storageBucket) patch.storageBucket = storageBucket;

  const replacement = sbRowPendingFiles.get(soundId);
  if (replacement) {
    patch.mimeType = String(replacement.type || '').toLowerCase();
    patch.originalName = replacement.name;
    const sourcePath = sbGetFilePath(replacement);
    if (sourcePath) {
      patch.sourceFilePath = sourcePath;
    } else {
      const read = await sbReadFileAsBase64(replacement);
      if (!read.ok) {
        toast(read.error || 'No se pudo leer el audio seleccionado.', 'err');
        return;
      }
      patch.audioBase64 = read.base64;
      patch.mimeType = read.mimeType;
    }
  }

  let r = null;
  try {
    r = await sbWithTimeout(api.soundboardUpdate(soundId, patch), SB_IPC_TIMEOUT_MS, 'guardado de sonido');
  } catch (e) {
    toast(e?.message || 'No se pudo guardar cambios.', 'err');
    return;
  }
  if (!r?.ok) {
    toast(r?.error || 'No se pudo guardar cambios.', 'err');
    return;
  }

  sbRowPendingFiles.delete(soundId);
  const fileInput = document.getElementById('sb-row-file-' + soundId);
  if (fileInput) fileInput.value = '';

  if (r.state?.ok) sbApplyState(r.state);
  else await sbRefresh(true);
  toast('Sonido actualizado', 'ok');
}

async function sbDelete(soundId) {
  const snd = sbSounds.find((s) => s.id === soundId);
  const label = snd?.name ? `"${snd.name}"` : 'este sonido';
  const ok = window.confirm(`¿Eliminar ${label}? Esta acción no se puede deshacer.`);
  if (!ok) return;

  let r = null;
  try {
    r = await sbWithTimeout(api.soundboardDelete(soundId), SB_IPC_TIMEOUT_MS, 'eliminación de sonido');
  } catch (e) {
    toast(e?.message || 'No se pudo eliminar el sonido.', 'err');
    return;
  }
  if (!r?.ok) {
    toast(r?.error || 'No se pudo eliminar el sonido.', 'err');
    return;
  }

  sbRowPendingFiles.delete(soundId);
  if (r.state?.ok) sbApplyState(r.state);
  else await sbRefresh(true);
  toast('Sonido eliminado', 'ok');
}

async function sbPlay(soundId) {
  const sid = String(soundId || '');
  if (!sid) return;
  if (sbIsSoundPlaying(sid)) {
    sbStopSoundVoices(sid, { preservePosition: true, silent: true });
    const playingSound = sbSounds.find((s) => s.id === sid);
    toast(`Pausado: ${playingSound?.name || 'sonido'}`, 'ok');
    return;
  }

  const sound = sbSounds.find((s) => s.id === sid);
  if (!sound || sound.enabled === false) {
    toast('Ese sonido no está disponible.', 'err');
    return;
  }

  const started = await sbStartVoice(sid, {
    id: sid,
    name: sound.name,
    volume: sound.volume,
    source: 'manual',
    ts: Date.now(),
  });
  if (!started.ok) {
    toast(started.error || 'No se pudo reproducir el sonido.', 'err');
    return;
  }

  sbMarkLastPlay({ id: sid, name: sound.name, ts: Date.now() }, false);
  api.soundboardPlay(sid).catch(() => {}); // mantiene logging/flujo de main sin bloquear el inicio local
}

async function sbHandlePlayTrigger(payload) {
  const soundId = String(payload?.id || '');
  if (!soundId) return;
  if (sbIsSoundPlaying(soundId)) return;

  const started = await sbStartVoice(soundId, payload || {});
  if (!started.ok) return;
  if (String(payload?.source || '') === 'hotkey') sbMarkHotkeyStart(soundId);
  sbMarkLastPlay(payload || { id: soundId, name: started.name, ts: Date.now() }, String(payload?.source || '') === 'hotkey');
}

async function sbStartVoice(soundId, payload) {
  const sid = String(soundId || '');
  if (!sid) return { ok: false, error: 'Sonido inválido.' };
  if (sbIsSoundPlaying(sid)) return { ok: false, error: 'Ese sonido ya está reproduciéndose.' };

  const cacheRes = await sbFetchAudioToCache(sid);
  if (!cacheRes?.ok || !cacheRes.cache?.blobUrl) return { ok: false, error: cacheRes?.error || 'No se pudo cargar audio.' };

  try {
    const snd = sbSounds.find((s) => s.id === sid);
    const baseVolume = sbClampVolume(payload?.volume ?? snd?.volume ?? 100);
    const soundName = String(payload?.name || snd?.name || 'Sonido');
    const audio = new Audio(cacheRes.cache.blobUrl);
    audio.preload = 'auto';
    audio.volume = sbEffectiveVolume(baseVolume);
    const resumePos = sbGetResumePosition(sid);
    const applyResume = () => {
      if (!(resumePos > 0)) return;
      let target = resumePos;
      const dur = Number(audio.duration || 0);
      if (Number.isFinite(dur) && dur > 0) {
        target = Math.min(target, Math.max(0, dur - 0.05));
      }
      try {
        audio.currentTime = Math.max(0, target);
      } catch {}
    };

    const voiceId = `v${sbVoiceSeq++}`;
    const meta = {
      id: voiceId,
      soundId: sid,
      name: soundName,
      audio,
      baseVolume,
      startedAt: Date.now(),
      duration: 0,
    };

    const cleanup = () => {
      const ids = sbVoiceIdsBySound.get(sid);
      if (ids) {
        ids.delete(voiceId);
        if (!ids.size) sbVoiceIdsBySound.delete(sid);
      }
      sbVoiceMetaById.delete(voiceId);
      sbAudioVoices.delete(audio);
      audio.onended = null;
      audio.onerror = null;
      audio.onloadedmetadata = null;
      sbRenderPlayer();
      sbRenderList(sbFilterSounds());
    };

    audio.onloadedmetadata = () => {
      const live = sbVoiceMetaById.get(voiceId);
      if (!live) return;
      if (Number.isFinite(audio.duration) && audio.duration > 0) live.duration = Number(audio.duration);
      applyResume();
    };
    audio.onended = () => {
      sbClearResumePosition(sid);
      cleanup();
    };
    audio.onerror = cleanup;

    sbVoiceMetaById.set(voiceId, meta);
    if (!sbVoiceIdsBySound.has(sid)) sbVoiceIdsBySound.set(sid, new Set());
    sbVoiceIdsBySound.get(sid).add(voiceId);
    sbAudioVoices.add(audio);
    sbRenderPlayer();
    sbRenderList(sbFilterSounds());

    if (audio.readyState >= 1) applyResume();

    const playPromise = audio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => cleanup());
    }
    return { ok: true, name: soundName };
  } catch (e) {
    return { ok: false, error: e?.message || 'No se pudo reproducir el sonido.' };
  }
}

function sbPlayAudioPayload(payload) {
  // Compatibilidad legacy: redirige al nuevo flujo.
  sbHandlePlayTrigger(payload).catch(() => {});
}

function sbStopAllAudio() {
  const voices = Array.from(sbAudioVoices);
  if (!voices.length) {
    toast('No hay audios reproduciéndose.', 'warn');
    return;
  }

  for (const audio of voices) {
    try {
      audio.pause();
      audio.currentTime = 0;
      audio.onended = null;
      audio.onerror = null;
      audio.onloadedmetadata = null;
    } catch {}
    sbAudioVoices.delete(audio);
  }
  sbVoiceMetaById.clear();
  sbVoiceIdsBySound.clear();
  sbRecentHotkeyStarts.clear();
  sbResumePositionBySound.clear();
  sbRenderPlayer();
  sbRenderList(sbFilterSounds());

  toast('Audios detenidos.', 'ok');
}

function sbStopSoundVoices(soundId, opts = {}) {
  const sid = String(soundId || '');
  if (!sid) return false;
  const ids = sbVoiceIdsBySound.get(sid);
  if (!ids || !ids.size) return false;

  let maxPosition = 0;
  const targetIds = Array.from(ids);
  for (const voiceId of targetIds) {
    const meta = sbVoiceMetaById.get(voiceId);
    if (!meta?.audio) {
      sbVoiceMetaById.delete(voiceId);
      ids.delete(voiceId);
      continue;
    }
    try {
      const cur = Number(meta.audio.currentTime || 0);
      if (Number.isFinite(cur) && cur > maxPosition) maxPosition = cur;
      meta.audio.pause();
      meta.audio.currentTime = 0;
      meta.audio.onended = null;
      meta.audio.onerror = null;
      meta.audio.onloadedmetadata = null;
    } catch {}
    sbAudioVoices.delete(meta.audio);
    sbVoiceMetaById.delete(voiceId);
    ids.delete(voiceId);
  }

  if (!ids.size) sbVoiceIdsBySound.delete(sid);
  if (opts?.preservePosition) sbSetResumePosition(sid, maxPosition);
  else sbClearResumePosition(sid);
  sbRecentHotkeyStarts.delete(sid);
  sbRenderPlayer();
  sbRenderList(sbFilterSounds());
  if (!opts?.silent) toast('Audio detenido.', 'ok');
  return true;
}

function sbMarkLastPlay(payload, fromHotkey) {
  const el = document.getElementById('sbLastPlay');
  if (!el) return;
  const name = sbEsc(String(payload?.name || 'Sonido'));
  const source = fromHotkey ? 'Atajo global' : 'Manual';
  const when = new Date(payload?.ts || Date.now()).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.textContent = `${when} · ${source} · ${name}`;
}

function sbShowInlineMsg(id, msg, type) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.remove('ok', 'err');
  if (msg) el.classList.add(type === 'err' ? 'err' : 'ok');
}

function sbUpdateStorageHint() {
  const hint = document.getElementById('sbStorageHint');
  if (!hint) return;
  hint.textContent = 'Modo único Supabase Storage: los audios se leen siempre desde el bucket. Podés subir manualmente y usar la ruta.';
}

function sbReadFileAsBase64(file) {
  return new Promise((resolve) => {
    if (!file) {
      resolve({ ok: false, error: 'Archivo inválido.' });
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => resolve({ ok: false, error: 'No se pudo leer el archivo.' });
    reader.onload = () => {
      const res = String(reader.result || '');
      const comma = res.indexOf(',');
      const header = comma > -1 ? res.slice(0, comma) : '';
      const base64 = comma > -1 ? res.slice(comma + 1) : '';
      const mime = (header.match(/^data:([^;]+);base64$/i)?.[1] || file.type || 'audio/mpeg').toLowerCase();
      if (!base64) {
        resolve({ ok: false, error: 'Audio inválido.' });
        return;
      }
      resolve({ ok: true, base64, mimeType: mime });
    };
    reader.readAsDataURL(file);
  });
}

function sbGetFilePath(file) {
  const p = file && typeof file.path === 'string' ? file.path : '';
  return p ? String(p).trim() : '';
}

function sbWithTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timeout en ${label} (${Math.round(ms / 1000)}s)`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function sbEsc(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sbEscAttr(v) {
  return sbEsc(v);
}
