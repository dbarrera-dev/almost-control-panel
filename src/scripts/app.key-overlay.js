// ── Key Overlay ────────────────────────────────────────────────────
const KO_MAX_BG_FILE_SIZE = 3 * 1024 * 1024;
const KO_BG_TYPES = new Set(['default', 'url', 'upload']);

let koConfig = {
  selectedKeys: [16, 17, 18, 19, 30, 31, 32, 33, 42, 29, 57416, 57424, 57419, 57421, 'm1', 'm2'],
  customKeys: [],
  style: {
    fontSize: 'md',
    keyColor: '#ffffff',
    bgColor: 'rgba(15,15,20,0.9)',
    accentColor: '#f97316',
    fadeDelay: 0,
    inactiveOpacity: 0.3,
  },
  background: { type: 'default', value: '', name: '', scale: 1, offsetX: 0, offsetY: 0 },
  gamepadEnabled: false,
  gamepadButtons: {},
};
const koActiveKeys = new Map();

function koClampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function koNormalizeBackground(raw) {
  const bg = raw && typeof raw === 'object' ? raw : {};
  const type = KO_BG_TYPES.has(String(bg.type || '').toLowerCase())
    ? String(bg.type || '').toLowerCase()
    : 'default';
  const value = String(bg.value || '').trim();
  if (!value || type === 'default') return { type: 'default', value: '', name: '', scale: 1, offsetX: 0, offsetY: 0 };
  return {
    type,
    value,
    name: String(bg.name || '').trim().slice(0, 255),
    scale: koClampNum(bg.scale, 0.1, 5, 1),
    offsetX: koClampNum(bg.offsetX, -3, 3, 0),
    offsetY: koClampNum(bg.offsetY, -3, 3, 0),
  };
}

function koNormalizeConfig(raw) {
  const base = raw && typeof raw === 'object' ? raw : {};
  const style = base.style && typeof base.style === 'object' ? base.style : {};
  const selected = Array.isArray(base.selectedKeys) ? base.selectedKeys : [];
  const custom = Array.isArray(base.customKeys) ? base.customKeys : [];

  return {
    selectedKeys: selected,
    customKeys: custom,
    style: {
      fontSize: ['sm', 'md', 'lg', 'xl'].includes(String(style.fontSize || '').toLowerCase())
        ? String(style.fontSize || '').toLowerCase()
        : 'md',
      keyColor: String(style.keyColor || '#ffffff'),
      bgColor: String(style.bgColor || 'rgba(15,15,20,0.9)'),
      accentColor: String(style.accentColor || '#f97316'),
      fadeDelay: Number.isFinite(Number(style.fadeDelay)) ? Number(style.fadeDelay) : 0,
      inactiveOpacity: Math.max(0, Math.min(1, Number.isFinite(Number(style.inactiveOpacity)) ? Number(style.inactiveOpacity) : 0.3)),
    },
    background: koNormalizeBackground(base.background),
    gamepadEnabled: !!base.gamepadEnabled,
    gamepadButtons: (base.gamepadButtons && typeof base.gamepadButtons === 'object') ? base.gamepadButtons : {},
  };
}

function koApplySelectedToUI() {
  const sel = new Set(koConfig.selectedKeys.map(String));
  document.querySelectorAll('#ko-keyboard .ko-key').forEach((el) => {
    el.classList.toggle('kok-on', sel.has(el.dataset.kc));
  });
}

function koSetBackgroundMeta(msg, tone) {
  const meta = document.getElementById('koBgMeta');
  if (!meta) return;
  meta.textContent = msg || '';
  meta.style.color = tone === 'ok'
    ? '#4ade80'
    : tone === 'warn'
      ? '#fbbf24'
      : tone === 'err'
        ? '#f87171'
        : 'var(--text3)';
}

// Estado del editor de fondo (preview en vivo + arrastre/zoom)
let koRunning = false;
let koOverlayUrl = 'http://localhost:9001';
let koBgDragging = false;
let koBgDragStart = null;
let koFrameLayout = null;       // {x,y,w,h} reportado por el overlay embebido (coords internas)
let koFrameFit = { scale: 1, tx: 0, ty: 0 }; // ajuste para encajar el teclado en el stage
let koBgPushRaf = null;
let koBgWheelTimer = null;

function koBgStartFrame() {
  const frame = document.getElementById('koBgFrame');
  if (!frame) return;
  const target = koOverlayUrl || 'http://localhost:9001';
  if (frame.dataset.loaded !== target) {
    frame.src = target;
    frame.dataset.loaded = target;
  }
}

function koBgStopFrame() {
  const frame = document.getElementById('koBgFrame');
  if (frame && frame.dataset.loaded) {
    frame.src = 'about:blank';
    frame.dataset.loaded = '';
    frame.style.transform = '';
  }
  const outline = document.getElementById('koBgFrameOutline');
  if (outline) outline.style.display = 'none';
  koFrameLayout = null;
  koFrameFit = { scale: 1, tx: 0, ty: 0 };
}

function koApplyBackgroundUI() {
  const bg = koNormalizeBackground(koConfig.background);
  const urlInput = document.getElementById('koBgUrl');
  const editor = document.getElementById('koBgEditor');
  const hint = document.getElementById('koBgEditorHint');
  if (urlInput && document.activeElement !== urlInput) {
    urlInput.value = bg.type === 'url' ? bg.value : '';
  }

  if (!bg.value) {
    if (editor) editor.style.display = 'none';
    if (hint) hint.style.display = 'none';
    koBgStopFrame();
    koSetBackgroundMeta('Usando fondo por defecto.', null);
    return;
  }

  if (bg.type === 'url') {
    koSetBackgroundMeta(`Fondo externo activo: ${bg.value.slice(0, 90)}${bg.value.length > 90 ? '…' : ''}`, 'ok');
  } else {
    koSetBackgroundMeta(`Imagen subida activa${bg.name ? `: ${bg.name}` : ''}`, 'ok');
  }

  const scaleEl = document.getElementById('koBgScale');
  const scaleVal = document.getElementById('koBgScaleVal');
  if (scaleEl && !koBgDragging) scaleEl.value = bg.scale;
  if (scaleVal) scaleVal.textContent = `${Math.round(bg.scale * 100)}%`;

  if (koRunning) {
    if (hint) hint.style.display = 'none';
    if (editor) editor.style.display = '';
    koBgStartFrame();
  } else {
    if (editor) editor.style.display = 'none';
    if (hint) hint.style.display = '';
    koBgStopFrame();
  }
}

// Empuja el estado actual a los overlays sin persistir (fluidez en el arrastre)
function koBgPreviewPush() {
  if (koBgPushRaf) return;
  koBgPushRaf = requestAnimationFrame(() => {
    koBgPushRaf = null;
    if (typeof api.keyOverlayPreviewConfig === 'function') api.keyOverlayPreviewConfig(koConfig);
    else api.keyOverlaySetConfig(koConfig);
  });
}

function koBgPersist() {
  api.keyOverlaySetConfig(koConfig);
}

function koBgWheelPersistDebounced() {
  if (koBgWheelTimer) clearTimeout(koBgWheelTimer);
  koBgWheelTimer = setTimeout(() => { koBgWheelTimer = null; koBgPersist(); }, 400);
}

function koBgOnScaleInput(val) {
  if (!koConfig.background) return;
  koConfig.background.scale = koClampNum(val, 0.2, 4, 1);
  const scaleVal = document.getElementById('koBgScaleVal');
  if (scaleVal) scaleVal.textContent = `${Math.round(koConfig.background.scale * 100)}%`;
  koBgPreviewPush();
}

function koBgCenter() {
  if (!koConfig.background) return;
  koConfig.background.offsetX = 0;
  koConfig.background.offsetY = 0;
  koBgPreviewPush();
  koBgPersist();
}

function koBgReset() {
  if (!koConfig.background) return;
  koConfig.background.scale = 1;
  koConfig.background.offsetX = 0;
  koConfig.background.offsetY = 0;
  koApplyBackgroundUI();
  koBgPreviewPush();
  koBgPersist();
}

function koInitBgEditor() {
  const stage = document.getElementById('koBgStage');
  const drag = document.getElementById('koBgDrag');
  if (!stage || !drag) return;

  drag.addEventListener('pointerdown', (e) => {
    if (!koNormalizeBackground(koConfig.background).value) return;
    koBgDragging = true;
    try { drag.setPointerCapture(e.pointerId); } catch {}
    const stageRect = stage.getBoundingClientRect();
    // Referencia 1:1 = ancho/alto del teclado tal como se ve en pantalla
    // (tamaño interno reportado por el overlay × factor de encaje del stage).
    const refW = (koFrameLayout && koFrameLayout.w) ? koFrameLayout.w * koFrameFit.scale : stageRect.width;
    const refH = (koFrameLayout && koFrameLayout.h) ? koFrameLayout.h * koFrameFit.scale : stageRect.height;
    koBgDragStart = {
      x: e.clientX,
      y: e.clientY,
      offsetX: koConfig.background.offsetX || 0,
      offsetY: koConfig.background.offsetY || 0,
      refW: Math.max(1, refW),
      refH: Math.max(1, refH),
    };
    drag.style.cursor = 'grabbing';
  });

  drag.addEventListener('pointermove', (e) => {
    if (!koBgDragging || !koBgDragStart) return;
    const dx = (e.clientX - koBgDragStart.x) / koBgDragStart.refW;
    const dy = (e.clientY - koBgDragStart.y) / koBgDragStart.refH;
    koConfig.background.offsetX = koClampNum(koBgDragStart.offsetX + dx, -3, 3, 0);
    koConfig.background.offsetY = koClampNum(koBgDragStart.offsetY + dy, -3, 3, 0);
    koBgPreviewPush();
  });

  const endDrag = (e) => {
    if (!koBgDragging) return;
    koBgDragging = false;
    koBgDragStart = null;
    drag.style.cursor = 'grab';
    try { drag.releasePointerCapture(e.pointerId); } catch {}
    koBgPersist();
  };
  drag.addEventListener('pointerup', endDrag);
  drag.addEventListener('pointercancel', endDrag);

  stage.addEventListener('wheel', (e) => {
    if (!koNormalizeBackground(koConfig.background).value) return;
    e.preventDefault();
    const cur = koConfig.background.scale || 1;
    const next = koClampNum(cur * (e.deltaY < 0 ? 1.08 : 0.92), 0.2, 4, 1);
    koConfig.background.scale = next;
    const scaleEl = document.getElementById('koBgScale');
    const scaleVal = document.getElementById('koBgScaleVal');
    if (scaleEl) scaleEl.value = next;
    if (scaleVal) scaleVal.textContent = `${Math.round(next * 100)}%`;
    koBgPreviewPush();
    koBgWheelPersistDebounced();
  }, { passive: false });

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'ko-overlay' || d.type !== 'layout' || !d.rect) return;
    const r = d.rect;
    koFrameLayout = r;
    const frame = document.getElementById('koBgFrame');
    const outline = document.getElementById('koBgFrameOutline');
    if (!frame) return;

    // Encaja el teclado completo dentro del stage (escala ≤ 1) y lo centra.
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const pad = 28;
    const fit = Math.min((sw - pad) / Math.max(1, r.w), (sh - pad) / Math.max(1, r.h), 1);
    const tx = ((sw - r.w * fit) / 2) - (r.x * fit);
    const ty = ((sh - r.h * fit) / 2) - (r.y * fit);
    koFrameFit = { scale: fit, tx, ty };
    frame.style.transformOrigin = 'top left';
    frame.style.transform = `translate(${tx}px, ${ty}px) scale(${fit})`;

    if (outline) {
      outline.style.left = `${(r.x * fit) + tx}px`;
      outline.style.top = `${(r.y * fit) + ty}px`;
      outline.style.width = `${r.w * fit}px`;
      outline.style.height = `${r.h * fit}px`;
      outline.style.display = '';
    }
  });
}

koInitBgEditor();

function koApplyConfigToUI(cfg) {
  koConfig = koNormalizeConfig(cfg || koConfig);
  koApplySelectedToUI();

  document.getElementById('koKeyColor').value = koConfig.style.keyColor;
  document.getElementById('koAccentColor').value = koConfig.style.accentColor;
  document.getElementById('koInactiveOpacity').value = koConfig.style.inactiveOpacity;
  document.getElementById('koGamepadToggle').checked = koConfig.gamepadEnabled;
  document.getElementById('koOpacityVal').textContent = `${Math.round(koConfig.style.inactiveOpacity * 100)}%`;
  koSetSizeUI(koConfig.style.fontSize);
  koApplyBackgroundUI();
}

// Wire up keyboard picker clicks
document.getElementById('ko-keyboard').addEventListener('click', (e) => {
  const key = e.target.closest('.ko-key');
  if (!key) return;
  const kc = key.dataset.kc;
  const kcVal = Number.isNaN(Number(kc)) ? kc : Number(kc);
  const sel = koConfig.selectedKeys.map(String);
  const idx = sel.indexOf(String(kc));
  if (idx === -1) koConfig.selectedKeys.push(kcVal);
  else koConfig.selectedKeys.splice(idx, 1);
  koApplySelectedToUI();
  api.keyOverlaySetConfig(koConfig);
});

async function loadKeyOverlay() {
  const r = await api.keyOverlayGetStatus();
  koRunning = !!r.running;
  koOverlayUrl = r.url || koOverlayUrl;
  document.getElementById('koToggle').checked = r.running;
  document.getElementById('koUrlRow').classList.toggle('hidden', !r.running);
  document.getElementById('koStatusText').textContent = r.running ? `Activo en ${r.url}` : 'Desactivado';

  const cfg = (await api.keyOverlayGetConfig()).config;
  koApplyConfigToUI(cfg);
}

async function koToggle(enabled) {
  if (enabled) {
    const r = await api.keyOverlayStart();
    koRunning = true;
    if (r?.url) koOverlayUrl = r.url;
    koApplyBackgroundUI();
  } else {
    await api.keyOverlayStop();
    koRunning = false;
    document.getElementById('koStatusText').textContent = 'Desactivado';
    document.getElementById('koUrlRow').classList.add('hidden');
    koPreviewClear();
    koApplyBackgroundUI();
  }
}

async function koSaveConfig() {
  koConfig.style.keyColor = document.getElementById('koKeyColor').value;
  koConfig.style.accentColor = document.getElementById('koAccentColor').value;
  koConfig.style.inactiveOpacity = parseFloat(document.getElementById('koInactiveOpacity').value);
  koConfig.gamepadEnabled = document.getElementById('koGamepadToggle').checked;
  await api.keyOverlaySetConfig(koConfig);
}

function koOnOpacity(val) {
  document.getElementById('koOpacityVal').textContent = `${Math.round(Number(val) * 100)}%`;
  koSaveConfig();
}

function koSetSize(sz) {
  koConfig.style.fontSize = sz;
  koSetSizeUI(sz);
  api.keyOverlaySetConfig(koConfig);
}

function koSetSizeUI(sz) {
  ['sm', 'md', 'lg', 'xl'].forEach((s) => {
    const btn = document.getElementById('ksz-' + s);
    if (btn) btn.style.borderColor = s === sz ? 'rgba(124,58,237,.7)' : '';
  });
}

function koCopyUrl(btn) {
  try {
    const ta = document.createElement('textarea');
    ta.value = 'http://localhost:9001';
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch {}
  btn.textContent = 'Copiado';
  setTimeout(() => { btn.textContent = 'Copiar'; }, 2000);
}

function koOpenBackgroundFilePicker() {
  document.getElementById('koBgFile')?.click();
}

async function koApplyBackgroundUrl() {
  const input = document.getElementById('koBgUrl');
  const raw = String(input?.value || '').trim();
  if (!raw) {
    koSetBackgroundMeta('Pegá una URL primero.', 'warn');
    return;
  }
  let valid = false;
  if (/^data:image\//i.test(raw)) {
    valid = true;
  } else {
    try {
      const u = new URL(raw);
      valid = u.protocol === 'http:' || u.protocol === 'https:';
    } catch {}
  }
  if (!valid) {
    koSetBackgroundMeta('URL inválida. Usá http:// o https://', 'err');
    return;
  }
  koConfig.background = { type: 'url', value: raw, name: '', scale: 1, offsetX: 0, offsetY: 0 };
  const res = await api.keyOverlaySetConfig(koConfig);
  if (res?.ok) {
    koApplyBackgroundUI();
    koSetBackgroundMeta('Fondo por URL guardado y sincronizado.', 'ok');
  } else {
    koSetBackgroundMeta('No se pudo guardar el fondo en Supabase.', 'err');
  }
}

async function koUploadBackground(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (!String(file.type || '').toLowerCase().startsWith('image/')) {
    koSetBackgroundMeta('El archivo debe ser una imagen.', 'err');
    input.value = '';
    return;
  }
  if (file.size > KO_MAX_BG_FILE_SIZE) {
    koSetBackgroundMeta('La imagen supera 3MB. Elegí una más liviana.', 'err');
    input.value = '';
    return;
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    reader.readAsDataURL(file);
  }).catch(() => '');

  if (!dataUrl) {
    koSetBackgroundMeta('No se pudo leer la imagen seleccionada.', 'err');
    input.value = '';
    return;
  }

  const res = await api.keyOverlayUploadBackground({
    fileName: String(file.name || '').trim(),
    dataUrl,
  });
  if (res?.ok) {
    if (res?.background) koConfig.background = res.background;
    koApplyBackgroundUI();
    koSetBackgroundMeta('Imagen subida al bucket y sincronizada en tiempo real.', 'ok');
  } else {
    koSetBackgroundMeta(String(res?.error || 'No se pudo sincronizar la imagen en Supabase Storage.'), 'err');
  }
  input.value = '';
}

async function koClearBackground() {
  koConfig.background = { type: 'default', value: '', name: '' };
  const res = await api.keyOverlaySetConfig(koConfig);
  if (res?.ok) {
    koApplyBackgroundUI();
    koSetBackgroundMeta('Fondo restaurado al predeterminado.', 'ok');
  } else {
    koSetBackgroundMeta('No se pudo actualizar el fondo.', 'err');
  }
}

// ── Detectar tecla ────────────────────────────────────────────────
let koDetectKeycode = null;

async function koDetectStart() {
  const r = await api.keyOverlayDetectNext();
  if (!r.ok) {
    document.getElementById('koDetectStatus').textContent = '⚠ ' + r.error;
    return;
  }
  koDetectKeycode = null;
  document.getElementById('koDetectBtn').disabled = true;
  document.getElementById('koDetectStatus').textContent = '⌨ Presioná la tecla...';
  document.getElementById('koDetectLabel').style.display = 'none';
  document.getElementById('koDetectAdd').style.display = 'none';
}

api.onKeyOverlayDetected((d) => {
  koDetectKeycode = d.keycode;
  document.getElementById('koDetectBtn').disabled = false;
  document.getElementById('koDetectStatus').textContent = `Detectada: kc ${d.keycode}`;
  const inp = document.getElementById('koDetectLabel');
  inp.value = d.label;
  inp.style.display = '';
  document.getElementById('koDetectAdd').style.display = '';
});

function koDetectAdd() {
  if (koDetectKeycode == null) return;
  const kc = koDetectKeycode;
  koDetectKeycode = null;
  const label = document.getElementById('koDetectLabel').value.trim() || `#${kc}`;

  koConfig.customKeys = koConfig.customKeys || [];
  const alreadyCustom = koConfig.customKeys.some((k) => String(k.keycode) === String(kc));
  const alreadySelected = koConfig.selectedKeys.map(String).includes(String(kc));
  if (!alreadyCustom && !alreadySelected) {
    koConfig.customKeys.push({ keycode: kc, label, row: 8 });
    api.keyOverlaySetConfig(koConfig);
  }

  document.getElementById('koDetectStatus').textContent = `"${label}" agregada`;
  document.getElementById('koDetectLabel').style.display = 'none';
  document.getElementById('koDetectAdd').style.display = 'none';
  setTimeout(() => { document.getElementById('koDetectStatus').textContent = ''; }, 2500);
}

// Preview de teclas en la app
function koPreviewClear() {
  koActiveKeys.clear();
  const prev = document.getElementById('koPreview');
  if (prev) prev.innerHTML = '<span style="font-size:11px;color:var(--text3)">Activá el overlay y presioná teclas...</span>';
}

api.onKeyOverlayKey((msg) => {
  const prev = document.getElementById('koPreview');
  if (!prev) return;
  const accent = koConfig.style.accentColor || '#f97316';

  if (msg.type === 'keydown') {
    prev.querySelectorAll('span').forEach((s) => s.remove());
    if (koActiveKeys.has(msg.keycode)) return;
    const el = document.createElement('div');
    el.style.cssText = `display:inline-flex;align-items:center;justify-content:center;
      border-radius:6px;font-weight:700;font-size:13px;min-width:32px;height:32px;
      padding:0 9px;background:${accent};border:1.5px solid ${accent};
      color:#fff;white-space:nowrap`;
    el.textContent = msg.label;
    prev.appendChild(el);
    koActiveKeys.set(msg.keycode, el);
  }

  if (msg.type === 'keyup') {
    const el = koActiveKeys.get(msg.keycode);
    if (!el) return;
    el.remove();
    koActiveKeys.delete(msg.keycode);
    if (koActiveKeys.size === 0) {
      prev.innerHTML = '<span style="font-size:11px;color:var(--text3)">Activá el overlay y presioná teclas...</span>';
    }
  }
});

if (typeof api.onKeyOverlayConfigUpdated === 'function') {
  api.onKeyOverlayConfigUpdated((payload) => {
    if (!payload?.config) return;
    if (koBgDragging) return; // no pisar el arrastre en curso
    koApplyConfigToUI(payload.config);
    if (payload?.source === 'supabase') {
      koSetBackgroundMeta('Cambio remoto aplicado desde Supabase.', 'ok');
      setTimeout(() => koApplyBackgroundUI(), 1600);
    }
  });
}

// ══════════════════════════════════════════
