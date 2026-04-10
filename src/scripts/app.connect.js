// ── Connect ───────────────────────────────────────────────────────
async function toggleConnect() {
  if(connected) { await api.disconnectBot(); setConn(false); log('info','Bot desconectado'); return; }
  await doConnect();
}
async function connectFromConfig() { await saveConfig(); await doConnect(); }

async function doConnect() {
  const cfg = getCfg();
  if(!cfg.supabaseUrl||!cfg.supabaseKey||!cfg.botUsername||!cfg.botOauth||!cfg.twitchChannel) {
    log('warn','Completa la configuración antes de conectar'); goTab('config'); return;
  }
  const btn=document.getElementById('btnC');
  btn.disabled=true; btn.textContent='⏳ Conectando...';
  log('info',`Conectando a #${cfg.twitchChannel}...`);
  const r = await api.connectBot(cfg);
  btn.disabled=false;
  if(r.ok) { setConn(true); log('info',`Conectado a #${cfg.twitchChannel}`); loadOverlays(); await restaurarTorneoActivo(); }
  else { setConn(false); log('warn',`Error: ${r.error}`); }
}

// ── Kick ─────────────────────────────────────────────────────────
let kickConnected = false;

async function kickOAuth() {
  const clientId     = document.getElementById('kClientId').value.trim();
  const clientSecret = document.getElementById('kClientSecret').value.trim();
  const kickChannel  = document.getElementById('kChannel').value.trim();
  if (!clientId || !clientSecret || !kickChannel) {
    toast('Completá Client ID, Secret y canal', 'warn'); return;
  }
  setKickStatus('Esperando autorización...');
  const r = await api.kickConnectOAuth({ clientId, clientSecret, kickChannel });
  if (r.ok) { setKickStatus('Cuenta autorizada. Conectá el bot.'); toast('Kick autorizado', 'ok'); }
  else       { setKickStatus('Error: ' + (r.error || 'desconocido')); toast('Error al autorizar Kick', 'err'); }
}

async function kickBotAccountOAuth() {
  const statusEl = document.getElementById('kickBotAccountStatus');
  statusEl.textContent = 'Esperando autorización...';
  const r = await api.kickBotOAuth();
  if (r.ok) { statusEl.textContent = 'Cuenta bot autorizada'; statusEl.style.color = 'var(--green)'; toast('Cuenta bot autorizada', 'ok'); }
  else      { statusEl.textContent = 'Error: ' + (r.error || 'desconocido'); statusEl.style.color = 'var(--red)'; toast('Error al autorizar cuenta bot', 'err'); }
}

async function toggleKickBot() {
  const btn = document.getElementById('kickBotBtn');
  const sbBtn = document.getElementById('kickSbBtn');
  if (kickConnected) {
    await api.kickBotDisconnect();
  } else {
    [btn, sbBtn].forEach(b => { if(b){b.disabled=true; b.textContent='Conectando...';} });
    const r = await api.kickBotConnect();
    [btn, sbBtn].forEach(b => { if(b) b.disabled=false; });
    if (!r.ok) { toast('Error Kick: ' + (r.error || 'desconocido'), 'err'); setKickStatus('Error: ' + r.error); }
  }
}

function setKickStatus(msg, connected) {
  const el = document.getElementById('kickConnStatus');
  const btn = document.getElementById('kickBotBtn');
  const sbDot = document.getElementById('sbKickDot');
  const sbTxt = document.getElementById('sbKickTxt');
  const sbBtn = document.getElementById('kickSbBtn');
  if (!el) return;
  if (connected !== undefined) {
    kickConnected = connected;
    el.style.color = connected ? 'var(--green)' : 'var(--text3)';
    el.textContent = connected ? 'Conectado a Kick' : (msg || 'Sin conectar');
    btn.textContent = connected ? 'Desconectar bot' : 'Conectar bot';
    if (sbDot) connected ? sbDot.classList.add('on') : sbDot.classList.remove('on');
    if (sbTxt) sbTxt.textContent = connected ? ('#'+(document.getElementById('kChannel')?.value.trim()||'kick')) : '';
    if (sbBtn) { sbBtn.textContent = connected ? 'Desconectar' : 'Conectar'; sbBtn.style.color = connected ? 'var(--red)' : ''; }
  } else {
    el.textContent = msg;
  }
}

function _setKickRewardBadge(enabled) {
  const badge = document.getElementById('kickRewardBadge');
  if (!badge) return;
  if (enabled === true)  { badge.style.background='rgba(83,208,103,.15)'; badge.style.color='#53d067'; badge.textContent='Habilitada'; }
  else if (enabled === false) { badge.style.background='rgba(248,113,113,.1)'; badge.style.color='#f87171'; badge.textContent='Deshabilitada'; }
  else { badge.style.background='rgba(255,255,255,.06)'; badge.style.color='var(--text3)'; badge.textContent='—'; }
}

async function kickRewardSet(enabled) {
  const msg = document.getElementById('kickRewardMsg');
  msg.textContent = enabled ? 'Habilitando...' : 'Deshabilitando...';
  msg.style.color = 'var(--text3)';
  const r = await api.kickRewardToggle(enabled);
  if (r.ok) {
    _setKickRewardBadge(enabled);
    msg.textContent = enabled ? 'Recompensa habilitada.' : 'Recompensa deshabilitada.';
    msg.style.color = enabled ? 'var(--green)' : 'var(--red)';
  } else {
    msg.textContent = 'Error: ' + (r.error || 'desconocido');
    msg.style.color = 'var(--red)';
  }
}

async function loadKickConfig() {
  const r = await api.kickGetConfig();
  if (!r.ok) return;
  if (r.clientId)    document.getElementById('kClientId').value    = r.clientId;
  if (r.kickChannel) document.getElementById('kChannel').value     = r.kickChannel;
  if (r.chatroomId && document.getElementById('kChatroomId')) document.getElementById('kChatroomId').value = r.chatroomId;
  if (r.rewardId)    document.getElementById('kRewardId').value    = r.rewardId;
  document.getElementById('kAutoConnect').checked = r.autoConnectKickBot !== false;
  if (r.connected) setKickStatus(null, true);
  else if (r.hasToken) setKickStatus('Cuenta autorizada. Conectá el bot.');
  const botEl = document.getElementById('kickBotAccountStatus');
  if (botEl) {
    if (r.hasBotToken) { botEl.textContent = 'Cuenta bot autorizada'; botEl.style.color = 'var(--green)'; }
    else               { botEl.textContent = 'Sin autorizar'; botEl.style.color = ''; }
  }
}

api.onKickBotStatus(({ connected, reason }) => {
  setKickStatus(reason, connected);
  if (!connected && reason) log('warn', `Kick desconectado: ${reason}`);
  if (connected)            log('info', 'Kick bot conectado');
});

// Recargar form si se cargaron credenciales desde Supabase automáticamente
api.onKickConfigLoaded(() => loadKickConfig());

// Recargar form de bot si se cargaron credenciales desde Supabase
api.onBotConfigLoaded(() => loadConfigForm());

function setConn(val) {
  connected=val;
  const pill=document.getElementById('connPill');
  const dot=document.getElementById('connDot');
  const txt=document.getElementById('connTxt');
  const ch=document.getElementById('connChan');
  const btn=document.getElementById('btnC');
  const sbDot=document.getElementById('sbTwitchDot');
  const sbTxt=document.getElementById('sbTwitchTxt');
  const chan=document.getElementById('cChan').value.trim();
  if(val) {
    pill.classList.add('on'); dot.classList.add('on');
    txt.textContent='Conectado'; ch.textContent='#'+chan; ch.classList.remove('hidden');
    btn.textContent='Desconectar'; btn.style.color='var(--red)';
    if(sbDot) sbDot.classList.add('on');
    if(sbTxt) sbTxt.textContent='#'+chan;
  } else {
    pill.classList.remove('on'); dot.classList.remove('on');
    txt.textContent='Desconectado'; ch.classList.add('hidden');
    btn.textContent='Conectar'; btn.style.color='';
    if(sbDot) sbDot.classList.remove('on');
    if(sbTxt) sbTxt.textContent='';
  }
}
