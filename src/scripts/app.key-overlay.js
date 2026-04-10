// ── Key Overlay ────────────────────────────────────────────────────
let koConfig = {
  selectedKeys: [16,17,18,19,30,31,32,33,42,29,57416,57424,57419,57421,'m1','m2'],
  customKeys: [],
  style: { fontSize: 'md', keyColor: '#ffffff', bgColor: 'rgba(15,15,20,0.9)', accentColor: '#f97316', fadeDelay: 0, inactiveOpacity: 0.3 }
};
const koActiveKeys = new Map();

// Wire up keyboard picker clicks
document.getElementById('ko-keyboard').addEventListener('click', (e) => {
  const key = e.target.closest('.ko-key');
  if (!key) return;
  const kc = key.dataset.kc;
  const kcVal = isNaN(kc) ? kc : Number(kc);
  const sel = koConfig.selectedKeys.map(String);
  const idx = sel.indexOf(String(kc));
  if (idx === -1) koConfig.selectedKeys.push(kcVal);
  else koConfig.selectedKeys.splice(idx, 1);
  koApplySelectedToUI();
  api.keyOverlaySetConfig(koConfig);
});

function koApplySelectedToUI() {
  const sel = new Set(koConfig.selectedKeys.map(String));
  document.querySelectorAll('#ko-keyboard .ko-key').forEach(el => {
    el.classList.toggle('kok-on', sel.has(el.dataset.kc));
  });
}

async function loadKeyOverlay() {
  const r = await api.keyOverlayGetStatus();
  document.getElementById('koToggle').checked = r.running;
  document.getElementById('koUrlRow').classList.toggle('hidden', !r.running);
  document.getElementById('koStatusText').textContent = r.running ? 'Activo en ' + r.url : 'Desactivado';

  const cfg = (await api.keyOverlayGetConfig()).config;
  koConfig = cfg;
  koApplySelectedToUI();
  document.getElementById('koKeyColor').value = cfg.style.keyColor;
  document.getElementById('koAccentColor').value = cfg.style.accentColor;
  const op = cfg.style.inactiveOpacity ?? 0.3;
  document.getElementById('koInactiveOpacity').value = op;
  document.getElementById('koGamepadToggle').checked = cfg.gamepadEnabled ?? false;
  document.getElementById('koOpacityVal').textContent = Math.round(op * 100) + '%';
  koSetSizeUI(cfg.style.fontSize);
}

async function koToggle(enabled) {
  if (enabled) {
    await api.keyOverlayStart();
  } else {
    await api.keyOverlayStop();
    document.getElementById('koStatusText').textContent = 'Desactivado';
    document.getElementById('koUrlRow').classList.add('hidden');
    koPreviewClear();
  }
}

async function koSaveConfig() {
  koConfig.style.keyColor         = document.getElementById('koKeyColor').value;
  koConfig.style.accentColor      = document.getElementById('koAccentColor').value;
  koConfig.style.inactiveOpacity  = parseFloat(document.getElementById('koInactiveOpacity').value);
  koConfig.gamepadEnabled         = document.getElementById('koGamepadToggle').checked;
  await api.keyOverlaySetConfig(koConfig);
}

function koOnOpacity(val) {
  document.getElementById('koOpacityVal').textContent = Math.round(val * 100) + '%';
  koSaveConfig();
}


function koSetSize(sz) {
  koConfig.style.fontSize = sz;
  koSetSizeUI(sz);
  api.keyOverlaySetConfig(koConfig);
}

function koSetSizeUI(sz) {
  ['sm','md','lg','xl'].forEach(s => {
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
  } catch(e) {}
  btn.textContent = 'Copiado';
  setTimeout(() => { btn.textContent = 'Copiar'; }, 2000);
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

  // Store in customKeys (with label so it can merge with same-label keys in overlay)
  koConfig.customKeys = koConfig.customKeys || [];
  const alreadyCustom = koConfig.customKeys.some(k => String(k.keycode) === String(kc));
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
    prev.querySelectorAll('span').forEach(s => s.remove());
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

// ══════════════════════════════════════════
