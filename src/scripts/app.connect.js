// ── Connect ───────────────────────────────────────────────────────
async function toggleConnect() {
  await toggleKickBot();
}
async function connectFromConfig() { await saveConfig(); await doConnect(); }

function _normalizeKickChannel(channel) {
  return String(channel || '').trim().replace(/^@/, '').toLowerCase();
}

function _resolveKickRouting(cfg) {
  const prod = _normalizeKickChannel(cfg?.kickChannel);
  const mode = cfg?.kickBotMode === 'dev' ? 'dev' : 'prod';
  const devRaw = _normalizeKickChannel(cfg?.kickDevChannel);
  const active = mode === 'dev' ? devRaw : prod;
  return {
    prod,
    mode,
    dev: devRaw,
    active,
    hasDedicatedDev: mode === 'dev' && !!devRaw && devRaw !== prod,
  };
}

// Buckets completos por ambiente (mirror local de lo que hay en config)
window._kCreds = window._kCreds || {
  prod: { clientId: '', clientSecret: '', channel: '', chatroomId: '', rewardId: '', hasToken: false, hasBotToken: false },
  dev:  { clientId: '', clientSecret: '', channel: '', chatroomId: '', rewardId: '', hasToken: false, hasBotToken: false },
};
window._kMode = window._kMode || 'prod';

async function _kickEnsureActiveMode() {
  const mode = window._kMode === 'dev' ? 'dev' : 'prod';
  try {
    await api.saveConfig({ kickBotMode: mode });
  } catch (_) {}
  return mode;
}

function _readKickInputsIntoBucket(mode) {
  const b = window._kCreds[mode] || (window._kCreds[mode] = {});
  b.clientId     = document.getElementById('kClientId')?.value.trim()     || '';
  b.clientSecret = document.getElementById('kClientSecret')?.value.trim() || '';
  b.channel      = document.getElementById('kChannel')?.value.trim()      || '';
  b.chatroomId   = document.getElementById('kChatroomId')?.value.trim()   || '';
  return b;
}

function _writeBucketIntoKickInputs(mode) {
  const b = window._kCreds[mode] || {};
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('kClientId', b.clientId);
  set('kClientSecret', b.clientSecret);
  set('kChannel', b.channel);
  set('kChatroomId', b.chatroomId);
  set('kRewardId', b.rewardId);
}

function _updateEnvPills() {
  const mode = window._kMode;
  const prod = document.getElementById('envModeProd');
  const dev  = document.getElementById('envModeDev');
  if (prod) prod.checked = mode !== 'dev';
  if (dev)  dev.checked  = mode === 'dev';
  const kLbl = document.getElementById('kChannelLabel');
  if (kLbl) kLbl.textContent = mode === 'dev' ? 'Canal de Kick — DEV (sin @)' : 'Canal de Kick (sin @)';
  const msg = document.getElementById('envModeMsg');
  if (msg) msg.textContent = mode === 'dev'
    ? 'Ambiente DEV activo — todo apunta a tus credenciales de prueba.'
    : 'Ambiente PROD activo — datos reales del canal.';
}

async function onEnvModeChanged() {
  const isDev = !!document.getElementById('envModeDev')?.checked;
  const newMode = isDev ? 'dev' : 'prod';
  const prevMode = window._kMode || 'prod';
  if (newMode === prevMode) return;
  if (kickConnected) {
    try {
      await api.kickBotDisconnect();
      setKickStatus('Bot desconectado por cambio de ambiente.', false);
    } catch (_) {}
  }
  // 1. Snapshot inputs actuales al bucket del modo anterior
  _readKickInputsIntoBucket(prevMode);
  // 2. Cambiar modo y pintar el nuevo bucket
  window._kMode = newMode;
  _writeBucketIntoKickInputs(newMode);
  _updateEnvPills();
  // 3. Persistir el switch inmediatamente para que main se entere (Kick + Spotify + rewards)
  try {
    await api.saveConfig({ kickBotMode: newMode, kickStartupMode: newMode });
  } catch (_) {
    // Revertir UI local si no se pudo persistir el modo activo.
    window._kMode = prevMode;
    _writeBucketIntoKickInputs(prevMode);
    _updateEnvPills();
    toast('No se pudo cambiar de ambiente', 'err');
    return;
  }
  // 4. Refrescar datos dependientes
  try { if (typeof loadKickConfig === 'function') await loadKickConfig(); } catch (_) {}
  try { if (typeof loadSpotify === 'function') loadSpotify(); } catch (_) {}
  _syncKickPrimaryRewardId();
  toast(newMode === 'dev' ? 'Ambiente DEV activo' : 'Ambiente PROD activo', 'ok');
}

async function doConnect() {
  await toggleKickBot();
}

// ── Kick ─────────────────────────────────────────────────────────
let kickConnected = false;
let kickRewardsCache = [];
let kickSubsCache = [];
let kickSection = 'summary';
const KICK_REWARD_DEFAULT_COLOR = '#53D067';
let kickCommandsConfig = { song: true, playlist: true, queue: true, skip: true };
let kickPresenceState = { localInstanceId: '', staleAfterMs: 20000, instances: [] };
let kickCommandHealthState = { totals: {}, actions: [], alerts: [] };
let kickMonitorState = null;
let kickMonitorTimer = null;
let kickAccountIdentities = {
  broadcaster: null,
  bot: null,
};

function _normalizeKickCommandsConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    song: src.song !== false,
    playlist: src.playlist !== false,
    queue: src.queue !== false,
    skip: src.skip !== false,
  };
}

function _setKickCommandsMsg(text, tone = 'muted') {
  const el = document.getElementById('kickCommandsMsg');
  if (!el) return;
  el.textContent = text || '';
  if (tone === 'ok') el.style.color = 'var(--green)';
  else if (tone === 'err') el.style.color = 'var(--red)';
  else if (tone === 'warn') el.style.color = 'var(--orange2)';
  else el.style.color = 'var(--text3)';
}

function _normalizeKickAccountIdentity(raw, role) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    role,
    mode: src.mode === 'dev' ? 'dev' : 'prod',
    authorized: !!src.authorized,
    validToken: !!src.validToken,
    username: String(src.username || '').trim(),
    displayName: String(src.displayName || src.username || '').trim(),
    channel: String(src.channel || '').trim(),
    userId: String(src.userId || '').trim(),
    avatarUrl: String(src.avatarUrl || '').trim(),
    statusText: String(src.statusText || '').trim(),
    error: String(src.error || '').trim(),
  };
}

function _renderKickAccountIdentityCard(containerId, identity, opts = {}) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const roleLabel = opts.roleLabel || 'Cuenta';
  if (!identity || !identity.authorized) {
    el.innerHTML = `<div class="cfg-kick-identity-empty">Sin ${roleLabel.toLowerCase()} verificada.</div>`;
    return;
  }

  const safeName = _hKick(identity.displayName || identity.username || 'Cuenta sin nombre');
  const safeUser = _hKick(identity.username ? `@${identity.username}` : '');
  const safeChannel = _hKick(identity.channel ? `Canal: @${identity.channel}` : 'Canal no detectado');
  const safeUserId = _hKick(identity.userId ? `ID: ${identity.userId}` : 'ID no detectado');
  const safeStatus = _hKick(identity.statusText || (identity.validToken ? `${roleLabel} autorizada` : `${roleLabel} requiere reautorización`));
  const pillClass = identity.validToken ? 'ok' : 'warn';
  const avatar = identity.avatarUrl
    ? `<img class="cfg-kick-identity-avatar" src="${_hKick(identity.avatarUrl)}" alt="${safeName}" referrerpolicy="no-referrer">`
    : `<div class="cfg-kick-identity-avatar" style="display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--text3)">?</div>`;

  el.innerHTML = `
    <div class="cfg-kick-identity-card">
      ${avatar}
      <div class="cfg-kick-identity-meta">
        <div class="cfg-kick-identity-name">${safeName} ${safeUser ? `<span style="color:var(--text3);font-weight:600">${safeUser}</span>` : ''}</div>
        <div class="cfg-kick-identity-sub">${safeChannel}</div>
        <div class="cfg-kick-identity-sub">${safeUserId}</div>
      </div>
      <span class="cfg-kick-identity-pill ${pillClass}">${safeStatus}</span>
    </div>
  `;
}

function _applyKickAccountIdentities(identities) {
  const src = identities && typeof identities === 'object' ? identities : {};
  const broadcaster = _normalizeKickAccountIdentity(src.broadcaster || {}, 'broadcaster');
  const bot = _normalizeKickAccountIdentity(src.bot || {}, 'bot');
  kickAccountIdentities = { broadcaster, bot };

  _renderKickAccountIdentityCard('kickBroadcasterIdentity', broadcaster, { roleLabel: 'Cuenta canal' });
  _renderKickAccountIdentityCard('kickBotIdentity', bot, { roleLabel: 'Cuenta bot' });

  const botStatusEl = document.getElementById('kickBotAccountStatus');
  if (botStatusEl) {
    if (!bot.authorized) {
      botStatusEl.textContent = 'Sin autorizar';
      botStatusEl.style.color = '';
    } else if (!bot.validToken) {
      botStatusEl.textContent = bot.statusText || 'Token bot vencido';
      botStatusEl.style.color = 'var(--orange2)';
    } else {
      botStatusEl.textContent = bot.statusText || (bot.username ? `Cuenta bot autorizada (@${bot.username})` : 'Cuenta bot autorizada');
      botStatusEl.style.color = 'var(--green)';
    }
  }
}

function _formatKickPresenceAge(ageMs) {
  const ms = Number(ageMs || 0);
  if (!Number.isFinite(ms) || ms <= 0) return 'ahora';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  return `${hours}h`;
}

function _renderKickPresence(payload) {
  if (payload && typeof payload === 'object') {
    kickPresenceState = {
      localInstanceId: payload.localInstanceId || '',
      staleAfterMs: Number(payload.staleAfterMs || 20000),
      instances: Array.isArray(payload.instances) ? payload.instances : [],
    };
  }

  const summaryEl = document.getElementById('kickPresenceSummary');
  const listEl = document.getElementById('kickPresenceList');
  if (!summaryEl || !listEl) return;

  const list = Array.isArray(kickPresenceState.instances) ? kickPresenceState.instances : [];
  const online = list.filter((row) => row?.online).length;
  summaryEl.textContent = list.length
    ? `${online}/${list.length} online · timeout ${Math.round((Number(kickPresenceState.staleAfterMs) || 20000) / 1000)}s`
    : 'Sin datos de presencia todavía.';

  if (!list.length) {
    listEl.innerHTML = '<div style="text-align:center;padding:12px;font-size:11px;color:var(--text3)">No hay instancias registradas.</div>';
    return;
  }

  listEl.innerHTML = list.map((entry) => {
    const isLocal = !!entry?.isLocal;
    const online = !!entry?.online;
    const chipClass = online ? 'online' : 'offline';
    const chipLabel = online ? 'ONLINE' : 'OFFLINE';
    const label = _hKick(entry?.label || entry?.host || entry?.instanceId || 'PC');
    const mode = entry?.kick?.mode === 'dev' ? 'dev' : 'prod';
    const channel = String(entry?.kick?.channel || '').trim();
    const kickStatus = entry?.kick?.connected
      ? `Kick conectado${channel ? ` @${_hKick(channel)}` : ''}`
      : 'Kick desconectado';
    const srEnabled = entry?.songrequest?.enabled !== false && entry?.songrequest?.kickEnabled !== false;
    const srStatus = srEnabled ? 'Songrequest ON' : 'Songrequest OFF';
    const queuePending = Number(entry?.songrequest?.queuePending || 0);
    const queueState = `cola:${queuePending}`;
    const runtimeFailed = Number(entry?.runtime?.commandFailed || 0);
    const runtimeTimeouts = Number(entry?.runtime?.commandTimeouts || 0);
    const runtimeHealth = `cmdFail:${runtimeFailed} timeout:${runtimeTimeouts}`;
    const overlayBits = [];
    if (entry?.overlays?.key) overlayBits.push('keys');
    if (entry?.overlays?.spotify) overlayBits.push('spotify');
    if (entry?.overlays?.rl) overlayBits.push('rl');
    if (entry?.overlays?.teams) overlayBits.push('teams');
    const overlayText = overlayBits.length ? `overlays:${overlayBits.join(',')}` : 'overlays:—';
    const ageText = _formatKickPresenceAge(Number(entry?.ageMs || 0));
    return `
      <div class="kick-presence-item" style="${isLocal ? 'border-color:rgba(83,208,103,.35);' : ''}">
        <div class="kick-presence-head">
          <div class="kick-presence-name">${label}${isLocal ? ' · esta PC' : ''}</div>
          <span class="kick-presence-chip ${chipClass}">${chipLabel}</span>
        </div>
        <div class="kick-presence-meta">${kickStatus} · ${mode} · ${srStatus} · ${queueState}</div>
        <div class="kick-presence-meta">${overlayText} · ${runtimeHealth} · visto hace ${ageText}</div>
      </div>
    `;
  }).join('');
}

async function kickPresenceRefresh(opts = {}) {
  const silent = !!opts.silent;
  if (typeof api.runtimePresenceGet !== 'function') {
    if (!silent) {
      const summaryEl = document.getElementById('kickPresenceSummary');
      if (summaryEl) summaryEl.textContent = 'Versión de app sin soporte de presencia.';
    }
    return;
  }
  const r = await api.runtimePresenceGet().catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (!r?.ok) {
    if (!silent) {
      const summaryEl = document.getElementById('kickPresenceSummary');
      if (summaryEl) summaryEl.textContent = r?.error || 'No pude leer presencia en Supabase.';
    }
    return;
  }
  _renderKickPresence(r);
}

function _renderKickCommandHealth(payload) {
  if (payload && typeof payload === 'object') {
    kickCommandHealthState = {
      totals: payload.totals || {},
      actions: Array.isArray(payload.actions) ? payload.actions : [],
      alerts: Array.isArray(payload.alerts) ? payload.alerts : [],
    };
  }
  const summaryEl = document.getElementById('kickCommandHealthSummary');
  const listEl = document.getElementById('kickCommandHealthList');
  if (!summaryEl || !listEl) return;

  const totals = kickCommandHealthState.totals || {};
  const total = Number(totals.total || 0);
  const failed = Number(totals.failed || 0);
  const timeouts = Number(totals.timeouts || 0);
  const retries = Number(totals.retries || 0);
  summaryEl.textContent = total
    ? `total:${total} · failed:${failed} · timeouts:${timeouts} · retries:${retries}`
    : 'Sin actividad de comandos todavía.';

  const actions = Array.isArray(kickCommandHealthState.actions) ? kickCommandHealthState.actions : [];
  if (!actions.length) {
    listEl.innerHTML = '<div style="text-align:center;padding:12px;font-size:11px;color:var(--text3)">No hay comandos ejecutados aún.</div>';
    return;
  }

  listEl.innerHTML = actions.slice(0, 12).map((row) => {
    const streak = Number(row?.consecutiveFailures || 0);
    const chipClass = streak >= 3 ? 'offline' : (streak > 0 ? 'offline' : 'online');
    const chipText = streak >= 3 ? `ALERTA x${streak}` : (streak > 0 ? `FAIL x${streak}` : 'OK');
    const avg = Number(row?.avgDurationMs || 0);
    const lastErr = _hKick(String(row?.lastError || row?.lastSoftError || ''));
    return `
      <div class="kick-presence-item">
        <div class="kick-presence-head">
          <div class="kick-presence-name">${_hKick(row?.action || 'unknown')}</div>
          <span class="kick-presence-chip ${chipClass}">${chipText}</span>
        </div>
        <div class="kick-presence-meta">ok:${Number(row?.ok || 0)} · fail:${Number(row?.failed || 0)} · soft:${Number(row?.softFailed || 0)} · timeout:${Number(row?.timeouts || 0)}</div>
        <div class="kick-presence-meta">avg:${avg}ms · last:${Number(row?.lastDurationMs || 0)}ms</div>
        ${lastErr ? `<div class="kick-presence-meta" style="color:#f59e0b">Último error: ${lastErr}</div>` : ''}
      </div>
    `;
  }).join('');
}

async function kickCommandHealthRefresh(opts = {}) {
  const silent = !!opts.silent;
  if (typeof api.runtimeCommandHealthGet !== 'function') return;
  const r = await api.runtimeCommandHealthGet().catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (!r?.ok) {
    if (!silent) {
      const summaryEl = document.getElementById('kickCommandHealthSummary');
      if (summaryEl) summaryEl.textContent = r?.error || 'No pude cargar métricas de comandos.';
    }
    return;
  }
  _renderKickCommandHealth(r);
}

async function kickCommandHealthReset() {
  if (typeof api.runtimeCommandHealthReset !== 'function') return;
  const r = await api.runtimeCommandHealthReset().catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (!r?.ok) return;
  _renderKickCommandHealth(r);
}

function _kickMonitorToneClass(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'ok') return 'ok';
  if (v === 'critical' || v === 'error' || v === 'err') return 'critical';
  return 'warn';
}

function _renderKickMonitor(payload) {
  if (payload && typeof payload === 'object') {
    kickMonitorState = payload;
  }
  const summaryEl = document.getElementById('kickMonitorSummary');
  const chipsEl = document.getElementById('kickMonitorChips');
  const alertsEl = document.getElementById('kickMonitorAlerts');
  if (!summaryEl || !chipsEl || !alertsEl) return;

  if (!kickMonitorState?.ok) {
    summaryEl.textContent = kickMonitorState?.error || 'No pude cargar el monitoreo de Kick.';
    chipsEl.innerHTML = `
      <span class="kick-monitor-chip critical">scopes: sin datos</span>
      <span class="kick-monitor-chip critical">subs: sin datos</span>
      <span class="kick-monitor-chip critical">webhook: sin datos</span>
      <span class="kick-monitor-chip critical">errores: sin datos</span>
    `;
    alertsEl.innerHTML = '<div style="text-align:center;padding:12px;font-size:11px;color:var(--red)">Monitor no disponible.</div>';
    return;
  }

  const warnCount = Number(kickMonitorState?.health?.warnCount || 0);
  const criticalCount = Number(kickMonitorState?.health?.criticalCount || 0);
  const mode = kickMonitorState?.mode === 'dev' ? 'DEV' : 'PROD';
  const channel = String(kickMonitorState?.channel || '').trim();
  summaryEl.textContent = [
    `modo:${mode}`,
    channel ? `canal:@${channel}` : 'canal:—',
    kickMonitorState?.connected ? 'bot:conectado' : 'bot:desconectado',
    `alertas:${criticalCount} críticas / ${warnCount} warning`,
  ].join(' · ');

  const chipLabels = [
    { key: 'scopes', label: 'scopes' },
    { key: 'subscriptions', label: 'subs' },
    { key: 'webhook', label: 'webhook' },
    { key: 'errors', label: 'errores' },
  ];
  chipsEl.innerHTML = chipLabels.map(({ key, label }) => {
    const tone = _kickMonitorToneClass(kickMonitorState?.chips?.[key]);
    let detailRaw = '';
    if (key === 'scopes') {
      const b = kickMonitorState?.scopes?.broadcaster?.label || '—';
      const bot = kickMonitorState?.scopes?.bot?.label || '—';
      detailRaw = `broadcaster:${b} · bot:${bot}`;
    } else if (key === 'subscriptions') {
      detailRaw = kickMonitorState?.subscriptions?.label || '—';
    } else if (key === 'webhook') {
      detailRaw = kickMonitorState?.webhook?.label || '—';
    } else if (key === 'errors') {
      detailRaw = kickMonitorState?.errorQueue?.label || '—';
    }
    const detail = _hKick(String(detailRaw || ''));
    return `<span class="kick-monitor-chip ${tone}" title="${detail}">${label}: ${detail}</span>`;
  }).join('');

  const alerts = Array.isArray(kickMonitorState?.alerts) ? kickMonitorState.alerts : [];
  const queueRows = Array.isArray(kickMonitorState?.errorQueue?.rows) ? kickMonitorState.errorQueue.rows : [];
  if (!alerts.length && !queueRows.length) {
    alertsEl.innerHTML = '<div style="text-align:center;padding:12px;font-size:11px;color:#53d067">Sin alertas activas.</div>';
    return;
  }

  const alertRows = alerts.slice(0, 8).map((row) => {
    const sev = String(row?.severity || 'warn').toLowerCase();
    const tone = sev === 'critical' ? 'critical' : (sev === 'warn' ? 'warn' : 'ok');
    const when = _hKick(_formatKickDate(row?.at));
    return `
      <div class="kick-presence-item">
        <div class="kick-presence-head">
          <div class="kick-presence-name">${_hKick(row?.code || 'monitor.alert')}</div>
          <span class="kick-monitor-chip ${tone}">${_hKick(sev.toUpperCase())}</span>
        </div>
        <div class="kick-presence-meta">${_hKick(row?.message || 'Alerta detectada.')}</div>
        <div class="kick-presence-meta">Detectado: ${when}</div>
      </div>
    `;
  });

  const errorRows = queueRows.slice(0, 4).map((row) => {
    const type = String(row?.type || '').toLowerCase();
    const tone = (type === 'error') ? 'critical' : 'warn';
    return `
      <div class="kick-presence-item">
        <div class="kick-presence-head">
          <div class="kick-presence-name">app_logs:${_hKick(row?.type || 'warn')}</div>
          <span class="kick-monitor-chip ${tone}">${_hKick(type.toUpperCase() || 'WARN')}</span>
        </div>
        <div class="kick-presence-meta">${_hKick(row?.msg || '')}</div>
        <div class="kick-presence-meta">Fecha: ${_hKick(_formatKickDate(row?.createdAt))}</div>
      </div>
    `;
  });

  alertsEl.innerHTML = `${alertRows.join('')}${errorRows.join('')}`;
}

async function kickMonitorRefresh(opts = {}) {
  const silent = !!opts.silent;
  if (typeof api.kickMonitorGet !== 'function') {
    if (!silent) {
      _renderKickMonitor({ ok: false, error: 'Versión de app sin soporte para monitor de Kick.' });
    }
    return;
  }
  const mode = window._kMode === 'dev' ? 'dev' : 'prod';
  const r = await api.kickMonitorGet({ mode }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (!r?.ok && !silent) {
    _renderKickMonitor({ ok: false, error: r?.error || 'No pude cargar monitor de Kick.' });
    return;
  }
  if (r?.ok) _renderKickMonitor(r);
}

function kickMonitorStartLoop() {
  if (kickMonitorTimer) return;
  kickMonitorTimer = setInterval(() => {
    kickMonitorRefresh({ silent: true }).catch(() => {});
  }, 20000);
}

function kickCommandsApplyUI() {
  kickCommandsConfig = _normalizeKickCommandsConfig(kickCommandsConfig);
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.checked = !!value;
  };
  set('kickCmdSong', kickCommandsConfig.song);
  set('kickCmdPlaylist', kickCommandsConfig.playlist);
  set('kickCmdQueue', kickCommandsConfig.queue);
  set('kickCmdSkip', kickCommandsConfig.skip);
}

async function kickCommandsLoad(opts = {}) {
  try {
    const r = await api.kickCommandsGetConfig();
    if (!r?.ok) {
      if (!opts.silent) _setKickCommandsMsg(r?.error || 'No pude cargar configuración de comandos.', 'warn');
      return;
    }
    kickCommandsConfig = _normalizeKickCommandsConfig(r.config);
    kickCommandsApplyUI();
    if (!opts.silent) _setKickCommandsMsg('Comandos sincronizados.', 'ok');
  } catch (e) {
    if (!opts.silent) _setKickCommandsMsg(e?.message || 'No pude cargar configuración de comandos.', 'err');
  }
}

async function kickCommandsToggle(key, enabled) {
  const allowed = new Set(['song', 'playlist', 'queue', 'skip']);
  if (!allowed.has(String(key || ''))) return;
  const prev = { ...kickCommandsConfig };
  kickCommandsConfig = _normalizeKickCommandsConfig({ ...kickCommandsConfig, [key]: !!enabled });
  kickCommandsApplyUI();
  _setKickCommandsMsg('Guardando cambios...', 'muted');
  const r = await api.kickCommandsSetConfig(kickCommandsConfig).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (r?.ok) {
    kickCommandsConfig = _normalizeKickCommandsConfig(r.config || kickCommandsConfig);
    kickCommandsApplyUI();
    _setKickCommandsMsg('Comandos actualizados en tiempo real.', 'ok');
  } else {
    kickCommandsConfig = _normalizeKickCommandsConfig(prev);
    kickCommandsApplyUI();
    _setKickCommandsMsg(r?.error || 'No se pudo guardar el cambio.', 'err');
  }
}

function kickSetSection(section, opts = {}) {
  const next = ['summary', 'rewards', 'subs'].includes(section) ? section : 'summary';
  kickSection = next;

  ['summary', 'rewards', 'subs'].forEach((key) => {
    const pane = document.getElementById(`kick-sec-${key}`);
    const tab = document.getElementById(`kick-tab-${key}`);
    if (pane) pane.classList.toggle('hidden', key !== next);
    if (tab) tab.classList.toggle('on', key === next);
  });

  if (opts.silent) return;
  if (next === 'rewards') {
    kickRewardsRefresh({ silent: true }).catch(() => {});
  } else if (next === 'subs') {
    kickSubsRefresh({ silent: true }).catch(() => {});
  }
}

function _normalizeKickRewardColor(value, fallback = KICK_REWARD_DEFAULT_COLOR) {
  const color = String(value || '').trim().toUpperCase();
  if (/^#[0-9A-F]{6}$/.test(color)) return color;
  return fallback;
}

function _syncKickRewardCreateColorUI() {
  const input = document.getElementById('kickRewardCreateColor');
  const code = document.getElementById('kickRewardCreateColorHex');
  const selected = _normalizeKickRewardColor(input?.value || KICK_REWARD_DEFAULT_COLOR);
  if (input) input.value = selected;
  if (code) code.textContent = selected;

  const swatches = document.querySelectorAll('[data-kick-reward-color]');
  swatches.forEach((btn) => {
    const color = _normalizeKickRewardColor(btn?.dataset?.kickRewardColor || '');
    const active = color === selected;
    btn.style.outline = active ? '2px solid rgba(255,255,255,.9)' : '1px solid rgba(255,255,255,.22)';
    btn.style.outlineOffset = active ? '1px' : '0';
  });
}

function kickRewardPickColor(color) {
  const input = document.getElementById('kickRewardCreateColor');
  if (!input) return;
  input.value = _normalizeKickRewardColor(color, KICK_REWARD_DEFAULT_COLOR);
  _syncKickRewardCreateColorUI();
}

function kickRewardCreateColorChanged() {
  _syncKickRewardCreateColorUI();
}

async function kickOAuth() {
  const mode = await _kickEnsureActiveMode();
  const clientId     = document.getElementById('kClientId').value.trim();
  const clientSecret = document.getElementById('kClientSecret').value.trim();
  const kickChannel  = document.getElementById('kChannel').value.trim();
  if (!clientId || !clientSecret) {
    toast('Completá Client ID y Secret', 'warn'); return;
  }
  setKickStatus('Esperando autorización...');
  const r = await api.kickConnectOAuth({ clientId, clientSecret, kickChannel, mode });
  if (r.ok) {
    if (r.identities) _applyKickAccountIdentities(r.identities);
    // Refrescar inputs con el canal detectado desde el token
    await loadKickConfig();
    const detected = r.channel ? `@${r.channel}` : '';
    setKickStatus(`Cuenta autorizada${detected ? ' (' + detected + ')' : ''}. Conectá el bot.`);
    toast(`Kick autorizado${detected ? ' ' + detected : ''}`, 'ok');
  } else {
    setKickStatus('Error: ' + (r.error || 'desconocido'));
    toast('Error al autorizar Kick', 'err');
  }
}

async function kickBotAccountOAuth() {
  const mode = await _kickEnsureActiveMode();
  const statusEl = document.getElementById('kickBotAccountStatus');
  statusEl.textContent = 'Esperando autorización...';
  const r = await api.kickBotOAuth({ mode });
  if (r.ok) {
    if (r.identities) _applyKickAccountIdentities(r.identities);
    statusEl.textContent = 'Cuenta bot autorizada';
    statusEl.style.color = 'var(--green)';
    toast('Cuenta bot autorizada', 'ok');
  }
  else      { statusEl.textContent = 'Error: ' + (r.error || 'desconocido'); statusEl.style.color = 'var(--red)'; toast('Error al autorizar cuenta bot', 'err'); }
}

function kickOpenResetModal() {
  let ov = document.getElementById('cfgConfirmModal');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'cfgConfirmModal';
    ov.className = 'cfg-modal-overlay';
    ov.addEventListener('click', (e) => { if (e.target === ov) kickCloseResetModal(); });
    document.body.appendChild(ov);
  }
  ov.innerHTML = `
    <div class="cfg-modal cfg-modal-danger" role="dialog" aria-modal="true">
      <div class="cfg-modal-head">
        <span class="cfg-modal-ico">!</span>
        <div>
          <div class="cfg-modal-title">Reset total de Kick</div>
          <div class="cfg-modal-sub">Acción destructiva e irreversible</div>
        </div>
      </div>
      <div class="cfg-modal-body">
        Esto borra <strong>client, channel, reward y tokens</strong> de PROD y DEV en Supabase (canal + bot) y limpia los campos locales. Vas a tener que reautorizar ambas cuentas.
      </div>
      <div class="cfg-modal-actions">
        <button class="btn btn-ghost" onclick="kickCloseResetModal()">Cancelar</button>
        <button class="btn btn-danger" id="kickResetConfirmBtn" onclick="kickConfirmReset()">Sí, resetear todo</button>
      </div>
    </div>`;
  requestAnimationFrame(() => ov.classList.add('on'));
}

function kickCloseResetModal() {
  const ov = document.getElementById('cfgConfirmModal');
  if (ov) ov.classList.remove('on');
}

async function kickConfirmReset() {
  const btn = document.getElementById('kickResetConfirmBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Reseteando...'; }
  setKickStatus('Ejecutando reset total de Kick...');
  const r = await api.kickResetTokens({ scope: 'all' });
  kickCloseResetModal();
  if (!r?.ok) {
    setKickStatus('Error: ' + (r?.error || 'No se pudo resetear Kick'));
    toast('No se pudo hacer reset total de Kick', 'err');
    return;
  }
  kickConnected = false;
  setKickStatus('Reset total completado. Reautorizá cuenta canal y cuenta bot.', false);
  toast('Reset total de Kick completado', 'ok');
  await loadKickConfig().catch(() => {});
}

async function toggleKickBot() {
  const btn = document.getElementById('kickBotBtn');
  const sbBtn = document.getElementById('kickSbBtn');
  if (kickConnected) {
    await api.kickBotDisconnect();
  } else {
    const mode = await _kickEnsureActiveMode();
    [btn, sbBtn].forEach(b => { if(b){b.disabled=true; b.textContent='Conectando...';} });
    const r = await api.kickBotConnect({ mode });
    [btn, sbBtn].forEach(b => { if(b) b.disabled=false; });
    if (!r.ok) { toast('Error Kick: ' + (r.error || 'desconocido'), 'err'); setKickStatus('Error: ' + r.error); }
  }
}

function setKickStatus(msg, connected) {
  const el = document.getElementById('kickConnStatus');
  const kickViewEl = document.getElementById('kickViewConnStatus');
  const btn = document.getElementById('kickBotBtn');
  const sbDot = document.getElementById('sbKickDot');
  const sbTxt = document.getElementById('sbKickTxt');
  const sbBtn = document.getElementById('kickSbBtn');
  const connPill = document.getElementById('connPill');
  const connDot = document.getElementById('connDot');
  const connTxt = document.getElementById('connTxt');
  const connChan = document.getElementById('connChan');
  const routing = _resolveKickRouting(getCfg());
  if (!el && !kickViewEl) return;
  if (connected !== undefined) {
    kickConnected = connected;
    if (el) {
      el.style.color = connected ? 'var(--green)' : 'var(--text3)';
      el.textContent = connected ? 'Conectado a Kick' : (msg || 'Sin conectar');
    }
    if (kickViewEl) {
      kickViewEl.style.color = connected ? 'var(--green)' : 'var(--text3)';
      kickViewEl.textContent = connected
        ? `Conectado en @${routing.active || 'kick'}`
        : (msg || 'Sin conectar');
    }
    if (btn) btn.textContent = connected ? 'Desconectar bot' : 'Conectar bot';
    if (sbDot) connected ? sbDot.classList.add('on') : sbDot.classList.remove('on');
    if (sbTxt) sbTxt.textContent = connected ? ('@' + (routing.active || 'kick')) : '';
    if (sbBtn) { sbBtn.textContent = connected ? 'Desconectar' : 'Conectar'; sbBtn.style.color = connected ? 'var(--red)' : ''; }

    if (connPill && connDot && connTxt && connChan) {
      if (connected) {
        connPill.classList.add('on');
        connDot.classList.add('on');
        connTxt.textContent = 'Kick conectado';
        connChan.textContent = routing.mode === 'dev' && routing.hasDedicatedDev
          ? `@${routing.active} · dev`
          : `@${routing.active || 'kick'}`;
        connChan.classList.remove('hidden');
      } else {
        connPill.classList.remove('on');
        connDot.classList.remove('on');
        connTxt.textContent = 'Kick desconectado';
        connChan.classList.add('hidden');
      }
    }
  } else {
    if (el) el.textContent = msg;
    if (kickViewEl && msg) kickViewEl.textContent = msg;
  }
}

function _setKickRewardBadge(enabled) {
  const badge = document.getElementById('kickRewardBadge');
  if (!badge) return;
  if (enabled === true)  { badge.style.background='rgba(83,208,103,.15)'; badge.style.color='#53d067'; badge.textContent='Habilitada'; }
  else if (enabled === false) { badge.style.background='rgba(248,113,113,.1)'; badge.style.color='#f87171'; badge.textContent='Deshabilitada'; }
  else { badge.style.background='rgba(255,255,255,.06)'; badge.style.color='var(--text3)'; badge.textContent='—'; }
}

function _syncKickPrimaryRewardId() {
  const rewardId = document.getElementById('kRewardId')?.value.trim() || '';
  const el = document.getElementById('kickPrimaryRewardId');
  if (!el) return;
  el.textContent = rewardId || 'Sin asignar';
}

function _hKick(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _getKickRewardByIndex(index) {
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0) return null;
  if (!Array.isArray(kickRewardsCache)) return null;
  return kickRewardsCache[idx] || null;
}

function _setKickRewardsPanelMsg(text, tone = 'muted') {
  const el = document.getElementById('kickRewardsPanelMsg');
  if (!el) return;
  el.textContent = text || '';
  if (tone === 'ok') el.style.color = 'var(--green)';
  else if (tone === 'err') el.style.color = 'var(--red)';
  else if (tone === 'warn') el.style.color = 'var(--orange2)';
  else el.style.color = 'var(--text3)';
}

function _setKickRewardsCreateMsg(text, tone = 'muted') {
  const el = document.getElementById('kickRewardPanelCreateMsg');
  if (!el) return;
  el.textContent = text || '';
  if (tone === 'ok') el.style.color = 'var(--green)';
  else if (tone === 'err') el.style.color = 'var(--red)';
  else if (tone === 'warn') el.style.color = 'var(--orange2)';
  else el.style.color = 'var(--text3)';
}

function _renderKickRewardsPanelList() {
  const listEl = document.getElementById('kickRewardsPanelList');
  if (!listEl) return;
  const currentId = document.getElementById('kRewardId')?.value.trim() || '';
  if (!Array.isArray(kickRewardsCache) || !kickRewardsCache.length) {
    listEl.innerHTML = '<div style="text-align:center;padding:16px;font-size:11px;color:var(--text3)">No hay rewards en este canal.</div>';
    return;
  }

  listEl.innerHTML = kickRewardsCache.map((reward, idx) => {
    const isPrimary = currentId && reward.id === currentId;
    const statusColor = reward.is_enabled ? '#53d067' : '#f87171';
    const statusText = reward.is_enabled ? 'Habilitada' : 'Deshabilitada';
    const bgColor = _normalizeKickRewardColor(reward.background_color || KICK_REWARD_DEFAULT_COLOR);
    const requiresInput = reward.is_user_input_required !== false;
    const skipsQueue = !!reward.should_redemptions_skip_request_queue;
    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:10px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px">
          <div style="min-width:0;flex:1">
            <div style="font-size:11px;font-weight:700;color:var(--text1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_hKick(reward.title || 'Sin título')}</div>
            <div style="font-size:10px;color:var(--text3);margin-top:2px;word-break:break-all">ID: ${_hKick(reward.id || '')}</div>
          </div>
          <div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap;justify-content:flex-end">
            <span style="font-size:10px;padding:2px 7px;border-radius:20px;background:rgba(255,255,255,.06);color:${statusColor}">${statusText}</span>
            <span style="font-size:10px;padding:2px 7px;border-radius:20px;background:rgba(255,255,255,.06);color:var(--text2)">${requiresInput ? 'Texto requerido' : 'Texto opcional'}</span>
            <span style="font-size:10px;padding:2px 7px;border-radius:20px;background:rgba(255,255,255,.06);color:${skipsQueue ? '#53d067' : 'var(--text2)'}">${skipsQueue ? 'Salta cola' : 'Pasa por cola'}</span>
            <span title="Color de fondo ${bgColor}" style="width:14px;height:14px;border-radius:50%;display:inline-block;border:1px solid rgba(255,255,255,.25);background:${bgColor}"></span>
            ${isPrimary
              ? '<span style="font-size:10px;padding:2px 7px;border-radius:20px;background:rgba(83,208,103,.16);color:#53d067">Song Request</span>'
              : ''}
          </div>
        </div>
        <div class="g2" style="margin-bottom:6px">
          <div class="ig" style="margin-bottom:0">
            <label style="margin-bottom:4px">Precio</label>
            <input id="kr-cost-${idx}" type="number" min="1" step="1" value="${Number(reward.cost) || 1}" style="font-size:11px;font-family:monospace">
          </div>
          <div class="ig" style="margin-bottom:0">
            <label style="margin-bottom:4px">Descripción</label>
            <input id="kr-desc-${idx}" type="text" maxlength="200" value="${_hKick(reward.description || '')}" style="font-size:11px">
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-ghost" style="padding:5px 9px;font-size:10px" onclick="kickRewardPanelSave(${idx})">Guardar</button>
          <button class="btn btn-ghost" style="padding:5px 9px;font-size:10px" onclick="kickRewardPanelToggle(${idx}, ${reward.is_enabled ? 'false' : 'true'})">${reward.is_enabled ? 'Deshabilitar' : 'Habilitar'}</button>
          <button class="btn btn-ghost" style="padding:5px 9px;font-size:10px" onclick="kickRewardPanelSetPrimary(${idx})">Usar en song request</button>
          <button class="btn btn-ghost" style="padding:5px 9px;font-size:10px;color:var(--red);border-color:rgba(248,113,113,.25)" onclick="kickRewardPanelDelete(${idx})">Eliminar</button>
        </div>
      </div>
    `;
  }).join('');
}

async function kickRewardSet(enabled) {
  const mode = await _kickEnsureActiveMode();
  const msg = document.getElementById('kickRewardMsg');
  if (msg) {
    msg.textContent = enabled ? 'Habilitando...' : 'Deshabilitando...';
    msg.style.color = 'var(--text3)';
  }
  const r = await api.kickRewardToggle({ enabled, mode });
  if (r.ok) {
    _setKickRewardBadge(enabled);
    if (msg) {
      msg.textContent = enabled ? 'Recompensa habilitada.' : 'Recompensa deshabilitada.';
      msg.style.color = enabled ? 'var(--green)' : 'var(--red)';
    }
    kickRewardsRefresh({ silent: true }).catch(() => {});
    return r;
  } else {
    if (msg) {
      msg.textContent = 'Error: ' + (r.error || 'desconocido');
      msg.style.color = 'var(--red)';
    }
    return r;
  }
}

async function kickRewardLoadDetails(opts = {}) {
  const mode = await _kickEnsureActiveMode();
  const silent = !!opts.silent;
  const costEl = document.getElementById('kickRewardCostInput');
  const descEl = document.getElementById('kickRewardDescInput');
  const editMsg = document.getElementById('kickRewardEditMsg');
  if (!costEl || !descEl || !editMsg) return;

  const rewardId = document.getElementById('kRewardId')?.value.trim();
  if (!rewardId) {
    if (!silent) {
      editMsg.textContent = 'Primero cargá un ID de reward en Config > Kick.';
      editMsg.style.color = 'var(--orange2)';
    }
    return;
  }

  const r = await api.kickRewardGet({ rewardId, mode });
  if (!r.ok || !r.reward) {
    if (!silent) {
      editMsg.textContent = r.error || 'No pude leer la reward.';
      editMsg.style.color = 'var(--red)';
    }
    return;
  }

  costEl.value = Number(r.reward.cost) || 1;
  descEl.value = r.reward.description || '';
  _setKickRewardBadge(!!r.reward.is_enabled);
  _syncKickPrimaryRewardId();
  if (!silent) {
    editMsg.textContent = 'Datos cargados desde Kick.';
    editMsg.style.color = 'var(--green)';
  }
}

async function kickRewardSaveDetails() {
  const mode = await _kickEnsureActiveMode();
  const costEl = document.getElementById('kickRewardCostInput');
  const descEl = document.getElementById('kickRewardDescInput');
  const editMsg = document.getElementById('kickRewardEditMsg');
  const rewardId = document.getElementById('kRewardId')?.value.trim();
  if (!costEl || !descEl || !editMsg) return;

  if (!rewardId) {
    editMsg.textContent = 'Falta el ID de reward. Cargalo en Config > Kick.';
    editMsg.style.color = 'var(--orange2)';
    return;
  }

  editMsg.textContent = 'Guardando cambios...';
  editMsg.style.color = 'var(--text3)';
  const r = await api.kickRewardUpdate({
    mode,
    rewardId,
    cost: Number(costEl.value),
    description: descEl.value,
  });

  if (r.ok) {
    editMsg.textContent = 'Precio y descripción actualizados en Kick.';
    editMsg.style.color = 'var(--green)';
    kickRewardsRefresh({ silent: true }).catch(() => {});
    return;
  }

  editMsg.textContent = r.error || 'No se pudieron guardar los cambios.';
  editMsg.style.color = 'var(--red)';
}

async function kickRewardsRefresh(opts = {}) {
  const mode = await _kickEnsureActiveMode();
  const silent = !!opts.silent;
  const listEl = document.getElementById('kickRewardsPanelList');
  if (!silent && listEl) {
    listEl.innerHTML = '<div style="text-align:center;padding:16px;font-size:11px;color:var(--text3)">Cargando rewards...</div>';
  }

  const r = await api.kickRewardList({ mode });
  if (!r.ok) {
    if (listEl && !silent) {
      listEl.innerHTML = `<div style="text-align:center;padding:16px;font-size:11px;color:var(--red)">${_hKick(r.error || 'No pude cargar rewards.')}</div>`;
    }
    if (!silent) _setKickRewardsPanelMsg(r.error || 'No pude cargar rewards.', 'err');
    return;
  }

  kickRewardsCache = Array.isArray(r.rewards) ? r.rewards : [];
  _renderKickRewardsPanelList();
  if (!silent) _setKickRewardsPanelMsg(`Cargadas ${kickRewardsCache.length} rewards (${mode.toUpperCase()}).`, 'ok');
}

async function kickRewardPanelSetPrimary(index) {
  const mode = await _kickEnsureActiveMode();
  const reward = _getKickRewardByIndex(index);
  if (!reward) return;
  _setKickRewardsPanelMsg('Marcando reward para song request...', 'muted');
  const r = await api.kickRewardSetPrimary({ rewardId: reward.id, mode });
  if (!r.ok) {
    _setKickRewardsPanelMsg(r.error || 'No se pudo seleccionar la reward.', 'err');
    return;
  }
  const idInput = document.getElementById('kRewardId');
  if (idInput) idInput.value = reward.id;
  _syncKickPrimaryRewardId();
  _setKickRewardsPanelMsg('Reward seleccionada para song request.', 'ok');
  await kickRewardLoadDetails({ silent: true });
  await kickRewardsRefresh({ silent: true });
}

async function kickRewardPanelToggle(index, enabled) {
  const mode = await _kickEnsureActiveMode();
  const reward = _getKickRewardByIndex(index);
  if (!reward) return;
  _setKickRewardsPanelMsg(enabled ? 'Habilitando reward...' : 'Deshabilitando reward...', 'muted');
  const r = await api.kickRewardUpdate({ mode, rewardId: reward.id, is_enabled: !!enabled });
  if (!r.ok) {
    _setKickRewardsPanelMsg(r.error || 'No se pudo cambiar el estado.', 'err');
    return;
  }
  _setKickRewardsPanelMsg(enabled ? 'Reward habilitada.' : 'Reward deshabilitada.', enabled ? 'ok' : 'warn');
  if ((document.getElementById('kRewardId')?.value.trim() || '') === reward.id) _setKickRewardBadge(!!enabled);
  await kickRewardsRefresh({ silent: true });
}

async function kickRewardPanelSave(index) {
  const mode = await _kickEnsureActiveMode();
  const reward = _getKickRewardByIndex(index);
  if (!reward) return;
  const costEl = document.getElementById(`kr-cost-${index}`);
  const descEl = document.getElementById(`kr-desc-${index}`);
  const cost = Number(costEl?.value || 0);
  const description = String(descEl?.value || '');
  _setKickRewardsPanelMsg('Guardando reward...', 'muted');
  const r = await api.kickRewardUpdate({ mode, rewardId: reward.id, cost, description });
  if (!r.ok) {
    _setKickRewardsPanelMsg(r.error || 'No se pudo guardar la reward.', 'err');
    return;
  }
  _setKickRewardsPanelMsg('Reward actualizada.', 'ok');
  if ((document.getElementById('kRewardId')?.value.trim() || '') === reward.id) {
    await kickRewardLoadDetails({ silent: true });
  }
  await kickRewardsRefresh({ silent: true });
}

async function kickRewardPanelDelete(index) {
  const mode = await _kickEnsureActiveMode();
  const reward = _getKickRewardByIndex(index);
  if (!reward) return;
  const confirmDelete = window.confirm(`¿Eliminar la reward "${reward.title || reward.id}"?`);
  if (!confirmDelete) return;
  _setKickRewardsPanelMsg('Eliminando reward...', 'muted');
  const r = await api.kickRewardDelete({ rewardId: reward.id, mode });
  if (!r.ok) {
    _setKickRewardsPanelMsg(r.error || 'No se pudo eliminar la reward.', 'err');
    return;
  }
  if (r.songRequestCleared) {
    const idInput = document.getElementById('kRewardId');
    if (idInput) idInput.value = '';
    _setKickRewardBadge(null);
    _syncKickPrimaryRewardId();
  }
  _setKickRewardsPanelMsg('Reward eliminada.', 'ok');
  await kickRewardsRefresh({ silent: true });
}

async function kickRewardCreateFromPanel() {
  const mode = await _kickEnsureActiveMode();
  const titleEl = document.getElementById('kickRewardCreateTitle');
  const costEl = document.getElementById('kickRewardCreateCost');
  const descEl = document.getElementById('kickRewardCreateDesc');
  const enabledEl = document.getElementById('kickRewardCreateEnabled');
  const userInputRequiredEl = document.getElementById('kickRewardCreateUserInputRequired');
  const skipQueueEl = document.getElementById('kickRewardCreateSkipQueue');
  const backgroundColorEl = document.getElementById('kickRewardCreateColor');
  const setPrimaryEl = document.getElementById('kickRewardCreateSetPrimary');
  if (!titleEl || !costEl || !descEl || !enabledEl || !userInputRequiredEl || !skipQueueEl || !backgroundColorEl || !setPrimaryEl) return;

  const title = titleEl.value.trim();
  const cost = Number(costEl.value || 0);
  const description = descEl.value.trim();
  const enabled = !!enabledEl.checked;
  const userInputRequired = !!userInputRequiredEl.checked;
  const shouldRedemptionsSkipRequestQueue = !!skipQueueEl.checked;
  const backgroundColor = _normalizeKickRewardColor(backgroundColorEl.value || KICK_REWARD_DEFAULT_COLOR);
  const setAsSongRequest = !!setPrimaryEl.checked;

  if (!title) {
    _setKickRewardsCreateMsg('El título es obligatorio.', 'err');
    return;
  }
  if (title.length > 50) {
    _setKickRewardsCreateMsg('El título no puede superar 50 caracteres.', 'err');
    return;
  }

  _setKickRewardsCreateMsg('Creando reward...', 'muted');
  const r = await api.kickRewardCreate({
    mode,
    title,
    cost,
    description,
    enabled,
    userInputRequired,
    shouldRedemptionsSkipRequestQueue,
    backgroundColor,
    setAsSongRequest,
  });
  if (!r.ok) {
    _setKickRewardsCreateMsg(r.error || 'No se pudo crear la reward.', 'err');
    return;
  }

  if (setAsSongRequest && r.songRequestRewardId) {
    const idInput = document.getElementById('kRewardId');
    if (idInput) idInput.value = r.songRequestRewardId;
    _syncKickPrimaryRewardId();
    await kickRewardLoadDetails({ silent: true });
  }

  titleEl.value = '';
  descEl.value = '';
  _syncKickRewardCreateColorUI();
  _setKickRewardsCreateMsg('Reward creada correctamente.', 'ok');
  await kickRewardsRefresh({ silent: true });
}

function _setKickSubsMsg(text, tone = 'muted') {
  const el = document.getElementById('kickSubsMsg');
  if (!el) return;
  el.textContent = text || '';
  if (tone === 'ok') el.style.color = 'var(--green)';
  else if (tone === 'err') el.style.color = 'var(--red)';
  else if (tone === 'warn') el.style.color = 'var(--orange2)';
  else el.style.color = 'var(--text3)';
}

function _formatKickDate(iso) {
  const ts = Date.parse(String(iso || ''));
  if (Number.isNaN(ts)) return '—';
  return new Date(ts).toLocaleString();
}

function _renderKickSubsList() {
  const listEl = document.getElementById('kickSubsList');
  const summaryEl = document.getElementById('kickSubsSummary');
  if (!listEl || !summaryEl) return;
  summaryEl.textContent = String(Array.isArray(kickSubsCache) ? kickSubsCache.length : 0);

  if (!Array.isArray(kickSubsCache) || !kickSubsCache.length) {
    listEl.innerHTML = '<div style="text-align:center;padding:14px;font-size:11px;color:var(--text3)">Sin suscriptores cacheados todavía.</div>';
    return;
  }

  listEl.innerHTML = kickSubsCache.map((sub) => {
    const statusTone = sub.isActive ? '#53d067' : '#f87171';
    return `
      <div style="border:1px solid var(--border);border-radius:8px;padding:8px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <div style="min-width:0;flex:1">
            <div style="font-size:11px;font-weight:700;color:var(--text1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_hKick(sub.username || '(sin username)')}</div>
            <div style="font-size:10px;color:var(--text3);margin-top:2px;word-break:break-all">ID: ${_hKick(sub.userId || '—')}</div>
          </div>
          <span style="font-size:10px;padding:2px 7px;border-radius:20px;background:rgba(255,255,255,.06);color:${statusTone}">
            ${sub.isActive ? 'Activa' : 'Vencida'}
          </span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;font-size:10px;color:var(--text3)">
          <div>Vence: <span style="color:var(--text2)">${_hKick(_formatKickDate(sub.expiresAt))}</span></div>
          <div>Último evento: <span style="color:var(--text2)">${_hKick(sub.lastEventType || '—')}</span></div>
        </div>
      </div>
    `;
  }).join('');
}

async function kickSubsRefresh(opts = {}) {
  const mode = await _kickEnsureActiveMode();
  const silent = !!opts.silent;
  const listEl = document.getElementById('kickSubsList');
  if (!silent && listEl) {
    listEl.innerHTML = '<div style="text-align:center;padding:14px;font-size:11px;color:var(--text3)">Cargando suscriptores...</div>';
  }
  const r = await api.kickSubsList({ mode, activeOnly: true, limit: 400 });
  if (!r?.ok) {
    if (!silent) {
      _setKickSubsMsg(r?.error || 'No pude cargar suscriptores.', 'warn');
    }
    if (listEl && !silent) {
      listEl.innerHTML = `<div style="text-align:center;padding:14px;font-size:11px;color:var(--text3)">${_hKick(r?.error || 'No pude cargar suscriptores.')}</div>`;
    }
    return;
  }
  kickSubsCache = Array.isArray(r.subscribers) ? r.subscribers : [];
  _renderKickSubsList();
  if (!silent) {
    _setKickSubsMsg(`Cargados ${kickSubsCache.length} subs activos de @${r.channel || 'kick'}.`, 'ok');
  }
}

async function kickSubsClear() {
  const mode = await _kickEnsureActiveMode();
  const yes = window.confirm('¿Limpiar la lista cacheada de suscriptores para este modo/canal?');
  if (!yes) return;
  _setKickSubsMsg('Limpiando lista de suscriptores...', 'muted');
  const r = await api.kickSubsClear({ mode });
  if (!r?.ok) {
    _setKickSubsMsg(r?.error || 'No se pudo limpiar la lista.', 'err');
    return;
  }
  kickSubsCache = [];
  _renderKickSubsList();
  _setKickSubsMsg(`Lista limpiada (${Number(r.removed || 0)} filas).`, 'ok');
}

async function loadKickConfig() {
  const r = await api.kickGetConfig();
  if (!r.ok) return;
  const mode = (r.kickBotMode === 'dev') ? 'dev' : 'prod';
  window._kMode = mode;
  // Rellenar buckets desde respuesta del IPC (formato nuevo: r.prod + r.dev)
  const fillBucket = (bucket, src) => {
    if (!src) return;
    bucket.clientId     = src.clientId     || '';
    bucket.clientSecret = src.clientSecret || '';
    bucket.channel      = src.channel      || '';
    bucket.chatroomId   = src.chatroomId   || '';
    bucket.rewardId     = src.rewardId     || '';
    bucket.hasToken     = !!src.hasToken;
    bucket.hasBotToken  = !!src.hasBotToken;
  };
  fillBucket(window._kCreds.prod, r.prod);
  fillBucket(window._kCreds.dev,  r.dev);
  _writeBucketIntoKickInputs(mode);
  _updateEnvPills();
  const activeBucket = window._kCreds[mode] || {};
  if (r.identities) {
    _applyKickAccountIdentities(r.identities);
  } else if (typeof api.kickGetIdentities === 'function') {
    api.kickGetIdentities({ mode }).then((res) => {
      if (res?.ok && res.identities) _applyKickAccountIdentities(res.identities);
    }).catch(() => {});
  }
  document.getElementById('kAutoConnect').checked = r.autoConnectKickBot !== false;
  _syncKickRewardCreateColorUI();
  _syncKickPrimaryRewardId();
  kickRewardLoadDetails({ silent: true }).catch(() => {});
  kickRewardsRefresh({ silent: true }).catch(() => {});
  kickSubsRefresh({ silent: true }).catch(() => {});
  kickCommandsLoad({ silent: true }).catch(() => {});
  kickPresenceRefresh({ silent: true }).catch(() => {});
  kickCommandHealthRefresh({ silent: true }).catch(() => {});
  kickMonitorRefresh({ silent: true }).catch(() => {});
  kickMonitorStartLoop();
  const broadcasterIdentity = r.identities?.broadcaster || kickAccountIdentities.broadcaster;
  if (r.connected) {
    setKickStatus(null, true);
  } else if (broadcasterIdentity?.authorized && !broadcasterIdentity?.validToken) {
    setKickStatus('Cuenta canal con token vencido. Reautorizá para volver a conectar.', false);
  } else if (broadcasterIdentity?.authorized || activeBucket.hasToken) {
    const usr = String(broadcasterIdentity?.username || '').trim();
    setKickStatus(usr ? `Cuenta canal autorizada como @${usr}. Conectá el bot.` : 'Cuenta autorizada. Conectá el bot.');
  } else {
    setKickStatus('Sin conectar');
  }
  if (!r.identities) {
    const botEl = document.getElementById('kickBotAccountStatus');
    if (botEl) {
      if (activeBucket.hasBotToken) { botEl.textContent = 'Cuenta bot autorizada'; botEl.style.color = 'var(--green)'; }
      else                          { botEl.textContent = 'Sin autorizar'; botEl.style.color = ''; }
    }
  }
}

api.onKickBotStatus(({ connected, reason, channel, mode }) => {
  if (channel) {
    const tgtMode = mode === 'dev' ? 'dev' : 'prod';
    if (window._kCreds?.[tgtMode]) window._kCreds[tgtMode].channel = channel;
    // Solo pintar el input si el modo del evento coincide con el ambiente activo en UI
    if (tgtMode === window._kMode) {
      const el = document.getElementById('kChannel');
      if (el) el.value = channel;
    }
  }
  setKickStatus(reason, connected);
  if (!connected && reason) log('warn', `Kick desconectado: ${reason}`);
  if (connected)            log('info', `Kick bot conectado ${channel ? 'en @' + channel : ''}`);
  kickMonitorRefresh({ silent: true }).catch(() => {});
});

function loadKickRewardsTab() {
  kickSetSection(kickSection, { silent: true });
  _syncKickRewardCreateColorUI();
  _syncKickPrimaryRewardId();
  kickRewardLoadDetails({ silent: true }).catch(() => {});
  kickRewardsRefresh().catch(() => {});
  kickSubsRefresh().catch(() => {});
  kickCommandsLoad({ silent: true }).catch(() => {});
  kickPresenceRefresh({ silent: true }).catch(() => {});
  kickCommandHealthRefresh({ silent: true }).catch(() => {});
  kickMonitorRefresh({ silent: true }).catch(() => {});
  kickMonitorStartLoop();
}

// Recargar form si se cargaron credenciales desde Supabase automáticamente
api.onKickConfigLoaded(() => loadKickConfig());

if (typeof api.onKickCommandsUpdated === 'function') {
  api.onKickCommandsUpdated((payload) => {
    if (!payload?.config) return;
    kickCommandsConfig = _normalizeKickCommandsConfig(payload.config);
    kickCommandsApplyUI();
    if (payload?.source === 'supabase') {
      _setKickCommandsMsg('Cambio remoto aplicado desde Supabase.', 'ok');
    }
  });
}

if (typeof api.onRuntimePresenceUpdated === 'function') {
  api.onRuntimePresenceUpdated((payload) => {
    _renderKickPresence(payload);
  });
}

if (typeof api.onRuntimeCommandHealthUpdated === 'function') {
  api.onRuntimeCommandHealthUpdated((payload) => {
    _renderKickCommandHealth(payload);
  });
}
