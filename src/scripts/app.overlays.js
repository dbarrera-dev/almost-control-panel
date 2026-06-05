// ── Overlays ──────────────────────────────────────────────────────
async function loadOverlays() {
  try {
    const r=await api.overlayLoadAll();
    if(!r.ok){log('warn','Error cargando overlays: '+(r.error||''));return;}
    const s=r.settings||{};

    const yc=s.ya_comenzamos||{};
    document.getElementById('ycTitle').value=yc.title||'YA COMENZAMOS';
    document.getElementById('ycMsg').value=yc.message||'El stream inicia en';
    ycMin=Math.floor((yc.countdown_seconds||300)/60);
    document.getElementById('ycMinVal').value=ycMin;
    updateYcPreview();

    const brb=s.brb||{};
    document.getElementById('brbTitle').value=brb.title||'VUELVO ENSEGUIDA';
    document.getElementById('brbMsg').value=brb.message||'Ya vuelvo...';

    const fin=s.fin_stream||{};
    document.getElementById('finTitle').value=fin.title||'FIN DEL STREAM';
    document.getElementById('finMsg').value=fin.message||'¡Gracias por quedarte!';

    bracketData=r.bracket||[];
    renderBracket();

    const startedAt = s.countdown_started_at;
    if (startedAt) {
      const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
      if (elapsed < ycMin * 60) cdTick(startedAt, ycMin * 60);
      else { document.getElementById('cdStatus').textContent = '¡Tiempo!'; document.getElementById('cdTimerLive').textContent = '00:00'; }
    } else {
      document.getElementById('cdTimerLive').textContent = `${String(ycMin).padStart(2,'0')}:00`;
    }

    log('info','Overlays cargados desde Supabase');
  } catch (e) {
    log('warn', 'Error cargando overlays: ' + (e.message || e));
  }
}

function abrirOverlay(tab) {
  const url = localStorage.getItem('ovUrl_'+tab) || '';
  if (url) api.openUrl(url);
}

function confirmOverlayUrl(tab) {
  const url = document.getElementById('ovUrl-'+tab).value.trim();
  if (url) {
    localStorage.setItem('ovUrl_'+tab, url);
    _showOverlayUrlSaved(tab, url);
  } else {
    localStorage.removeItem('ovUrl_'+tab);
    document.getElementById('ovUrl-'+tab).classList.remove('hidden');
    document.getElementById('ovUrlSaved-'+tab).classList.add('hidden');
    document.getElementById('ovEdit-'+tab).classList.add('hidden');
    document.getElementById('ovOpen-'+tab).disabled = true;
  }
}

function editOverlayUrl(tab) {
  document.getElementById('ovUrlSaved-'+tab).classList.add('hidden');
  document.getElementById('ovEdit-'+tab).classList.add('hidden');
  const inp = document.getElementById('ovUrl-'+tab);
  inp.classList.remove('hidden');
  inp.focus(); inp.select();
}

function _showOverlayUrlSaved(tab, url) {
  document.getElementById('ovUrl-'+tab).classList.add('hidden');
  document.getElementById('ovUrlSaved-'+tab).classList.remove('hidden');
  document.getElementById('ovEdit-'+tab).classList.remove('hidden');
  document.getElementById('ovOpen-'+tab).disabled = false;
  try { document.getElementById('ovUrlHost-'+tab).textContent = new URL(url).hostname; }
  catch { document.getElementById('ovUrlHost-'+tab).textContent = url.slice(0,40); }
}

function loadOverlayUrl(tab) {
  const url = localStorage.getItem('ovUrl_'+tab) || '';
  if (url) { document.getElementById('ovUrl-'+tab).value = url; _showOverlayUrlSaved(tab, url); }
  else { document.getElementById('ovUrl-'+tab).classList.remove('hidden'); }
}

// ── Countdown control ─────────────────────────────────────────────
let cdInterval = null;

function _ycValue(startedAt) {
  return {
    title: document.getElementById('ycTitle').value || 'YA COMENZAMOS',
    message: document.getElementById('ycMsg').value || 'El stream inicia en',
    countdown_seconds: ycMin * 60,
    countdown_started_at: startedAt
  };
}

async function cdStart() {
  const startedAt = new Date().toISOString();
  const r = await api.overlayUpdate('ya_comenzamos', _ycValue(startedAt));
  log(r?.ok ? 'info' : 'warn', r?.ok ? `▶ Contador iniciado (${ycMin} min) — Supabase OK` : `Error Supabase: ${r?.error||'desconocido'}`);
  if (!r?.ok) return;
  cdTick(startedAt, ycMin * 60);
}

async function cdReset() {
  clearInterval(cdInterval); cdInterval = null;
  await api.overlayUpdate('ya_comenzamos', _ycValue(null));
  document.getElementById('cdStatus').textContent = 'Detenido';
  document.getElementById('cdStatus').classList.remove('running');
  document.getElementById('cdTimerLive').textContent = `${String(ycMin).padStart(2,'0')}:00`;
  document.getElementById('cdStartBtn').disabled = false;
  log('info', '↺ Contador reseteado');
}

function cdTick(startedAt, totalSecs) {
  clearInterval(cdInterval);
  document.getElementById('cdStartBtn').disabled = true;
  document.getElementById('cdStatus').textContent = 'Corriendo';
  document.getElementById('cdStatus').classList.add('running');
  cdInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
    const remaining = Math.max(0, totalSecs - elapsed);
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    document.getElementById('cdTimerLive').textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    if (remaining === 0) {
      clearInterval(cdInterval); cdInterval = null;
      document.getElementById('cdStatus').textContent = '¡Tiempo!';
      document.getElementById('cdStartBtn').disabled = false;
    }
  }, 1000);
}

function updateYcPreview() {
  const title=document.getElementById('ycTitle').value||'YA COMENZAMOS';
  const msg=document.getElementById('ycMsg').value||'El stream inicia en';
  document.getElementById('pvYcTitle').textContent=title;
  document.getElementById('pvYcMsg').textContent=msg;
  document.getElementById('pvYcTimer').textContent=String(ycMin).padStart(2,'0')+':00';
  document.getElementById('ycSecLabel').textContent=`${ycMin} min (${ycMin*60}s)`;
}

async function saveOverlay(key) {
  if(saving) return; saving=true;
  let value;
  if(key==='ya_comenzamos') value={title:document.getElementById('ycTitle').value,message:document.getElementById('ycMsg').value,countdown_seconds:ycMin*60};
  if(key==='brb') value={title:document.getElementById('brbTitle').value,message:document.getElementById('brbMsg').value};
  if(key==='fin_stream') value={title:document.getElementById('finTitle').value,message:document.getElementById('finMsg').value};
  try {
    const r=await api.overlayUpdate(key,value);
    if(r.ok) toast('Guardado en Supabase','ok');
    else toast('Error al guardar','err');
  } catch (e) {
    toast('Error al guardar','err');
  } finally {
    saving=false;
  }
}

// ── Bracket ───────────────────────────────────────────────────────
function renderBracket() {
  renderRound('qf',[0,1,2,3],'PARTIDO');
  renderRound('sf',[4,5],'SEMIFINAL');
  renderGF();
  renderTorneoBracket();
}

// ── Bracket visual (read-only) dentro de la pantalla de Torneos ───
function _brGet(idx) {
  return bracketData.find(x => x.match_index === idx)
    || { id:null, team_a:'', team_b:'', score_a:0, score_b:0, winner:null, match_index:idx };
}

function _brTeamRow(name, score, side, winner, placeholder) {
  const isWin = winner === side;
  const isLose = winner && winner !== side;
  const cls = 't-mteam' + (isWin ? ' win' : isLose ? ' lose' : '');
  const label = name
    ? '<span class="t-mteam-name">' + _h(name) + '</span>'
    : '<span class="t-mteam-name t-mteam-tbd">' + placeholder + '</span>';
  const sc = name ? (parseInt(score) || 0) : '·';
  return '<div class="' + cls + '">' + label + '<span class="t-mteam-score">' + sc + '</span></div>';
}

function _brMatchCard(m, label, isGF) {
  const decided = !!m.winner;
  return '<div class="t-match' + (isGF ? ' gf' : '') + (decided ? ' decided' : '') +
    '" onclick="goEditBracket(' + m.match_index + ')" title="Editar este partido en Overlays">' +
    '<div class="t-match-lbl">' + label + (decided ? '<span class="t-match-tick">✓</span>' : '') + '</div>' +
    _brTeamRow(m.team_a, m.score_a, 'a', m.winner, isGF ? 'Finalista A' : 'Por definir') +
    _brTeamRow(m.team_b, m.score_b, 'b', m.winner, isGF ? 'Finalista B' : 'Por definir') +
    '</div>';
}

function renderTorneoBracket() {
  const tree = document.getElementById('tBracketTree');
  if (!tree) return;

  const qf = [0,1,2,3].map(_brGet);
  const sf = [4,5].map(_brGet);
  const gf = _brGet(6);

  tree.innerHTML =
    '<div class="t-br-col">' +
      '<div class="t-br-col-head">Cuartos</div>' +
      '<div class="t-br-col-body">' + qf.map((m,i)=>_brMatchCard(m,'Partido '+(i+1),false)).join('') + '</div>' +
    '</div>' +
    '<div class="t-br-col">' +
      '<div class="t-br-col-head">Semifinales</div>' +
      '<div class="t-br-col-body">' + sf.map((m,i)=>_brMatchCard(m,'Semifinal '+(i+1),false)).join('') + '</div>' +
    '</div>' +
    '<div class="t-br-col">' +
      '<div class="t-br-col-head">Gran Final</div>' +
      '<div class="t-br-col-body">' + _brMatchCard(gf,'Final',true) + '</div>' +
    '</div>';

  // ── Estadísticas de progreso ──
  const all = [...qf, ...sf, gf];
  const decided = all.filter(m => m.winner).length;
  const teams = new Set();
  all.forEach(m => {
    if (m.team_a) teams.add(m.team_a.trim().toLowerCase());
    if (m.team_b) teams.add(m.team_b.trim().toLowerCase());
  });
  const phase = gf.winner ? 'Finalizado'
    : (gf.team_a || gf.team_b) ? 'Gran Final'
    : (sf.some(m => m.team_a || m.team_b)) ? 'Semifinales'
    : 'Cuartos';

  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('brStMatches', decided + '/7');
  setTxt('brStTeams', teams.size);
  setTxt('brStPhase', phase);

  // ── Banner del campeón ──
  const champ = gf.winner === 'a' ? gf.team_a : gf.winner === 'b' ? gf.team_b : '';
  const banner = document.getElementById('tChampion');
  if (banner) {
    banner.classList.toggle('hidden', !champ);
    if (champ) setTxt('tChampionName', champ);
  }
}

function goEditBracket(idx) {
  openBracketModal();
  if (typeof idx === 'number') {
    const round = idx <= 3 ? 'qf' : idx <= 5 ? 'sf' : 'gf';
    if (typeof goBracketRound === 'function') goBracketRound(round);
  }
}

function openBracketModal() {
  const m = document.getElementById('tBracketModal');
  if (!m) return;
  loadOverlayUrl('rl');
  // Aseguramos que los formularios de partidos estén poblados.
  if (!bracketData.length) loadOverlays();
  else renderBracket();
  m.classList.remove('hidden');
  document.addEventListener('keydown', _bracketModalEsc);
}

function closeBracketModal() {
  const m = document.getElementById('tBracketModal');
  if (m) m.classList.add('hidden');
  document.removeEventListener('keydown', _bracketModalEsc);
}

function _bracketModalEsc(e) {
  if (e.key === 'Escape') closeBracketModal();
}

function openTorneoBracketOverlay() {
  const url = localStorage.getItem('ovUrl_rl') || '';
  if (!url) {
    toast('Configurá la URL del overlay en Overlays › Bracket RL', 'err');
    return;
  }
  api.openUrl(url);
}

function renderRound(round, indices, prefix) {
  const container=document.getElementById('br-'+round); container.innerHTML='';
  indices.forEach((idx,i)=>{
    const m=bracketData.find(x=>x.match_index===idx)||{id:null,team_a:'',team_b:'',score_a:0,score_b:0,winner:null,match_index:idx};
    container.appendChild(buildMatchCard(m, `${prefix} ${i+1}`, false));
  });
}

function renderGF() {
  const container=document.getElementById('br-gf'); container.innerHTML='';
  const m=bracketData.find(x=>x.match_index===6)||{id:null,team_a:'',team_b:'',score_a:0,score_b:0,winner:null,match_index:6};
  container.appendChild(buildMatchCard(m,'GRAN FINAL',true));
}

function buildMatchCard(m, label, isGF) {
  const div=document.createElement('div'); div.className='match-card'+(isGF?' gf':''); div.id='mc-'+m.match_index;
  div.innerHTML=`
    <div class="match-head">
      <span class="match-lbl${isGF?' gf':''}">${label}</span>
      <span class="match-idx">match_index: ${m.match_index}</span>
      ${m.winner?`<span class="match-done">${isGF?'CAMPEÓN':'FINALIZADO'}</span>`:''}
    </div>
    <div class="match-teams">
      <div class="match-team${m.winner==='a'?' win':m.winner==='b'?' lose':''}" id="mta-${m.match_index}">
        <span class="match-team-lbl">${isGF?'FINALISTA A':'EQUIPO A'}</span>
        <input class="match-input" id="ta-${m.match_index}" type="text" value="${m.team_a||''}" placeholder="${isGF?'Finalista A':'Equipo A'}" oninput="updateWinBtns(${m.match_index})" />
        <input class="match-score" id="sa-${m.match_index}" type="number" value="${m.score_a||0}" min="0" />
      </div>
      <div class="match-vs">VS</div>
      <div class="match-team${m.winner==='b'?' win':m.winner==='a'?' lose':''}" id="mtb-${m.match_index}">
        <span class="match-team-lbl">${isGF?'FINALISTA B':'EQUIPO B'}</span>
        <input class="match-input" id="tb-${m.match_index}" type="text" value="${m.team_b||''}" placeholder="${isGF?'Finalista B':'Equipo B'}" oninput="updateWinBtns(${m.match_index})" />
        <input class="match-score" id="sb-${m.match_index}" type="number" value="${m.score_b||0}" min="0" />
      </div>
    </div>
    <div class="match-winner-row">
      <span class="match-wlbl">${isGF?'CAMPEÓN:':'GANADOR:'}</span>
      <button class="win-btn${m.winner==='a'?' on':''}" id="wb-a-${m.match_index}" onclick="setWinner(${m.match_index},'a')">${m.team_a||'Equipo A'}</button>
      <button class="win-btn${m.winner==='b'?' on':''}" id="wb-b-${m.match_index}" onclick="setWinner(${m.match_index},'b')">${m.team_b||'Equipo B'}</button>
      <button class="win-btn clear${!m.winner?' on':''}" onclick="setWinner(${m.match_index},null)">Sin definir</button>
    </div>
    <button class="match-save${isGF?' gf':''}" onclick="saveMatch(${m.match_index})">${isGF?'Guardar Gran Final':'Guardar '+label}</button>
  `;
  return div;
}

function setWinner(idx, side) {
  const m=bracketData.find(x=>x.match_index===idx);
  if(m) m.winner=side;
  document.querySelectorAll(`[id^="wb-"][id$="-${idx}"]`).forEach(btn=>{
    btn.classList.toggle('on', (btn.id===`wb-a-${idx}`&&side==='a')||(btn.id===`wb-b-${idx}`&&side==='b'));
  });
  document.getElementById(`mta-${idx}`)?.classList.toggle('win', side==='a');
  document.getElementById(`mta-${idx}`)?.classList.toggle('lose', side==='b');
  document.getElementById(`mtb-${idx}`)?.classList.toggle('win', side==='b');
  document.getElementById(`mtb-${idx}`)?.classList.toggle('lose', side==='a');
}

function updateWinBtns(idx) {
  const ta=document.getElementById(`ta-${idx}`)?.value||'Equipo A';
  const tb=document.getElementById(`tb-${idx}`)?.value||'Equipo B';
  const btnA=document.getElementById(`wb-a-${idx}`); if(btnA) btnA.textContent=ta;
  const btnB=document.getElementById(`wb-b-${idx}`); if(btnB) btnB.textContent=tb;
}

async function saveMatch(idx) {
  const m=bracketData.find(x=>x.match_index===idx);
  if(!m||!m.id){toast('Partido no encontrado en BD','err');return;}
  const data={
    team_a: document.getElementById(`ta-${idx}`)?.value||'',
    team_b: document.getElementById(`tb-${idx}`)?.value||'',
    score_a: parseInt(document.getElementById(`sa-${idx}`)?.value)||0,
    score_b: parseInt(document.getElementById(`sb-${idx}`)?.value)||0,
    winner: m.winner
  };
  Object.assign(m, data);
  const r=await api.bracketUpdate(m.id, data);
  if(r.ok) { toast('Partido guardado','ok'); renderTorneoBracket(); }
  else toast('Error al guardar','err');
}

async function resetBracket() {
  showModal(
    'Resetear bracket',
    '<div style="font-size:12px;color:var(--text2);line-height:1.7">¿Resetear el bracket completo?<br><span style="color:#f87171">Se borran todos los equipos, scores y resultados.</span></div>' +
    '<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doResetBracket()">Sí, resetear</button>'
  );
}
async function _doResetBracket() {
  const r=await api.bracketReset();
  if(r.ok){ bracketData.forEach(m=>{m.team_a='';m.team_b='';m.score_a=0;m.score_b=0;m.winner=null;}); renderBracket(); toast('Bracket reseteado','ok'); }
  else toast('Error al resetear','err');
}

// ── RL Stats Overlay (panel dentro de Overlays) ──────────────────
let ovRlLoaded = false;
let ovRlBound = false;
let ovRlCfg = {
  platform: 'epic',
  username: '',
  playlistId: 13,
  realtimeEnabled: true,
  statsApiPort: 49123,
  style: { bg: 'rgba(15,15,20,0.92)', text: '#ffffff', accent: '#2563eb', radius: 12 }
};

function ovRlNormalizeCfg(cfg = {}) {
  const style = cfg.style || {};
  return {
    platform: cfg.platform || 'epic',
    username: cfg.username || '',
    playlistId: Number(cfg.playlistId || 13),
    realtimeEnabled: cfg.realtimeEnabled !== false,
    statsApiPort: Number(cfg.statsApiPort || 49123),
    style: {
      bg: style.bg || 'rgba(15,15,20,0.92)',
      text: style.text || '#ffffff',
      accent: style.accent || '#2563eb',
      radius: Number.isFinite(Number(style.radius)) ? Number(style.radius) : 12
    }
  };
}

function ovRlBgOpacityFromRgba(bg) {
  const match = String(bg || '').match(/rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\s*\)/i);
  const alpha = match ? Number(match[1]) : 0.92;
  const pct = Math.max(0, Math.min(100, Math.round(alpha * 100)));
  return Number.isFinite(pct) ? pct : 92;
}

async function loadRlOverlayPanel() {
  try {
    if (!ovRlLoaded) {
      const st = await api.rlOverlayStatus();
      if (!st?.running) await api.rlOverlayStart();
      ovRlLoaded = true;
    }

    const status = await api.rlOverlayStatus();
    ovRlApplyStatus(status);

    const payload = await api.rlOverlayGetConfig();
    ovRlCfg = ovRlNormalizeCfg(payload?.config || ovRlCfg);
    ovRlApplyUI();

    if (payload?.stats) ovRlShowStats(payload);

    if (!ovRlBound) {
      api.onRLStatsUpdate((data) => ovRlShowStats(data));
      ovRlBound = true;
    }
  } catch (e) {
    log('warn', 'Error cargando panel RL overlay: ' + (e.message || e));
  }
}

function ovRlApplyStatus(s) {
  const badge = document.getElementById('ovRlStatusBadge');
  if (!badge) return;
  if (s?.running) {
    badge.textContent = 'Activo';
    badge.className = 'badge badge-on';
  } else {
    badge.textContent = 'Inactivo';
    badge.className = 'badge badge-off';
  }
  if (s?.url) document.getElementById('ovRlUrlText').textContent = s.url;
}

function ovRlApplyUI() {
  document.getElementById('ovRlPlatform').value = ovRlCfg.platform || 'epic';
  document.getElementById('ovRlUsername').value = ovRlCfg.username || '';
  document.getElementById('ovRlPlaylist').value = String(ovRlCfg.playlistId || 13);
  document.getElementById('ovRlRealtimeMode').value = ovRlCfg.realtimeEnabled === false ? 'tracker' : 'realtime';
  document.getElementById('ovRlStatsPort').value = String(ovRlCfg.statsApiPort || 49123);
  document.getElementById('ovRlAccent').value = ovRlCfg.style.accent || '#2563eb';
  document.getElementById('ovRlAccentVal').textContent = ovRlCfg.style.accent || '#2563eb';
  document.getElementById('ovRlTextColor').value = ovRlCfg.style.text || '#ffffff';
  document.getElementById('ovRlTextVal').textContent = ovRlCfg.style.text || '#ffffff';
  document.getElementById('ovRlRadius').value = ovRlCfg.style.radius ?? 12;
  document.getElementById('ovRlRadiusVal').textContent = `${ovRlCfg.style.radius ?? 12}px`;
  const op = ovRlBgOpacityFromRgba(ovRlCfg.style.bg);
  document.getElementById('ovRlBgOp').value = op;
  document.getElementById('ovRlBgOpVal').textContent = `${op}%`;
}

function ovRlFormatResult(session) {
  const last = session?.lastResult || '';
  if (last === 'win') return 'WIN';
  if (last === 'loss') return 'LOSS';
  return '—';
}

function ovRlFormatStreak(session) {
  const streak = Number(session?.streak || 0);
  if (streak > 0) return `W${streak}`;
  if (streak < 0) return `L${Math.abs(streak)}`;
  return '0';
}

function ovRlShowStats(payload = {}) {
  const stats = payload?.stats;
  const delta = payload?.delta || {};
  const session = payload?.session || {};
  const realtime = payload?.realtime || {};
  if (!stats) return;

  document.getElementById('ovRlStatsCard').style.display = '';
  document.getElementById('ovRlMMR').textContent = stats.mmr ?? '—';
  document.getElementById('ovRlWins').textContent = stats.wins ?? '—';
  document.getElementById('ovRlLosses').textContent = stats.losses ?? '—';
  document.getElementById('ovRlGoals').textContent = stats.goals ?? '—';
  document.getElementById('ovRlRank').textContent = stats.rank || '—';
  document.getElementById('ovRlDivision').textContent = stats.division ? `· ${stats.division}` : '';
  document.getElementById('ovRlPlaylistName').textContent = stats.playlist || '';

  const mmrD = Number(delta.mmr || 0);
  const mmrTxt = mmrD > 0 ? `+${mmrD}` : `${mmrD}`;
  const mmrEl = document.getElementById('ovRlSessionMMR');
  mmrEl.textContent = mmrTxt;
  mmrEl.style.color = mmrD > 0 ? '#22c55e' : mmrD < 0 ? '#ef4444' : 'var(--text1)';

  const res = ovRlFormatResult(session);
  const resEl = document.getElementById('ovRlSessionResult');
  resEl.textContent = res;
  resEl.style.color = res === 'WIN' ? '#22c55e' : res === 'LOSS' ? '#ef4444' : 'var(--text1)';
  if (ovRlCfg.realtimeEnabled !== false) {
    if (realtime.connected) {
      const who = realtime.playerName ? ` (${realtime.playerName})` : '';
      document.getElementById('ovRlLastResult').textContent = res === '—'
        ? `Realtime conectado${who}`
        : `Última partida: ${res}${who}`;
    } else {
      document.getElementById('ovRlLastResult').textContent = `Esperando Rocket en puerto ${realtime.port || ovRlCfg.statsApiPort || 49123}`;
    }
  } else {
    document.getElementById('ovRlLastResult').textContent = res === '—' ? 'Modo tracker activo' : `Última partida: ${res}`;
  }

  const streakText = ovRlFormatStreak(session);
  const streakEl = document.getElementById('ovRlSessionStreak');
  streakEl.textContent = streakText;
  streakEl.style.color = streakText.startsWith('W') ? '#22c55e' : streakText.startsWith('L') ? '#ef4444' : 'var(--text1)';

  document.getElementById('ovRlSessionWL').textContent = `${session.wins || 0} / ${session.losses || 0}`;
  document.getElementById('ovRlSessionGoals').textContent = `${session.goals || 0}`;
}

async function ovRlSaveConfig() {
  const mode = document.getElementById('ovRlRealtimeMode').value;
  ovRlCfg.platform = document.getElementById('ovRlPlatform').value;
  ovRlCfg.username = document.getElementById('ovRlUsername').value.trim();
  ovRlCfg.playlistId = parseInt(document.getElementById('ovRlPlaylist').value, 10) || 13;
  ovRlCfg.realtimeEnabled = mode !== 'tracker';
  ovRlCfg.statsApiPort = parseInt(document.getElementById('ovRlStatsPort').value, 10) || 49123;
  await api.rlOverlaySetConfig(ovRlCfg);
}

async function ovRlSaveStyle() {
  ovRlCfg.style.accent = document.getElementById('ovRlAccent').value;
  ovRlCfg.style.text = document.getElementById('ovRlTextColor').value;
  document.getElementById('ovRlAccentVal').textContent = ovRlCfg.style.accent;
  document.getElementById('ovRlTextVal').textContent = ovRlCfg.style.text;
  await api.rlOverlaySetConfig(ovRlCfg);
}

function ovRlOnRadius(v) {
  ovRlCfg.style.radius = parseInt(v, 10) || 12;
  document.getElementById('ovRlRadiusVal').textContent = `${ovRlCfg.style.radius}px`;
  api.rlOverlaySetConfig(ovRlCfg);
}

function ovRlOnBgOp(v) {
  const value = parseInt(v, 10) || 92;
  document.getElementById('ovRlBgOpVal').textContent = `${value}%`;
  ovRlCfg.style.bg = `rgba(15,15,20,${(value / 100).toFixed(2)})`;
  api.rlOverlaySetConfig(ovRlCfg);
}

async function ovRlRefresh(btn) {
  const prev = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '↻ Actualizando...'; }
  try {
    const payload = await api.rlOverlayRefresh();
    if (payload?.stats) ovRlShowStats(payload);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = prev || '↻ Actualizar stats ahora'; }
  }
}

async function ovRlResetSession() {
  await api.rlOverlayResetSession();
  const payload = await api.rlOverlayRefresh();
  if (payload?.stats) ovRlShowStats(payload);
}

function ovRlCopyUrl(btn) {
  const txt = document.getElementById('ovRlUrlText')?.textContent || 'http://localhost:9003';
  navigator.clipboard.writeText(txt).then(() => {
    if (!btn) return;
    const prev = btn.textContent;
    btn.textContent = '✓ Copiado';
    setTimeout(() => { btn.textContent = prev; }, 1400);
  });
}
