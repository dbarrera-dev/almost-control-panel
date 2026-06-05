// ── Sorteos ────────────────────────────────────────────────────────
const SORTEO_TAU = Math.PI * 2;
const SORTEO_WHEEL_MIN_DURATION_SEC = 3;
const SORTEO_WHEEL_MAX_DURATION_SEC = 20;
const SORTEO_WHEEL_DEFAULT_DURATION_SEC = 7;
const SORTEO_WHEEL_BASE_SPINS = 7;

const SORTEO_WHEEL_PALETTE = [
  '#ffb703',
  '#fb8500',
  '#ef476f',
  '#e63946',
  '#8338ec',
  '#3a86ff',
  '#00b4d8',
  '#06d6a0',
  '#52b788',
  '#80ed99',
  '#f72585',
  '#ff6b6b',
];

const SORTEO_CONFETTI_COLORS = [
  '#fbbf24',
  '#f59e0b',
  '#ef4444',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#f97316',
  '#fde68a',
];

const sorteoWheelState = {
  initialized: false,
  canvas: null,
  ctx: null,
  overlayCanvas: null,
  overlayCtx: null,
  entries: [],
  excludedKeys: new Set(),
  lastWinner: null,
  lastWinnerKey: '',
  spinning: false,
  rotation: 0,
  spinMeta: null,
  spinRaf: 0,
  autoRemoveWinner: true,
  durationSec: SORTEO_WHEEL_DEFAULT_DURATION_SEC,
  confettiPieces: [],
  confettiRaf: 0,
  confettiStartTs: 0,
  confettiPrevTs: 0,
  confettiNextBurstTs: 0,
  overlayVisible: false,
  pendingSync: false,
  audioCtx: null,
  audioMasterGain: null,
  lastTickIndex: -1,
  lastTickMs: 0,
};

function _sorteoArr(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function _normalizeSorteoPart(p) {
  return {
    nick: String(p?.nick || '').trim(),
    joined_at: p?.joined_at || p?.created_at || new Date().toISOString(),
  };
}

function _nickKey(nick) {
  return String(nick || '').trim().toLowerCase();
}

function _setSorteoUiState() {
  const bar = document.getElementById('sorteoStatusBar');
  const txt = document.getElementById('sorteoStatusTxt');
  const btn = document.getElementById('sorteoToggleBtn');
  if (bar) bar.classList.toggle('activo', !!sorteoActivo);
  if (txt) txt.textContent = sorteoActivo ? 'SORTEO ABIERTO — ANOTANDO PARTICIPANTES' : 'SORTEO CERRADO';
  if (btn) {
    btn.textContent = sorteoActivo ? 'Cerrar sorteo' : 'Abrir sorteo';
    btn.className = sorteoActivo ? 'btn btn-danger' : 'btn btn-orange';
  }
  const badge = document.getElementById('sorteoBadge');
  if (badge) badge.classList.toggle('hidden', !sorteoActivo);
}

function _h(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _sorteoParseManualNicks(raw) {
  const parts = String(raw || '')
    .replace(/\r/g, '\n')
    .split(/[\n,;]+/);

  const out = [];
  const seen = new Set();
  for (const part of parts) {
    let nick = String(part || '').trim();
    nick = nick.replace(/^@+/, '').trim();
    nick = nick.replace(/\s+/g, ' ');
    if (!nick) continue;
    if (nick.length > 40) nick = nick.slice(0, 40);
    const key = _nickKey(nick);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(nick);
    if (out.length >= 500) break;
  }
  return out;
}

function _sorteoWheelRand() {
  if (window.crypto?.getRandomValues) {
    const arr = new Uint32Array(1);
    window.crypto.getRandomValues(arr);
    return arr[0] / 4294967296;
  }
  return Math.random();
}

function _sorteoWheelRandInt(maxExclusive) {
  if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) return 0;
  return Math.floor(_sorteoWheelRand() * maxExclusive);
}

function _sorteoWheelHash(str) {
  let h = 2166136261;
  const txt = String(str || '');
  for (let i = 0; i < txt.length; i++) {
    h ^= txt.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function _sorteoWheelColorForKey(key) {
  return SORTEO_WHEEL_PALETTE[_sorteoWheelHash(key) % SORTEO_WHEEL_PALETTE.length];
}

function _sorteoWheelHexToRgb(hex) {
  const value = String(hex || '').trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  const n = Number.parseInt(value, 16);
  return {
    r: (n >> 16) & 255,
    g: (n >> 8) & 255,
    b: n & 255,
  };
}

function _sorteoWheelTextStyleForColor(hex) {
  const rgb = _sorteoWheelHexToRgb(hex);
  if (!rgb) {
    return {
      textFill: 'rgba(255,255,255,0.96)',
      textStroke: 'rgba(0,0,0,0.35)',
    };
  }
  const lum = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  if (lum > 0.62) {
    return {
      textFill: 'rgba(17,24,39,0.95)',
      textStroke: 'rgba(255,255,255,0.58)',
    };
  }
  return {
    textFill: 'rgba(248,250,252,0.96)',
    textStroke: 'rgba(0,0,0,0.40)',
  };
}

function _sorteoWheelRecomputeColors() {
  const entries = sorteoWheelState.entries;
  const count = entries.length;
  const paletteLen = SORTEO_WHEEL_PALETTE.length;
  if (!count || !paletteLen) return;

  const chosen = new Array(count);
  let firstIdx = -1;
  let prevIdx = -1;

  for (let i = 0; i < count; i++) {
    const key = entries[i]?.key || entries[i]?.nick || String(i);
    const base = _sorteoWheelHash(`${key}|${i}`) % paletteLen;
    let idx = base;

    for (let step = 0; step < paletteLen; step++) {
      const cand = (base + step) % paletteLen;
      if (cand === prevIdx) continue;
      if (i === count - 1 && count > 2 && cand === firstIdx) continue;
      idx = cand;
      break;
    }

    if (i === 0) firstIdx = idx;
    prevIdx = idx;
    chosen[i] = idx;
  }

  if (count > 2 && paletteLen > 1 && chosen[0] === chosen[count - 1]) {
    const prev = chosen[count - 2];
    for (let step = 1; step < paletteLen; step++) {
      const cand = (chosen[count - 1] + step) % paletteLen;
      if (cand === prev || cand === chosen[0]) continue;
      chosen[count - 1] = cand;
      break;
    }
  }

  for (let i = 0; i < count; i++) {
    const color = SORTEO_WHEEL_PALETTE[chosen[i] % paletteLen];
    const textStyle = _sorteoWheelTextStyleForColor(color);
    entries[i].colorIndex = chosen[i];
    entries[i].color = color;
    entries[i].textFill = textStyle.textFill;
    entries[i].textStroke = textStyle.textStroke;
  }
}

function _sorteoWheelNormAngle(angle) {
  return ((angle % SORTEO_TAU) + SORTEO_TAU) % SORTEO_TAU;
}

function _sorteoWheelPosMod(value, mod) {
  return ((value % mod) + mod) % mod;
}

function _sorteoWheelClampDuration(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return SORTEO_WHEEL_DEFAULT_DURATION_SEC;
  return Math.max(SORTEO_WHEEL_MIN_DURATION_SEC, Math.min(SORTEO_WHEEL_MAX_DURATION_SEC, n));
}

function _sorteoWheelGetAudioCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;

  if (!sorteoWheelState.audioCtx) {
    try {
      sorteoWheelState.audioCtx = new AC();
      const gain = sorteoWheelState.audioCtx.createGain();
      gain.gain.value = 0.28;
      gain.connect(sorteoWheelState.audioCtx.destination);
      sorteoWheelState.audioMasterGain = gain;
    } catch {
      sorteoWheelState.audioCtx = null;
      sorteoWheelState.audioMasterGain = null;
    }
  }

  const ctx = sorteoWheelState.audioCtx;
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
  return ctx || null;
}

function _sorteoWheelPlayTone({ freq, duration, gain, type, attack, release }) {
  const ctx = _sorteoWheelGetAudioCtx();
  if (!ctx || !sorteoWheelState.audioMasterGain) return;
  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = Math.max(80, Number(freq || 440));

    amp.gain.cancelScheduledValues(now);
    amp.gain.setValueAtTime(0, now);
    amp.gain.linearRampToValueAtTime(Math.max(0.0001, Number(gain || 0.02)), now + Math.max(0.002, Number(attack || 0.005)));
    amp.gain.exponentialRampToValueAtTime(0.0001, now + Math.max(0.015, Number(duration || 0.06)) + Math.max(0.015, Number(release || 0.045)));

    osc.connect(amp);
    amp.connect(sorteoWheelState.audioMasterGain);
    osc.start(now);
    osc.stop(now + Math.max(0.015, Number(duration || 0.06)) + Math.max(0.015, Number(release || 0.045)) + 0.01);
  } catch {}
}

function _sorteoWheelPlayTick(progress) {
  const nowMs = Date.now();
  if (nowMs - sorteoWheelState.lastTickMs < 12) return;
  sorteoWheelState.lastTickMs = nowMs;

  const p = Math.max(0, Math.min(1, Number(progress || 0)));
  const energy = 1 - p;
  _sorteoWheelPlayTone({
    freq: 760 + (energy * 180),
    duration: 0.018 + (energy * 0.015),
    gain: 0.012 + (energy * 0.010),
    type: 'triangle',
    attack: 0.003,
    release: 0.030,
  });
}

function _sorteoWheelPlayWhoosh(durationSec) {
  const ctx = _sorteoWheelGetAudioCtx();
  if (!ctx || !sorteoWheelState.audioMasterGain) return;
  try {
    const now = ctx.currentTime;
    const dur = Math.max(0.5, Math.min(2.4, Number(durationSec || 1) * 0.32));
    const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.85;
    filter.frequency.setValueAtTime(260, now);
    filter.frequency.exponentialRampToValueAtTime(1900, now + dur * 0.55);
    filter.frequency.exponentialRampToValueAtTime(320, now + dur);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.linearRampToValueAtTime(0.055, now + Math.min(0.2, dur * 0.3));
    amp.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(filter);
    filter.connect(amp);
    amp.connect(sorteoWheelState.audioMasterGain);
    src.start(now);
    src.stop(now + dur + 0.03);

    // Sub-sweep para darle cuerpo al arranque
    _sorteoWheelPlayTone({ freq: 130, duration: 0.22, gain: 0.03, type: 'sawtooth', attack: 0.02, release: 0.28 });
  } catch {}
}

function _sorteoWheelPlayWinnerSfx() {
  // Arpegio triunfal ascendente C5–E5–G5–C6 con armónico
  const notes = [523.25, 659.25, 783.99, 1046.50];
  notes.forEach((f, i) => {
    setTimeout(() => {
      _sorteoWheelPlayTone({ freq: f, duration: 0.13, gain: 0.05, type: 'sine', attack: 0.005, release: 0.12 });
      _sorteoWheelPlayTone({ freq: f * 2, duration: 0.10, gain: 0.016, type: 'triangle', attack: 0.004, release: 0.10 });
    }, i * 95);
  });
  // Brillo final sostenido
  setTimeout(() => {
    _sorteoWheelPlayTone({ freq: 1318.51, duration: 0.45, gain: 0.03, type: 'sine', attack: 0.02, release: 0.55 });
    _sorteoWheelPlayTone({ freq: 1567.98, duration: 0.45, gain: 0.022, type: 'sine', attack: 0.03, release: 0.6 });
  }, notes.length * 95);
}

function _sorteoWheelCreateEntry(part) {
  const normalized = _normalizeSorteoPart(part);
  const key = _nickKey(normalized.nick);
  if (!key) return null;
  const baseColor = _sorteoWheelColorForKey(key);
  const textStyle = _sorteoWheelTextStyleForColor(baseColor);
  return {
    nick: normalized.nick,
    joined_at: normalized.joined_at,
    key,
    colorIndex: 0,
    color: baseColor,
    textFill: textStyle.textFill,
    textStroke: textStyle.textStroke,
  };
}

function _sorteoWheelIndexAtPointer(rotation, count) {
  if (!count) return -1;
  const arc = SORTEO_TAU / count;
  const rel = _sorteoWheelNormAngle(-rotation);
  let idx = Math.floor(rel / arc);
  if (idx >= count) idx = 0;
  return idx;
}

function _sorteoWheelFitLabel(ctx, text, maxWidth) {
  let out = String(text || '');
  if (!out) return '';
  if (ctx.measureText(out).width <= maxWidth) return out;
  while (out.length > 1 && ctx.measureText(out + '…').width > maxWidth) {
    out = out.slice(0, -1);
  }
  return out + '…';
}

function _sorteoWheelEnsureCanvasSize(canvas, ctx) {
  if (!canvas || !ctx) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const pxW = Math.max(1, Math.round(rect.width * dpr));
  const pxH = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w: rect.width, h: rect.height };
}

function _sorteoWheelDraw() {
  if (!sorteoWheelState.canvas || !sorteoWheelState.ctx) return;
  const d = _sorteoWheelEnsureCanvasSize(sorteoWheelState.canvas, sorteoWheelState.ctx);
  if (!d) return;
  const ctx = sorteoWheelState.ctx;
  const { w, h } = d;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.max(32, Math.min(w, h) / 2 - 8);
  const wheelRadius = Math.max(24, radius - Math.max(12, radius * 0.055));
  const centerRadius = Math.max(28, wheelRadius * 0.19);
  const count = sorteoWheelState.entries.length;

  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const halo = ctx.createRadialGradient(cx, cy, radius * 0.34, cx, cy, radius * 1.14);
  halo.addColorStop(0, 'rgba(255,180,75,0.02)');
  halo.addColorStop(0.72, 'rgba(18,18,20,0.12)');
  halo.addColorStop(1, 'rgba(5,5,6,0.36)');
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 4, 0, SORTEO_TAU);
  ctx.fillStyle = halo;
  ctx.fill();

  const rimGradient = ctx.createRadialGradient(cx, cy, radius * 0.18, cx, cy, radius + 6);
  rimGradient.addColorStop(0, 'rgba(56,56,58,0.96)');
  rimGradient.addColorStop(0.58, 'rgba(18,18,19,0.98)');
  rimGradient.addColorStop(1, 'rgba(5,5,5,1)');
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, SORTEO_TAU);
  ctx.fillStyle = rimGradient;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, radius - 1, 0, SORTEO_TAU);
  ctx.strokeStyle = 'rgba(255,242,215,0.28)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, radius - 7, 0, SORTEO_TAU);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  const plateGradient = ctx.createRadialGradient(cx, cy - wheelRadius * 0.34, wheelRadius * 0.1, cx, cy, wheelRadius * 1.02);
  plateGradient.addColorStop(0, 'rgba(32,34,39,0.86)');
  plateGradient.addColorStop(0.55, 'rgba(14,15,18,0.97)');
  plateGradient.addColorStop(1, 'rgba(7,8,9,1)');
  ctx.beginPath();
  ctx.arc(cx, cy, wheelRadius, 0, SORTEO_TAU);
  ctx.fillStyle = plateGradient;
  ctx.fill();

  if (!count) {
    ctx.beginPath();
    ctx.arc(cx, cy, centerRadius * 1.42, 0, SORTEO_TAU);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fill();
    return;
  }

  const arc = SORTEO_TAU / count;
  const base = sorteoWheelState.rotation - Math.PI / 2;
  const drawTextEvery = count > 140 ? 0 : count > 90 ? 4 : count > 60 ? 3 : count > 36 ? 2 : 1;

  for (let i = 0; i < count; i++) {
    const entry = sorteoWheelState.entries[i];
    const start = base + i * arc;
    const end = start + arc;
    const mid = start + arc / 2;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, wheelRadius, start, end);
    ctx.closePath();
    ctx.fillStyle = entry.color;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, wheelRadius, start, end);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (drawTextEvery && i % drawTextEvery === 0) {
      let fontSize = 18;
      if (count > 12) fontSize = 16;
      if (count > 24) fontSize = 13;
      if (count > 40) fontSize = 11;
      if (count > 70) fontSize = 9;
      const textR = wheelRadius - Math.max(14, wheelRadius * 0.08);
      const maxTextW = wheelRadius * 0.62;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(mid);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = `700 ${fontSize}px 'Inter', sans-serif`;
      const label = _sorteoWheelFitLabel(ctx, entry.nick, maxTextW);
      ctx.lineWidth = 3;
      ctx.strokeStyle = entry.textStroke || 'rgba(0, 0, 0, 0.35)';
      ctx.strokeText(label, textR, 0);
      ctx.fillStyle = entry.textFill || 'rgba(255, 255, 255, 0.96)';
      ctx.fillText(label, textR, 0);
      ctx.restore();
    }
  }

  if (count <= 170) {
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.lineWidth = count > 84 ? 0.5 : 0.75;
    for (let i = 0; i < count; i++) {
      const a = base + i * arc;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * wheelRadius, cy + Math.sin(a) * wheelRadius);
      ctx.stroke();
    }
  }

  const pointerIdx = _sorteoWheelIndexAtPointer(sorteoWheelState.rotation, count);
  if (pointerIdx >= 0) {
    const hiStart = base + pointerIdx * arc;
    const hiEnd = hiStart + arc;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, wheelRadius, hiStart, hiEnd);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(cx, cy, wheelRadius - 2, hiStart, hiEnd);
    ctx.strokeStyle = 'rgba(255, 244, 208, 0.98)';
    ctx.lineWidth = Math.max(2.5, wheelRadius * 0.013);
    ctx.stroke();
  }

  const gloss = ctx.createRadialGradient(cx, cy - wheelRadius * 0.66, wheelRadius * 0.08, cx, cy, wheelRadius * 0.96);
  gloss.addColorStop(0, 'rgba(255,255,255,0.2)');
  gloss.addColorStop(0.35, 'rgba(255,255,255,0.03)');
  gloss.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.arc(cx, cy, wheelRadius, 0, SORTEO_TAU);
  ctx.fillStyle = gloss;
  ctx.fill();

  const vignette = ctx.createRadialGradient(cx, cy, wheelRadius * 0.3, cx, cy, wheelRadius);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(0.7, 'rgba(0,0,0,0.08)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.beginPath();
  ctx.arc(cx, cy, wheelRadius, 0, SORTEO_TAU);
  ctx.fillStyle = vignette;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, centerRadius * 1.05, 0, SORTEO_TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy - wheelRadius + 7, 3.3, 0, SORTEO_TAU);
  ctx.fillStyle = 'rgba(255, 247, 217, 0.88)';
  ctx.fill();
}

function _sorteoWheelRenderNames() {
  const wrap = document.getElementById('sorteoWheelNames');
  if (!wrap) return;

  const count = sorteoWheelState.entries.length;
  if (!count) {
    wrap.innerHTML = '<div class="sorteo-empty"><p>La ruleta está vacía.</p></div>';
    return;
  }

  wrap.innerHTML = sorteoWheelState.entries.map((entry, idx) => {
    const lastClass = sorteoWheelState.lastWinnerKey === entry.key ? ' is-last' : '';
    const disabled = sorteoWheelState.spinning ? 'disabled' : '';
    return `<div class="sorteo-wheel-name-row${lastClass}">
      <span class="sorteo-wheel-name-color" style="background:${entry.color}"></span>
      <span class="sorteo-wheel-name-num">${idx + 1}</span>
      <span class="sorteo-wheel-name-nick">${_h(entry.nick)}</span>
      <button ${disabled} onclick="sorteoWheelRemoveEntry(${idx})">Quitar</button>
    </div>`;
  }).join('');
}

function _sorteoWheelRenderLastWinner() {
  const el = document.getElementById('sorteoWheelLastWinner');
  if (!el) return;
  if (!sorteoWheelState.lastWinner?.nick) {
    el.textContent = 'Último ganador: —';
    return;
  }
  el.innerHTML = `Último ganador:<b>${_h(sorteoWheelState.lastWinner.nick)}</b>`;
}

function _sorteoWheelUpdateControls() {
  const count = sorteoWheelState.entries.length;
  const spinBtn = document.getElementById('sorteoWheelSpinBtn');
  const syncBtn = document.getElementById('sorteoWheelSyncBtn');
  const resetBtn = document.getElementById('sorteoWheelResetBtn');
  const manualInput = document.getElementById('sorteoManualInput');
  const manualAddBtn = document.getElementById('sorteoManualAddBtn');
  const chip = document.getElementById('sorteoWheelCountChip');
  const stage = document.getElementById('sorteoWheelStage');
  const empty = document.getElementById('sorteoWheelEmpty');
  const countBig = document.getElementById('sorteoCountBig');

  if (chip) chip.textContent = `${count} en ruleta`;
  if (countBig) countBig.textContent = count;
  if (spinBtn) spinBtn.disabled = sorteoWheelState.spinning || count === 0;
  if (syncBtn) syncBtn.disabled = !!sorteoWheelState.spinning;
  if (resetBtn) resetBtn.disabled = !!sorteoWheelState.spinning;
  if (manualInput) manualInput.disabled = !!sorteoWheelState.spinning;
  if (manualAddBtn) manualAddBtn.disabled = !!sorteoWheelState.spinning;
  if (stage) stage.classList.toggle('is-spinning', !!sorteoWheelState.spinning);
  if (empty) empty.style.display = count ? 'none' : 'flex';
}

function _sorteoWheelRenderAll() {
  _sorteoWheelRecomputeColors();
  _sorteoWheelUpdateControls();
  _sorteoWheelRenderNames();
  _sorteoWheelRenderLastWinner();
  _sorteoWheelDraw();
}

function _sorteoWheelSyncFromParticipantes({ replace = false, clearExcluded = false } = {}) {
  if (!Array.isArray(sorteoParticipantes)) sorteoParticipantes = [];

  if (replace) sorteoWheelState.entries = [];
  if (clearExcluded) sorteoWheelState.excludedKeys.clear();

  const existing = new Set(sorteoWheelState.entries.map(e => e.key));
  let added = 0;

  for (const part of sorteoParticipantes) {
    const entry = _sorteoWheelCreateEntry(part);
    if (!entry) continue;
    if (sorteoWheelState.excludedKeys.has(entry.key)) continue;
    if (existing.has(entry.key)) continue;
    existing.add(entry.key);
    sorteoWheelState.entries.push(entry);
    added++;
  }

  if (!sorteoWheelState.entries.length) {
    sorteoWheelState.rotation = 0;
  }

  _sorteoWheelRenderAll();
  return added;
}

function _sorteoWheelAddLiveParticipante(part) {
  const entry = _sorteoWheelCreateEntry(part);
  if (!entry) return false;
  if (sorteoWheelState.excludedKeys.has(entry.key)) return false;
  if (sorteoWheelState.spinning) {
    sorteoWheelState.pendingSync = true;
    return false;
  }
  const exists = sorteoWheelState.entries.some(e => e.key === entry.key);
  if (exists) return false;
  sorteoWheelState.entries.push(entry);
  _sorteoWheelRenderAll();
  return true;
}

function _sorteoWheelStopSpin() {
  if (sorteoWheelState.spinRaf) {
    cancelAnimationFrame(sorteoWheelState.spinRaf);
    sorteoWheelState.spinRaf = 0;
  }
  sorteoWheelState.spinning = false;
  sorteoWheelState.spinMeta = null;
  sorteoWheelState.lastTickIndex = -1;
  _sorteoWheelExitFocus();
}

// ── Modo foco: la ruleta viaja suave hasta el centro de la pantalla ──
function _sorteoWheelEnterFocus() {
  const stage = document.getElementById('sorteoWheelStage');
  if (!stage) { document.body.classList.add('sorteo-focus'); return; }
  // First: congelar la posición/tamaño actuales para que al pasar a fixed no salte
  const r = stage.getBoundingClientRect();
  stage.style.setProperty('--f-top', r.top + 'px');
  stage.style.setProperty('--f-left', r.left + 'px');
  stage.style.setProperty('--f-w', r.width + 'px');
  stage.style.setProperty('--f-h', r.height + 'px');
  stage.style.setProperty('--f-dx', '0px');
  stage.style.setProperty('--f-dy', '0px');
  stage.style.setProperty('--f-scale', '1');
  document.body.classList.add('sorteo-focus');
  // Last: en el próximo frame, animar el transform hacia el centro + escala
  requestAnimationFrame(() => {
    if (!document.body.classList.contains('sorteo-focus')) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const canvas = document.getElementById('sorteoWheelCanvas');
    const wheelW = (canvas ? canvas.getBoundingClientRect().width : r.width) || r.width;
    const target = Math.min(Math.min(vw, vh) * 0.8, 600);
    const scale = Math.max(1, target / wheelW);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    stage.style.setProperty('--f-dx', (vw / 2 - cx).toFixed(1) + 'px');
    stage.style.setProperty('--f-dy', (vh / 2 - cy).toFixed(1) + 'px');
    stage.style.setProperty('--f-scale', scale.toFixed(3));
  });
}

function _sorteoWheelExitFocus() {
  document.body.classList.remove('sorteo-focus');
  const stage = document.getElementById('sorteoWheelStage');
  if (!stage) return;
  ['--f-top', '--f-left', '--f-w', '--f-h', '--f-dx', '--f-dy', '--f-scale']
    .forEach(p => stage.style.removeProperty(p));
}

function _sorteoWheelResetState({ reseedFromParticipantes = false, clearExcluded = true } = {}) {
  _sorteoWheelStopSpin();
  sorteoWheelCloseWinner(true);
  sorteoWheelState.entries = [];
  if (clearExcluded) sorteoWheelState.excludedKeys.clear();
  sorteoWheelState.lastWinner = null;
  sorteoWheelState.lastWinnerKey = '';
  sorteoWheelState.rotation = 0;
  if (reseedFromParticipantes) _sorteoWheelSyncFromParticipantes({ replace: true, clearExcluded });
  else _sorteoWheelRenderAll();
}

function initSorteoWheel() {
  sorteoWheelState.canvas = document.getElementById('sorteoWheelCanvas');
  sorteoWheelState.ctx = sorteoWheelState.canvas ? sorteoWheelState.canvas.getContext('2d') : null;
  sorteoWheelState.overlayCanvas = document.getElementById('sorteoWheelConfettiCanvas');
  sorteoWheelState.overlayCtx = sorteoWheelState.overlayCanvas ? sorteoWheelState.overlayCanvas.getContext('2d') : null;

  const durationInput = document.getElementById('sorteoWheelDuration');
  if (durationInput) durationInput.value = String(sorteoWheelState.durationSec);
  const autoRemove = document.getElementById('sorteoWheelAutoRemove');
  if (autoRemove) autoRemove.checked = !!sorteoWheelState.autoRemoveWinner;

  if (!sorteoWheelState.initialized) {
    sorteoWheelState.initialized = true;
    window.addEventListener('resize', () => {
      _sorteoWheelDraw();
      _sorteoWheelResizeConfettiCanvas();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && sorteoWheelState.overlayVisible) sorteoWheelCloseWinner();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) _sorteoWheelStopConfetti();
    });
  }

  _sorteoWheelRenderAll();
}

function _renderSorteoWinners() {
  if (!Array.isArray(sorteoCurrentWinners)) sorteoCurrentWinners = [];
  const wrap = document.getElementById('sorteoWinnersWrap');
  const list = document.getElementById('sorteoWinnersList');
  const cleanBtn = document.getElementById('limpiarBtn');
  if (!wrap || !list) return;

  if (!sorteoCurrentWinners.length) {
    wrap.classList.add('hidden');
    if (cleanBtn) cleanBtn.textContent = 'Limpiar participantes';
    _updateSorteoResultsEmpty();
    _updateSorteoWinnersBadge();
    return;
  }

  const medals = ['1°', '2°', '3°', '4°', '5°', '6°', '7°', '8°'];
  list.innerHTML = sorteoCurrentWinners.map((w, i) => `
    <div class="sorteo-winner-item">
      <span class="sorteo-winner-medal">${medals[i] || '—'}</span>
      <span class="sorteo-winner-nick">${_h(w.nick)}</span>
    </div>
  `).join('');
  wrap.classList.remove('hidden');
  if (cleanBtn) cleanBtn.textContent = 'Guardar ganadores y limpiar';
  _updateSorteoResultsEmpty();
  _updateSorteoWinnersBadge();
}

function _updateSorteoResultsEmpty() {
  const winnersEmpty = document.getElementById('sorteoResultsEmpty');
  if (winnersEmpty) {
    const winnersVisible = !document.getElementById('sorteoWinnersWrap')?.classList.contains('hidden');
    winnersEmpty.classList.toggle('hidden', winnersVisible);
  }
  const histEmpty = document.getElementById('sorteoHistorialEmpty');
  if (histEmpty) {
    const historyVisible = !document.getElementById('sorteoHistorialWrap')?.classList.contains('hidden');
    histEmpty.classList.toggle('hidden', historyVisible);
  }
}

function _addWinnerFromWheel(part) {
  const normalized = _normalizeSorteoPart(part);
  if (!normalized.nick) return false;
  const key = _nickKey(normalized.nick);
  if (!Array.isArray(sorteoCurrentWinners)) sorteoCurrentWinners = [];
  const exists = sorteoCurrentWinners.some(w => _nickKey(w.nick) === key);
  if (exists) return false;
  sorteoCurrentWinners.push(normalized);
  _renderSorteoWinners();
  return true;
}

async function loadSorteo() {
  try {
    initSorteoWheel();

    const st = await api.sorteoGetState();
    if (st?.ok) {
      sorteoActivo = !!st.activo;
      const cmdEl = document.getElementById('sorteoCmd');
      if (cmdEl) cmdEl.value = st.cmd || '!sorteo';
      _setSorteoUiState();
    }

    const cmd = document.getElementById('sorteoCmd')?.value?.trim() || '!sorteo';
    _syncSorteoCmdLabel(cmd);
    await api.sorteoSetCmd(cmd);

    const res = await api.sorteoGetParticipantes();
    sorteoParticipantes = _sorteoArr(res)
      .map(_normalizeSorteoPart)
      .filter(p => !!p.nick);
    renderSorteoList();
    _sorteoWheelSyncFromParticipantes();
    _renderSorteoWinners();
    loadSorteoHistorial();
  } catch (e) {
    log('warn', 'Error cargando sorteo: ' + (e.message || e));
  }
}

function _syncSorteoCmdLabel(val) {
  const label = document.getElementById('sorteoCmdLabel');
  if (label) label.textContent = String(val || '').trim().toLowerCase() || '!sorteo';
}

function updateSorteoCmd(val) {
  const cmd = String(val || '').trim().toLowerCase() || '!sorteo';
  _syncSorteoCmdLabel(cmd);
  api.sorteoSetCmd(cmd);
}

// ── Modal helpers ────────────────────────────────────────────
function sorteoOpenModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.remove('hidden');
  document.addEventListener('keydown', _sorteoModalEscClose);
}
function sorteoCloseModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.add('hidden');
  document.removeEventListener('keydown', _sorteoModalEscClose);
}
function _sorteoModalEscClose(e) {
  if (e.key !== 'Escape') return;
  ['sorteoOptionsModal','sorteoWinnersModal','sorteoHistorialModal'].forEach(id => {
    const m = document.getElementById(id);
    if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
  });
}
function sorteoOpenOptions() { sorteoOpenModal('sorteoOptionsModal'); }
function sorteoOpenWinners() { sorteoOpenModal('sorteoWinnersModal'); }
function sorteoOpenHistorial() {
  sorteoOpenModal('sorteoHistorialModal');
  loadSorteoHistorial();
}

function _updateSorteoWinnersBadge() {
  const badge = document.getElementById('sorteoWinnersBadge');
  if (!badge) return;
  const n = Array.isArray(sorteoCurrentWinners) ? sorteoCurrentWinners.length : 0;
  badge.textContent = String(n);
  badge.classList.toggle('is-zero', n === 0);
}

async function toggleSorteo() {
  const btn = document.getElementById('sorteoToggleBtn');
  if (btn) btn.disabled = true;
  try {
    const next = !sorteoActivo;
    const r = await api.sorteoToggle(next);
    if (r?.ok === false) throw new Error(r.error || 'No se pudo cambiar el estado');
    sorteoActivo = next;
    _setSorteoUiState();
  } catch (e) {
    toast('Error al cambiar estado del sorteo', 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function sorteoHandleManualKeydown(e) {
  if (!e) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    sorteoAddManualFromInput();
  }
}

async function sorteoAddManualFromInput() {
  if (sorteoWheelState.spinning) {
    toast('Esperá a que termine el giro para agregar manualmente', 'err');
    return;
  }

  const input = document.getElementById('sorteoManualInput');
  const btn = document.getElementById('sorteoManualAddBtn');
  const nicks = _sorteoParseManualNicks(input?.value || '');

  if (!nicks.length) {
    toast('Escribí al menos un nick válido', 'err');
    if (input) input.focus();
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const r = await api.sorteoAddParticipantes({ participantes: nicks });
    if (r?.ok === false) throw new Error(r.error || 'No se pudieron agregar participantes');

    const addedRows = _sorteoArr(r?.data)
      .map(_normalizeSorteoPart)
      .filter(p => !!p.nick);

    if (addedRows.length) {
      addedRows.forEach(p => addSorteoParticipante(p));
    } else if ((Number(r?.added) || 0) > 0) {
      const res = await api.sorteoGetParticipantes();
      sorteoParticipantes = _sorteoArr(res).map(_normalizeSorteoPart).filter(p => !!p.nick);
      renderSorteoList();
      _sorteoWheelSyncFromParticipantes();
    }

    if (input) input.value = '';

    const added = Number(r?.added ?? addedRows.length);
    const duplicates = Number(r?.duplicates ?? Math.max(0, nicks.length - added));
    if (added > 0 && duplicates > 0) {
      toast(`Agregados ${added} · repetidos omitidos ${duplicates}`, 'ok');
    } else if (added > 0) {
      toast(`Agregados ${added} participante(s)`, 'ok');
    } else {
      toast('No se agregó nadie: todos ya estaban en la lista', 'err');
    }
    if (added > 0 && input) input.blur();
  } catch (e) {
    toast('Error al agregar participantes manuales', 'err');
    log('warn', 'Sorteo manual: ' + (e.message || e));
  } finally {
    if (btn) btn.disabled = !!sorteoWheelState.spinning;
    if (input) input.disabled = !!sorteoWheelState.spinning;
  }
}

function addSorteoParticipante({ nick, joined_at }) {
  const part = _normalizeSorteoPart({ nick, joined_at });
  if (!part.nick) return;
  if (!Array.isArray(sorteoParticipantes)) sorteoParticipantes = [];
  const exists = sorteoParticipantes.find(p => _nickKey(p.nick) === _nickKey(part.nick));
  if (exists) return;
  sorteoParticipantes.push(part);
  renderSorteoList();
  _sorteoWheelAddLiveParticipante(part);
}

function renderSorteoList() {
  if (!Array.isArray(sorteoParticipantes)) sorteoParticipantes = [];
  const list = document.getElementById('sorteoPartList');
  const count = sorteoParticipantes.length;
  const partCount = document.getElementById('sorteoPartCount');
  const badge = document.getElementById('sorteoBadge');
  const sortearBtn = document.getElementById('sortearBtn');

  if (partCount) partCount.textContent = count;
  if (badge) badge.textContent = count;
  if (sortearBtn) sortearBtn.disabled = count === 0;
  if (!list) return;
  list.classList.toggle('is-empty', count === 0);

  if (!count) {
    list.innerHTML = '<div class="sorteo-empty"><div class="empty-ico"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12v10H4V12"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg></div><p>Abrí el sorteo · la gente escribe el comando para entrar</p></div>';
    return;
  }

  list.innerHTML = sorteoParticipantes.map((p, i) => {
    const t = new Date(p.joined_at || p.created_at || Date.now());
    const time = t.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div class="sorteo-part-row">
      <span class="sorteo-part-num">${i + 1}</span>
      <span class="sorteo-part-nick">${_h(p.nick)}</span>
      <span class="sorteo-part-time">${time}</span>
    </div>`;
  }).join('');

  const q = document.getElementById('sorteoSearch')?.value || '';
  if (q) filterSorteoList(q);
}

function filterSorteoList(query) {
  const rows = document.querySelectorAll('#sorteoPartList .sorteo-part-row');
  const term = String(query || '').toLowerCase().trim();
  rows.forEach(row => {
    const nick = row.querySelector('.sorteo-part-nick')?.textContent?.toLowerCase() || '';
    row.style.display = (!term || nick.includes(term)) ? '' : 'none';
  });
}

function sortear() {
  if (sorteoWheelState.spinning) {
    toast('Esperá a que termine el giro de la ruleta', 'err');
    return;
  }
  if (!sorteoParticipantes.length) return;
  const n = Math.min(sorteoWinCount, sorteoParticipantes.length);
  const pool = [...sorteoParticipantes];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(_sorteoWheelRand() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  sorteoCurrentWinners = pool.slice(0, n);
  _renderSorteoWinners();
}

function limpiarSorteo() {
  if (sorteoWheelState.spinning) {
    toast('No se puede limpiar mientras la ruleta está girando', 'err');
    return;
  }
  const tieneGanadores = sorteoCurrentWinners.length > 0;
  const msg = tieneGanadores
    ? 'Se guardarán los ganadores actuales y se vaciará la lista.'
    : 'Se vaciará la lista de participantes.';
  showModal(
    'Limpiar sorteo',
    `<div style="font-size:12px;color:var(--text2);line-height:1.7">${msg}<br><span style="color:#f87171">Esta acción no se puede deshacer.</span></div>` +
    '<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doLimpiarSorteo()">Sí, limpiar</button>'
  );
}

async function _doLimpiarSorteo() {
  try {
    const r = await api.sorteoGuardarYLimpiar({
      ganadores: sorteoCurrentWinners.map(w => w.nick),
      total: sorteoParticipantes.length
    });
    if (r?.ok === false) throw new Error(r.error || 'No se pudo limpiar');
    sorteoParticipantes = [];
    sorteoCurrentWinners = [];
    renderSorteoList();
    _renderSorteoWinners();
    _sorteoWheelResetState({ reseedFromParticipantes: false, clearExcluded: true });
    const badge = document.getElementById('sorteoBadge');
    if (badge) badge.textContent = '0';
    loadSorteoHistorial();
  } catch (e) {
    toast('Error al limpiar sorteo', 'err');
  }
}

async function loadSorteoHistorial() {
  try {
    const res = await api.sorteoGetHistorial();
    renderSorteoHistorial(_sorteoArr(res));
  } catch (e) {
    log('warn', 'Error cargando historial de sorteos');
  }
}

function renderSorteoHistorial(registros) {
  const wrap = document.getElementById('sorteoHistorialWrap');
  const body = document.getElementById('sorteoHistorialBody');
  if (!wrap || !body) return;
  if (!registros.length) {
    wrap.classList.add('hidden');
    _updateSorteoResultsEmpty();
    return;
  }
  wrap.classList.remove('hidden');
  const medals = ['1°', '2°', '3°', '4°'];
  body.innerHTML = registros.map(r => {
    const fecha = new Date(r.fecha);
    const fechaStr = fecha.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const horaStr = fecha.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    const gans = (r.ganadores || []).map((g, i) => `<span style="color:var(--gold);font-weight:700">${medals[i] || '—'} ${_h(g)}</span>`).join('  ');
    return `<tr>
      <td style="color:var(--text2)">${fechaStr}</td>
      <td style="color:var(--text3);font-size:11px">${horaStr}</td>
      <td>${gans}</td>
      <td style="color:var(--text3);text-align:center">${r.total || '—'}</td>
    </tr>`;
  }).join('');
  _updateSorteoResultsEmpty();
}

function sorteoWheelHandleDurationInput(raw) {
  const clamped = _sorteoWheelClampDuration(raw);
  sorteoWheelState.durationSec = clamped;
  const input = document.getElementById('sorteoWheelDuration');
  if (input && input.value !== String(clamped)) input.value = String(clamped);
}

function sorteoWheelSync() {
  if (sorteoWheelState.spinning) return;
  const added = _sorteoWheelSyncFromParticipantes();
  if (added > 0) toast(`Ruleta sincronizada: +${added}`, 'ok');
  else toast('La ruleta ya estaba al día', 'ok');
}

function sorteoWheelReseed() {
  if (sorteoWheelState.spinning) return;
  const added = _sorteoWheelSyncFromParticipantes({ replace: true, clearExcluded: true });
  sorteoWheelState.lastWinner = null;
  sorteoWheelState.lastWinnerKey = '';
  sorteoWheelState.rotation = 0;
  _sorteoWheelRenderAll();
  toast(`Ruleta recargada con ${sorteoWheelState.entries.length} participantes`, added ? 'ok' : 'err');
}

function sorteoWheelReset() {
  if (sorteoWheelState.spinning) return;
  showModal(
    'Reiniciar ruleta',
    '<div style="font-size:12px;color:var(--text2);line-height:1.7">Se reiniciará la ruleta y se volverán a cargar todos los participantes actuales.<br><span style="color:#f87171">Se limpia la exclusión de ganadores previos.</span></div>' +
    '<button class="btn btn-danger" style="width:100%;margin-top:14px" onclick="closeModal();_doSorteoWheelReset()">Sí, reiniciar</button>'
  );
}

function _doSorteoWheelReset() {
  _sorteoWheelResetState({ reseedFromParticipantes: true, clearExcluded: true });
  toast(`Ruleta reiniciada (${sorteoWheelState.entries.length} en rueda)`, 'ok');
}

function sorteoWheelRemoveEntry(index) {
  if (sorteoWheelState.spinning) return;
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= sorteoWheelState.entries.length) return;
  const [removed] = sorteoWheelState.entries.splice(idx, 1);
  if (removed?.key) sorteoWheelState.excludedKeys.add(removed.key);
  if (!sorteoWheelState.entries.length) sorteoWheelState.rotation = 0;
  _sorteoWheelRenderAll();
}

function _sorteoWheelStartSpin(targetIndex, durationSec) {
  const count = sorteoWheelState.entries.length;
  if (!count) return;

  sorteoWheelCloseWinner(true);
  _sorteoWheelStopSpin();
  sorteoWheelState.spinning = true;
  _sorteoWheelEnterFocus();

  const arc = SORTEO_TAU / count;
  const jitter = (arc * 0.44) * (_sorteoWheelRand() - 0.5);
  const targetOnWheel = -(targetIndex * arc + arc / 2 + jitter);
  const extraTurns = SORTEO_WHEEL_BASE_SPINS + _sorteoWheelRandInt(6);
  const current = sorteoWheelState.rotation;
  const delta = _sorteoWheelPosMod(targetOnWheel - current, SORTEO_TAU) + extraTurns * SORTEO_TAU;

  sorteoWheelState.spinMeta = {
    startTs: 0,
    startRotation: current,
    delta,
    durationMs: durationSec * 1000,
    targetIndex,
  };

  sorteoWheelState.lastTickIndex = _sorteoWheelIndexAtPointer(current, count);
  sorteoWheelState.lastTickMs = 0;
  _sorteoWheelGetAudioCtx();
  _sorteoWheelPlayWhoosh(durationSec);

  _sorteoWheelUpdateControls();
  _sorteoWheelDraw();
  sorteoWheelState.spinRaf = requestAnimationFrame(_sorteoWheelSpinTick);
}

function _sorteoWheelSpinTick(ts) {
  const spin = sorteoWheelState.spinMeta;
  if (!spin) return;
  if (!spin.startTs) spin.startTs = ts;

  const elapsed = ts - spin.startTs;
  const progress = Math.min(1, elapsed / spin.durationMs);
  const eased = 1 - Math.pow(1 - progress, 4);
  sorteoWheelState.rotation = spin.startRotation + spin.delta * eased;

  const count = sorteoWheelState.entries.length;
  if (count > 1) {
    const tickIdx = _sorteoWheelIndexAtPointer(sorteoWheelState.rotation, count);
    if (tickIdx !== sorteoWheelState.lastTickIndex) {
      sorteoWheelState.lastTickIndex = tickIdx;
      _sorteoWheelPlayTick(progress);
    }
  }

  _sorteoWheelDraw();

  if (progress < 1) {
    sorteoWheelState.spinRaf = requestAnimationFrame(_sorteoWheelSpinTick);
    return;
  }

  _sorteoWheelFinishSpin();
}

function _sorteoWheelFinishSpin() {
  const count = sorteoWheelState.entries.length;
  const spin = sorteoWheelState.spinMeta;
  _sorteoWheelStopSpin();
  if (!count || !spin) {
    _sorteoWheelRenderAll();
    return;
  }

  const finalIdx = _sorteoWheelIndexAtPointer(sorteoWheelState.rotation, count);
  const winner = sorteoWheelState.entries[finalIdx] || sorteoWheelState.entries[spin.targetIndex];
  if (!winner) {
    _sorteoWheelRenderAll();
    return;
  }

  sorteoWheelState.lastWinner = winner;
  sorteoWheelState.lastWinnerKey = winner.key;
  const addedToWinners = _addWinnerFromWheel(winner);

  sorteoWheelState.autoRemoveWinner = !!document.getElementById('sorteoWheelAutoRemove')?.checked;
  if (sorteoWheelState.autoRemoveWinner) {
    sorteoWheelState.excludedKeys.add(winner.key);
    const idx = sorteoWheelState.entries.findIndex(e => e.key === winner.key);
    if (idx >= 0) sorteoWheelState.entries.splice(idx, 1);
    if (!sorteoWheelState.entries.length) sorteoWheelState.rotation = 0;
  }

  _sorteoWheelRenderAll();
  if (sorteoWheelState.pendingSync) {
    sorteoWheelState.pendingSync = false;
    _sorteoWheelSyncFromParticipantes();
  }
  _sorteoWheelPlayWinnerSfx();
  if (addedToWinners) toast(`Ganador por ruleta: ${winner.nick}`, 'ok');
  else toast(`Salió ${winner.nick} (ya estaba como ganador)`, 'ok');
  _sorteoWheelOpenWinner(winner.nick);
}

function sorteoWheelSpin() {
  if (sorteoWheelState.spinning) return;
  if (!sorteoWheelState.entries.length) {
    toast('No hay participantes en la ruleta', 'err');
    return;
  }

  const durationInput = document.getElementById('sorteoWheelDuration');
  const durationSec = _sorteoWheelClampDuration(durationInput?.value);
  sorteoWheelState.durationSec = durationSec;
  if (durationInput && durationInput.value !== String(durationSec)) {
    durationInput.value = String(durationSec);
  }

  const winnerIndex = _sorteoWheelRandInt(sorteoWheelState.entries.length);
  _sorteoWheelStartSpin(winnerIndex, durationSec);
}

function sorteoWheelSpinAgain() {
  sorteoWheelCloseWinner();
  if (!sorteoWheelState.entries.length) {
    toast('No quedan participantes en la ruleta', 'err');
    return;
  }
  setTimeout(() => sorteoWheelSpin(), 90);
}

function _sorteoWheelResizeConfettiCanvas() {
  if (!sorteoWheelState.overlayCanvas || !sorteoWheelState.overlayCtx) return null;
  return _sorteoWheelEnsureCanvasSize(sorteoWheelState.overlayCanvas, sorteoWheelState.overlayCtx);
}

function _sorteoWheelSpawnConfettiBurst(amount) {
  const d = _sorteoWheelResizeConfettiCanvas();
  if (!d) return;
  const cx = d.w / 2;
  const cy = d.h * 0.38;

  for (let i = 0; i < amount; i++) {
    const angle = (-Math.PI / 2) + (_sorteoWheelRand() - 0.5) * (Math.PI * 1.4);
    const speed = 220 + _sorteoWheelRand() * 560;
    const ttl = 2.2 + _sorteoWheelRand() * 2.2;
    const size = 5 + _sorteoWheelRand() * 8;
    sorteoWheelState.confettiPieces.push({
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      gravity: 520 + _sorteoWheelRand() * 260,
      drag: 0.985 + _sorteoWheelRand() * 0.012,
      rot: _sorteoWheelRand() * SORTEO_TAU,
      vr: (_sorteoWheelRand() - 0.5) * 11,
      life: 0,
      ttl,
      size,
      color: SORTEO_CONFETTI_COLORS[_sorteoWheelRandInt(SORTEO_CONFETTI_COLORS.length)],
      flip: _sorteoWheelRand() * SORTEO_TAU,
      flipSpeed: 7 + _sorteoWheelRand() * 7,
    });
  }
}

function _sorteoWheelStopConfetti() {
  if (sorteoWheelState.confettiRaf) {
    cancelAnimationFrame(sorteoWheelState.confettiRaf);
    sorteoWheelState.confettiRaf = 0;
  }
  sorteoWheelState.confettiPieces = [];
  sorteoWheelState.confettiStartTs = 0;
  sorteoWheelState.confettiPrevTs = 0;
  sorteoWheelState.confettiNextBurstTs = 0;
  if (sorteoWheelState.overlayCtx && sorteoWheelState.overlayCanvas) {
    const d = _sorteoWheelResizeConfettiCanvas();
    if (d) sorteoWheelState.overlayCtx.clearRect(0, 0, d.w, d.h);
  }
}

function _sorteoWheelConfettiTick(ts) {
  const overlay = document.getElementById('sorteoWheelWinnerOverlay');
  if (!sorteoWheelState.overlayVisible || !overlay || getComputedStyle(overlay).display === 'none') {
    _sorteoWheelStopConfetti();
    return;
  }

  const d = _sorteoWheelResizeConfettiCanvas();
  const ctx = sorteoWheelState.overlayCtx;
  if (!d || !ctx) return;

  if (!sorteoWheelState.confettiStartTs) {
    sorteoWheelState.confettiStartTs = ts;
    sorteoWheelState.confettiPrevTs = ts;
    sorteoWheelState.confettiNextBurstTs = ts;
    _sorteoWheelSpawnConfettiBurst(180);
  }

  const elapsed = ts - sorteoWheelState.confettiStartTs;
  if (ts >= sorteoWheelState.confettiNextBurstTs && elapsed < 2600) {
    const burst = elapsed < 900 ? 120 : 80;
    _sorteoWheelSpawnConfettiBurst(burst);
    sorteoWheelState.confettiNextBurstTs = ts + 260;
  }

  const dt = Math.min(0.034, Math.max(0.008, (ts - sorteoWheelState.confettiPrevTs) / 1000));
  sorteoWheelState.confettiPrevTs = ts;

  ctx.clearRect(0, 0, d.w, d.h);
  for (let i = sorteoWheelState.confettiPieces.length - 1; i >= 0; i--) {
    const p = sorteoWheelState.confettiPieces[i];
    p.life += dt;
    p.vx *= p.drag;
    p.vy += p.gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.flip += p.flipSpeed * dt;

    const alpha = Math.max(0, 1 - (p.life / p.ttl));
    if (alpha <= 0 || p.y > d.h + 40) {
      sorteoWheelState.confettiPieces.splice(i, 1);
      continue;
    }

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.scale(1, Math.cos(p.flip));
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
    ctx.restore();
  }

  const keepRunning = elapsed < 7200 || sorteoWheelState.confettiPieces.length > 0;
  if (keepRunning) {
    sorteoWheelState.confettiRaf = requestAnimationFrame(_sorteoWheelConfettiTick);
  } else {
    sorteoWheelState.confettiRaf = 0;
  }
}

function _sorteoWheelStartConfetti() {
  _sorteoWheelStopConfetti();
  sorteoWheelState.confettiRaf = requestAnimationFrame(_sorteoWheelConfettiTick);
}

function _sorteoWheelOpenWinner(nick) {
  const overlay = document.getElementById('sorteoWheelWinnerOverlay');
  const name = document.getElementById('sorteoWheelOverlayName');
  if (!overlay || !name) return;
  name.textContent = nick || '—';
  overlay.classList.remove('hidden');
  sorteoWheelState.overlayVisible = true;
  _sorteoWheelStartConfetti();
}

function sorteoWheelCloseWinner(silent) {
  const overlay = document.getElementById('sorteoWheelWinnerOverlay');
  if (overlay) overlay.classList.add('hidden');
  sorteoWheelState.overlayVisible = false;
  _sorteoWheelStopConfetti();
  if (!silent) _sorteoWheelDraw();
}
