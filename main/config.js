const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  autoConnectBot: true,
  songRequestEnabled: true,
  songRequestTwitchEnabled: true,
  songRequestKickEnabled: true,
  songRequestRewardId: '47b1efa5-e73d-483b-ba49-6cf74a6d03dc',
  supabaseUrl:   'https://fyfqwlxogdwhhsefjuhf.supabase.co',
  supabaseKey:   'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5ZnF3bHhvZ2R3aGhzZWZqdWhmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEwNDMyODUsImV4cCI6MjA4NjYxOTI4NX0.i7VuuB4z0TMv0J421snb4wYo2ixtApZuZxtJVmORBZI',
  botUsername:   'BotAlmost',
  botOauth:      'oauth:h5uip5akuviavo0mtqwqw0o4uw6p6o',
  twitchChannel: 'almost',
  twitchClientId: '',
  broadcasterToken: '',
  kickClientId: '',
  kickClientSecret: '',
  kickChannel: '',
  kickChatroomId: '',
  kickAccessToken: '',
  kickRefreshToken: '',
  kickSongRequestRewardId: '',
  autoConnectKickBot: true,
  kickBotAccessToken: '',
  kickBotRefreshToken: '',
  logoUrl:       'https://fyfqwlxogdwhhsefjuhf.supabase.co/storage/v1/object/sign/alerts/almost_avatar_a1%20(1).png?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV84YmQwY2E2OS1jMGRlLTRmOGQtYjhhMi0wYmY0NjA0YmIyOTciLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJhbGVydHMvYWxtb3N0X2F2YXRhcl9hMSAoMSkucG5nIiwiaWF0IjoxNzcyNTM3NDM1LCJleHAiOjU1MjUzMjE0MzV9.L1vYdRyWcvR4QOEul_d7OVwNjHglsricRUYUNM0wvF4'
};

function createConfigStore(app) {
  const configPath = path.join(app.getPath('userData'), 'almost-config.json');

  function loadConfig() {
    try {
      if (fs.existsSync(configPath)) return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    } catch (e) {}
    return { ...DEFAULT_CONFIG };
  }

  function saveConfig(cfg) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  }

  return { DEFAULT_CONFIG, loadConfig, saveConfig, configPath };
}

module.exports = { createConfigStore };
