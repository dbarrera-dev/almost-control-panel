const {
  normalizeKickChannel,
  resolveKickRouting,
  getActiveSongRequestRewardId,
  getKickCreds,
  setKickCred,
  getKickBroadcasterRowId,
  getKickBotRowId,
} = require('../kick-utils');

const KICK_COMMANDS_ROW_KEY = 'kick_commands';
const DEFAULT_KICK_COMMAND_CONFIG = Object.freeze({
  song: true,
  playlist: true,
  queue: true,
  skip: true,
});
const KICK_MONITOR_REQUIRED_BROADCASTER_SCOPES = Object.freeze([
  'events:subscribe',
  'channel:read',
]);
const KICK_MONITOR_REQUIRED_BROADCASTER_REWARD_ANY = Object.freeze([
  'channel:rewards:read',
  'channel:rewards:write',
]);
const KICK_MONITOR_OPTIONAL_BROADCASTER_SCOPES = Object.freeze([]);
const KICK_MONITOR_REQUIRED_BOT_SCOPES = Object.freeze(['chat:write']);
const KICK_MONITOR_REQUIRED_EVENTS = Object.freeze([
  'chat.message.sent',
  'channel.reward.redemption.updated',
  'channel.subscription.new',
  'channel.subscription.renewal',
  'channel.subscription.gifts',
]);

function normalizeKickCommandConfig(raw, fallback = DEFAULT_KICK_COMMAND_CONFIG) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const base = fallback && typeof fallback === 'object' ? fallback : DEFAULT_KICK_COMMAND_CONFIG;
  return {
    song: src.song !== undefined ? src.song !== false : base.song !== false,
    playlist: src.playlist !== undefined ? src.playlist !== false : base.playlist !== false,
    queue: src.queue !== undefined ? src.queue !== false : base.queue !== false,
    skip: src.skip !== undefined ? src.skip !== false : base.skip !== false,
  };
}

function registerKickIpc({
  ipcMain,
  loadConfig,
  saveConfig,
  startKickOAuthFlow,
  getKickCodeVerifier,
  KICK_REDIRECT_URI,
  httpsRequest,
  kickApiRequest,
  kickRefreshAccessToken,
  connectKickBot,
  disconnectKickBot,
  stopKickPolling,
  saveLog,
  state,
}) {
  let kickCommandsRealtimeChannel = null;
  let kickCommandsRealtimeSupabaseRef = null;
  let kickCommandsRealtimeStatus = 'CLOSED';
  let commandsSyncRetryTimer = null;
  let commandsSyncRetryBackoffMs = 0;
  let commandsSyncInFlight = false;
  let lastSyncedCommandsHash = '';

  function broadcastKickCommandsConfig(config, source = 'local') {
    state.mainWindow?.webContents.send('kick-commands-updated', {
      source,
      config,
    });
  }

  function applyKickCommandsConfig(nextCfg, options = {}) {
    const normalized = normalizeKickCommandConfig(
      nextCfg,
      normalizeKickCommandConfig(state.kickCommandConfig || DEFAULT_KICK_COMMAND_CONFIG)
    );
    state.kickCommandConfig = normalized;

    if (options.persistLocal !== false) {
      const cfg = loadConfig();
      cfg.kickCommandConfig = normalized;
      saveConfig(cfg);
    }
    if (options.broadcast !== false) {
      broadcastKickCommandsConfig(normalized, options.source || 'local');
    }
    return normalized;
  }

  async function pushKickCommandsToSupabase(cfg) {
    if (!state.supabase) return { ok: false, error: 'Sin conexión a Supabase' };
    const { error } = await state.supabase
      .from('overlay_settings')
      .upsert({ key: KICK_COMMANDS_ROW_KEY, value: cfg }, { onConflict: 'key' });
    if (error) return { ok: false, error: error.message || 'No se pudo guardar comandos de Kick' };
    return { ok: true };
  }

  function commandsConfigHash(cfg) {
    try {
      return JSON.stringify(cfg || {});
    } catch {
      return '';
    }
  }

  function clearCommandsSyncRetryTimer() {
    if (!commandsSyncRetryTimer) return;
    clearTimeout(commandsSyncRetryTimer);
    commandsSyncRetryTimer = null;
  }

  function scheduleCommandsSyncRetry() {
    if (commandsSyncRetryTimer) return;
    commandsSyncRetryBackoffMs = commandsSyncRetryBackoffMs
      ? Math.min(commandsSyncRetryBackoffMs * 2, 30000)
      : 1500;
    commandsSyncRetryTimer = setTimeout(() => {
      commandsSyncRetryTimer = null;
      syncKickCommandsToSupabase('retry').catch(() => {});
    }, commandsSyncRetryBackoffMs);
  }

  async function syncKickCommandsToSupabase(trigger = 'manual') {
    if (commandsSyncInFlight) return { ok: false, skipped: true, error: 'Sync en progreso' };
    const snapshot = normalizeKickCommandConfig(state.kickCommandConfig || DEFAULT_KICK_COMMAND_CONFIG);
    const hash = commandsConfigHash(snapshot);
    if (trigger !== 'retry' && hash && hash === lastSyncedCommandsHash) {
      return { ok: true, skipped: true };
    }
    commandsSyncInFlight = true;
    try {
      const res = await pushKickCommandsToSupabase(snapshot);
      if (res.ok) {
        lastSyncedCommandsHash = hash;
        commandsSyncRetryBackoffMs = 0;
        clearCommandsSyncRetryTimer();
        return { ok: true };
      }
      scheduleCommandsSyncRetry();
      return res;
    } finally {
      commandsSyncInFlight = false;
    }
  }

  async function pullKickCommandsFromSupabase() {
    if (!state.supabase) return null;
    try {
      const { data, error } = await state.supabase
        .from('overlay_settings')
        .select('value')
        .eq('key', KICK_COMMANDS_ROW_KEY)
        .maybeSingle();
      if (error || !data?.value) return null;
      return data.value;
    } catch {
      return null;
    }
  }

  function stopKickCommandsRealtime() {
    if (!kickCommandsRealtimeChannel || !kickCommandsRealtimeSupabaseRef) {
      kickCommandsRealtimeChannel = null;
      kickCommandsRealtimeSupabaseRef = null;
      kickCommandsRealtimeStatus = 'CLOSED';
      return;
    }
    const sb = kickCommandsRealtimeSupabaseRef;
    const ch = kickCommandsRealtimeChannel;
    kickCommandsRealtimeChannel = null;
    kickCommandsRealtimeSupabaseRef = null;
    kickCommandsRealtimeStatus = 'CLOSED';
    Promise.resolve(sb.removeChannel(ch)).catch(() => {});
  }

  function ensureKickCommandsRealtime() {
    const supabase = state.supabase;
    if (!supabase) {
      stopKickCommandsRealtime();
      return;
    }
    const channelHealthy = (
      kickCommandsRealtimeChannel
      && kickCommandsRealtimeSupabaseRef === supabase
      && (kickCommandsRealtimeStatus === 'SUBSCRIBED' || kickCommandsRealtimeStatus === 'JOINING')
    );
    if (channelHealthy) return;
    stopKickCommandsRealtime();
    kickCommandsRealtimeSupabaseRef = supabase;
    kickCommandsRealtimeStatus = 'JOINING';
    kickCommandsRealtimeChannel = supabase
      .channel(`kick-commands-sync-${Date.now()}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'overlay_settings',
          filter: `key=eq.${KICK_COMMANDS_ROW_KEY}`,
        },
        (payload) => {
          const remoteValue = payload?.new?.value ?? payload?.record?.value ?? null;
          if (!remoteValue) return;
          applyKickCommandsConfig(remoteValue, {
            persistLocal: true,
            broadcast: true,
            source: 'supabase',
          });
        }
      )
      .subscribe((status) => {
        kickCommandsRealtimeStatus = String(status || '').toUpperCase() || 'UNKNOWN';
        if (kickCommandsRealtimeStatus === 'SUBSCRIBED') {
          pullKickCommandsFromSupabase().then((remote) => {
            if (!remote) return;
            applyKickCommandsConfig(remote, {
              persistLocal: true,
              broadcast: true,
              source: 'supabase',
            });
          }).catch(() => {});
          return;
        }
        if (
          kickCommandsRealtimeStatus === 'CHANNEL_ERROR'
          || kickCommandsRealtimeStatus === 'TIMED_OUT'
          || kickCommandsRealtimeStatus === 'CLOSED'
        ) {
          stopKickCommandsRealtime();
          setTimeout(() => ensureKickCommandsRealtime(), 1500);
        }
      });
  }

  // Base local defaults (in case Supabase still has no row)
  applyKickCommandsConfig(state.kickCommandConfig || DEFAULT_KICK_COMMAND_CONFIG, {
    persistLocal: true,
    broadcast: false,
  });
  ensureKickCommandsRealtime();
  setInterval(() => ensureKickCommandsRealtime(), 4000);
  Promise.resolve().then(async () => {
    const remote = await pullKickCommandsFromSupabase();
    if (!remote) return;
    applyKickCommandsConfig(remote, {
      persistLocal: true,
      broadcast: false,
    });
  }).catch(() => {});

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

  function extractKickErrorMessage(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    if (typeof data?.message === 'string' && data.message.trim()) return data.message.trim();
    if (typeof data?.error_description === 'string' && data.error_description.trim()) return data.error_description.trim();
    if (typeof data?.error === 'string' && data.error.trim()) return data.error.trim();
    if (Array.isArray(data?.errors) && data.errors.length) {
      const first = data.errors[0];
      if (typeof first === 'string' && first.trim()) return first.trim();
      if (typeof first?.message === 'string' && first.message.trim()) return first.message.trim();
      if (typeof first?.detail === 'string' && first.detail.trim()) return first.detail.trim();
    }
    return '';
  }

  function mapKickRewardError(r, fallback = 'Error') {
    const status = Number(r?.status || 0);
    const apiMsg = extractKickErrorMessage(r?.data);
    if (status === 401) {
      return 'Kick devolvió Unauthorized. Reautorizá la cuenta en Config > Kick y volvé a conectar el bot.';
    }
    if (status === 404) {
      return 'No encontré esa reward en Kick. Si la borraste desde Kick, cargá un reward ID nuevo en Config > Kick.';
    }
    return apiMsg || `${fallback} ${status}`.trim();
  }

  function normalizeKickRewardColor(value, fallback = '#53D067') {
    const color = String(value || '').trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(color)) return color;
    return fallback;
  }

  function normalizeKickReward(reward, songRequestRewardId = '') {
    if (!reward || typeof reward !== 'object') return null;
    const id = String(reward.id || '');
    if (!id) return null;
    return {
      id,
      title: String(reward.title || ''),
      description: String(reward.description || ''),
      cost: Number(reward.cost) || 1,
      is_enabled: !!reward.is_enabled,
      is_user_input_required: reward?.is_user_input_required !== false,
      should_redemptions_skip_request_queue: !!reward?.should_redemptions_skip_request_queue,
      background_color: normalizeKickRewardColor(reward?.background_color),
      is_song_request: songRequestRewardId ? id === songRequestRewardId : false,
    };
  }

  function pickKickMode(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    return input.mode === 'dev' ? 'dev' : (input.mode === 'prod' ? 'prod' : null);
  }

  function withKickMode(cfg, mode) {
    if (mode !== 'dev' && mode !== 'prod') return cfg;
    return { ...cfg, kickBotMode: mode };
  }

  function isKickSubsTableMissingError(error) {
    const msg = String(error?.message || error || '').toLowerCase();
    return msg.includes('kick_subscribers') && (msg.includes('does not exist') || msg.includes('relation') || msg.includes('schema cache'));
  }

  function isKickEventsTableMissingError(error) {
    const msg = String(error?.message || error || '').toLowerCase();
    return msg.includes('kick_events') && (msg.includes('does not exist') || msg.includes('relation') || msg.includes('schema cache'));
  }

  function isKickEventsProcessedColumnMissingError(error) {
    const msg = String(error?.message || error || '').toLowerCase();
    return (
      msg.includes('processed_at')
      && (msg.includes('does not exist') || msg.includes('column'))
    );
  }

  function isKickEventsColumnMissingError(error, columnName) {
    const col = String(columnName || '').toLowerCase();
    if (!col) return false;
    const msg = String(error?.message || error || '').toLowerCase();
    return msg.includes(col) && (msg.includes('does not exist') || msg.includes('column'));
  }

  function parseKickScopeSet(rawScope) {
    return new Set(
      String(rawScope || '')
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean)
    );
  }

  function hasKickScopes(scopeSet, requiredScopes) {
    return requiredScopes.every((scope) => scopeSet.has(scope));
  }

  function mapKickTokenStateLabel(tokenState) {
    if (!tokenState || !tokenState.hasToken) return 'Sin token';
    if (!tokenState.active) return 'Token inactivo';
    if (tokenState.missingScopes?.length) return `Faltan scopes: ${tokenState.missingScopes.join(', ')}`;
    if (!tokenState.ok) return `No verificado (${tokenState.status || 0})`;
    return 'Token OK';
  }

  async function kickTokenIntrospectWithRefresh({
    token,
    refreshFn,
    requiredScopes = [],
  }) {
    let bearer = String(token || '').trim();
    if (!bearer) {
      return {
        ok: false,
        status: 0,
        hasToken: false,
        active: false,
        scopes: [],
        missingScopes: [...requiredScopes],
        expAt: null,
        expInSec: null,
      };
    }

    const introspect = async (accessToken) => {
      const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token/introspect', {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      }, null).catch(() => ({ status: 0, data: null }));
      const payload = (r?.data && typeof r.data === 'object') ? (r.data.data || {}) : {};
      const scopeSet = parseKickScopeSet(payload?.scope || '');
      const missingScopes = requiredScopes.filter((scope) => !scopeSet.has(scope));
      const expSec = Number(payload?.exp || 0);
      const expMs = Number.isFinite(expSec) && expSec > 0 ? expSec * 1000 : 0;
      return {
        ok: Number(r?.status || 0) === 200,
        status: Number(r?.status || 0),
        active: !!payload?.active,
        scopes: [...scopeSet],
        missingScopes,
        expAt: expMs ? new Date(expMs).toISOString() : null,
        expInSec: expMs ? Math.max(0, Math.round((expMs - Date.now()) / 1000)) : null,
      };
    };

    let res = await introspect(bearer);
    const needsRefresh = (
      res.status === 401
      || !res.active
      || !hasKickScopes(new Set(res.scopes), requiredScopes)
    );
    if (needsRefresh && typeof refreshFn === 'function') {
      const refreshed = await refreshFn().catch(() => null);
      if (refreshed) {
        bearer = refreshed;
        res = await introspect(bearer);
      }
    }

    return {
      ...res,
      hasToken: true,
      tokenPreview: `${bearer.slice(0, 4)}...${bearer.slice(-2)}`,
    };
  }

  function normalizeKickEventSubscriptionRows(listResponse) {
    const rows = Array.isArray(listResponse?.data?.data) ? listResponse.data.data : [];
    return rows
      .map((row) => {
        const eventName = String(row?.event || row?.name || '').trim();
        if (!eventName) return null;
        return {
          id: String(row?.id || '').trim(),
          event: eventName,
          version: Number(row?.version || 1) || 1,
          createdAt: String(row?.created_at || '').trim() || null,
          broadcasterUserId: String(row?.broadcaster_user_id || '').trim() || null,
        };
      })
      .filter(Boolean);
  }

  function formatKickMonitorAlert(code, severity, message, details = null) {
    return {
      code: String(code || 'monitor'),
      severity: severity === 'critical' ? 'critical' : (severity === 'warn' ? 'warn' : 'info'),
      message: String(message || '').trim(),
      details: details || null,
      at: new Date().toISOString(),
    };
  }

  function mapKickSubscriberRow(row) {
    const expiresAt = String(row?.expires_at || '').trim() || null;
    const expiresTs = expiresAt ? Date.parse(expiresAt) : NaN;
    const notExpired = !Number.isFinite(expiresTs) || expiresTs >= Date.now();
    const active = row?.is_active !== false && notExpired;
    return {
      id: String(row?.id || ''),
      mode: String(row?.mode || 'prod'),
      channel: String(row?.channel_slug || ''),
      userId: String(row?.user_id || ''),
      username: String(row?.username || ''),
      isActive: !!active,
      expiresAt,
      lastEventAt: String(row?.last_event_at || '').trim() || null,
      lastEventType: String(row?.last_event_type || '').trim() || '',
      updatedAt: String(row?.updated_at || '').trim() || null,
    };
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

  async function loadKickModeContext(modeOverride = null) {
    const baseCfg = withKickMode(loadConfig(), modeOverride);
    const mode = baseCfg.kickBotMode === 'dev' ? 'dev' : 'prod';
    if (!state.supabase) {
      const emptyCfg = stripKickFieldsFromCfg(baseCfg);
      return {
        ok: false,
        error: 'Sin conexión a Supabase',
        cfg: emptyCfg,
        mode,
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
        mode,
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
        mode,
        creds: getKickCreds(emptyCfg),
        broadcasterRow: null,
        botRow: null,
      };
    }
  }

  function makeKickBucket(cfg) {
    const creds = getKickCreds(cfg);
    return {
      clientId: creds.clientId || '',
      clientSecret: creds.clientSecret || '',
      channel: creds.channel || '',
      chatroomId: creds.chatroomId || '',
      hasToken: !!creds.accessToken,
      hasBotToken: !!creds.botAccessToken,
      rewardId: creds.rewardId || '',
    };
  }

  function pickFirstNonEmpty(...values) {
    for (const value of values) {
      const str = String(value == null ? '' : value).trim();
      if (str) return str;
    }
    return '';
  }

  function normalizeKickImageUrl(value) {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object') {
      return pickFirstNonEmpty(
        value.url,
        value.src,
        value.original,
        value.medium,
        value.small
      );
    }
    return '';
  }

  function emptyKickIdentity(role, mode, base = {}) {
    return {
      role,
      mode,
      authorized: false,
      validToken: false,
      username: '',
      displayName: '',
      channel: String(base?.channel || '').trim(),
      userId: '',
      avatarUrl: '',
      statusText: role === 'broadcaster' ? 'Cuenta canal sin autorizar' : 'Cuenta bot sin autorizar',
      error: '',
    };
  }

  function mergeKickIdentity(base, patch) {
    return {
      ...base,
      ...patch,
      role: patch?.role || base.role,
      mode: patch?.mode || base.mode,
      username: pickFirstNonEmpty(patch?.username, base.username),
      displayName: pickFirstNonEmpty(patch?.displayName, patch?.username, base.displayName, base.username),
      channel: pickFirstNonEmpty(patch?.channel, base.channel),
      userId: pickFirstNonEmpty(patch?.userId, base.userId),
      avatarUrl: pickFirstNonEmpty(patch?.avatarUrl, base.avatarUrl),
      statusText: pickFirstNonEmpty(patch?.statusText, base.statusText),
      error: String(patch?.error || base.error || '').trim(),
      authorized: patch?.authorized !== undefined ? !!patch.authorized : !!base.authorized,
      validToken: patch?.validToken !== undefined ? !!patch.validToken : !!base.validToken,
    };
  }

  function extractIdentityFromUsersResponse(response, base) {
    const row = response?.data?.data?.[0] || null;
    if (!row || typeof row !== 'object') return null;
    const username = pickFirstNonEmpty(row.username, row.name, row.slug, row.login);
    const displayName = pickFirstNonEmpty(row.name, row.display_name, row.username, row.slug);
    const userId = pickFirstNonEmpty(row.user_id, row.id);
    const avatarUrl = pickFirstNonEmpty(
      normalizeKickImageUrl(row.profile_picture),
      normalizeKickImageUrl(row.profile_pic),
      normalizeKickImageUrl(row.avatar),
      normalizeKickImageUrl(row.image)
    );
    if (!username && !userId) return null;
    return mergeKickIdentity(base, {
      authorized: true,
      validToken: true,
      username,
      displayName,
      userId,
      avatarUrl,
      statusText: `${base.role === 'broadcaster' ? 'Cuenta canal' : 'Cuenta bot'} autorizada`,
    });
  }

  function extractIdentityFromChannelsResponse(response, base) {
    const row = response?.data?.data?.[0] || null;
    if (!row || typeof row !== 'object') return null;
    const user = row.user && typeof row.user === 'object' ? row.user : {};
    const username = pickFirstNonEmpty(
      row.broadcaster_user_login,
      row.slug,
      user.username,
      user.name
    );
    const displayName = pickFirstNonEmpty(
      user.name,
      user.display_name,
      row.slug,
      row.broadcaster_user_login
    );
    const channel = pickFirstNonEmpty(row.slug, row.channel, base.channel);
    const userId = pickFirstNonEmpty(row.broadcaster_user_id, user.id, user.user_id);
    const avatarUrl = pickFirstNonEmpty(
      normalizeKickImageUrl(user.profile_pic),
      normalizeKickImageUrl(user.profile_picture),
      normalizeKickImageUrl(row.profile_picture),
      normalizeKickImageUrl(row.profile_pic)
    );
    if (!username && !channel && !userId) return null;
    return mergeKickIdentity(base, {
      authorized: true,
      validToken: true,
      username,
      displayName: displayName || username,
      channel,
      userId,
      avatarUrl,
      statusText: `${base.role === 'broadcaster' ? 'Cuenta canal' : 'Cuenta bot'} autorizada`,
    });
  }

  async function kickRefreshBotTokenForMode(modeOverride = null) {
    const ctx = await loadKickModeContext(modeOverride);
    if (!ctx.ok) return null;
    const cfg = ctx.cfg;
    const creds = ctx.creds;
    if (!creds.botRefreshToken || !creds.clientId || !creds.clientSecret) return null;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.botRefreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }).toString();
    const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (!r?.data?.access_token) return null;
    state.kickBotAccessToken = r.data.access_token;
    if (state.supabase) {
      try {
        await state.supabase.from('kick_tokens').upsert({
          id: getKickBotRowId(cfg),
          access_token: r.data.access_token,
          refresh_token: r.data.refresh_token || creds.botRefreshToken || '',
          updated_at: new Date().toISOString(),
        });
      } catch (_) {}
    }
    return r.data.access_token;
  }

  async function resolveKickIdentity({ role, mode, token, defaultChannel, refreshTokenFn = null }) {
    const base = emptyKickIdentity(role, mode, { channel: defaultChannel });
    const initialToken = String(token || '').trim();
    if (!initialToken) return base;
    let bearer = initialToken;
    base.authorized = true;

    const fetchUsers = async () => kickApiRequest('GET', '/public/v1/users', null, bearer);
    const fetchChannels = async () => kickApiRequest('GET', '/public/v1/channels', null, bearer);

    let usersRes = await fetchUsers().catch(() => ({ status: 0, data: null }));
    if (Number(usersRes?.status || 0) === 401 && typeof refreshTokenFn === 'function') {
      const refreshed = await refreshTokenFn().catch(() => null);
      if (refreshed) {
        bearer = refreshed;
        usersRes = await fetchUsers().catch(() => ({ status: 0, data: null }));
      }
    }
    const usersIdentity = extractIdentityFromUsersResponse(usersRes, base);

    let channelsRes = await fetchChannels().catch(() => ({ status: 0, data: null }));
    if (Number(channelsRes?.status || 0) === 401 && typeof refreshTokenFn === 'function') {
      const refreshed = await refreshTokenFn().catch(() => null);
      if (refreshed) {
        bearer = refreshed;
        channelsRes = await fetchChannels().catch(() => ({ status: 0, data: null }));
      }
    }
    const channelsIdentity = extractIdentityFromChannelsResponse(channelsRes, usersIdentity || base);
    const identity = channelsIdentity || usersIdentity || base;

    const statusCandidates = [Number(usersRes?.status || 0), Number(channelsRes?.status || 0)].filter((s) => s > 0);
    const status = statusCandidates.length ? Math.max(...statusCandidates) : 0;
    if (identity.validToken) return identity;

    if (status === 401) {
      return mergeKickIdentity(identity, {
        validToken: false,
        statusText: `${role === 'broadcaster' ? 'Cuenta canal' : 'Cuenta bot'} con token vencido`,
        error: 'token_expired',
      });
    }
    if (status === 403) {
      return mergeKickIdentity(identity, {
        validToken: false,
        statusText: `${role === 'broadcaster' ? 'Cuenta canal' : 'Cuenta bot'} sin permisos`,
        error: 'forbidden',
      });
    }
    return mergeKickIdentity(identity, {
      validToken: false,
      statusText: `${role === 'broadcaster' ? 'Cuenta canal' : 'Cuenta bot'} sin verificar`,
      error: 'unreachable',
    });
  }

  async function getKickModeIdentities(modeOverride = null) {
    const ctx = await loadKickModeContext(modeOverride);
    const mode = ctx.mode === 'dev' ? 'dev' : 'prod';
    const cfg = ctx.cfg;
    const routing = resolveKickRouting(cfg);
    const channelHint = normalizeKickChannel(routing.activeChannel || '');

    const broadcaster = await resolveKickIdentity({
      role: 'broadcaster',
      mode,
      token: ctx.creds.accessToken,
      defaultChannel: channelHint,
      refreshTokenFn: () => kickRefreshAccessToken(modeOverride || undefined),
    });

    const bot = await resolveKickIdentity({
      role: 'bot',
      mode,
      token: ctx.creds.botAccessToken,
      defaultChannel: '',
      refreshTokenFn: () => kickRefreshBotTokenForMode(modeOverride || undefined),
    });

    return {
      mode,
      broadcaster,
      bot,
    };
  }

  async function persistKickSongRequestRewardId(rewardId, modeOverride = null, options = {}) {
    const ctx = await loadKickModeContext(modeOverride);
    const cfg = ctx.cfg;
    const nextId = String(rewardId || '').trim();
    const allowClear = options?.allowClear === true;
    const reason = String(options?.reason || 'unspecified');
    const currentId = String(getActiveSongRequestRewardId(cfg) || '').trim();

    if (!nextId && !allowClear) {
      saveLog('warn', `[Kick reward_id] intento de limpiar bloqueado (mode=${cfg.kickBotMode === 'dev' ? 'dev' : 'prod'}, reason=${reason})`);
      return currentId;
    }

    if (state.supabase) {
      const upd = { id: getKickBroadcasterRowId(cfg), updated_at: new Date().toISOString(), reward_id: nextId };
      try {
        await state.supabase.from('kick_tokens').upsert(upd);
      } catch (_) {}
    }
    state.songRequestRewardId = nextId;
    saveLog('info', `[Kick reward_id] persistido mode=${cfg.kickBotMode === 'dev' ? 'dev' : 'prod'} reason=${reason} value=${nextId || '(empty)'}`);
    return nextId;
  }

  async function kickRequestWithRefresh(method, endpoint, body, modeOverride = null) {
    const ctx = await loadKickModeContext(modeOverride);
    if (!ctx.ok) {
      return { status: 0, data: { message: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` } };
    }
    let token = ctx.creds.accessToken;
    if (!token) return { status: 401, data: { message: 'Sin token de Kick autorizado.' } };
    state.kickAccessToken = token;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const retries = 2;
    const baseDelayMs = 450;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let r = await kickApiRequest(method, endpoint, body, token);
      if (r.status === 401 && kickRefreshAccessToken) {
        token = await kickRefreshAccessToken(modeOverride || undefined);
        if (token) {
          state.kickAccessToken = token;
          r = await kickApiRequest(method, endpoint, body, token);
        } else {
          return { status: 401, data: { message: 'Token de Kick vencido o revocado. Reautorizá en Config > Kick.' } };
        }
      }

      const status = Number(r?.status || 0);
      const retryable = status === 0 || status === 429 || status >= 500;
      if (!retryable || attempt >= retries) return r;

      const retryAfterHeader = r?.headers?.['retry-after'] || r?.headers?.['Retry-After'] || '';
      let retryAfterMs = 0;
      const retryAfterNum = Number(retryAfterHeader);
      if (Number.isFinite(retryAfterNum) && retryAfterNum > 0) {
        retryAfterMs = retryAfterNum * 1000;
      } else if (typeof retryAfterHeader === 'string' && retryAfterHeader.trim()) {
        const retryAt = Date.parse(retryAfterHeader);
        if (Number.isFinite(retryAt)) retryAfterMs = Math.max(0, retryAt - Date.now());
      }
      if (!retryAfterMs) retryAfterMs = baseDelayMs * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 180);
      await sleep(Math.min(retryAfterMs + jitter, 8000));
    }

    return { status: 0, data: { message: 'Kick retry exhausted' } };
  }

  async function kickFetchAllRewards(modeOverride = null) {
    const out = [];
    const seen = new Set();
    const perPage = 100;
    const maxPages = 20;

    for (let page = 1; page <= maxPages; page++) {
      const endpoint = `/public/v1/channels/rewards?page=${page}&per_page=${perPage}`;
      const r = await kickRequestWithRefresh('GET', endpoint, null, modeOverride);
      if (r.status !== 200) return { ok: false, response: r };

      const rows = Array.isArray(r.data?.data) ? r.data.data : [];
      let added = 0;
      for (const item of rows) {
        const id = String(item?.id || '');
        const key = id || JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        added++;
      }

      const hasNext =
        !!r.data?.links?.next ||
        !!r.data?.pagination?.next_page ||
        !!r.data?.meta?.next_page;

      if (!rows.length) break;
      if (added === 0) break; // endpoint no paginado o página repetida
      if (rows.length < perPage && !hasNext) break;
    }

    return { ok: true, rewards: out };
  }

  async function ensureKickTokenMatchesActiveChannel(modeOverride = null) {
    const ctx = await loadKickModeContext(modeOverride);
    if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
    const cfg = ctx.cfg;
    const routing = resolveKickRouting(cfg);
    const expectedChannel = normalizeKickChannel(routing.activeChannel || '');
    const modeLabel = routing.mode === 'dev' ? 'dev' : 'prod';
    if (!expectedChannel) {
      return { ok: false, error: 'Canal de Kick no configurado para el modo activo.' };
    }

    const me = await kickRequestWithRefresh('GET', '/public/v1/channels', null, modeOverride);
    if (me.status !== 200) {
      return { ok: false, error: mapKickRewardError(me, 'No pude validar la cuenta autorizada de Kick') };
    }
    const tokenChannel = normalizeKickChannel(me?.data?.data?.[0]?.slug || me?.data?.data?.[0]?.broadcaster_user_login || '');
    if (!tokenChannel) {
      return { ok: false, error: 'No pude identificar el canal de la cuenta autorizada en Kick.' };
    }
    if (tokenChannel !== expectedChannel) {
      return {
        ok: false,
        error: `Token de ${modeLabel} autorizado como @${tokenChannel}, pero el canal configurado es @${expectedChannel}. Reautorizá la cuenta canal en ${modeLabel.toUpperCase()}.`,
      };
    }
    return { ok: true, channel: tokenChannel };
  }

  ipcMain.handle('kick-connect-oauth', async (_, payload = {}) => {
    try {
      const mode = pickKickMode(payload);
      const clientId = String(payload?.clientId || '').trim();
      const clientSecret = String(payload?.clientSecret || '').trim();
      const kickChannel = String(payload?.kickChannel || '').trim();
      if (!clientId || !clientSecret) return { ok: false, error: 'Faltan client ID/secret de Kick.' };
      if (!state.supabase) return { ok: false, error: 'Kick requiere Supabase activo para guardar credenciales.' };
      const currentCtx = await loadKickModeContext(mode);
      const cfg = currentCtx.cfg;
      const expectedChannel = normalizeKickChannel(kickChannel || currentCtx.creds.channel || '');
      const code = await startKickOAuthFlow(clientId);
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: KICK_REDIRECT_URI,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: (getKickCodeVerifier && getKickCodeVerifier()) || ''
      }).toString();
      const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token',
        { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
      if (!r.data?.access_token) return { ok: false, error: r.data?.error_description || 'No se recibió token' };
      const accessToken = r.data.access_token;
      // Detectar el canal real del token consultando /public/v1/channels (sin filtro)
      let detectedSlug = '';
      try {
        const me = await kickApiRequest('GET', '/public/v1/channels', null, accessToken);
        detectedSlug = normalizeKickChannel(me?.data?.data?.[0]?.slug || me?.data?.data?.[0]?.broadcaster_user_login || '');
      } catch (_) {}
      const modeLabel = cfg.kickBotMode === 'dev' ? 'dev' : 'prod';
      if (detectedSlug && expectedChannel && detectedSlug !== expectedChannel) {
        return {
          ok: false,
          error: `Autorizaste @${detectedSlug}, pero en ${modeLabel.toUpperCase()} el canal esperado es @${expectedChannel}. Cambiá de cuenta en kick.com y reintentá.`,
        };
      }
      const finalChannel = detectedSlug || normalizeKickChannel(kickChannel);
      state.kickAccessToken = accessToken;
      const upd = {
        id: getKickBroadcasterRowId(cfg),
        client_id: clientId,
        client_secret: clientSecret,
        access_token: accessToken,
        refresh_token: r.data.refresh_token || '',
        updated_at: new Date().toISOString()
      };
      if (finalChannel) upd.channel = finalChannel;
      await state.supabase.from('kick_tokens').upsert(upd);
      saveLog('info', `Kick: autorizado como @${finalChannel || '(?)'} en modo ${modeLabel}`);
      const identities = await getKickModeIdentities(mode);
      return { ok: true, channel: finalChannel, mode: modeLabel, identities };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('kick-bot-connect', (_, input) => connectKickBot(pickKickMode(input) || undefined));

  ipcMain.handle('kick-bot-oauth', async (_, input) => {
    try {
      const ctx = await loadKickModeContext(pickKickMode(input));
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const cfg = ctx.cfg;
      const creds = ctx.creds;
      const clientId = creds.clientId;
      const clientSecret = creds.clientSecret;
      if (!clientId || !clientSecret) return { ok: false, error: 'Guardá el Client ID y Secret primero para el modo actual' };
      const code = await startKickOAuthFlow(clientId);
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: KICK_REDIRECT_URI,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: (getKickCodeVerifier && getKickCodeVerifier()) || ''
      }).toString();
      const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token',
        { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
      if (!r.data?.access_token) return { ok: false, error: r.data?.error_description || 'No se recibió token' };
      state.kickBotAccessToken = r.data.access_token;
      try {
        await state.supabase.from('kick_tokens').upsert({
          id: getKickBotRowId(cfg),
          access_token: r.data.access_token,
          refresh_token: r.data.refresh_token || '',
          updated_at: new Date().toISOString()
        });
      } catch (_) {}
      const mode = pickKickMode(input);
      const identities = await getKickModeIdentities(mode);
      return { ok: true, identities };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('kick-reset-tokens', async (_, input = {}) => {
    try {
      if (!state.supabase) return { ok: false, error: 'Kick requiere Supabase activo: sin conexión' };
      const mode = pickKickMode(input);
      const scope = String(input?.scope || '').trim().toLowerCase();
      const resetAll = scope === 'all' || (!mode && !scope);

      const targetRows = resetAll
        ? [1, 2, 3, 4]
        : (() => {
            const cfg = withKickMode(loadConfig(), mode || 'prod');
            return [getKickBroadcasterRowId(cfg), getKickBotRowId(cfg)];
          })();

      const nowIso = new Date().toISOString();
      const updates = targetRows.map((id) => state.supabase.from('kick_tokens').upsert({
        id,
        client_id: '',
        client_secret: '',
        channel: '',
        chatroom_id: '',
        reward_id: '',
        access_token: '',
        refresh_token: '',
        updated_at: nowIso,
      }));
      await Promise.all(updates);

      const cfg = loadConfig();
      const clearProd = () => {
        cfg.kickClientId = '';
        cfg.kickClientSecret = '';
        cfg.kickChannel = '';
        cfg.kickChatroomId = '';
        cfg.kickAccessToken = '';
        cfg.kickRefreshToken = '';
        cfg.kickBotAccessToken = '';
        cfg.kickBotRefreshToken = '';
        cfg.kickSongRequestRewardId = '';
      };
      const clearDev = () => {
        cfg.kickClientIdDev = '';
        cfg.kickClientSecretDev = '';
        cfg.kickDevChannel = '';
        cfg.kickChatroomIdDev = '';
        cfg.kickAccessTokenDev = '';
        cfg.kickRefreshTokenDev = '';
        cfg.kickBotAccessTokenDev = '';
        cfg.kickBotRefreshTokenDev = '';
        cfg.kickSongRequestRewardIdDev = '';
      };
      if (resetAll) {
        clearProd();
        clearDev();
        cfg.songRequestRewardId = '';
      } else if (mode === 'dev') {
        clearDev();
      } else {
        clearProd();
      }
      saveConfig(cfg);

      if (typeof disconnectKickBot === 'function') {
        await disconnectKickBot(mode || null, { cleanupRemote: true });
      } else {
        stopKickPolling();
        state.kickChannelId = null;
        state.kickAccessToken = null;
        state.kickBotAccessToken = null;
      }
      state.songRequestRewardId = '';
      state.mainWindow?.webContents.send('kick-bot-status', {
        connected: false,
        channel: null,
        reason: 'Tokens de Kick reseteados',
      });
      state.mainWindow?.webContents.send('kick-config-loaded', {});

      const scopeLabel = resetAll ? 'all' : (mode === 'dev' ? 'dev' : 'prod');
      saveLog('warn', `Kick: reset total en Supabase (${scopeLabel}) y limpieza local completada. Reautorizá las cuentas.`);
      return { ok: true, scope: scopeLabel };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('kick-bot-disconnect', async (_, input) => {
    const mode = pickKickMode(input) || undefined;
    if (typeof disconnectKickBot === 'function') {
      await disconnectKickBot(mode, { cleanupRemote: true });
    } else {
      stopKickPolling();
      state.kickChannelId = null;
      state.kickAccessToken = null;
      state.kickBotAccessToken = null;
    }
    state.mainWindow?.webContents.send('kick-bot-status', { connected: false, channel: null });
    saveLog('info', 'Kick bot desconectado manualmente');
    return { ok: true };
  });

  ipcMain.handle('kick-bot-status', async (_, input) => {
    const ctx = await loadKickModeContext(pickKickMode(input));
    const cfg = ctx.cfg;
    const routing = resolveKickRouting(cfg);
    return {
      connected: !!state.kickPollTimer,
      channel: routing.activeChannel || '',
      mode: routing.mode,
    };
  });

  ipcMain.handle('kick-get-config', async (_, input) => {
    const cfg = withKickMode(loadConfig(), pickKickMode(input));
    const mode = cfg.kickBotMode === 'dev' ? 'dev' : 'prod';
    const [prodCtx, devCtx] = await Promise.all([
      loadKickModeContext('prod'),
      loadKickModeContext('dev'),
    ]);
    const prodBucket = makeKickBucket(prodCtx.cfg);
    const devBucket = makeKickBucket(devCtx.cfg);
    const prodChannel = normalizeKickChannel(prodBucket.channel);
    const devChannel = normalizeKickChannel(devBucket.channel);
    const activeChannel = (mode === 'dev') ? devChannel : prodChannel;

    const identities = await getKickModeIdentities(mode);
    return {
      ok: true,
      kickBotMode: mode,
      activeChannel: activeChannel || '',
      autoConnectKickBot: cfg.autoConnectKickBot !== false,
      connected: !!state.kickPollTimer,
      prod: prodBucket,
      dev: devBucket,
      identities,
    };
  });

  ipcMain.handle('kick-get-identities', async (_, input) => {
    const mode = pickKickMode(input);
    try {
      const identities = await getKickModeIdentities(mode);
      return { ok: true, identities };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('kick-monitor-get', async (_, input = {}) => {
    const mode = pickKickMode(input);
    const alerts = [];
    try {
      const ctx = await loadKickModeContext(mode);
      const effectiveMode = ctx.mode === 'dev' ? 'dev' : 'prod';
      const cfg = ctx.cfg;
      const routing = resolveKickRouting(cfg);
      const channel = normalizeKickChannel(routing.activeChannel || '');
      const connected = !!state.kickPollTimer;
      const hasSupabase = !!state.supabase;

      const broadcasterToken = ctx.creds?.accessToken || '';
      const botToken = ctx.creds?.botAccessToken || '';

      const broadcasterState = await kickTokenIntrospectWithRefresh({
        token: broadcasterToken,
        refreshFn: () => kickRefreshAccessToken(effectiveMode),
        requiredScopes: KICK_MONITOR_REQUIRED_BROADCASTER_SCOPES,
      });
      const broadcasterScopeSet = new Set(broadcasterState.scopes || []);
      const broadcasterMissingRewardAny = !KICK_MONITOR_REQUIRED_BROADCASTER_REWARD_ANY
        .some((scope) => broadcasterScopeSet.has(scope));
      const broadcasterOptionalMissingScopes = KICK_MONITOR_OPTIONAL_BROADCASTER_SCOPES
        .filter((scope) => !broadcasterScopeSet.has(scope));
      const botState = await kickTokenIntrospectWithRefresh({
        token: botToken,
        refreshFn: () => kickRefreshBotTokenForMode(effectiveMode),
        requiredScopes: KICK_MONITOR_REQUIRED_BOT_SCOPES,
      });

      if (!broadcasterState.hasToken) {
        alerts.push(formatKickMonitorAlert(
          'scope.broadcaster.missing_token',
          'critical',
          'La cuenta del canal no tiene token en este modo.'
        ));
      } else if (!broadcasterState.active) {
        alerts.push(formatKickMonitorAlert(
          'scope.broadcaster.inactive',
          'critical',
          'El token de la cuenta del canal está inactivo o vencido.'
        ));
      } else if (broadcasterState.missingScopes.length) {
        alerts.push(formatKickMonitorAlert(
          'scope.broadcaster.missing',
          'critical',
          `Faltan scopes en la cuenta del canal: ${broadcasterState.missingScopes.join(', ')}.`
        ));
      } else if (broadcasterMissingRewardAny) {
        alerts.push(formatKickMonitorAlert(
          'scope.broadcaster.missing_reward_scope',
          'critical',
          'Falta scope de rewards en la cuenta del canal: necesitás channel:rewards:read o channel:rewards:write.'
        ));
      } else if (broadcasterOptionalMissingScopes.length) {
        alerts.push(formatKickMonitorAlert(
          'scope.broadcaster.optional_missing',
          'warn',
          `Scopes opcionales faltantes en la cuenta del canal: ${broadcasterOptionalMissingScopes.join(', ')}. Algunas funciones de edición de rewards pueden no estar disponibles.`
        ));
      }

      if (!botState.hasToken) {
        alerts.push(formatKickMonitorAlert(
          'scope.bot.missing_token',
          'warn',
          'La cuenta bot no tiene token en este modo.'
        ));
      } else if (!botState.active) {
        alerts.push(formatKickMonitorAlert(
          'scope.bot.inactive',
          'warn',
          'El token de la cuenta bot está inactivo o vencido.'
        ));
      } else if (botState.missingScopes.length) {
        alerts.push(formatKickMonitorAlert(
          'scope.bot.missing',
          'critical',
          `Faltan scopes en la cuenta bot: ${botState.missingScopes.join(', ')}.`
        ));
      }

      let subscriptions = {
        ok: false,
        status: 0,
        total: 0,
        activeRequired: 0,
        missingRequired: [...KICK_MONITOR_REQUIRED_EVENTS],
        required: KICK_MONITOR_REQUIRED_EVENTS.map((name) => ({ name, active: false })),
        sample: [],
        label: 'Sin datos',
      };

      if (broadcasterState.active && !broadcasterState.missingScopes.length) {
        const subRes = await kickApiRequest(
          'GET',
          '/public/v1/events/subscriptions',
          null,
          state.kickAccessToken || ctx.creds.accessToken
        ).catch(() => ({ status: 0, data: null }));
        const subRows = normalizeKickEventSubscriptionRows(subRes);
        const byEvent = new Set(subRows.map((row) => row.event));
        const missingRequired = KICK_MONITOR_REQUIRED_EVENTS.filter((evt) => !byEvent.has(evt));
        const required = KICK_MONITOR_REQUIRED_EVENTS.map((name) => ({ name, active: byEvent.has(name) }));
        subscriptions = {
          ok: Number(subRes?.status || 0) === 200,
          status: Number(subRes?.status || 0),
          total: subRows.length,
          activeRequired: required.filter((row) => row.active).length,
          missingRequired,
          required,
          sample: subRows.slice(0, 12),
          label: Number(subRes?.status || 0) === 200
            ? (missingRequired.length
              ? `Faltan ${missingRequired.length} eventos requeridos`
              : `OK (${required.length}/${required.length})`)
            : `Error ${Number(subRes?.status || 0) || 0}`,
        };
        if (!subscriptions.ok) {
          const isRateLimit = Number(subscriptions.status || 0) === 429;
          alerts.push(formatKickMonitorAlert(
            isRateLimit ? 'subscriptions.read_rate_limited' : 'subscriptions.read_failed',
            isRateLimit ? 'warn' : 'critical',
            isRateLimit
              ? 'Kick devolvió rate-limit temporal al leer subscriptions (429).'
              : `No pude leer subscriptions de Kick (status ${subscriptions.status || 0}).`
          ));
        } else if (missingRequired.length) {
          alerts.push(formatKickMonitorAlert(
            connected ? 'subscriptions.missing_required' : 'subscriptions.missing_while_disconnected',
            connected ? 'critical' : 'warn',
            connected
              ? `Faltan eventos requeridos: ${missingRequired.join(', ')}.`
              : `Faltan eventos requeridos (${missingRequired.join(', ')}), pero el bot está desconectado.`
          ));
        }
      } else {
        subscriptions.label = 'Sin token broadcaster usable';
      }

      let webhook = {
        ok: false,
        label: hasSupabase ? 'Sin datos' : 'Supabase desconectado',
        hasTable: false,
        totalPending: null,
        totalRecent: null,
        signatureInvalidRecent: null,
        processErrorsRecent: null,
        lastEventAt: null,
        lastEventType: '',
        secondsSinceLastEvent: null,
      };

      if (!hasSupabase) {
        alerts.push(formatKickMonitorAlert(
          'supabase.offline',
          'critical',
          'No hay conexión a Supabase para validar webhooks.'
        ));
      } else {
        const recentSinceIso = new Date(Date.now() - (60 * 60 * 1000)).toISOString();
        let pendingRes = await state.supabase
          .from('kick_events')
          .select('id', { count: 'exact', head: true })
          .is('processed_at', null);
        if (pendingRes.error && isKickEventsProcessedColumnMissingError(pendingRes.error)) {
          // Compatibilidad con esquemas viejos donde kick_events no tiene processed_at.
          pendingRes = await state.supabase
            .from('kick_events')
            .select('id', { count: 'exact', head: true });
        }
        const recentRes = await state.supabase
          .from('kick_events')
          .select('id', { count: 'exact', head: true })
          .gte('created_at', recentSinceIso);
        const lastRes = await state.supabase
          .from('kick_events')
          .select('event_type,created_at')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        let invalidSignaturesRes = await state.supabase
          .from('kick_events')
          .select('id', { count: 'exact', head: true })
          .eq('signature_valid', false)
          .gte('created_at', recentSinceIso);
        if (invalidSignaturesRes.error && isKickEventsColumnMissingError(invalidSignaturesRes.error, 'signature_valid')) {
          invalidSignaturesRes = { data: null, count: 0, error: null };
        }
        let processErrorsRes = await state.supabase
          .from('kick_events')
          .select('id', { count: 'exact', head: true })
          .neq('processed_error', '')
          .gte('created_at', recentSinceIso);
        if (processErrorsRes.error && isKickEventsColumnMissingError(processErrorsRes.error, 'processed_error')) {
          processErrorsRes = { data: null, count: 0, error: null };
        }

        if (pendingRes.error || recentRes.error || lastRes.error || invalidSignaturesRes.error || processErrorsRes.error) {
          const firstError = pendingRes.error || recentRes.error || lastRes.error || invalidSignaturesRes.error || processErrorsRes.error;
          const missingTable = isKickEventsTableMissingError(firstError);
          webhook = {
            ...webhook,
            ok: false,
            hasTable: !missingTable,
            label: missingTable ? 'Falta tabla kick_events' : (firstError?.message || 'Error leyendo kick_events'),
          };
          alerts.push(formatKickMonitorAlert(
            'webhook.table_error',
            missingTable ? 'warn' : 'critical',
            webhook.label
          ));
        } else {
          const pending = Number(pendingRes.count || 0);
          const recent = Number(recentRes.count || 0);
          const invalidSignatureRecent = Number(invalidSignaturesRes.count || 0);
          const processErrorsRecent = Number(processErrorsRes.count || 0);
          const lastEventAt = String(lastRes.data?.created_at || '').trim() || null;
          const lastEventType = String(lastRes.data?.event_type || '').trim();
          const secondsSinceLastEvent = lastEventAt
            ? Math.max(0, Math.round((Date.now() - Date.parse(lastEventAt)) / 1000))
            : null;
          const label = pending > 40
            ? `Backlog alto (${pending})`
            : (invalidSignatureRecent > 0
              ? `Firmas inválidas (${invalidSignatureRecent})`
              : (processErrorsRecent > 0
                ? `Errores procesamiento (${processErrorsRecent})`
                : 'Pipeline OK'));
          webhook = {
            ok: true,
            label,
            hasTable: true,
            totalPending: pending,
            totalRecent: recent,
            signatureInvalidRecent: invalidSignatureRecent,
            processErrorsRecent,
            lastEventAt,
            lastEventType,
            secondsSinceLastEvent: Number.isFinite(secondsSinceLastEvent) ? secondsSinceLastEvent : null,
          };
          if (pending > 40) {
            alerts.push(formatKickMonitorAlert(
              'webhook.backlog_high',
              'warn',
              `Hay ${pending} eventos pendientes en kick_events.`
            ));
          }
          if (connected && recent === 0) {
            alerts.push(formatKickMonitorAlert(
              'webhook.no_recent_events',
              'warn',
              'No hubo eventos Kick en la última hora.'
            ));
          }
          if (invalidSignatureRecent > 0) {
            alerts.push(formatKickMonitorAlert(
              'webhook.invalid_signatures',
              'critical',
              `Se detectaron ${invalidSignatureRecent} webhooks con firma inválida en la última hora.`
            ));
          }
          if (processErrorsRecent > 0) {
            alerts.push(formatKickMonitorAlert(
              'webhook.process_errors',
              'warn',
              `Se detectaron ${processErrorsRecent} eventos con error de procesamiento en la última hora.`
            ));
          }
        }
      }

      let errorQueue = {
        ok: hasSupabase,
        label: hasSupabase ? 'Sin datos' : 'Supabase desconectado',
        total: 0,
        rows: [],
      };
      if (hasSupabase) {
        const logRes = await state.supabase
          .from('app_logs')
          .select('id,type,msg,created_at')
          .order('created_at', { ascending: false })
          .limit(120);
        if (logRes.error) {
          errorQueue = {
            ok: false,
            label: logRes.error?.message || 'No pude leer app_logs',
            total: 0,
            rows: [],
          };
          alerts.push(formatKickMonitorAlert('logs.read_failed', 'warn', errorQueue.label));
        } else {
          const keywords = ['kick', 'songrequest', 'song request', 'reward', 'webhook', 'chat'];
          const recentKickErrors = (Array.isArray(logRes.data) ? logRes.data : [])
            .filter((row) => {
              const msg = String(row?.msg || '').toLowerCase();
              const type = String(row?.type || '').toLowerCase();
              const isInteresting = keywords.some((needle) => msg.includes(needle));
              const isProblem = type === 'warn' || type === 'error' || msg.includes('fall') || msg.includes('timeout');
              const benignRealtimeFallback = (
                msg.includes('kick realtime estado=timed_out')
                || msg.includes('kick realtime estado=closed')
              ) && msg.includes('se mantiene polling fallback');
              return isInteresting && isProblem && !benignRealtimeFallback;
            })
            .slice(0, 16)
            .map((row) => ({
              id: String(row?.id || ''),
              type: String(row?.type || ''),
              msg: String(row?.msg || '').slice(0, 240),
              createdAt: String(row?.created_at || ''),
            }));
          errorQueue = {
            ok: true,
            label: recentKickErrors.length ? `${recentKickErrors.length} alertas recientes` : 'Sin alertas recientes',
            total: recentKickErrors.length,
            rows: recentKickErrors,
          };
          if (recentKickErrors.length >= 8) {
            alerts.push(formatKickMonitorAlert(
              'logs.error_queue_high',
              'warn',
              `Se detectaron ${recentKickErrors.length} errores/avisos recientes de Kick/SR.`
            ));
          }
        }
      }

      if (!connected) {
        alerts.push(formatKickMonitorAlert(
          'bot.disconnected',
          'warn',
          'El bot de Kick está desconectado en esta instancia.'
        ));
      }

      const scopesOk = (
        broadcasterState.active
        && !broadcasterState.missingScopes.length
        && !broadcasterMissingRewardAny
        && botState.active
        && !botState.missingScopes.length
      );
      const subscriptionsOk = subscriptions.ok && !subscriptions.missingRequired.length;
      const webhookOk = webhook.ok && (Number(webhook.totalPending || 0) <= 40);
      const errorQueueOk = Number(errorQueue.total || 0) < 8;
      const criticalCount = alerts.filter((row) => row.severity === 'critical').length;
      const warnCount = alerts.filter((row) => row.severity === 'warn').length;

      return {
        ok: true,
        checkedAt: new Date().toISOString(),
        mode: effectiveMode,
        channel,
        connected,
        context: {
          hasSupabase,
          kickPollRunning: connected,
        },
        scopes: {
          ok: scopesOk,
          broadcaster: {
            ...broadcasterState,
            optionalMissingScopes: broadcasterOptionalMissingScopes,
            label: mapKickTokenStateLabel(broadcasterState),
          },
          bot: {
            ...botState,
            label: mapKickTokenStateLabel(botState),
          },
        },
        subscriptions: {
          ...subscriptions,
          ok: subscriptionsOk,
        },
        webhook,
        errorQueue,
        health: {
          ok: criticalCount === 0,
          criticalCount,
          warnCount,
        },
        chips: {
          scopes: scopesOk ? 'ok' : (broadcasterState.hasToken || botState.hasToken ? 'warn' : 'critical'),
          subscriptions: subscriptionsOk ? 'ok' : (subscriptions.status === 0 ? 'warn' : 'critical'),
          webhook: webhookOk ? 'ok' : (webhook.hasTable ? 'warn' : 'critical'),
          errors: errorQueueOk ? 'ok' : 'warn',
        },
        alerts,
      };
    } catch (e) {
      return { ok: false, error: e?.message || String(e), alerts };
    }
  });

  ipcMain.handle('kick-commands-get-config', async () => {
    ensureKickCommandsRealtime();
    const remote = await pullKickCommandsFromSupabase();
    if (remote) {
      applyKickCommandsConfig(remote, {
        persistLocal: true,
        broadcast: false,
      });
    }
    return {
      ok: true,
      config: normalizeKickCommandConfig(state.kickCommandConfig || DEFAULT_KICK_COMMAND_CONFIG),
    };
  });

  ipcMain.handle('kick-commands-set-config', async (_, payload = {}) => {
    ensureKickCommandsRealtime();
    const merged = normalizeKickCommandConfig(
      payload,
      normalizeKickCommandConfig(state.kickCommandConfig || DEFAULT_KICK_COMMAND_CONFIG)
    );
    const applied = applyKickCommandsConfig(merged, {
      persistLocal: true,
      broadcast: true,
      source: 'local',
    });
    const sync = await syncKickCommandsToSupabase('set-config');
    if (!sync.ok) {
      return {
        ok: true,
        synced: false,
        error: sync.error || 'No se pudo sincronizar comandos en Supabase',
        config: applied,
      };
    }
    return { ok: true, synced: true, config: applied };
  });

  ipcMain.handle('kick-subs-list', async (_, input = {}) => {
    try {
      if (!state.supabase) return { ok: false, error: 'Kick requiere Supabase activo: sin conexión' };
      const mode = pickKickMode(input);
      const ctx = await loadKickModeContext(mode);
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const routing = resolveKickRouting(ctx.cfg);
      const channel = normalizeKickChannel(routing.activeChannel || '');
      if (!channel) {
        return { ok: false, error: 'Canal de Kick no configurado para el modo activo.' };
      }

      const activeOnly = input?.activeOnly !== false;
      const limitRaw = Number(input?.limit || 300);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.round(limitRaw))) : 300;

      const { data, error } = await state.supabase
        .from('kick_subscribers')
        .select('id,mode,channel_slug,user_id,username,is_active,expires_at,last_event_at,last_event_type,updated_at')
        .eq('mode', routing.mode)
        .eq('channel_slug', channel)
        .order('expires_at', { ascending: true })
        .order('username', { ascending: true })
        .limit(limit);

      if (error) {
        if (isKickSubsTableMissingError(error)) {
          return {
            ok: false,
            error: 'Falta la tabla kick_subscribers en Supabase. Creala para habilitar la lista de subs.',
            code: 'subs_table_missing',
          };
        }
        return { ok: false, error: error?.message || String(error) };
      }

      const rows = (Array.isArray(data) ? data : []).map(mapKickSubscriberRow);
      const subscribers = activeOnly ? rows.filter((row) => row.isActive) : rows;
      return {
        ok: true,
        mode: routing.mode,
        channel,
        activeOnly,
        total: subscribers.length,
        totalStored: rows.length,
        subscribers,
      };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('kick-subs-clear', async (_, input = {}) => {
    try {
      if (!state.supabase) return { ok: false, error: 'Kick requiere Supabase activo: sin conexión' };
      const mode = pickKickMode(input);
      const ctx = await loadKickModeContext(mode);
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const routing = resolveKickRouting(ctx.cfg);
      const channel = normalizeKickChannel(routing.activeChannel || '');
      if (!channel) {
        return { ok: false, error: 'Canal de Kick no configurado para el modo activo.' };
      }

      const { error, count } = await state.supabase
        .from('kick_subscribers')
        .delete({ count: 'exact' })
        .eq('mode', routing.mode)
        .eq('channel_slug', channel);

      if (error) {
        if (isKickSubsTableMissingError(error)) {
          return {
            ok: false,
            error: 'Falta la tabla kick_subscribers en Supabase. Creala para habilitar la lista de subs.',
            code: 'subs_table_missing',
          };
        }
        return { ok: false, error: error?.message || String(error) };
      }
      return { ok: true, mode: routing.mode, channel, removed: Number(count || 0) };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  ipcMain.handle('kick-reward-toggle', async (_, input) => {
    try {
      const mode = pickKickMode(input);
      const enabled = (input && typeof input === 'object' && !Array.isArray(input))
        ? (input.enabled !== false)
        : (input !== false);
      const ctx = await loadKickModeContext(mode);
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const cfg = ctx.cfg;
      const rewardId = getActiveSongRequestRewardId(cfg);
      if (!ctx.creds.accessToken) return { ok: false, error: 'Primero autorizá Kick en Config.' };
      const aligned = await ensureKickTokenMatchesActiveChannel(mode);
      if (!aligned.ok) return { ok: false, error: aligned.error };
      if (!rewardId)               return { ok: false, error: 'No hay ID de recompensa configurado.' };
      const r = await kickRequestWithRefresh('PATCH', `/public/v1/channels/rewards/${rewardId}`, { is_enabled: enabled }, mode);
      if (r.status === 200) return { ok: true, enabled };
      if (r.status === 403) return { ok: false, error: 'Solo se puede modificar una reward creada por esta app.' };
      return { ok: false, error: mapKickRewardError(r) };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('kick-reward-get-status', async (_, input) => {
    try {
      const mode = pickKickMode(input);
      const ctx = await loadKickModeContext(mode);
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const cfg = ctx.cfg;
      const rewardId = getActiveSongRequestRewardId(cfg);
      if (!ctx.creds.accessToken || !rewardId) return { ok: false, error: 'config_missing' };
      const aligned = await ensureKickTokenMatchesActiveChannel(mode);
      if (!aligned.ok) return { ok: false, error: aligned.error };
      const fetchRes = await kickFetchAllRewards(mode);
      if (!fetchRes.ok) return { ok: false, error: mapKickRewardError(fetchRes.response) };
      const reward = (fetchRes.rewards || []).find(rw => String(rw?.id || '') === rewardId);
      if (!reward) {
        return {
          ok: false,
          error: 'No encontré esa reward en Kick. Si la borraste desde Kick, actualizá el reward ID en Config > Kick.',
        };
      }
      return { ok: true, enabled: !!reward.is_enabled };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('kick-reward-get', async (_, rewardIdInput) => {
    try {
      const mode = pickKickMode(rewardIdInput);
      const rewardIdArg = (rewardIdInput && typeof rewardIdInput === 'object' && !Array.isArray(rewardIdInput))
        ? rewardIdInput.rewardId
        : rewardIdInput;
      const ctx = await loadKickModeContext(mode);
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const cfg = ctx.cfg;
      const rewardId = String(rewardIdArg || getActiveSongRequestRewardId(cfg) || '').trim();
      if (!ctx.creds.accessToken) return { ok: false, error: 'Primero autorizá Kick en Config.' };
      const aligned = await ensureKickTokenMatchesActiveChannel(mode);
      if (!aligned.ok) return { ok: false, error: aligned.error };
      if (!rewardId) return { ok: false, error: 'Falta el ID de la reward.' };
      const fetchRes = await kickFetchAllRewards(mode);
      if (!fetchRes.ok) return { ok: false, error: mapKickRewardError(fetchRes.response) };
      const reward = (fetchRes.rewards || []).find(item => String(item?.id || '') === rewardId);
      if (!reward) {
        return {
          ok: false,
          error: 'No encontré esa reward en el canal conectado. Si la borraste/desactivaste afuera, actualizá el reward ID en Config > Kick.',
        };
      }
      return {
        ok: true,
        reward: {
          id: reward.id,
          title: reward.title || '',
          description: reward.description || '',
          cost: Number(reward.cost) || 1,
          is_enabled: !!reward.is_enabled,
          is_user_input_required: reward?.is_user_input_required !== false,
          should_redemptions_skip_request_queue: !!reward?.should_redemptions_skip_request_queue,
          background_color: normalizeKickRewardColor(reward?.background_color),
        },
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('kick-reward-update', async (_, payload) => {
    try {
      const mode = pickKickMode(payload);
      const ctx = await loadKickModeContext(mode);
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const cfg = ctx.cfg;
      const rewardId = String(payload?.rewardId || getActiveSongRequestRewardId(cfg) || '').trim();
      if (!ctx.creds.accessToken) return { ok: false, error: 'Primero autorizá Kick en Config.' };
      const aligned = await ensureKickTokenMatchesActiveChannel(mode);
      if (!aligned.ok) return { ok: false, error: aligned.error };
      if (!rewardId) return { ok: false, error: 'Falta el ID de la reward.' };

      const patchBody = {};
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'cost')) {
        const cost = Number(payload.cost);
        if (!Number.isInteger(cost) || cost < 1) {
          return { ok: false, error: 'El precio tiene que ser un número entero mayor o igual a 1.' };
        }
        patchBody.cost = cost;
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'description')) {
        const description = String(payload.description || '').trim();
        if (description.length > 200) {
          return { ok: false, error: 'La descripción no puede superar 200 caracteres.' };
        }
        patchBody.description = description;
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'is_enabled')) {
        patchBody.is_enabled = !!payload.is_enabled;
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'userInputRequired')) {
        patchBody.is_user_input_required = !!payload.userInputRequired;
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'shouldRedemptionsSkipRequestQueue')) {
        patchBody.should_redemptions_skip_request_queue = !!payload.shouldRedemptionsSkipRequestQueue;
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'backgroundColor')) {
        const rawColor = String(payload.backgroundColor || '').trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(rawColor)) {
          return { ok: false, error: 'El color de fondo debe tener formato HEX #RRGGBB.' };
        }
        patchBody.background_color = normalizeKickRewardColor(rawColor);
      }

      if (!Object.keys(patchBody).length) {
        return { ok: false, error: 'No hay cambios para guardar.' };
      }

      const r = await kickRequestWithRefresh('PATCH', `/public/v1/channels/rewards/${rewardId}`, patchBody, mode);
      if (r.status === 200) return { ok: true, reward: r.data?.data || null };
      if (r.status === 403) return { ok: false, error: 'Kick solo deja editar rewards creadas por esta app.' };
      return { ok: false, error: mapKickRewardError(r) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('kick-reward-list', async (_, input) => {
    try {
      const mode = pickKickMode(input);
      const ctx = await loadKickModeContext(mode);
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const cfg = ctx.cfg;
      const songRequestRewardId = getActiveSongRequestRewardId(cfg);
      if (!ctx.creds.accessToken) {
        return { ok: false, error: 'Primero autorizá Kick en Config.' };
      }
      const aligned = await ensureKickTokenMatchesActiveChannel(mode);
      if (!aligned.ok) return { ok: false, error: aligned.error };

      const fetchRes = await kickFetchAllRewards(mode);
      if (!fetchRes.ok) return { ok: false, error: mapKickRewardError(fetchRes.response) };
      const rewardsRaw = Array.isArray(fetchRes.rewards) ? fetchRes.rewards : [];
      const rewards = rewardsRaw
        .map(item => normalizeKickReward(item, songRequestRewardId))
        .filter(Boolean)
        .sort((a, b) => Number(b.is_song_request) - Number(a.is_song_request) || a.title.localeCompare(b.title));

      return { ok: true, rewards, songRequestRewardId };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('kick-reward-set-primary', async (_, rewardIdInput) => {
    try {
      const mode = pickKickMode(rewardIdInput);
      const rewardIdArg = (rewardIdInput && typeof rewardIdInput === 'object' && !Array.isArray(rewardIdInput))
        ? rewardIdInput.rewardId
        : rewardIdInput;
      const ctx = await loadKickModeContext(mode);
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const cfg = ctx.cfg;
      const rewardId = String(rewardIdArg || '').trim();
      if (!ctx.creds.accessToken) return { ok: false, error: 'Primero autorizá Kick en Config.' };
      const aligned = await ensureKickTokenMatchesActiveChannel(mode);
      if (!aligned.ok) return { ok: false, error: aligned.error };
      if (!rewardId) return { ok: false, error: 'Falta el ID de la reward.' };

      const fetchRes = await kickFetchAllRewards(mode);
      if (!fetchRes.ok) return { ok: false, error: mapKickRewardError(fetchRes.response) };
      const reward = (fetchRes.rewards || []).find(item => String(item?.id || '') === rewardId);
      if (!reward) {
        return { ok: false, error: 'No encontré esa reward en el canal conectado.' };
      }

      const persistedId = await persistKickSongRequestRewardId(rewardId, mode, { reason: 'set-primary' });
      return { ok: true, rewardId: persistedId };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('kick-reward-create', async (_, payload) => {
    try {
      const mode = pickKickMode(payload);
      const ctx = await loadKickModeContext(mode);
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const cfg = ctx.cfg;
      if (!ctx.creds.accessToken) return { ok: false, error: 'Primero autorizá Kick en Config.' };
      const aligned = await ensureKickTokenMatchesActiveChannel(mode);
      if (!aligned.ok) return { ok: false, error: aligned.error };

      const title = String(payload?.title || '').trim();
      const description = String(payload?.description || '').trim();
      const cost = Number(payload?.cost);
      const enabled = payload?.enabled !== false;
      const userInputRequired = payload?.userInputRequired !== false;
      const shouldRedemptionsSkipRequestQueue = !!payload?.shouldRedemptionsSkipRequestQueue;
      const setAsSongRequest = payload?.setAsSongRequest !== false;
      const backgroundColorRaw = String(payload?.backgroundColor || '').trim();

      if (!title) return { ok: false, error: 'El título es obligatorio.' };
      if (title.length > 50) return { ok: false, error: 'El título no puede superar 50 caracteres.' };
      if (!Number.isInteger(cost) || cost < 1) {
        return { ok: false, error: 'El precio tiene que ser un número entero mayor o igual a 1.' };
      }
      if (description.length > 200) return { ok: false, error: 'La descripción no puede superar 200 caracteres.' };
      if (backgroundColorRaw && !/^#[0-9a-fA-F]{6}$/.test(backgroundColorRaw)) {
        return { ok: false, error: 'El color de fondo debe tener formato HEX #RRGGBB.' };
      }

      const body = {
        title,
        cost,
        description,
        is_enabled: !!enabled,
        is_user_input_required: !!userInputRequired,
        should_redemptions_skip_request_queue: shouldRedemptionsSkipRequestQueue,
        background_color: normalizeKickRewardColor(backgroundColorRaw || '#53D067'),
      };

      const r = await kickRequestWithRefresh('POST', '/public/v1/channels/rewards', body, mode);
      if (r.status !== 200 && r.status !== 201) {
        if (r.status === 403) return { ok: false, error: 'No tenés permisos para crear rewards en este canal.' };
        return { ok: false, error: mapKickRewardError(r) };
      }

      const createdRaw = r.data?.data || r.data || null;
      const createdId = String(createdRaw?.id || '').trim();
      let songRequestRewardId = getActiveSongRequestRewardId(cfg);
      if (setAsSongRequest && createdId) {
        songRequestRewardId = await persistKickSongRequestRewardId(createdId, mode, { reason: 'create-set-primary' });
      }

      const reward = normalizeKickReward(createdRaw, songRequestRewardId);
      return { ok: true, reward, songRequestRewardId };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('kick-reward-delete', async (_, rewardIdInput) => {
    try {
      const mode = pickKickMode(rewardIdInput);
      const rewardIdArg = (rewardIdInput && typeof rewardIdInput === 'object' && !Array.isArray(rewardIdInput))
        ? rewardIdInput.rewardId
        : rewardIdInput;
      const ctx = await loadKickModeContext(mode);
      if (!ctx.ok) return { ok: false, error: `Kick requiere Supabase activo: ${ctx.error || 'sin conexión'}` };
      const cfg = ctx.cfg;
      const rewardId = String(rewardIdArg || '').trim();
      if (!ctx.creds.accessToken) return { ok: false, error: 'Primero autorizá Kick en Config.' };
      const aligned = await ensureKickTokenMatchesActiveChannel(mode);
      if (!aligned.ok) return { ok: false, error: aligned.error };
      if (!rewardId) return { ok: false, error: 'Falta el ID de la reward.' };

      const r = await kickRequestWithRefresh('DELETE', `/public/v1/channels/rewards/${rewardId}`, null, mode);
      if (![200, 202, 204].includes(Number(r.status || 0))) {
        if (r.status === 403) return { ok: false, error: 'Kick solo deja borrar rewards creadas por esta app.' };
        if (r.status === 404) return { ok: false, error: 'No encontré esa reward en Kick.' };
        return { ok: false, error: mapKickRewardError(r) };
      }

      const currentSrId = getActiveSongRequestRewardId(cfg);
      let songRequestCleared = false;
      if (currentSrId && currentSrId === rewardId) {
        await persistKickSongRequestRewardId('', mode, { allowClear: true, reason: 'delete-primary-reward' });
        songRequestCleared = true;
      }

      return { ok: true, songRequestCleared };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

module.exports = { registerKickIpc };
