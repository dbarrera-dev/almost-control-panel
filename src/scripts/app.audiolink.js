// ── Audio Link (VBAN) UI ─────────────────────────────────────────
let alLoaded = false;
let alPolling = null;
let alLevelsPolling = null;
let alVmConnected = false;
let alObsConnected = false;

async function loadAudiolink() {
  if (alLoaded) { alRefreshStatus(); return; }
  alLoaded = true;
  try {
    const cfg = await api.audiolinkGetConfig();
    if (!cfg.ok) return;
    alApplyCfgToUI(cfg);
    alRefreshStatus();
    alStartPolling();
    alDetectIp();
  } catch (e) {
    console.error('audiolink init error', e);
  }
}

function alApplyCfgToUI(cfg) {
  document.getElementById('alMode').value = cfg.audiolinkMode || 'emitter';
  document.getElementById('alStreamName').value = cfg.audiolinkStreamName || 'MUSIC_STREAM';
  document.getElementById('alPort').value = cfg.audiolinkPort || 6980;
  document.getElementById('alSampleRate').value = String(cfg.audiolinkSampleRate || 48000);
  document.getElementById('alVbanIndex').value = String(cfg.audiolinkVbanIndex ?? 0);
  document.getElementById('alSendToggle').checked = cfg.audiolinkSendEnabled ?? false;
  document.getElementById('alMonitorToggle').checked = cfg.audiolinkMonitorEnabled ?? false;
  document.getElementById('alObsEnabled').checked = cfg.audiolinkObsEnabled ?? false;
  document.getElementById('alObsAddress').value = cfg.audiolinkObsAddress || 'ws://127.0.0.1:4455';
  document.getElementById('alObsPassword').value = cfg.audiolinkObsPassword || '';
  document.getElementById('alObsSource').value = cfg.audiolinkObsSourceName || 'Music VBAN';

  // IP field — depends on mode
  const mode = cfg.audiolinkMode || 'emitter';
  if (mode === 'emitter') {
    document.getElementById('alTargetIp').value = cfg.audiolinkTargetIp || '192.168.1.100';
  } else {
    document.getElementById('alTargetIp').value = cfg.audiolinkSourceIp || '192.168.1.50';
  }
  alUpdateModeUI(mode);

  // Send toggle label
  const sendLabel = document.getElementById('alSendLabel');
  if (sendLabel) sendLabel.textContent = mode === 'emitter' ? 'Enviar música' : 'Recibir música';

  // Platforms
  const rules = cfg.audiolinkPlatformRules || {};
  ['kick','tiktok','youtube'].forEach(p => {
    const cb = document.getElementById('alPlat' + p.charAt(0).toUpperCase() + p.slice(1));
    const st = document.getElementById('alPlat' + p.charAt(0).toUpperCase() + p.slice(1) + 'Status');
    if (cb) cb.checked = rules[p]?.includeMusic ?? false;
    if (st) st.textContent = (rules[p]?.includeMusic ?? false) ? 'Incluida' : 'Excluida';
  });

  // OBS body visibility
  document.getElementById('alObsBody').style.display = cfg.audiolinkObsEnabled ? '' : 'none';
}

function alUpdateModeUI(mode) {
  const label = document.getElementById('alIpLabel');
  const hint = document.getElementById('alIpHint');
  const modeHint = document.getElementById('alModeHint');
  if (mode === 'emitter') {
    if (label) label.textContent = 'IP destino (PC Gaming)';
    if (hint) hint.textContent = 'IP de la PC que va a recibir la música';
    if (modeHint) modeHint.textContent = 'Esta PC envía la música por VBAN. Spotify/YT Music deben reproducirse aquí.';
  } else {
    if (label) label.textContent = 'IP origen (PC Streaming)';
    if (hint) hint.textContent = 'IP de la PC que envía la música';
    if (modeHint) modeHint.textContent = 'Esta PC recibe la música y la reproduce en tus auriculares. No pasa por la capturadora.';
  }
}

function alModeChanged() {
  const mode = document.getElementById('alMode').value;
  alUpdateModeUI(mode);
  const sendLabel = document.getElementById('alSendLabel');
  if (sendLabel) sendLabel.textContent = mode === 'emitter' ? 'Enviar música' : 'Recibir música';
}

// ── Save Config ──────────────────────────────────────────────────

async function alSaveConfig() {
  const mode = document.getElementById('alMode').value;
  const data = {
    audiolinkEnabled: true,
    audiolinkMode: mode,
    audiolinkStreamName: document.getElementById('alStreamName').value.trim(),
    audiolinkPort: parseInt(document.getElementById('alPort').value) || 6980,
    audiolinkSampleRate: parseInt(document.getElementById('alSampleRate').value) || 48000,
    audiolinkVbanIndex: parseInt(document.getElementById('alVbanIndex').value) || 0,
    audiolinkObsEnabled: document.getElementById('alObsEnabled').checked,
    audiolinkObsAddress: document.getElementById('alObsAddress').value.trim(),
    audiolinkObsPassword: document.getElementById('alObsPassword').value,
    audiolinkObsSourceName: document.getElementById('alObsSource').value.trim(),
  };
  const ip = document.getElementById('alTargetIp').value.trim();
  if (mode === 'emitter') data.audiolinkTargetIp = ip;
  else data.audiolinkSourceIp = ip;

  try {
    const res = await api.audiolinkSaveConfig(data);
    alShowAlert('alCfgAlert', res.ok ? 'ok' : 'err', res.ok ? 'Configuración guardada ✓' : 'Error: ' + (res.error || ''));
    if (typeof toast === 'function') toast(res.ok ? 'Audio Link guardado' : 'Error al guardar', res.ok ? 'ok' : 'err');
  } catch (e) {
    alShowAlert('alCfgAlert', 'err', 'Error al guardar');
  }
}

function alShowAlert(id, type, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'al-alert ' + type;
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// ── Toggles ──────────────────────────────────────────────────────

async function alToggleSend() {
  const on = document.getElementById('alSendToggle').checked;
  try { await api.audiolinkToggleSend(on); } catch {}
}

async function alToggleMonitor() {
  const on = document.getElementById('alMonitorToggle').checked;
  try { await api.audiolinkToggleMonitor(on); } catch {}
}

async function alToggleObs() {
  const on = document.getElementById('alObsEnabled').checked;
  document.getElementById('alObsBody').style.display = on ? '' : 'none';
}

// ── Voicemeeter ──────────────────────────────────────────────────

async function alToggleVm() {
  const btn = document.getElementById('alVmBtn');
  if (alVmConnected) {
    await api.audiolinkVmDisconnect();
    alVmConnected = false;
    btn.textContent = 'Conectar Voicemeeter';
  } else {
    btn.textContent = 'Conectando...';
    btn.disabled = true;
    try {
      const res = await api.audiolinkVmConnect();
      alVmConnected = res.ok;
      btn.textContent = res.ok ? 'Desconectar Voicemeeter' : 'Conectar Voicemeeter';
      if (!res.ok && typeof toast === 'function') toast('Error: ' + (res.error || 'No conectado'), 'err');
    } catch {
      btn.textContent = 'Conectar Voicemeeter';
    }
    btn.disabled = false;
  }
  alRefreshStatus();
}

async function alApplyProfile() {
  try {
    const res = await api.audiolinkApplyProfile();
    if (typeof toast === 'function') toast(res.ok ? 'Perfil aplicado ✓' : 'Error: ' + (res.error || ''), res.ok ? 'ok' : 'err');
  } catch {}
  alRefreshStatus();
}

async function alReconnect() {
  try {
    const res = await api.audiolinkReconnect();
    if (typeof toast === 'function') toast(res.ok ? 'Reconectado ✓' : 'Error: ' + (res.error || ''), res.ok ? 'ok' : 'err');
  } catch {}
  alRefreshStatus();
}

// ── OBS ──────────────────────────────────────────────────────────

async function alObsConnect() {
  const btn = document.getElementById('alObsConnBtn');
  if (alObsConnected) {
    await api.audiolinkObsDisconnect();
    alObsConnected = false;
    btn.textContent = 'Conectar OBS';
  } else {
    btn.textContent = 'Conectando...';
    btn.disabled = true;
    // Save config first so main process has the latest address/password
    await alSaveConfig();
    try {
      const res = await api.audiolinkObsConnect();
      alObsConnected = res.ok;
      btn.textContent = res.ok ? 'Desconectar OBS' : 'Conectar OBS';
      if (!res.ok && typeof toast === 'function') toast('OBS: ' + (res.error || 'No conectado'), 'err');
      if (res.ok && typeof toast === 'function') toast('OBS conectado ✓', 'ok');
    } catch {
      btn.textContent = 'Conectar OBS';
    }
    btn.disabled = false;
  }
  alRefreshStatus();
}

async function alObsListSources() {
  const container = document.getElementById('alObsSourcesList');
  container.classList.remove('hidden');
  container.innerHTML = '<span style="color:var(--text3)">Cargando...</span>';
  try {
    const res = await api.audiolinkObsSources();
    if (!res.ok || !res.sources.length) {
      container.innerHTML = '<span style="color:var(--text3)">No se encontraron fuentes de audio</span>';
      return;
    }
    container.innerHTML = res.sources.map(s =>
      `<div class="al-obs-source-item">
        <span>${s.name} <span style="color:var(--text3);font-size:10px">(${s.kind})</span></span>
        <span style="color:${s.muted ? 'var(--red)' : 'var(--green)'}; font-size:10px">${s.muted ? 'MUTE' : 'ON'}</span>
      </div>`
    ).join('');
  } catch {
    container.innerHTML = '<span style="color:var(--red)">Error al obtener fuentes</span>';
  }
}

// ── Platforms ─────────────────────────────────────────────────────

async function alPlatformChanged(platform, includeMusic) {
  const statusEl = document.getElementById('alPlat' + platform.charAt(0).toUpperCase() + platform.slice(1) + 'Status');
  if (statusEl) statusEl.textContent = includeMusic ? 'Incluida' : 'Excluida';
  try {
    await api.audiolinkSetPlatformRule({ platform, includeMusic });
  } catch {}
}

// ── Status Polling ───────────────────────────────────────────────

function alStartPolling() {
  if (alPolling) return;
  alPolling = setInterval(alRefreshStatus, 3000);
  alLevelsPolling = setInterval(alRefreshLevels, 100);
}

function alStopPolling() {
  if (alPolling) { clearInterval(alPolling); alPolling = null; }
  if (alLevelsPolling) { clearInterval(alLevelsPolling); alLevelsPolling = null; }
}

async function alRefreshStatus() {
  try {
    const res = await api.audiolinkGetStatus();
    if (!res.ok) return;

    // Voicemeeter
    const vmDot = document.getElementById('alVmDot');
    const vmTxt = document.getElementById('alVmTxt');
    alVmConnected = res.audiolink?.voicemeeter?.connected;
    if (!res.audiolink?.voicemeeter?.available) {
      vmDot.className = 'cdot err';
      vmTxt.textContent = 'No instalado';
    } else if (alVmConnected) {
      vmDot.className = 'cdot on';
      vmTxt.textContent = res.audiolink.voicemeeter.type || 'Conectado';
    } else {
      vmDot.className = 'cdot';
      vmTxt.textContent = 'Desconectado';
    }
    const vmBtn = document.getElementById('alVmBtn');
    if (vmBtn) vmBtn.textContent = alVmConnected ? 'Desconectar Voicemeeter' : 'Conectar Voicemeeter';

    // VBAN
    const vbanDot = document.getElementById('alVbanDot');
    const vbanTxt = document.getElementById('alVbanTxt');
    if (res.audiolink?.vban?.active) {
      vbanDot.className = 'cdot on';
      vbanTxt.textContent = 'Activo';
    } else if (res.audiolink?.vban?.listening) {
      vbanDot.className = 'cdot warn';
      vbanTxt.textContent = 'Escuchando...';
    } else {
      vbanDot.className = 'cdot';
      vbanTxt.textContent = 'Inactivo';
    }

    // Packets
    const pkts = document.getElementById('alPackets');
    if (pkts) pkts.textContent = String(res.audiolink?.vban?.packetsReceived ?? 0);

    // OBS
    const obsDot = document.getElementById('alObsDot');
    const obsTxt = document.getElementById('alObsTxt');
    alObsConnected = res.obs?.connected;
    if (alObsConnected) {
      obsDot.className = 'cdot on';
      obsTxt.textContent = 'Conectado';
    } else {
      obsDot.className = 'cdot';
      obsTxt.textContent = 'Desconectado';
    }
    const obsBtn = document.getElementById('alObsConnBtn');
    if (obsBtn) obsBtn.textContent = alObsConnected ? 'Desconectar OBS' : 'Conectar OBS';

  } catch {}
}

async function alRefreshLevels() {
  try {
    const res = await api.audiolinkGetLevels();
    if (!res.ok) return;
    const l = Math.max(0, Math.min(100, ((res.levels?.left ?? -60) + 60) / 60 * 100));
    const r = Math.max(0, Math.min(100, ((res.levels?.right ?? -60) + 60) / 60 * 100));
    document.getElementById('alMeterL').style.width = l + '%';
    document.getElementById('alMeterR').style.width = r + '%';
  } catch {}
}

// ── IP Detection ─────────────────────────────────────────────────

async function alDetectIp() {
  const el = document.getElementById('alLocalIpValue');
  if (!el) return;
  try {
    const res = await api.audiolinkGetLocalIp();
    if (res.ok && res.interfaces.length > 0) {
      // Prefer ethernet over wifi, show all options
      const ips = res.interfaces.map(i => `${i.address} (${i.name})`);
      el.textContent = res.interfaces[0].address;
      el.title = ips.join('\n');
    } else {
      el.textContent = 'no detectada';
    }
  } catch {
    el.textContent = 'error';
  }
}
