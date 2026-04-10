function createOverlays({ state, http, fs, path, os, saveLog, spotifyNowPlayingData }) {
  // ── Key Overlay ────────────────────────────────────────────────
  let keyOverlayHttpServer = null;
  let keyOverlayWss = null;
  let uiohookInstance = null;

  const KEY_LAYOUT = [
    // row 0: number row
    {kc:1,  l:'Esc',row:0},{kc:41,l:'`',row:0},{kc:2,l:'1',row:0},{kc:3,l:'2',row:0},{kc:4,l:'3',row:0},{kc:5,l:'4',row:0},
    {kc:6,  l:'5',  row:0},{kc:7,l:'6',row:0},{kc:8,l:'7',row:0},{kc:9,l:'8',row:0},{kc:10,l:'9',row:0},
    {kc:11, l:'0',  row:0},{kc:12,l:'-',row:0},{kc:13,l:'=',row:0},{kc:14,l:'⌫',row:0},
    // row 1: F keys
    {kc:59,l:'F1',row:1},{kc:60,l:'F2',row:1},{kc:61,l:'F3',row:1},{kc:62,l:'F4',row:1},
    {kc:63,l:'F5',row:1},{kc:64,l:'F6',row:1},{kc:65,l:'F7',row:1},{kc:66,l:'F8',row:1},
    {kc:67,l:'F9',row:1},{kc:68,l:'F10',row:1},{kc:87,l:'F11',row:1},{kc:88,l:'F12',row:1},
    // row 2: QWERTY
    {kc:15,l:'Tab',row:2},
    {kc:16,l:'Q',row:2},{kc:17,l:'W',row:2,hi:true},{kc:18,l:'E',row:2},{kc:19,l:'R',row:2},
    {kc:20,l:'T',row:2},{kc:21,l:'Y',row:2},{kc:22,l:'U',row:2},{kc:23,l:'I',row:2,sub:'←'},
    {kc:24,l:'O',row:2,sub:'→'},{kc:25,l:'P',row:2},{kc:26,l:'[',row:2},{kc:27,l:']',row:2},{kc:43,l:'\\',row:2},
    // row 3: ASDF
    {kc:58,l:'Caps',row:3},
    {kc:30,l:'A',row:3,hi:true},{kc:31,l:'S',row:3,hi:true},{kc:32,l:'D',row:3,hi:true},{kc:33,l:'F',row:3},
    {kc:34,l:'G',row:3},{kc:35,l:'H',row:3},{kc:36,l:'J',row:3},{kc:37,l:'K',row:3,sub:'Nitro'},
    {kc:38,l:'L',row:3,sub:'Salto'},{kc:39,l:'Ñ',row:3},{kc:40,l:"'",row:3},{kc:28,l:'↵',row:3},
    // row 4: ZXCV
    {kc:44,l:'Z',row:4},{kc:45,l:'X',row:4},{kc:46,l:'C',row:4},{kc:47,l:'V',row:4},
    {kc:48,l:'B',row:4},{kc:49,l:'N',row:4},{kc:50,l:'M',row:4},
    {kc:51,l:',',row:4},{kc:52,l:'.',row:4},{kc:53,l:'/',row:4},{kc:54,l:'R-Shift',row:4},
    // row 5: bottom modifiers (Ctrl + Shift + Space together)
    {kc:29,l:'Ctrl',row:5},{kc:42,l:'Shift',row:5},{kc:56,l:'Alt',row:5},{kc:57,l:'Space',row:5,flex:true},
    // row 6: arrows
    {kc:57416,l:'↑',row:6},{kc:57419,l:'←',row:6},{kc:57424,l:'↓',row:6},{kc:57421,l:'→',row:6},
    // row 7: mouse
    {kc:'m1',l:'LMB',row:7},{kc:'m2',l:'RMB',row:7},{kc:'m3',l:'MMB',row:7},
  ];

  const KEY_LABELS_MAP = {};
  KEY_LAYOUT.forEach(k => { if (typeof k.kc === 'number') KEY_LABELS_MAP[k.kc] = k.l; });

  function keyAllowed(keycode) {
    const cfg = state.keyOverlayConfig || { selectedKeys: [], customKeys: [] };
    const kStr = String(keycode);
    if ((cfg.selectedKeys || []).map(String).includes(kStr)) return true;
    return (cfg.customKeys || []).some(k => String(k.keycode) === kStr);
  }

  function buildKeysList() {
    const cfg = state.keyOverlayConfig || { selectedKeys: [], customKeys: [] };
    const sel = new Set((cfg.selectedKeys || []).map(String));
    // Start with KEY_LAYOUT keys
    const items = KEY_LAYOUT.filter(k => sel.has(String(k.kc)))
      .map(k => ({ keycode: k.kc, label: k.l, row: k.row, hi: !!k.hi, flex: !!k.flex, sub: k.sub || null, aliases: [] }));

    // Merge customKeys: if same label exists -> add as alias; otherwise add as new key
    (cfg.customKeys || []).forEach(ck => {
      const existing = items.find(i => i.label === ck.label);
      if (existing) {
        existing.aliases.push(ck.keycode);
      } else {
        items.push({ keycode: ck.keycode, label: ck.label, row: ck.row ?? 8, hi: false, flex: false, sub: null, aliases: [] });
      }
    });

    return items;
  }

  function configMsg() {
    return { type: 'config', data: { ...state.keyOverlayConfig, keys: buildKeysList() } };
  }

  function broadcastOverlay(msg) {
    if (!keyOverlayWss) return;
    const str = JSON.stringify(msg);
    keyOverlayWss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
  }

  function startKeyOverlay() {
    if (state.keyOverlayRunning) return;
    try {
      const { uIOhook } = require('uiohook-napi');
      const { WebSocketServer } = require('ws');

      keyOverlayHttpServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay-keys.html')));
      });

      keyOverlayWss = new WebSocketServer({ server: keyOverlayHttpServer });
      keyOverlayWss.on('connection', (ws) => {
        ws.send(JSON.stringify(configMsg()));
      });

      uiohookInstance = uIOhook;

      uIOhook.on('keydown', (e) => {
        if (state.koDetecting) {
          state.koDetecting = false;
          const label = KEY_LABELS_MAP[e.keycode] || `#${e.keycode}`;
          state.mainWindow?.webContents.send('keyoverlay-detected', { keycode: e.keycode, label });
          return;
        }
        if (!keyAllowed(e.keycode)) return;
        const label = KEY_LABELS_MAP[e.keycode] || String.fromCharCode(e.keycode) || `#${e.keycode}`;
        const msg = { type: 'keydown', keycode: e.keycode, label };
        broadcastOverlay(msg);
        state.mainWindow?.webContents.send('keyoverlay-key', msg);
      });

      uIOhook.on('keyup', (e) => {
        if (!keyAllowed(e.keycode)) return;
        const msg = { type: 'keyup', keycode: e.keycode };
        broadcastOverlay(msg);
        state.mainWindow?.webContents.send('keyoverlay-key', msg);
      });

      const MOUSE_LABELS = { 1: 'LMB', 2: 'RMB', 3: 'MMB' };
      uIOhook.on('mousedown', (e) => {
        const kc = `m${e.button}`;
        if (!keyAllowed(kc)) return;
        const label = MOUSE_LABELS[e.button];
        if (!label) return;
        const msg = { type: 'keydown', keycode: kc, label };
        broadcastOverlay(msg);
        state.mainWindow?.webContents.send('keyoverlay-key', msg);
      });

      uIOhook.on('mouseup', (e) => {
        const kc = `m${e.button}`;
        if (!keyAllowed(kc)) return;
        const msg = { type: 'keyup', keycode: kc };
        broadcastOverlay(msg);
        state.mainWindow?.webContents.send('keyoverlay-key', msg);
      });

      uIOhook.start();

      keyOverlayHttpServer.listen(9001, '127.0.0.1', () => {
        state.keyOverlayRunning = true;
        state.mainWindow?.webContents.send('keyoverlay-status', { running: true, url: 'http://localhost:9001' });
      });

      keyOverlayHttpServer.on('error', (e) => {
        state.mainWindow?.webContents.send('keyoverlay-status', { running: false, error: `Puerto 9001 ocupado: ${e.message}` });
      });
    } catch (e) {
      state.mainWindow?.webContents.send('keyoverlay-status', { running: false, error: e.message });
    }
  }

  function stopKeyOverlay() {
    if (!state.keyOverlayRunning && !keyOverlayHttpServer) return;
    try { uiohookInstance?.stop(); uiohookInstance?.removeAllListeners(); } catch {}
    uiohookInstance = null;
    try { keyOverlayWss?.close(); } catch {}
    keyOverlayWss = null;
    try { keyOverlayHttpServer?.close(); } catch {}
    keyOverlayHttpServer = null;
    state.keyOverlayRunning = false;
    state.mainWindow?.webContents.send('keyoverlay-status', { running: false });
  }

  // ── Spotify Overlay ────────────────────────────────────────────
  let spotifyOverlayHttpServer = null;
  let spotifyOverlayWss        = null;
  let spotifyOverlayPollTimer  = null;

  function broadcastSpotify(msg) {
    if (!spotifyOverlayWss) return;
    const str = JSON.stringify(msg);
    spotifyOverlayWss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
  }

  let _spotifyPollErrorCount = 0;
  let _spotifyPollOkCount = 0;
  let _activeRequesterSince = 0; // timestamp cuando se activó el requester actual

  async function spotifyOverlayPoll() {
    try {
      const data = await spotifyNowPlayingData();
      if (_spotifyPollErrorCount > 0) _spotifyPollErrorCount = 0;
      if (!data || !data.item) return;
      const trackId = data.item.id;

      // Log diagnóstico al inicio y cada 100 polls (~5 min)
      _spotifyPollOkCount++;
      if (_spotifyPollOkCount === 1 || _spotifyPollOkCount % 100 === 0) {
        const qLen = state.spotifyRequesterQueue.length;
        const activeNick = state.spotifyActiveRequester?.nick || 'ninguno';
        const clients = spotifyOverlayWss?.clients?.size || 0;
        saveLog('info', `[Overlay Spotify] Poll OK #${_spotifyPollOkCount}: track=${data.item.name}, queue=${qLen}, active=${activeNick}, ws_clients=${clients}`);
      }

      // Safeguard: limpiar entradas viejas de la queue (> 3 horas)
      const now = Date.now();
      const before = state.spotifyRequesterQueue.length;
      const expired = state.spotifyRequesterQueue.filter(r => r._addedAt && (now - r._addedAt) >= 3 * 60 * 60 * 1000);
      if (expired.length) {
        expired.forEach(r => state.sessionDoneIds.add(r.trackId));
        state.spotifyRequesterQueue = state.spotifyRequesterQueue.filter(r => !r._addedAt || (now - r._addedAt) < 3 * 60 * 60 * 1000);
        saveLog('info', `[Requester] Limpieza: ${before - state.spotifyRequesterQueue.length} entrada(s) expiradas eliminadas`);
        state.mainWindow?.webContents.send('request-queue-update', { queue: state.spotifyRequesterQueue, active: state.spotifyActiveRequester });
      }

      // Safeguard: si la queue crece más de 20 entradas, algo está mal — limpiar
      if (state.spotifyRequesterQueue.length > 20) {
        saveLog('warn', `[Requester] Queue con ${state.spotifyRequesterQueue.length} entradas — limpiando`);
        state.spotifyRequesterQueue.forEach(r => state.sessionDoneIds.add(r.trackId));
        state.spotifyRequesterQueue = [];
        state.mainWindow?.webContents.send('request-queue-update', { queue: [], active: state.spotifyActiveRequester });
      }

      // Safeguard: requester activo por más de 15 min de reproducción real sin cambiar la canción — limpiar
      if (state.spotifyActiveRequester && _activeRequesterSince && data.is_playing && (now - _activeRequesterSince > 15 * 60 * 1000)) {
        saveLog('warn', `[Requester] Requester activo por >15min de reproducción (${state.spotifyActiveRequester.nick}) — reseteando`);
        state.sessionDoneIds.add(state.spotifyActiveRequester.trackId);
        state.spotifyActiveRequester = null;
        _activeRequesterSince = 0;
        state.mainWindow?.webContents.send('request-queue-update', { queue: state.spotifyRequesterQueue, active: null });
      }

      if (state.spotifyActiveRequester?.trackId !== trackId) {
        // Marcar el track anterior como reproducido antes de reemplazarlo
        if (state.spotifyActiveRequester) {
          state.sessionDoneIds.add(state.spotifyActiveRequester.trackId);
        }
        const idx = state.spotifyRequesterQueue.findIndex(r => r.trackId === trackId);
        state.spotifyActiveRequester = idx >= 0 ? state.spotifyRequesterQueue.splice(idx, 1)[0] : null;
        _activeRequesterSince = state.spotifyActiveRequester ? now : 0;
        if (state.spotifyActiveRequester) {
          saveLog('info', `[Overlay] Requester activo: ${state.spotifyActiveRequester.nick} → ${trackId}`);
        }
        state.mainWindow?.webContents.send('request-queue-update', { queue: state.spotifyRequesterQueue, active: state.spotifyActiveRequester });
        if (state.spotifyActiveRequester && state.supabase) {
          state.supabase.from('app_logs').insert({ type: 'sr-done', msg: trackId }).then(() => {}).catch(() => {});
        }
      }
      if (!spotifyOverlayWss || spotifyOverlayWss.clients.size === 0) return;
      broadcastSpotify({
        type: 'track',
        data: {
          is_playing:  data.is_playing,
          progress_ms: data.progress_ms || 0,
          duration_ms: data.item.duration_ms || 0,
          requester:   state.spotifyActiveRequester ? state.spotifyActiveRequester.nick : null,
          track: {
            name:   data.item.name,
            artist: data.item.artists.map(a => a.name).join(', '),
            album:  data.item.album.name,
            image:  data.item.album.images[1]?.url || data.item.album.images[0]?.url || ''
          }
        }
      });
    } catch (e) {
      _spotifyPollErrorCount++;
      // Solo loguear el primer error y cada 20 ciclos (~1 min) para no spamear
      if (_spotifyPollErrorCount === 1 || _spotifyPollErrorCount % 20 === 0) {
        saveLog('warn', `[Overlay Spotify] Poll error (x${_spotifyPollErrorCount}): ${e.message}`);
      }
    }
  }

  function startSpotifyOverlay() {
    if (state.spotifyOverlayRunning) return;
    try {
      spotifyOverlayHttpServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const file = req.url === '/requester' ? 'overlay-requester.html' : 'overlay-spotify.html';
        res.end(fs.readFileSync(path.join(__dirname, '..', 'src', file)));
      });

      const { WebSocketServer: WSSp } = require('ws');
      spotifyOverlayWss = new WSSp({ server: spotifyOverlayHttpServer });

      // Heartbeat: ping all clients every 25s, close dead ones
      const spotifyHeartbeat = setInterval(() => {
        if (!spotifyOverlayWss) return;
        spotifyOverlayWss.clients.forEach(ws => {
          if (ws.isAlive === false) { ws.terminate(); return; }
          ws.isAlive = false;
          ws.ping();
        });
      }, 25000);
      spotifyOverlayWss.on('close', () => clearInterval(spotifyHeartbeat));

      spotifyOverlayWss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        ws.send(JSON.stringify({ type: 'config', data: state.spotifyOverlayConfig }));
        // Send current track immediately on connect
        spotifyNowPlayingData().then(data => {
          if (!data || !data.item) return;
          const trackId = data.item.id;
          const isRequesterTrack = state.spotifyActiveRequester?.trackId === trackId;
          ws.send(JSON.stringify({
            type: 'track',
            data: {
              is_playing:  data.is_playing,
              progress_ms: data.progress_ms || 0,
              duration_ms: data.item.duration_ms || 0,
              requester:   isRequesterTrack ? state.spotifyActiveRequester.nick : null,
              track: {
                name:   data.item.name,
                artist: data.item.artists.map(a => a.name).join(', '),
                album:  data.item.album.name,
                image:  data.item.album.images[1]?.url || data.item.album.images[0]?.url || ''
              }
            }
          }));
        }).catch(() => {});
      });

      spotifyOverlayHttpServer.listen(9002, '127.0.0.1', () => {
        state.spotifyOverlayRunning = true;
        spotifyOverlayPollTimer = setInterval(spotifyOverlayPoll, 3000);
        state.mainWindow?.webContents.send('spotify-overlay-status', { running: true, url: 'http://localhost:9002' });
      });

      spotifyOverlayHttpServer.on('error', (e) => {
        state.mainWindow?.webContents.send('spotify-overlay-status', { running: false, error: `Puerto 9002 ocupado: ${e.message}` });
      });
    } catch (e) {
      state.mainWindow?.webContents.send('spotify-overlay-status', { running: false, error: e.message });
    }
  }

  // ── Teams Overlay ───────────────────────────────────────────────
  let teamsOverlayHttpServer = null;
  let teamsOverlayWss        = null;

  function broadcastTeams(msg) {
    if (!teamsOverlayWss) return;
    const str = JSON.stringify(msg);
    teamsOverlayWss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
  }

  function startTeamsOverlay() {
    if (state.teamsOverlayRunning) return;
    try {
      const overlayPath = path.join(__dirname, '..', 'src', 'overlay-teams.html');
      teamsOverlayHttpServer = http.createServer((_req, res) => {
        fs.readFile(overlayPath, (err, data) => {
          if (err) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        });
      });
      const { WebSocketServer: WSSt } = require('ws');
      teamsOverlayWss = new WSSt({ server: teamsOverlayHttpServer });
      teamsOverlayHttpServer.listen(9004, '127.0.0.1', () => { state.teamsOverlayRunning = true; });
      teamsOverlayHttpServer.on('error', () => {});
    } catch {}
  }

  // ── Rocket League Overlay ───────────────────────────────────────
  let rlOverlayHttpServer = null;
  let rlOverlayWss        = null;
  let rlWatcher           = null;
  let rlRefreshTimer      = null;

  function rlRankColor(tier) {
    const map = {
      bronze: '#cd7f32', silver: '#a8a9ad', gold: '#ffd700',
      platinum: '#4dc9e6', diamond: '#b9f2ff', champion: '#e040fb',
      grandchampion: '#ff4655', supersonic: '#f5a623'
    };
    const t = (tier || '').toLowerCase();
    for (const [k, v] of Object.entries(map)) { if (t.includes(k)) return v; }
    return '#ffffff';
  }

  function parseRLStats(json) {
    try {
      const seg = json.data.segments.find(s => s.type === 'playlist' && s.attributes.playlistId === 13);
      // playlistId 13 = Ranked Doubles (most common). Fallback to first ranked playlist.
      const ranked = seg || json.data.segments.find(s => s.type === 'playlist' && s.metadata?.name?.toLowerCase().includes('ranked'));
      if (!ranked) return null;
      const st = ranked.stats;
      const tier = ranked.metadata?.tierName || '';
      return {
        mmr:     Math.round(st.rating?.value ?? 0),
        rank:    tier,
        tier:    ranked.metadata?.tier ?? 0,
        wins:    st.wins?.value ?? 0,
        losses:  (st.matchesPlayed?.value ?? 0) - (st.wins?.value ?? 0),
        matches: st.matchesPlayed?.value ?? 0,
        winRate: st.winPercentage?.value ?? 0,
        color:   rlRankColor(tier),
        division: ranked.metadata?.divisionName || '',
        playlist: ranked.metadata?.name || 'Ranked'
      };
    } catch { return null; }
  }

  async function fetchRLStats() {
    if (!state.rlOverlayConfig.username) return null;
    const { platform, username } = state.rlOverlayConfig;
    const url = `https://api.tracker.gg/api/v2/rocket-league/standard/profile/${platform}/${encodeURIComponent(username)}`;
    try {
      const res = await fetch(url, {
        headers: {
          'TRN-Api-Key': '',
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'application/json'
        }
      });
      if (!res.ok) return null;
      const json = await res.json();
      return parseRLStats(json);
    } catch { return null; }
  }

  function broadcastRL(msg) {
    if (!rlOverlayWss) return;
    const str = JSON.stringify(msg);
    rlOverlayWss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
  }

  async function refreshRLStats() {
    if (rlRefreshTimer) { clearTimeout(rlRefreshTimer); rlRefreshTimer = null; }
    const stats = await fetchRLStats();
    if (!stats) return;
    if (!state.rlSessionStart) state.rlSessionStart = { ...stats };
    state.rlStats = stats;
    const delta = {
      mmr:     state.rlStats.mmr - state.rlSessionStart.mmr,
      wins:    state.rlStats.wins - state.rlSessionStart.wins,
      losses:  state.rlStats.losses - state.rlSessionStart.losses,
      matches: state.rlStats.matches - state.rlSessionStart.matches,
    };
    broadcastRL({ type: 'stats', data: { stats: state.rlStats, delta, config: state.rlOverlayConfig } });
    state.mainWindow?.webContents.send('rl-stats-update', { stats: state.rlStats, delta });
  }

  function startRLWatcher() {
    if (rlWatcher) { try { rlWatcher.close(); } catch {} rlWatcher = null; }
    const demoDir = path.join(os.homedir(), 'Documents', 'My Games', 'Rocket League', 'TAGame', 'Demos');
    if (!fs.existsSync(demoDir)) return;
    try {
      rlWatcher = fs.watch(demoDir, (_event, filename) => {
        if (filename && filename.endsWith('.replay')) {
          // Wait 15s for tracker.gg to index the new match
          if (rlRefreshTimer) clearTimeout(rlRefreshTimer);
          rlRefreshTimer = setTimeout(refreshRLStats, 15000);
        }
      });
    } catch {}
  }

  function startRLOverlay() {
    if (state.rlOverlayRunning) return;
    try {
      const overlayPath = path.join(__dirname, '..', 'src', 'overlay-rl.html');
      rlOverlayHttpServer = http.createServer((_req, res) => {
        fs.readFile(overlayPath, (err, data) => {
          if (err) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
        });
      });
      const { WebSocketServer: WSSrl } = require('ws');
      rlOverlayWss = new WSSrl({ server: rlOverlayHttpServer });
      rlOverlayWss.on('connection', (ws) => {
        if (state.rlStats) {
          const delta = {
            mmr:     state.rlStats.mmr - (state.rlSessionStart?.mmr ?? state.rlStats.mmr),
            wins:    state.rlStats.wins - (state.rlSessionStart?.wins ?? state.rlStats.wins),
            losses:  state.rlStats.losses - (state.rlSessionStart?.losses ?? state.rlStats.losses),
            matches: state.rlStats.matches - (state.rlSessionStart?.matches ?? state.rlStats.matches),
          };
          ws.send(JSON.stringify({ type: 'stats', data: { stats: state.rlStats, delta, config: state.rlOverlayConfig } }));
        }
        ws.send(JSON.stringify({ type: 'config', data: state.rlOverlayConfig }));
      });
      rlOverlayHttpServer.listen(9003, '127.0.0.1', () => {
        state.rlOverlayRunning = true;
        startRLWatcher();
        if (state.rlOverlayConfig.username) refreshRLStats();
      });
      rlOverlayHttpServer.on('error', () => {});
    } catch {}
  }

  return {
    startKeyOverlay,
    stopKeyOverlay,
    broadcastOverlay,
    configMsg,
    startSpotifyOverlay,
    broadcastSpotify,
    startTeamsOverlay,
    startRLOverlay,
    refreshRLStats,
    broadcastRL,
    broadcastTeams,
  };
}

module.exports = { createOverlays };
