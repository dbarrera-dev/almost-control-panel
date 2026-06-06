const fs = require('fs');
const path = require('path');

const LOCAL_KICK_STRIP_FIELDS = [
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

function stripLocalKickCredentials(cfg) {
  const out = { ...(cfg || {}) };
  for (const field of LOCAL_KICK_STRIP_FIELDS) out[field] = '';
  return out;
}

function normalizeKickModes(cfg) {
  const out = { ...(cfg || {}) };
  out.kickStartupMode = out.kickStartupMode === 'dev' ? 'dev' : 'prod';
  if (out.kickBotMode !== 'dev' && out.kickBotMode !== 'prod') {
    out.kickBotMode = out.kickStartupMode;
  }
  return out;
}

const DEFAULT_CONFIG = {
  autoConnectBot: true,
  songRequestEnabled: true,
  songRequestKickEnabled: true,
  songRequestRewardId: '',
  kickCommandConfig: {
    song: true,
    playlist: true,
    queue: true,
    skip: true,
  },
  kickCommandConfigProd: {
    song: true,
    playlist: true,
    queue: true,
    skip: true,
  },
  kickCommandConfigDev: {
    song: true,
    playlist: true,
    queue: true,
    skip: true,
  },
  supabaseUrl:   'https://fyfqwlxogdwhhsefjuhf.supabase.co',
  supabaseKey:   'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5ZnF3bHhvZ2R3aGhzZWZqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwNDMyODUsImV4cCI6MjA4NjYxOTI4NX0.i7VuuB4z0TMv0J421snb4wYo2ixtApZuZxtJVmORBZI',
  kickBotMode: 'prod',     // modo activo en runtime (prod | dev)
  kickStartupMode: 'prod', // modo de inicio al abrir la app (prod | dev)
  // ── Prod ──
  kickClientId: '',
  kickClientSecret: '',
  kickChannel: '',
  kickChatroomId: '',
  kickAccessToken: '',
  kickRefreshToken: '',
  kickBotAccessToken: '',
  kickBotRefreshToken: '',
  kickSongRequestRewardId: '',
  // ── Dev ──
  kickClientIdDev: '',
  kickClientSecretDev: '',
  kickDevChannel: '',
  kickChatroomIdDev: '',
  kickAccessTokenDev: '',
  kickRefreshTokenDev: '',
  kickBotAccessTokenDev: '',
  kickBotRefreshTokenDev: '',
  kickSongRequestRewardIdDev: '',
  autoConnectKickBot: true,
  allowLanOverlays: false,
  logoUrl:       'https://fyfqwlxogdwhhsefjuhf.supabase.co/storage/v1/object/sign/alerts/almost_avatar_a1%20(1).png?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84YmQwY2E2OS1jMGRlLTRmOGQtYjhhMi0wYmY0NjA0YmIyOTciLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJhbGVydHMvYWxtb3N0X2F2YXRhcl9hMSAoMSkucG5nIiwiaWF0IjoxNzcyNTM3NDM1LCJleHAiOjU1MjUzMjE0MzV9.L1vYdRyWcvR4QOEul_d7OVwNjHglsricRUYUNM0wvF4',

  // ── Audio Link (VBAN) ──
  audiolinkEnabled: false,
  audiolinkMode: 'emitter',             // 'emitter' (PC Streaming) | 'receiver' (PC Gaming)
  audiolinkStreamName: 'MUSIC_STREAM',
  audiolinkSampleRate: 48000,
  audiolinkChannels: 2,
  audiolinkPort: 6980,
  audiolinkVbanIndex: 0,
  // Emitter (PC Streaming → envía música)
  audiolinkTargetIp: '192.168.1.100',
  audiolinkSendEnabled: false,
  audiolinkMonitorEnabled: false,
  // Receiver (PC Gaming → recibe música)
  audiolinkSourceIp: '192.168.1.50',
  // OBS integration
  audiolinkObsEnabled: false,
  audiolinkObsAddress: 'ws://127.0.0.1:4455',
  audiolinkObsPassword: '',
  audiolinkObsSourceName: 'Music VBAN',
  // Platform rules
  audiolinkPlatformRules: {
    kick:    { includeMusic: true },
    tiktok:  { includeMusic: true },
    youtube: { includeMusic: true }
  },

  // ── Soundboard ──
  soundboardStorageMode: 'supabase',
  soundboardBucket: 'soundboard',
  soundboardHotkeysEnabled: true,
  keyOverlayStorageBucket: 'soundboard',

  // ── Content / Discord ──
  contentStorageBucket: 'almost-content',
  discordBotName: 'Almost Bot',
  discordBotAvatarUrl: '',
};

function createConfigStore(app) {
  const configPath = path.join(app.getPath('userData'), 'almost-config.json');

  function loadConfig() {
    try {
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return stripLocalKickCredentials(normalizeKickModes({ ...DEFAULT_CONFIG, ...raw }));
      }
    } catch (e) {}
    return stripLocalKickCredentials(normalizeKickModes({ ...DEFAULT_CONFIG }));
  }

  function saveConfig(cfg) {
    const safeCfg = stripLocalKickCredentials(normalizeKickModes(cfg));
    fs.writeFileSync(configPath, JSON.stringify(safeCfg, null, 2));
  }

  return { DEFAULT_CONFIG, loadConfig, saveConfig, configPath };
}

module.exports = { createConfigStore };
