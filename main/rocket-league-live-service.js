const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');

const DEFAULT_CONFIG = {
  playerName: '',
  primaryId: '',
  statsApiPort: 49123,
  autoConnectStatsApi: true,
  overlayPort: 9003,
  eventLabel: 'Rocket League',
  seriesLabel: '',
  subtitle: '',
  showPlayers: true,
  blueTeam: {
    name: 'Azul',
    logoDataUrl: '',
    color: '#2f8cff'
  },
  orangeTeam: {
    name: 'Naranja',
    logoDataUrl: '',
    color: '#ff7a18'
  },
  style: {
    theme: 'slate',
    bg: 'rgba(6,11,18,0.88)',
    text: '#ffffff',
    accent: '#ffffff',
    radius: 8
  }
};

const CONNECTION_STATUS_VISIBILITY_DELAY_MS = 4000;
const RECONNECT_INTERVAL_MS = 45000;

const SCOREBOARD_THEMES = ['broadcast', 'slate', 'minimal', 'neon', 'classic', 'arena'];

const LOW_BOOST_THRESHOLD = 12;
const SUPERSONIC_SPEED = 2200;

const DEFAULT_PERFORMANCE = {
  trackedSeconds: 0,
  avgBoost: 0,
  minBoost: 100,
  zeroBoostSeconds: 0,
  lowBoostSeconds: 0,
  lowBoostPercent: 0,
  avgSpeed: 0,
  supersonicSeconds: 0,
  groundSeconds: 0,
  wallSeconds: 0,
  powerslideSeconds: 0,
  demolishedSeconds: 0,
  boostWhileSupersonicSeconds: 0,
  touches: 0,
  carTouches: 0,
  touchesPerMinute: 0,
  scorePerMinute: 0,
  shootingEfficiency: 0,
  boostDisciplineScore: 100
};

const DEFAULT_DAILY = {
  date: dayKey(),
  wins: 0,
  losses: 0,
  matchesPlayed: 0,
  goals: 0,
  assists: 0,
  saves: 0,
  shots: 0,
  demos: 0,
  score: 0,
  currentStreak: 0,
  currentStreakType: null,
  bestWinStreak: 0,
  lastResult: null,
  countedMatchIds: [],
  performance: DEFAULT_PERFORMANCE
};

const DEFAULT_SERIES_STATE = {
  bestOf: 3,
  blueGames: 0,
  orangeGames: 0,
  blueGoalAdjust: 0,
  orangeGoalAdjust: 0,
  autoAddGames: true,
  sidesSwapped: false,
  countedMatchIds: []
};

function dayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampInt(value, min, max, fallback = min) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function bool(value) {
  return value === true;
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function clampDelta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return Math.min(seconds, 2);
}

function normalizeArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : Object.values(value);
}

function normalizeTeam(team, fallback) {
  const rawName = String(team?.name ?? fallback.name);
  const legacyDefault = (
    (fallback.name === 'Azul' && rawName.trim().toUpperCase() === 'BLUE') ||
    (fallback.name === 'Naranja' && rawName.trim().toUpperCase() === 'ORANGE')
  );
  return {
    ...fallback,
    ...(team || {}),
    name: legacyDefault ? fallback.name : rawName,
    logoDataUrl: String(team?.logoDataUrl ?? fallback.logoDataUrl),
    color: String(team?.color ?? fallback.color)
  };
}

function normalizeConfig(config = {}) {
  const overlayPort = Number(config.overlayPort || DEFAULT_CONFIG.overlayPort);
  const rawTheme = config.style?.theme === 'broadcast' ? 'slate' : config.style?.theme;
  return {
    ...DEFAULT_CONFIG,
    ...config,
    playerName: String(config.playerName ?? DEFAULT_CONFIG.playerName),
    primaryId: String(config.primaryId ?? DEFAULT_CONFIG.primaryId),
    statsApiPort: Number(config.statsApiPort || DEFAULT_CONFIG.statsApiPort),
    autoConnectStatsApi: config.autoConnectStatsApi !== false,
    overlayPort: Number.isFinite(overlayPort) ? overlayPort : DEFAULT_CONFIG.overlayPort,
    eventLabel: String(config.eventLabel ?? DEFAULT_CONFIG.eventLabel),
    seriesLabel: String(config.seriesLabel ?? DEFAULT_CONFIG.seriesLabel),
    subtitle: String(config.subtitle ?? DEFAULT_CONFIG.subtitle),
    showPlayers: config.showPlayers !== false,
    blueTeam: normalizeTeam(config.blueTeam, DEFAULT_CONFIG.blueTeam),
    orangeTeam: normalizeTeam(config.orangeTeam, DEFAULT_CONFIG.orangeTeam),
    style: {
      ...DEFAULT_CONFIG.style,
      ...(config.style || {}),
      theme: SCOREBOARD_THEMES.includes(rawTheme) ? rawTheme : DEFAULT_CONFIG.style.theme
    }
  };
}

function normalizePerformance(performance = {}) {
  return {
    ...DEFAULT_PERFORMANCE,
    ...(performance || {})
  };
}

function normalizeDaily(daily = {}, date = dayKey()) {
  return {
    ...DEFAULT_DAILY,
    ...daily,
    date: daily.date || date,
    countedMatchIds: Array.isArray(daily.countedMatchIds) ? daily.countedMatchIds : [],
    performance: normalizePerformance(daily.performance)
  };
}

function normalizeSeriesState(series = {}) {
  const bestOf = clampInt(series.bestOf, 1, 99, DEFAULT_SERIES_STATE.bestOf);
  return {
    ...DEFAULT_SERIES_STATE,
    ...(series || {}),
    bestOf,
    blueGames: clampInt(series.blueGames, 0, 99, 0),
    orangeGames: clampInt(series.orangeGames, 0, 99, 0),
    blueGoalAdjust: clampInt(series.blueGoalAdjust, -99, 99, 0),
    orangeGoalAdjust: clampInt(series.orangeGoalAdjust, -99, 99, 0),
    autoAddGames: series.autoAddGames !== false,
    sidesSwapped: series.sidesSwapped === true,
    countedMatchIds: Array.isArray(series.countedMatchIds) ? series.countedMatchIds.slice(-250) : []
  };
}

function buildSeriesStatus(series = DEFAULT_SERIES_STATE) {
  const state = normalizeSeriesState(series);
  const played = state.blueGames + state.orangeGames;
  const isEvenLength = state.bestOf % 2 === 0;
  const targetWins = Math.floor(state.bestOf / 2) + 1;
  const maxGames = state.bestOf;
  const blueClinched = state.blueGames >= targetWins;
  const orangeClinched = state.orangeGames >= targetWins;
  const completed = isEvenLength
    ? played >= maxGames || blueClinched || orangeClinched
    : blueClinched || orangeClinched || played >= maxGames;
  const winner = completed
    ? state.blueGames > state.orangeGames ? 'blue' : state.orangeGames > state.blueGames ? 'orange' : 'draw'
    : null;
  const gameNumber = completed ? Math.max(1, Math.min(maxGames, played || 1)) : Math.min(maxGames, played + 1);
  const label = `${completed ? 'FINAL' : `GAME ${gameNumber}`} · BO${state.bestOf} · ${state.blueGames}-${state.orangeGames}`;
  return {
    bestOf: state.bestOf,
    played,
    maxGames,
    targetWins,
    gameNumber,
    completed,
    winner,
    label,
    modeLabel: isEvenLength ? `${state.bestOf} partidos` : `primero a ${targetWins}`
  };
}

function createAccumulator(matchGuid) {
  return {
    id: matchGuid,
    startedAt: new Date().toISOString(),
    lastWallTime: 0,
    duration: 0,
    boostWeighted: 0,
    speedWeighted: 0,
    minBoost: 100,
    zeroBoostSeconds: 0,
    lowBoostSeconds: 0,
    supersonicSeconds: 0,
    groundSeconds: 0,
    wallSeconds: 0,
    powerslideSeconds: 0,
    demolishedSeconds: 0,
    boostWhileSupersonicSeconds: 0,
    touches: 0,
    carTouches: 0,
    score: 0,
    goals: 0,
    assists: 0,
    saves: 0,
    shots: 0,
    demos: 0,
    boostTimeline: [],
    speedTimeline: []
  };
}

function summarizeAccumulator(accumulator) {
  if (!accumulator || accumulator.duration <= 0) return normalizePerformance();
  const trackedSeconds = round(accumulator.duration);
  const avgBoost = round(accumulator.boostWeighted / accumulator.duration);
  const avgSpeed = round(accumulator.speedWeighted / accumulator.duration);
  const lowBoostPercent = round((accumulator.lowBoostSeconds / accumulator.duration) * 100);
  const touchesPerMinute = round((accumulator.touches / accumulator.duration) * 60);
  const scorePerMinute = round((accumulator.score / accumulator.duration) * 60);
  const shootingEfficiency = accumulator.shots > 0 ? round((accumulator.goals / accumulator.shots) * 100) : 0;
  const boostDisciplineScore = Math.max(0, Math.min(100, Math.round(100 - lowBoostPercent * 1.6 - accumulator.boostWhileSupersonicSeconds * 0.15)));
  return {
    trackedSeconds,
    avgBoost,
    minBoost: accumulator.minBoost === 100 ? 0 : Math.round(accumulator.minBoost),
    zeroBoostSeconds: round(accumulator.zeroBoostSeconds),
    lowBoostSeconds: round(accumulator.lowBoostSeconds),
    lowBoostPercent,
    avgSpeed,
    supersonicSeconds: round(accumulator.supersonicSeconds),
    groundSeconds: round(accumulator.groundSeconds),
    wallSeconds: round(accumulator.wallSeconds),
    powerslideSeconds: round(accumulator.powerslideSeconds),
    demolishedSeconds: round(accumulator.demolishedSeconds),
    boostWhileSupersonicSeconds: round(accumulator.boostWhileSupersonicSeconds),
    touches: accumulator.touches,
    carTouches: accumulator.carTouches,
    touchesPerMinute,
    scorePerMinute,
    shootingEfficiency,
    boostDisciplineScore
  };
}

function combinePerformance(total = DEFAULT_PERFORMANCE, next = DEFAULT_PERFORMANCE) {
  total = normalizePerformance(total);
  next = normalizePerformance(next);
  if (next.trackedSeconds <= 0) return total;
  if (total.trackedSeconds <= 0) return next;
  const trackedSeconds = total.trackedSeconds + next.trackedSeconds;
  const weighted = (a, b) => round((a * total.trackedSeconds + b * next.trackedSeconds) / trackedSeconds);
  const lowBoostSeconds = total.lowBoostSeconds + next.lowBoostSeconds;
  const touches = total.touches + next.touches;
  const scorePerMinute = round((((total.scorePerMinute * total.trackedSeconds) / 60) + ((next.scorePerMinute * next.trackedSeconds) / 60)) / trackedSeconds * 60);
  const minBoost = Math.min(Number.isFinite(total.minBoost) ? total.minBoost : 100, Number.isFinite(next.minBoost) ? next.minBoost : 100);
  return {
    trackedSeconds,
    avgBoost: weighted(total.avgBoost, next.avgBoost),
    minBoost,
    zeroBoostSeconds: round(total.zeroBoostSeconds + next.zeroBoostSeconds),
    lowBoostSeconds: round(lowBoostSeconds),
    lowBoostPercent: round((lowBoostSeconds / trackedSeconds) * 100),
    avgSpeed: weighted(total.avgSpeed, next.avgSpeed),
    supersonicSeconds: round(total.supersonicSeconds + next.supersonicSeconds),
    groundSeconds: round(total.groundSeconds + next.groundSeconds),
    wallSeconds: round(total.wallSeconds + next.wallSeconds),
    powerslideSeconds: round(total.powerslideSeconds + next.powerslideSeconds),
    demolishedSeconds: round(total.demolishedSeconds + next.demolishedSeconds),
    boostWhileSupersonicSeconds: round(total.boostWhileSupersonicSeconds + next.boostWhileSupersonicSeconds),
    touches,
    carTouches: numberOrZero(total.carTouches) + numberOrZero(next.carTouches),
    touchesPerMinute: round((touches / trackedSeconds) * 60),
    scorePerMinute,
    shootingEfficiency: weighted(total.shootingEfficiency, next.shootingEfficiency),
    boostDisciplineScore: weighted(total.boostDisciplineScore, next.boostDisciplineScore)
  };
}

function labelFromSeconds(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function pushTimelinePoint(points, point) {
  const previous = points[points.length - 1];
  if (previous && previous.label === point.label) {
    points[points.length - 1] = point;
  } else {
    points.push(point);
  }
  if (points.length > 90) points.shift();
}

function shortDateLabel(date) {
  const [, month, day] = String(date || '').split('-');
  return `${day || '--'}/${month || '--'}`;
}

function addDays(date, offset) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + offset);
  return copy;
}

function dayKeyToDate(key) {
  return new Date(`${key}T12:00:00`);
}

function statsWinrate(stats) {
  return stats.matchesPlayed ? Math.round((stats.wins / stats.matchesPlayed) * 100) : 0;
}

function mergeDailyStats(base, next) {
  const matchesPlayed = numberOrZero(base.matchesPlayed) + numberOrZero(next.matchesPlayed);
  const goals = numberOrZero(base.goals) + numberOrZero(next.goals);
  const shots = numberOrZero(base.shots) + numberOrZero(next.shots);
  return normalizeDaily({
    ...base,
    wins: numberOrZero(base.wins) + numberOrZero(next.wins),
    losses: numberOrZero(base.losses) + numberOrZero(next.losses),
    matchesPlayed,
    goals,
    assists: numberOrZero(base.assists) + numberOrZero(next.assists),
    saves: numberOrZero(base.saves) + numberOrZero(next.saves),
    shots,
    demos: numberOrZero(base.demos) + numberOrZero(next.demos),
    score: numberOrZero(base.score) + numberOrZero(next.score),
    bestWinStreak: Math.max(numberOrZero(base.bestWinStreak), numberOrZero(next.bestWinStreak)),
    currentStreak: next.currentStreak || base.currentStreak,
    currentStreakType: next.currentStreakType ?? base.currentStreakType,
    lastResult: next.lastResult ?? base.lastResult,
    countedMatchIds: [...new Set([...(base.countedMatchIds || []), ...(next.countedMatchIds || [])])],
    performance: combinePerformance(base.performance, {
      ...normalizePerformance(next.performance),
      shootingEfficiency: shots > 0 ? round((goals / shots) * 100) : numberOrZero(next.performance?.shootingEfficiency)
    })
  }, base.date);
}

function buildRangeSummary(allDays, key, days, today = dayKey()) {
  const toDate = dayKeyToDate(today);
  const fromDate = addDays(toDate, -(days - 1));
  const dayMap = new Map(allDays.map((day) => [day.date, day]));
  const calendarDays = Array.from({ length: days }, (_, index) => {
    const date = addDays(fromDate, index);
    const keyForDay = dayKey(date);
    return dayMap.get(keyForDay) || normalizeDaily({ date: keyForDay }, keyForDay);
  });
  const aggregate = calendarDays.reduce((total, day) => mergeDailyStats(total, day), normalizeDaily({ date: `${dayKey(fromDate)}..${today}` }, `${dayKey(fromDate)}..${today}`));
  return {
    key,
    label: key === '7d' ? 'Últimos 7 días' : 'Últimos 30 días',
    days,
    from: dayKey(fromDate),
    to: today,
    stats: aggregate,
    matches: aggregate.matchesPlayed,
    wins: aggregate.wins,
    losses: aggregate.losses,
    goals: aggregate.goals,
    charts: {
      matches: calendarDays.map((day) => ({ label: shortDateLabel(day.date), value: day.matchesPlayed })),
      winrate: calendarDays.map((day) => ({ label: shortDateLabel(day.date), value: statsWinrate(day) })),
      goals: calendarDays.map((day) => ({ label: shortDateLabel(day.date), value: day.goals })),
      boostDiscipline: calendarDays.map((day) => ({ label: shortDateLabel(day.date), value: day.performance.trackedSeconds > 0 ? day.performance.boostDisciplineScore : 0 })),
      touchesPerMinute: calendarDays.map((day) => ({ label: shortDateLabel(day.date), value: day.performance.touchesPerMinute }))
    }
  };
}

function getPayload(event) {
  return event?.data ?? event?.payload ?? event?.Data ?? event?.raw ?? {};
}

function readMatchGuid(payload = {}) {
  return payload.MatchGuid || payload.MatchGUID || payload.Game?.MatchGuid || payload.Game?.MatchGUID;
}

function readTeams(payload = {}) {
  return normalizeArray(payload.Teams || payload.Game?.Teams);
}

function readRawPlayers(payload = {}) {
  return normalizeArray(payload.Players ?? payload.players ?? payload.Game?.Players ?? payload.Game?.players);
}

function readTeamScore(teams, teamNum) {
  const row = teams.find((team, index) => Number(team.TeamNum ?? team.teamNum ?? team.team_num ?? index) === teamNum);
  return numberOrZero(row?.Score ?? row?.score);
}

function readPlayerName(playerOrName) {
  if (!playerOrName) return 'Unknown';
  if (typeof playerOrName === 'string') return playerOrName;
  return playerOrName.Name || playerOrName.name || playerOrName.PrimaryId || playerOrName.id || 'Unknown';
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeHexColor(value, fallback = '') {
  let raw = String(value || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    raw = raw.split('').map((ch) => ch + ch).join('');
  }
  if (!/^[0-9a-f]{6}$/i.test(raw)) return fallback;
  return `#${raw.toLowerCase()}`;
}

function genericTeamName(name, teamNum) {
  const value = String(name || '').trim().toLowerCase();
  if (!value) return true;
  const genericBySide = teamNum === 0
    ? new Set(['blue', 'azul', 'team blue', 'blue team', 'equipo azul'])
    : new Set(['orange', 'naranja', 'team orange', 'orange team', 'equipo naranja']);
  return genericBySide.has(value) || /^team\s*[12]$/.test(value) || /^equipo\s*[12]$/.test(value);
}

function readTeamMeta(teams, players, teamNum, fallbackTeam) {
  const row = teams.find((team, index) => Number(team.TeamNum ?? team.teamNum ?? team.team_num ?? index) === teamNum) || {};
  const sidePlayers = players.filter((player) => Number(player.TeamNum ?? player.Team ?? player.team ?? player.team_num) === teamNum);
  const rawName = String(row.Name ?? row.name ?? '').trim();
  const oneVersusOne = sidePlayers.length === 1 && players.filter((player) => {
    const n = Number(player.TeamNum ?? player.Team ?? player.team ?? player.team_num);
    return n === 0 || n === 1;
  }).length === 2;
  const playerName = oneVersusOne ? readPlayerName(sidePlayers[0]) : '';
  const detectedName = oneVersusOne && genericTeamName(rawName, teamNum) ? playerName : rawName;
  const primary = normalizeHexColor(
    row.ColorPrimary ?? row.colorPrimary ?? row.color_primary ?? row.PrimaryColor ?? row.primaryColor,
    ''
  );
  const secondary = normalizeHexColor(
    row.ColorSecondary ?? row.colorSecondary ?? row.color_secondary ?? row.SecondaryColor ?? row.secondaryColor,
    ''
  );
  return {
    name: detectedName || fallbackTeam.name,
    color: primary || fallbackTeam.color,
    secondaryColor: secondary || '',
    logoDataUrl: fallbackTeam.logoDataUrl || '',
    source: detectedName || primary || secondary ? 'stats-api' : 'manual',
    playerCount: sidePlayers.length,
  };
}

function readPlayers(payload = {}) {
  const raw = readRawPlayers(payload);
  return raw.map((player) => {
    const boost = firstFiniteNumber(player.Boost, player.boost);
    return {
      name: readPlayerName(player),
      teamNum: firstFiniteNumber(player.TeamNum, player.Team, player.team, player.team_num),
      boost: boost == null ? null : Math.max(0, Math.min(100, Math.round(boost)))
    };
  });
}

function parseEvent(raw) {
  const envelope = raw && typeof raw === 'object' ? raw : {};
  const type = String(envelope.type ?? envelope.event ?? envelope.Event ?? envelope.EventName ?? envelope.name ?? envelope.Type ?? 'Unknown');
  let data = envelope.data ?? envelope.payload ?? envelope.Data ?? envelope;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch {}
  }
  return { type, event: type, data, raw, receivedAt: new Date().toISOString() };
}

function parseConcatenatedJsonMessages(buffer) {
  const messages = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (escaped) { escaped = false; continue; }
    if (inString && ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        messages.push(buffer.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return { messages, leftover: depth > 0 && start >= 0 ? buffer.slice(start) : '' };
}

function createRocketLeagueLiveService({ app, saveLog, getMainWindow, overlayPath, statsOverlayPath }) {
  const storePath = path.join(app.getPath('userData'), 'rocket-league-live.json');
  let config = normalizeConfig();
  let dailyStats = normalizeDaily({ date: dayKey() });
  let seriesState = normalizeSeriesState();
  let historyByDate = {};
  let matchHistory = [];
  let currentAccumulator = null;
  let currentMatch = null;
  let currentPlayer = null;
  let lastEvents = [];
  let connectionStatus = 'disconnected';
  let visibleConnectionStatus = 'disconnected';
  let overlayServer = null;
  let overlayWss = null;
  let apiWs = null;
  let reconnectTimer = null;
  let connectionStatusVisibilityTimer = null;
  let currentTransport = null;
  let started = false;
  const loggedOnce = new Set();

  function log(type, msg) {
    try { saveLog?.(type, `[RL Live] ${msg}`); } catch {}
  }

  function logOnce(type, key, msg) {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    log(type, msg);
  }

  function isLiveConnectionStatus(status) {
    return status === 'connected' || status === 'waiting-match';
  }

  function clearConnectionStatusVisibilityTimer() {
    if (connectionStatusVisibilityTimer) clearTimeout(connectionStatusVisibilityTimer);
    connectionStatusVisibilityTimer = null;
  }

  function setConnectionStatus(nextStatus, { smoothTransient = false } = {}) {
    connectionStatus = nextStatus;

    if (
      smoothTransient &&
      !isLiveConnectionStatus(nextStatus) &&
      isLiveConnectionStatus(visibleConnectionStatus)
    ) {
      if (!connectionStatusVisibilityTimer) {
        connectionStatusVisibilityTimer = setTimeout(() => {
          connectionStatusVisibilityTimer = null;
          if (!isLiveConnectionStatus(connectionStatus) && visibleConnectionStatus !== connectionStatus) {
            visibleConnectionStatus = connectionStatus;
            emitUpdate();
          }
        }, CONNECTION_STATUS_VISIBILITY_DELAY_MS);
      }
      return;
    }

    clearConnectionStatusVisibilityTimer();
    visibleConnectionStatus = nextStatus;
  }

  function loadStore() {
    try {
      if (!fs.existsSync(storePath)) return;
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      config = normalizeConfig(parsed.config);
      dailyStats = normalizeDaily(parsed.dailyStats);
      seriesState = normalizeSeriesState(parsed.seriesState);
      historyByDate = Object.fromEntries(
        Object.entries(parsed.historyByDate || {}).map(([date, stats]) => [date, normalizeDaily(stats, date)])
      );
      matchHistory = Array.isArray(parsed.matchHistory) ? parsed.matchHistory.slice(0, 250) : [];
    } catch (error) {
      log('warn', `No se pudo leer rocket-league-live.json: ${error?.message || error}`);
    }
  }

  function saveStore() {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify({ config, dailyStats, seriesState, historyByDate, matchHistory }, null, 2));
    } catch (error) {
      log('warn', `No se pudo guardar estado local: ${error?.message || error}`);
    }
  }

  function ensureDailyBoundary() {
    if (dailyStats.date !== dayKey()) {
      if (dailyStats.matchesPlayed > 0 || dailyStats.countedMatchIds.length > 0 || dailyStats.performance.trackedSeconds > 0) {
        historyByDate[dailyStats.date] = dailyStats;
      }
      dailyStats = normalizeDaily({ date: dayKey() });
      saveStore();
    }
  }

  function buildHistoryAnalytics() {
    const byDate = new Map();
    for (const [date, stats] of Object.entries(historyByDate || {})) {
      byDate.set(date, normalizeDaily(stats, date));
    }
    byDate.set(dailyStats.date, normalizeDaily(dailyStats, dailyStats.date));
    const days = [...byDate.values()]
      .filter((day) => day.matchesPlayed > 0 || day.countedMatchIds.length > 0 || day.performance.trackedSeconds > 0)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return {
      days,
      availableDates: days.map((day) => day.date).reverse(),
      last7: buildRangeSummary(days, '7d', 7),
      last30: buildRangeSummary(days, '30d', 30)
    };
  }

  function buildPerformanceCharts() {
    return {
      boostTimeline: currentAccumulator?.boostTimeline || [],
      speedTimeline: currentAccumulator?.speedTimeline || [],
      matchTrend: [...matchHistory].reverse().slice(-20).map((match, index) => ({
        label: `P${index + 1}`,
        value: numberOrZero(match.stats?.score),
        secondary: numberOrZero(match.performance?.avgBoost),
        result: match.result
      })),
      statAverages: [
        { label: 'Goles', value: dailyStats.matchesPlayed ? round(dailyStats.goals / dailyStats.matchesPlayed) : 0 },
        { label: 'Shots', value: dailyStats.matchesPlayed ? round(dailyStats.shots / dailyStats.matchesPlayed) : 0 },
        { label: 'Saves', value: dailyStats.matchesPlayed ? round(dailyStats.saves / dailyStats.matchesPlayed) : 0 },
        { label: 'Demos', value: dailyStats.matchesPlayed ? round(dailyStats.demos / dailyStats.matchesPlayed) : 0 },
        { label: 'Touches/min', value: dailyStats.performance.touchesPerMinute || 0 },
        { label: 'Boost score', value: dailyStats.performance.boostDisciplineScore || 0 }
      ]
    };
  }

  function buildCoachInsights() {
    const stats = dailyStats || normalizeDaily();
    const perf = stats.performance?.trackedSeconds > 0 ? stats.performance : currentMatch?.performance || normalizePerformance();
    if (!perf || perf.trackedSeconds <= 0) return [];
    const matches = Math.max(1, numberOrZero(stats.matchesPlayed));
    const shootingEfficiency = stats.shots > 0 ? round((stats.goals / stats.shots) * 100) : numberOrZero(perf.shootingEfficiency);
    const demosPerMatch = round(numberOrZero(stats.demos) / matches);
    return [
      {
        id: 'boost-low',
        severity: perf.lowBoostPercent > 26 ? 'critical' : perf.lowBoostPercent > 18 ? 'warning' : 'good',
        title: 'Tiempo con boost bajo',
        value: `${perf.lowBoostPercent}%`,
        detail: perf.lowBoostPercent > 18
          ? 'Buscá pads chicos durante rotaciones y evitá entrar al challenge con menos de 12 boost.'
          : 'Buen control de recursos. Mantené esa disciplina cuando sube el ritmo.'
      },
      {
        id: 'boost-supersonic',
        severity: perf.boostWhileSupersonicSeconds > 35 ? 'warning' : 'good',
        title: 'Boost gastado ya supersónico',
        value: `${Math.round(perf.boostWhileSupersonicSeconds)}s`,
        detail: perf.boostWhileSupersonicSeconds > 35
          ? 'Soltá boost al llegar a velocidad máxima; ese ahorro decide defensas y segundos toques.'
          : 'No estás quemando demasiado boost a velocidad máxima.'
      },
      {
        id: 'shooting',
        severity: stats.shots >= 6 && shootingEfficiency < 25 ? 'warning' : 'good',
        title: 'Conversión de tiros',
        value: `${shootingEfficiency}%`,
        detail: shootingEfficiency < 25
          ? 'Hay volumen de tiros, pero poca conversión. Priorizá tiros colocados o pases antes que clears al arco.'
          : 'La eficiencia de tiro está saludable para la sesión.'
      },
      {
        id: 'touch-rate',
        severity: perf.touchesPerMinute < 6.5 || perf.touchesPerMinute > 13 ? 'warning' : 'good',
        title: 'Touches por minuto',
        value: `${perf.touchesPerMinute}`,
        detail: perf.touchesPerMinute < 6.5
          ? 'Puede haber demasiado tiempo fuera de la jugada. Revisá posicionamiento de apoyo.'
          : perf.touchesPerMinute > 13
            ? 'Muchos toques pueden indicar sobrecomité. Mirá si tus toques mejoran la posesión.'
            : 'Participación equilibrada.'
      },
      {
        id: 'pressure',
        severity: demosPerMatch >= 0.6 ? 'good' : 'warning',
        title: 'Presión física',
        value: `${demosPerMatch}/partido`,
        detail: demosPerMatch >= 0.6
          ? 'Estás creando presión con demos. Usalas cuando tu compañero puede capitalizar.'
          : 'Hay margen para sumar bumps/demos en rotaciones ofensivas sin regalar posición.'
      }
    ];
  }

  function buildScoreboardState() {
    const match = currentMatch || {};
    const physicalBlueScore = Number.isFinite(Number(match.blueScore)) ? Number(match.blueScore) : 0;
    const physicalOrangeScore = Number.isFinite(Number(match.orangeScore)) ? Number(match.orangeScore) : 0;
    const rawBlueScore = seriesState.sidesSwapped ? physicalOrangeScore : physicalBlueScore;
    const rawOrangeScore = seriesState.sidesSwapped ? physicalBlueScore : physicalOrangeScore;
    const blueGoalAdjust = numberOrZero(seriesState.blueGoalAdjust);
    const orangeGoalAdjust = numberOrZero(seriesState.orangeGoalAdjust);
    const series = buildSeriesStatus(seriesState);
    const detectedBlueTeam = {
      ...config.blueTeam,
      ...(match.teams?.blue || {}),
      logoDataUrl: config.blueTeam.logoDataUrl || '',
    };
    const detectedOrangeTeam = {
      ...config.orangeTeam,
      ...(match.teams?.orange || {}),
      logoDataUrl: config.orangeTeam.logoDataUrl || '',
    };
    const blueTeam = seriesState.sidesSwapped === true ? detectedOrangeTeam : detectedBlueTeam;
    const orangeTeam = seriesState.sidesSwapped === true ? detectedBlueTeam : detectedOrangeTeam;
    return {
      ...match,
      blueTeam,
      orangeTeam,
      blueScore: Math.max(0, rawBlueScore + blueGoalAdjust),
      orangeScore: Math.max(0, rawOrangeScore + orangeGoalAdjust),
      rawBlueScore,
      rawOrangeScore,
      physicalBlueScore,
      physicalOrangeScore,
      sidesSwapped: seriesState.sidesSwapped === true,
      blueGoalAdjust,
      orangeGoalAdjust,
      series,
      seriesLabel: config.seriesLabel || series.label
    };
  }

  function snapshot() {
    ensureDailyBoundary();
    const scoreboard = buildScoreboardState();
    return {
      connectionStatus: visibleConnectionStatus,
      rawConnectionStatus: connectionStatus,
      config,
      currentMatch,
      scoreboard,
      seriesState: normalizeSeriesState(seriesState),
      currentPlayer,
      dailyStats,
      matchHistory,
      performanceCharts: buildPerformanceCharts(),
      historyAnalytics: buildHistoryAnalytics(),
      coachInsights: buildCoachInsights(),
      lastEvents,
      urls: {
        broadcast: `http://localhost:${config.overlayPort}/broadcast`,
        stats: `http://localhost:${config.overlayPort}/stats`,
        root: `http://localhost:${config.overlayPort}`
      },
      storePath
    };
  }

  function emitUpdate(eventName = 'rl-stats-update') {
    const state = snapshot();
    const mainWindow = getMainWindow?.();
    try { mainWindow?.webContents?.send(eventName, state); } catch {}
    broadcast({ type: 'state', data: state });
    return state;
  }

  function broadcast(message) {
    if (!overlayWss) return;
    const serialized = JSON.stringify(message);
    for (const client of overlayWss.clients) {
      if (client.readyState === 1) client.send(serialized);
    }
  }

  function findCurrentPlayer(players) {
    const playerName = config.playerName.trim().toLowerCase();
    const primaryId = config.primaryId.trim().toLowerCase();
    return (
      players.find((player) => primaryId && String(player.PrimaryId || '').toLowerCase() === primaryId) ||
      players.find((player) => playerName && String(player.Name || '').toLowerCase() === playerName) ||
      players[0] ||
      null
    );
  }

  function processUpdateState(payload) {
    const teams = readTeams(payload);
    const players = readRawPlayers(payload);
    const me = findCurrentPlayer(players);
    const matchGuid = readMatchGuid(payload) || currentMatch?.matchGuid;
    if (!currentAccumulator || (matchGuid && currentAccumulator.id && currentAccumulator.id !== matchGuid)) {
      currentAccumulator = createAccumulator(matchGuid);
    }
    if (matchGuid && currentAccumulator && !currentAccumulator.id) currentAccumulator.id = matchGuid;
    addTelemetrySample(me);
    currentPlayer = me || currentPlayer;
    const detectedBlueTeam = readTeamMeta(teams, players, 0, config.blueTeam);
    const detectedOrangeTeam = readTeamMeta(teams, players, 1, config.orangeTeam);
    currentMatch = {
      matchGuid,
      arena: payload.Arena || payload.Game?.Arena || currentMatch?.arena,
      blueScore: readTeamScore(teams, 0),
      orangeScore: readTeamScore(teams, 1),
      teams: {
        blue: detectedBlueTeam,
        orange: detectedOrangeTeam,
      },
      secondsRemaining:
        typeof payload.SecondsRemaining === 'number' ? payload.SecondsRemaining :
        typeof payload.GameTimeRemaining === 'number' ? payload.GameTimeRemaining :
        typeof payload.TimeSeconds === 'number' ? payload.TimeSeconds :
        typeof payload.Game?.TimeSeconds === 'number' ? payload.Game.TimeSeconds :
        currentMatch?.secondsRemaining,
      isOvertime: Boolean(payload.IsOvertime ?? payload.Overtime ?? payload.bOvertime ?? payload.Game?.bOvertime ?? currentMatch?.isOvertime),
      playerTeamNum: typeof me?.TeamNum === 'number' ? me.TeamNum : currentMatch?.playerTeamNum,
      playerBoost: typeof me?.Boost === 'number' ? me.Boost : currentMatch?.playerBoost,
      playerSpeed: typeof me?.Speed === 'number' ? me.Speed : currentMatch?.playerSpeed,
      lastGoal: currentMatch?.lastGoal,
      performance: summarizeAccumulator(currentAccumulator),
      startedAt: currentMatch?.startedAt || new Date().toISOString(),
      players: readPlayers(payload)
    };
    setConnectionStatus('connected');
  }

  function addTelemetrySample(player) {
    if (!player || !currentAccumulator) return;
    const now = Date.now();
    const delta = clampDelta(currentAccumulator.lastWallTime ? (now - currentAccumulator.lastWallTime) / 1000 : 0);
    currentAccumulator.lastWallTime = now;
    const boost = typeof player.Boost === 'number' ? player.Boost : 0;
    const speed = typeof player.Speed === 'number' ? player.Speed : 0;
    currentAccumulator.duration += delta;
    currentAccumulator.boostWeighted += boost * delta;
    currentAccumulator.speedWeighted += speed * delta;
    currentAccumulator.minBoost = Math.min(currentAccumulator.minBoost, boost);
    currentAccumulator.zeroBoostSeconds += boost <= 0 ? delta : 0;
    currentAccumulator.lowBoostSeconds += boost <= LOW_BOOST_THRESHOLD ? delta : 0;
    currentAccumulator.supersonicSeconds += bool(player.bSupersonic) || speed >= SUPERSONIC_SPEED ? delta : 0;
    currentAccumulator.groundSeconds += bool(player.bOnGround) ? delta : 0;
    currentAccumulator.wallSeconds += bool(player.bOnWall) ? delta : 0;
    currentAccumulator.powerslideSeconds += bool(player.bPowersliding) ? delta : 0;
    currentAccumulator.demolishedSeconds += bool(player.bDemolished) ? delta : 0;
    currentAccumulator.boostWhileSupersonicSeconds += bool(player.bBoosting) && (bool(player.bSupersonic) || speed >= SUPERSONIC_SPEED) ? delta : 0;
    currentAccumulator.touches = Math.max(currentAccumulator.touches, numberOrZero(player.Touches ?? player.CarTouches));
    currentAccumulator.carTouches = Math.max(currentAccumulator.carTouches, numberOrZero(player.CarTouches));
    currentAccumulator.score = numberOrZero(player.Score);
    currentAccumulator.goals = numberOrZero(player.Goals);
    currentAccumulator.assists = numberOrZero(player.Assists);
    currentAccumulator.saves = numberOrZero(player.Saves);
    currentAccumulator.shots = numberOrZero(player.Shots);
    currentAccumulator.demos = numberOrZero(player.Demos);
    const label = labelFromSeconds(currentAccumulator.duration);
    pushTimelinePoint(currentAccumulator.boostTimeline, { label, value: Math.round(boost) });
    pushTimelinePoint(currentAccumulator.speedTimeline, { label, value: Math.round(speed) });
  }

  function processGoalScored(payload) {
    const scorer = typeof payload.Scorer === 'object' ? payload.Scorer : undefined;
    currentMatch = {
      ...(currentMatch || { blueScore: 0, orangeScore: 0, isOvertime: false }),
      lastGoal: {
        scorer: payload.ScorerName || readPlayerName(payload.Scorer),
        assist: payload.AssisterName || (payload.Assister ? readPlayerName(payload.Assister) : undefined),
        speed: typeof payload.GoalSpeed === 'number' ? payload.GoalSpeed : typeof payload.Speed === 'number' ? payload.Speed : typeof payload.BallSpeed === 'number' ? payload.BallSpeed : undefined,
        teamNum: payload.TeamNum ?? scorer?.TeamNum,
        at: new Date().toISOString()
      }
    };
  }

  function processClock(payload) {
    currentMatch = {
      ...(currentMatch || { blueScore: 0, orangeScore: 0, isOvertime: false }),
      secondsRemaining: payload.TimeSeconds ?? payload.SecondsRemaining ?? currentMatch?.secondsRemaining,
      isOvertime: Boolean(payload.bOvertime ?? payload.IsOvertime ?? currentMatch?.isOvertime)
    };
  }

  function recordSeriesGameWinner(side, matchId) {
    if (side !== 'blue' && side !== 'orange') return false;
    const normalized = normalizeSeriesState(seriesState);
    if (matchId && normalized.countedMatchIds.includes(matchId)) return false;
    seriesState = {
      ...normalized,
      blueGames: side === 'blue' ? normalized.blueGames + 1 : normalized.blueGames,
      orangeGames: side === 'orange' ? normalized.orangeGames + 1 : normalized.orangeGames,
      countedMatchIds: matchId ? [...normalized.countedMatchIds, matchId].slice(-250) : normalized.countedMatchIds
    };
    return true;
  }

  function resetCurrentGoalAdjustments() {
    seriesState = {
      ...normalizeSeriesState(seriesState),
      blueGoalAdjust: 0,
      orangeGoalAdjust: 0
    };
  }

  function applySeriesAction(action = {}) {
    const type = String(action.type || '');
    const side = action.side === 'orange' ? 'orange' : 'blue';
    const delta = clampInt(action.delta, -99, 99, 0);
    const current = normalizeSeriesState(seriesState);
    let next = current;

    if (type === 'set-best-of') {
      next = { ...current, bestOf: clampInt(action.bestOf, 1, 99, current.bestOf) };
    } else if (type === 'set-auto-add') {
      next = { ...current, autoAddGames: action.enabled !== false };
    } else if (type === 'adjust-goal') {
      const key = side === 'blue' ? 'blueGoalAdjust' : 'orangeGoalAdjust';
      next = { ...current, [key]: clampInt(current[key] + delta, -99, 99, current[key]) };
    } else if (type === 'set-goals') {
      const blueBase = currentMatch ? numberOrZero(currentMatch.blueScore) : 0;
      const orangeBase = currentMatch ? numberOrZero(currentMatch.orangeScore) : 0;
      next = {
        ...current,
        blueGoalAdjust: clampInt(numberOrZero(action.blueScore) - blueBase, -99, 99, current.blueGoalAdjust),
        orangeGoalAdjust: clampInt(numberOrZero(action.orangeScore) - orangeBase, -99, 99, current.orangeGoalAdjust)
      };
    } else if (type === 'reset-goals') {
      next = { ...current, blueGoalAdjust: 0, orangeGoalAdjust: 0 };
    } else if (type === 'adjust-game') {
      const key = side === 'blue' ? 'blueGames' : 'orangeGames';
      next = { ...current, [key]: clampInt(current[key] + delta, 0, 99, current[key]) };
    } else if (type === 'reset-series') {
      next = {
        ...current,
        blueGames: 0,
        orangeGames: 0,
        countedMatchIds: []
      };
    } else if (type === 'reset-all') {
      next = normalizeSeriesState({ bestOf: current.bestOf, autoAddGames: current.autoAddGames });
    } else if (type === 'swap-sides') {
      config = normalizeConfig({
        ...config,
        blueTeam: config.orangeTeam,
        orangeTeam: config.blueTeam
      });
      next = {
        ...current,
        blueGames: current.orangeGames,
        orangeGames: current.blueGames,
        blueGoalAdjust: current.orangeGoalAdjust,
        orangeGoalAdjust: current.blueGoalAdjust,
        sidesSwapped: !current.sidesSwapped
      };
    } else {
      return snapshot();
    }

    seriesState = normalizeSeriesState(next);
    saveStore();
    return emitUpdate();
  }

  function processMatchEnded(payload) {
    const matchGuid = readMatchGuid(payload) || currentMatch?.matchGuid || `temp-${Date.now()}`;
    if (dailyStats.countedMatchIds.includes(matchGuid)) return;

    const winnerTeamNum = Number(payload.WinnerTeamNum ?? payload.Game?.WinnerTeamNum ?? payload.Game?.Winner);
    const playerTeamNum = Number(currentPlayer?.TeamNum ?? currentMatch?.playerTeamNum);
    const finalScoreboard = buildScoreboardState();
    let result;
    if (Number.isFinite(winnerTeamNum) && Number.isFinite(playerTeamNum)) {
      const won = winnerTeamNum === playerTeamNum;
      result = won ? 'WIN' : 'LOSS';
      dailyStats.matchesPlayed += 1;
      dailyStats.wins += won ? 1 : 0;
      dailyStats.losses += won ? 0 : 1;
      dailyStats.currentStreak = dailyStats.currentStreakType === (won ? 'W' : 'L') ? dailyStats.currentStreak + 1 : 1;
      dailyStats.currentStreakType = won ? 'W' : 'L';
      dailyStats.lastResult = result;
      if (won) dailyStats.bestWinStreak = Math.max(numberOrZero(dailyStats.bestWinStreak), numberOrZero(dailyStats.currentStreak));
    }

    if (seriesState.autoAddGames) {
      let seriesWinner = Number.isFinite(winnerTeamNum)
        ? winnerTeamNum === 0
          ? (seriesState.sidesSwapped ? 'orange' : 'blue')
          : winnerTeamNum === 1
            ? (seriesState.sidesSwapped ? 'blue' : 'orange')
            : null
        : null;
      if (!seriesWinner) {
        seriesWinner = finalScoreboard.blueScore > finalScoreboard.orangeScore ? 'blue' : finalScoreboard.orangeScore > finalScoreboard.blueScore ? 'orange' : null;
      }
      if (seriesWinner) recordSeriesGameWinner(seriesWinner, matchGuid);
    }

    const playerStats = {
      goals: numberOrZero(currentPlayer?.Goals ?? currentAccumulator?.goals),
      assists: numberOrZero(currentPlayer?.Assists ?? currentAccumulator?.assists),
      saves: numberOrZero(currentPlayer?.Saves ?? currentAccumulator?.saves),
      shots: numberOrZero(currentPlayer?.Shots ?? currentAccumulator?.shots),
      demos: numberOrZero(currentPlayer?.Demos ?? currentAccumulator?.demos),
      score: numberOrZero(currentPlayer?.Score ?? currentAccumulator?.score)
    };
    const performance = summarizeAccumulator(currentAccumulator);
    dailyStats.goals += playerStats.goals;
    dailyStats.assists += playerStats.assists;
    dailyStats.saves += playerStats.saves;
    dailyStats.shots += playerStats.shots;
    dailyStats.demos += playerStats.demos;
    dailyStats.score += playerStats.score;
    dailyStats.performance = combinePerformance(dailyStats.performance, performance);
    dailyStats.countedMatchIds.push(matchGuid);
    dailyStats.countedMatchIds = dailyStats.countedMatchIds.slice(-250);
    matchHistory = [{
      id: matchGuid,
      date: new Date().toISOString(),
      arena: currentMatch?.arena,
      result,
      blueScore: finalScoreboard.blueScore ?? 0,
      orangeScore: finalScoreboard.orangeScore ?? 0,
      teams: {
        blue: finalScoreboard.blueTeam || currentMatch?.teams?.blue || config.blueTeam,
        orange: finalScoreboard.orangeTeam || currentMatch?.teams?.orange || config.orangeTeam,
      },
      playerTeamNum,
      winnerTeamNum,
      stats: playerStats,
      performance
    }, ...matchHistory].slice(0, 250);
    currentAccumulator = null;
    resetCurrentGoalAdjustments();
    saveStore();
  }

  function processEvent(event) {
    ensureDailyBoundary();
    const payload = getPayload(event);
    switch (event.type) {
      case 'UpdateState':
        processUpdateState(payload);
        break;
      case 'GoalScored':
        processGoalScored(payload);
        break;
      case 'ClockUpdatedSeconds':
        processClock(payload);
        break;
      case 'MatchEnded':
        processMatchEnded(payload);
        break;
      case 'MatchInitialized':
      case 'RoundStarted':
        setConnectionStatus('connected');
        if (!currentMatch) resetCurrentGoalAdjustments();
        currentAccumulator = currentAccumulator || createAccumulator(readMatchGuid(payload));
        currentMatch = currentMatch || { blueScore: 0, orangeScore: 0, isOvertime: false, startedAt: new Date().toISOString() };
        break;
      case 'MatchDestroyed':
        currentMatch = null;
        currentPlayer = null;
        currentAccumulator = null;
        resetCurrentGoalAdjustments();
        saveStore();
        setConnectionStatus('waiting-match');
        break;
      default:
        break;
    }
    lastEvents = [{ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ...event }, ...lastEvents].slice(0, 40);
    emitUpdate();
  }

  function handleRawMessage(raw) {
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
      const parsed = parseConcatenatedJsonMessages(text);
      const messages = parsed.messages.length ? parsed.messages : [text];
      for (const message of messages) {
        if (!message.trim()) continue;
        processEvent(parseEvent(JSON.parse(message)));
      }
    } catch (error) {
      log('warn', `Evento inválido de Rocket League: ${error?.message || error}`);
    }
  }

  function clearReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    if (config.autoConnectStatsApi === false) {
      closeStatsApi();
      setConnectionStatus('disconnected', { smoothTransient: true });
      emitUpdate();
      return;
    }
    setConnectionStatus('disconnected', { smoothTransient: true });
    emitUpdate();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectStatsApi({ force: false });
    }, RECONNECT_INTERVAL_MS);
  }

  function closeStatsApi() {
    clearReconnect();
    try {
      apiWs?.removeAllListeners?.();
      apiWs?.on?.('error', () => {});
    } catch {}
    try { apiWs?.terminate?.(); } catch {}
    apiWs = null;
    currentTransport = null;
  }

  function connectStatsApi(options = {}) {
    const force = options?.force === true;
    if (config.autoConnectStatsApi === false && !force) {
      closeStatsApi();
      setConnectionStatus('disconnected');
      emitUpdate();
      return;
    }
    const port = Number(config.statsApiPort || DEFAULT_CONFIG.statsApiPort);
    closeStatsApi();
    currentTransport = 'ws';
    setConnectionStatus('reconnecting', { smoothTransient: true });
    emitUpdate();
    logOnce('info', 'stats-api-connecting', `Conectando Stats API en ws://127.0.0.1:${port}`);

    try {
      apiWs = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      scheduleReconnect();
      return;
    }

    apiWs.on('open', () => {
      setConnectionStatus('waiting-match');
      emitUpdate();
      logOnce('info', 'stats-api-ws-connected', `Stats API WS conectada en ${port}`);
    });
    apiWs.on('message', handleRawMessage);
    apiWs.on('close', () => {
      scheduleReconnect();
    });
    apiWs.on('error', () => {
      scheduleReconnect();
    });
  }

  function startOverlayServer() {
    if (overlayServer) return;
    overlayServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', `http://localhost:${config.overlayPort}`);
      if (reqUrl.pathname === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(snapshot()));
        return;
      }
      const filePath = reqUrl.pathname === '/stats' ? statsOverlayPath : overlayPath;
      fs.readFile(filePath, (error, data) => {
        if (error) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Rocket League overlay no encontrado');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
    });
    overlayWss = new WebSocketServer({ server: overlayServer });
    overlayWss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'state', data: snapshot() }));
    });
    overlayServer.listen(config.overlayPort, '127.0.0.1', () => {
      log('info', `Overlay OBS activo en http://localhost:${config.overlayPort}/broadcast`);
      emitUpdate();
    });
    overlayServer.on('error', (error) => {
      log('error', `No se pudo levantar el overlay en ${config.overlayPort}: ${error?.message || error}`);
    });
  }

  function start() {
    if (started) {
      startOverlayServer();
      return snapshot();
    }
    started = true;
    loadStore();
    startOverlayServer();
    if (config.autoConnectStatsApi !== false) {
      connectStatsApi({ force: false });
    } else {
      setConnectionStatus('disconnected');
      emitUpdate();
    }
    return snapshot();
  }

  function setConfig(nextConfig = {}) {
    const prevStatsPort = Number(config.statsApiPort);
    const prevOverlayPort = Number(config.overlayPort);
    const prevAutoConnect = config.autoConnectStatsApi !== false;
    config = normalizeConfig({ ...config, ...nextConfig });
    saveStore();
    broadcast({ type: 'config', data: config });
    const nextAutoConnect = config.autoConnectStatsApi !== false;
    if (!nextAutoConnect) {
      closeStatsApi();
      setConnectionStatus('disconnected');
    } else if (Number(config.statsApiPort) !== prevStatsPort || !prevAutoConnect) {
      connectStatsApi({ force: false });
    }
    if (Number(config.overlayPort) !== prevOverlayPort) {
      log('warn', 'Cambio de puerto OBS requiere reiniciar la app para reabrir el servidor local.');
    }
    return emitUpdate();
  }

  function resetSession() {
    dailyStats = normalizeDaily({ date: dayKey() });
    saveStore();
    return emitUpdate();
  }

  // Limpia los datos de la partida en vivo (reloj, score del feed, jugadores, boost)
  // sin tocar la config (equipos, logos, colores) ni el estado de la serie.
  function clearLiveMatch() {
    currentMatch = null;
    currentPlayer = null;
    currentAccumulator = null;
    lastEvents = [];
    resetCurrentGoalAdjustments();
    saveStore();
    return emitUpdate();
  }

  function refresh() {
    connectStatsApi({ force: true });
    return snapshot();
  }

  function destroy() {
    started = false;
    closeStatsApi();
    clearConnectionStatusVisibilityTimer();
    try { overlayWss?.close?.(); } catch {}
    overlayWss = null;
    try { overlayServer?.close?.(); } catch {}
    overlayServer = null;
  }

  return {
    start,
    refresh,
    destroy,
    getStatus: () => ({
      running: !!overlayServer,
      connectionStatus: visibleConnectionStatus,
      rawConnectionStatus: connectionStatus,
      transport: currentTransport,
      autoConnectStatsApi: config.autoConnectStatsApi !== false,
      url: `http://localhost:${config.overlayPort}/broadcast`,
      statsUrl: `http://localhost:${config.overlayPort}/stats`,
      statsApiPort: config.statsApiPort,
      storePath
    }),
    getConfig: () => ({ config, state: snapshot(), stats: currentMatch, session: dailyStats, series: normalizeSeriesState(seriesState) }),
    setConfig,
    resetSession,
    clearLiveMatch,
    applySeriesAction,
    snapshot
  };
}

module.exports = { createRocketLeagueLiveService, DEFAULT_CONFIG };
