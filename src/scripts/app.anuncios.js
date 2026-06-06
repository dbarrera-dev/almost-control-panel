// ── Anuncios Discord ──────────────────────────────────────────────
let annWebhooks = [];
let annHistory = [];
let annSettings = { botName: 'Almost Bot', botAvatarUrl: '', contentStorageBucket: 'almost-content' };
let annFilter = 'all';
let annEditingId = null;

function annEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function annIsUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function annDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('es', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
  } catch {
    return '—';
  }
}

// ISO -> valor para <input type="datetime-local"> (hora local).
function annToLocalInput(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function annMaskUrl(value) {
  try {
    const u = new URL(String(value || ''));
    return `${u.origin}${u.pathname.slice(0, 22)}...${u.pathname.slice(-6)}`;
  } catch {
    const raw = String(value || '');
    return raw.length > 30 ? `${raw.slice(0, 30)}...` : raw;
  }
}

function annSetMsg(id, text, tone = '') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.style.color = tone === 'ok' ? 'var(--green)' : tone === 'err' ? 'var(--red)' : 'var(--text3)';
}

async function loadAnuncios() {
  try {
    const [settings, webhooks, history] = await Promise.all([
      api.discordSettingsGet(),
      api.discordWebhooksGet(),
      api.discordAnnouncementsGet(),
    ]);
    if (settings.ok) annSettings = settings.data || annSettings;
    annWebhooks = webhooks.ok ? (webhooks.data || []) : [];
    annHistory = history.ok ? (history.data || []) : [];
    annRenderWebhooks();
    annRenderHistory();
    annUpdateStats();
    annUpdateBadge();
    if (!webhooks.ok && webhooks.error) toast('Webhooks: ' + webhooks.error, 'err');
    if (!history.ok && history.error) toast('Anuncios: ' + history.error, 'err');
  } catch (e) {
    toast('Error cargando anuncios', 'err');
  }
}

function annSetFilter(filter) {
  annFilter = ['scheduled', 'sent', 'failed'].includes(filter) ? filter : 'all';
  [['all', 'annFilterAll'], ['scheduled', 'annFilterScheduled'], ['sent', 'annFilterSent'], ['failed', 'annFilterFailed']]
    .forEach(([key, id]) => document.getElementById(id)?.classList.toggle('on', annFilter === key));
  annRenderHistory();
}

function annUpdateStats() {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = String(value); };
  const sent = annHistory.filter(a => a.status === 'sent').length;
  const scheduled = annHistory.filter(a => a.status === 'scheduled' || a.status === 'sending').length;
  set('annStatTotal', annHistory.length);
  set('annStatSent', sent);
  set('annStatScheduled', scheduled);
  set('annFilterSchedCount', scheduled);
}

function annRenderWebhooks() {
  const sel = document.getElementById('annWebhookSelect');
  const meta = document.getElementById('annWebhookMeta');
  if (meta) meta.textContent = `${annWebhooks.length} webhook${annWebhooks.length !== 1 ? 's' : ''}`;
  if (sel) {
    const current = sel.value;
    sel.innerHTML = annWebhooks.length
      ? annWebhooks.map(w => `<option value="${annEsc(w.id)}"># ${annEsc(w.name)}</option>`).join('')
      : '<option value="">Sin webhooks configurados</option>';
    if (annWebhooks.some(w => w.id === current)) sel.value = current;
    sel.onchange = annPreview;
    if (typeof uiSelectScan === 'function') uiSelectScan(document.getElementById('view-anuncios'));
    sel.dispatchEvent(new Event('change'));
  }
  const list = document.getElementById('annWebhookList');
  if (list) {
    if (!annWebhooks.length) {
      list.innerHTML = `<div class="sorteo-empty"><p>No hay webhooks configurados.</p></div>`;
    } else {
      list.innerHTML = annWebhooks.map(w => `
        <div class="webhook-row">
          <div class="webhook-row-main">
            <div class="webhook-row-title"># ${annEsc(w.name)}</div>
            <div class="webhook-row-url">${annEsc(annMaskUrl(w.webhook_url))}</div>
          </div>
          <div class="webhook-row-actions">
            <button class="content-mini-btn" onclick="annTestWebhook('${w.id}')" title="Probar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>
            </button>
            <button class="content-mini-btn danger" onclick="annDeleteWebhook('${w.id}')" title="Eliminar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            </button>
          </div>
        </div>
      `).join('');
    }
  }
}

function annSelectedWebhook() {
  const id = document.getElementById('annWebhookSelect')?.value || '';
  return annWebhooks.find(w => w.id === id) || null;
}

function annFormData() {
  const scheduleOn = !!document.getElementById('annScheduleToggle')?.checked;
  const localValue = document.getElementById('annScheduleAt')?.value || '';
  let scheduledAt = '';
  if (scheduleOn && localValue) {
    const d = new Date(localValue);
    if (!isNaN(d.getTime())) scheduledAt = d.toISOString();
  }
  return {
    webhookId: document.getElementById('annWebhookSelect')?.value || '',
    title: document.getElementById('annTitle')?.value?.trim() || '',
    body: document.getElementById('annBody')?.value?.trim() || '',
    imageUrl: document.getElementById('annImageUrl')?.value?.trim() || '',
    footerText: document.getElementById('annFooter')?.value?.trim() || '',
    embedColor: document.getElementById('annColor')?.value?.trim() || '#e07000',
    scheduleOn,
    scheduledAt,
  };
}

function annPreview() {
  const data = annFormData();
  const wh = annSelectedWebhook();
  const box = document.getElementById('annDiscordPreview');
  const channel = document.getElementById('annPreviewChannel');
  if (channel) channel.textContent = wh ? `# ${wh.name}` : '# canal';
  if (!box) return;
  const botName = annSettings.botName || 'Almost Bot';
  const avatar = annSettings.botAvatarUrl || '';
  const img = data.imageUrl && annIsUrl(data.imageUrl)
    ? `<img class="discord-img" src="${annEsc(data.imageUrl)}" alt="">`
    : '';
  const footer = data.footerText ? `<div class="discord-footer">${annEsc(data.footerText)}</div>` : '';
  box.innerHTML = `
    <div class="discord-message">
      <div class="discord-avatar">${avatar ? `<img src="${annEsc(avatar)}" alt="">` : 'A'}</div>
      <div class="discord-main">
        <div class="discord-head">
          <span class="discord-name">${annEsc(botName)}</span>
          <span class="discord-bot">BOT</span>
          <span class="discord-time">Hoy</span>
        </div>
        <div class="discord-embed" style="border-left-color:${annEsc(data.embedColor)}">
          <div class="discord-title">${data.title ? annEsc(data.title) : 'Título del anuncio'}</div>
          <div class="discord-body">${data.body ? annEsc(data.body) : 'Cuerpo del mensaje...'}</div>
          ${img}
          ${footer}
        </div>
      </div>
    </div>
  `;
}

function annPickColor(btn) {
  const color = btn?.dataset?.color || '#e07000';
  document.querySelectorAll('#view-anuncios .color-swatch').forEach(b => b.classList.toggle('on', b === btn));
  const input = document.getElementById('annColor');
  if (input) input.value = color;
  annPreview();
}

function annResetForm() {
  ['annTitle','annBody','annImageUrl','annFooter','annScheduleAt'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const color = document.getElementById('annColor');
  if (color) color.value = '#e07000';
  document.querySelectorAll('#view-anuncios .color-swatch').forEach((b, i) => b.classList.toggle('on', i === 0));
  const toggle = document.getElementById('annScheduleToggle');
  if (toggle) toggle.checked = false;
  annEditingId = null;
  annToggleSchedule();
  annSetMsg('annMsg', '');
  annPreview();
}

// ── Modal constructor ─────────────────────────────────────────────
function annOpenComposeModal(id = null) {
  const editing = id ? annHistory.find(a => a.id === id) : null;
  if (id && (!editing || editing.status !== 'scheduled')) {
    toast('Solo se pueden editar anuncios programados.', 'err');
    return;
  }
  annResetForm();
  annEditingId = editing ? editing.id : null;

  if (editing) {
    document.getElementById('annTitle').value = editing.title || '';
    document.getElementById('annBody').value = editing.body || '';
    document.getElementById('annImageUrl').value = editing.image_url || '';
    document.getElementById('annFooter').value = editing.footer_text || '';
    document.getElementById('annColor').value = editing.embed_color || '#e07000';
    document.querySelectorAll('#view-anuncios .color-swatch').forEach(b =>
      b.classList.toggle('on', (b.dataset.color || '').toLowerCase() === String(editing.embed_color || '').toLowerCase()));
    const toggle = document.getElementById('annScheduleToggle');
    if (toggle) toggle.checked = true;
    document.getElementById('annScheduleAt').value = annToLocalInput(editing.scheduled_at);
    annToggleSchedule();
    const wh = annWebhooks.find(w => w.id === editing.webhook_id || w.name === editing.channel_name);
    if (wh) annSetWebhookValue(wh.id);
  }

  document.getElementById('annComposeTitle').textContent = editing ? 'Editar anuncio programado' : 'Nuevo anuncio';
  document.getElementById('annComposeModal')?.classList.remove('hidden');
  document.addEventListener('keydown', annEscComposeModal);
  annPreview();
  setTimeout(() => document.getElementById('annTitle')?.focus(), 40);
}

function annCloseComposeModal() {
  document.getElementById('annComposeModal')?.classList.add('hidden');
  document.removeEventListener('keydown', annEscComposeModal);
  annEditingId = null;
}

function annEscComposeModal(e) {
  if (e.key === 'Escape') annCloseComposeModal();
}

// Selecciona un webhook tanto en el <select> nativo como en el dropdown custom.
function annSetWebhookValue(id) {
  const sel = document.getElementById('annWebhookSelect');
  if (!sel) return;
  sel.value = id;
  sel.dispatchEvent(new Event('change'));
  if (typeof uiSelectScan === 'function') uiSelectScan(document.getElementById('view-anuncios'));
}

function annToggleSchedule() {
  const on = !!document.getElementById('annScheduleToggle')?.checked;
  document.getElementById('annScheduleRow')?.classList.toggle('hidden', !on);
  const at = document.getElementById('annScheduleAt');
  if (on && at && !at.value) {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setSeconds(0, 0);
    at.value = annToLocalInput(d.toISOString());
  }
  const label = document.getElementById('annSendBtnLabel');
  if (label) label.textContent = annEditingId ? 'Guardar cambios' : (on ? 'Programar anuncio' : 'Enviar a Discord');
}

function annFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

async function annUploadImage(input) {
  const file = input?.files?.[0];
  if (!file) return;
  annSetMsg('annMsg', 'Subiendo imagen...');
  try {
    const dataUrl = await annFileToDataUrl(file);
    const r = await api.contentUploadImage({ dataUrl, fileName: file.name, folder: 'announcements' });
    input.value = '';
    if (!r.ok) {
      annSetMsg('annMsg', r.error || 'No se pudo subir la imagen.', 'err');
      return;
    }
    document.getElementById('annImageUrl').value = r.url;
    annSetMsg('annMsg', `Imagen subida al bucket ${r.bucket}.`, 'ok');
    annPreview();
  } catch (e) {
    annSetMsg('annMsg', e.message || 'Error subiendo imagen.', 'err');
  }
}

async function annSubmit() {
  const data = annFormData();
  if (!data.title) { annSetMsg('annMsg', 'El título es obligatorio.', 'err'); return; }
  if (!data.body) { annSetMsg('annMsg', 'El mensaje es obligatorio.', 'err'); return; }
  if (!data.webhookId) { annSetMsg('annMsg', 'Configurá y seleccioná un webhook.', 'err'); return; }
  if (data.imageUrl && !annIsUrl(data.imageUrl)) { annSetMsg('annMsg', 'La URL de imagen no es válida.', 'err'); return; }
  if (data.scheduleOn) {
    if (!data.scheduledAt) { annSetMsg('annMsg', 'Elegí una fecha y hora válida.', 'err'); return; }
    if (new Date(data.scheduledAt).getTime() < Date.now() + 30 * 1000) {
      annSetMsg('annMsg', 'La fecha debe ser al menos 30 segundos en el futuro.', 'err');
      return;
    }
  }

  const btn = document.getElementById('annSendBtn');
  if (btn) btn.disabled = true;

  const editing = annEditingId;
  const scheduling = data.scheduleOn;
  annSetMsg('annMsg', editing ? 'Guardando cambios...' : (scheduling ? 'Programando anuncio...' : 'Enviando a Discord...'));

  try {
    let r;
    if (editing) {
      r = await api.discordAnnouncementsUpdate(editing, data);
    } else if (scheduling) {
      r = await api.discordAnnouncementsSchedule(data);
    } else {
      r = await api.discordAnnouncementsSend(data);
    }

    if (!r.ok) {
      annSetMsg('annMsg', r.error || 'No se pudo completar la operación.', 'err');
      if (!editing && !scheduling) toast('Anuncio con error', 'err');
      await loadAnuncios();
      return;
    }

    await loadAnuncios();
    annCloseComposeModal();
    toast(editing ? 'Anuncio actualizado' : (scheduling ? 'Anuncio programado' : 'Anuncio enviado a Discord'), 'ok');
  } catch (e) {
    annSetMsg('annMsg', e.message || 'Error procesando el anuncio.', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function annSendNow(id) {
  const r = await api.discordAnnouncementsSendNow(id);
  await loadAnuncios();
  if (!r.ok) { toast(r.error || 'No se pudo enviar', 'err'); return; }
  toast('Anuncio enviado a Discord', 'ok');
}

const ANN_ICONS = {
  sendNow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  duplicate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="13" height="13" x="9" y="9" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};

function annRenderHistory() {
  const list = document.getElementById('annHistoryList');
  if (!list) return;
  const q = (document.getElementById('annSearchInput')?.value || '').toLowerCase().trim();
  const filtered = annHistory.filter(a => {
    const status = a.status === 'sending' ? 'scheduled' : a.status;
    if (annFilter !== 'all' && status !== annFilter) return false;
    const hay = `${a.title || ''} ${a.body || ''} ${a.channel_name || ''} ${a.status || ''}`.toLowerCase();
    return !q || hay.includes(q);
  }).sort((a, b) => {
    const aSched = a.status === 'scheduled' || a.status === 'sending';
    const bSched = b.status === 'scheduled' || b.status === 'sending';
    if (aSched && bSched) return new Date(a.scheduled_at || 0) - new Date(b.scheduled_at || 0);
    if (aSched) return -1;
    if (bSched) return 1;
    return new Date(b.sent_at || b.created_at || 0) - new Date(a.sent_at || a.created_at || 0);
  });

  if (!filtered.length) {
    const msg = q ? 'No hay anuncios con esa búsqueda.'
      : annFilter !== 'all' ? 'No hay anuncios en este estado.'
      : 'Todavía no hay anuncios.';
    list.innerHTML = `<div class="empty content-empty"><div class="empty-ico">!</div><p>${msg}</p></div>`;
    return;
  }

  list.innerHTML = filtered.map(annHistoryItemHtml).join('');
}

function annHistoryItemHtml(a) {
  const isScheduled = a.status === 'scheduled' || a.status === 'sending';
  const isFailed = a.status === 'failed';

  let statusChip;
  if (a.status === 'sending') statusChip = '<span class="content-chip ann-status-scheduled">Enviando</span>';
  else if (isScheduled) statusChip = `<span class="content-chip ann-status-scheduled">${ANN_ICONS.clock}Programado</span>`;
  else if (isFailed) statusChip = '<span class="content-chip ann-status-failed">Fallido</span>';
  else statusChip = '<span class="content-chip ann-status-sent">Enviado</span>';

  const dateText = isScheduled
    ? `Programado: ${annDate(a.scheduled_at)}`
    : annDate(a.sent_at || a.created_at);

  let actions = '';
  if (isScheduled) {
    actions = `
      <button class="content-mini-btn" onclick="annSendNow('${a.id}')" title="Enviar ahora">${ANN_ICONS.sendNow}</button>
      <button class="content-mini-btn" onclick="annOpenComposeModal('${a.id}')" title="Editar">${ANN_ICONS.edit}</button>
      <button class="content-mini-btn danger" onclick="annDeleteAnnouncement('${a.id}')" title="Cancelar">${ANN_ICONS.trash}</button>`;
  } else if (isFailed) {
    actions = `
      <button class="content-mini-btn" onclick="annSendNow('${a.id}')" title="Reintentar">${ANN_ICONS.sendNow}</button>
      <button class="content-mini-btn" onclick="annDuplicate('${a.id}')" title="Duplicar">${ANN_ICONS.duplicate}</button>
      <button class="content-mini-btn danger" onclick="annDeleteAnnouncement('${a.id}')" title="Eliminar">${ANN_ICONS.trash}</button>`;
  } else {
    actions = `
      <button class="content-mini-btn" onclick="annDuplicate('${a.id}')" title="Duplicar">${ANN_ICONS.duplicate}</button>
      <button class="content-mini-btn danger" onclick="annDeleteAnnouncement('${a.id}')" title="Eliminar">${ANN_ICONS.trash}</button>`;
  }

  return `<div class="content-item">
    <div class="content-item-text">
      <div class="content-item-title">${annEsc(a.title || 'Sin título')}</div>
      ${a.body ? `<div class="content-note-preview">${annEsc(a.body)}</div>` : ''}
      <div class="content-item-meta">
        ${statusChip}
        <span class="content-chip muted"># ${annEsc(a.channel_name || 'canal')}</span>
        <span class="content-item-date">${annEsc(dateText)}</span>
        ${isFailed && a.error_text ? `<span class="content-chip muted">${annEsc(a.error_text)}</span>` : ''}
      </div>
    </div>
    <div class="content-item-actions">${actions}</div>
  </div>`;
}

function annUpdateBadge() {
  const badge = document.getElementById('annBadge');
  if (!badge) return;
  const failed = annHistory.filter(a => a.status === 'failed').length;
  const scheduled = annHistory.filter(a => a.status === 'scheduled' || a.status === 'sending').length;
  const count = failed || scheduled;
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
  badge.style.background = failed ? '#ef4444' : '#5865F2';
  badge.style.color = '#fff';
}

function annDuplicate(id) {
  const a = annHistory.find(x => x.id === id);
  if (!a) return;
  annOpenComposeModal();
  document.getElementById('annTitle').value = a.title || '';
  document.getElementById('annBody').value = a.body || '';
  document.getElementById('annImageUrl').value = a.image_url || '';
  document.getElementById('annFooter').value = a.footer_text || '';
  document.getElementById('annColor').value = a.embed_color || '#e07000';
  document.querySelectorAll('#view-anuncios .color-swatch').forEach(b =>
    b.classList.toggle('on', (b.dataset.color || '').toLowerCase() === String(a.embed_color || '').toLowerCase()));
  const wh = annWebhooks.find(w => w.id === a.webhook_id || w.name === a.channel_name);
  if (wh) annSetWebhookValue(wh.id);
  annPreview();
}

function annDeleteAnnouncement(id) {
  const a = annHistory.find(x => x.id === id);
  const scheduled = a && (a.status === 'scheduled' || a.status === 'sending');
  const title = scheduled ? 'Cancelar anuncio programado' : 'Eliminar anuncio';
  const detail = scheduled
    ? 'Se cancelará el envío programado. Esta acción no se puede deshacer.'
    : 'No borra el mensaje ya enviado en Discord.';
  const confirmLabel = scheduled ? 'Sí, cancelar' : 'Sí, eliminar';
  showModal(
    title,
    `<div style="font-size:12px;color:var(--text2);line-height:1.7">¿${scheduled ? 'Cancelar' : 'Eliminar'} <strong style="color:var(--text)">${annEsc(a?.title || 'este anuncio')}</strong>?<br><span style="color:#f87171">${detail}</span></div>` +
    `<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doAnnDeleteAnnouncement('${id}')">${confirmLabel}</button>`
  );
}

async function _doAnnDeleteAnnouncement(id) {
  const r = await api.discordAnnouncementsDelete(id);
  if (!r.ok) { toast(r.error || 'Error al eliminar', 'err'); return; }
  annHistory = annHistory.filter(a => a.id !== id);
  annRenderHistory();
  annUpdateStats();
  annUpdateBadge();
  toast('Anuncio eliminado', 'ok');
}

function annOpenWebhookModal() {
  annSetMsg('annWebhookMsg', '');
  document.getElementById('annWebhookModal')?.classList.remove('hidden');
}

function annCloseWebhookModal() {
  document.getElementById('annWebhookModal')?.classList.add('hidden');
}

async function annAddWebhook() {
  const name = document.getElementById('annWebhookName')?.value?.trim() || '';
  const url = document.getElementById('annWebhookUrl')?.value?.trim() || '';
  if (!name || !url) { annSetMsg('annWebhookMsg', 'Nombre y URL son obligatorios.', 'err'); return; }
  const r = await api.discordWebhooksAdd({ name, url });
  if (!r.ok) { annSetMsg('annWebhookMsg', r.error || 'No se pudo agregar.', 'err'); return; }
  annWebhooks.unshift(r.data);
  document.getElementById('annWebhookName').value = '';
  document.getElementById('annWebhookUrl').value = '';
  annSetMsg('annWebhookMsg', 'Webhook agregado.', 'ok');
  annRenderWebhooks();
  annPreview();
}

function annDeleteWebhook(id) {
  showModal(
    'Eliminar webhook',
    `<div style="font-size:12px;color:var(--text2);line-height:1.7">¿Eliminar este webhook guardado?</div>` +
    `<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doAnnDeleteWebhook('${id}')">Sí, eliminar</button>`
  );
}

async function _doAnnDeleteWebhook(id) {
  const r = await api.discordWebhooksDelete(id);
  if (!r.ok) { annSetMsg('annWebhookMsg', r.error || 'No se pudo eliminar.', 'err'); return; }
  annWebhooks = annWebhooks.filter(w => w.id !== id);
  annSetMsg('annWebhookMsg', 'Webhook eliminado.', 'ok');
  annRenderWebhooks();
  annPreview();
}

async function annTestWebhook(id) {
  annSetMsg('annWebhookMsg', 'Enviando prueba...');
  const r = await api.discordWebhooksTest(id);
  annSetMsg('annWebhookMsg', r.ok ? 'Prueba enviada.' : (r.error || 'Error en la prueba.'), r.ok ? 'ok' : 'err');
}

function annOpenBotModal() {
  document.getElementById('annBotName').value = annSettings.botName || 'Almost Bot';
  document.getElementById('annBotAvatar').value = annSettings.botAvatarUrl || '';
  document.getElementById('annBucketName').value = annSettings.contentStorageBucket || 'almost-content';
  document.getElementById('annBotModal')?.classList.remove('hidden');
}

function annCloseBotModal() {
  document.getElementById('annBotModal')?.classList.add('hidden');
}

async function annSaveBotSettings() {
  const botName = document.getElementById('annBotName')?.value?.trim() || 'Almost Bot';
  const botAvatarUrl = document.getElementById('annBotAvatar')?.value?.trim() || '';
  const contentStorageBucket = document.getElementById('annBucketName')?.value?.trim() || 'almost-content';
  const r = await api.discordSettingsSet({ botName, botAvatarUrl, contentStorageBucket });
  if (!r.ok) { toast('No se pudo guardar perfil', 'err'); return; }
  annSettings = { botName, botAvatarUrl, contentStorageBucket };
  annCloseBotModal();
  annPreview();
  toast('Perfil del bot guardado', 'ok');
}

// El scheduler del proceso principal avisa cuando envía anuncios programados.
if (typeof api?.onDiscordAnnouncementsChanged === 'function') {
  api.onDiscordAnnouncementsChanged(() => loadAnuncios());
}
