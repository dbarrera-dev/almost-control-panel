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
  if(r.ok) toast('Partido guardado','ok');
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

