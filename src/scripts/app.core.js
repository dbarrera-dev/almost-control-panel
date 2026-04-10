
// ── State ──────────────────────────────────────────────────────────
let connected=false, torneoId=null, pCount=0, joins=0, tSize=2, pEmpty=true;
let bracketData=[], overlayRound='qf', ovPanel='yc';
let ycMin=5;
let saving=false;

// ── Sorteo State ───────────────────────────────────────────────────
let sorteoActivo=false, sorteoParticipantes=[], sorteoWinCount=1, sorteoCurrentWinners=[];

// ── Tabs ──────────────────────────────────────────────────────────
function goTab(name) {
  ['torneo','overlays','spotify','duelos','sorteos','rl','config','todos'].forEach(n => {
    document.getElementById('view-'+n).classList.toggle('on', n===name);
    document.getElementById('tab-'+n).classList.toggle('on', n===name);
  });
  if(name==='torneo') loadHistorial();
  if(name==='overlays') {
    loadOverlayUrl(ovPanel);
    if(!bracketData.length) loadOverlays();
  }
  if(name==='config') loadConfigForm();
  if(name==='spotify') loadSpotify();
  if(name==='duelos') renderDuelos();
  if(name==='sorteos') loadSorteo();
  if(name==='rl') loadRLOverlay();
  if(name==='todos') loadTodos();
}

function goOverlay(name) {
  ['yc','brb','fin','rl','teclas'].forEach(n => {
    document.getElementById('ov-'+n).classList.toggle('hidden', n!==name);
    document.getElementById('otab-'+n).classList.toggle('on', n===name);
  });
  ovPanel=name;
  if(name==='teclas') { loadKeyOverlay(); return; }
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
    document.getElementById('cUrl').value   = c.supabaseUrl||'';
    document.getElementById('cKey').value   = c.supabaseKey||'';
    document.getElementById('cUser').value  = c.botUsername||'';
    document.getElementById('cOauth').value = c.botOauth||'';
    document.getElementById('cChan').value  = c.twitchChannel||'';
    document.getElementById('cLogo').value  = c.logoUrl||'';
    if (document.getElementById('kChatroomId')) document.getElementById('kChatroomId').value = c.kickChatroomId||'';
    document.getElementById('cAutoConnect').checked = c.autoConnectBot !== false;
    updateLogo(c.logoUrl||'');
    api.getLoginItemSettings().then(s => {
      document.getElementById('cOpenAtLogin').checked = s.openAtLogin === true;
    }).catch(() => {});
    loadKickConfig();
  } catch (e) {
    log('warn', 'Error cargando config: ' + (e.message || e));
  }
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
  return {
    supabaseUrl:   document.getElementById('cUrl').value.trim(),
    supabaseKey:   document.getElementById('cKey').value.trim(),
    botUsername:   document.getElementById('cUser').value.trim(),
    botOauth:      document.getElementById('cOauth').value.trim(),
    twitchChannel: document.getElementById('cChan').value.trim(),
    logoUrl:       document.getElementById('cLogo').value.trim(),
    autoConnectBot: document.getElementById('cAutoConnect').checked,
    kickChannel: document.getElementById('kChannel').value.trim(),
    kickChatroomId: document.getElementById('kChatroomId') ? document.getElementById('kChatroomId').value.trim() : '',
    kickSongRequestRewardId: document.getElementById('kRewardId').value.trim(),
    autoConnectKickBot: document.getElementById('kAutoConnect').checked
  };
}

async function toggleOpenAtLogin() {
  const enabled = document.getElementById('cOpenAtLogin').checked;
  await api.saveConfig({ openAtLogin: enabled });
  toast(enabled ? 'La app abrirá al iniciar Windows' : 'Inicio automático desactivado', 'ok');
}

async function saveConfig() {
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
    if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
  }
}

// ── Keyboard Shortcuts ───────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

  // Alt+1..8 → switch tabs
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    const tabs = ['torneo','sorteos','duelos','todos','spotify','overlays','rl','config'];
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
