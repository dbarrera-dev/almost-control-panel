const {
  normalizeKickChannel,
  resolveKickRouting,
  getActiveSongRequestRewardId,
  getKickCreds,
  setKickCred,
  getKickBroadcasterRowId,
  getKickBotRowId,
} = require('./kick-utils');

function createKickService({ loadConfig, saveConfig, httpsRequest, saveLog, state, processQueue }) {
  const KICK_REDEMPTION_DEDUPE_MS = 2 * 60 * 1000;
  const KICK_REDEMPTION_ID_DEDUPE_MS = 24 * 60 * 60 * 1000;
  const KICK_CHAT_DEDUPE_MS = 2 * 60 * 1000;
  const KICK_CHAT_EVENT_ID_DEDUPE_MS = 12 * 60 * 60 * 1000;
  const KICK_POLL_INTERVAL_MS = 650;
  const KICK_ROW_DEDUPE_MS = 60 * 1000;
  const KICK_EVENT_LIVE_SKEW_MS = 7000;
  const KICK_TOKEN_REFRESH_INTERVAL_MS = 25 * 60 * 1000;
  const KICK_SUBS_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
  const KICK_TOKEN_EXP_SKEW_MS = 2 * 60 * 1000;
  const KICK_REFRESH_FAIL_BASE_BACKOFF_MS = 60 * 1000;
  const KICK_REFRESH_FAIL_MAX_BACKOFF_MS = 15 * 60 * 1000;
  const KICK_SCOPE_WARN_COOLDOWN_MS = 10 * 60 * 1000;
  const KICK_REQUIRED_BROADCASTER_SCOPES = [
    'events:subscribe',
    'channel:read',
  ];
  const KICK_BROADCASTER_REWARD_SCOPE_ANY = ['channel:rewards:read', 'channel:rewards:write'];
  const KICK_OPTIONAL_BROADCASTER_SCOPES = [];
  const KICK_REQUIRED_BOT_SCOPES = ['chat:write'];
  const KICK_REQUIRED_EVENTS = [
    { name: 'chat.message.sent', version: 1 },
    { name: 'channel.reward.redemption.updated', version: 1 },
    { name: 'channel.subscription.new', version: 1 },
    { name: 'channel.subscription.renewal', version: 1 },
    { name: 'channel.subscription.gifts', version: 1 },
  ];
  const KICK_REQUIRED_EVENT_SET = new Set(KICK_REQUIRED_EVENTS.map((evt) => evt.name));
  const recentKickRedemptions = new Map();
  const recentKickRedemptionIds = new Map();
  const recentKickChatEvents = new Map();
  const recentKickChatEventIds = new Map();
  const recentlyProcessedKickRowIds = new Map();
  let kickPollInFlight = false;
  let kickPollLastOkAt = 0;
  let kickPollConsecutiveErrors = 0;
  let kickRealtimeChannel = null;
  let kickRealtimeStatus = 'CLOSED';
  let kickRealtimeRetryTimer = null;
  let kickRealtimeLastWarnStatus = '';
  let kickRealtimeLastWarnAt = 0;
  let kickRuntimeMode = null;
  let kickHealthTimer = null;
  let kickLastTokenRefreshAt = 0;
  let kickLastSubsReconcileAt = 0;
  let kickHealthInFlight = false;
  let kickBroadcasterRefreshFailCount = 0;
  let kickBotRefreshFailCount = 0;
  let kickNextBroadcasterRefreshAt = 0;
  let kickNextBotRefreshAt = 0;
  let kickLastScopeWarnAt = 0;
  let kickEventsLiveSinceMs = 0;
  let kickCommandsAcceptSinceMs = 0;
  const kickRefreshInFlight = new Map();
  let kickSubsStorageDisabled = false;
  let kickSubsStorageWarned = false;
  let kickSubsReconcileSoonTimer = null;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseScopeSet(rawScope) {
    const parts = String(rawScope || '')
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean);
    return new Set(parts);
  }

  function hasAllScopes(scopeSet, requiredScopes) {
    return requiredScopes.every((scope) => scopeSet.has(scope));
  }

  function missingScopesFromSet(scopeSet, requiredScopes) {
    return requiredScopes.filter((scope) => !scopeSet.has(scope));
  }

  function hasAnyScope(scopeSet, scopes) {
    return scopes.some((scope) => scopeSet.has(scope));
  }

  function missingBroadcasterScopes(scopeSet) {
    const missing = missingScopesFromSet(scopeSet, KICK_REQUIRED_BROADCASTER_SCOPES);
    if (!hasAnyScope(scopeSet, KICK_BROADCASTER_REWARD_SCOPE_ANY)) {
      missing.push('channel:rewards:read|channel:rewards:write');
    }
    return missing;
  }

  function computeRefreshBackoffMs(failCount) {
    const safeCount = Math.max(1, Number(failCount) || 1);
    const ms = KICK_REFRESH_FAIL_BASE_BACKOFF_MS * Math.pow(2, safeCount - 1);
    return Math.min(ms, KICK_REFRESH_FAIL_MAX_BACKOFF_MS);
  }

  function markTokenRefreshOutcome(kind, ok) {
    const isBot = kind === 'bot';
    if (ok) {
      if (isBot) {
        kickBotRefreshFailCount = 0;
        kickNextBotRefreshAt = 0;
      } else {
        kickBroadcasterRefreshFailCount = 0;
        kickNextBroadcasterRefreshAt = 0;
      }
      return;
    }
    if (isBot) {
      kickBotRefreshFailCount += 1;
      kickNextBotRefreshAt = Date.now() + computeRefreshBackoffMs(kickBotRefreshFailCount);
      return;
    }
    kickBroadcasterRefreshFailCount += 1;
    kickNextBroadcasterRefreshAt = Date.now() + computeRefreshBackoffMs(kickBroadcasterRefreshFailCount);
  }

  function tokenRefreshAllowed(kind) {
    const now = Date.now();
    if (kind === 'bot') return now >= kickNextBotRefreshAt;
    return now >= kickNextBroadcasterRefreshAt;
  }

  async function kickTokenIntrospect(token) {
    const bearer = String(token || '').trim();
    if (!bearer) {
      return { ok: false, status: 0, active: false, expMs: 0, scopes: new Set() };
    }
    const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token/introspect', {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
    }, null);
    const payload = (r?.data && typeof r.data === 'object') ? (r.data.data || {}) : {};
    const expSec = Number(payload?.exp || 0);
    const expMs = Number.isFinite(expSec) && expSec > 0 ? expSec * 1000 : 0;
    const scopes = parseScopeSet(payload?.scope || '');
    return {
      ok: Number(r?.status || 0) === 200,
      status: Number(r?.status || 0),
      active: !!payload?.active,
      expMs,
      scopes,
    };
  }

  async function kickApiRequest(method, endpoint, body, token) {
    const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Type'] = 'application/json';
    return httpsRequest(method, 'api.kick.com', endpoint, headers, bodyStr);
  }

  async function kickApiRequestWithRetry(method, endpoint, body, token, options = {}) {
    const retries = Number.isInteger(options?.retries) ? Math.max(0, options.retries) : 2;
    const baseDelayMs = Number.isFinite(options?.baseDelayMs) ? Math.max(150, Number(options.baseDelayMs)) : 450;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const response = await kickApiRequest(method, endpoint, body, token);
      const status = Number(response?.status || 0);
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt >= retries) return response;
      const retryAfterHeader = response?.headers?.['retry-after'] || response?.headers?.['Retry-After'] || '';
      let retryAfterMs = 0;
      const retryAfterNum = Number(retryAfterHeader);
      if (Number.isFinite(retryAfterNum) && retryAfterNum > 0) {
        retryAfterMs = retryAfterNum * 1000;
      } else if (typeof retryAfterHeader === 'string' && retryAfterHeader.trim()) {
        const retryAt = Date.parse(retryAfterHeader);
        if (Number.isFinite(retryAt)) {
          retryAfterMs = Math.max(0, retryAt - Date.now());
        }
      }
      if (!retryAfterMs) {
        retryAfterMs = baseDelayMs * Math.pow(2, attempt);
      }
      const jitter = Math.floor(Math.random() * 180);
      await sleep(Math.min(retryAfterMs + jitter, 8000));
    }
    return { status: 0, data: { message: 'Kick retry exhausted' } };
  }

  function cfgForMode(modeOverride) {
    const cfg = loadConfig();
    if (modeOverride === 'dev' || modeOverride === 'prod') {
      return { ...cfg, kickBotMode: modeOverride };
    }
    if (kickRuntimeMode === 'dev' || kickRuntimeMode === 'prod') {
      return { ...cfg, kickBotMode: kickRuntimeMode };
    }
    return cfg;
  }

  function resolveKickMode(modeOverride = null) {
    if (modeOverride === 'dev' || modeOverride === 'prod') return modeOverride;
    const cfg = cfgForMode(null);
    return cfg?.kickBotMode === 'dev' ? 'dev' : 'prod';
  }

  function refreshFlightKey(kind, modeOverride = null) {
    const mode = resolveKickMode(modeOverride);
    return `${mode}:${kind}`;
  }

  async function runRefreshSingleFlight(kind, modeOverride, fn) {
    const key = refreshFlightKey(kind, modeOverride);
    const existing = kickRefreshInFlight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        return await fn();
      } finally {
        kickRefreshInFlight.delete(key);
      }
    })();
    kickRefreshInFlight.set(key, promise);
    return promise;
  }

  function stripKickFieldsFromCfg(cfg) {
    const out = { ...cfg };
    const fields = [
      'kickClientId',
      'kickClientSecret',
      'kickChannel',
      'kickChatroomId',
      'kickAccessToken',
      'kickRefreshToken',
      'kickBotAccessToken',
      'kickBotRefreshToken',
      'kickSongRequestRewardId',
      'kickClientIdDev',
      'kickClientSecretDev',
      'kickDevChannel',
      'kickChatroomIdDev',
      'kickAccessTokenDev',
      'kickRefreshTokenDev',
      'kickBotAccessTokenDev',
      'kickBotRefreshTokenDev',
      'kickSongRequestRewardIdDev',
      'songRequestRewardId',
    ];
    for (const field of fields) out[field] = '';
    return out;
  }

  function applyKickBroadcasterRowToCfg(cfg, row) {
    if (!row || typeof row !== 'object') return;
    if (row.client_id !== undefined && row.client_id !== null) {
      setKickCred(cfg, 'clientId', String(row.client_id || '').trim());
    }
    if (row.client_secret !== undefined && row.client_secret !== null) {
      setKickCred(cfg, 'clientSecret', String(row.client_secret || '').trim());
    }
    if (row.channel !== undefined && row.channel !== null) {
      setKickCred(cfg, 'channel', String(row.channel || '').trim());
    }
    if (row.chatroom_id !== undefined && row.chatroom_id !== null) {
      setKickCred(cfg, 'chatroomId', String(row.chatroom_id || '').trim());
    }
    if (row.access_token !== undefined && row.access_token !== null) {
      setKickCred(cfg, 'accessToken', String(row.access_token || '').trim());
    }
    if (row.refresh_token !== undefined && row.refresh_token !== null) {
      setKickCred(cfg, 'refreshToken', String(row.refresh_token || '').trim());
    }
    if (row.reward_id !== undefined && row.reward_id !== null) {
      setKickCred(cfg, 'rewardId', String(row.reward_id || '').trim());
    }
  }

  function applyKickBotRowToCfg(cfg, row) {
    if (!row || typeof row !== 'object') return;
    if (row.access_token !== undefined && row.access_token !== null) {
      setKickCred(cfg, 'botAccessToken', String(row.access_token || '').trim());
    }
    if (row.refresh_token !== undefined && row.refresh_token !== null) {
      setKickCred(cfg, 'botRefreshToken', String(row.refresh_token || '').trim());
    }
  }

  async function loadKickContext(modeOverride = null) {
    const baseCfg = cfgForMode(modeOverride);
    if (!state.supabase) {
      const emptyCfg = stripKickFieldsFromCfg(baseCfg);
      return {
        ok: false,
        error: 'Sin conexión a Supabase',
        cfg: emptyCfg,
        creds: getKickCreds(emptyCfg),
        broadcasterRow: null,
        botRow: null,
      };
    }
    try {
      const broadcasterRowId = getKickBroadcasterRowId(baseCfg);
      const botRowId = getKickBotRowId(baseCfg);
      const [bRes, botRes] = await Promise.all([
        state.supabase.from('kick_tokens').select('*').eq('id', broadcasterRowId).maybeSingle(),
        state.supabase.from('kick_tokens').select('*').eq('id', botRowId).maybeSingle(),
      ]);
      const broadcasterRow = bRes?.data || null;
      const botRow = botRes?.data || null;
      const cfg = { ...baseCfg };
      applyKickBroadcasterRowToCfg(cfg, broadcasterRow);
      applyKickBotRowToCfg(cfg, botRow);
      return {
        ok: true,
        cfg,
        creds: getKickCreds(cfg),
        broadcasterRow,
        botRow,
      };
    } catch (e) {
      const emptyCfg = stripKickFieldsFromCfg(baseCfg);
      return {
        ok: false,
        error: e?.message || String(e),
        cfg: emptyCfg,
        creds: getKickCreds(emptyCfg),
        broadcasterRow: null,
        botRow: null,
      };
    }
  }

  async function doKickRefreshAccessToken(modeOverride = null, options = {}) {
    const silent = options?.silent === true;
    const ctx = await loadKickContext(modeOverride);
    if (!ctx.ok) {
      if (!silent) {
        saveLog('warn', `Kick refresh broadcaster: sin contexto (${ctx.error || 'desconocido'})`);
      }
      return null;
    }
    const cfg = ctx.cfg;
    const creds = ctx.creds;
    if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) return null;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret
    }).toString();
    const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (r.data?.access_token) {
      state.kickAccessToken = r.data.access_token;
      if (state.supabase) {
        const upd = { id: getKickBroadcasterRowId(cfg), access_token: r.data.access_token, updated_at: new Date().toISOString() };
        if (r.data.refresh_token) upd.refresh_token = r.data.refresh_token;
        try {
          await state.supabase.from('kick_tokens').upsert(upd);
        } catch (e) {
          if (!silent) saveLog('warn', `Kick refresh broadcaster: no pude guardar token en Supabase (${e?.message || e})`);
        }
      }
      return r.data.access_token;
    }
    if (!silent) {
      const detail = r?.data?.message || r?.data?.error_description || r?.data?.error || 'sin detalle';
      saveLog('warn', `Kick refresh broadcaster falló (status=${r?.status || 0}): ${detail}`);
    }
    return null;
  }

  async function kickRefreshAccessToken(modeOverride = null, options = {}) {
    return runRefreshSingleFlight('broadcaster', modeOverride, () =>
      doKickRefreshAccessToken(modeOverride, options)
    );
  }

  async function doKickRefreshBotToken(modeOverride = null, options = {}) {
    const silent = options?.silent === true;
    const ctx = await loadKickContext(modeOverride);
    if (!ctx.ok) {
      if (!silent) {
        saveLog('warn', `Kick refresh bot: sin contexto (${ctx.error || 'desconocido'})`);
      }
      return null;
    }
    const cfg = ctx.cfg;
    const creds = ctx.creds;
    if (!creds.botRefreshToken || !creds.clientId || !creds.clientSecret) return null;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.botRefreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret
    }).toString();
    const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (r.data?.access_token) {
      state.kickBotAccessToken = r.data.access_token;
      if (state.supabase) {
        const upd = { id: getKickBotRowId(cfg), access_token: r.data.access_token, updated_at: new Date().toISOString() };
        if (r.data.refresh_token) upd.refresh_token = r.data.refresh_token;
        try {
          await state.supabase.from('kick_tokens').upsert(upd);
        } catch (e) {
          if (!silent) saveLog('warn', `Kick refresh bot: no pude guardar token en Supabase (${e?.message || e})`);
        }
      }
      return r.data.access_token;
    }
    if (!silent) {
      const detail = r?.data?.message || r?.data?.error_description || r?.data?.error || 'sin detalle';
      saveLog('warn', `Kick refresh bot falló (status=${r?.status || 0}): ${detail}`);
    }
    return null;
  }

  async function kickRefreshBotToken(modeOverride = null, options = {}) {
    return runRefreshSingleFlight('bot', modeOverride, () =>
      doKickRefreshBotToken(modeOverride, options)
    );
  }

  async function ensureKickTokenUsable({
    kind = 'broadcaster',
    token,
    modeOverride = null,
    requiredScopes = [],
    silent = false,
  }) {
    let usableToken = String(token || '').trim();
    if (!usableToken) return { ok: false, token: '', reason: 'missing_token', scopes: new Set() };

    const refreshFn = kind === 'bot' ? kickRefreshBotToken : kickRefreshAccessToken;
    let introspection = await kickTokenIntrospect(usableToken);
    let isActive = introspection.ok && introspection.active;
    const expMs = Number(introspection.expMs || 0);
    const expiresSoon = expMs > 0 && expMs <= (Date.now() + KICK_TOKEN_EXP_SKEW_MS);
    let scopes = introspection.scopes || new Set();
    let scopesOk = hasAllScopes(scopes, requiredScopes);

    if (!isActive || expiresSoon || !scopesOk || introspection.status === 401) {
      const refreshed = await refreshFn(modeOverride, { silent: true });
      if (refreshed) {
        usableToken = refreshed;
        introspection = await kickTokenIntrospect(usableToken);
        isActive = introspection.ok && introspection.active;
        scopes = introspection.scopes || new Set();
        scopesOk = hasAllScopes(scopes, requiredScopes);
      }
    }

    if (!isActive) {
      if (!silent) {
        saveLog('warn', `Kick ${kind}: token inactivo o inválido (status introspect=${introspection.status || 0}).`);
      }
      return { ok: false, token: '', reason: 'inactive_token', scopes };
    }

    if (!scopesOk) {
      const now = Date.now();
      const missing = requiredScopes.filter((scope) => !scopes.has(scope));
      if (!silent || (now - kickLastScopeWarnAt) >= KICK_SCOPE_WARN_COOLDOWN_MS) {
        saveLog('warn', `Kick ${kind}: faltan scopes requeridos (${missing.join(', ') || 'desconocido'}).`);
        kickLastScopeWarnAt = now;
      }
      return { ok: false, token: usableToken, reason: 'missing_scope', scopes, missingScopes: missing };
    }

    return { ok: true, token: usableToken, scopes };
  }

  async function kickChatSend(message) {
    let token = state.kickBotAccessToken;
    if (!token) {
      const ctx = await loadKickContext(kickRuntimeMode);
      token = ctx.creds.botAccessToken;
      if (token) state.kickBotAccessToken = token;
    }

    const sendChat = async (t, type) => {
      const payload = { content: message, type };
      if (type === 'user' && state.kickChannelId) payload.broadcaster_user_id = Number(state.kickChannelId) || state.kickChannelId;
      return kickApiRequestWithRetry('POST', '/public/v1/chat', payload, t, { retries: 0, baseDelayMs: 350 });
    };

    if (!token) {
      saveLog('warn', 'Kick chat: no hay token de bot disponible. El mensaje no se envía con broadcaster para mantener identidad de bot.');
      return { ok: false, status: 503, via: 'bot', error: 'Sin token bot' };
    }

    // Responder siempre como "user" usando el token BOT (más estable en algunos canales).
    let r = await sendChat(token, 'user');
    if (r.status === 401) {
      token = await kickRefreshBotToken(kickRuntimeMode);
      if (token) {
        state.kickBotAccessToken = token;
        r = await sendChat(token, 'user');
      }
    }
    if (r.status === 200) {
      return { ok: true, status: 200, via: 'bot:user' };
    }

    if (r.status === 403) {
      saveLog('warn', 'Kick chat error 403 con token bot (sin permisos o canal no asociado).');
    } else if (r.status === 429) {
      saveLog('warn', 'Kick chat en rate limit con token bot.');
    } else if (r.status >= 500 || r.status === 0) {
      saveLog('warn', `Kick chat error ${r.status} con token bot.`);
    } else {
      saveLog('warn', `Kick chat error ${r.status}: ${JSON.stringify(r.data || {})}`);
    }
    return { ok: false, status: Number(r.status || 0), via: 'bot', error: JSON.stringify(r.data || {}) };
  }

  function normalizeKickCommandToken(message) {
    const token = String(message || '').trim().toLowerCase().split(/\s+/)[0] || '';
    return token.replace(/[.,!?;:]+$/g, '');
  }

  function processKickMessage(nick, content) {
    const msg = content.trim();
    const cmd = normalizeKickCommandToken(msg);
    const cmdCfg = (state.kickCommandConfig && typeof state.kickCommandConfig === 'object')
      ? state.kickCommandConfig
      : {};
    const enabled = (key) => cmdCfg[key] !== false;
    if (['!join', '!torneo', '!unirse'].includes(cmd)) {
      const parts = msg.split(/\s+/);
      state.queue.push({ nick, channel: '__kick__', action: 'join', gameNick: parts.length > 1 ? parts.slice(1).join(' ') : null });
    }
    if (['!salir', '!leave'].includes(cmd)) {
      state.queue.push({ nick, channel: '__kick__', action: 'leave' });
    }
    if (cmd === String(state.currentSorteoCmd || '!sorteo').toLowerCase()) {
      state.queue.push({ nick, channel: '__kick__', action: 'sorteo' });
    }
    if (enabled('song') && ['!song', '!cancion', '!musica', '!np', '!nowplaying'].includes(cmd)) {
      state.queue.push({ nick, channel: '__kick__', action: 'song' });
    }
    if (enabled('playlist') && cmd === '!playlist') {
      state.queue.push({ nick, channel: '__kick__', action: 'playlist' });
    }
    if (enabled('queue') && ['!lista', '!queue'].includes(cmd)) {
      state.queue.push({ nick, channel: '__kick__', action: 'queue' });
    }
    if (enabled('skip') && ['!skip', '!next', '!saltar'].includes(cmd)) {
      state.queue.push({ nick, channel: '__kick__', action: 'skip' });
    }
  }

  function clearPendingKickCommandQueue(reason = 'offline') {
    if (!Array.isArray(state.queue) || !state.queue.length) return 0;
    const before = state.queue.length;
    state.queue = state.queue.filter((item) => String(item?.channel || '') !== '__kick__');
    const dropped = before - state.queue.length;
    if (dropped > 0) {
      saveLog('warn', `Kick queue: descarté ${dropped} comandos pendientes (${reason})`);
    }
    return dropped;
  }

  function startKickPolling(modeOverride = null) {
    stopKickPolling();
    if (modeOverride === 'dev' || modeOverride === 'prod') {
      kickRuntimeMode = modeOverride;
    }
    kickLastTokenRefreshAt = 0;
    kickLastSubsReconcileAt = 0;
    clearPendingKickCommandQueue('reconexión');
    kickCommandsAcceptSinceMs = Date.now();
    kickEventsLiveSinceMs = Date.now() - KICK_EVENT_LIVE_SKEW_MS;
    startKickRealtime().catch(() => {});
    state.kickPollTimer = setInterval(pollKickEvents, KICK_POLL_INTERVAL_MS);
    kickHealthTimer = setInterval(() => {
      runKickHealthCycle(kickRuntimeMode).catch(() => {});
    }, 60 * 1000);
    pollKickEvents(); // primera ejecuciÃ³n inmediata
    runKickHealthCycle(kickRuntimeMode).catch(() => {});
  }

  function stopKickPolling() {
    stopKickRealtime().catch(() => {});
    if (state.kickPollTimer) { clearInterval(state.kickPollTimer); state.kickPollTimer = null; }
    if (kickHealthTimer) { clearInterval(kickHealthTimer); kickHealthTimer = null; }
    if (kickSubsReconcileSoonTimer) {
      clearTimeout(kickSubsReconcileSoonTimer);
      kickSubsReconcileSoonTimer = null;
    }
    kickRuntimeMode = null;
    kickLastTokenRefreshAt = 0;
    kickLastSubsReconcileAt = 0;
    kickBroadcasterRefreshFailCount = 0;
    kickBotRefreshFailCount = 0;
    kickNextBroadcasterRefreshAt = 0;
    kickNextBotRefreshAt = 0;
    kickEventsLiveSinceMs = 0;
    kickCommandsAcceptSinceMs = 0;
    clearPendingKickCommandQueue('bot desconectado');
  }

  function scheduleKickSubsReconcileSoon(delayMs = 20000, reason = 'rate-limit') {
    if (kickSubsReconcileSoonTimer) return;
    const waitMs = Math.max(5000, Math.min(120000, Number(delayMs) || 20000));
    kickSubsReconcileSoonTimer = setTimeout(() => {
      kickSubsReconcileSoonTimer = null;
      runKickHealthCycle(kickRuntimeMode).catch(() => {});
    }, waitMs);
    saveLog('warn', `Kick subscriptions: reintento automático en ${Math.round(waitMs / 1000)}s (${reason}).`);
  }

  function parseKickEventCreatedAtMs(row, payloadData) {
    const candidates = [
      payloadData?.created_at,
      payloadData?.createdAt,
      payloadData?.message?.created_at,
      payloadData?.message?.createdAt,
      row?.webhook_timestamp,
      row?.created_at,
      row?.createdAt,
    ];
    for (const value of candidates) {
      const raw = String(value || '').trim();
      if (!raw) continue;
      const ts = Date.parse(raw);
      if (Number.isFinite(ts)) return ts;
    }
    return 0;
  }

  function isKickEventStaleForLiveWindow(row, payloadData) {
    if (!kickEventsLiveSinceMs) return false;
    const createdMs = parseKickEventCreatedAtMs(row, payloadData);
    if (!createdMs) return false;
    return createdMs < kickEventsLiveSinceMs;
  }

  function isKickCommandEventBeforeConnection(row, payloadData) {
    if (!kickCommandsAcceptSinceMs) return true;
    const createdMs = parseKickEventCreatedAtMs(row, payloadData);
    if (!createdMs) return false;
    return createdMs < kickCommandsAcceptSinceMs;
  }

  function cleanupRecentKickRedemptions(nowTs = Date.now()) {
    for (const [key, ts] of recentKickRedemptions.entries()) {
      if ((nowTs - ts) > KICK_REDEMPTION_DEDUPE_MS) {
        recentKickRedemptions.delete(key);
      }
    }
  }

  function cleanupRecentKickRedemptionIds(nowTs = Date.now()) {
    for (const [key, ts] of recentKickRedemptionIds.entries()) {
      if ((nowTs - ts) > KICK_REDEMPTION_ID_DEDUPE_MS) {
        recentKickRedemptionIds.delete(key);
      }
    }
  }

  function isDuplicateKickRedemptionId(redemptionId) {
    const key = String(redemptionId || '').trim();
    if (!key) return false;
    const now = Date.now();
    cleanupRecentKickRedemptionIds(now);
    const prev = recentKickRedemptionIds.get(key);
    recentKickRedemptionIds.set(key, now);
    return !!prev && (now - prev) <= KICK_REDEMPTION_ID_DEDUPE_MS;
  }

  function isDuplicateKickRedemption(key) {
    if (!key) return false;
    const now = Date.now();
    cleanupRecentKickRedemptions(now);
    const prev = recentKickRedemptions.get(key);
    recentKickRedemptions.set(key, now);
    return !!prev && (now - prev) <= KICK_REDEMPTION_DEDUPE_MS;
  }

  function cleanupRecentKickChatEvents(nowTs = Date.now()) {
    for (const [key, ts] of recentKickChatEvents.entries()) {
      if ((nowTs - ts) > KICK_CHAT_DEDUPE_MS) {
        recentKickChatEvents.delete(key);
      }
    }
  }

  function cleanupRecentKickChatEventIds(nowTs = Date.now()) {
    for (const [key, ts] of recentKickChatEventIds.entries()) {
      if ((nowTs - ts) > KICK_CHAT_EVENT_ID_DEDUPE_MS) {
        recentKickChatEventIds.delete(key);
      }
    }
  }

  function isDuplicateKickChatEvent(key) {
    if (!key) return false;
    const now = Date.now();
    cleanupRecentKickChatEvents(now);
    const prev = recentKickChatEvents.get(key);
    recentKickChatEvents.set(key, now);
    return !!prev && (now - prev) <= KICK_CHAT_DEDUPE_MS;
  }

  function isDuplicateKickChatEventId(eventId) {
    const key = String(eventId || '').trim();
    if (!key) return false;
    const now = Date.now();
    cleanupRecentKickChatEventIds(now);
    const prev = recentKickChatEventIds.get(key);
    recentKickChatEventIds.set(key, now);
    return !!prev && (now - prev) <= KICK_CHAT_EVENT_ID_DEDUPE_MS;
  }

  function cleanupProcessedKickRowIds(nowTs = Date.now()) {
    for (const [key, ts] of recentlyProcessedKickRowIds.entries()) {
      if ((nowTs - ts) > KICK_ROW_DEDUPE_MS) {
        recentlyProcessedKickRowIds.delete(key);
      }
    }
  }

  function markKickRowProcessed(rowId) {
    const key = String(rowId || '').trim();
    if (!key) return;
    const now = Date.now();
    cleanupProcessedKickRowIds(now);
    recentlyProcessedKickRowIds.set(key, now);
  }

  function wasKickRowProcessed(rowId) {
    const key = String(rowId || '').trim();
    if (!key) return false;
    const now = Date.now();
    cleanupProcessedKickRowIds(now);
    return recentlyProcessedKickRowIds.has(key);
  }

  function kickEventsColumnMissing(error, columnName) {
    const col = String(columnName || '').toLowerCase();
    if (!col) return false;
    const msg = String(error?.message || error || '').toLowerCase();
    return msg.includes(col) && (msg.includes('does not exist') || msg.includes('column'));
  }

  async function listUnprocessedKickEvents() {
    if (!state.supabase) return { data: [], error: null };
    let res = await state.supabase
      .from('kick_events')
      .select('*')
      .is('processed_at', null)
      .order('created_at', { ascending: true })
      .limit(20);
    if (res?.error && kickEventsColumnMissing(res.error, 'processed_at')) {
      // Compatibilidad con instalaciones antiguas sin columna processed_at.
      res = await state.supabase
        .from('kick_events')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(20);
    }
    return res;
  }

  async function markKickEventsProcessed(rowIds) {
    if (!state.supabase || !Array.isArray(rowIds) || !rowIds.length) return;
    const uniqueIds = [...new Set(rowIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
    if (!uniqueIds.length) return;
    const nowIso = new Date().toISOString();
    let updateRes = await state.supabase
      .from('kick_events')
      .update({ processed_at: nowIso, processed_error: '' })
      .in('id', uniqueIds)
      .select('id');
    if (updateRes?.error && kickEventsColumnMissing(updateRes.error, 'processed_error')) {
      updateRes = await state.supabase
        .from('kick_events')
        .update({ processed_at: nowIso })
        .in('id', uniqueIds)
        .select('id');
    }
    if (updateRes?.error && kickEventsColumnMissing(updateRes.error, 'processed_at')) {
      // Fallback legacy: si no existe processed_at, borrar como antes.
      await state.supabase.from('kick_events').delete().in('id', uniqueIds);
      return;
    }
    if (updateRes?.error) {
      saveLog('warn', `[Kick poll] no pude marcar eventos procesados (${updateRes.error?.message || updateRes.error})`);
      // En política estricta (solo service_role para UPDATE), consumir por DELETE.
      await state.supabase.from('kick_events').delete().in('id', uniqueIds);
      return;
    }
    const updatedRows = Array.isArray(updateRes?.data) ? updateRes.data : [];
    if (!updatedRows.length) {
      // RLS puede devolver 0 rows sin error para UPDATE no permitido.
      await state.supabase.from('kick_events').delete().in('id', uniqueIds);
    }
  }

  async function markKickEventFailed(rowId, errorLike) {
    if (!state.supabase || !rowId) return;
    const errText = String(errorLike?.message || errorLike || 'unknown error').slice(0, 500);
    const nowIso = new Date().toISOString();
    let updateRes = await state.supabase
      .from('kick_events')
      .update({ processed_at: nowIso, processed_error: errText })
      .eq('id', rowId)
      .select('id');
    if (updateRes?.error && kickEventsColumnMissing(updateRes.error, 'processed_error')) {
      updateRes = await state.supabase
        .from('kick_events')
        .update({ processed_at: nowIso })
        .eq('id', rowId)
        .select('id');
    }
    if (updateRes?.error && kickEventsColumnMissing(updateRes.error, 'processed_at')) {
      // Fallback legacy: sin processed_at no hay cuarentena segura, borrar para evitar loop infinito.
      await state.supabase.from('kick_events').delete().eq('id', rowId);
      return;
    }
    if (updateRes?.error) {
      saveLog('warn', `[Kick poll] no pude marcar evento fallido id=${rowId} (${updateRes.error?.message || updateRes.error})`);
      await state.supabase.from('kick_events').delete().eq('id', rowId);
      return;
    }
    const updatedRows = Array.isArray(updateRes?.data) ? updateRes.data : [];
    if (!updatedRows.length) {
      await state.supabase.from('kick_events').delete().eq('id', rowId);
    }
  }

  async function pollKickEvents() {
    if (!state.supabase) return;
    if (kickPollInFlight) return;
    kickPollInFlight = true;
    try {
      const { data, error } = await listUnprocessedKickEvents();
      if (error) {
        kickPollConsecutiveErrors += 1;
        saveLog('warn', `[Kick poll] error leyendo kick_events: ${error?.message || error}`);
        return;
      }
      kickPollConsecutiveErrors = 0;
      kickPollLastOkAt = Date.now();
      if (!data?.length) return;

      const processedIds = [];
      for (const row of data) {
        if (wasKickRowProcessed(row?.id)) {
          processedIds.push(Number(row.id));
          continue;
        }
        try {
          const processed = await processKickEvent(row);
          if (processed) {
            markKickRowProcessed(row.id);
            processedIds.push(Number(row.id));
          }
        } catch (rowErr) {
          saveLog('warn', `[Kick poll] row ${row?.id || '?'} error: ${rowErr?.message || rowErr}`);
          await markKickEventFailed(row?.id, rowErr);
        }
      }
      // Persistir estado de procesado para trazabilidad y diagnóstico.
      if (processedIds.length) {
        await markKickEventsProcessed(processedIds);
      }
      kickPollConsecutiveErrors = 0;
      kickPollLastOkAt = Date.now();
    } catch (e) {
      kickPollConsecutiveErrors += 1;
      saveLog('warn', `[Kick poll] error: ${e?.message || e}`);
    } finally {
      kickPollInFlight = false;
    }
  }

  async function processKickEventRealtimeRow(row) {
    const rowId = row?.id;
    if (!rowId || wasKickRowProcessed(rowId)) return;
    try {
      const processed = await processKickEvent(row);
      if (!processed) return;
      markKickRowProcessed(rowId);
      if (state.supabase) {
        await markKickEventsProcessed([rowId]);
      }
    } catch (e) {
      saveLog('warn', `[Kick realtime] row ${rowId} error: ${e?.message || e}`);
      await markKickEventFailed(rowId, e);
    }
  }

  async function stopKickRealtime() {
    if (kickRealtimeRetryTimer) {
      clearTimeout(kickRealtimeRetryTimer);
      kickRealtimeRetryTimer = null;
    }
    if (!kickRealtimeChannel || !state.supabase) {
      kickRealtimeChannel = null;
      kickRealtimeStatus = 'CLOSED';
      return;
    }
    const channel = kickRealtimeChannel;
    kickRealtimeChannel = null;
    kickRealtimeStatus = 'CLOSED';
    try {
      await state.supabase.removeChannel(channel);
    } catch (_) {}
  }

  async function startKickRealtime() {
    if (!state.supabase || typeof state.supabase.channel !== 'function') return;
    if (
      kickRealtimeChannel
      && (kickRealtimeStatus === 'SUBSCRIBED' || kickRealtimeStatus === 'JOINING')
    ) {
      return;
    }
    await stopKickRealtime();
    const name = `kick-events-live-${Date.now()}`;
    kickRealtimeStatus = 'JOINING';
    kickRealtimeChannel = state.supabase
      .channel(name)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'kick_events' },
        (payload) => {
          const row = payload?.new || null;
          processKickEventRealtimeRow(row).catch(() => {});
        }
      )
      .subscribe((status) => {
        kickRealtimeStatus = String(status || '').toUpperCase() || 'UNKNOWN';
        if (kickRealtimeStatus === 'SUBSCRIBED') {
          kickRealtimeLastWarnStatus = '';
          kickRealtimeLastWarnAt = 0;
          saveLog('info', 'Kick realtime activo (kick_events INSERT).');
          return;
        }
        if (kickRealtimeStatus === 'CHANNEL_ERROR' || kickRealtimeStatus === 'TIMED_OUT' || kickRealtimeStatus === 'CLOSED') {
          const now = Date.now();
          const pollingUnhealthy = (
            !state.kickPollTimer
            || kickPollConsecutiveErrors >= 3
            || (kickPollLastOkAt > 0 && (now - kickPollLastOkAt) > 15000)
          );
          const shouldWarn = pollingUnhealthy && (now - kickRealtimeLastWarnAt) > (3 * 60 * 1000);
          if (shouldWarn) {
            saveLog('warn', `Kick realtime estado=${kickRealtimeStatus} y polling fallback degradado (errStreak=${kickPollConsecutiveErrors}).`);
            kickRealtimeLastWarnStatus = kickRealtimeStatus;
            kickRealtimeLastWarnAt = now;
          }
          if (!kickRealtimeRetryTimer) {
            kickRealtimeRetryTimer = setTimeout(() => {
              kickRealtimeRetryTimer = null;
              startKickRealtime().catch(() => {});
            }, 2000);
          }
        }
      });
  }

  function extractKickNick(d) {
    return (
      d?.redeemer?.username ||
      d?.redeemer?.slug ||
      d?.user?.username ||
      d?.user?.slug ||
      d?.sender?.username ||
      d?.sender?.slug ||
      d?.username ||
      d?.display_name ||
      d?.name ||
      'unknown'
    );
  }

  function extractKickRewardId(d) {
    return String(
      d?.reward?.id ||
      d?.reward_id ||
      d?.rewardId ||
      d?.redemption?.reward_id ||
      d?.redemption?.reward?.id ||
      ''
    );
  }

  function extractKickRewardInput(d) {
    return (
      d?.user_input ||
      d?.userInput ||
      d?.input ||
      d?.redemption?.user_input ||
      d?.redemption?.userInput ||
      d?.redemption?.input ||
      ''
    );
  }

  function extractKickRedemptionEventId(d) {
    return String(
      d?.id ||
      d?.redemption?.id ||
      d?.redemption_id ||
      d?.event_id ||
      ''
    ).trim();
  }

  function extractKickChatEventId(d, row = null) {
    return String(
      d?.message_id ||
      d?.messageId ||
      d?.chat_message_id ||
      d?.chatMessageId ||
      d?.message?.id ||
      row?.event_id ||
      d?.event_id ||
      d?.id ||
      ''
    ).trim();
  }

  function extractKickChatText(d) {
    const candidates = [
      d?.content,
      d?.message?.content,
      d?.message?.text,
      d?.text,
      d?.chat_message?.content,
      d?.chatMessage?.content,
      d?.data?.content,
      d?.data?.message?.content,
      d?.attributes?.content,
    ];
    for (const value of candidates) {
      const text = String(value || '').trim();
      if (text) return text;
    }
    return '';
  }

  function extractKickEventChannel(payloadData) {
    const candidates = [
      payloadData?.broadcaster?.slug,
      payloadData?.broadcaster?.channel_slug,
      payloadData?.broadcaster?.username,
      payloadData?.broadcaster_user_login,
      payloadData?.channel?.slug,
      payloadData?.channel?.name,
      payloadData?.chatroom?.channel?.slug,
      payloadData?.chatroom?.channel?.name,
      payloadData?.message?.channel?.slug,
      payloadData?.message?.channel?.name,
      payloadData?.room?.channel?.slug,
      payloadData?.room?.channel?.name,
    ];
    for (const value of candidates) {
      const normalized = normalizeKickChannel(value);
      if (normalized) return normalized;
    }
    return '';
  }

  function extractKickRedemptionStatus(payloadData) {
    return String(payloadData?.status || payloadData?.redemption?.status || '').trim().toLowerCase();
  }

  function toIsoOrNull(value) {
    const str = String(value || '').trim();
    if (!str) return null;
    const ts = Date.parse(str);
    if (Number.isNaN(ts)) return null;
    return new Date(ts).toISOString();
  }

  function normalizeKickUserPayload(value) {
    if (!value || typeof value !== 'object') return null;
    const userIdRaw = value.user_id ?? value.id ?? null;
    const userId = userIdRaw == null ? '' : String(userIdRaw).trim();
    const username = String(value.username || value.slug || value.channel_slug || '').trim();
    if (!userId && !username) return null;
    return { userId, username };
  }

  function kickSubsTableMissing(error) {
    const msg = String(error?.message || error || '').toLowerCase();
    return msg.includes('kick_subscribers') && (msg.includes('does not exist') || msg.includes('relation') || msg.includes('schema cache'));
  }

  async function upsertKickSubscribers(rows) {
    if (!state.supabase || !Array.isArray(rows) || !rows.length || kickSubsStorageDisabled) return;
    try {
      await state.supabase.from('kick_subscribers').upsert(rows, { onConflict: 'id' });
    } catch (e) {
      if (kickSubsTableMissing(e)) {
        kickSubsStorageDisabled = true;
        if (!kickSubsStorageWarned) {
          kickSubsStorageWarned = true;
          saveLog('warn', 'Kick subs: tabla kick_subscribers no encontrada en Supabase. El listado de subs queda desactivado hasta crearla.');
        }
        return;
      }
      saveLog('warn', `Kick subs: error guardando subs (${e?.message || e})`);
    }
  }

  async function persistKickSubscriptionEvent({ eventType, payloadData, mode, activeChannel }) {
    const channelSlug = normalizeKickChannel(activeChannel || extractKickEventChannel(payloadData));
    if (!channelSlug) return;

    const eventAt = toIsoOrNull(payloadData?.created_at || payloadData?.redeemed_at) || new Date().toISOString();
    const expiresAt = toIsoOrNull(payloadData?.expires_at);
    const durationMonths = Number(payloadData?.duration) || null;
    const nowIso = new Date().toISOString();

    const rows = [];
    const pushSub = (user) => {
      const normalized = normalizeKickUserPayload(user);
      if (!normalized) return;
      const userKey = normalized.userId || normalized.username.toLowerCase();
      rows.push({
        id: `${mode}:${channelSlug}:${userKey}`,
        mode,
        channel_slug: channelSlug,
        user_id: normalized.userId || null,
        username: normalized.username || null,
        is_active: !expiresAt || Date.parse(expiresAt) >= Date.now(),
        duration_months: durationMonths,
        expires_at: expiresAt,
        last_event_at: eventAt,
        last_event_type: eventType,
        updated_at: nowIso,
      });
    };

    if (eventType === 'channel.subscription.gifts') {
      const giftees = Array.isArray(payloadData?.giftees) ? payloadData.giftees : [];
      giftees.forEach((giftee) => pushSub(giftee));
    } else {
      pushSub(payloadData?.subscriber);
    }

    if (rows.length) {
      await upsertKickSubscribers(rows);
    }
  }

  function normalizeKickEventTypeName(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[:]/g, '.');
  }

  function isKickChatEventType(value) {
    const evt = normalizeKickEventTypeName(value);
    if (!evt) return false;
    if (evt === 'chat.message.sent' || evt === 'chat.message.created' || evt === 'channel.chat.message.sent' || evt === 'chat_message.sent') {
      return true;
    }
    return evt.includes('chat') && evt.includes('message');
  }

  function isKickSubscriptionEventType(value) {
    const evt = normalizeKickEventTypeName(value);
    if (!evt) return false;
    if (evt === 'channel.subscription.new' || evt === 'channel.subscription.renewal' || evt === 'channel.subscription.gifts') {
      return true;
    }
    return evt.includes('subscription');
  }

  function isKickRewardRedemptionEventType(value) {
    const evt = normalizeKickEventTypeName(value);
    if (!evt) return false;
    if (evt === 'channel.reward.redemption.updated' || evt === 'channel.reward.redemption.created') {
      return true;
    }
    return evt.includes('reward') && (evt.includes('redemption') || evt.includes('redeem'));
  }

  function extractKickBroadcasterId(payloadData) {
    const raw = payloadData?.broadcaster?.id
      ?? payloadData?.broadcaster_id
      ?? payloadData?.broadcaster_user_id
      ?? payloadData?.channel?.broadcaster_user_id
      ?? payloadData?.channel?.id
      ?? payloadData?.chatroom?.channel?.broadcaster_user_id
      ?? null;
    if (raw == null) return '';
    return String(raw).trim();
  }

  function shouldIgnoreKickEventChannel(payloadData, activeChannel) {
    const eventChannel = extractKickEventChannel(payloadData);
    if (!eventChannel || !activeChannel) return false;
    if (eventChannel === activeChannel) return false;
    const eventBroadcasterId = extractKickBroadcasterId(payloadData);
    const localBroadcasterId = String(state.kickChannelId || '').trim();
    if (eventBroadcasterId && localBroadcasterId && eventBroadcasterId === localBroadcasterId) {
      return false;
    }
    return true;
  }

  async function processKickEvent(row) {
    const payload = row.payload || {};
    const eventType = row.event_type || payload.event_type || payload.event || '';

    // Chat message
    if (isKickChatEventType(eventType)) {
      const d = payload.data || payload;
      if (isKickEventStaleForLiveWindow(row, d)) {
        return true;
      }
      if (isKickCommandEventBeforeConnection(row, d)) {
        return true;
      }
      const nick = extractKickNick(d);
      const text = extractKickChatText(d);
      const cfg = cfgForMode();
      const routing = resolveKickRouting(cfg);
      const activeChannel = normalizeKickChannel(routing.activeChannel);
      if (shouldIgnoreKickEventChannel(d, activeChannel)) {
        return true;
      }

      const chatEventId = extractKickChatEventId(d, row);
      if (chatEventId && isDuplicateKickChatEventId(chatEventId)) {
        return true;
      }
      const rowCreatedAt = String(
        d.created_at
        || d.createdAt
        || d?.message?.created_at
        || d?.message?.createdAt
        || row?.webhook_timestamp
        || ''
      ).trim();
      const eventChannel = extractKickEventChannel(d);
      const fallbackKey = `${eventChannel || activeChannel || 'unknown'}|${String(nick || '').toLowerCase()}|${String(text || '').toLowerCase()}|${rowCreatedAt}`;
      const dedupeKey = chatEventId || (rowCreatedAt ? fallbackKey : '');
      if (isDuplicateKickChatEvent(dedupeKey)) {
        return true;
      }

      if (nick && text) {
        processKickMessage(nick, text);
        await processQueue();
      } else {
        saveLog('warn', `[Kick chat] evento sin nick/texto legible (type=${eventType}) payload=${JSON.stringify(d).slice(0, 220)}`);
      }
      return true;
    }

    if (isKickSubscriptionEventType(eventType)) {
      const d = payload.data || payload;
      const cfg = cfgForMode();
      const routing = resolveKickRouting(cfg);
      const activeChannel = normalizeKickChannel(routing.activeChannel);
      const eventChannel = extractKickEventChannel(d);
      if (shouldIgnoreKickEventChannel(d, activeChannel)) {
        return true;
      }
      await persistKickSubscriptionEvent({
        eventType,
        payloadData: d,
        mode: routing.mode === 'dev' ? 'dev' : 'prod',
        activeChannel: eventChannel || activeChannel,
      });
      return true;
    }

    // Channel reward redemption
    if (isKickRewardRedemptionEventType(eventType)) {
      const d = payload.data || payload;
      if (isKickEventStaleForLiveWindow(row, d)) {
        return true;
      }
      if (isKickCommandEventBeforeConnection(row, d)) {
        return true;
      }
      const nick = extractKickNick(d);
      const rewardId = extractKickRewardId(d);
      const redemptionStatus = extractKickRedemptionStatus(d);
      const userInput = String(extractKickRewardInput(d) || '').trim();
      const cfgForLog = cfgForMode();
      const routing = resolveKickRouting(cfgForLog);
      const activeChannel = normalizeKickChannel(routing.activeChannel);
      const eventChannel = extractKickEventChannel(d);
      if (shouldIgnoreKickEventChannel(d, activeChannel)) {
        return true;
      }
      const cfgRewardId = String(state.songRequestRewardId || getActiveSongRequestRewardId(cfgForLog) || '').trim();
      const redemptionId = extractKickRedemptionEventId(d);
      const fallbackKey = `${rewardId}|${String(nick || '').toLowerCase()}|${userInput.toLowerCase()}`;
      const dedupeKey = redemptionId || fallbackKey;
      saveLog('info', `[Kick redemption] mode=${cfgForLog.kickBotMode || 'prod'} rewardId=${rewardId} nick=${nick} status=${redemptionStatus || 'unknown'} match=${rewardId === cfgRewardId}`);

      // Kick puede emitir redemptions en distintos estados según el webhook/app.
      // Procesamos estados útiles para song request y descartamos explícitamente los negativos.
      const ignoreStatuses = new Set(['rejected', 'canceled', 'cancelled', 'failed', 'denied', 'refunded']);
      if (redemptionStatus && ignoreStatuses.has(redemptionStatus)) {
        return true;
      }

      if (!cfgRewardId) {
        const detected = rewardId || '(vacío)';
        saveLog('warn', `[Kick redemption] reward ID (modo actual) no configurado — detectado en canje: ${detected}`);
        return true;
      }
      if (!state.songRequestEnabled) {
        saveLog('warn', `[Kick redemption] songRequestEnabled=false, ignorando`);
        return true;
      }
      if (!state.songRequestKickEnabled) {
        saveLog('warn', `[Kick redemption] songRequestKickEnabled=false, ignorando`);
        return true;
      }
      if (rewardId !== cfgRewardId) {
        return true;
      }
      if (!userInput) {
        saveLog('warn', `[Kick redemption] ${nick} canjeo sin texto, ignorando`);
        return true;
      }
      if (redemptionId && isDuplicateKickRedemptionId(redemptionId)) {
        saveLog('info', `[Kick redemption] duplicado por redemption_id ignorado (${nick})`);
        return true;
      }
      if (isDuplicateKickRedemption(dedupeKey)) {
        saveLog('info', `[Kick redemption] duplicado ignorado (${nick})`);
        return true;
      }

      saveLog('song', `[Kick] ${nick} pidió: ${userInput}`);
      state.queue.push({ nick, channel: '__kick__', action: 'songrequest', link: userInput });
      await processQueue();
      return true;
    }

    // Cualquier otro evento: no ensuciar logs con payload completo.
    if (eventType) {
      saveLog('info', `[Kick evento ignorado] type="${eventType}"`);
    }
    return true;
  }

  async function syncSongRequestStateFromKickReward() {
    const ctx = await loadKickContext();
    if (!ctx.ok) {
      saveLog('warn', `[Kick SR sync] sin contexto de Supabase: ${ctx.error || 'desconocido'}`);
      return;
    }
    const cfg = ctx.cfg;
    const mode = cfg.kickBotMode === 'dev' ? 'dev' : 'prod';
    const configuredRewardId = getActiveSongRequestRewardId(cfg);
    state.songRequestRewardId = configuredRewardId || '';

    let nextEnabled = state.songRequestEnabled !== false;
    let nextKickEnabled = state.songRequestKickEnabled !== false;

    if (!configuredRewardId) {
      nextEnabled = false;
      nextKickEnabled = false;
    } else {
      let token = ctx.creds.accessToken;
      if (!token) {
        saveLog('warn', `[Kick SR sync ${mode}] no hay token para validar reward`);
        return;
      }
      let r = await kickApiRequestWithRetry('GET', '/public/v1/channels/rewards', null, token, { retries: 1, baseDelayMs: 500 });
      if (r.status === 401) {
        const refreshed = await kickRefreshAccessToken(mode);
        if (refreshed) {
          token = refreshed;
          r = await kickApiRequestWithRetry('GET', '/public/v1/channels/rewards', null, token, { retries: 1, baseDelayMs: 500 });
        }
      }
      if (r.status !== 200) {
        saveLog('warn', `[Kick SR sync ${mode}] no pude validar reward (status=${r.status})`);
        return;
      }

      const rewards = Array.isArray(r.data?.data) ? r.data.data : [];
      const reward = rewards.find(item => String(item?.id || '') === configuredRewardId);
      if (!reward) {
        saveLog('warn', `[Kick SR sync ${mode}] la reward configurada (${configuredRewardId}) no apareció en el listado de Kick; se mantiene la configuración local para evitar limpiar el ID por error.`);
        return;
      }
      const rewardEnabled = !!reward.is_enabled;
      nextEnabled = rewardEnabled;
      nextKickEnabled = rewardEnabled;
    }

    let changed = false;
    if (cfg.songRequestEnabled !== nextEnabled) {
      cfg.songRequestEnabled = nextEnabled;
      changed = true;
    }
    if (cfg.songRequestKickEnabled !== nextKickEnabled) {
      cfg.songRequestKickEnabled = nextKickEnabled;
      changed = true;
    }

    state.songRequestEnabled = nextEnabled;
    state.songRequestKickEnabled = nextKickEnabled;
    if (changed) {
      const appCfg = loadConfig();
      appCfg.songRequestEnabled = nextEnabled;
      appCfg.songRequestKickEnabled = nextKickEnabled;
      saveConfig(appCfg);
    }
    saveLog('info', `[Kick SR sync ${mode}] enabled=${nextKickEnabled} rewardId=${getActiveSongRequestRewardId(cfg) || '(none)'}`);
  }

  async function deleteKickEventSubscriptionsById(token, ids) {
    const uniqueIds = [...new Set((ids || []).map((value) => String(value || '').trim()).filter(Boolean))];
    if (!uniqueIds.length) return { ok: true, deleted: 0 };
    const query = uniqueIds.map((id) => `id=${encodeURIComponent(id)}`).join('&');
    const delRes = await kickApiRequestWithRetry('DELETE', `/public/v1/events/subscriptions?${query}`, null, token, {
      retries: 2,
      baseDelayMs: 600,
    });
    const status = Number(delRes?.status || 0);
    if ([200, 202, 204].includes(status)) {
      return { ok: true, deleted: uniqueIds.length };
    }
    return { ok: false, status, error: delRes?.data?.message || delRes?.data?.error || '' };
  }

  async function ensureKickEventSubscriptions(token, broadcasterUserId) {
    const listPath = broadcasterUserId
      ? `/public/v1/events/subscriptions?broadcaster_user_id=${encodeURIComponent(String(broadcasterUserId))}`
      : '/public/v1/events/subscriptions';
    const listRes = await kickApiRequestWithRetry('GET', listPath, null, token, { retries: 1, baseDelayMs: 500 });
    if (listRes.status !== 200) {
      const detail = listRes?.data?.message || listRes?.data?.error_description || listRes?.data?.error || '';
      if (Number(listRes.status || 0) === 429) {
        return {
          ok: false,
          status: 429,
          retryable: true,
          error: `Kick rate-limit al leer suscripciones (429${detail ? `: ${detail}` : ''}).`,
        };
      }
      return {
        ok: false,
        status: listRes.status,
        error: `Kick no permitió leer las suscripciones actuales (status=${listRes.status}${detail ? `: ${detail}` : ''}).`,
      };
    }

    const existing = Array.isArray(listRes.data?.data) ? listRes.data.data : [];
    const keyOf = (row) => `${String(row?.event || row?.name || '').trim()}:${Number(row?.version || 1) || 1}`;
    const existingSet = new Set(existing.map((row) => keyOf(row)));
    const duplicateSubscriptionIds = [];
    const groupedRequired = new Map();
    for (const row of existing) {
      const eventName = String(row?.event || row?.name || '').trim();
      if (!KICK_REQUIRED_EVENT_SET.has(eventName)) continue;
      const key = keyOf(row);
      const list = groupedRequired.get(key) || [];
      list.push(row);
      groupedRequired.set(key, list);
    }
    for (const rows of groupedRequired.values()) {
      if (rows.length <= 1) continue;
      const sorted = rows.slice().sort((a, b) => {
        const aMs = Date.parse(String(a?.created_at || a?.updated_at || 0)) || 0;
        const bMs = Date.parse(String(b?.created_at || b?.updated_at || 0)) || 0;
        return bMs - aMs;
      });
      for (let i = 1; i < sorted.length; i += 1) {
        duplicateSubscriptionIds.push(String(sorted[i]?.id || '').trim());
      }
    }
    const legacyChatEvents = new Set(['chat.message.created', 'channel.chat.message.sent', 'chat_message.sent']);
    for (const row of existing) {
      const eventName = String(row?.event || row?.name || '').trim();
      if (!legacyChatEvents.has(eventName)) continue;
      duplicateSubscriptionIds.push(String(row?.id || '').trim());
    }
    if (duplicateSubscriptionIds.length) {
      const deleteRes = await deleteKickEventSubscriptionsById(token, duplicateSubscriptionIds);
      if (deleteRes.ok) {
        saveLog('warn', `Kick subscriptions: limpié ${duplicateSubscriptionIds.length} suscripciones duplicadas/legacy.`);
      } else {
        saveLog('warn', `Kick subscriptions: no pude limpiar duplicadas (status=${deleteRes.status || 0}).`);
      }
    }
    const missing = KICK_REQUIRED_EVENTS.filter((evt) => !existingSet.has(`${evt.name}:${evt.version}`));
    if (!missing.length) {
      return { ok: true, created: [], failed: [], existing: existing };
    }

    const body = {
      method: 'webhook',
      broadcaster_user_id: Number(broadcasterUserId) || broadcasterUserId,
      events: missing,
    };
    const createRes = await kickApiRequestWithRetry('POST', '/public/v1/events/subscriptions', body, token, { retries: 2, baseDelayMs: 600 });
    if (createRes.status !== 200 && createRes.status !== 201) {
      const detail = createRes?.data?.message || createRes?.data?.error_description || createRes?.data?.error || '';
      if (Number(createRes.status || 0) === 429) {
        return {
          ok: false,
          status: 429,
          retryable: true,
          error: `Kick rate-limit al suscribir eventos (429${detail ? `: ${detail}` : ''}).`,
        };
      }
      return {
        ok: false,
        status: createRes.status,
        error: `Kick no permitió suscribir eventos (status=${createRes.status}${detail ? `: ${detail}` : ''}).`,
      };
    }

    const results = Array.isArray(createRes.data?.data) ? createRes.data.data : [];
    const failed = results.filter((entry) => entry?.error).map((entry) => ({
      name: String(entry?.name || entry?.event || '').trim(),
      error: String(entry?.error || '').trim(),
    }));
    const createdOk = results.filter((entry) => !entry?.error);
    const confirmedSet = new Set(existingSet);
    createdOk.forEach((entry) => {
      const key = `${String(entry?.name || entry?.event || '').trim()}:${Number(entry?.version || 1) || 1}`;
      confirmedSet.add(key);
    });
    for (const evt of KICK_REQUIRED_EVENTS) {
      const key = `${evt.name}:${evt.version}`;
      if (!confirmedSet.has(key)) {
        failed.push({ name: evt.name, error: 'Kick no confirmó la suscripción' });
      }
    }
    return {
      ok: true,
      created: createdOk,
      failed,
      existing,
    };
  }

  async function cleanupKickEventSubscriptions(modeOverride = null) {
    const ctx = await loadKickContext(modeOverride);
    if (!ctx.ok) return;
    let token = state.kickAccessToken || ctx.creds.accessToken;
    if (!token) return;

    let listRes = await kickApiRequestWithRetry('GET', '/public/v1/events/subscriptions', null, token, { retries: 1, baseDelayMs: 500 });
    if (listRes.status === 401) {
      const refreshed = await kickRefreshAccessToken(modeOverride);
      if (!refreshed) return;
      token = refreshed;
      listRes = await kickApiRequestWithRetry('GET', '/public/v1/events/subscriptions', null, token, { retries: 1, baseDelayMs: 500 });
    }
    if (listRes.status !== 200) {
      saveLog('warn', `Kick: no pude listar suscripciones para limpiar (status=${listRes.status || 0}).`);
      return;
    }

    const channelId = String(state.kickChannelId || '').trim();
    const rows = Array.isArray(listRes.data?.data) ? listRes.data.data : [];
    const targetIds = rows
      .filter((row) => {
        const eventName = String(row?.event || row?.name || '').trim();
        if (!KICK_REQUIRED_EVENT_SET.has(eventName)) return false;
        if (!channelId) return true;
        return String(row?.broadcaster_user_id || '').trim() === channelId;
      })
      .map((row) => String(row?.id || '').trim())
      .filter(Boolean);

    if (!targetIds.length) return;
    const query = targetIds.map((id) => `id=${encodeURIComponent(id)}`).join('&');
    const delRes = await kickApiRequestWithRetry('DELETE', `/public/v1/events/subscriptions?${query}`, null, token, {
      retries: 2,
      baseDelayMs: 600,
    });
    if (![200, 202, 204].includes(Number(delRes.status || 0))) {
      saveLog('warn', `Kick: no pude limpiar suscripciones remotas (status=${delRes.status || 0}).`);
    }
  }

  async function runKickHealthCycle(modeOverride = null) {
    if (kickHealthInFlight) return;
    kickHealthInFlight = true;
    try {
      const mode = resolveKickMode(modeOverride);
      const now = Date.now();

      if ((now - kickLastTokenRefreshAt) >= KICK_TOKEN_REFRESH_INTERVAL_MS) {
        const ctx = await loadKickContext(mode);

        if (tokenRefreshAllowed('broadcaster')) {
          const broadcasterState = await ensureKickTokenUsable({
            kind: 'broadcaster',
            token: state.kickAccessToken || ctx?.creds?.accessToken || '',
            modeOverride: mode,
            requiredScopes: KICK_REQUIRED_BROADCASTER_SCOPES,
            silent: true,
          });
          if (broadcasterState.ok && broadcasterState.token) {
            const scopeSet = broadcasterState.scopes instanceof Set ? broadcasterState.scopes : new Set();
            const missing = missingBroadcasterScopes(scopeSet);
            if (missing.length) {
              markTokenRefreshOutcome('broadcaster', false);
              saveLog('warn', `Kick health ${mode}: token broadcaster sin scopes requeridos (${missing.join('/')}).`);
            } else {
              state.kickAccessToken = broadcasterState.token;
              markTokenRefreshOutcome('broadcaster', true);
            }
          } else {
            markTokenRefreshOutcome('broadcaster', false);
            if (broadcasterState.reason === 'missing_scope') {
              const missing = Array.isArray(broadcasterState.missingScopes) && broadcasterState.missingScopes.length
                ? broadcasterState.missingScopes.join('/')
                : 'events:subscribe/channel:read/channel:rewards:read|channel:rewards:write';
              saveLog('warn', `Kick health ${mode}: token broadcaster sin scopes requeridos (${missing}).`);
            } else {
              saveLog('warn', `Kick health ${mode}: no pude validar/renovar token broadcaster (retry en ${Math.round((kickNextBroadcasterRefreshAt - Date.now()) / 1000)}s).`);
            }
          }
        }

        if (tokenRefreshAllowed('bot')) {
          const botState = await ensureKickTokenUsable({
            kind: 'bot',
            token: state.kickBotAccessToken || ctx?.creds?.botAccessToken || '',
            modeOverride: mode,
            requiredScopes: KICK_REQUIRED_BOT_SCOPES,
            silent: true,
          });
          if (botState.ok && botState.token) {
            state.kickBotAccessToken = botState.token;
            markTokenRefreshOutcome('bot', true);
          } else {
            markTokenRefreshOutcome('bot', false);
            if (botState.reason === 'missing_scope') {
              saveLog('warn', `Kick health ${mode}: token bot sin scope chat:write.`);
            } else {
              saveLog('warn', `Kick health ${mode}: no pude validar/renovar token bot (retry en ${Math.round((kickNextBotRefreshAt - Date.now()) / 1000)}s).`);
            }
          }
        }

        if ((kickBroadcasterRefreshFailCount === 0) && (kickBotRefreshFailCount === 0)) {
          kickLastTokenRefreshAt = Date.now();
        }
      }

      if ((now - kickLastSubsReconcileAt) >= KICK_SUBS_RECONCILE_INTERVAL_MS) {
        const ctx = await loadKickContext(mode);
        const broadcasterState = await ensureKickTokenUsable({
          kind: 'broadcaster',
          token: state.kickAccessToken || ctx?.creds?.accessToken || '',
          modeOverride: mode,
          requiredScopes: KICK_REQUIRED_BROADCASTER_SCOPES,
          silent: true,
        });
        let token = broadcasterState.ok ? broadcasterState.token : null;
        if (token) state.kickAccessToken = token;
        if (token) {
          if (!state.kickChannelId) {
            const me = await kickApiRequestWithRetry('GET', '/public/v1/channels', null, token, { retries: 1, baseDelayMs: 500 });
            if (me.status === 200 && me?.data?.data?.[0]?.broadcaster_user_id) {
              state.kickChannelId = me.data.data[0].broadcaster_user_id;
            }
          }
          if (state.kickChannelId) {
            const subRes = await ensureKickEventSubscriptions(token, state.kickChannelId);
            if (!subRes.ok) {
              if (Number(subRes?.status || 0) === 429 || subRes?.retryable) {
                scheduleKickSubsReconcileSoon(30000, `health-${mode}-429`);
                saveLog('warn', `Kick health ${mode}: rate-limit en reconciliación de suscripciones. Reintento automático en curso.`);
              } else {
                saveLog('warn', `Kick health ${mode}: no pude reconciliar suscripciones (${subRes.error})`);
              }
            } else if (Array.isArray(subRes.failed) && subRes.failed.length) {
              const detail = subRes.failed.map((row) => `${row.name || 'evento'}: ${row.error || 'error'}`).join(', ');
              saveLog('warn', `Kick health ${mode}: eventos con falla en reconciliación: ${detail}`);
            }
          }
        }
        if (token) {
          kickLastSubsReconcileAt = now;
        }
      }
    } catch (e) {
      saveLog('warn', `Kick health: ${e?.message || e}`);
    } finally {
      kickHealthInFlight = false;
    }
  }

  async function connectKickBot(modeOverride = null) {
    try {
      const ctx = await loadKickContext(modeOverride);
      if (!ctx.ok) {
        return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      }
      const cfg = ctx.cfg;
      const creds = ctx.creds;
      state.kickAccessToken = creds.accessToken;
      state.kickBotAccessToken = creds.botAccessToken || null;
      state.songRequestRewardId = creds.rewardId || '';
      const routing = resolveKickRouting(cfg);
      const activeChannel = routing.activeChannel;
      if (!state.kickAccessToken || !activeChannel || !creds.clientId) {
        return { ok: false, error: 'Falta configuración de Kick para el modo actual. Autorizá la cuenta primero.' };
      }
      if (!state.kickBotAccessToken && !creds.botRefreshToken) {
        return { ok: false, error: 'Falta autorizar la cuenta BOT en el modo actual. Sin eso el bot no puede hablar en chat de forma estable.' };
      }
      const broadcasterToken = await ensureKickTokenUsable({
        kind: 'broadcaster',
        token: state.kickAccessToken,
        modeOverride,
        requiredScopes: KICK_REQUIRED_BROADCASTER_SCOPES,
        silent: false,
      });
      if (!broadcasterToken.ok || !broadcasterToken.token) {
        const missingText = (Array.isArray(broadcasterToken.missingScopes) && broadcasterToken.missingScopes.length)
          ? broadcasterToken.missingScopes.join('/')
          : 'events:subscribe/channel:read/channel:rewards:read|channel:rewards:write';
        const detail = broadcasterToken.reason === 'missing_scope'
          ? `Faltan permisos OAuth en la cuenta del canal (${missingText}). Reautorizá la cuenta canal.`
          : 'Token de la cuenta canal vencido o inválido. Reautorizá la cuenta canal.';
        return { ok: false, error: detail };
      }
      const broadcasterScopeSet = broadcasterToken.scopes instanceof Set ? broadcasterToken.scopes : new Set();
      const broadcasterMissing = missingBroadcasterScopes(broadcasterScopeSet);
      if (broadcasterMissing.length) {
        return {
          ok: false,
          error: `Faltan permisos OAuth en la cuenta del canal (${broadcasterMissing.join('/')}). Reautorizá la cuenta canal.`,
        };
      }
      state.kickAccessToken = broadcasterToken.token;
      if (broadcasterToken.scopes instanceof Set) {
        const optionalMissing = missingScopesFromSet(broadcasterToken.scopes, KICK_OPTIONAL_BROADCASTER_SCOPES);
        if (optionalMissing.length) {
          saveLog('warn', `Kick broadcaster: scopes opcionales faltantes (${optionalMissing.join(', ')}). Funciones de edición de rewards pueden no estar disponibles.`);
        }
      }

      const botToken = await ensureKickTokenUsable({
        kind: 'bot',
        token: state.kickBotAccessToken || creds.botAccessToken || '',
        modeOverride,
        requiredScopes: KICK_REQUIRED_BOT_SCOPES,
        silent: false,
      });
      if (!botToken.ok || !botToken.token) {
        const detail = botToken.reason === 'missing_scope'
          ? 'La cuenta BOT no tiene scope chat:write. Reautorizá la cuenta BOT.'
          : 'Token de la cuenta BOT vencido o inválido. Reautorizá la cuenta BOT.';
        return { ok: false, error: detail };
      }
      state.kickBotAccessToken = botToken.token;
      // Validar SIEMPRE que el token del modo activo pertenezca al canal configurado.
      let me = await kickApiRequestWithRetry('GET', '/public/v1/channels', null, state.kickAccessToken, { retries: 1, baseDelayMs: 500 });
      saveLog('info', `Kick GET /channels(self) → status=${me.status}`);
      if (me.status === 401) {
        const newTok = await kickRefreshAccessToken(modeOverride);
        if (!newTok) {
          return { ok: false, error: 'Refresh del token falló. Reautorizá la cuenta en Config > Kick.' };
        }
        state.kickAccessToken = newTok;
        me = await kickApiRequestWithRetry('GET', '/public/v1/channels', null, state.kickAccessToken, { retries: 1, baseDelayMs: 500 });
        saveLog('info', `Kick GET /channels(self) retry → status=${me.status}`);
      }
      if (me.status !== 200 || !me?.data?.data?.[0]) {
        const apiMsg = me?.data?.message || me?.data?.error_description || me?.data?.error || '';
        return {
          ok: false,
          error: `No pude validar la cuenta autorizada de Kick (${me.status || 'sin status'}${apiMsg ? ': ' + apiMsg : ''}). Reautorizá en Config > Kick.`,
        };
      }
      const meChannel = normalizeKickChannel(me?.data?.data?.[0]?.slug || me?.data?.data?.[0]?.broadcaster_user_login || '');
      if (meChannel && meChannel !== activeChannel) {
        return {
          ok: false,
          error: `Token de ${routing.mode} autorizado como @${meChannel}, pero el canal configurado es @${activeChannel}. Reautorizá la cuenta del canal correcto en ${routing.mode.toUpperCase()}.`,
        };
      }
      state.kickChannelId = me.data.data[0].broadcaster_user_id;

      // Enviar mensajes usa el endpoint oficial /public/v1/chat con el token del bot.
      // Suscribir y reconciliar eventos requeridos.
      const subRes = await ensureKickEventSubscriptions(state.kickAccessToken, state.kickChannelId);
      if (!subRes.ok) {
        if (Number(subRes?.status || 0) === 429 || subRes?.retryable) {
          scheduleKickSubsReconcileSoon(20000, 'connect-429');
          saveLog('warn', `Kick subscriptions rate-limited en conexión. Continúo con fallback y reintento automático. (${subRes.error || '429'})`);
        } else {
          return {
            ok: false,
            error: `${subRes.error} Revisá OAuth y webhook de la app en Kick.`,
          };
        }
      }
      const results = Array.isArray(subRes.created) ? subRes.created : [];
      const failedRows = Array.isArray(subRes.failed) ? subRes.failed : [];
      const ok = results.map((e) => e.name || e.type).filter(Boolean);
      const failedFromHelper = failedRows
        .filter((entry) => entry?.name || entry?.error)
        .map((entry) => `${entry.name || 'evento'}: ${entry.error || 'error'}`);
      if (ok.length) saveLog('info', `Kick eventos suscritos: ${ok.join(', ')}`);
      if (failedFromHelper.length) {
        saveLog('warn', `Kick eventos fallidos: ${failedFromHelper.join(', ')}`);
      }

      if (failedRows.length) {
        const requiredFailed = failedRows
          .map((e) => String(e?.name || '').trim())
          .filter(Boolean)
          .join(', ');
        return {
          ok: false,
          error: `Kick conectó pero faltan eventos requeridos (${requiredFailed || 'desconocido'}). Reautorizá y verificá webhook de la app.`,
        };
      }

      // Sincronizar Song Request con el estado real de la reward en Kick.
      await syncSongRequestStateFromKickReward();

      // Log estado de song request config
      const srRewardId = String(state.songRequestRewardId || '').trim() || '(no configurado)';
      saveLog('info', `Kick SR config [${routing.mode}]: rewardId=${srRewardId} srEnabled=${state.songRequestEnabled} srKick=${state.songRequestKickEnabled}`);

      startKickPolling(routing.mode);
      const connectedPayload = { connected: true, channel: activeChannel, mode: routing.mode };
      state.mainWindow?.webContents.send('kick-bot-status', connectedPayload);
      if (routing.mode === 'dev' && routing.hasDedicatedDev) {
        saveLog('info', `Kick bot conectado en modo dev a @${activeChannel} (prod: @${routing.prodChannel}) ✓`);
      } else if (routing.mode === 'dev') {
        saveLog('info', `Kick bot conectado en modo dev usando @${activeChannel} ✓`);
      } else {
        saveLog('info', `Kick bot conectado a @${activeChannel} ✓`);
      }
      return { ok: true, ...connectedPayload };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function disconnectKickBot(modeOverride = null, options = {}) {
    const cleanupRemote = options?.cleanupRemote !== false;
    if (cleanupRemote) {
      try {
        await cleanupKickEventSubscriptions(modeOverride);
      } catch (e) {
        saveLog('warn', `Kick: fallo limpiando suscripciones remotas (${e?.message || e})`);
      }
    }
    stopKickPolling();
    state.kickChannelId = null;
    state.kickAccessToken = null;
    state.kickBotAccessToken = null;
    return { ok: true };
  }

  return {
    kickApiRequest,
    kickRefreshAccessToken,
    kickChatSend,
    connectKickBot,
    disconnectKickBot,
    startKickPolling,
    stopKickPolling,
  };
}

module.exports = { createKickService };
