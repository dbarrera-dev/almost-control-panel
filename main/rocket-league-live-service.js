const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { WebSocket, WebSocketServer } = require('ws');

const DEFAULT_CONFIG = {
  playerName: '',
  primaryId: '',
  statsApiPort: 49123,
  autoConnectStatsApi: false,
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
const RECONNECT_INTERVAL_MS = 5000;
const ROCKET_LEAGUE_STATS_API_DISABLED = true;

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
    autoConnectStatsApi: false,
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

function normalizePlayerSession(session = {}) {
  return {
    key: String(session.key || ''),
    name: String(session.name || 'Unknown'),
    primaryId: String(session.primaryId || ''),
    teamNum: Number.isFinite(Number(session.teamNum)) ? Number(session.teamNum) : null,
    teamSide: session.teamSide === 'orange' ? 'orange' : session.teamSide === 'blue' ? 'blue' : '',
    dailyStats: normalizeDaily(session.dailyStats, session.dailyStats?.date || dayKey()),
    matchHistory: Array.isArray(session.matchHistory) ? session.matchHistory.slice(0, 250) : []
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
  return playerOrName.Name || playerOrName.name || playerOrName.PrimaryId || playerOrName.PrimaryID || playerOrName.primaryId || playerOrName.id || 'Unknown';
}

function playerKey(player) {
  const primaryId = String(player?.PrimaryId || player?.PrimaryID || player?.primaryId || player?.id || '').trim();
  if (primaryId) return `id:${primaryId.toLowerCase()}`;
  const name = readPlayerName(player).trim();
  return `name:${name.toLowerCase() || 'unknown'}`;
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
    const teamNum = firstFiniteNumber(player.TeamNum, player.Team, player.team, player.team_num);
    return {
      key: playerKey(player),
      name: readPlayerName(player),
      primaryId: String(player.PrimaryId || player.PrimaryID || player.primaryId || player.id || ''),
      teamNum,
      teamSide: teamNum === 0 ? 'blue' : teamNum === 1 ? 'orange' : '',
      boost: boost == null ? null : Math.max(0, Math.min(100, Math.round(boost))),
      score: numberOrZero(player.Score ?? player.score),
      goals: numberOrZero(player.Goals ?? player.goals),
      assists: numberOrZero(player.Assists ?? player.assists),
      saves: numberOrZero(player.Saves ?? player.saves),
      shots: numberOrZero(player.Shots ?? player.shots),
      demos: numberOrZero(player.Demos ?? player.demos),
      touches: numberOrZero(player.Touches ?? player.CarTouches ?? player.touches)
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
  let playerSessions = {};
  let currentAccumulator = null;
  let playerAccumulators = new Map();
  let currentMatch = null;
  let currentPlayer = null;
  let lastEvents = [];
  let connectionStatus = 'disconnected';
  let visibleConnectionStatus = 'disconnected';
  let overlayServer = null;
  let overlayWss = null;
  let apiWs = null;
  let apiTcp = null;
  let apiTcpBuffer = '';
  let wsFallbackTimer = null;
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
      playerSessions = Object.fromEntries(
        Object.entries(parsed.playerSessions || {}).map(([key, session]) => [key, normalizePlayerSession({ ...session, key })])
      );
    } catch (error) {
      log('warn', `No se pudo leer rocket-league-live.json: ${error?.message || error}`);
    }
  }

  function saveStore() {
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify({ config, dailyStats, seriesState, historyByDate, matchHistory, playerSessions }, null, 2));
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
      for (const [key, session] of Object.entries(playerSessions || {})) {
        const normalized = normalizePlayerSession(session);
        if (normalized.dailyStats.date !== dayKey()) {
          playerSessions[key] = normalizePlayerSession({
            ...normalized,
            dailyStats: { date: dayKey() }
          });
        }
      }
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

  function buildPerformanceChartsFor(stats = dailyStats, history = matchHistory, accumulator = currentAccumulator) {
    const daily = normalizeDaily(stats);
    return {
      boostTimeline: accumulator?.boostTimeline || [],
      speedTimeline: accumulator?.speedTimeline || [],
      matchTrend: [...history].reverse().slice(-20).map((match, index) => ({
        label: `P${index + 1}`,
        value: numberOrZero(match.stats?.score),
        secondary: numberOrZero(match.performance?.avgBoost),
        result: match.result
      })),
      statAverages: [
        { label: 'Goles', value: daily.matchesPlayed ? round(daily.goals / daily.matchesPlayed) : 0 },
        { label: 'Shots', value: daily.matchesPlayed ? round(daily.shots / daily.matchesPlayed) : 0 },
        { label: 'Saves', value: daily.matchesPlayed ? round(daily.saves / daily.matchesPlayed) : 0 },
        { label: 'Demos', value: daily.matchesPlayed ? round(daily.demos / daily.matchesPlayed) : 0 },
        { label: 'Touches/min', value: daily.performance.touchesPerMinute || 0 },
        { label: 'Boost score', value: daily.performance.boostDisciplineScore || 0 }
      ]
    };
  }

  function buildPerformanceCharts() {
    return buildPerformanceChartsFor(dailyStats, matchHistory, currentAccumulator);
  }

  function buildCoachInsightsFor(stats = dailyStats, livePerformance = currentMatch?.performance) {
    stats = normalizeDaily(stats);
    const perf = stats.performance?.trackedSeconds > 0 ? stats.performance : livePerformance || normalizePerformance();
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

  function buildCoachInsights() {
    return buildCoachInsightsFor(dailyStats, currentMatch?.performance);
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

  function buildPlayerStatsSnapshot(scoreboard = buildScoreboardState()) {
    const livePlayers = Array.isArray(currentMatch?.players) ? currentMatch.players : [];
    const byKey = new Map(Object.entries(playerSessions || {}).map(([key, session]) => [key, normalizePlayerSession({ ...session, key })]));
    for (const player of livePlayers) {
      const session = getPlayerSession(player);
      byKey.set(session.key, session);
    }
    const players = [...byKey.values()].map((session) => {
      const live = livePlayers.find((player) => player.key === session.key) || null;
      const accumulator = live ? playerAccumulators.get(session.key) || null : null;
      const livePerformance = accumulator ? summarizeAccumulator(accumulator) : null;
      const teamSide = live?.teamSide || session.teamSide;
      const teamName = teamSide === 'blue'
        ? scoreboard.blueTeam?.name
        : teamSide === 'orange'
          ? scoreboard.orangeTeam?.name
          : '';
      return {
        key: session.key,
        name: live?.name || session.name,
        primaryId: live?.primaryId || session.primaryId,
        teamNum: live?.teamNum ?? session.teamNum,
        teamSide,
        teamName,
        live,
        livePerformance,
        dailyStats: session.dailyStats,
        matchHistory: session.matchHistory,
        performanceCharts: buildPerformanceChartsFor(session.dailyStats, session.matchHistory, accumulator),
        coachInsights: buildCoachInsightsFor(session.dailyStats, livePerformance)
      };
    }).sort((a, b) => {
      const liveDelta = (b.live ? 1 : 0) - (a.live ? 1 : 0);
      if (liveDelta) return liveDelta;
      const teamDelta = numberOrZero(a.teamNum) - numberOrZero(b.teamNum);
      if (teamDelta) return teamDelta;
      return String(a.name).localeCompare(String(b.name));
    });
    const currentKey = currentPlayer ? playerKey(currentPlayer) : '';
    return {
      activeKey: players.some((player) => player.key === currentKey) ? currentKey : players[0]?.key || '',
      players
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
      playerStats: buildPlayerStatsSnapshot(scoreboard),
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
      players.find((player) => primaryId && String(player.PrimaryId || player.PrimaryID || player.primaryId || '').toLowerCase() === primaryId) ||
      players.find((player) => playerName && String(player.Name || '').toLowerCase() === playerName) ||
      players[0] ||
      null
    );
  }

  function getPlayerSession(player) {
    const key = player.key || playerKey(player);
    const existing = normalizePlayerSession(playerSessions[key] || { key });
    const teamNum = Number.isFinite(Number(player.teamNum ?? player.TeamNum ?? player.Team)) ? Number(player.teamNum ?? player.TeamNum ?? player.Team) : existing.teamNum;
    const session = normalizePlayerSession({
      ...existing,
      key,
      name: readPlayerName(player) || existing.name,
      primaryId: String(player.primaryId || player.PrimaryId || player.PrimaryID || existing.primaryId || ''),
      teamNum,
      teamSide: teamNum === 0 ? 'blue' : teamNum === 1 ? 'orange' : existing.teamSide
    });
    playerSessions[key] = session;
    return session;
  }

  function getPlayerAccumulator(player, matchGuid) {
    const key = player.key || playerKey(player);
    const existing = playerAccumulators.get(key);
    if (!existing || (matchGuid && existing.id && existing.id !== matchGuid)) {
      const next = createAccumulator(matchGuid);
      playerAccumulators.set(key, next);
      return next;
    }
    if (matchGuid && !existing.id) existing.id = matchGuid;
    return existing;
  }

  function updateAccumulatorFromPlayer(accumulator, player) {
    if (!player || !accumulator) return;
    const now = Date.now();
    const delta = clampDelta(accumulator.lastWallTime ? (now - accumulator.lastWallTime) / 1000 : 0);
    accumulator.lastWallTime = now;
    const boost = firstFiniteNumber(player.Boost, player.boost) ?? 0;
    const speed = firstFiniteNumber(player.Speed, player.speed) ?? 0;
    accumulator.duration += delta;
    accumulator.boostWeighted += boost * delta;
    accumulator.speedWeighted += speed * delta;
    accumulator.minBoost = Math.min(accumulator.minBoost, boost);
    accumulator.zeroBoostSeconds += boost <= 0 ? delta : 0;
    accumulator.lowBoostSeconds += boost <= LOW_BOOST_THRESHOLD ? delta : 0;
    accumulator.supersonicSeconds += bool(player.bSupersonic) || speed >= SUPERSONIC_SPEED ? delta : 0;
    accumulator.groundSeconds += bool(player.bOnGround) ? delta : 0;
    accumulator.wallSeconds += bool(player.bOnWall) ? delta : 0;
    accumulator.powerslideSeconds += bool(player.bPowersliding) ? delta : 0;
    accumulator.demolishedSeconds += bool(player.bDemolished) ? delta : 0;
    accumulator.boostWhileSupersonicSeconds += bool(player.bBoosting) && (bool(player.bSupersonic) || speed >= SUPERSONIC_SPEED) ? delta : 0;
    accumulator.touches = Math.max(accumulator.touches, numberOrZero(player.Touches ?? player.CarTouches ?? player.touches));
    accumulator.carTouches = Math.max(accumulator.carTouches, numberOrZero(player.CarTouches ?? player.touches));
    accumulator.score = numberOrZero(player.Score ?? player.score);
    accumulator.goals = numberOrZero(player.Goals ?? player.goals);
    accumulator.assists = numberOrZero(player.Assists ?? player.assists);
    accumulator.saves = numberOrZero(player.Saves ?? player.saves);
    accumulator.shots = numberOrZero(player.Shots ?? player.shots);
    accumulator.demos = numberOrZero(player.Demos ?? player.demos);
    const label = labelFromSeconds(accumulator.duration);
    pushTimelinePoint(accumulator.boostTimeline, { label, value: Math.round(boost) });
    pushTimelinePoint(accumulator.speedTimeline, { label, value: Math.round(speed) });
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
    for (const player of players) {
      getPlayerSession(player);
      updateAccumulatorFromPlayer(getPlayerAccumulator(player, matchGuid), player);
    }
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
    updateAccumulatorFromPlayer(currentAccumulator, player);
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

  function addPlayerMatchResult(player, matchGuid, finalScoreboard, winnerTeamNum) {
    if (!player || !matchGuid) return;
    const session = getPlayerSession(player);
    if (session.dailyStats.countedMatchIds.includes(matchGuid)) return;
    const teamNum = Number(player.teamNum);
    const result = Number.isFinite(winnerTeamNum) && Number.isFinite(teamNum)
      ? winnerTeamNum === teamNum ? 'WIN' : 'LOSS'
      : undefined;
    const playerStats = {
      goals: numberOrZero(player.goals),
      assists: numberOrZero(player.assists),
      saves: numberOrZero(player.saves),
      shots: numberOrZero(player.shots),
      demos: numberOrZero(player.demos),
      score: numberOrZero(player.score)
    };
    const performance = summarizeAccumulator(playerAccumulators.get(session.key));
    const daily = normalizeDaily(session.dailyStats);
    daily.matchesPlayed += 1;
    if (result === 'WIN' || result === 'LOSS') {
      const won = result === 'WIN';
      daily.wins += won ? 1 : 0;
      daily.losses += won ? 0 : 1;
      daily.currentStreak = daily.currentStreakType === (won ? 'W' : 'L') ? daily.currentStreak + 1 : 1;
      daily.currentStreakType = won ? 'W' : 'L';
      daily.lastResult = result;
      if (won) daily.bestWinStreak = Math.max(numberOrZero(daily.bestWinStreak), numberOrZero(daily.currentStreak));
    }
    daily.goals += playerStats.goals;
    daily.assists += playerStats.assists;
    daily.saves += playerStats.saves;
    daily.shots += playerStats.shots;
    daily.demos += playerStats.demos;
    daily.score += playerStats.score;
    daily.performance = combinePerformance(daily.performance, performance);
    daily.countedMatchIds.push(matchGuid);
    daily.countedMatchIds = daily.countedMatchIds.slice(-250);
    playerSessions[session.key] = normalizePlayerSession({
      ...session,
      name: player.name || session.name,
      primaryId: player.primaryId || session.primaryId,
      teamNum: Number.isFinite(teamNum) ? teamNum : session.teamNum,
      teamSide: player.teamSide || session.teamSide,
      dailyStats: daily,
      matchHistory: [{
        id: matchGuid,
        date: new Date().toISOString(),
        arena: currentMatch?.arena,
        result,
        blueScore: finalScoreboard.blueScore ?? 0,
        orangeScore: finalScoreboard.orangeScore ?? 0,
        playerName: player.name || session.name,
        playerTeamNum: Number.isFinite(teamNum) ? teamNum : null,
        winnerTeamNum,
        stats: playerStats,
        performance
      }, ...session.matchHistory].slice(0, 250)
    });
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
    for (const player of Array.isArray(currentMatch?.players) ? currentMatch.players : []) {
      addPlayerMatchResult(player, matchGuid, finalScoreboard, winnerTeamNum);
    }
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
    playerAccumulators = new Map();
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
        playerAccumulators = new Map();
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

  function clearWsFallbackTimer() {
    if (wsFallbackTimer) clearTimeout(wsFallbackTimer);
    wsFallbackTimer = null;
  }

  function scheduleReconnect() {
    if (ROCKET_LEAGUE_STATS_API_DISABLED) {
      closeStatsApi();
      setConnectionStatus('disconnected', { smoothTransient: true });
      emitUpdate();
      return;
    }
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

  function closeStatsApiWs() {
    clearWsFallbackTimer();
    try {
      apiWs?.removeAllListeners?.();
      apiWs?.on?.('error', () => {});
      apiWs?.on?.('close', () => {});
    } catch {}
    try { apiWs?.terminate?.(); } catch {}
    apiWs = null;
  }

  function closeStatsApiTcp() {
    try {
      apiTcp?.removeAllListeners?.();
      apiTcp?.on?.('error', () => {});
      apiTcp?.on?.('close', () => {});
    } catch {}
    try { apiTcp?.destroy?.(); } catch {}
    apiTcp = null;
    apiTcpBuffer = '';
  }

  function closeStatsApi() {
    clearReconnect();
    closeStatsApiWs();
    closeStatsApiTcp();
    currentTransport = null;
  }

  function connectStatsApiTcp(port) {
    closeStatsApiWs();
    closeStatsApiTcp();
    currentTransport = 'tcp';
    setConnectionStatus('reconnecting', { smoothTransient: true });
    emitUpdate();
    logOnce('info', 'stats-api-tcp-connecting', `Conectando Stats API en TCP 127.0.0.1:${port}`);

    try {
      apiTcp = net.createConnection({ host: '127.0.0.1', port });
    } catch {
      scheduleReconnect();
      return;
    }

    apiTcp.on('connect', () => {
      setConnectionStatus('waiting-match');
      emitUpdate();
      logOnce('info', 'stats-api-tcp-connected', `Stats API TCP conectada en ${port}`);
    });

    apiTcp.on('data', (chunk) => {
      apiTcpBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const parsed = parseConcatenatedJsonMessages(apiTcpBuffer);
      apiTcpBuffer = parsed.leftover || '';
      for (const message of parsed.messages) handleRawMessage(message);
    });

    apiTcp.on('close', () => {
      if (currentTransport !== 'tcp') return;
      closeStatsApiTcp();
      currentTransport = null;
      scheduleReconnect();
    });

    apiTcp.on('error', () => {
      if (currentTransport !== 'tcp') return;
      closeStatsApiTcp();
      currentTransport = null;
      scheduleReconnect();
    });
  }

  function connectStatsApi(options = {}) {
    if (ROCKET_LEAGUE_STATS_API_DISABLED) {
      closeStatsApi();
      setConnectionStatus('disconnected');
      emitUpdate();
      return;
    }
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

    wsFallbackTimer = setTimeout(() => {
      if (apiWs?.readyState === WebSocket.OPEN) return;
      connectStatsApiTcp(port);
    }, 1500);

    try {
      apiWs = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      connectStatsApiTcp(port);
      return;
    }

    apiWs.on('open', () => {
      clearWsFallbackTimer();
      setConnectionStatus('waiting-match');
      emitUpdate();
      logOnce('info', 'stats-api-ws-connected', `Stats API WS conectada en ${port}`);
    });
    apiWs.on('message', handleRawMessage);
    apiWs.on('close', () => {
      clearWsFallbackTimer();
      if (currentTransport === 'ws') connectStatsApiTcp(port);
    });
    apiWs.on('error', () => {
      clearWsFallbackTimer();
      if (currentTransport === 'ws') connectStatsApiTcp(port);
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
    if (!ROCKET_LEAGUE_STATS_API_DISABLED && config.autoConnectStatsApi !== false) {
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
    config = normalizeConfig({ ...config, ...nextConfig });
    saveStore();
    broadcast({ type: 'config', data: config });
    if (ROCKET_LEAGUE_STATS_API_DISABLED) {
      closeStatsApi();
      setConnectionStatus('disconnected');
    } else if (Number(config.statsApiPort) !== prevStatsPort) {
      connectStatsApi({ force: false });
    }
    if (Number(config.overlayPort) !== prevOverlayPort) {
      log('warn', 'Cambio de puerto OBS requiere reiniciar la app para reabrir el servidor local.');
    }
    return emitUpdate();
  }

  function resetSession() {
    dailyStats = normalizeDaily({ date: dayKey() });
    playerSessions = {};
    playerAccumulators = new Map();
    saveStore();
    return emitUpdate();
  }

  // Limpia los datos de la partida en vivo (reloj, score del feed, jugadores, boost)
  // sin tocar la config (equipos, logos, colores) ni el estado de la serie.
  function clearLiveMatch() {
    currentMatch = null;
    currentPlayer = null;
    currentAccumulator = null;
    playerAccumulators = new Map();
    lastEvents = [];
    resetCurrentGoalAdjustments();
    saveStore();
    return emitUpdate();
  }

  function refresh() {
    closeStatsApi();
    setConnectionStatus('disconnected');
    emitUpdate();
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
      autoConnectStatsApi: false,
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
