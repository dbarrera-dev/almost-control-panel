function createOverlays({ state, http, fs, path, os, saveLog, spotifyNowPlayingData, loadConfig }) {
  function pickLanIPv4() {
    try {
      const ifaces = os.networkInterfaces?.() || {};
      for (const addrs of Object.values(ifaces)) {
        for (const addr of addrs || []) {
          if (!addr || addr.internal) continue;
          const fam = typeof addr.family === 'string' ? addr.family : String(addr.family);
          if (fam !== 'IPv4' && fam !== '4') continue;
          if (String(addr.address || '').startsWith('169.254.')) continue;
          return addr.address;
        }
      }
    } catch {}
    return null;
  }

  function allowLanOverlays() {
    try {
      const cfg = loadConfig?.() || {};
      return cfg.allowLanOverlays === true;
    } catch {
      return false;
    }
  }

  function overlayBindHost() {
    return allowLanOverlays() ? '0.0.0.0' : '127.0.0.1';
  }

  // ── Key Overlay ────────────────────────────────────────────────
  let keyOverlayHttpServer = null;
  let keyOverlayWss = null;
  let uiohookInstance = null;
  const keyOverlayStatus = {
    running: false,
    url: 'http://localhost:9001',
    lanUrl: null,
    bindHost: '127.0.0.1',
    error: null,
  };

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

  function keyStyleFor(keycode) {
    const cfg = state.keyOverlayConfig || {};
    const styles = cfg.keyStyles && typeof cfg.keyStyles === 'object' ? cfg.keyStyles : {};
    return styles[String(keycode)] && typeof styles[String(keycode)] === 'object' ? styles[String(keycode)] : {};
  }

  function labelForKeycode(keycode, fallback) {
    const custom = (state.keyOverlayConfig?.customKeys || []).find(k => String(k.keycode) === String(keycode));
    const style = keyStyleFor(keycode);
    return style.label || custom?.label || fallback || KEY_LABELS_MAP[keycode] || `#${keycode}`;
  }

  function buildKeysList() {
    const cfg = state.keyOverlayConfig || { selectedKeys: [], customKeys: [] };
    const sel = new Set((cfg.selectedKeys || []).map(String));
    // Start with KEY_LAYOUT keys
    const items = KEY_LAYOUT.filter(k => sel.has(String(k.kc)))
      .map(k => {
        const style = keyStyleFor(k.kc);
        return {
          keycode: k.kc,
          label: style.label || k.l,
          row: k.row,
          hi: !!k.hi,
          flex: !!k.flex,
          sub: style.sub ?? k.sub ?? null,
          aliases: [],
          style,
        };
      });

    // Merge customKeys: if same label exists -> add as alias; otherwise add as new key
    (cfg.customKeys || []).forEach(ck => {
      const style = keyStyleFor(ck.keycode);
      const label = style.label || ck.label;
      const existing = items.find(i => i.label === label);
      if (existing) {
        existing.aliases.push(ck.keycode);
      } else {
        items.push({ keycode: ck.keycode, label, row: ck.row ?? 8, hi: false, flex: false, sub: style.sub || null, aliases: [], style });
      }
    });

    return items;
  }

  function configMsg() {
    return { type: 'config', data: { ...state.keyOverlayConfig, keys: buildKeysList() } };
  }

  function configRefreshMsg() {
    return { type: 'config-refresh' };
  }

  function getKeyOverlayStatus() {
    return { ...keyOverlayStatus };
  }

  function emitKeyOverlayStatus(patch = {}) {
    Object.assign(keyOverlayStatus, patch);
    state.mainWindow?.webContents.send('keyoverlay-status', { ...keyOverlayStatus });
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
      emitKeyOverlayStatus({ error: null });

      keyOverlayHttpServer = http.createServer((req, res) => {
        const reqPath = String(req?.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
        if (reqPath === '/key-overlay-config') {
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(configMsg().data));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, '..', 'src', 'overlay-keys.html')));
      });

      keyOverlayWss = new WebSocketServer({ server: keyOverlayHttpServer });
      keyOverlayWss.on('connection', (ws) => {
        ws.send(JSON.stringify(configRefreshMsg()));
      });

      uiohookInstance = uIOhook;

      uIOhook.on('keydown', (e) => {
        if (state.koDetecting) {
          state.koDetecting = false;
          const label = labelForKeycode(e.keycode, KEY_LABELS_MAP[e.keycode]);
          state.mainWindow?.webContents.send('keyoverlay-detected', { keycode: e.keycode, label });
          return;
        }
        if (!keyAllowed(e.keycode)) return;
        const label = labelForKeycode(e.keycode, KEY_LABELS_MAP[e.keycode] || String.fromCharCode(e.keycode));
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

      const bindHost = overlayBindHost();
      keyOverlayHttpServer.listen(9001, bindHost, () => {
        const exposeLan = bindHost === '0.0.0.0';
        const lanIp = exposeLan ? pickLanIPv4() : null;
        state.keyOverlayRunning = true;
        emitKeyOverlayStatus({
          running: true,
          url: 'http://localhost:9001',
          lanUrl: lanIp ? `http://${lanIp}:9001` : null,
          bindHost,
          error: null,
        });
      });

      keyOverlayHttpServer.on('error', (e) => {
        state.keyOverlayRunning = false;
        emitKeyOverlayStatus({ running: false, error: `Puerto 9001 ocupado: ${e.message}` });
      });
    } catch (e) {
      state.keyOverlayRunning = false;
      emitKeyOverlayStatus({ running: false, error: e.message });
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
    emitKeyOverlayStatus({ running: false, error: null });
  }

  // ── Spotify Overlay ────────────────────────────────────────────
  let spotifyOverlayHttpServer = null;
  let spotifyOverlayWss        = null;
  let spotifyOverlayPollTimer  = null;
  let spotifyOverlayHeartbeat  = null;
  let spotifyLastTrackPayload  = null;
  const spotifyOverlayStatus = {
    running: false,
    url: 'http://localhost:9002',
    requesterUrl: 'http://localhost:9002/requester',
    lanUrl: null,
    lanRequesterUrl: null,
    wsClients: 0,
    error: null,
    bindHost: '127.0.0.1',
  };

  function getSpotifyOverlayStatus() {
    return { ...spotifyOverlayStatus };
  }

  function emitSpotifyOverlayStatus(patch = {}) {
    Object.assign(spotifyOverlayStatus, patch);
    state.mainWindow?.webContents.send('spotify-overlay-status', { ...spotifyOverlayStatus });
  }

  function updateSpotifyWsClientCount() {
    const count = !spotifyOverlayWss
      ? 0
      : [...spotifyOverlayWss.clients].filter(c => c.readyState === 1).length;
    if (spotifyOverlayStatus.wsClients !== count) emitSpotifyOverlayStatus({ wsClients: count });
  }

  function spotifyTrackPayload(data, requesterNick) {
    const item = data?.item || {};
    const artists = Array.isArray(item.artists) ? item.artists.map(a => a?.name).filter(Boolean).join(', ') : '';
    const images = Array.isArray(item.album?.images) ? item.album.images : [];
    return {
      is_playing:  !!data?.is_playing,
      progress_ms: data?.progress_ms || 0,
      duration_ms: item.duration_ms || 0,
      requester:   requesterNick || null,
      track: {
        name:   item.name || '',
        artist: artists,
        album:  item.album?.name || '',
        image:  images[1]?.url || images[0]?.url || ''
      }
    };
  }

  function extractTrackId(data) {
    const item = data?.item || null;
    if (!item) return null;
    if (item.id) return item.id;
    if (typeof item.uri === 'string' && item.uri.includes(':')) {
      const id = item.uri.split(':')[2];
      return id || null;
    }
    return null;
  }

  function activateRequesterForTrack(trackId, nowTs) {
    if (!trackId) return;
    const now = nowTs || Date.now();
    if (state.spotifyActiveRequester?.trackId === trackId) return;

    if (state.spotifyActiveRequester?.trackId) {
      const prevTrackId = state.spotifyActiveRequester.trackId;
      state.sessionDoneIds.add(prevTrackId);
      if (state.supabase) {
        state.supabase.from('app_logs').insert({ type: 'sr-done', msg: prevTrackId }).then(() => {}).catch(() => {});
      }
    }

    const idx = state.spotifyRequesterQueue.findIndex(r => r.trackId === trackId);
    state.spotifyActiveRequester = idx >= 0 ? state.spotifyRequesterQueue.splice(idx, 1)[0] : null;
    _activeRequesterSince = state.spotifyActiveRequester ? now : 0;

    state.mainWindow?.webContents.send('request-queue-update', {
      queue: state.spotifyRequesterQueue,
      active: state.spotifyActiveRequester,
    });
  }

  function broadcastSpotify(msg) {
    if (!spotifyOverlayWss) return;
    const str = JSON.stringify(msg);
    spotifyOverlayWss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
  }

  let _spotifyPollErrorCount = 0;
  let _activeRequesterSince = 0; // timestamp cuando se activó el requester actual

  async function spotifyOverlayPoll() {
    try {
      const data = await spotifyNowPlayingData();
      if (_spotifyPollErrorCount > 0) {
        _spotifyPollErrorCount = 0;
        if (String(spotifyOverlayStatus.error || '').startsWith('Poll error:')) {
          emitSpotifyOverlayStatus({ error: null });
        }
      }
      if (!data || !data.item) {
        const payload = spotifyTrackPayload(data || null, null);
        spotifyLastTrackPayload = payload;
        if (spotifyOverlayWss && spotifyOverlayWss.clients.size > 0) {
          broadcastSpotify({ type: 'track', data: payload });
        }
        return;
      }
      const trackId = extractTrackId(data);

      // Safeguard: limpiar entradas viejas de la queue (> 3 horas)
      const now = Date.now();
      const expired = state.spotifyRequesterQueue.filter(r => r._addedAt && (now - r._addedAt) >= 3 * 60 * 60 * 1000);
      if (expired.length) {
        expired.forEach(r => state.sessionDoneIds.add(r.trackId));
        state.spotifyRequesterQueue = state.spotifyRequesterQueue.filter(r => !r._addedAt || (now - r._addedAt) < 3 * 60 * 60 * 1000);
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

      activateRequesterForTrack(trackId, now);
      const requesterNick = trackId && state.spotifyActiveRequester?.trackId === trackId
        ? state.spotifyActiveRequester.nick
        : null;
      const payload = spotifyTrackPayload(data, requesterNick);
      spotifyLastTrackPayload = payload;
      if (!spotifyOverlayWss || spotifyOverlayWss.clients.size === 0) return;
      broadcastSpotify({
        type: 'track',
        data: payload,
      });
    } catch (e) {
      _spotifyPollErrorCount++;
      // Solo loguear el primer error y cada 20 ciclos (~1 min) para no spamear
      if (_spotifyPollErrorCount === 1 || _spotifyPollErrorCount % 20 === 0) {
        saveLog('warn', `[Overlay Spotify] Poll error (x${_spotifyPollErrorCount}): ${e.message}`);
        emitSpotifyOverlayStatus({ error: `Poll error: ${e.message}` });
      }
    }
  }

  function startSpotifyOverlay() {
    if (state.spotifyOverlayRunning) return;
    try {
      emitSpotifyOverlayStatus({ error: null });
      spotifyOverlayHttpServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const reqPath = String(req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
        const file = reqPath === '/requester' ? 'overlay-requester.html' : 'overlay-spotify.html';
        res.end(fs.readFileSync(path.join(__dirname, '..', 'src', file)));
      });

      const { WebSocketServer: WSSp } = require('ws');
      spotifyOverlayWss = new WSSp({ server: spotifyOverlayHttpServer });
      spotifyOverlayWss.on('error', (e) => {
        state.spotifyOverlayRunning = false;
        if (spotifyOverlayPollTimer) { clearInterval(spotifyOverlayPollTimer); spotifyOverlayPollTimer = null; }
        emitSpotifyOverlayStatus({ running: false, error: `Puerto 9002 ocupado: ${e.message}` });
        saveLog('warn', `[Overlay Spotify] WebSocket error: ${e.message}`);
      });

      // Heartbeat: ping all clients every 25s, close dead ones
      spotifyOverlayHeartbeat = setInterval(() => {
        if (!spotifyOverlayWss) return;
        spotifyOverlayWss.clients.forEach(ws => {
          if (ws.isAlive === false) { ws.terminate(); return; }
          ws.isAlive = false;
          ws.ping();
        });
      }, 25000);
      spotifyOverlayWss.on('close', () => {
        if (spotifyOverlayHeartbeat) clearInterval(spotifyOverlayHeartbeat);
        spotifyOverlayHeartbeat = null;
        updateSpotifyWsClientCount();
      });

      spotifyOverlayWss.on('connection', (ws) => {
        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });
        updateSpotifyWsClientCount();
        ws.on('close', () => updateSpotifyWsClientCount());

        ws.send(JSON.stringify({ type: 'config', data: state.spotifyOverlayConfig }));
        if (spotifyLastTrackPayload) {
          ws.send(JSON.stringify({ type: 'track', data: spotifyLastTrackPayload }));
        }

        // Send current track immediately on connect
        spotifyNowPlayingData().then(data => {
          let payload = null;
          if (!data || !data.item) {
            payload = spotifyTrackPayload(data || null, null);
          } else {
            const trackId = extractTrackId(data);
            activateRequesterForTrack(trackId, Date.now());
            const requesterNick = trackId && state.spotifyActiveRequester?.trackId === trackId
              ? state.spotifyActiveRequester.nick
              : null;
            payload = spotifyTrackPayload(data, requesterNick);
          }
          spotifyLastTrackPayload = payload;
          ws.send(JSON.stringify({
            type: 'track',
            data: payload,
          }));
        }).catch(() => {});

        // Force one quick poll so app-first/OBS-late always syncs as soon as OBS attaches.
        spotifyOverlayPoll().catch(() => {});
      });

      const bindHost = overlayBindHost();
      spotifyOverlayHttpServer.listen(9002, bindHost, () => {
        const exposeLan = bindHost === '0.0.0.0';
        const lanIp = exposeLan ? pickLanIPv4() : null;
        state.spotifyOverlayRunning = true;
        if (spotifyOverlayPollTimer) clearInterval(spotifyOverlayPollTimer);
        spotifyOverlayPollTimer = setInterval(spotifyOverlayPoll, 3000);
        emitSpotifyOverlayStatus({
          running: true,
          url: 'http://localhost:9002',
          requesterUrl: 'http://localhost:9002/requester',
          lanUrl: lanIp ? `http://${lanIp}:9002` : null,
          lanRequesterUrl: lanIp ? `http://${lanIp}:9002/requester` : null,
          wsClients: 0,
          error: null,
          bindHost,
        });
      });

      spotifyOverlayHttpServer.on('error', (e) => {
        state.spotifyOverlayRunning = false;
        emitSpotifyOverlayStatus({ running: false, error: `Puerto 9002 ocupado: ${e.message}` });
        saveLog('warn', `[Overlay Spotify] Error al iniciar server: ${e.message}`);
      });
    } catch (e) {
      state.spotifyOverlayRunning = false;
      emitSpotifyOverlayStatus({ running: false, error: e.message });
      saveLog('warn', `[Overlay Spotify] Error inesperado al iniciar: ${e.message}`);
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
  let rlRealtimeSocket    = null;
  let rlRealtimeTcpSocket = null;
  let rlRealtimeTcpBuffer = '';
  let rlRealtimeTransport = null; // 'ws' | 'tcp'
  let rlRealtimeSocketPort = null;
  let rlRealtimeReconnectTimer = null;
  const RL_REALTIME_RECONNECT_MS = 3000;
  const rlRealtime = {
    connected: false,
    playerName: '',
    playerTeamNum: null,
    currentMatchGuid: null,
    completedGoals: 0,
    matchGoalsByGuid: new Map(),
    matchTeamByGuid: new Map(),
    endedMatches: new Set(),
    lastLiveEndTs: 0,
  };

  function normalizeRlOverlayConfig(cfg = {}) {
    return {
      platform: cfg.platform || 'epic',
      username: cfg.username || '',
      playlistId: Number(cfg.playlistId || 13),
      realtimeEnabled: cfg.realtimeEnabled !== false,
      statsApiPort: Number(cfg.statsApiPort || 49123),
      style: {
        bg: cfg.style?.bg || 'rgba(15,15,20,0.92)',
        text: cfg.style?.text || '#ffffff',
        accent: cfg.style?.accent || '#2563eb',
        radius: Number.isFinite(Number(cfg.style?.radius)) ? Number(cfg.style.radius) : 12
      }
    };
  }

  function resetRlRealtimeTracking({ keepIdentity = true } = {}) {
    rlRealtime.connected = (rlRealtimeSocket?.readyState === 1) || (rlRealtimeTcpSocket && !rlRealtimeTcpSocket.destroyed);
    rlRealtime.currentMatchGuid = null;
    rlRealtime.completedGoals = 0;
    rlRealtime.matchGoalsByGuid.clear();
    rlRealtime.matchTeamByGuid.clear();
    rlRealtime.endedMatches.clear();
    if (!keepIdentity) {
      rlRealtime.playerName = '';
      rlRealtime.playerTeamNum = null;
    }
  }

  function summaryFromRealtime() {
    const base = ensureRlSessionSummary();
    if (state.rlOverlayConfig?.realtimeEnabled === false) return base;
    const currentGuid = rlRealtime.currentMatchGuid || '';
    const liveGoals = currentGuid ? Number(rlRealtime.matchGoalsByGuid.get(currentGuid) || 0) : 0;
    return { ...base, goals: Math.max(0, Number(base.goals || 0), rlRealtime.completedGoals + liveGoals) };
  }

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

  function pickPlaylistSegment(segments, playlistId) {
    if (!Array.isArray(segments)) return null;
    const wanted = Number(playlistId || 13);
    const exact = segments.find((segment) => {
      if (segment?.type !== 'playlist') return false;
      const fromAttr = Number(segment?.attributes?.playlistId);
      const fromMeta = Number(segment?.metadata?.playlistId);
      return fromAttr === wanted || fromMeta === wanted;
    });
    if (exact) return exact;
    return segments.find((segment) => segment?.type === 'playlist' && String(segment?.metadata?.name || '').toLowerCase().includes('ranked')) || null;
  }

  function parseRLStats(json, playlistId) {
    try {
      const ranked = pickPlaylistSegment(json?.data?.segments, playlistId);
      if (!ranked) return null;
      const st = ranked?.stats || {};
      const globalStats = json?.data?.stats || {};
      const tier = ranked.metadata?.tierName || '';
      const wins = Number(st.wins?.value ?? 0);
      const matches = Number(st.matchesPlayed?.value ?? 0);
      const goals = Number(st.goals?.value ?? globalStats.goals?.value ?? 0);
      return {
        mmr:     Math.round(Number(st.rating?.value ?? 0)),
        rank:    tier,
        tier:    Number(ranked.metadata?.tier ?? 0),
        wins,
        losses:  Math.max(0, matches - wins),
        matches,
        goals,
        winRate: Number(st.winPercentage?.value ?? 0),
        color:   rlRankColor(tier),
        division: ranked.metadata?.divisionName || '',
        playlist: ranked.metadata?.name || 'Ranked'
      };
    } catch { return null; }
  }

  async function fetchRLStats() {
    state.rlOverlayConfig = normalizeRlOverlayConfig(state.rlOverlayConfig);
    if (!state.rlOverlayConfig.username) return null;
    const { platform, username, playlistId } = state.rlOverlayConfig;
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
      return parseRLStats(json, playlistId);
    } catch { return null; }
  }

  function defaultRlSessionSummary() {
    return { wins: 0, losses: 0, goals: 0, streak: 0, lastResult: null, matches: 0 };
  }

  function ensureRlSessionSummary() {
    const base = state.rlSessionSummary && typeof state.rlSessionSummary === 'object'
      ? state.rlSessionSummary
      : defaultRlSessionSummary();
    return {
      wins: Number(base.wins || 0),
      losses: Number(base.losses || 0),
      goals: Number(base.goals || 0),
      streak: Number(base.streak || 0),
      lastResult: base.lastResult === 'win' || base.lastResult === 'loss' ? base.lastResult : null,
      matches: Number(base.matches || 0),
    };
  }

  function updateRlSessionSummary(prevStats, nextStats) {
    const summary = ensureRlSessionSummary();
    if (!prevStats || !nextStats) return summary;

    const diffWins = Math.max(0, Number(nextStats.wins || 0) - Number(prevStats.wins || 0));
    const diffLosses = Math.max(0, Number(nextStats.losses || 0) - Number(prevStats.losses || 0));
    const diffMatches = Math.max(0, Number(nextStats.matches || 0) - Number(prevStats.matches || 0));
    const diffGoals = Math.max(0, Number(nextStats.goals || 0) - Number(prevStats.goals || 0));

    if (diffMatches <= 0) {
      return summary;
    }

    summary.matches += diffMatches;
    summary.wins += diffWins;
    summary.losses += diffLosses;
    summary.goals += diffGoals;

    if (diffWins > 0 && diffLosses === 0) {
      summary.lastResult = 'win';
      summary.streak = summary.streak > 0 ? summary.streak + diffWins : diffWins;
    } else if (diffLosses > 0 && diffWins === 0) {
      summary.lastResult = 'loss';
      summary.streak = summary.streak < 0 ? summary.streak - diffLosses : -diffLosses;
    } else if (diffWins > 0 || diffLosses > 0) {
      summary.lastResult = diffWins >= diffLosses ? 'win' : 'loss';
      summary.streak = 0;
    }

    return summary;
  }

  function computeRlDelta() {
    if (!state.rlStats || !state.rlSessionStart) {
      return { mmr: 0, wins: 0, losses: 0, matches: 0, goals: 0 };
    }
    return {
      mmr: Number(state.rlStats.mmr || 0) - Number(state.rlSessionStart.mmr || 0),
      wins: Number(state.rlStats.wins || 0) - Number(state.rlSessionStart.wins || 0),
      losses: Number(state.rlStats.losses || 0) - Number(state.rlSessionStart.losses || 0),
      matches: Number(state.rlStats.matches || 0) - Number(state.rlSessionStart.matches || 0),
      goals: Number(state.rlStats.goals || 0) - Number(state.rlSessionStart.goals || 0),
    };
  }

  function fallbackStatsFromRealtime() {
    const session = summaryFromRealtime();
    return {
      mmr: null,
      rank: 'Realtime API',
      tier: 0,
      wins: Number(session.wins || 0),
      losses: Number(session.losses || 0),
      matches: Number(session.matches || 0),
      goals: Number(session.goals || 0),
      winRate: session.matches > 0 ? (session.wins / session.matches) * 100 : 0,
      color: '#60a5fa',
      division: rlRealtime.playerName ? `· ${rlRealtime.playerName}` : '',
      playlist: 'Live match session'
    };
  }

  function buildRlPayload() {
    const config = normalizeRlOverlayConfig(state.rlOverlayConfig);
    const session = summaryFromRealtime();
    return {
      stats: state.rlStats || fallbackStatsFromRealtime(),
      delta: computeRlDelta(),
      session,
      realtime: {
        connected: rlRealtime.connected,
        port: Number(config.statsApiPort || 49123),
        playerName: rlRealtime.playerName || ''
      },
      config
    };
  }

  function updateSessionResultFromMatch(win) {
    const summary = ensureRlSessionSummary();
    summary.matches += 1;
    if (win) {
      summary.wins += 1;
      summary.lastResult = 'win';
      summary.streak = summary.streak > 0 ? summary.streak + 1 : 1;
    } else {
      summary.losses += 1;
      summary.lastResult = 'loss';
      summary.streak = summary.streak < 0 ? summary.streak - 1 : -1;
    }
    state.rlSessionSummary = summary;
  }

  function pickLocalPlayer(updateStateData) {
    const players = Array.isArray(updateStateData?.Players) ? updateStateData.Players : [];
    if (!players.length) return null;
    const hintName = String(state.rlOverlayConfig?.username || '').trim().toLowerCase();
    if (hintName) {
      const byHint = players.find((player) => String(player?.Name || '').trim().toLowerCase() === hintName);
      if (byHint) return byHint;
    }
    if (rlRealtime.playerName) {
      const byPrev = players.find((player) => String(player?.Name || '').trim().toLowerCase() === String(rlRealtime.playerName).trim().toLowerCase());
      if (byPrev) return byPrev;
    }
    const targetName = updateStateData?.Game?.Target?.Name;
    if (targetName) {
      const byTarget = players.find((player) => String(player?.Name || '').trim().toLowerCase() === String(targetName).trim().toLowerCase());
      if (byTarget) return byTarget;
    }
    return players[0];
  }

  function onRlRealtimeUpdateState(data) {
    const rawGuid = String(data?.MatchGuid || data?.MatchGUID || data?.Game?.MatchGuid || data?.Game?.MatchGUID || '').trim();
    const matchGuid = rawGuid || 'live';
    const me = pickLocalPlayer(data);
    if (!me) return;

    rlRealtime.playerName = String(me.Name || rlRealtime.playerName || '');
    rlRealtime.playerTeamNum = Number.isFinite(Number(me.TeamNum)) ? Number(me.TeamNum) : rlRealtime.playerTeamNum;
    rlRealtime.currentMatchGuid = matchGuid;
    if (rlRealtime.playerTeamNum !== null) {
      rlRealtime.matchTeamByGuid.set(matchGuid, rlRealtime.playerTeamNum);
    }

    const goalsNow = Math.max(0, Number(me.Goals || 0));
    rlRealtime.matchGoalsByGuid.set(matchGuid, goalsNow);

    const payload = buildRlPayload();
    broadcastRL({ type: 'stats', data: payload });
    state.mainWindow?.webContents.send('rl-stats-update', payload);
  }

  function onRlRealtimeMatchEnded(data) {
    const rawGuid = String(data?.MatchGuid || data?.MatchGUID || data?.Game?.MatchGuid || data?.Game?.MatchGUID || '').trim();
    const matchGuid = rawGuid || 'live';
    if (matchGuid === 'live') {
      const now = Date.now();
      if (now - Number(rlRealtime.lastLiveEndTs || 0) < 2500) return;
      rlRealtime.lastLiveEndTs = now;
    } else if (rlRealtime.endedMatches.has(matchGuid)) {
      return;
    }

    const myTeamNum = rlRealtime.matchTeamByGuid.get(matchGuid);
    let winnerTeamNum = Number(data?.WinnerTeamNum);
    if (!Number.isFinite(winnerTeamNum)) {
      winnerTeamNum = Number(data?.Game?.WinnerTeamNum);
    }
    if (!Number.isFinite(winnerTeamNum)) {
      winnerTeamNum = Number(data?.Game?.Winner);
    }
    if (Number.isFinite(myTeamNum) && Number.isFinite(winnerTeamNum)) {
      updateSessionResultFromMatch(myTeamNum === winnerTeamNum);
    }

    const goalsThisMatch = Number(rlRealtime.matchGoalsByGuid.get(matchGuid) || 0);
    rlRealtime.completedGoals += Math.max(0, goalsThisMatch);
    const summary = ensureRlSessionSummary();
    summary.goals = rlRealtime.completedGoals;
    state.rlSessionSummary = summary;

    if (matchGuid !== 'live') {
      rlRealtime.endedMatches.add(matchGuid);
      if (rlRealtime.endedMatches.size > 300) {
        rlRealtime.endedMatches.clear();
        rlRealtime.matchGoalsByGuid.clear();
        rlRealtime.matchTeamByGuid.clear();
      }
    }
    if (rlRealtime.currentMatchGuid === matchGuid) {
      rlRealtime.currentMatchGuid = null;
    }

    const payload = buildRlPayload();
    broadcastRL({ type: 'stats', data: payload });
    state.mainWindow?.webContents.send('rl-stats-update', payload);
  }

  function onRlRealtimeMessage(raw) {
    try {
      const rawText = String(raw || '').trim();
      const packed = parseConcatenatedJsonMessages(rawText);
      const payloads = packed.messages.length ? packed.messages : [rawText];

      for (const entry of payloads) {
        if (!entry) continue;
        const msg = JSON.parse(entry);
        const eventName = String(msg?.Event || msg?.event || msg?.Type || '');
        const data = (msg && typeof msg.Data === 'string') ? JSON.parse(msg.Data) : (msg?.Data || msg?.data || {});

        if (eventName === 'MatchInitialized') {
          rlRealtime.currentMatchGuid = String(data?.MatchGuid || data?.MatchGUID || '').trim() || 'live';
          rlRealtime.endedMatches.clear();
          rlRealtime.lastLiveEndTs = 0;
          continue;
        }
        if (eventName === 'UpdateState') onRlRealtimeUpdateState(data);
        if (eventName === 'MatchEnded') onRlRealtimeMatchEnded(data);
        if (eventName === 'MatchDestroyed') {
          rlRealtime.currentMatchGuid = null;
          rlRealtime.lastLiveEndTs = 0;
        }
      }
    } catch {}
  }

  function scheduleRlRealtimeReconnect() {
    if (rlRealtimeReconnectTimer) return;
    rlRealtimeReconnectTimer = setTimeout(() => {
      rlRealtimeReconnectTimer = null;
      startRlRealtimeFeed();
    }, RL_REALTIME_RECONNECT_MS);
  }

  function closeRlRealtimeSocket() {
    const socket = rlRealtimeSocket;
    if (!socket) return;
    rlRealtimeSocket = null;
    rlRealtimeSocketPort = null;

    // Evita "WebSocket was closed before the connection was established"
    // como uncaught en main process durante fallback/reconnect.
    try { socket.on?.('error', () => {}); } catch {}
    try { socket.on?.('close', () => {}); } catch {}
    try {
      const st = Number(socket.readyState);
      if (st === 0) {
        // CONNECTING -> terminate es más seguro que close
        socket.terminate?.();
      } else if (st === 1) {
        // OPEN
        socket.close?.();
      }
    } catch {}
    return;
  }

  function closeRlRealtimeTcpSocket() {
    if (!rlRealtimeTcpSocket) return;
    try { rlRealtimeTcpSocket.removeAllListeners?.(); } catch {}
    try { rlRealtimeTcpSocket.destroy(); } catch {}
    rlRealtimeTcpSocket = null;
    rlRealtimeTcpBuffer = '';
    rlRealtimeSocketPort = null;
  }

  function closeRlRealtimeTransports() {
    closeRlRealtimeSocket();
    closeRlRealtimeTcpSocket();
    rlRealtimeTransport = null;
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

    const leftover = depth > 0 && start >= 0 ? buffer.slice(start) : '';
    return { messages, leftover };
  }

  function connectRlRealtimeTcp(port) {
    const net = require('net');
    closeRlRealtimeTransports();
    rlRealtimeTransport = 'tcp';
    rlRealtime.connected = false;
    rlRealtimeSocketPort = port;

    rlRealtimeTcpSocket = net.createConnection({ host: '127.0.0.1', port });

    rlRealtimeTcpSocket.on('connect', () => {
      rlRealtime.connected = true;
      const payload = buildRlPayload();
      broadcastRL({ type: 'stats', data: payload });
      state.mainWindow?.webContents.send('rl-stats-update', payload);
    });

    rlRealtimeTcpSocket.on('data', (chunk) => {
      rlRealtimeTcpBuffer += String(chunk || '');
      const parsed = parseConcatenatedJsonMessages(rlRealtimeTcpBuffer);
      rlRealtimeTcpBuffer = parsed.leftover || '';
      for (const msg of parsed.messages) onRlRealtimeMessage(msg);
    });

    rlRealtimeTcpSocket.on('close', () => {
      rlRealtime.connected = false;
      closeRlRealtimeTcpSocket();
      rlRealtimeTransport = null;
      scheduleRlRealtimeReconnect();
    });

    rlRealtimeTcpSocket.on('error', () => {
      rlRealtime.connected = false;
      closeRlRealtimeTcpSocket();
      rlRealtimeTransport = null;
      scheduleRlRealtimeReconnect();
    });
  }

  function startRlRealtimeFeed() {
    state.rlOverlayConfig = normalizeRlOverlayConfig(state.rlOverlayConfig);
    if (state.rlOverlayConfig.realtimeEnabled === false) {
      if (rlRealtimeReconnectTimer) {
        clearTimeout(rlRealtimeReconnectTimer);
        rlRealtimeReconnectTimer = null;
      }
      resetRlRealtimeTracking({ keepIdentity: true });
      rlRealtime.connected = false;
      closeRlRealtimeTransports();
      return;
    }
    const port = Number(state.rlOverlayConfig.statsApiPort || 49123);
    if (
      rlRealtimeSocket
      && (rlRealtimeSocket.readyState === 0 || rlRealtimeSocket.readyState === 1)
      && rlRealtimeSocketPort === port
    ) return;
    if (
      rlRealtimeTcpSocket
      && !rlRealtimeTcpSocket.destroyed
      && rlRealtimeSocketPort === port
    ) return;

    const { WebSocket } = require('ws');
    closeRlRealtimeTransports();
    rlRealtimeTransport = 'ws';
    rlRealtime.connected = false;
    let opened = false;
    let usedFallback = false;
    const wsFallbackTimer = setTimeout(() => {
      if (opened || usedFallback) return;
      usedFallback = true;
      closeRlRealtimeSocket();
      connectRlRealtimeTcp(port);
    }, 1500);

    try {
      rlRealtimeSocket = new WebSocket(`ws://127.0.0.1:${port}`);
      rlRealtimeSocketPort = port;
    } catch {
      clearTimeout(wsFallbackTimer);
      rlRealtime.connected = false;
      connectRlRealtimeTcp(port);
      return;
    }

    rlRealtimeSocket.on('open', () => {
      clearTimeout(wsFallbackTimer);
      opened = true;
      rlRealtimeTransport = 'ws';
      rlRealtime.connected = true;
      const payload = buildRlPayload();
      broadcastRL({ type: 'stats', data: payload });
      state.mainWindow?.webContents.send('rl-stats-update', payload);
    });

    rlRealtimeSocket.on('message', (data) => onRlRealtimeMessage(data));
    rlRealtimeSocket.on('close', () => {
      clearTimeout(wsFallbackTimer);
      rlRealtime.connected = false;
      closeRlRealtimeSocket();
      if (!opened && !usedFallback) {
        usedFallback = true;
        connectRlRealtimeTcp(port);
        return;
      }
      if (rlRealtimeTransport === 'ws') scheduleRlRealtimeReconnect();
    });
    rlRealtimeSocket.on('error', () => {
      clearTimeout(wsFallbackTimer);
      rlRealtime.connected = false;
      closeRlRealtimeSocket();
      if (!opened && !usedFallback) {
        usedFallback = true;
        connectRlRealtimeTcp(port);
        return;
      }
      if (rlRealtimeTransport === 'ws') scheduleRlRealtimeReconnect();
    });
  }

  function broadcastRL(msg) {
    if (!rlOverlayWss) return;
    const str = JSON.stringify(msg);
    rlOverlayWss.clients.forEach(c => { if (c.readyState === 1) c.send(str); });
  }

  async function refreshRLStats() {
    if (rlRefreshTimer) { clearTimeout(rlRefreshTimer); rlRefreshTimer = null; }
    state.rlOverlayConfig = normalizeRlOverlayConfig(state.rlOverlayConfig);
    if (state.rlOverlayConfig.realtimeEnabled !== false) {
      startRlRealtimeFeed();
    }
    const stats = await fetchRLStats();
    if (!stats) {
      const payloadNoTracker = buildRlPayload();
      broadcastRL({ type: 'stats', data: payloadNoTracker });
      state.mainWindow?.webContents.send('rl-stats-update', payloadNoTracker);
      return payloadNoTracker;
    }

    const prevStats = state.rlStats ? { ...state.rlStats } : null;
    if (!state.rlSessionStart) state.rlSessionStart = { ...stats };
    if (state.rlOverlayConfig.realtimeEnabled === false) {
      state.rlSessionSummary = prevStats ? updateRlSessionSummary(prevStats, stats) : ensureRlSessionSummary();
    } else {
      state.rlSessionSummary = ensureRlSessionSummary();
    }
    state.rlStats = stats;
    const payload = buildRlPayload();
    broadcastRL({ type: 'stats', data: payload });
    state.mainWindow?.webContents.send('rl-stats-update', payload);
    return payload;
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
        ws.send(JSON.stringify({ type: 'stats', data: buildRlPayload() }));
        ws.send(JSON.stringify({ type: 'config', data: normalizeRlOverlayConfig(state.rlOverlayConfig) }));
      });
      rlOverlayHttpServer.listen(9003, '127.0.0.1', () => {
        state.rlOverlayRunning = true;
        state.rlOverlayConfig = normalizeRlOverlayConfig(state.rlOverlayConfig);
        startRlRealtimeFeed();
        startRLWatcher();
        refreshRLStats();
      });
      rlOverlayHttpServer.on('error', () => {});
    } catch {}
  }

  function resetRLSessionTracking() {
    state.rlSessionStart = state.rlStats ? { ...state.rlStats } : null;
    state.rlSessionSummary = defaultRlSessionSummary();
    resetRlRealtimeTracking({ keepIdentity: true });
    startRlRealtimeFeed();
    const payload = buildRlPayload();
    broadcastRL({ type: 'stats', data: payload });
    state.mainWindow?.webContents.send('rl-stats-update', payload);
    return payload;
  }

  return {
    startKeyOverlay,
    stopKeyOverlay,
    getKeyOverlayStatus,
    broadcastOverlay,
    configMsg,
    configRefreshMsg,
    startSpotifyOverlay,
    getSpotifyOverlayStatus,
    broadcastSpotify,
    startTeamsOverlay,
    startRLOverlay,
    refreshRLStats,
    resetRLSessionTracking,
    broadcastRL,
    broadcastTeams,
  };
}

module.exports = { createOverlays };
