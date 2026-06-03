// ── Log ───────────────────────────────────────────────────────────
const LOG_NOISE_PATTERNS = [
  /^\[Overlay Spotify\] Poll OK\b/i,
  /^\[Overlay\] Requester activo:/i,
  /^\[syncRequester\]\s+\d+\s+request\(s\)\s+restaurados/i,
  /^Kick chat:\s+mensaje enviado/i,
  /^\[songrequest\] pick /i,
  /^\[Kick chat\] @/i,
];
const LOG_SIDEBAR_PREF_KEY = 'almost.log.sidebar.visible';

function _readLogSidebarPref() {
  try {
    const raw = localStorage.getItem(LOG_SIDEBAR_PREF_KEY);
    if (raw === null) return false; // oculto por default para modo stream
    return raw === '1';
  } catch {
    return false;
  }
}

function _writeLogSidebarPref(visible) {
  try {
    localStorage.setItem(LOG_SIDEBAR_PREF_KEY, visible ? '1' : '0');
  } catch {}
}

function setLogSidebarVisible(visible, { persist = true } = {}) {
  const isVisible = !!visible;
  document.body.classList.toggle('log-hidden', !isVisible);

  const btn = document.getElementById('tbLogToggleBtn');
  const txt = document.getElementById('tbLogToggleTxt');
  if (btn) {
    btn.classList.toggle('is-active', isVisible);
    btn.title = isVisible ? 'Ocultar log' : 'Mostrar log';
    btn.setAttribute('aria-pressed', isVisible ? 'true' : 'false');
  }
  if (txt) txt.textContent = isVisible ? 'Ocultar log' : 'Mostrar log';

  if (persist) _writeLogSidebarPref(isVisible);
}

function toggleLogSidebar() {
  const visibleNow = !document.body.classList.contains('log-hidden');
  setLogSidebarVisible(!visibleNow);
}

function initLogSidebarVisibility() {
  setLogSidebarVisible(_readLogSidebarPref(), { persist: false });
}

initLogSidebarVisibility();

function isNoisyLog(type, msg) {
  const text = String(msg || '').trim();
  if (!text) return false;
  if (type === 'song' && /solicit[oó]:/i.test(text)) return true;
  return LOG_NOISE_PATTERNS.some(re => re.test(text));
}

function _maskUiSecret(value, start = 3, end = 3) {
  const v = String(value || '');
  if (!v) return '';
  if (v.length <= 8) return '***';
  return `${v.slice(0, start)}***${v.slice(Math.max(0, v.length - end))}`;
}

function _sanitizeUiLogMessage(raw) {
  let msg = String(raw ?? '');
  if (!msg) return '';
  msg = msg.replace(
    /("(?:access_token|refresh_token|client_secret|supabaseKey|api[_-]?key|authorization|token)"\s*:\s*")([^"]+)(")/gi,
    (_, p1, p2, p3) => `${p1}${_maskUiSecret(p2, 4, 2)}${p3}`
  );
  msg = msg.replace(
    /((?:access_token|refresh_token|client_secret|supabaseKey|api[_-]?key|authorization|token)\s*[=:]\s*)([^\s,;]+)/gi,
    (_, p1, p2) => `${p1}${_maskUiSecret(p2, 4, 2)}`
  );
  msg = msg.replace(
    /(Bearer\s+)([A-Za-z0-9._~-]{12,})/gi,
    (_, p1, p2) => `${p1}${_maskUiSecret(p2, 4, 2)}`
  );
  msg = msg.replace(
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/g,
    (jwt) => _maskUiSecret(jwt, 6, 4)
  );
  return msg;
}

function log(type, msg, date) {
  const safeMsg = _sanitizeUiLogMessage(msg);
  if (isNoisyLog(type, safeMsg)) return;
  const list = document.getElementById('llist');
  if (!list) return;
  const el = document.createElement('div'); el.className = 'le ' + type;
  const d = date ? new Date(date) : new Date();
  const isToday = d.toDateString() === new Date().toDateString();
  const t = isToday
    ? d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleDateString('es', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const time = document.createElement('span'); time.className = 'le-time'; time.textContent = t;
  const text = document.createTextNode(safeMsg);
  el.appendChild(time); el.appendChild(text);
  list.appendChild(el); list.scrollTop = list.scrollHeight;
  while (list.children.length > 500) list.removeChild(list.firstChild);
}
function clearLog() {
  const list = document.getElementById('llist');
  if (list) list.innerHTML = '';
}

async function loadLogHistory() {
  const r = await api.logsGet();
  if (!r.ok || !r.data.length) return;
  const list = document.getElementById('llist');
  if (!list) return;
  const frag = document.createDocumentFragment();
  let lastDay = null;
  r.data.forEach(entry => {
    const safeMsg = _sanitizeUiLogMessage(entry.msg);
    if (isNoisyLog(entry.type, safeMsg)) return;
    const d = new Date(entry.created_at);
    const day = d.toDateString();
    if (day !== lastDay) {
      lastDay = day;
      const sep = document.createElement('div');
      sep.style.cssText = 'font-size:10px;color:var(--text3);text-align:center;padding:4px 0;border-top:1px solid var(--border);margin-top:4px';
      sep.textContent = d.toLocaleDateString('es', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
      frag.appendChild(sep);
    }
    const el = document.createElement('div'); el.className = 'le ' + entry.type;
    const isToday = d.toDateString() === new Date().toDateString();
    const t = isToday
      ? d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    el.textContent = `[${t}] ${safeMsg}`;
    frag.appendChild(el);
  });
  list.appendChild(frag);
  list.scrollTop = list.scrollHeight;
}

// ── Toast ─────────────────────────────────────────────────────────
let toastTimer=null;
function toast(msg,type) {
  const el=document.getElementById('toast');
  el.textContent=msg; el.className=type;
  el.classList.remove('hidden');
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.classList.add('hidden'),3000);
}

// ── Alert ─────────────────────────────────────────────────────────
function showAlert(id,type,msg) {
  const el=document.getElementById(id);
  el.className=`alert alert-${type}`;el.textContent=msg;el.classList.remove('hidden');
  setTimeout(()=>el.classList.add('hidden'),3500);
}

// ── IPC ───────────────────────────────────────────────────────────
api.getVersion().then(v => { const el = document.getElementById('appVersion'); if (el) el.textContent = 'v' + v; });
api.onBotLog(({type,msg})=>log(type,msg));


api.onNewParticipante(({nick,senderNick,joined_at})=>{if(!torneoId)return;pCount++;joins++;updateStats();addP(nick,joined_at,senderNick);});
api.onRemoveParticipante(({nick,senderNick})=>{
  removeP(nick || senderNick);
  pCount=Math.max(0,pCount-1);
  updateStats();
});
api.onNewSorteoPart(({nick,joined_at})=>{ addSorteoParticipante({nick,joined_at}); });
