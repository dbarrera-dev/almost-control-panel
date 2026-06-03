(function () {
  const api = window.gcApi;
  let cfg = null;
  let state = null;

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ageLabel(ms) {
    const n = Number(ms || 0);
    if (!Number.isFinite(n) || n <= 0) return 'ahora';
    const s = Math.floor(n / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h`;
  }

  function sourceById(sourceId) {
    const list = cfg?.sources || [];
    return list.find((row) => row.id === sourceId) || null;
  }

  function setBusy(btn, busy, textBusy) {
    if (!btn) return;
    if (busy) {
      btn.dataset.prev = btn.textContent;
      btn.textContent = textBusy || 'Procesando...';
    } else if (btn.dataset.prev) {
      btn.textContent = btn.dataset.prev;
      delete btn.dataset.prev;
    }
    btn.disabled = !!busy;
  }

  function buildSourcesConfig() {
    const wrap = document.getElementById('sourcesConfig');
    if (!wrap) return;
    const list = cfg?.sources || [];
    wrap.innerHTML = list.map((source) => `
      <div class="source-box">
        <h3>${esc(source.label)}</h3>
        <div class="field">
          <label>Project ID</label>
          <input data-source="${esc(source.id)}" data-field="projectId" value="${esc(source.projectId || '')}" />
        </div>
        <div class="field">
          <label>Supabase URL</label>
          <input data-source="${esc(source.id)}" data-field="supabaseUrl" value="${esc(source.supabaseUrl || '')}" />
        </div>
        <div class="field">
          <label>Supabase Key</label>
          <input data-source="${esc(source.id)}" data-field="supabaseKey" value="${esc(source.supabaseKey || '')}" />
        </div>
      </div>
    `).join('');
  }

  function readSourcesFromInputs() {
    const next = JSON.parse(JSON.stringify(cfg || { uiLabel: 'general-control', sources: [] }));
    const entries = document.querySelectorAll('[data-source][data-field]');
    entries.forEach((input) => {
      const sourceId = String(input.getAttribute('data-source') || '').trim();
      const field = String(input.getAttribute('data-field') || '').trim();
      if (!sourceId || !field) return;
      const source = next.sources.find((row) => row.id === sourceId);
      if (!source) return;
      source[field] = input.value || '';
    });
    return next;
  }

  async function sendCommand(payload, btn) {
    setBusy(btn, true, 'Enviando...');
    try {
      const r = await api.sendCommand(payload);
      if (!r?.ok) {
        alert(r?.error || 'No se pudo enviar comando');
      }
      await refreshState();
    } finally {
      setBusy(btn, false);
    }
  }

  async function commandInstance(sourceId, instance, action, btn) {
    await sendCommand({
      sourceId,
      action,
      targetProject: instance.project || sourceById(sourceId)?.projectId || '',
      targetInstanceId: instance.instanceId || '',
      payload: { mode: instance?.kick?.mode || 'prod' },
    }, btn);
  }

  async function commandBulk(sourceId, action, btn) {
    const src = state?.sources?.find((row) => row.sourceId === sourceId);
    const list = src?.instances || [];
    const online = list.filter((row) => row.online);
    if (!online.length) return;
    setBusy(btn, true, 'Enviando...');
    try {
      for (const instance of online) {
        await api.sendCommand({
          sourceId,
          action,
          targetProject: instance.project || sourceById(sourceId)?.projectId || '',
          targetInstanceId: instance.instanceId || '',
          payload: { mode: instance?.kick?.mode || 'prod' },
        });
      }
      await refreshState();
    } finally {
      setBusy(btn, false);
    }
  }

  function renderInstances() {
    const wrap = document.getElementById('instancesWrap');
    const summary = document.getElementById('instancesSummary');
    if (!wrap || !summary) return;
    const sources = state?.sources || [];
    let total = 0;
    let online = 0;
    sources.forEach((src) => {
      total += src.instances.length;
      online += src.instances.filter((row) => row.online).length;
    });
    summary.textContent = `${online}/${total} online`;

    wrap.innerHTML = sources.map((src) => {
      const pill = src.ready ? '<span class="pill ok">SYNC OK</span>' : `<span class="pill bad">${esc(src.lastError || 'offline')}</span>`;
      const statusPill = src.realtimeStatus === 'SUBSCRIBED'
        ? '<span class="pill ok">Realtime</span>'
        : '<span class="pill warn">Fallback</span>';
      const rows = src.instances.map((instance) => `
        <tr>
          <td>
            <div>${esc(instance.label)}</div>
            <div class="small">${esc(instance.instanceId)}</div>
          </td>
          <td>
            <span class="pill ${instance.online ? 'ok' : 'warn'}">${instance.online ? 'online' : 'offline'}</span>
            <div class="small">visto ${esc(ageLabel(instance.ageMs))}</div>
          </td>
          <td>
            <div>${instance.kick.connected ? 'Conectado' : 'Desconectado'} ${instance.kick.channel ? '@' + esc(instance.kick.channel) : ''}</div>
            <div class="small">mode:${esc(instance.kick.mode || 'prod')} · queue:${Number(instance.songrequest.queuePending || 0)}</div>
            <div class="small">cmdFail:${Number(instance.runtime.commandFailed || 0)} · timeout:${Number(instance.runtime.commandTimeouts || 0)}</div>
          </td>
          <td class="cmd-actions">
            <button data-source="${esc(src.sourceId)}" data-instance="${esc(instance.instanceId)}" data-action="kick.connect">Connect</button>
            <button data-source="${esc(src.sourceId)}" data-instance="${esc(instance.instanceId)}" data-action="kick.disconnect">Disconnect</button>
            <button data-source="${esc(src.sourceId)}" data-instance="${esc(instance.instanceId)}" data-action="kick.reconnect">Reconnect</button>
            <button data-source="${esc(src.sourceId)}" data-instance="${esc(instance.instanceId)}" data-action="runtime.presence.ping">Ping</button>
            <button data-source="${esc(src.sourceId)}" data-instance="${esc(instance.instanceId)}" data-action="command.health.reset">Reset Health</button>
          </td>
        </tr>
      `).join('');
      return `
        <div class="source-title">
          <h3>${esc(src.label)} (${esc(src.projectId)})</h3>
          <div class="row">
            ${pill}
            ${statusPill}
            <button data-bulk="${esc(src.sourceId)}" data-action="kick.connect">Connect ALL</button>
            <button data-bulk="${esc(src.sourceId)}" data-action="kick.disconnect">Disconnect ALL</button>
            <button data-bulk="${esc(src.sourceId)}" data-action="runtime.presence.ping">Ping ALL</button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Instancia</th>
              <th>Estado</th>
              <th>Kick / Runtime</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="4" class="small">Sin instancias todavía.</td></tr>'}
          </tbody>
        </table>
      `;
    }).join('');

    wrap.querySelectorAll('button[data-source][data-instance][data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const sourceId = btn.getAttribute('data-source');
        const instanceId = btn.getAttribute('data-instance');
        const action = btn.getAttribute('data-action');
        const src = state?.sources?.find((row) => row.sourceId === sourceId);
        const instance = src?.instances?.find((row) => row.instanceId === instanceId);
        if (!instance) return;
        await commandInstance(sourceId, instance, action, btn);
      });
    });

    wrap.querySelectorAll('button[data-bulk][data-action]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await commandBulk(btn.getAttribute('data-bulk'), btn.getAttribute('data-action'), btn);
      });
    });
  }

  function renderCommands() {
    const wrap = document.getElementById('commandsWrap');
    if (!wrap) return;
    const rows = [];
    for (const source of (state?.sources || [])) {
      for (const cmd of (source.commands || [])) {
        rows.push({ ...cmd, sourceLabel: source.label, sourceId: source.sourceId });
      }
    }
    rows.sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
    const show = rows.slice(0, 120);
    wrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Fecha</th>
            <th>Fuente</th>
            <th>Acción</th>
            <th>Target</th>
            <th>Resultados</th>
          </tr>
        </thead>
        <tbody>
          ${show.map((row) => {
            const resultLines = Object.entries(row.results || {}).map(([instanceId, info]) => {
              const status = esc(info?.status || 'pending');
              const msg = esc(info?.message || '');
              return `<div class="small">${esc(instanceId)}: ${status}${msg ? ` · ${msg}` : ''}</div>`;
            }).join('');
            return `
              <tr>
                <td>${esc(row.createdAt || '—')}</td>
                <td>${esc(row.sourceLabel || row.sourceId)}</td>
                <td>${esc(row.action)}</td>
                <td>
                  <div>${esc(row.targetProject || 'ALL')}</div>
                  <div class="small">${esc(row.targetInstanceId || 'broadcast')}</div>
                </td>
                <td>${resultLines || '<span class="small">sin respuestas</span>'}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  function renderAll() {
    renderInstances();
    renderCommands();
  }

  async function refreshState() {
    const r = await api.refresh();
    if (r?.ok) {
      state = r;
      renderAll();
    }
  }

  async function init() {
    const cfgRes = await api.getConfig();
    cfg = cfgRes?.config || { uiLabel: 'general-control', sources: [] };
    buildSourcesConfig();

    document.getElementById('btnSaveConfig')?.addEventListener('click', async () => {
      const next = readSourcesFromInputs();
      const r = await api.saveConfig(next);
      if (!r?.ok) {
        alert(r?.error || 'No se pudo guardar');
        return;
      }
      cfg = r.config || next;
      await refreshState();
      buildSourcesConfig();
    });

    document.getElementById('btnRefresh')?.addEventListener('click', async () => {
      await refreshState();
    });

    document.getElementById('btnPruneCommands')?.addEventListener('click', async () => {
      for (const source of (cfg?.sources || [])) {
        await api.pruneOldCommands(source.id);
      }
      await refreshState();
    });

    api.onStateUpdated((nextState) => {
      state = nextState;
      renderAll();
    });

    const stateRes = await api.getState();
    state = stateRes?.ok ? stateRes : { sources: [] };
    renderAll();
  }

  init().catch((e) => {
    alert(`Error inicializando general-control: ${e?.message || e}`);
  });
})();
