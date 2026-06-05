// Rocket League Live overlay powered by the local Stats API.
let rlCfg = null;
let rlState = null;
let rlLoaded = false;
let rlDirty = false;
let rlSection = 'summary';

const RL_SECTIONS = ['summary', 'scoreboard', 'session', 'stats', 'help', 'debug'];
const RL_THEMES = ['broadcast', 'slate', 'minimal', 'neon', 'classic', 'arena'];
const RL_DEFAULT_CONFIG = {
  playerName: '',
  primaryId: '',
  statsApiPort: 49123,
  overlayPort: 9003,
  eventLabel: 'Rocket League',
  seriesLabel: '',
  subtitle: '',
  showPlayers: true,
  blueTeam: { name: 'BLUE', logoDataUrl: '', color: '#2f8cff' },
  orangeTeam: { name: 'ORANGE', logoDataUrl: '', color: '#ff7a18' },
  style: { theme: 'broadcast', bg: 'rgba(6,11,18,0.88)', text: '#ffffff', accent: '#ffffff', radius: 10 }
};

async function loadRLOverlay() {
  if (rlLoaded) return;
  rlLoaded = true;
  try {
    await api.rlOverlayStart();
    const payload = await api.rlOverlayGetConfig();
    rlCfg = _rlNormalizeConfig(payload.config);
    rlState = payload.state || null;
    rlApplyUI();
    rlRenderState(rlState);
    rlApplyStatus(await api.rlOverlayStatus());
    api.onRLStatsUpdate((state) => {
      rlState = state;
      if (state?.config && !rlDirty) {
        rlCfg = _rlNormalizeConfig(state.config);
        rlApplyUI();
      }
      rlRenderState(state);
      rlApplyStatus({
        running: true,
        connectionStatus: state?.connectionStatus,
        url: state?.urls?.broadcast,
        statsUrl: state?.urls?.stats,
        statsApiPort: state?.config?.statsApiPort
      });
    });
  } catch (error) {
    toast('No se pudo iniciar Rocket League Live', 'err');
    try { log('warn', 'Error RL Live: ' + (error?.message || error)); } catch {}
  }
}

function _rlNormalizeConfig(config) {
  const theme = RL_THEMES.includes(config?.style?.theme) ? config.style.theme : 'broadcast';
  return {
    ...RL_DEFAULT_CONFIG,
    ...(config || {}),
    blueTeam: { ...RL_DEFAULT_CONFIG.blueTeam, ...(config?.blueTeam || {}) },
    orangeTeam: { ...RL_DEFAULT_CONFIG.orangeTeam, ...(config?.orangeTeam || {}) },
    style: { ...RL_DEFAULT_CONFIG.style, ...(config?.style || {}), theme }
  };
}

function _rlEl(id) {
  return document.getElementById(id);
}

function _rlVal(id, value) {
  const el = _rlEl(id);
  if (el) el.value = value ?? '';
}

function _rlText(id, value) {
  const el = _rlEl(id);
  if (el) el.textContent = value ?? '';
}

function _rlNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function _rlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function rlApplyUI() {
  if (!rlCfg) return;
  _rlVal('rlStatsApiPort', rlCfg.statsApiPort || 49123);
  _rlVal('rlPlayerName', rlCfg.playerName || '');
  _rlVal('rlPrimaryId', rlCfg.primaryId || '');
  _rlVal('rlEventLabel', rlCfg.eventLabel || 'Rocket League');
  _rlVal('rlSeriesLabel', rlCfg.seriesLabel || '');
  _rlVal('rlSubtitle', rlCfg.subtitle || '');
  const showPlayersEl = _rlEl('rlShowPlayers');
  if (showPlayersEl) showPlayersEl.checked = rlCfg.showPlayers !== false;
  rlRenderThemeSelection();
  _rlVal('rlBlueName', rlCfg.blueTeam.name || 'BLUE');
  _rlVal('rlBlueColor', rlCfg.blueTeam.color || '#2f8cff');
  _rlVal('rlOrangeName', rlCfg.orangeTeam.name || 'ORANGE');
  _rlVal('rlOrangeColor', rlCfg.orangeTeam.color || '#ff7a18');
  rlRenderLogo('blue');
  rlRenderLogo('orange');
}

function rlApplyStatus(status) {
  const overlayBadge = _rlEl('rlStatusBadge');
  const apiBadge = _rlEl('rlApiBadge');
  const broadcastUrl = status?.url || rlState?.urls?.broadcast || 'http://localhost:9003/broadcast';
  const statsUrl = status?.statsUrl || rlState?.urls?.stats || broadcastUrl.replace(/\/broadcast$/, '/stats');
  _rlText('rlBroadcastUrlText', broadcastUrl);
  _rlText('rlStatsUrlText', statsUrl);
  _rlText('rlHelpBroadcastUrl', broadcastUrl);
  _rlText('rlHelpStatsUrl', statsUrl);
  _rlText('rlStorePath', rlState?.storePath || 'rocket-league-live.json');
  if (overlayBadge) {
    overlayBadge.textContent = status?.running ? 'Overlay activo' : 'Overlay inactivo';
    overlayBadge.className = status?.running ? 'badge badge-on' : 'badge badge-off';
  }
  if (apiBadge) {
    const state = status?.connectionStatus || rlState?.connectionStatus || 'disconnected';
    apiBadge.textContent =
      state === 'connected' ? 'Stats API conectada' :
      state === 'waiting-match' ? 'Esperando partida' :
      state === 'reconnecting' ? 'Reconectando Stats API' :
      'Stats API offline';
    apiBadge.className = state === 'connected' || state === 'waiting-match' ? 'badge badge-on' : 'badge badge-off';
  }
}

function rlSetSection(section) {
  rlSection = RL_SECTIONS.includes(section) ? section : 'summary';
  RL_SECTIONS.forEach((name) => {
    _rlEl('rltab-' + name)?.classList.toggle('on', name === rlSection);   // legacy (ya no existe)
    _rlEl('rlnav-' + name)?.classList.toggle('on', name === rlSection);   // submenú del aside
    const panel = _rlEl('rl-section-' + name);
    if (panel) {
      panel.classList.toggle('on', name === rlSection);
      panel.classList.toggle('hidden', name !== rlSection);
    }
  });
  if (rlState) rlRenderState(rlState);
}

function rlMarkDirty() {
  rlDirty = true;
}

// ── Modales de Marcador (Conexión / Equipos) ──────────────────────
function _rlOpenModal(id) {
  const m = _rlEl(id);
  if (!m) return;
  m.classList.remove('hidden');
  document.addEventListener('keydown', _rlModalEsc);
}
function _rlCloseModal(id) {
  const m = _rlEl(id);
  if (!m) return;
  m.classList.add('hidden');
  document.removeEventListener('keydown', _rlModalEsc);
}
function _rlModalEsc(e) {
  if (e.key !== 'Escape') return;
  ['rlSetupModal', 'rlStylesModal'].forEach((id) => {
    const m = _rlEl(id);
    if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
  });
  document.removeEventListener('keydown', _rlModalEsc);
}
function rlOpenSetup() { _rlOpenModal('rlSetupModal'); }
function rlCloseSetup() { _rlCloseModal('rlSetupModal'); }
function rlOpenStyles() { _rlOpenModal('rlStylesModal'); }
function rlCloseStyles() { _rlCloseModal('rlStylesModal'); }

function rlRenderThemeSelection() {
  const active = RL_THEMES.includes(rlCfg?.style?.theme) ? rlCfg.style.theme : 'broadcast';
  document.querySelectorAll('#rlThemeGrid .rl-theme-card').forEach((card) => {
    card.classList.toggle('on', card.dataset.theme === active);
  });
}

function rlSetTheme(theme) {
  if (!RL_THEMES.includes(theme)) return;
  rlReadForm();
  rlCfg.style = { ...(rlCfg.style || RL_DEFAULT_CONFIG.style), theme };
  rlRenderThemeSelection();
  rlMarkDirty();
}

function rlReadForm() {
  const numberVal = (id, fallback) => {
    const n = Number(_rlEl(id)?.value);
    return Number.isFinite(n) ? n : fallback;
  };
  rlCfg = _rlNormalizeConfig({
    ...rlCfg,
    statsApiPort: numberVal('rlStatsApiPort', 49123),
    playerName: _rlEl('rlPlayerName')?.value?.trim() || '',
    primaryId: _rlEl('rlPrimaryId')?.value?.trim() || '',
    eventLabel: _rlEl('rlEventLabel')?.value?.trim() || 'Rocket League',
    seriesLabel: _rlEl('rlSeriesLabel')?.value?.trim() || '',
    subtitle: _rlEl('rlSubtitle')?.value?.trim() || '',
    showPlayers: _rlEl('rlShowPlayers') ? !!_rlEl('rlShowPlayers').checked : (rlCfg?.showPlayers !== false),
    style: { ...(rlCfg?.style || RL_DEFAULT_CONFIG.style) },
    blueTeam: {
      ...(rlCfg?.blueTeam || RL_DEFAULT_CONFIG.blueTeam),
      name: _rlEl('rlBlueName')?.value?.trim() || 'BLUE',
      color: _rlEl('rlBlueColor')?.value || '#2f8cff'
    },
    orangeTeam: {
      ...(rlCfg?.orangeTeam || RL_DEFAULT_CONFIG.orangeTeam),
      name: _rlEl('rlOrangeName')?.value?.trim() || 'ORANGE',
      color: _rlEl('rlOrangeColor')?.value || '#ff7a18'
    }
  });
  return rlCfg;
}

async function rlSaveConfig() {
  try {
    const next = rlReadForm();
    const result = await api.rlOverlaySetConfig(next);
    rlDirty = false;
    rlState = result.state || rlState;
    if (result.config) rlCfg = _rlNormalizeConfig(result.config);
    rlApplyUI();
    rlRenderState(rlState);
    rlApplyStatus(await api.rlOverlayStatus());
    toast('Rocket League guardado', 'ok');
  } catch (error) {
    toast('No se pudo guardar RL Live', 'err');
  }
}

function rlReadLogo(side, file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result !== 'string') return;
    rlReadForm();
    if (side === 'blue') rlCfg.blueTeam.logoDataUrl = reader.result;
    if (side === 'orange') rlCfg.orangeTeam.logoDataUrl = reader.result;
    rlRenderLogo(side);
    rlMarkDirty();
  };
  reader.readAsDataURL(file);
}

function rlClearLogo(side) {
  rlReadForm();
  if (side === 'blue') rlCfg.blueTeam.logoDataUrl = '';
  if (side === 'orange') rlCfg.orangeTeam.logoDataUrl = '';
  const fileInput = _rlEl(side === 'blue' ? 'rlBlueLogoFile' : 'rlOrangeLogoFile');
  if (fileInput) fileInput.value = '';
  rlRenderLogo(side);
  rlMarkDirty();
}

function rlRenderLogo(side) {
  const team = side === 'blue' ? rlCfg?.blueTeam : rlCfg?.orangeTeam;
  const preview = _rlEl(side === 'blue' ? 'rlBlueLogoPreview' : 'rlOrangeLogoPreview');
  if (!preview || !team) return;
  if (team.logoDataUrl) {
    preview.innerHTML = `<img alt="" src="${_rlEscape(team.logoDataUrl)}">`;
  } else {
    preview.textContent = side === 'blue' ? 'B' : 'O';
    preview.style.color = team.color || (side === 'blue' ? '#2f8cff' : '#ff7a18');
  }
}

function rlFormatClock(seconds, overtime) {
  const hasSeconds = typeof seconds === 'number' && Number.isFinite(seconds);
  if (overtime && !hasSeconds) return 'OT';
  if (!overtime && !hasSeconds) return '--:--';
  const mins = Math.floor(Math.max(0, seconds) / 60);
  const secs = Math.floor(Math.max(0, seconds) % 60);
  return `${overtime ? '+' : ''}${mins}:${String(secs).padStart(2, '0')}`;
}

function rlStreakText(daily) {
  const streak = _rlNum(daily?.currentStreak);
  if (!streak) return '—';
  return `${daily.currentStreakType === 'W' ? '+' : '-'}${streak}`;
}

function rlAvg(total, matches) {
  return matches ? `${(_rlNum(total) / matches).toFixed(1)} / partido` : '0.0 / partido';
}

async function rlSeriesAction(action, okMessage) {
  try {
    const payload = await api.rlOverlaySeriesAction(action);
    rlState = payload.state || rlState;
    if (rlState?.config) {
      rlCfg = _rlNormalizeConfig(rlState.config);
      rlDirty = false;
      rlApplyUI();
    }
    rlRenderState(rlState);
    if (okMessage) toast(okMessage, 'ok');
    return payload;
  } catch (error) {
    toast('No se pudo actualizar la serie', 'err');
    return null;
  }
}

function rlSetBestOf(value) {
  rlSeriesAction({ type: 'set-best-of', bestOf: Number(value) });
}

function rlSeriesAutoAddChanged(enabled) {
  rlSeriesAction({ type: 'set-auto-add', enabled: Boolean(enabled) });
}

function rlAdjustSeriesGame(side, delta) {
  rlSeriesAction({ type: 'adjust-game', side, delta: Number(delta) });
}

function rlAdjustGoal(side, delta) {
  rlSeriesAction({ type: 'adjust-goal', side, delta: Number(delta) });
}

function rlResetGoals() {
  rlSeriesAction({ type: 'reset-goals' }, 'Goles reseteados');
}

function rlResetSeries() {
  rlSeriesAction({ type: 'reset-series' }, 'Serie reseteada');
}

async function rlSwapSides() {
  try {
    if (rlDirty) {
      const next = rlReadForm();
      const saved = await api.rlOverlaySetConfig(next);
      rlState = saved.state || rlState;
      if (saved.config) rlCfg = _rlNormalizeConfig(saved.config);
      rlDirty = false;
    }
    await rlSeriesAction({ type: 'swap-sides' }, 'Lados intercambiados');
  } catch (error) {
    toast('No se pudieron intercambiar los lados', 'err');
  }
}

function rlRenderSeriesControls(state) {
  const seriesState = state?.seriesState || {};
  const scoreboard = state?.scoreboard || {};
  const series = scoreboard.series || {};
  const bestOf = _rlNum(seriesState.bestOf || series.bestOf || 3) || 3;
  const bestOfInput = _rlEl('rlSeriesBestOf');
  if (bestOfInput && document.activeElement !== bestOfInput) bestOfInput.value = String(bestOf);
  const auto = _rlEl('rlSeriesAutoAdd');
  if (auto) auto.checked = seriesState.autoAddGames !== false;

  document.querySelectorAll('[data-bo]').forEach((btn) => {
    btn.classList.toggle('on', Number(btn.dataset.bo) === bestOf);
  });

  const blueName = state?.config?.blueTeam?.name || rlCfg?.blueTeam?.name || 'BLUE';
  const orangeName = state?.config?.orangeTeam?.name || rlCfg?.orangeTeam?.name || 'ORANGE';
  _rlText('rlSeriesBlueName', blueName);
  _rlText('rlSeriesOrangeName', orangeName);
  _rlText('rlSeriesBlueGames', _rlNum(seriesState.blueGames));
  _rlText('rlSeriesOrangeGames', _rlNum(seriesState.orangeGames));
  _rlText('rlManualBlueGoals', scoreboard.blueScore ?? 0);
  _rlText('rlManualOrangeGoals', scoreboard.orangeScore ?? 0);
  _rlText('rlSeriesLabelPreview', scoreboard.seriesLabel || series.label || `GAME 1 · BO${bestOf} · 0-0`);
  _rlText('rlSeriesMode', series.completed
    ? series.winner === 'blue' ? `${blueName} gana la serie`
      : series.winner === 'orange' ? `${orangeName} gana la serie`
      : 'Serie empatada'
    : series.modeLabel || '');
}

function rlRenderState(state) {
  const match = state?.currentMatch;
  const scoreboard = state?.scoreboard || match || {};
  const daily = state?.dailyStats || {};
  const perf = daily.performance || {};
  const matches = _rlNum(daily.matchesPlayed);
  const wins = _rlNum(daily.wins);
  const losses = _rlNum(daily.losses);
  const winrate = matches ? Math.round((wins / matches) * 100) : 0;

  _rlText('rlBlueScore', scoreboard?.blueScore ?? 0);
  _rlText('rlOrangeScore', scoreboard?.orangeScore ?? 0);
  _rlText('rlClock', rlFormatClock(scoreboard?.secondsRemaining, scoreboard?.isOvertime));
  _rlText('rlBoost', typeof scoreboard?.playerBoost === 'number' ? Math.round(scoreboard.playerBoost) : '—');
  _rlText('rlSessionWins', wins);
  _rlText('rlSessionLosses', losses);
  _rlText('rlSessionGoals', daily.goals ?? 0);
  _rlText('rlSessionStreak', rlStreakText(daily));
  _rlText('rlStatMatches', matches);
  _rlText('rlStatWinrate', `${winrate}%`);
  _rlText('rlStatBoostScore', Math.round(perf.boostDisciplineScore ?? 100));
  _rlText('rlStatTouches', perf.touchesPerMinute || 0);
  _rlText('rlSummaryWinrate', `${winrate}%`);
  _rlText('rlSummaryRecord', `${wins}V · ${losses}D`);
  _rlText('rlSummaryMatches', matches);
  _rlText('rlSummaryStreak', rlStreakText(daily));
  _rlText('rlSummaryBestStreak', `${_rlNum(daily.bestWinStreak)}V`);
  _rlText('rlSummaryLastResult', daily.lastResult === 'WIN' ? 'WIN' : daily.lastResult === 'LOSS' ? 'LOSS' : '—');
  _rlText('rlSummaryGoals', daily.goals || 0);
  _rlText('rlSummaryAssists', daily.assists || 0);
  _rlText('rlSummarySaves', daily.saves || 0);
  _rlText('rlSummaryShots', daily.shots || 0);
  _rlText('rlSummaryDemos', daily.demos || 0);
  _rlText('rlSummaryScore', daily.score || 0);
  _rlText('rlGoalsAvg', rlAvg(daily.goals, matches));
  _rlText('rlAssistsAvg', rlAvg(daily.assists, matches));
  _rlText('rlSavesAvg', rlAvg(daily.saves, matches));
  _rlText('rlShotsAvg', rlAvg(daily.shots, matches));
  _rlText('rlDemosAvg', rlAvg(daily.demos, matches));
  _rlText('rlScoreAvg', rlAvg(daily.score, matches));

  const ring = _rlEl('rlWinrateRing');
  const bar = _rlEl('rlWinrateBar');
  if (ring) ring.style.setProperty('--rl-winrate', winrate);
  if (bar) bar.style.width = `${winrate}%`;

  rlRenderSeriesControls(state);
  rlRenderRecentForm(state);
  rlRenderInsights(state);
  rlRenderCharts(state);
  rlRenderHistoryDays(state);
  rlRenderHistory(state);
  rlRenderDebug(state);
  rlApplyStatus({ running: true, connectionStatus: state?.connectionStatus, url: state?.urls?.broadcast, statsUrl: state?.urls?.stats });

  const detail = _rlEl('rlLiveDetail');
  if (detail) {
    if (!match) {
      detail.textContent = state?.connectionStatus === 'waiting-match'
        ? 'Stats API conectada. Esperando que empiece una partida.'
        : `Esperando Rocket League en el puerto ${state?.config?.statsApiPort || rlCfg?.statsApiPort || 49123}.`;
    } else {
      const player = state?.currentPlayer?.Name ? ` · Jugador: ${state.currentPlayer.Name}` : '';
      const goal = match.lastGoal?.scorer ? ` · Último gol: ${match.lastGoal.scorer}` : '';
      const manual = (scoreboard.blueGoalAdjust || scoreboard.orangeGoalAdjust) ? ` · Corrección ${scoreboard.blueGoalAdjust || 0}/${scoreboard.orangeGoalAdjust || 0}` : '';
      detail.textContent = `${match.arena || 'Partida activa'}${player}${goal}${manual}`;
    }
  }
}

function rlRenderRecentForm(state) {
  const root = _rlEl('rlRecentForm');
  if (!root) return;
  const recent = Array.isArray(state?.matchHistory) ? state.matchHistory.slice(0, 12) : [];
  _rlText('rlRecentCount', `últimas ${recent.length} partidas`);
  if (!recent.length) {
    root.textContent = 'Sin partidas registradas todavía.';
    return;
  }
  root.innerHTML = recent.map((match) => {
    const cls = match.result === 'WIN' ? 'win' : match.result === 'LOSS' ? 'loss' : 'unknown';
    return `<span class="rl-form-pill ${cls}" title="${_rlEscape(match.arena || '')}">${match.result === 'WIN' ? 'V' : match.result === 'LOSS' ? 'D' : '-'}</span>`;
  }).join('');
}

function rlRenderInsights(state) {
  const root = _rlEl('rlCoachInsights');
  if (!root) return;
  const insights = Array.isArray(state?.coachInsights) ? state.coachInsights : [];
  if (!insights.length) {
    root.innerHTML = '<div class="rl-insights-empty">Esperando telemetría real de Rocket League para generar recomendaciones accionables sobre boost, tiros y posicionamiento.</div>';
    return;
  }
  root.innerHTML = insights.map((insight) => `
    <article class="rl-insight ${_rlEscape(insight.severity || 'good')}">
      <span>${_rlEscape(insight.value || '')}</span>
      <strong>${_rlEscape(insight.title || '')}</strong>
      <p>${_rlEscape(insight.detail || '')}</p>
    </article>
  `).join('');
}

function rlRenderCharts(state) {
  const charts = state?.performanceCharts || {};
  const daily = state?.dailyStats || {};
  const perf = daily.performance || state?.currentMatch?.performance || {};
  const last7 = state?.historyAnalytics?.last7?.charts || {};
  rlRenderBarChart('rlChart7', last7.goals || [], 'Goles');
  rlRenderBarChart('rlWinrateHistoryChart', last7.winrate || [], 'Winrate', 100);
  rlRenderBarChart('rlBoostChart', charts.boostTimeline || [], 'Boost', 100);
  rlRenderBarChart('rlSpeedChart', charts.speedTimeline || [], 'Velocidad', 2300);
  rlRenderBarChart('rlAverageChart', charts.statAverages || [], 'Promedio');
  rlRenderBarChart('rlTrendChart', charts.matchTrend || [], 'Score');
  rlRenderBarChart('rlProfileChart', [
    { label: 'Boost', value: perf.avgBoost || 0 },
    { label: 'Vel', value: Math.min(100, Math.round((_rlNum(perf.avgSpeed) / 2300) * 100)) },
    { label: 'Touch', value: Math.min(100, Math.round(_rlNum(perf.touchesPerMinute) * 8)) },
    { label: 'Tiro', value: perf.shootingEfficiency || 0 },
    { label: 'Score', value: perf.boostDisciplineScore || 0 }
  ], 'Perfil', 100);
  rlRenderBarChart('rlTimeChart', [
    { label: 'Suelo', value: perf.groundSeconds || 0 },
    { label: 'Pared', value: perf.wallSeconds || 0 },
    { label: 'Supersonic', value: perf.supersonicSeconds || 0 },
    { label: 'Powerslide', value: perf.powerslideSeconds || 0 },
    { label: 'Demo', value: perf.demolishedSeconds || 0 }
  ], 'Segundos');
  rlRenderBarChart('rlDisciplineChart', [
    { label: 'Score', value: perf.boostDisciplineScore || 0 },
    { label: 'Low %', value: perf.lowBoostPercent || 0 },
    { label: 'Sin boost', value: perf.zeroBoostSeconds || 0 },
    { label: 'Supersonic', value: perf.boostWhileSupersonicSeconds || 0 }
  ], 'Boost', 100);
}

function rlRenderBarChart(id, points, label, forcedMax) {
  const root = _rlEl(id);
  if (!root) return;
  const clean = Array.isArray(points) ? points.filter((point) => point && Number.isFinite(Number(point.value))) : [];
  if (!clean.length || clean.every((point) => Number(point.value || 0) === 0)) {
    root.innerHTML = `<div class="rl-chart-empty">Sin datos para mostrar</div>`;
    return;
  }
  const max = forcedMax || Math.max(1, ...clean.map((point) => Number(point.value || 0)));
  root.innerHTML = clean.map((point) => {
    const value = Number(point.value || 0);
    const height = Math.max(4, Math.round((value / max) * 112));
    const resultClass = point.result === 'WIN' ? ' win' : point.result === 'LOSS' ? ' loss' : '';
    return `
      <div class="rl-chart-bar${resultClass}" title="${_rlEscape(label)}: ${value}">
        <div class="rl-chart-fill" style="height:${height}px"></div>
        <div class="rl-chart-label">${_rlEscape(point.label || '')}</div>
      </div>
    `;
  }).join('');
}

function rlRenderHistoryDays(state) {
  const daysRoot = _rlEl('rlHistoryDays');
  const rangeRoot = _rlEl('rlRangeSummary');
  const days = Array.isArray(state?.historyAnalytics?.days) ? state.historyAnalytics.days.slice().reverse() : [];
  if (daysRoot) {
    if (!days.length) {
      daysRoot.textContent = 'Sin días guardados todavía.';
    } else {
      daysRoot.innerHTML = days.slice(0, 12).map((day) => `
        <div class="rl-day-row">
          <strong>${_rlEscape(day.date)}</strong>
          <span>${day.matchesPlayed || 0}P · ${day.wins || 0}V/${day.losses || 0}D · ${day.goals || 0}G · Boost ${Math.round(day.performance?.boostDisciplineScore || 0)}</span>
        </div>
      `).join('');
    }
  }
  if (rangeRoot) {
    const ranges = [state?.historyAnalytics?.last7, state?.historyAnalytics?.last30].filter(Boolean);
    rangeRoot.innerHTML = ranges.map((range) => {
      const stats = range.stats || range;
      const matches = _rlNum(stats.matchesPlayed || range.matches);
      const wins = _rlNum(stats.wins || range.wins);
      const winrate = matches ? Math.round((wins / matches) * 100) : 0;
      return `
        <div class="rl-range-card">
          <strong>${_rlEscape(range.label || '')}</strong>
          <span>${_rlEscape(range.from || '')} a ${_rlEscape(range.to || '')}</span>
          <b>${matches}P · ${winrate}% WR · ${_rlNum(stats.goals || range.goals)}G</b>
        </div>
      `;
    }).join('') || '<span class="rl-muted">Sin rangos disponibles.</span>';
  }
}

function rlRenderHistory(state) {
  const rows = _rlEl('rlHistoryRows');
  if (!rows) return;
  const matches = Array.isArray(state?.matchHistory) ? state.matchHistory.slice(0, 24) : [];
  if (!matches.length) {
    rows.innerHTML = '<tr><td colspan="7" style="color:var(--text3)">Sin partidas registradas todavía.</td></tr>';
    return;
  }
  rows.innerHTML = matches.map((match) => {
    const date = new Date(match.date);
    const score = `${match.blueScore ?? 0}-${match.orangeScore ?? 0}`;
    const result = match.result || '—';
    const color = result === 'WIN' ? 'var(--green)' : result === 'LOSS' ? 'var(--red)' : 'var(--text3)';
    const stats = match.stats || {};
    const perf = match.performance || {};
    return `
      <tr>
        <td style="color:var(--text2);font-size:11px">${Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()}</td>
        <td style="color:${color};font-weight:800">${result}</td>
        <td>${score}</td>
        <td>${_rlEscape(match.arena || '—')}</td>
        <td style="color:var(--text2);font-size:11px">G ${stats.goals || 0} · A ${stats.assists || 0} · SV ${stats.saves || 0} · SH ${stats.shots || 0} · SCR ${stats.score || 0}</td>
        <td>${Math.round(perf.boostDisciplineScore || 0)}/100</td>
        <td>${perf.touchesPerMinute || 0} t/min</td>
      </tr>
    `;
  }).join('');
}

function rlRenderDebug(state) {
  const eventsRoot = _rlEl('rlDebugEvents');
  const jsonRoot = _rlEl('rlDebugJson');
  if (eventsRoot) {
    const events = Array.isArray(state?.lastEvents) ? state.lastEvents.slice(0, 20) : [];
    eventsRoot.innerHTML = events.length ? events.map((event) => `
      <div class="rl-debug-event">
        <strong>${_rlEscape(event.type || event.event || 'Unknown')}</strong>
        <span>${_rlEscape(event.receivedAt || '')}</span>
      </div>
    `).join('') : 'Sin eventos todavía.';
  }
  if (jsonRoot) {
    const lastUpdate = (state?.lastEvents || []).find((e) => (e.type || e.event) === 'UpdateState');
    const rawPayload = lastUpdate?.data || lastUpdate?.raw?.data || lastUpdate?.raw || null;
    const compact = {
      connectionStatus: state?.connectionStatus,
      rawConnectionStatus: state?.rawConnectionStatus,
      updateStateKeys: rawPayload ? Object.keys(rawPayload) : '(no llegó ningún UpdateState)',
      rawPlayersSample: rawPayload
        ? (rawPayload.Players ?? rawPayload.players ?? rawPayload.Game?.Players ?? rawPayload.Game?.players ?? '(no hay campo Players en el payload)')
        : '(no llegó ningún UpdateState)',
      currentMatchPlayers: state?.currentMatch?.players,
      urls: state?.urls,
      currentMatch: state?.currentMatch,
      scoreboard: state?.scoreboard,
      seriesState: state?.seriesState,
      currentPlayer: state?.currentPlayer,
      dailyStats: state?.dailyStats,
      storePath: state?.storePath
    };
    jsonRoot.textContent = JSON.stringify(compact, null, 2);
  }
}

async function rlRefresh(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Reconectando...'; }
  try {
    if (rlDirty) await rlSaveConfig();
    const payload = await api.rlOverlayRefresh();
    rlState = payload.state || payload || rlState;
    rlRenderState(rlState);
    rlApplyStatus(await api.rlOverlayStatus());
    toast('Stats API reconectando', 'ok');
  } catch {
    toast('No se pudo reconectar Stats API', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Reconectar API'; }
  }
}

async function rlResetSession() {
  try {
    const payload = await api.rlOverlayResetSession();
    rlState = payload.state || payload || rlState;
    rlRenderState(rlState);
    toast('Sesión RL reiniciada', 'ok');
  } catch {
    toast('No se pudo reiniciar sesión RL', 'err');
  }
}

async function rlClearLive(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Limpiando...'; }
  try {
    const payload = await api.rlOverlayClearLive();
    rlState = payload.state || payload || rlState;
    rlRenderState(rlState);
    toast('Partida en vivo limpiada', 'ok');
  } catch {
    toast('No se pudo limpiar la partida', 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Limpiar partida en vivo'; }
  }
}

function rlCopyUrl(kind = 'broadcast') {
  const txt = kind === 'stats'
    ? (_rlEl('rlStatsUrlText')?.textContent || 'http://localhost:9003/stats')
    : (_rlEl('rlBroadcastUrlText')?.textContent || 'http://localhost:9003/broadcast');
  navigator.clipboard.writeText(txt).then(() => toast('URL copiada', 'ok')).catch(() => {});
}

function rlOpenUrl(kind = 'broadcast') {
  const txt = kind === 'stats'
    ? (_rlEl('rlStatsUrlText')?.textContent || 'http://localhost:9003/stats')
    : (_rlEl('rlBroadcastUrlText')?.textContent || 'http://localhost:9003/broadcast');
  api.openUrl(txt);
}
