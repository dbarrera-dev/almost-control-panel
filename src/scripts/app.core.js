
// ── State ──────────────────────────────────────────────────────────
let torneoId=null, pCount=0, joins=0, tSize=2, pEmpty=true;
let bracketData=[], overlayRound='qf', ovPanel='yc';
let ycMin=5;
let saving=false;

// ── Sorteo State ───────────────────────────────────────────────────
let sorteoActivo=false, sorteoParticipantes=[], sorteoWinCount=1, sorteoCurrentWinners=[];

// ── Tabs ──────────────────────────────────────────────────────────
const _TAB_LOADER_FN = {
  dashboard: 'loadDashboard',
  torneo: '__coreLoadTorneoTab',
  overlays: '__coreLoadOverlaysTab',
  config: 'loadConfigForm',
  spotify: 'loadSpotify',
  kick: 'loadKickRewardsTab',
  duelos: 'renderDuelos',
  sorteos: 'loadSorteo',
  keys: 'loadKeyOverlay',
  rl: 'loadRLOverlay',
  todos: 'loadTodos',
  audiolink: 'loadAudiolink',
  'obs-dual': 'loadObsDual',
  soundboard: 'loadSoundboard',
};

function __coreLoadOverlaysTab() {
  loadOverlayUrl(ovPanel);
  if (!bracketData.length) loadOverlays();
}

function __coreLoadTorneoTab() {
  loadHistorial();
  // El bracket vive en Supabase (lo carga loadOverlays). Si ya está en memoria,
  // solo lo re-pintamos; si no, lo traemos (loadOverlays → renderBracket → renderTorneoBracket).
  if (!bracketData.length) loadOverlays();
  else if (typeof renderTorneoBracket === 'function') renderTorneoBracket();
}

function _runTabLoader(name, attempt = 0) {
  const fnName = _TAB_LOADER_FN[name];
  if (!fnName) return;
  const fn = globalThis[fnName];
  if (typeof fn !== 'function') {
    if (attempt < 10) setTimeout(() => _runTabLoader(name, attempt + 1), 80);
    return;
  }
  try {
    fn();
  } catch (e) {
    try { log('warn', `Error cargando tab "${name}": ${e?.message || e}`); } catch {}
  }
}

function goTab(name) {
  // Pestañas marcadas como "Pronto" no son navegables
  if (document.getElementById('tab-' + name)?.classList.contains('tab-soon')) return;
  ['dashboard','torneo','overlays','keys','spotify','kick','duelos','sorteos','rl','config','todos','audiolink','obs-dual','soundboard'].forEach(n => {
    const view = document.getElementById('view-' + n);
    const tab = document.getElementById('tab-' + n);
    if (view) view.classList.toggle('on', n === name);
    if (tab) tab.classList.toggle('on', n === name);
  });
  // Submenús del aside (Música, RL...): visibles solo en su pestaña
  document.querySelectorAll('.subnav').forEach((s) => {
    s.classList.toggle('hidden', s.id !== 'subnav-' + name);
  });
  _runTabLoader(name);
}

function goOverlay(name) {
  ['yc','brb','fin','rlstats','spotify'].forEach(n => {
    const section = document.getElementById('ov-'+n);
    const tab = document.getElementById('otab-'+n);
    if (section) section.classList.toggle('hidden', n!==name);
    if (tab) tab.classList.toggle('on', n===name);
  });
  ovPanel=name;
  if(name==='rlstats') {
    if (typeof loadRlOverlayPanel === 'function') loadRlOverlayPanel();
    return;
  }
  if(name==='spotify') { if (typeof spovInit === 'function') spovInit(); return; }
  loadOverlayUrl(name);
}

function goBracketRound(r) {
  ['qf','sf','gf'].forEach(n => {
    document.getElementById('br-'+n).classList.toggle('hidden', n!==r);
    document.getElementById('brtab-'+n).classList.toggle('on', n===r);
  });
  overlayRound=r;
}

// ── Config ────────────────────────────────────────────────────────
async function loadConfigForm() {
  try {
    const c = await api.getConfig();
    const setVal = (id, value) => { const el = document.getElementById(id); if (el) el.value = value ?? ''; };
    const setChk = (id, value) => { const el = document.getElementById(id); if (el) el.checked = !!value; };

    setVal('cUrl', c.supabaseUrl || '');
    setVal('cKey', c.supabaseKey || '');
    setVal('cLogo', c.logoUrl || '');

    setChk('cAutoConnect', c.autoConnectBot !== false);
    updateLogo(c.logoUrl||'');
    api.getLoginItemSettings().then(s => {
      document.getElementById('cOpenAtLogin').checked = s.openAtLogin === true;
    }).catch(() => {});
    loadKickConfig();
  } catch (e) {
    log('warn', 'Error cargando config: ' + (e.message || e));
  }
}

function onBotModeChanged() {
  // Compatibilidad: el modo activo ahora se maneja en Kick (onKickBotModeChanged)
}

function updateLogo(url) {
  const img = document.getElementById('brandLogo');
  const dot = document.getElementById('brandDot');
  if(url) {
    img.src = url;
    img.classList.remove('hidden');
    dot.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    dot.classList.remove('hidden');
  }
}

function getCfg() {
  const val = (id) => document.getElementById(id)?.value?.trim?.() || '';
  const checked = (id, fallback = false) => {
    const el = document.getElementById(id);
    return el ? !!el.checked : fallback;
  };

  const kickBotMode = document.getElementById('envModeDev')?.checked ? 'dev' : 'prod';
  // Volcar inputs actuales al bucket del modo activo para no perder cambios sin tocar el switcher
  const creds = window._kCreds || (window._kCreds = {
    prod: { clientId:'',clientSecret:'',channel:'',chatroomId:'',rewardId:'' },
    dev:  { clientId:'',clientSecret:'',channel:'',chatroomId:'',rewardId:'' },
  });
  const active = creds[kickBotMode] || (creds[kickBotMode] = {});
  active.clientId     = val('kClientId');
  active.clientSecret = val('kClientSecret');
  active.channel      = val('kChannel');
  active.chatroomId   = val('kChatroomId');
  const p = creds.prod || {};
  const d = creds.dev  || {};
  return {
    supabaseUrl: val('cUrl'),
    supabaseKey: val('cKey'),
    logoUrl: val('cLogo'),
    autoConnectBot: checked('cAutoConnect', true),
    kickBotMode,
    kickStartupMode: kickBotMode,
    // Prod
    kickClientId:               p.clientId     || '',
    kickClientSecret:           p.clientSecret || '',
    kickChannel:                p.channel      || '',
    kickChatroomId:             p.chatroomId   || '',
    // Dev
    kickClientIdDev:            d.clientId     || '',
    kickClientSecretDev:        d.clientSecret || '',
    kickDevChannel:             d.channel      || '',
    kickChatroomIdDev:          d.chatroomId   || '',
    autoConnectKickBot: checked('kAutoConnect', true),
  };
}

async function toggleOpenAtLogin() {
  const enabled = document.getElementById('cOpenAtLogin').checked;
  await api.saveConfig({ openAtLogin: enabled });
  toast(enabled ? 'La app abrirá al iniciar Windows' : 'Inicio automático desactivado', 'ok');
}

let _savingConfig = false;
async function saveConfig() {
  if (_savingConfig) return;
  _savingConfig = true;
  const btn = document.querySelector('#view-config .btn-orange');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    await api.saveConfig(getCfg());
    showAlert('cfgAlert','ok','Configuración guardada');
    toast('Guardado','ok');
  } catch (e) {
    showAlert('cfgAlert','err','Error al guardar');
    toast('Error al guardar','err');
  } finally {
    _savingConfig = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
  }
}

// ── Config nav helpers ───────────────────────────────────────────
function cfgNavGo(sectionId, evt) {
  const nav = document.querySelectorAll('#view-config .cfg-nav-item');
  nav.forEach(n => n.classList.toggle('on', n.dataset.target === sectionId));
  const sec = document.getElementById(sectionId);
  if (sec) sec.scrollIntoView({ behavior:'smooth', block:'start' });
  if (evt) evt.preventDefault();
}

// ── Modal de Ambiente (Prod/Dev) ─────────────────────────────────
function cfgOpenEnvModal() {
  const m = document.getElementById('cfgEnvModal');
  if (!m) return;
  m.classList.remove('hidden');
  document.addEventListener('keydown', _cfgEnvEsc);
}
function cfgCloseEnvModal() {
  const m = document.getElementById('cfgEnvModal');
  if (m) m.classList.add('hidden');
  document.removeEventListener('keydown', _cfgEnvEsc);
}
function _cfgEnvEsc(e) { if (e.key === 'Escape') cfgCloseEnvModal(); }

function cfgToggleSecret(btn) {
  const input = btn.parentNode?.querySelector('input');
  if (!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.setAttribute('aria-label', showing ? 'Mostrar' : 'Ocultar');
  const ico = btn.querySelector('svg');
  if (ico) ico.style.opacity = showing ? '.7' : '1';
}

// ── Keyboard Shortcuts ───────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  // Alt+1..9 → switch tabs
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    const tabs = ['dashboard','torneo','sorteos','duelos','todos','spotify','kick','overlays','keys','rl','config','audiolink','obs-dual','soundboard'];
    const idx = parseInt(e.key) - 1;
    if (idx >= 0 && idx < tabs.length) { e.preventDefault(); goTab(tabs[idx]); return; }
  }

  // Ctrl+S → save config (when on config tab)
  if (e.ctrlKey && e.key === 's') {
    e.preventDefault();
    const onConfig = document.getElementById('view-config')?.classList.contains('on');
    if (onConfig) saveConfig();
  }

  // Space → toggle Spotify play/pause (when on spotify tab)
  if (e.key === ' ' && !e.ctrlKey && !e.altKey) {
    const onSpotify = document.getElementById('view-spotify')?.classList.contains('on');
    if (onSpotify && spConnected) { e.preventDefault(); spTogglePlayPause(); }
  }
});
