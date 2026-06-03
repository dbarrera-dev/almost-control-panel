function normalizeKickChannel(channel) {
  return String(channel || '').trim().replace(/^@/, '').toLowerCase();
}

function resolveKickRouting(cfg) {
  const mode = cfg?.kickBotMode === 'dev' ? 'dev' : 'prod';
  const prodChannel = normalizeKickChannel(cfg?.kickChannel);
  const devChannel = normalizeKickChannel(cfg?.kickDevChannel);
  const activeChannel = mode === 'dev' ? devChannel : prodChannel;
  return {
    mode,
    prodChannel,
    devChannel,
    activeChannel,
    hasDedicatedDev: mode === 'dev' && !!devChannel && devChannel !== prodChannel,
  };
}

function getActiveSongRequestRewardId(cfg) {
  const mode = cfg?.kickBotMode === 'dev' ? 'dev' : 'prod';
  const id = mode === 'dev' ? cfg?.kickSongRequestRewardIdDev : cfg?.kickSongRequestRewardId;
  return String(id || '').trim();
}

function getSongRequestRewardField(cfg) {
  return (cfg?.kickBotMode === 'dev') ? 'kickSongRequestRewardIdDev' : 'kickSongRequestRewardId';
}

function getSongRequestRewardSupabaseColumn(cfg) {
  // Fila por modo (id=1 prod / id=3 dev), columna siempre `reward_id`.
  return 'reward_id';
}

function getSpotifyTokenRowId(cfg) {
  return (cfg?.kickBotMode === 'dev') ? 2 : 1;
}

const KICK_FIELDS_PROD = {
  clientId: 'kickClientId',
  clientSecret: 'kickClientSecret',
  channel: 'kickChannel',
  chatroomId: 'kickChatroomId',
  accessToken: 'kickAccessToken',
  refreshToken: 'kickRefreshToken',
  botAccessToken: 'kickBotAccessToken',
  botRefreshToken: 'kickBotRefreshToken',
  rewardId: 'kickSongRequestRewardId',
};

const KICK_FIELDS_DEV = {
  clientId: 'kickClientIdDev',
  clientSecret: 'kickClientSecretDev',
  channel: 'kickDevChannel',
  chatroomId: 'kickChatroomIdDev',
  accessToken: 'kickAccessTokenDev',
  refreshToken: 'kickRefreshTokenDev',
  botAccessToken: 'kickBotAccessTokenDev',
  botRefreshToken: 'kickBotRefreshTokenDev',
  rewardId: 'kickSongRequestRewardIdDev',
};

function getKickFieldMap(cfg) {
  return (cfg?.kickBotMode === 'dev') ? KICK_FIELDS_DEV : KICK_FIELDS_PROD;
}

function getKickCreds(cfg) {
  const f = getKickFieldMap(cfg);
  const out = {};
  for (const k of Object.keys(f)) out[k] = String(cfg?.[f[k]] || '').trim();
  return out;
}

function setKickCred(cfg, key, value) {
  const f = getKickFieldMap(cfg);
  if (!f[key]) return;
  cfg[f[key]] = value == null ? '' : value;
}

function getKickBroadcasterRowId(cfg) {
  return (cfg?.kickBotMode === 'dev') ? 3 : 1;
}

function getKickBotRowId(cfg) {
  return (cfg?.kickBotMode === 'dev') ? 4 : 2;
}

module.exports = {
  normalizeKickChannel,
  resolveKickRouting,
  getActiveSongRequestRewardId,
  getSongRequestRewardField,
  getSongRequestRewardSupabaseColumn,
  getSpotifyTokenRowId,
  KICK_FIELDS_PROD,
  KICK_FIELDS_DEV,
  getKickFieldMap,
  getKickCreds,
  setKickCred,
  getKickBroadcasterRowId,
  getKickBotRowId,
};
