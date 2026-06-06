// ── Key Overlay ────────────────────────────────────────────────────
const KO_MAX_BG_FILE_SIZE = 3 * 1024 * 1024;
const KO_BG_TYPES = new Set(['default', 'url', 'upload']);
const KO_FONT_TYPES = new Set(['russo', 'bangers', 'inter', 'system', 'mono', 'serif']);
const KO_DEFAULT_SUBS = { '23': '<-', '24': '->', '37': 'Nitro', '38': 'Salto' };
const KO_KEY_IMAGE_PAN_LIMIT = 50;

let koConfig = {
  selectedKeys: [16, 17, 18, 19, 30, 31, 32, 33, 42, 29, 57416, 57424, 57419, 57421, 'm1', 'm2'],
  customKeys: [],
  style: {
    fontSize: 'md',
    fontFamily: 'russo',
    keyColor: '#ffffff',
    bgColor: '#15151a',
    accentColor: '#f97316',
    fadeDelay: 0,
    inactiveOpacity: 0.3,
    showBrand: true,
    brandText: 'WOOTING 80HE',
  },
  background: { type: 'default', enabled: true, value: '', name: '', scale: 1, rotation: 0, offsetX: 0, offsetY: 0 },
  keyStyles: {},
  gamepadEnabled: false,
  gamepadButtons: {},
};
const koActiveKeys = new Map();
let koEditKey = '37';
let koBgLibraryImages = [];
let koKeyImageLibraryImages = [];

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
  const enabled = bg.enabled !== false;
  const value = String(bg.value || '').trim();
  if (!value || type === 'default') return { type: 'default', enabled, value: '', name: '', scale: 1, rotation: 0, offsetX: 0, offsetY: 0 };
  return {
    type,
    enabled,
    value,
    name: String(bg.name || '').trim().slice(0, 255),
    bucket: String(bg.bucket || '').trim(),
    storagePath: String(bg.storagePath || '').trim(),
    scale: koClampNum(bg.scale, 0.1, 5, 1),
    rotation: koClampNum(bg.rotation, -180, 180, 0),
    offsetX: koClampNum(bg.offsetX, -3, 3, 0),
    offsetY: koClampNum(bg.offsetY, -3, 3, 0),
  };
}

function koNormalizeKeyStyles(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  Object.keys(src).forEach((key) => {
    const item = src[key] && typeof src[key] === 'object' ? src[key] : {};
    const clean = {};
    const label = String(item.label || '').trim().slice(0, 30);
    const sub = String(item.sub || '').trim().slice(0, 30);
    const keyColor = String(item.keyColor || '').trim();
    const bgColor = String(item.bgColor || '').trim();
    const accentColor = String(item.accentColor || '').trim();
    if (label) clean.label = label;
    if (sub) clean.sub = sub;
    if (keyColor) clean.keyColor = keyColor;
    if (bgColor) clean.bgColor = bgColor;
    if (accentColor) clean.accentColor = accentColor;
    const img = item.image && typeof item.image === 'object' ? item.image : null;
    if (img) {
      const type = KO_BG_TYPES.has(String(img.type || '').toLowerCase()) ? String(img.type || '').toLowerCase() : 'url';
      const value = String(img.value || '').trim();
      if (value && type !== 'default') {
        clean.image = {
          type,
          value,
          name: String(img.name || '').trim().slice(0, 255),
          fit: ['cover', 'contain'].includes(String(img.fit || '').toLowerCase()) ? String(img.fit || '').toLowerCase() : 'cover',
          opacity: koClampNum(img.opacity, 0, 1, 1),
          scale: koClampNum(img.scale, 0.2, 4, 1),
          rotation: koClampNum(img.rotation, -180, 180, 0),
          offsetX: koClampNum(img.offsetX, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0),
          offsetY: koClampNum(img.offsetY, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0),
          bucket: String(img.bucket || '').trim(),
          storagePath: String(img.storagePath || '').trim(),
        };
      }
    }
    if (Object.keys(clean).length) out[String(key)] = clean;
  });
  return out;
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
      fontFamily: KO_FONT_TYPES.has(String(style.fontFamily || '').toLowerCase())
        ? String(style.fontFamily || '').toLowerCase()
        : 'russo',
      keyColor: String(style.keyColor || '#ffffff'),
      bgColor: String(style.bgColor || '#15151a'),
      accentColor: String(style.accentColor || '#f97316'),
      fadeDelay: Number.isFinite(Number(style.fadeDelay)) ? Number(style.fadeDelay) : 0,
      inactiveOpacity: Math.max(0, Math.min(1, Number.isFinite(Number(style.inactiveOpacity)) ? Number(style.inactiveOpacity) : 0.3)),
      showBrand: style.showBrand !== undefined ? !!style.showBrand : true,
      brandText: String(style.brandText ?? 'WOOTING 80HE').trim().slice(0, 40) || 'WOOTING 80HE',
    },
    background: koNormalizeBackground(base.background),
    keyStyles: koNormalizeKeyStyles(base.keyStyles),
    gamepadEnabled: !!base.gamepadEnabled,
    gamepadButtons: (base.gamepadButtons && typeof base.gamepadButtons === 'object') ? base.gamepadButtons : {},
  };
}

function koToHexColor(value, fallback = '#ffffff') {
  const raw = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw;
  if (/^#[0-9a-f]{3}$/i.test(raw)) {
    return '#' + raw.slice(1).split('').map((ch) => ch + ch).join('');
  }
  const m = raw.match(/^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})/i);
  if (m) {
    return '#' + [m[1], m[2], m[3]]
      .map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, '0'))
      .join('');
  }
  return fallback;
}

function koColorToRgb(value, fallback = { r: 21, g: 21, b: 26 }) {
  const hex = koToHexColor(value, '');
  if (!hex) return fallback;
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function koKeyDefaultLabel(keycode) {
  const el = document.querySelector(`#ko-keyboard .ko-key[data-kc="${CSS.escape(String(keycode))}"]`);
  return (el?.textContent || `#${keycode}`).trim();
}

function koEffectiveKeyStyle(keycode) {
  const style = koConfig.keyStyles?.[String(keycode)] || {};
  return {
    label: style.label || koKeyDefaultLabel(keycode),
    sub: style.sub || KO_DEFAULT_SUBS[String(keycode)] || '',
    keyColor: style.keyColor || koConfig.style.keyColor || '#ffffff',
    bgColor: style.bgColor || koConfig.style.bgColor || '#15151a',
    accentColor: style.accentColor || koConfig.style.accentColor || '#f97316',
    image: style.image || null,
  };
}

function koKeyImageTranslate(img) {
  const x = koClampNum(img?.offsetX, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0);
  const y = koClampNum(img?.offsetY, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0);
  return {
    x: `${Math.round(x * 10000) / 100}%`,
    y: `${Math.round(y * 10000) / 100}%`,
  };
}

function koSetKeyImagePositionText(img) {
  const el = document.getElementById('koEditImagePositionVal');
  if (!el) return;
  if (!img?.value) {
    el.textContent = '';
    return;
  }
  const x = Math.round(koClampNum(img.offsetX, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0) * 100);
  const y = Math.round(koClampNum(img.offsetY, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0) * 100);
  const scale = Math.round(koClampNum(img.scale, 0.2, 4, 1) * 100);
  const rotation = Math.round(koClampNum(img.rotation, -180, 180, 0));
  el.textContent = `Posición X ${x}% · Y ${y}% · Zoom ${scale}% · Giro ${rotation}°`;
}

function koApplySelectedToUI() {
  const sel = new Set(koConfig.selectedKeys.map(String));
  document.querySelectorAll('#ko-keyboard .ko-key').forEach((el) => {
    el.classList.toggle('kok-on', sel.has(el.dataset.kc));
    el.classList.toggle('kok-editing', String(el.dataset.kc) === String(koEditKey));
  });
}

function koBuildEditOptions() {
  const select = document.getElementById('koEditKeySelect');
  if (!select) return;
  const prev = String(koEditKey || select.value || '');
  const seen = new Set();
  const options = [];
  document.querySelectorAll('#ko-keyboard .ko-key').forEach((el) => {
    const kc = String(el.dataset.kc || '');
    if (!kc || seen.has(kc)) return;
    seen.add(kc);
    options.push({ keycode: kc, label: (el.textContent || kc).trim() });
  });
  (koConfig.customKeys || []).forEach((k) => {
    const kc = String(k.keycode || '');
    if (!kc || seen.has(kc)) return;
    seen.add(kc);
    options.push({ keycode: kc, label: String(k.label || kc).trim() });
  });
  select.innerHTML = '';
  options.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = String(item.keycode);
    opt.textContent = `${item.label} · ${item.keycode}`;
    select.appendChild(opt);
  });
  koEditKey = options.some((item) => String(item.keycode) === prev) ? prev : (options[0]?.keycode || '37');
  select.value = koEditKey;
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

function koSetKeyImageMeta(msg, tone) {
  const meta = document.getElementById('koEditImageMeta');
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

function koApplyKeyEditorUI() {
  koBuildEditOptions();
  const style = koConfig.keyStyles?.[String(koEditKey)] || {};
  const effective = koEffectiveKeyStyle(koEditKey);
  const labelEl = document.getElementById('koEditLabel');
  const subEl = document.getElementById('koEditSub');
  const textColorEl = document.getElementById('koEditKeyColor');
  const bgColorEl = document.getElementById('koEditBgColor');
  const accentEl = document.getElementById('koEditAccentColor');
  const imgUrlEl = document.getElementById('koEditImageUrl');
  const imgFitEl = document.getElementById('koEditImageFit');
  const imgOpacityEl = document.getElementById('koEditImageOpacity');
  const imgOpacityVal = document.getElementById('koEditImageOpacityVal');
  const imgScaleEl = document.getElementById('koEditImageScale');
  const imgScaleVal = document.getElementById('koEditImageScaleVal');
  const imgRotationEl = document.getElementById('koEditImageRotation');
  const imgRotationVal = document.getElementById('koEditImageRotationVal');
  const preview = document.getElementById('koEditPreview');

  if (labelEl && document.activeElement !== labelEl) labelEl.value = style.label || '';
  if (subEl && document.activeElement !== subEl) subEl.value = style.sub || '';
  if (textColorEl) textColorEl.value = koToHexColor(effective.keyColor, '#ffffff');
  if (bgColorEl) bgColorEl.value = koToHexColor(effective.bgColor, '#15151a');
  if (accentEl) accentEl.value = koToHexColor(effective.accentColor, '#f97316');
  if (imgUrlEl && document.activeElement !== imgUrlEl) imgUrlEl.value = style.image?.type === 'url' ? style.image.value : '';
  if (imgFitEl) imgFitEl.value = style.image?.fit || 'cover';
  if (imgOpacityEl) imgOpacityEl.value = style.image?.opacity ?? 1;
  if (imgOpacityVal) imgOpacityVal.textContent = `${Math.round((style.image?.opacity ?? 1) * 100)}%`;
  if (imgScaleEl) imgScaleEl.value = style.image?.scale ?? 1;
  if (imgScaleVal) imgScaleVal.textContent = `${Math.round((style.image?.scale ?? 1) * 100)}%`;
  if (imgRotationEl) imgRotationEl.value = style.image?.rotation ?? 0;
  if (imgRotationVal) imgRotationVal.textContent = `${Math.round(style.image?.rotation ?? 0)}°`;

  if (preview) {
    const bgRgb = koColorToRgb(effective.bgColor);
    preview.style.color = effective.keyColor;
    preview.style.backgroundColor = effective.bgColor;
    preview.style.setProperty('--kop-bg-rgb', `${bgRgb.r}, ${bgRgb.g}, ${bgRgb.b}`);
    preview.style.setProperty('--kop-img', effective.image?.value ? `url("${String(effective.image.value).replace(/"/g, '\\"')}")` : 'none');
    preview.style.setProperty('--kop-img-size', effective.image?.fit || 'cover');
    const imgTranslate = koKeyImageTranslate(effective.image);
    preview.style.setProperty('--kop-img-x', imgTranslate.x);
    preview.style.setProperty('--kop-img-y', imgTranslate.y);
    preview.style.setProperty('--kop-img-opacity', koClampNum(effective.image?.opacity, 0, 1, 1));
    preview.style.setProperty('--kop-img-scale', koClampNum(effective.image?.scale, 0.2, 4, 1));
    preview.style.setProperty('--kop-img-rotate', `${koClampNum(effective.image?.rotation, -180, 180, 0)}deg`);
    preview.classList.toggle('kop-has-image', !!effective.image?.value);
    preview.innerHTML = '';
    const main = document.createElement('span');
    main.textContent = effective.label;
    preview.appendChild(main);
    if (effective.sub) {
      const small = document.createElement('small');
      small.textContent = effective.sub;
      preview.appendChild(small);
    }
  }
  koSetKeyImagePositionText(style.image);
  koRenderKeyImageLibrary();

  if (style.image?.value) {
    koSetKeyImageMeta(style.image.type === 'upload'
      ? `Imagen subida activa${style.image.name ? `: ${style.image.name}` : ''}`
      : `Imagen por URL activa: ${style.image.value.slice(0, 90)}${style.image.value.length > 90 ? '...' : ''}`, 'ok');
  } else {
    koSetKeyImageMeta('Sin imagen propia.', null);
  }
  koApplySelectedToUI();
}

function koSelectEditKey(keycode) {
  if (!keycode) return;
  koEditKey = String(keycode);
  koApplyKeyEditorUI();
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
let koKeyImageDragging = false;
let koKeyImageDragStart = null;
let koKeyImageWheelTimer = null;

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
  const enabledInput = document.getElementById('koBgEnabled');
  if (enabledInput) enabledInput.checked = bg.enabled !== false;
  if (urlInput && document.activeElement !== urlInput) {
    urlInput.value = bg.type === 'url' ? bg.value : '';
  }

  if (bg.enabled === false) {
    if (editor) editor.style.display = 'none';
    if (hint) hint.style.display = 'none';
    koBgStopFrame();
    koSetBackgroundMeta('Foto de fondo desactivada. Las teclas usan colores planos o imágenes propias.', null);
    koRenderBackgroundLibrary();
    return;
  }

  if (!bg.value) {
    if (editor) editor.style.display = 'none';
    if (hint) hint.style.display = 'none';
    koBgStopFrame();
    koSetBackgroundMeta('Sin foto de fondo.', null);
    koRenderBackgroundLibrary();
    return;
  }

  if (bg.type === 'url') {
    koSetBackgroundMeta(`Fondo externo activo: ${bg.value.slice(0, 90)}${bg.value.length > 90 ? '…' : ''}`, 'ok');
  } else {
    koSetBackgroundMeta(`Imagen subida activa${bg.name ? `: ${bg.name}` : ''}`, 'ok');
  }

  const scaleEl = document.getElementById('koBgScale');
  const scaleVal = document.getElementById('koBgScaleVal');
  const rotationEl = document.getElementById('koBgRotation');
  const rotationVal = document.getElementById('koBgRotationVal');
  if (scaleEl && !koBgDragging) scaleEl.value = bg.scale;
  if (scaleVal) scaleVal.textContent = `${Math.round(bg.scale * 100)}%`;
  if (rotationEl && !koBgDragging) rotationEl.value = bg.rotation || 0;
  if (rotationVal) rotationVal.textContent = `${Math.round(bg.rotation || 0)}°`;

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

function koGetCurrentKeyImage() {
  if (!koEditKey) return null;
  const style = koConfig.keyStyles?.[String(koEditKey)];
  return style?.image?.value ? style.image : null;
}

function koSetCurrentKeyImageOffset(offsetX, offsetY) {
  const img = koGetCurrentKeyImage();
  if (!img) return null;
  img.offsetX = koClampNum(offsetX, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0);
  img.offsetY = koClampNum(offsetY, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0);
  const preview = document.getElementById('koEditPreview');
  if (preview) {
    const imgTranslate = koKeyImageTranslate(img);
    preview.style.setProperty('--kop-img-x', imgTranslate.x);
    preview.style.setProperty('--kop-img-y', imgTranslate.y);
  }
  koSetKeyImagePositionText(img);
  return img;
}

function koKeyImagePersist() {
  api.keyOverlaySetConfig(koConfig);
}

function koKeyImageWheelPersistDebounced() {
  if (koKeyImageWheelTimer) clearTimeout(koKeyImageWheelTimer);
  koKeyImageWheelTimer = setTimeout(() => { koKeyImageWheelTimer = null; koKeyImagePersist(); }, 350);
}

function koApplyCurrentKeyImageTransform() {
  const img = koGetCurrentKeyImage();
  const preview = document.getElementById('koEditPreview');
  if (!img || !preview) return;
  const scale = koClampNum(img.scale, 0.2, 4, 1);
  const rotation = koClampNum(img.rotation, -180, 180, 0);
  preview.style.setProperty('--kop-img-scale', scale);
  preview.style.setProperty('--kop-img-rotate', `${rotation}deg`);
  preview.style.setProperty('--kop-img-opacity', koClampNum(img.opacity, 0, 1, 1));
  const imgTranslate = koKeyImageTranslate(img);
  preview.style.setProperty('--kop-img-x', imgTranslate.x);
  preview.style.setProperty('--kop-img-y', imgTranslate.y);
  const scaleEl = document.getElementById('koEditImageScale');
  const scaleVal = document.getElementById('koEditImageScaleVal');
  const rotationEl = document.getElementById('koEditImageRotation');
  const rotationVal = document.getElementById('koEditImageRotationVal');
  const opacityVal = document.getElementById('koEditImageOpacityVal');
  if (scaleEl && !koKeyImageDragging) scaleEl.value = scale;
  if (scaleVal) scaleVal.textContent = `${Math.round(scale * 100)}%`;
  if (rotationEl && !koKeyImageDragging) rotationEl.value = rotation;
  if (rotationVal) rotationVal.textContent = `${Math.round(rotation)}°`;
  if (opacityVal) opacityVal.textContent = `${Math.round(koClampNum(img.opacity, 0, 1, 1) * 100)}%`;
  koSetKeyImagePositionText(img);
}

function koInitKeyImageDrag() {
  const preview = document.getElementById('koEditPreview');
  if (!preview) return;

  preview.addEventListener('pointerdown', (e) => {
    const img = koGetCurrentKeyImage();
    if (!img) return;
    e.preventDefault();
    koKeyImageDragging = true;
    try { preview.setPointerCapture(e.pointerId); } catch {}
    const rect = preview.getBoundingClientRect();
    koKeyImageDragStart = {
      x: e.clientX,
      y: e.clientY,
      offsetX: koClampNum(img.offsetX, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0),
      offsetY: koClampNum(img.offsetY, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0),
      refW: Math.max(1, rect.width),
      refH: Math.max(1, rect.height),
    };
    preview.classList.add('kop-dragging');
  });

  preview.addEventListener('pointermove', (e) => {
    if (!koKeyImageDragging || !koKeyImageDragStart) return;
    e.preventDefault();
    const dx = (e.clientX - koKeyImageDragStart.x) / koKeyImageDragStart.refW;
    const dy = (e.clientY - koKeyImageDragStart.y) / koKeyImageDragStart.refH;
    koSetCurrentKeyImageOffset(koKeyImageDragStart.offsetX + dx, koKeyImageDragStart.offsetY + dy);
    koBgPreviewPush();
  });

  const endDrag = (e) => {
    if (!koKeyImageDragging) return;
    koKeyImageDragging = false;
    koKeyImageDragStart = null;
    preview.classList.remove('kop-dragging');
    try { preview.releasePointerCapture(e.pointerId); } catch {}
    koKeyImagePersist();
  };
  preview.addEventListener('pointerup', endDrag);
  preview.addEventListener('pointercancel', endDrag);

  preview.addEventListener('wheel', (e) => {
    const img = koGetCurrentKeyImage();
    if (!img) return;
    e.preventDefault();
    img.scale = koClampNum((img.scale || 1) * (e.deltaY < 0 ? 1.08 : 0.92), 0.2, 4, 1);
    koApplyCurrentKeyImageTransform();
    koBgPreviewPush();
    koKeyImageWheelPersistDebounced();
  }, { passive: false });
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

function koBgOnRotationInput(val) {
  if (!koConfig.background) return;
  koConfig.background.rotation = koClampNum(val, -180, 180, 0);
  const rotationVal = document.getElementById('koBgRotationVal');
  if (rotationVal) rotationVal.textContent = `${Math.round(koConfig.background.rotation)}°`;
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
  koConfig.background.rotation = 0;
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
koInitKeyImageDrag();

function koApplyConfigToUI(cfg) {
  koConfig = koNormalizeConfig(cfg || koConfig);
  koApplySelectedToUI();

  document.getElementById('koKeyColor').value = koToHexColor(koConfig.style.keyColor, '#ffffff');
  document.getElementById('koBgColor').value = koToHexColor(koConfig.style.bgColor, '#15151a');
  document.getElementById('koAccentColor').value = koToHexColor(koConfig.style.accentColor, '#f97316');
  document.getElementById('koFontFamily').value = koConfig.style.fontFamily || 'russo';
  document.getElementById('koBrandToggle').checked = koConfig.style.showBrand !== false;
  if (document.activeElement !== document.getElementById('koBrandText')) {
    document.getElementById('koBrandText').value = koConfig.style.brandText || 'WOOTING 80HE';
  }
  document.getElementById('koInactiveOpacity').value = koConfig.style.inactiveOpacity;
  document.getElementById('koGamepadToggle').checked = koConfig.gamepadEnabled;
  document.getElementById('koOpacityVal').textContent = `${Math.round(koConfig.style.inactiveOpacity * 100)}%`;
  koSetSizeUI(koConfig.style.fontSize);
  koApplyBackgroundUI();
  koApplyKeyEditorUI();
}

// Wire up keyboard picker clicks
document.getElementById('ko-keyboard').addEventListener('click', (e) => {
  const key = e.target.closest('.ko-key');
  if (!key) return;
  const kc = key.dataset.kc;
  koSelectEditKey(kc);
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
  koLoadBackgroundLibrary();
  koLoadKeyImageLibrary();
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
  koConfig.style.bgColor = document.getElementById('koBgColor').value;
  koConfig.style.accentColor = document.getElementById('koAccentColor').value;
  koConfig.style.fontFamily = document.getElementById('koFontFamily').value;
  koConfig.style.showBrand = document.getElementById('koBrandToggle').checked;
  koConfig.style.brandText = (document.getElementById('koBrandText').value || '').trim().slice(0, 40) || 'WOOTING 80HE';
  koConfig.style.inactiveOpacity = parseFloat(document.getElementById('koInactiveOpacity').value);
  koConfig.gamepadEnabled = document.getElementById('koGamepadToggle').checked;
  koApplyKeyEditorUI();
  await api.keyOverlaySetConfig(koConfig);
}

async function koSaveKeyStyle() {
  if (!koEditKey) return;
  const current = koConfig.keyStyles?.[String(koEditKey)] || {};
  const image = current.image ? { ...current.image } : null;
  if (image) {
    image.fit = document.getElementById('koEditImageFit')?.value || 'cover';
    image.opacity = koClampNum(document.getElementById('koEditImageOpacity')?.value, 0, 1, 1);
    image.scale = koClampNum(document.getElementById('koEditImageScale')?.value, 0.2, 4, 1);
    image.rotation = koClampNum(document.getElementById('koEditImageRotation')?.value, -180, 180, 0);
    image.offsetX = koClampNum(image.offsetX, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0);
    image.offsetY = koClampNum(image.offsetY, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0);
  }
  const next = {
    label: document.getElementById('koEditLabel')?.value.trim() || '',
    sub: document.getElementById('koEditSub')?.value.trim() || '',
    ...(image ? { image } : {}),
  };
  const keyColor = document.getElementById('koEditKeyColor')?.value || '';
  const bgColor = document.getElementById('koEditBgColor')?.value || '';
  const accentColor = document.getElementById('koEditAccentColor')?.value || '';
  if (current.keyColor || koToHexColor(koConfig.style.keyColor, '#ffffff').toLowerCase() !== keyColor.toLowerCase()) next.keyColor = keyColor;
  if (current.bgColor || koToHexColor(koConfig.style.bgColor, '#15151a').toLowerCase() !== bgColor.toLowerCase()) next.bgColor = bgColor;
  if (current.accentColor || koToHexColor(koConfig.style.accentColor, '#f97316').toLowerCase() !== accentColor.toLowerCase()) next.accentColor = accentColor;
  Object.keys(next).forEach((key) => {
    if (next[key] === '' || next[key] == null) delete next[key];
  });
  koConfig.keyStyles = koConfig.keyStyles || {};
  if (Object.keys(next).length) koConfig.keyStyles[String(koEditKey)] = next;
  else delete koConfig.keyStyles[String(koEditKey)];
  koApplyKeyEditorUI();
  koBgPreviewPush();
  await api.keyOverlaySetConfig(koConfig);
}

async function koResetKeyStyle() {
  if (!koEditKey) return;
  if (koConfig.keyStyles) delete koConfig.keyStyles[String(koEditKey)];
  koApplyKeyEditorUI();
  await api.keyOverlaySetConfig(koConfig);
}

// Copia los 3 colores de la tecla en edición a todas las teclas activas.
async function koApplyColorsToSelected() {
  const keyColor = document.getElementById('koEditKeyColor')?.value || '';
  const bgColor = document.getElementById('koEditBgColor')?.value || '';
  const accentColor = document.getElementById('koEditAccentColor')?.value || '';
  const targets = (koConfig.selectedKeys || []).map(String);
  if (!targets.length) {
    if (typeof toast === 'function') toast('Activá al menos una tecla para aplicarle los colores.', 'warn');
    return;
  }
  koConfig.keyStyles = koConfig.keyStyles || {};
  targets.forEach((kc) => {
    const cur = koConfig.keyStyles[kc] || {};
    koConfig.keyStyles[kc] = { ...cur, keyColor, bgColor, accentColor };
  });
  koApplyKeyEditorUI();
  koBgPreviewPush();
  await api.keyOverlaySetConfig(koConfig);
  if (typeof toast === 'function') toast(`Colores aplicados a ${targets.length} tecla${targets.length !== 1 ? 's' : ''} activa${targets.length !== 1 ? 's' : ''}.`, 'ok');
}

async function koCenterKeyImage() {
  const img = koSetCurrentKeyImageOffset(0, 0);
  if (!img) {
    koSetKeyImageMeta('Esta tecla no tiene imagen propia para centrar.', 'warn');
    return;
  }
  koBgPreviewPush();
  await api.keyOverlaySetConfig(koConfig);
  koSetKeyImageMeta('Imagen centrada.', 'ok');
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

async function koToggleBackgroundEnabled(enabled) {
  const bg = koNormalizeBackground(koConfig.background);
  koConfig.background = { ...bg, enabled: !!enabled };
  koApplyBackgroundUI();
  koBgPreviewPush();
  await api.keyOverlaySetConfig(koConfig);
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
  const prevBg = koNormalizeBackground(koConfig.background);
  koConfig.background = { type: 'url', enabled: true, value: raw, name: '', scale: prevBg.scale || 1, rotation: prevBg.rotation || 0, offsetX: prevBg.offsetX || 0, offsetY: prevBg.offsetY || 0 };
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
    koLoadBackgroundLibrary();
  } else {
    koSetBackgroundMeta(String(res?.error || 'No se pudo sincronizar la imagen en Supabase Storage.'), 'err');
  }
  input.value = '';
}

async function koClearBackground() {
  koConfig.background = { type: 'default', enabled: false, value: '', name: '' };
  const res = await api.keyOverlaySetConfig(koConfig);
  if (res?.ok) {
    koApplyBackgroundUI();
    koSetBackgroundMeta('Fondo quitado.', 'ok');
  } else {
    koSetBackgroundMeta('No se pudo actualizar el fondo.', 'err');
  }
  koRenderBackgroundLibrary();
}

function koSetBgLibraryStatus(msg, tone) {
  const el = document.getElementById('koBgLibraryStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = tone === 'ok'
    ? '#4ade80'
    : tone === 'warn'
      ? '#fbbf24'
      : tone === 'err'
        ? '#f87171'
        : 'var(--text3)';
}

function koPaintThumbImage(el, value) {
  if (!el) return;
  const url = String(value || '').replace(/"/g, '\\"');
  const checker = [
    'linear-gradient(45deg, rgba(255,255,255,.055) 25%, transparent 25%)',
    'linear-gradient(-45deg, rgba(255,255,255,.055) 25%, transparent 25%)',
    'linear-gradient(45deg, transparent 75%, rgba(255,255,255,.055) 75%)',
    'linear-gradient(-45deg, transparent 75%, rgba(255,255,255,.055) 75%)',
  ].join(', ');
  el.style.backgroundImage = url ? `url("${url}"), ${checker}` : checker;
  el.style.backgroundSize = url ? 'cover, 14px 14px, 14px 14px, 14px 14px, 14px 14px' : '14px 14px, 14px 14px, 14px 14px, 14px 14px';
  el.style.backgroundPosition = url ? 'center, 0 0, 0 7px, 7px -7px, -7px 0' : '0 0, 0 7px, 7px -7px, -7px 0';
  el.style.backgroundRepeat = url ? 'no-repeat, repeat, repeat, repeat, repeat' : 'repeat, repeat, repeat, repeat';
}

function koRenderBackgroundLibrary() {
  const grid = document.getElementById('koBgLibrary');
  if (!grid) return;
  const active = koNormalizeBackground(koConfig.background);
  grid.innerHTML = '';
  if (!koBgLibraryImages.length) return;
  koBgLibraryImages.forEach((img) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ko-bg-thumb';
    const samePath = active.storagePath && img.storagePath && active.storagePath === img.storagePath;
    const sameValue = active.value && img.value && active.value === img.value;
    btn.classList.toggle('kobg-active', !!(samePath || sameValue));
    btn.onclick = () => koUseBackgroundLibraryImage(img);

    const preview = document.createElement('span');
    preview.className = 'ko-bg-thumb-img';
    koPaintThumbImage(preview, img.value);
    const name = document.createElement('span');
    name.className = 'ko-bg-thumb-name';
    name.textContent = img.name || img.storagePath || 'Fondo';
    btn.appendChild(preview);
    btn.appendChild(name);
    grid.appendChild(btn);
  });
}

async function koLoadBackgroundLibrary() {
  const grid = document.getElementById('koBgLibrary');
  if (!grid || typeof api.keyOverlayListBackgrounds !== 'function') return;
  koSetBgLibraryStatus('Cargando imágenes...', null);
  const res = await api.keyOverlayListBackgrounds().catch((err) => ({ ok: false, error: err?.message || String(err) }));
  if (!res?.ok) {
    koBgLibraryImages = [];
    grid.innerHTML = '';
    koSetBgLibraryStatus(String(res?.error || 'No se pudieron cargar los fondos subidos.'), 'err');
    return;
  }
  koBgLibraryImages = Array.isArray(res.images) ? res.images : [];
  if (!koBgLibraryImages.length) {
    grid.innerHTML = '';
    koSetBgLibraryStatus('Todavía no hay fondos subidos.', 'warn');
    return;
  }
  koSetBgLibraryStatus(`${koBgLibraryImages.length} fondo${koBgLibraryImages.length === 1 ? '' : 's'} disponible${koBgLibraryImages.length === 1 ? '' : 's'}.`, 'ok');
  koRenderBackgroundLibrary();
}

async function koUseBackgroundLibraryImage(img) {
  if (!img?.value) return;
  koConfig.background = {
    type: 'upload',
    enabled: true,
    value: img.value,
    name: img.name || '',
    bucket: img.bucket || '',
    storagePath: img.storagePath || '',
    scale: 1,
    rotation: 0,
    offsetX: 0,
    offsetY: 0,
  };
  const res = await api.keyOverlaySetConfig(koConfig);
  if (res?.ok) {
    koApplyBackgroundUI();
    koSetBackgroundMeta(`Fondo activo: ${img.name || img.storagePath || 'imagen subida'}`, 'ok');
  } else {
    koSetBackgroundMeta('No se pudo activar ese fondo.', 'err');
  }
}

function koSetKeyImageLibraryStatus(msg, tone) {
  const el = document.getElementById('koKeyImageLibraryStatus');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = tone === 'ok'
    ? '#4ade80'
    : tone === 'warn'
      ? '#fbbf24'
      : tone === 'err'
        ? '#f87171'
        : 'var(--text3)';
}

function koRenderKeyImageLibrary() {
  const grid = document.getElementById('koKeyImageLibrary');
  if (!grid) return;
  const active = koConfig.keyStyles?.[String(koEditKey)]?.image || null;
  grid.innerHTML = '';
  if (!koKeyImageLibraryImages.length) return;
  koKeyImageLibraryImages.forEach((img) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ko-bg-thumb';
    const samePath = active?.storagePath && img.storagePath && active.storagePath === img.storagePath;
    const sameValue = active?.value && img.value && active.value === img.value;
    btn.classList.toggle('kobg-active', !!(samePath || sameValue));
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      koUseKeyImageLibraryImage(img);
    });

    const preview = document.createElement('span');
    preview.className = 'ko-bg-thumb-img';
    koPaintThumbImage(preview, img.value);
    const name = document.createElement('span');
    name.className = 'ko-bg-thumb-name';
    name.textContent = img.name || img.storagePath || 'Imagen';
    btn.appendChild(preview);
    btn.appendChild(name);
    grid.appendChild(btn);
  });
}

async function koLoadKeyImageLibrary() {
  const grid = document.getElementById('koKeyImageLibrary');
  if (!grid || typeof api.keyOverlayListKeyImages !== 'function') return;
  koSetKeyImageLibraryStatus('Cargando imágenes...', null);
  const res = await api.keyOverlayListKeyImages().catch((err) => ({ ok: false, error: err?.message || String(err) }));
  if (!res?.ok) {
    koKeyImageLibraryImages = [];
    grid.innerHTML = '';
    koSetKeyImageLibraryStatus(String(res?.error || 'No se pudieron cargar las imágenes subidas.'), 'err');
    return;
  }
  koKeyImageLibraryImages = Array.isArray(res.images) ? res.images : [];
  if (!koKeyImageLibraryImages.length) {
    grid.innerHTML = '';
    koSetKeyImageLibraryStatus('Todavía no hay imágenes de teclas subidas.', 'warn');
    return;
  }
  koSetKeyImageLibraryStatus(`${koKeyImageLibraryImages.length} imagen${koKeyImageLibraryImages.length === 1 ? '' : 'es'} disponible${koKeyImageLibraryImages.length === 1 ? '' : 's'}.`, 'ok');
  koRenderKeyImageLibrary();
}

async function koUseKeyImageLibraryImage(img) {
  if (!img?.value || !koEditKey) {
    koSetKeyImageMeta('Seleccioná una tecla y una imagen válida.', 'warn');
    return;
  }
  const key = String(koEditKey);
  koConfig.keyStyles = koConfig.keyStyles || {};
  const current = koConfig.keyStyles[key] || {};
  const currentImage = current.image || {};
  const nextImage = {
    type: 'upload',
    value: img.value,
    name: img.name || '',
    bucket: img.bucket || '',
    storagePath: img.storagePath || '',
    fit: currentImage.fit || document.getElementById('koEditImageFit')?.value || 'cover',
    opacity: koClampNum(currentImage.opacity ?? document.getElementById('koEditImageOpacity')?.value, 0, 1, 1),
    scale: koClampNum(currentImage.scale ?? document.getElementById('koEditImageScale')?.value, 0.2, 4, 1),
    rotation: koClampNum(currentImage.rotation ?? document.getElementById('koEditImageRotation')?.value, -180, 180, 0),
    offsetX: koClampNum(currentImage.offsetX, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0),
    offsetY: koClampNum(currentImage.offsetY, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0),
  };
  koConfig.keyStyles[key] = {
    ...current,
    image: nextImage,
  };
  koApplyKeyEditorUI();
  koBgPreviewPush();
  koSetKeyImageMeta(`Aplicando imagen a ${koKeyDefaultLabel(key)}...`, null);
  const res = await api.keyOverlaySetConfig(koConfig);
  if (res?.ok) {
    if (res.config) koConfig = koNormalizeConfig(res.config);
    koApplyKeyEditorUI();
    koSetKeyImageMeta(`Imagen reutilizada: ${img.name || img.storagePath || 'imagen subida'}`, 'ok');
    return;
  }
  koSetKeyImageMeta(String(res?.error || 'No se pudo aplicar esa imagen.'), 'err');
}

function koOpenKeyImageFilePicker() {
  document.getElementById('koEditImageFile')?.click();
}

function koValidImageUrl(raw) {
  if (/^data:image\//i.test(raw)) return true;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function koApplyKeyImageUrl() {
  if (!koEditKey) return;
  const input = document.getElementById('koEditImageUrl');
  const raw = String(input?.value || '').trim();
  if (!raw) {
    koSetKeyImageMeta('Pegá una URL primero.', 'warn');
    return;
  }
  if (!koValidImageUrl(raw)) {
    koSetKeyImageMeta('URL inválida. Usá http:// o https://', 'err');
    return;
  }
  koConfig.keyStyles = koConfig.keyStyles || {};
  const current = koConfig.keyStyles[String(koEditKey)] || {};
  koConfig.keyStyles[String(koEditKey)] = {
    ...current,
    image: {
      type: 'url',
      value: raw,
      name: '',
      fit: document.getElementById('koEditImageFit')?.value || current.image?.fit || 'cover',
      opacity: koClampNum(document.getElementById('koEditImageOpacity')?.value, 0, 1, current.image?.opacity ?? 1),
      scale: koClampNum(current.image?.scale, 0.2, 4, 1),
      rotation: koClampNum(current.image?.rotation, -180, 180, 0),
      offsetX: koClampNum(current.image?.offsetX, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0),
      offsetY: koClampNum(current.image?.offsetY, -KO_KEY_IMAGE_PAN_LIMIT, KO_KEY_IMAGE_PAN_LIMIT, 0),
    },
  };
  koApplyKeyEditorUI();
  const res = await api.keyOverlaySetConfig(koConfig);
  koSetKeyImageMeta(res?.ok ? 'Imagen por URL guardada y sincronizada.' : 'No se pudo guardar la imagen.', res?.ok ? 'ok' : 'err');
}

async function koUploadKeyImage(input) {
  const file = input?.files?.[0];
  if (!file || !koEditKey) return;
  if (!String(file.type || '').toLowerCase().startsWith('image/')) {
    koSetKeyImageMeta('El archivo debe ser una imagen.', 'err');
    input.value = '';
    return;
  }
  if (file.size > KO_MAX_BG_FILE_SIZE) {
    koSetKeyImageMeta('La imagen supera 3MB. Elegí una más liviana.', 'err');
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
    koSetKeyImageMeta('No se pudo leer la imagen seleccionada.', 'err');
    input.value = '';
    return;
  }

  const res = await api.keyOverlayUploadKeyImage({
    keycode: koEditKey,
    fileName: String(file.name || '').trim(),
    dataUrl,
  });
  if (res?.ok) {
    koConfig.keyStyles = koConfig.keyStyles || {};
    koConfig.keyStyles[String(koEditKey)] = {
      ...(koConfig.keyStyles[String(koEditKey)] || {}),
      ...(res.keyStyle || {}),
    };
    koApplyKeyEditorUI();
    koSetKeyImageMeta('Imagen de tecla subida y sincronizada.', 'ok');
    koLoadKeyImageLibrary();
  } else {
    koSetKeyImageMeta(String(res?.error || 'No se pudo subir la imagen de la tecla.'), 'err');
  }
  input.value = '';
}

async function koClearKeyImage() {
  if (!koEditKey) return;
  const current = { ...(koConfig.keyStyles?.[String(koEditKey)] || {}) };
  delete current.image;
  koConfig.keyStyles = koConfig.keyStyles || {};
  if (Object.keys(current).length) koConfig.keyStyles[String(koEditKey)] = current;
  else delete koConfig.keyStyles[String(koEditKey)];
  koApplyKeyEditorUI();
  await api.keyOverlaySetConfig(koConfig);
  koSetKeyImageMeta('Imagen propia quitada.', 'ok');
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
    koEditKey = String(kc);
    koBuildEditOptions();
    koApplyKeyEditorUI();
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
    if (koBgDragging || koKeyImageDragging) return; // no pisar el arrastre en curso
    koApplyConfigToUI(payload.config);
    if (payload?.source === 'supabase') {
      koSetBackgroundMeta('Cambio remoto aplicado desde Supabase.', 'ok');
      setTimeout(() => koApplyBackgroundUI(), 1600);
    }
  });
}

// ══════════════════════════════════════════
