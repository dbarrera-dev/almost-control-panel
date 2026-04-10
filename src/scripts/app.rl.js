// ROCKET LEAGUE OVERLAY
// ══════════════════════════════════════════
let rlCfg = { platform: 'epic', username: '', style: { bg: 'rgba(15,15,20,0.92)', text: '#ffffff', accent: '#2563eb', radius: 12 } };
let rlLoaded = false;

async function loadRLOverlay() {
  if (rlLoaded) return;
  rlLoaded = true;
  const { config, stats } = await api.rlOverlayGetConfig();
  rlCfg = config || rlCfg;
  rlApplyUI();
  if (stats) rlShowStats(stats, { mmr: 0, wins: 0, losses: 0, matches: 0 });
  const status = await api.rlOverlayStatus();
  rlApplyStatus(status);
  api.onRLStatsUpdate(({ stats, delta }) => rlShowStats(stats, delta));
}

function rlApplyUI() {
  document.getElementById('rlPlatform').value  = rlCfg.platform || 'epic';
  document.getElementById('rlUsername').value  = rlCfg.username || '';
  const s = rlCfg.style || {};
  document.getElementById('rlAccent').value    = s.accent || '#2563eb';
  document.getElementById('rlAccentVal').textContent = s.accent || '#2563eb';
  document.getElementById('rlTextColor').value = s.text || '#ffffff';
  document.getElementById('rlTextVal').textContent   = s.text || '#ffffff';
  document.getElementById('rlRadius').value    = s.radius ?? 12;
  document.getElementById('rlRadiusVal').textContent = (s.radius ?? 12) + 'px';
  const op = Math.round((parseFloat((s.bg || '0.92').match(/[\d.]+\)$/)?.[0] ?? '0.92')) * 100);
  document.getElementById('rlBgOp').value      = op;
  document.getElementById('rlBgOpVal').textContent   = op + '%';
}

function rlApplyStatus(s) {
  const badge = document.getElementById('rlStatusBadge');
  if (!badge) return;
  if (s.running) {
    badge.textContent = 'Activo';
    badge.className = 'badge badge-on';
    const urlEl = document.getElementById('rlUrlText');
    if (urlEl && s.url) urlEl.textContent = s.url;
  } else {
    badge.textContent = 'Inactivo';
    badge.className = 'badge badge-off';
  }
}

function rlShowStats(stats, delta) {
  if (!stats) return;
  document.getElementById('rlStatsCard').style.display = '';
  document.getElementById('rlSMMR').textContent    = stats.mmr ?? '—';
  document.getElementById('rlSWins').textContent   = stats.wins ?? '—';
  document.getElementById('rlSLosses').textContent = stats.losses ?? '—';
  document.getElementById('rlSRank').textContent   = stats.rank || '—';
  document.getElementById('rlSDiv').textContent    = stats.division ? ' · ' + stats.division : '';
  document.getElementById('rlSPlaylist').textContent = stats.playlist || '';
  if (delta) {
    const mmrD = delta.mmr || 0;
    document.getElementById('rlDMmr').textContent    = 'MMR: ' + (mmrD > 0 ? '+' : '') + mmrD;
    document.getElementById('rlDMmr').style.color    = mmrD > 0 ? '#22c55e' : mmrD < 0 ? '#ef4444' : 'var(--text3)';
    document.getElementById('rlDRecord').textContent = `W/L: ${delta.wins || 0}W ${delta.losses || 0}L`;
  }
}

async function rlSaveConfig() {
  rlCfg.platform = document.getElementById('rlPlatform').value;
  rlCfg.username = document.getElementById('rlUsername').value.trim();
  await api.rlOverlaySetConfig(rlCfg);
}

async function rlSaveStyle() {
  rlCfg.style.accent = document.getElementById('rlAccent').value;
  rlCfg.style.text   = document.getElementById('rlTextColor').value;
  document.getElementById('rlAccentVal').textContent = rlCfg.style.accent;
  document.getElementById('rlTextVal').textContent   = rlCfg.style.text;
  await api.rlOverlaySetConfig(rlCfg);
}

function rlOnRadius(v) {
  rlCfg.style.radius = parseInt(v);
  document.getElementById('rlRadiusVal').textContent = v + 'px';
  api.rlOverlaySetConfig(rlCfg);
}

function rlOnBgOp(v) {
  document.getElementById('rlBgOpVal').textContent = v + '%';
  rlCfg.style.bg = `rgba(15,15,20,${(v/100).toFixed(2)})`;
  api.rlOverlaySetConfig(rlCfg);
}

async function rlRefresh(btn) {
  btn.disabled = true; btn.textContent = '↻ Actualizando...';
  const { stats } = await api.rlOverlayRefresh();
  if (stats) rlShowStats(stats, { mmr: 0, wins: 0, losses: 0, matches: 0 });
  btn.disabled = false; btn.textContent = '↻ Actualizar stats ahora';
}

async function rlResetSession() {
  await api.rlOverlayResetSession();
  document.getElementById('rlDMmr').textContent    = 'MMR: +0';
  document.getElementById('rlDMmr').style.color    = 'var(--text3)';
  document.getElementById('rlDRecord').textContent = 'W/L: 0W 0L';
}

function rlCopyUrl() {
  navigator.clipboard.writeText('http://localhost:9003').then(() => {
    const btn = document.querySelector('#view-rl button[onclick="rlCopyUrl()"]');
    if (btn) { const t = btn.textContent; btn.textContent = '✓ Copiado'; setTimeout(() => btn.textContent = t, 1500); }
  });
}

