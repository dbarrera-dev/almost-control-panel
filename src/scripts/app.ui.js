// ── Log ───────────────────────────────────────────────────────────
function log(type, msg, date) {
  const list = document.getElementById('llist');
  const el = document.createElement('div'); el.className = 'le ' + type;
  const d = date ? new Date(date) : new Date();
  const isToday = d.toDateString() === new Date().toDateString();
  const t = isToday
    ? d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : d.toLocaleDateString('es', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const time = document.createElement('span'); time.className = 'le-time'; time.textContent = t;
  const text = document.createTextNode(msg);
  el.appendChild(time); el.appendChild(text);
  list.appendChild(el); list.scrollTop = list.scrollHeight;
  while (list.children.length > 500) list.removeChild(list.firstChild);
}
function clearLog() { document.getElementById('llist').innerHTML = ''; }

async function loadLogHistory() {
  const r = await api.logsGet();
  if (!r.ok || !r.data.length) return;
  const list = document.getElementById('llist');
  const frag = document.createDocumentFragment();
  let lastDay = null;
  r.data.forEach(entry => {
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
    el.textContent = `[${t}] ${entry.msg}`;
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
api.onBotStatus(({connected:c,reason})=>{setConn(c);if(!c)log('warn',`Desconectado: ${reason||''}`);});
api.onBotLog(({type,msg})=>log(type,msg));


api.onNewParticipante(({nick,twitchNick,joined_at})=>{if(!torneoId)return;pCount++;joins++;updateStats();addP(nick,joined_at,twitchNick);});
api.onRemoveParticipante(({nick})=>{removeP(nick);pCount=Math.max(0,pCount-1);updateStats();});
api.onNewSorteoPart(({nick,joined_at})=>{ addSorteoParticipante({nick,joined_at}); });

