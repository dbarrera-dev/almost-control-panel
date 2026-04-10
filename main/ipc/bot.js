function registerBotIpc({ ipcMain, loadConfig, saveConfig, saveLog, processQueue, state }) {
  ipcMain.handle('connect-bot', async (_, config) => {
    saveLog('info', `Bot conectando a #${config.twitchChannel}...`);
    const tmi = require('tmi.js');
    const { createClient } = require('@supabase/supabase-js');

    if (state.tmiClient) { try { await state.tmiClient.disconnect(); } catch (e) {} state.tmiClient = null; }

    saveConfig({ ...loadConfig(), ...config });
    state.supabase = createClient(config.supabaseUrl, config.supabaseKey);

    try {
      state.tmiClient = new tmi.Client({
        options: { debug: false },
        connection: { reconnect: true, secure: true },
        identity: {
          username: config.botUsername,
          password: config.botOauth.startsWith('oauth:') ? config.botOauth : `oauth:${config.botOauth}`
        },
        channels: [config.twitchChannel]
      });

      const client = state.tmiClient;

      client.on('join', (channel, username, self) => {
        if (self) saveLog('info', `Bot entró al canal ${channel}`);
      });

      client.on('notice', (_channel, _msgid, message) => {
        saveLog('warn', `Twitch notice: ${message}`);
      });

      client.on('disconnected', (reason) => {
        state.mainWindow?.webContents.send('bot-status', { connected: false, reason });
        saveLog('warn', `Bot desconectado: ${reason || 'sin motivo'}`);
      });

      await client.connect();

      client.on('message', (channel, tags, message, self) => {
        if (self) return;
        const msgTrimmed = message.trim();
        const cmd = msgTrimmed.toLowerCase();
        const nick = tags['display-name'];
        if (['!join', '!torneo', '!unirse'].some(c => cmd === c || cmd.startsWith(c + ' '))) {
          const parts = msgTrimmed.split(/\s+/);
          const gameNick = parts.length > 1 ? parts.slice(1).join(' ') : null;
          state.queue.push({ nick, channel, action: 'join', gameNick });
        }
        if (['!salir', '!leave'].includes(cmd)) state.queue.push({ nick, channel, action: 'leave' });
        if (cmd === state.currentSorteoCmd && state.sorteoActivo) state.queue.push({ nick, channel, action: 'sorteo' });
        if (['!song', '!cancion', '!musica'].includes(cmd)) state.queue.push({ nick, channel, action: 'song' });
        if (['!playlist', '!lista'].includes(cmd)) state.queue.push({ nick, channel, action: 'playlist' });
        if (['!cola', '!queue'].includes(cmd)) state.queue.push({ nick, channel, action: 'queue' });
        if (cmd === '!skip') state.queue.push({ nick, channel, action: 'skip' });
        if (state.songRequestRewardId && tags['custom-reward-id'] === state.songRequestRewardId) {
          if (state.songRequestEnabled && state.songRequestTwitchEnabled) {
            state.queue.push({ nick, channel, action: 'songrequest', link: msgTrimmed });
          } else {
            client.say(channel, `@${nick} Ya no funciona este método, wachin, perdiste los puntos LUL Anda a canjear en Kick`);
          }
        }
        processQueue();
      });

      saveLog('info', `Bot conectado a #${config.twitchChannel} ✅`);

      // Sincronizar credenciales del bot a Supabase para otros dispositivos
      if (state.supabase) {
        state.supabase.from('bot_config').upsert({
          id: 1,
          bot_username: config.botUsername,
          bot_oauth: config.botOauth,
          twitch_channel: config.twitchChannel,
          updated_at: new Date().toISOString()
        }).then(() => saveLog('info', 'Bot: credenciales sincronizadas a Supabase'))
          .catch(() => {});
      }

      return { ok: true };
    } catch (err) {
      saveLog('warn', `Bot error al conectar: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('disconnect-bot', async () => {
    if (state.tmiClient) { try { await state.tmiClient.disconnect(); } catch (e) {} state.tmiClient = null; }
    state.currentTorneoId = null;
    saveLog('info', 'Bot desconectado manualmente');
    return { ok: true };
  });
}

module.exports = { registerBotIpc };