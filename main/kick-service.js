function createKickService({ loadConfig, saveConfig, httpsRequest, saveLog, state, processQueue }) {
  async function kickApiRequest(method, endpoint, body, token) {
    const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
    const bodyStr = body ? JSON.stringify(body) : null;
    if (bodyStr) headers['Content-Type'] = 'application/json';
    return httpsRequest(method, 'api.kick.com', endpoint, headers, bodyStr);
  }

  async function kickRefreshAccessToken() {
    const cfg = loadConfig();
    if (!cfg.kickRefreshToken || !cfg.kickClientId || !cfg.kickClientSecret) return null;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.kickRefreshToken,
      client_id: cfg.kickClientId,
      client_secret: cfg.kickClientSecret
    }).toString();
    const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (r.data?.access_token) {
      const newCfg = loadConfig();
      newCfg.kickAccessToken = r.data.access_token;
      if (r.data.refresh_token) newCfg.kickRefreshToken = r.data.refresh_token;
      saveConfig(newCfg);
      state.kickAccessToken = r.data.access_token;
      if (state.supabase) {
        const upd = { id: 1, access_token: r.data.access_token, updated_at: new Date().toISOString() };
        if (r.data.refresh_token) upd.refresh_token = r.data.refresh_token;
        state.supabase.from('kick_tokens').upsert(upd).then(() => {}).catch(() => {});
      }
      return r.data.access_token;
    }
    return null;
  }

  async function kickRefreshBotToken() {
    const cfg = loadConfig();
    if (!cfg.kickBotRefreshToken || !cfg.kickClientId || !cfg.kickClientSecret) return null;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.kickBotRefreshToken,
      client_id: cfg.kickClientId,
      client_secret: cfg.kickClientSecret
    }).toString();
    const r = await httpsRequest('POST', 'id.kick.com', '/oauth/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (r.data?.access_token) {
      const newCfg = loadConfig();
      newCfg.kickBotAccessToken = r.data.access_token;
      if (r.data.refresh_token) newCfg.kickBotRefreshToken = r.data.refresh_token;
      saveConfig(newCfg);
      state.kickBotAccessToken = r.data.access_token;
      if (state.supabase) {
        const upd = { id: 2, access_token: r.data.access_token, updated_at: new Date().toISOString() };
        if (r.data.refresh_token) upd.refresh_token = r.data.refresh_token;
        state.supabase.from('kick_tokens').upsert(upd).then(() => {}).catch(() => {});
      }
      return r.data.access_token;
    }
    return null;
  }

  async function kickChatSend(message) {
    let token = state.kickBotAccessToken || loadConfig().kickBotAccessToken;
    if (!token) {
      saveLog('warn', 'Kick chat: no hay token de bot, no se puede enviar mensaje');
      return;
    }
    const sendChat = async (t, type) => {
      const payload = { content: message, type };
      if (type === 'user' && state.kickChannelId) payload.broadcaster_user_id = Number(state.kickChannelId) || state.kickChannelId;
      return kickApiRequest('POST', '/public/v1/chat', payload, t);
    };
    let r = await sendChat(token, 'user');
    if (r.status === 401) {
      token = await kickRefreshBotToken();
      if (token) r = await sendChat(token, 'user');
    }
    if (r.status === 200) {
      saveLog('info', 'Kick chat: mensaje enviado con cuenta bot.');
      return;
    }

    if (r.status === 403) {
      saveLog('warn', 'Kick chat error 403 con token bot (faltan permisos o canal no asociado). Intentando como broadcaster...');
    } else if (r.status >= 500 || r.status === 0) {
      saveLog('warn', `Kick chat error ${r.status} con token bot. Intentando como broadcaster...`);
    } else {
      state.mainWindow?.webContents.send('bot-log', { type: 'warn', msg: `Kick chat error ${r.status}: ${JSON.stringify(r.data)}` });
      return;
    }

    // Fallback: enviar como broadcaster si existe token principal
    let bToken = state.kickAccessToken || loadConfig().kickAccessToken;
    if (!bToken) {
      saveLog('warn', 'Kick chat fallback no disponible: falta token broadcaster');
      return;
    }
    let r2 = await sendChat(bToken, 'user');
    if (r2.status === 401) {
      bToken = await kickRefreshAccessToken();
      if (bToken) r2 = await sendChat(bToken, 'user');
    }
    if (r2.status === 200) {
      saveLog('info', 'Kick chat: mensaje enviado como broadcaster (fallback).');
    } else {
      state.mainWindow?.webContents.send('bot-log', { type: 'warn', msg: `Kick chat fallback error ${r2.status}: ${JSON.stringify(r2.data)}` });
    }
  }

  function processKickMessage(nick, content) {
    const msg = content.trim();
    const cmd = msg.toLowerCase();
    if (['!join', '!torneo', '!unirse'].some(c => cmd === c || cmd.startsWith(c + ' '))) {
      const parts = msg.split(/\s+/);
      state.queue.push({ nick, channel: '__kick__', action: 'join', gameNick: parts.length > 1 ? parts.slice(1).join(' ') : null });
    }
    if (['!salir', '!leave'].includes(cmd)) state.queue.push({ nick, channel: '__kick__', action: 'leave' });
    if (cmd === state.currentSorteoCmd && state.sorteoActivo) state.queue.push({ nick, channel: '__kick__', action: 'sorteo' });
    if (['!song', '!cancion', '!musica'].includes(cmd)) state.queue.push({ nick, channel: '__kick__', action: 'song' });
    if (['!playlist', '!lista'].includes(cmd)) state.queue.push({ nick, channel: '__kick__', action: 'playlist' });
    if (['!cola', '!queue'].includes(cmd)) state.queue.push({ nick, channel: '__kick__', action: 'queue' });
    if (cmd === '!skip') state.queue.push({ nick, channel: '__kick__', action: 'skip' });
    processQueue();
  }

  function startKickPolling() {
    stopKickPolling();
    state.kickPollTimer = setInterval(pollKickEvents, 4000);
    pollKickEvents(); // primera ejecuciÃ³n inmediata
  }

  function stopKickPolling() {
    if (state.kickPollTimer) { clearInterval(state.kickPollTimer); state.kickPollTimer = null; }
  }

  async function pollKickEvents() {
    if (!state.supabase) return;
    try {
      const { data, error } = await state.supabase
        .from('kick_events')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(20);
      if (error || !data?.length) return;

      const nonChat = data.filter(r => (r.event_type || '') !== 'chat.message.sent');
      if (nonChat.length) {
        const types = nonChat.map(r => r.event_type || 'unknown');
        saveLog('info', `[Kick poll] ${nonChat.length} evento(s) no-chat: ${types.join(', ')}`);
      }

      for (const row of data) {
        processKickEvent(row);
      }
      // Borrar los procesados
      const ids = data.map(r => r.id);
      await state.supabase.from('kick_events').delete().in('id', ids);
    } catch (e) {
      saveLog('warn', `[Kick poll] error: ${e?.message || e}`);
    }
  }

  function processKickEvent(row) {
    const payload = row.payload || {};
    const eventType = row.event_type || payload.event || '';

    // Chat message
    if (eventType === 'chat.message.sent') {
      const d = payload.data || payload;
      const nick = d.sender?.username || 'unknown';
      const text = d.content || '';
      if (nick && text) processKickMessage(nick, text);
      return;
    }

    // Channel reward redemption
    if (eventType === 'channel.reward.redemption.created' || eventType === 'channel.reward.redemption.updated') {
      const d = payload.data || payload;
      const nick = d.redeemer?.username || d.user?.username || 'unknown';
      const rewardId = String(d.reward?.id || d.reward_id || '');
      const userInput = d.user_input || d.input || '';
      const cfgRewardId = String(loadConfig().kickSongRequestRewardId || '');

      saveLog('info', `[Kick redemption] nick=${nick} rewardId=${rewardId} cfgRewardId=${cfgRewardId} match=${rewardId === cfgRewardId} srEnabled=${state.songRequestEnabled} srKick=${state.songRequestKickEnabled} input="${(userInput || '').slice(0, 60)}"`);

      if (!cfgRewardId) {
        saveLog('warn', '[Kick redemption] kickSongRequestRewardId NO esta configurado — no se puede procesar');
        return;
      }
      if (!state.songRequestEnabled) {
        saveLog('warn', `[Kick redemption] songRequestEnabled=false, ignorando`);
        return;
      }
      if (!state.songRequestKickEnabled) {
        saveLog('warn', `[Kick redemption] songRequestKickEnabled=false, ignorando`);
        return;
      }
      if (rewardId !== cfgRewardId) {
        saveLog('info', `[Kick redemption] rewardId no coincide (${rewardId} vs ${cfgRewardId}), ignorando`);
        return;
      }
      if (!userInput) {
        saveLog('warn', `[Kick redemption] ${nick} canjeo sin texto, ignorando`);
        return;
      }

      state.mainWindow?.webContents.send('bot-log', { type: 'song', msg: `[Kick] ${nick} pidió: ${userInput}` });
      state.queue.push({ nick, channel: '__kick__', action: 'songrequest', link: userInput });
      processQueue();
      return;
    }

    // Cualquier otro evento â€” log completo para diagnÃ³stico
    state.mainWindow?.webContents.send('bot-log', { type: 'info', msg: `[Kick evento desconocido] type="${eventType}" payload=${JSON.stringify(payload).slice(0, 200)}` });
  }

  async function connectKickBot() {
    try {
      let cfg = loadConfig();
      // Si no hay credenciales locales, intentar cargar desde Supabase
      if (state.supabase && (!cfg.kickAccessToken || !cfg.kickClientId)) {
        const { data: kt } = await state.supabase.from('kick_tokens').select('*').eq('id', 1).maybeSingle();
        if (kt) {
          cfg.kickClientId     = kt.client_id     || cfg.kickClientId;
          cfg.kickClientSecret = kt.client_secret || cfg.kickClientSecret;
          cfg.kickChannel      = kt.channel       || cfg.kickChannel;
          cfg.kickAccessToken  = kt.access_token  || cfg.kickAccessToken;
          cfg.kickRefreshToken = kt.refresh_token || cfg.kickRefreshToken;
          if (kt.reward_id)    cfg.kickSongRequestRewardId = kt.reward_id;
          saveConfig(cfg);
        }
      }
      // Cargar token de la cuenta bot si existe
      if (state.supabase && !cfg.kickBotAccessToken) {
        const { data: kb } = await state.supabase.from('kick_tokens').select('*').eq('id', 2).maybeSingle();
        if (kb?.access_token) {
          cfg.kickBotAccessToken = kb.access_token;
          if (kb.refresh_token) cfg.kickBotRefreshToken = kb.refresh_token;
          saveConfig(cfg);
        }
      }
      state.kickAccessToken = cfg.kickAccessToken;
      state.kickBotAccessToken = cfg.kickBotAccessToken || null;
      if (!state.kickAccessToken || !cfg.kickChannel || !cfg.kickClientId) {
        return { ok: false, error: 'Falta configuraciÃ³n de Kick. ConectÃ¡ la cuenta primero.' };
      }
      // Obtener info del canal
      let r = await kickApiRequest('GET', `/public/v1/channels?broadcaster_user_login=${encodeURIComponent(cfg.kickChannel)}`, null, state.kickAccessToken);
      if (!r.data?.data?.[0]) {
        state.kickAccessToken = await kickRefreshAccessToken();
        if (!state.kickAccessToken) return { ok: false, error: 'Token vencido. ReconectÃ¡ la cuenta de Kick.' };
        r = await kickApiRequest('GET', `/public/v1/channels?broadcaster_user_login=${encodeURIComponent(cfg.kickChannel)}`, null, state.kickAccessToken);
        if (!r.data?.data?.[0]) return { ok: false, error: 'Canal de Kick no encontrado.' };
      }
      state.kickChannelId = r.data.data[0].broadcaster_user_id;

      // Enviar mensajes usa el endpoint oficial /public/v1/chat con el token del bot.

      // Suscribir eventos via webhook
      const subRes = await kickApiRequest('POST', '/public/v1/events/subscriptions', {
        method: 'webhook',
        events: [
          { name: 'chat.message.sent', version: 1 },
          { name: 'channel.reward.redemption.updated', version: 1 }
        ]
      }, state.kickAccessToken);
      const results = Array.isArray(subRes.data?.data) ? subRes.data.data : [];
      const failed = results.filter(e => e.error).map(e => `${e.name}: ${e.error}`);
      const ok = results.filter(e => !e.error).map(e => e.name || e.type);
      if (ok.length) saveLog('info', `Kick eventos suscritos: ${ok.join(', ')}`);
      if (failed.length) saveLog('warn', `Kick eventos fallidos: ${failed.join(', ')}`);

      // Log estado de song request config
      const srRewardId = cfg.kickSongRequestRewardId || '(no configurado)';
      saveLog('info', `Kick SR config: rewardId=${srRewardId} srEnabled=${state.songRequestEnabled} srKick=${state.songRequestKickEnabled}`);

      startKickPolling();
      state.mainWindow?.webContents.send('kick-bot-status', { connected: true });
      saveLog('info', `Kick bot conectado a #${cfg.kickChannel} âœ…`);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return {
    kickApiRequest,
    kickChatSend,
    connectKickBot,
    startKickPolling,
    stopKickPolling,
  };
}

module.exports = { createKickService };
