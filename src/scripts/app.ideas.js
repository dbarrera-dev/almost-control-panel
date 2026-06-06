// ── Ideas ─────────────────────────────────────────────────────────
let ideasData = [];
let ideaEditingId = null;
let ideaDraftImages = [];
let ideaDraftLinks = [];

const IDEA_CATEGORIES = [
  'Partidas destacadas',
  'Guías y consejos',
  'Retos de Rocket League',
  'Análisis de partidas',
  'Noticias y actualizaciones',
  'Colaboraciones',
  'Shorts y clips',
  'Directos',
  'Ideas experimentales',
];

function ideaEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function ideaList(value) {
  return Array.isArray(value) ? value.map(v => String(v || '').trim()).filter(Boolean) : [];
}

function ideaIsUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function ideaSanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const allowedTags = new Set(['B','STRONG','I','EM','U','BR','P','DIV','UL','OL','LI','A']);
  const cleanNode = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) return;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        return;
      }
      if (!allowedTags.has(child.tagName)) {
        cleanNode(child);
        child.replaceWith(...child.childNodes);
        return;
      }
      const hrefBeforeClean = child.tagName === 'A' ? (child.getAttribute('href') || child.textContent || '') : '';
      [...child.attributes].forEach((attr) => child.removeAttribute(attr.name));
      if (child.tagName === 'A') {
        const href = hrefBeforeClean;
        if (ideaIsUrl(href)) {
          child.setAttribute('href', href);
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        }
      }
      cleanNode(child);
    });
  };
  cleanNode(tpl.content);
  return tpl.innerHTML.trim();
}

function ideaNotesText() {
  const el = document.getElementById('ideaNotes');
  return (el?.innerText || '').trim();
}

function ideaSetMsg(text, tone = '') {
  const el = document.getElementById('ideaModalMsg');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = tone === 'ok' ? 'var(--green)' : tone === 'err' ? 'var(--red)' : 'var(--text3)';
}

async function loadIdeas() {
  try {
    const r = await api.ideasGet();
    if (!r.ok) {
      ideasData = [];
      ideaRender();
      if (r.error) toast('Ideas: ' + r.error, 'err');
      return;
    }
    ideasData = (r.data || []).map((idea) => ({
      ...idea,
      reference_links: ideaList(idea.reference_links),
      images: ideaList(idea.images),
    }));
    ideaRender();
    ideaUpdateBadge();
  } catch (e) {
    ideasData = [];
    ideaRender();
    toast('Error cargando ideas', 'err');
  }
}

function ideaUpdateCategoryOptions() {
  const all = new Set(IDEA_CATEGORIES);
  ideasData.forEach(i => { if (i.category) all.add(i.category); });
  const values = [...all].sort((a, b) => a.localeCompare(b));
  const filter = document.getElementById('ideaCategoryFilter');
  if (filter) {
    const current = filter.value;
    filter.innerHTML = '<option value="">Todas las categorías</option>' + values.map(c => `<option value="${ideaEsc(c)}">${ideaEsc(c)}</option>`).join('');
    filter.value = values.includes(current) ? current : '';
  }
  const datalist = document.getElementById('ideaCategoryList');
  if (datalist) datalist.innerHTML = values.map(c => `<option value="${ideaEsc(c)}"></option>`).join('');
  if (typeof uiSelectScan === 'function') uiSelectScan(document.getElementById('view-ideas'));
}

function ideaRender() {
  const list = document.getElementById('ideaList');
  if (!list) return;
  ideaUpdateStats();
  ideaUpdateCategoryOptions();

  const q = (document.getElementById('ideaSearchInput')?.value || '').toLowerCase().trim();
  const cat = document.getElementById('ideaCategoryFilter')?.value || '';
  const filtered = ideasData.filter((i) => {
    const hay = `${i.title || ''} ${i.category || ''} ${i.notes_text || ''}`.toLowerCase();
    return (!q || hay.includes(q)) && (!cat || i.category === cat);
  });
  const count = document.getElementById('ideaCountLabel');
  if (count) count.textContent = `${filtered.length} idea${filtered.length !== 1 ? 's' : ''}`;

  if (!filtered.length) {
    list.innerHTML = `<div class="empty content-empty"><div class="empty-ico">+</div><p>${q || cat ? 'No hay ideas con esos filtros.' : 'No hay ideas todavía.'}</p></div>`;
    return;
  }

  list.innerHTML = filtered.map(ideaItemHtml).join('');
}

function ideaUpdateStats() {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = String(value); };
  const categories = new Set(ideasData.map(i => i.category).filter(Boolean));
  const refs = ideasData.reduce((acc, i) => acc + ideaList(i.reference_links).length + ideaList(i.images).length, 0);
  set('ideaStatTotal', ideasData.length);
  set('ideaStatCategories', categories.size);
  set('ideaStatRefs', refs);
}

function ideaItemHtml(i) {
  const links = ideaList(i.reference_links);
  const images = ideaList(i.images);
  const notes = ideaSanitizeHtml(i.notes_html || ideaEsc(i.notes_text || ''));
  const updated = i.updated_at ? new Date(i.updated_at).toLocaleDateString('es', { day:'2-digit', month:'short' }) : '';
  const thumb = images[0] ? `<div class="content-thumb"><img src="${ideaEsc(images[0])}" alt=""></div>` : '';
  const imgPill = images.length ? `<span class="content-count-pill" title="${images.length} imagen${images.length !== 1 ? 'es' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/></svg>${images.length}</span>` : '';
  const linkPill = links.length ? `<span class="content-count-pill" title="${links.length} enlace${links.length !== 1 ? 's' : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>${links.length}</span>` : '';
  return `<div class="content-item" id="idea-${i.id}">
    <div class="content-item-main">
      ${thumb}
      <div class="content-item-text">
        <div class="content-item-title">${ideaEsc(i.title || 'Sin título')}</div>
        ${notes ? `<div class="content-note-preview">${notes}</div>` : ''}
        <div class="content-item-meta">
          <span class="content-chip">${ideaEsc(i.category || 'General')}</span>
          ${updated ? `<span class="content-item-date">${ideaEsc(updated)}</span>` : ''}
          ${imgPill}
          ${linkPill}
        </div>
      </div>
    </div>
    <div class="content-item-actions">
      <button class="content-mini-btn" onclick="ideaEdit('${i.id}')" title="Editar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      </button>
      <button class="content-mini-btn danger" onclick="ideaDelete('${i.id}')" title="Eliminar">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  </div>`;
}

function ideaUpdateBadge() {
  const badge = document.getElementById('ideasBadge');
  if (!badge) return;
  badge.textContent = ideasData.length;
  badge.classList.toggle('hidden', ideasData.length === 0);
}

function ideaOpenModal(id = null) {
  ideaEditingId = id;
  const idea = id ? ideasData.find(i => i.id === id) : null;
  ideaDraftImages = ideaList(idea?.images);
  ideaDraftLinks = ideaList(idea?.reference_links);
  document.getElementById('ideaModalTitle').textContent = idea ? 'Editar idea' : 'Nueva idea';
  document.getElementById('ideaTitle').value = idea?.title || '';
  document.getElementById('ideaCategory').value = idea?.category || '';
  document.getElementById('ideaNotes').innerHTML = ideaSanitizeHtml(idea?.notes_html || '');
  document.getElementById('ideaImageUrl').value = '';
  document.getElementById('ideaRefUrl').value = '';
  ideaSetMsg('');
  ideaRenderDraftImages();
  ideaRenderDraftLinks();
  document.getElementById('ideaModal')?.classList.remove('hidden');
  document.addEventListener('keydown', ideaEscModal);
  setTimeout(() => document.getElementById('ideaTitle')?.focus(), 40);
}

function ideaEdit(id) {
  ideaOpenModal(id);
}

function ideaCloseModal() {
  document.getElementById('ideaModal')?.classList.add('hidden');
  document.removeEventListener('keydown', ideaEscModal);
}

function ideaEscModal(e) {
  if (e.key === 'Escape') ideaCloseModal();
}

function ideaRtCmd(cmd) {
  document.getElementById('ideaNotes')?.focus();
  document.execCommand(cmd, false, null);
}

function ideaRtLink() {
  const url = prompt('URL del enlace');
  if (!url) return;
  if (!ideaIsUrl(url)) {
    ideaSetMsg('El enlace debe empezar con http:// o https://', 'err');
    return;
  }
  document.getElementById('ideaNotes')?.focus();
  document.execCommand('createLink', false, url);
}

function ideaRenderDraftImages() {
  const box = document.getElementById('ideaImagesPreview');
  if (!box) return;
  box.innerHTML = ideaDraftImages.map((url, idx) => `
    <div class="content-image-tile">
      <img src="${ideaEsc(url)}" alt="">
      <button onclick="ideaRemoveImage(${idx})" title="Quitar">×</button>
    </div>
  `).join('');
}

function ideaRenderDraftLinks() {
  const box = document.getElementById('ideaRefsPreview');
  if (!box) return;
  box.innerHTML = ideaDraftLinks.map((url, idx) => `
    <div class="content-link-row">
      <a href="${ideaEsc(url)}" target="_blank" rel="noopener noreferrer">${ideaEsc(url)}</a>
      <button onclick="ideaRemoveRefLink(${idx})" title="Quitar">×</button>
    </div>
  `).join('');
}

function ideaAddImageUrl() {
  const input = document.getElementById('ideaImageUrl');
  const url = input?.value?.trim() || '';
  if (!ideaIsUrl(url)) {
    ideaSetMsg('Pegá una URL de imagen válida.', 'err');
    return;
  }
  ideaDraftImages.push(url);
  input.value = '';
  ideaSetMsg('');
  ideaRenderDraftImages();
}

function ideaRemoveImage(idx) {
  ideaDraftImages.splice(idx, 1);
  ideaRenderDraftImages();
}

function ideaAddRefLink() {
  const input = document.getElementById('ideaRefUrl');
  const url = input?.value?.trim() || '';
  if (!ideaIsUrl(url)) {
    ideaSetMsg('Pegá un enlace válido.', 'err');
    return;
  }
  ideaDraftLinks.push(url);
  input.value = '';
  ideaSetMsg('');
  ideaRenderDraftLinks();
}

function ideaRemoveRefLink(idx) {
  ideaDraftLinks.splice(idx, 1);
  ideaRenderDraftLinks();
}

function ideaFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

async function ideaUploadImage(input) {
  const file = input?.files?.[0];
  if (!file) return;
  ideaSetMsg('Subiendo imagen...');
  try {
    const dataUrl = await ideaFileToDataUrl(file);
    const r = await api.contentUploadImage({ dataUrl, fileName: file.name, folder: 'ideas' });
    input.value = '';
    if (!r.ok) {
      ideaSetMsg(r.error || 'No se pudo subir la imagen.', 'err');
      return;
    }
    ideaDraftImages.push(r.url);
    ideaRenderDraftImages();
    ideaSetMsg(`Imagen subida al bucket ${r.bucket}.`, 'ok');
  } catch (e) {
    ideaSetMsg(e.message || 'Error subiendo imagen.', 'err');
  }
}

async function ideaSave() {
  const title = document.getElementById('ideaTitle')?.value?.trim() || '';
  const category = document.getElementById('ideaCategory')?.value?.trim() || 'General';
  const notesHtml = ideaSanitizeHtml(document.getElementById('ideaNotes')?.innerHTML || '');
  if (!title) {
    ideaSetMsg('El título es obligatorio.', 'err');
    return;
  }
  const btn = document.getElementById('ideaSaveBtn');
  if (btn) btn.disabled = true;
  const payload = {
    title,
    category,
    notesHtml,
    notesText: ideaNotesText(),
    referenceLinks: ideaDraftLinks,
    images: ideaDraftImages,
  };
  try {
    const r = ideaEditingId ? await api.ideasUpdate(ideaEditingId, payload) : await api.ideasAdd(payload);
    if (!r.ok) {
      ideaSetMsg(r.error || 'No se pudo guardar.', 'err');
      return;
    }
    await loadIdeas();
    ideaCloseModal();
    toast(ideaEditingId ? 'Idea actualizada' : 'Idea creada', 'ok');
  } catch (e) {
    ideaSetMsg(e.message || 'Error guardando idea.', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function ideaDelete(id) {
  const idea = ideasData.find(i => i.id === id);
  showModal(
    'Eliminar idea',
    `<div style="font-size:12px;color:var(--text2);line-height:1.7">¿Eliminar <strong style="color:var(--text)">${ideaEsc(idea?.title || 'esta idea')}</strong>?<br><span style="color:#f87171">Esta acción no se puede deshacer.</span></div>` +
    `<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doIdeaDelete('${id}')">Sí, eliminar</button>`
  );
}

async function _doIdeaDelete(id) {
  const r = await api.ideasDelete(id);
  if (!r.ok) {
    toast(r.error || 'Error al eliminar', 'err');
    return;
  }
  ideasData = ideasData.filter(i => i.id !== id);
  ideaRender();
  ideaUpdateBadge();
  toast('Idea eliminada', 'ok');
}
