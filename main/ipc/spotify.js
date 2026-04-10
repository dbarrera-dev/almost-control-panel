function registerSpotifyIpc({
  ipcMain,
  loadConfig,
  saveConfig,
  spotifyNowPlayingData,
  spotifyPlayerCommand,
  startSpotifyOAuthFlow,
  SPOTIFY_REDIRECT_URI,
  httpsRequest,
  getSpotifyAccessToken,
  parseSpotifyLink,
  spotifyGetTrackName,
  saveLog,
  state,
}) {
  ipcMain.handle('get-spotify-status', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, connected: false };
    const { data } = await supabase.from('spotify_tokens').select('id').eq('id', 1).maybeSingle();
    return { ok: true, connected: !!data };
  });

  ipcMain.handle('spotify-now-playing', async () => {
    try {
      const track = await spotifyNowPlayingData();
      if (!track) return { ok: true, playing: false, reason: '204' };
      if (!track.item) return { ok: true, playing: false, reason: 'no_item' };
      return {
        ok: true,
        playing: track.is_playing,
        shuffle: track.shuffle_state || false,
        repeat: track.repeat_state || 'off',
        volume: track.device?.volume_percent ?? null,
        progress_ms: track.progress_ms || 0,
        duration_ms: track.item.duration_ms || 0,
        device: track.device ? { id: track.device.id, name: track.device.name, type: track.device.type } : null,
        track: {
          name: track.item.name,
          artist: track.item.artists.map(a => a.name).join(', '),
          album: track.item.album.name,
          image: track.item.album.images[1]?.url || track.item.album.images[0]?.url || ''
        }
      };
    } catch(e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('spotify-play',          async ()       => spotifyPlayerCommand('PUT',  '/v1/me/player/play'));
  ipcMain.handle('spotify-pause',         async ()       => spotifyPlayerCommand('PUT',  '/v1/me/player/pause'));
  ipcMain.handle('spotify-next',          async ()       => spotifyPlayerCommand('POST', '/v1/me/player/next'));
  ipcMain.handle('spotify-prev',          async ()       => spotifyPlayerCommand('POST', '/v1/me/player/previous'));
  ipcMain.handle('spotify-shuffle',            async (_, st)       => spotifyPlayerCommand('PUT',  `/v1/me/player/shuffle?state=${st}`));
  ipcMain.handle('spotify-set-volume',         async (_, vol)      => spotifyPlayerCommand('PUT',  `/v1/me/player/volume?volume_percent=${Math.max(0, Math.min(100, Math.round(vol)))}`));
  ipcMain.handle('spotify-play-context',       async (_, uri)      => spotifyPlayerCommand('PUT',  '/v1/me/player/play', { context_uri: uri }));
  ipcMain.handle('spotify-set-repeat',         async (_, repeatState)    => spotifyPlayerCommand('PUT',  `/v1/me/player/repeat?state=${repeatState}`));
  ipcMain.handle('spotify-transfer-playback',  async (_, deviceId) => spotifyPlayerCommand('PUT',  '/v1/me/player', { device_ids: [deviceId], play: true }));
  ipcMain.handle('spotify-seek',               async (_, posMs)    => spotifyPlayerCommand('PUT',  `/v1/me/player/seek?position_ms=${Math.max(0, Math.round(posMs))}`));

  ipcMain.handle('spotify-get-devices', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
    if (!data?.refresh_token) return { ok: false };
    const tokenData = await getSpotifyAccessToken(data.client_id, data.client_secret, data.refresh_token);
    if (!tokenData?.access_token) return { ok: false };
    const r = await httpsRequest('GET', 'api.spotify.com', '/v1/me/player/devices',
      { 'Authorization': `Bearer ${tokenData.access_token}` });
    if (!r.data?.devices) return { ok: false };
    return {
      ok: true,
      devices: r.data.devices.map(d => ({
        id: d.id, name: d.name, type: d.type,
        isActive: d.is_active, volume: d.volume_percent ?? 0
      }))
    };
  });

  ipcMain.handle('spotify-get-playlists', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
    if (!data?.refresh_token) return { ok: false };
    const tokenData = await getSpotifyAccessToken(data.client_id, data.client_secret, data.refresh_token);
    if (!tokenData?.access_token) return { ok: false };
    const r = await httpsRequest('GET', 'api.spotify.com', '/v1/me/playlists?limit=30',
      { 'Authorization': `Bearer ${tokenData.access_token}` });
    if (!r.data?.items) return { ok: false };
    return {
      ok: true,
      playlists: r.data.items.map(p => ({
        id: p.id, name: p.name, uri: p.uri,
        tracks: p.tracks?.total || 0,
        image: p.images?.[0]?.url || ''
      }))
    };
  });

  ipcMain.handle('spotify-songrequest-toggle', (_, enabled) => {
    state.songRequestEnabled = enabled;
    const cfg = loadConfig(); cfg.songRequestEnabled = enabled; saveConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('spotify-songrequest-toggle-twitch', (_, enabled) => {
    state.songRequestTwitchEnabled = enabled;
    if (enabled) state.songRequestEnabled = true;
    const cfg = loadConfig();
    cfg.songRequestTwitchEnabled = enabled;
    if (enabled) cfg.songRequestEnabled = true;
    saveConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('spotify-songrequest-toggle-kick', (_, enabled) => {
    state.songRequestKickEnabled = enabled;
    if (enabled) state.songRequestEnabled = true;
    const cfg = loadConfig();
    cfg.songRequestKickEnabled = enabled;
    if (enabled) cfg.songRequestEnabled = true;
    saveConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('spotify-songrequest-set-reward', (_, rewardId) => {
    state.songRequestRewardId = rewardId.trim();
    const cfg = loadConfig(); cfg.songRequestRewardId = rewardId.trim(); saveConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('spotify-get-songrequest-config', () => ({
    enabled: state.songRequestEnabled,
    twitchEnabled: state.songRequestTwitchEnabled,
    kickEnabled: state.songRequestKickEnabled,
    rewardId: state.songRequestRewardId
  }));

  // Devuelve la queue de requests interna + el requester activo
  ipcMain.handle('spotify-get-request-queue', () => ({
    queue:  state.spotifyRequesterQueue,
    active: state.spotifyActiveRequester
  }));

  // Elimina una entrada de la queue interna por trackId
  // (la canción ya está en la cola de Spotify, pero dejamos de trackearla)
  ipcMain.handle('spotify-remove-from-request-queue', (_, trackId) => {
    const idx = state.spotifyRequesterQueue.findIndex(r => r.trackId === trackId);
    if (idx !== -1) state.spotifyRequesterQueue.splice(idx, 1);
    if (state.spotifyActiveRequester?.trackId === trackId) state.spotifyActiveRequester = null;
    return { ok: true };
  });

  // Limpia toda la queue de requests (reset manual de emergencia)
  ipcMain.handle('spotify-clear-request-queue', () => {
    state.spotifyRequesterQueue.forEach(r => state.sessionDoneIds.add(r.trackId));
    if (state.spotifyActiveRequester) state.sessionDoneIds.add(state.spotifyActiveRequester.trackId);
    state.spotifyRequesterQueue = [];
    state.spotifyActiveRequester = null;
    state.mainWindow?.webContents.send('request-queue-update', { queue: [], active: null });
    saveLog('info', '[Requester] Queue limpiada manualmente');
    return { ok: true };
  });

  ipcMain.handle('spotify-add-to-queue', async (_, trackUri, nick, trackName) => {
    const uri = parseSpotifyLink(trackUri);
    if (!uri) return { ok: false, error: 'URI inválida' };
    const result = await spotifyPlayerCommand('POST', `/v1/me/player/queue?uri=${encodeURIComponent(uri)}`, null);
    if (result.ok && nick) {
      const trackId = uri.split(':')[2];
      let resolvedName = trackName;
      if (!resolvedName) {
        try {
          const supabase = state.supabase;
          const { data: tokenRow } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
          if (tokenRow?.refresh_token) resolvedName = await spotifyGetTrackName(tokenRow.client_id, tokenRow.client_secret, tokenRow.refresh_token, uri);
        } catch {}
      }
      const newReq = { nick, trackId, trackName: resolvedName || uri, _addedAt: Date.now() };
      state.spotifyRequesterQueue.push(newReq);
      state.mainWindow?.webContents.send('request-queue-update', { queue: state.spotifyRequesterQueue, active: state.spotifyActiveRequester });
      saveLog('join', `${nick} agregó a la cola: ${newReq.trackName}`);
      if (state.supabase) state.supabase.from('app_logs').insert({ type: 'sr', msg: JSON.stringify(newReq) }).then(() => {}).catch(() => {});
    }
    return result;
  });

  ipcMain.handle('spotify-search', async (_, query) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin Supabase' };
    const { data } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
    if (!data?.refresh_token) return { ok: false, error: 'Sin token' };
    const tokenData = await getSpotifyAccessToken(data.client_id, data.client_secret, data.refresh_token);
    if (!tokenData?.access_token) return { ok: false, error: 'Sin access token' };
    const r = await httpsRequest('GET', 'api.spotify.com',
      `/v1/search?q=${encodeURIComponent(query)}&type=track&limit=10`,
      { 'Authorization': `Bearer ${tokenData.access_token}` });
    if (!r.data?.tracks?.items) return { ok: false, error: r.data?.error?.message || `HTTP ${r.status}` };
    return {
      ok: true,
      tracks: r.data.tracks.items.map(t => ({
        id: t.id, uri: t.uri, name: t.name,
        artist: t.artists.map(a => a.name).join(', '),
        image: t.album.images?.[2]?.url || t.album.images?.[0]?.url || ''
      }))
    };
  });

  ipcMain.handle('spotify-get-queue', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data } = await supabase.from('spotify_tokens').select('*').eq('id', 1).maybeSingle();
    if (!data?.refresh_token) return { ok: false };
    const tokenData = await getSpotifyAccessToken(data.client_id, data.client_secret, data.refresh_token);
    if (!tokenData?.access_token) return { ok: false };
    const r = await httpsRequest('GET', 'api.spotify.com', '/v1/me/player/queue',
      { 'Authorization': `Bearer ${tokenData.access_token}` });
    if (!r.data) return { ok: false };
    return {
      ok: true,
      queue: (r.data.queue || []).slice(0, 15).map(t => ({
        id: t.id, uri: t.uri, name: t.name,
        artist: t.artists?.map(a => a.name).join(', ') || '',
        image: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url || ''
      }))
    };
  });

  ipcMain.handle('spotify-connect-oauth', async (_, { clientId, clientSecret }) => {
    try {
      state.mainWindow?.webContents.send('spotify-oauth-status', { step: 'waiting' });
      const code = await startSpotifyOAuthFlow(clientId);

      state.mainWindow?.webContents.send('spotify-oauth-status', { step: 'exchanging' });
      const body = `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(SPOTIFY_REDIRECT_URI)}`;
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const r = await httpsRequest('POST', 'accounts.spotify.com', '/api/token',
        { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);

      if (!r.data?.refresh_token) return { ok: false, error: r.data?.error_description || 'No se recibió refresh token' };

      if (!state.supabase) return { ok: false, error: 'Sin conexión a Supabase' };
      const { error } = await state.supabase.from('spotify_tokens').upsert({
        id: 1, client_id: clientId, client_secret: clientSecret,
        refresh_token: r.data.refresh_token, updated_at: new Date().toISOString()
      });
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('spotify-disconnect', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { error } = await supabase.from('spotify_tokens').delete().eq('id', 1);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

  ipcMain.handle('spotify-get-credentials', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false };
    const { data } = await supabase.from('spotify_tokens').select('client_id, client_secret').eq('id', 1).maybeSingle();
    return { ok: true, clientId: data?.client_id || '', clientSecret: data?.client_secret || '' };
  });

}

module.exports = { registerSpotifyIpc };
