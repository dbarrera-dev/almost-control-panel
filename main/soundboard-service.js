const { globalShortcut, app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_SOUND_NAME_LEN = 80;
const MIN_HOTKEY_COOLDOWN_MS = 120;
const SUPABASE_OP_TIMEOUT_MS = 25000;
const SOUNDBOARD_BUCKET_DEFAULT = 'soundboard';
const SOUNDBOARD_PATH_PREFIX = 'sounds';
const ALLOWED_MIME_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/flac',
  'audio/x-flac',
]);

function createSoundboardService({ loadConfig, saveConfig, saveLog, state, getMainWindow }) {
  let soundsCache = [];
  let cacheLoaded = false;
  let cacheLoading = null;

  const registeredHotkeys = new Set();
  const hotkeyErrors = new Map(); // soundId -> reason
  const soundByHotkey = new Map();
  const lastFiredAt = new Map();

  function log(type, msg) {
    try { saveLog(type, msg); } catch {}
  }

  function logOpError(context, errorLike) {
    const msg = typeof errorLike === 'string'
      ? errorLike
      : (errorLike?.message || errorLike?.error || String(errorLike || 'Error desconocido'));
    log('warn', `[Soundboard] ${context}: ${msg}`);
  }

  async function withTimeout(promise, ms, context) {
    let timer = null;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout en ${context} (${ms}ms)`)), ms);
      });
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function getStorageMode() {
    return 'supabase';
  }

  function setStorageMode() {
    const next = 'supabase';
    const cfg = loadConfig();
    cfg.soundboardStorageMode = next;
    saveConfig(cfg);
    return next;
  }

  function areHotkeysEnabled() {
    const cfg = loadConfig();
    return cfg.soundboardHotkeysEnabled !== false;
  }

  function setHotkeysEnabled(enabled) {
    const cfg = loadConfig();
    cfg.soundboardHotkeysEnabled = !!enabled;
    saveConfig(cfg);
  }

  function normalizeName(name) {
    const raw = String(name || '').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    return raw.slice(0, MAX_SOUND_NAME_LEN);
  }

  function normalizeMimeType(mimeType) {
    return String(mimeType || '').trim().toLowerCase();
  }

  function mimeFromExt(ext) {
    const e = String(ext || '').trim().toLowerCase();
    const map = {
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'audio/ogg',
      '.webm': 'audio/webm',
      '.m4a': 'audio/mp4',
      '.mp4': 'audio/mp4',
      '.aac': 'audio/aac',
      '.flac': 'audio/flac',
    };
    return map[e] || '';
  }

  function resolveMimeType({ mimeType, originalName, sourceFilePath }) {
    const direct = normalizeMimeType(mimeType);
    if (isAllowedMimeType(direct)) return direct;

    const fromPath = mimeFromExt(path.extname(String(sourceFilePath || '')));
    if (isAllowedMimeType(fromPath)) return fromPath;

    const fromName = mimeFromExt(path.extname(String(originalName || '')));
    if (isAllowedMimeType(fromName)) return fromName;

    return direct || '';
  }

  function isAllowedMimeType(mimeType) {
    return ALLOWED_MIME_TYPES.has(normalizeMimeType(mimeType));
  }

  function normalizeVolume(volume) {
    const n = Number(volume);
    if (!Number.isFinite(n)) return 100;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function normalizeEnabled(enabled) {
    return enabled !== false;
  }

  function normalizeAudioBase64(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    return raw.replace(/^data:[^;]+;base64,/i, '').replace(/\s+/g, '');
  }

  function normalizeStoragePath(value, bucketName = '') {
    let raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\s+/g, ' ');
    if (!raw) return '';
    const bucket = String(bucketName || getSoundboardBucket()).trim();
    if (raw.toLowerCase().startsWith(`${bucket.toLowerCase()}/`)) {
      raw = raw.slice(bucket.length + 1);
    }
    return raw;
  }

  function joinObjectPath(id, mimeType, originalName, sourceFilePath) {
    const ext = extFromMimeOrName(mimeType, originalName, sourceFilePath);
    return `${SOUNDBOARD_PATH_PREFIX}/${id}${ext}`;
  }

  function getSoundboardBucket() {
    const cfg = loadConfig();
    const raw = String(cfg.soundboardBucket || '').trim();
    if (!raw) return SOUNDBOARD_BUCKET_DEFAULT;
    return raw;
  }

  function getBase64SizeBytes(base64) {
    if (!base64) return 0;
    try {
      return Buffer.byteLength(base64, 'base64');
    } catch {
      return 0;
    }
  }

  function normalizeHotkey(input) {
    const raw = String(input || '').trim();
    if (!raw) return '';

    const modifierMap = {
      commandorcontrol: 'CommandOrControl',
      cmdorctrl: 'CommandOrControl',
      command: 'Command',
      cmd: 'Command',
      control: 'Ctrl',
      ctrl: 'Ctrl',
      alt: 'Alt',
      option: 'Alt',
      shift: 'Shift',
      super: 'Super',
      meta: 'Super',
    };

    const keyMap = {
      space: 'Space',
      enter: 'Return',
      return: 'Return',
      tab: 'Tab',
      escape: 'Escape',
      esc: 'Escape',
      backspace: 'Backspace',
      delete: 'Delete',
      del: 'Delete',
      insert: 'Insert',
      ins: 'Insert',
      home: 'Home',
      end: 'End',
      pageup: 'PageUp',
      pagedown: 'PageDown',
      up: 'Up',
      down: 'Down',
      left: 'Left',
      right: 'Right',
      plus: 'Plus',
      numlock: 'Numlock',
      capslock: 'Capslock',
      scrolllock: 'Scrolllock',
      mediaplaypause: 'MediaPlayPause',
      medianexttrack: 'MediaNextTrack',
      mediaprevioustrack: 'MediaPreviousTrack',
      mediastop: 'MediaStop',
      volumemute: 'VolumeMute',
      volumeup: 'VolumeUp',
      volumedown: 'VolumeDown',
      printscreen: 'PrintScreen',
    };

    const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return '';

    const mods = [];
    let key = '';

    for (const part of parts) {
      const lower = part.toLowerCase();
      if (modifierMap[lower]) {
        const mod = modifierMap[lower];
        if (!mods.includes(mod)) mods.push(mod);
        continue;
      }

      const mapped = keyMap[lower] || part;
      if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(mapped)) {
        key = mapped.toUpperCase();
        continue;
      }
      if (/^[a-z0-9]$/i.test(mapped)) {
        key = mapped.toUpperCase();
        continue;
      }
      if (/^num[0-9]$/i.test(mapped)) {
        key = mapped.toLowerCase();
        continue;
      }
      if (/^(numdec|numadd|numsub|nummult)$/i.test(mapped)) {
        key = mapped.toLowerCase();
        continue;
      }
      if (keyMap[lower]) {
        key = keyMap[lower];
        continue;
      }
      return '';
    }

    if (!key) return '';
    if (!mods.length) {
      const safeWithoutMods = /^F([1-9]|1[0-9]|2[0-4])$/.test(key) || /^(Media|Volume)/.test(key);
      if (!safeWithoutMods) return '';
    }

    const modOrder = ['CommandOrControl', 'Command', 'Ctrl', 'Alt', 'Shift', 'Super'];
    mods.sort((a, b) => modOrder.indexOf(a) - modOrder.indexOf(b));

    return [...mods, key].join('+');
  }

  function getLocalBaseDir() {
    return path.join(app.getPath('userData'), 'soundboard');
  }

  function getLocalAudioDir() {
    return path.join(getLocalBaseDir(), 'audio');
  }

  function getLocalIndexPath() {
    return path.join(getLocalBaseDir(), 'index.json');
  }

  function ensureLocalStoreReady() {
    try {
      fs.mkdirSync(getLocalAudioDir(), { recursive: true });
      if (!fs.existsSync(getLocalIndexPath())) {
        fs.writeFileSync(getLocalIndexPath(), JSON.stringify({ version: 1, sounds: [] }, null, 2), 'utf8');
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || 'No se pudo inicializar almacenamiento local.' };
    }
  }

  function readLocalIndex() {
    const ready = ensureLocalStoreReady();
    if (!ready.ok) return ready;
    try {
      const raw = JSON.parse(fs.readFileSync(getLocalIndexPath(), 'utf8'));
      const sounds = Array.isArray(raw?.sounds) ? raw.sounds : [];
      return { ok: true, sounds };
    } catch (err) {
      return { ok: false, error: err?.message || 'No se pudo leer índice local.' };
    }
  }

  function writeLocalIndex(sounds) {
    const ready = ensureLocalStoreReady();
    if (!ready.ok) return ready;
    try {
      fs.writeFileSync(getLocalIndexPath(), JSON.stringify({ version: 1, sounds }, null, 2), 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || 'No se pudo guardar índice local.' };
    }
  }

  function extFromMimeOrName(mimeType, originalName, sourceFilePath) {
    const mime = resolveMimeType({ mimeType, originalName, sourceFilePath });
    const map = {
      'audio/mpeg': '.mp3',
      'audio/mp3': '.mp3',
      'audio/wav': '.wav',
      'audio/x-wav': '.wav',
      'audio/ogg': '.ogg',
      'audio/webm': '.webm',
      'audio/mp4': '.m4a',
      'audio/aac': '.aac',
      'audio/flac': '.flac',
      'audio/x-flac': '.flac',
    };
    if (map[mime]) return map[mime];
    const ext =
      path.extname(String(sourceFilePath || '')).toLowerCase() ||
      path.extname(String(originalName || '')).toLowerCase();
    if (ext && ext.length <= 10) return ext;
    return '.bin';
  }

  function uuid() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function safeFileName(id, mimeType, originalName, sourceFilePath) {
    const ext = extFromMimeOrName(mimeType, originalName, sourceFilePath);
    return `${id}${ext}`;
  }

  function writeLocalAudioFile({ id, mimeType, originalName, audioBase64, sourceFilePath = '' }) {
    const ready = ensureLocalStoreReady();
    if (!ready.ok) return ready;

    const clean = normalizeAudioBase64(audioBase64);
    if (!clean) return { ok: false, error: 'Audio inválido.' };

    let buf = null;
    try {
      buf = Buffer.from(clean, 'base64');
    } catch {
      return { ok: false, error: 'No se pudo decodificar audio.' };
    }

    if (!buf || !buf.length) return { ok: false, error: 'Audio vacío.' };

    const fileName = safeFileName(id, mimeType, originalName, sourceFilePath);
    const filePath = path.join(getLocalAudioDir(), fileName);

    try {
      fs.writeFileSync(filePath, buf);
      return { ok: true, fileName, filePath, sizeBytes: buf.length };
    } catch (err) {
      return { ok: false, error: err?.message || 'No se pudo guardar archivo local.' };
    }
  }

  async function copyLocalAudioFileFromPath({ id, mimeType, originalName, sourceFilePath }) {
    const ready = ensureLocalStoreReady();
    if (!ready.ok) return ready;

    const src = String(sourceFilePath || '').trim();
    if (!src) return { ok: false, error: 'Ruta de archivo local inválida.' };
    if (!fs.existsSync(src)) return { ok: false, error: 'El archivo seleccionado no existe.' };

    let stats = null;
    try {
      stats = fs.statSync(src);
    } catch (err) {
      return { ok: false, error: err?.message || 'No se pudo leer el archivo seleccionado.' };
    }
    if (!stats?.isFile?.()) return { ok: false, error: 'La ruta seleccionada no es un archivo.' };

    const fileName = safeFileName(id, mimeType, originalName, src);
    const filePath = path.join(getLocalAudioDir(), fileName);
    try {
      await fs.promises.copyFile(src, filePath);
      return { ok: true, fileName, filePath, sizeBytes: Math.max(0, Number(stats.size || 0)) };
    } catch (err) {
      return { ok: false, error: err?.message || 'No se pudo copiar el archivo al almacenamiento local.' };
    }
  }

  function deleteLocalAudioFile(fileName) {
    if (!fileName) return;
    try {
      const filePath = path.join(getLocalAudioDir(), fileName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }

  function localRowToCache(row) {
    const fileName = String(row?.fileName || '');
    return {
      id: String(row.id || ''),
      name: normalizeName(row.name),
      originalName: String(row.originalName || ''),
      mimeType: normalizeMimeType(row.mimeType) || 'audio/mpeg',
      audioBase64: '',
      fileName,
      filePath: fileName ? path.join(getLocalAudioDir(), fileName) : '',
      sizeBytes: Math.max(0, Number(row.sizeBytes || 0) || 0),
      hotkey: normalizeHotkey(row.hotkey),
      volume: normalizeVolume(row.volume),
      enabled: normalizeEnabled(row.enabled),
      createdAt: row.createdAt || null,
      updatedAt: row.updatedAt || null,
      storage: 'local',
      storageBucket: '',
      storagePath: '',
    };
  }

  function rowToCache(row) {
    const storageBucket = String(row.storage_bucket || getSoundboardBucket());
    const storagePath = normalizeStoragePath(row.storage_path || '', storageBucket);
    return {
      id: String(row.id),
      name: normalizeName(row.name),
      originalName: String(row.original_name || ''),
      mimeType: normalizeMimeType(row.mime_type) || 'audio/mpeg',
      audioBase64: normalizeAudioBase64(row.audio_base64),
      fileName: '',
      filePath: '',
      sizeBytes: Math.max(0, Number(row.size_bytes || 0) || 0),
      hotkey: normalizeHotkey(row.hotkey),
      volume: normalizeVolume(row.volume),
      enabled: normalizeEnabled(row.enabled),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      storage: 'supabase',
      storageBucket,
      storagePath,
    };
  }

  function toUiSound(sound) {
    const hk = sound.hotkey;
    const err = hotkeyErrors.get(sound.id) || '';
    return {
      id: sound.id,
      name: sound.name,
      originalName: sound.originalName,
      mimeType: sound.mimeType,
      sizeBytes: sound.sizeBytes,
      hotkey: sound.hotkey,
      volume: sound.volume,
      enabled: sound.enabled,
      createdAt: sound.createdAt,
      updatedAt: sound.updatedAt,
      storage: sound.storage,
      storageBucket: sound.storageBucket || '',
      storagePath: sound.storagePath || '',
      hotkeyRegistered: hk ? registeredHotkeys.has(hk) : false,
      hotkeyError: err,
    };
  }

  function getSupabase() {
    return state.supabase || null;
  }

  async function loadSupabaseCache() {
    const supabase = getSupabase();
    if (!supabase) {
      const res = { ok: false, error: 'Supabase no conectado.' };
      logOpError('load supabase', res.error);
      return res;
    }

    let data = null;
    let error = null;
    try {
      const res = await withTimeout(
        supabase
          .from('soundboard_sounds')
          .select('id,name,original_name,mime_type,audio_base64,storage_bucket,storage_path,size_bytes,hotkey,volume,enabled,created_at,updated_at')
          .order('created_at', { ascending: true }),
        SUPABASE_OP_TIMEOUT_MS,
        'carga de sonidos'
      );
      data = res?.data;
      error = res?.error || null;
    } catch (err) {
      const res = { ok: false, error: err?.message || 'Error consultando Supabase.' };
      logOpError('load supabase', res.error);
      return res;
    }

    if (error) {
      const message = String(error.message || '');
      if (message.toLowerCase().includes('storage_bucket') || message.toLowerCase().includes('storage_path')) {
        const res = { ok: false, error: 'Faltan columnas en soundboard_sounds: ejecutá la migración para agregar storage_bucket y storage_path.' };
        logOpError('load supabase', res.error);
        return res;
      }
      const msg = [error.message, error.code, error.details, error.hint].filter(Boolean).join(' | ');
      const res = { ok: false, error: msg || 'No se pudo cargar soundboard de Supabase.' };
      logOpError('load supabase', res.error);
      return res;
    }

    const rows = Array.isArray(data)
      ? data
          .map(rowToCache)
          .filter((s) => s.id && s.name && (s.storagePath || s.audioBase64))
      : [];
    return { ok: true, sounds: rows };
  }

  async function loadLocalCache() {
    const idx = readLocalIndex();
    if (!idx.ok) return idx;
    const rows = idx.sounds.map(localRowToCache).filter((s) => s.id && s.name);
    return { ok: true, sounds: rows };
  }

  async function loadCacheFromStorage() {
    return loadSupabaseCache();
  }

  async function loadCache({ force = false } = {}) {
    if (!force && cacheLoaded) return { ok: true, sounds: soundsCache };
    if (cacheLoading) return cacheLoading;

    cacheLoading = (async () => {
      const loaded = await loadCacheFromStorage();
      if (!loaded.ok) {
        soundsCache = [];
        cacheLoaded = false;
        return loaded;
      }
      soundsCache = loaded.sounds;
      cacheLoaded = true;
      return { ok: true, sounds: soundsCache };
    })();

    try {
      return await cacheLoading;
    } finally {
      cacheLoading = null;
    }
  }

  function clearRegisteredHotkeys() {
    for (const key of registeredHotkeys) {
      try { globalShortcut.unregister(key); } catch {}
    }
    registeredHotkeys.clear();
    soundByHotkey.clear();
  }

  function canFireSound(id) {
    const now = Date.now();
    const last = Number(lastFiredAt.get(id) || 0);
    if (now - last < MIN_HOTKEY_COOLDOWN_MS) return false;
    lastFiredAt.set(id, now);
    return true;
  }

  function readAudioBase64FromFile(filePath) {
    if (!filePath) return '';
    try {
      const buf = fs.readFileSync(filePath);
      if (!buf || !buf.length) return '';
      return buf.toString('base64');
    } catch {
      return '';
    }
  }

  function resolveAudioBase64(sound) {
    if (sound.audioBase64) return sound.audioBase64;
    if (sound.storage === 'local') return readAudioBase64FromFile(sound.filePath);
    return '';
  }

  async function downloadAudioBase64FromStorage(sound) {
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'Supabase no conectado.' };

    const bucket = String(sound?.storageBucket || getSoundboardBucket()).trim();
    const storagePath = normalizeStoragePath(sound?.storagePath || '', bucket);
    if (!bucket || !storagePath) return { ok: false, error: 'Ruta de storage inválida.' };

    let data = null;
    let error = null;
    try {
      const res = await withTimeout(
        supabase.storage.from(bucket).download(storagePath),
        SUPABASE_OP_TIMEOUT_MS,
        'descarga de audio desde bucket'
      );
      data = res?.data || null;
      error = res?.error || null;
    } catch (err) {
      return { ok: false, error: err?.message || 'Error descargando audio de Supabase Storage.' };
    }
    if (error) {
      const full = [error.message || 'No se pudo descargar el audio.', error.code, error.details, error.hint].filter(Boolean).join(' | ');
      return { ok: false, error: full };
    }
    if (!data) return { ok: false, error: 'Supabase devolvió un archivo vacío.' };

    try {
      const ab = await data.arrayBuffer();
      const buf = Buffer.from(ab);
      if (!buf.length) return { ok: false, error: 'El objeto en bucket está vacío.' };
      return { ok: true, base64: buf.toString('base64') };
    } catch (err) {
      return { ok: false, error: err?.message || 'No se pudo convertir el audio descargado.' };
    }
  }

  function emitPlaySound(sound, source = 'manual') {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { ok: false, error: 'Ventana principal no disponible.' };
    }

    win.webContents.send('soundboard-play', {
      id: sound.id,
      name: sound.name,
      mimeType: sound.mimeType,
      volume: sound.volume,
      source,
      ts: Date.now(),
    });

    return { ok: true };
  }

  async function playSoundById(id, source = 'manual') {
    const sid = String(id || '').trim();
    if (!sid) return { ok: false, error: 'Sonido inválido.' };

    const loadRes = await loadCache();
    if (!loadRes.ok) return loadRes;

    const sound = soundsCache.find((s) => s.id === sid && s.enabled);
    if (!sound) return { ok: false, error: 'El sonido no existe o está deshabilitado.' };

    if (!canFireSound(sid)) return { ok: true, throttled: true };

    const result = emitPlaySound(sound, source);
    if (result.ok) {
      log('info', `[Soundboard] Reproducido: ${sound.name} (${source})`);
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('soundboard-hotkey-fired', {
          id: sound.id,
          name: sound.name,
          hotkey: sound.hotkey,
          source,
          ts: Date.now(),
        });
      }
    }
    return result;
  }

  async function getAudioPayload(id) {
    const sid = String(id || '').trim();
    if (!sid) {
      const res = { ok: false, error: 'Sonido inválido.' };
      logOpError('get audio', res.error);
      return res;
    }

    const loadRes = await loadCache();
    if (!loadRes.ok) {
      logOpError('get audio', loadRes.error);
      return loadRes;
    }

    const sound = soundsCache.find((s) => s.id === sid);
    if (!sound) {
      const res = { ok: false, error: 'Sonido no encontrado.' };
      logOpError('get audio', res.error);
      return res;
    }
    let audioBase64 = '';
    if (sound.storagePath) {
      const downloaded = await downloadAudioBase64FromStorage(sound);
      if (!downloaded.ok) {
        logOpError('get audio', downloaded.error);
        return downloaded;
      }
      audioBase64 = downloaded.base64;
    } else {
      audioBase64 = resolveAudioBase64(sound);
    }
    if (!audioBase64) {
      const res = { ok: false, error: 'No se pudo leer el audio del sonido.' };
      logOpError('get audio', res.error);
      return res;
    }

    return {
      ok: true,
      payload: {
        id: sound.id,
        name: sound.name,
        mimeType: sound.mimeType,
        audioBase64,
        volume: sound.volume,
        updatedAt: sound.updatedAt || null,
      },
    };
  }

  async function registerHotkeysFromCache() {
    clearRegisteredHotkeys();
    hotkeyErrors.clear();

    if (!areHotkeysEnabled()) {
      return { ok: true, registered: 0, errors: [] };
    }

    const seen = new Set();
    let registered = 0;
    const errors = [];

    for (const sound of soundsCache) {
      if (!sound.enabled || !sound.hotkey) continue;

      const normalized = normalizeHotkey(sound.hotkey);
      if (!normalized) {
        hotkeyErrors.set(sound.id, 'invalido');
        errors.push({ soundId: sound.id, key: sound.hotkey, reason: 'invalido' });
        continue;
      }

      const keyLower = normalized.toLowerCase();
      if (seen.has(keyLower)) {
        hotkeyErrors.set(sound.id, 'duplicado');
        errors.push({ soundId: sound.id, key: normalized, reason: 'duplicado' });
        continue;
      }
      seen.add(keyLower);

      try {
        const ok = globalShortcut.register(normalized, () => {
          const sid = soundByHotkey.get(normalized);
          if (!sid) return;
          playSoundById(sid, 'hotkey').catch(() => {});
        });

        if (!ok) {
          hotkeyErrors.set(sound.id, 'en_uso');
          errors.push({ soundId: sound.id, key: normalized, reason: 'en_uso' });
          continue;
        }

        registeredHotkeys.add(normalized);
        soundByHotkey.set(normalized, sound.id);
        registered++;
      } catch (err) {
        const reason = err?.message || String(err) || 'error';
        hotkeyErrors.set(sound.id, reason);
        errors.push({ soundId: sound.id, key: normalized, reason });
      }
    }

    if (errors.length) {
      log('warn', `[Soundboard] Atajos con conflicto: ${errors.map((e) => `${e.key}(${e.reason})`).join(', ')}`);
    }

    return { ok: true, registered, errors };
  }

  async function refreshAndRegisterHotkeys({ force = false } = {}) {
    const loaded = await loadCache({ force });
    if (!loaded.ok) {
      clearRegisteredHotkeys();
      return loaded;
    }
    const reg = await registerHotkeysFromCache();
    return { ok: true, registered: reg.registered, errors: reg.errors, sounds: soundsCache.map(toUiSound) };
  }

  function getState() {
    return {
      ok: true,
      storageMode: getStorageMode(),
      soundboardBucket: getSoundboardBucket(),
      hotkeysEnabled: areHotkeysEnabled(),
      registeredHotkeys: Array.from(registeredHotkeys),
      sounds: soundsCache.map(toUiSound),
    };
  }

  function validateCreatePayload(payload) {
    const name = normalizeName(payload?.name);
    const originalName = String(payload?.originalName || '').slice(0, 255);
    const mimeType = resolveMimeType({
      mimeType: payload?.mimeType,
      originalName,
      sourceFilePath: payload?.sourceFilePath || payload?.storagePath,
    });
    const audioBase64 = normalizeAudioBase64(payload?.audioBase64);
    const hotkey = normalizeHotkey(payload?.hotkey);
    const volume = normalizeVolume(payload?.volume);
    const enabled = normalizeEnabled(payload?.enabled);
    const sizeBytes = getBase64SizeBytes(audioBase64);

    if (!name) return { ok: false, error: 'El nombre es obligatorio.' };
    if (!audioBase64) return { ok: false, error: 'No se recibió audio para subir.' };
    if (!isAllowedMimeType(mimeType)) return { ok: false, error: 'Formato no soportado. Usa mp3, wav, ogg, webm, m4a, aac o flac.' };
    if (!sizeBytes) return { ok: false, error: 'No se pudo procesar el audio.' };

    return {
      ok: true,
      value: { name, originalName, mimeType, audioBase64, hotkey, volume, enabled, sizeBytes },
    };
  }

  function validateUpdatePayload(payload) {
    const patch = {};

    if (payload?.name !== undefined) {
      const v = normalizeName(payload.name);
      if (!v) return { ok: false, error: 'El nombre no puede quedar vacío.' };
      patch.name = v;
    }

    if (payload?.hotkey !== undefined) {
      const v = normalizeHotkey(payload.hotkey);
      if (String(payload.hotkey || '').trim() && !v) {
        return { ok: false, error: 'Atajo inválido.' };
      }
      patch.hotkey = v;
    }

    if (payload?.volume !== undefined) patch.volume = normalizeVolume(payload.volume);
    if (payload?.enabled !== undefined) patch.enabled = normalizeEnabled(payload.enabled);

    if (payload?.audioBase64 !== undefined || payload?.mimeType !== undefined || payload?.originalName !== undefined || payload?.sourceFilePath !== undefined) {
      const mimeType = payload?.mimeType !== undefined
        ? resolveMimeType({
            mimeType: payload.mimeType,
            originalName: payload?.originalName,
            sourceFilePath: payload?.sourceFilePath,
          })
        : null;
      if (mimeType !== null && !isAllowedMimeType(mimeType)) {
        return { ok: false, error: 'Formato no soportado para reemplazar audio. Usa mp3, wav, ogg, webm, m4a, aac o flac.' };
      }

      if (payload?.audioBase64 !== undefined) {
        const audioBase64 = normalizeAudioBase64(payload.audioBase64);
        const sizeBytes = getBase64SizeBytes(audioBase64);
        if (!audioBase64) return { ok: false, error: 'Audio inválido.' };
        if (!sizeBytes) return { ok: false, error: 'No se pudo procesar el audio.' };
        patch.audioBase64 = audioBase64;
        patch.sizeBytes = sizeBytes;
      }

      if (mimeType !== null) patch.mimeType = mimeType;
      if (payload?.originalName !== undefined) patch.originalName = String(payload.originalName || '').slice(0, 255);
    }

    return { ok: true, value: patch };
  }

  function ensureNoHotkeyConflict(sounds, soundId, hotkey) {
    if (!hotkey) return { ok: true };
    const conflict = sounds.find((s) => s.id !== soundId && String(s.hotkey || '').toLowerCase() === hotkey.toLowerCase());
    if (conflict) return { ok: false, error: 'Ese atajo ya lo usa otro sonido.' };
    return { ok: true };
  }

  function validateCreateStoragePayload(payload) {
    const name = normalizeName(payload?.name);
    const originalName = String(payload?.originalName || '').slice(0, 255);
    const mimeType = resolveMimeType({
      mimeType: payload?.mimeType,
      originalName,
      sourceFilePath: payload?.sourceFilePath,
    });
    const hotkey = normalizeHotkey(payload?.hotkey);
    const volume = normalizeVolume(payload?.volume);
    const enabled = normalizeEnabled(payload?.enabled);
    const storageBucket = String(payload?.storageBucket || getSoundboardBucket()).trim();
    const storagePath = normalizeStoragePath(payload?.storagePath, storageBucket);

    if (!name) return { ok: false, error: 'El nombre es obligatorio.' };
    if (storagePath && !isAllowedMimeType(mimeType)) {
      return { ok: false, error: 'Formato no soportado. Usa mp3, wav, ogg, webm, m4a, aac o flac.' };
    }

    return {
      ok: true,
      value: { name, originalName, mimeType, hotkey, volume, enabled, storagePath, storageBucket },
    };
  }

  function validateUpdateStoragePayload(payload) {
    const patch = {};
    if (payload?.name !== undefined) {
      const v = normalizeName(payload.name);
      if (!v) return { ok: false, error: 'El nombre no puede quedar vacío.' };
      patch.name = v;
    }
    if (payload?.hotkey !== undefined) {
      const v = normalizeHotkey(payload.hotkey);
      if (String(payload.hotkey || '').trim() && !v) return { ok: false, error: 'Atajo inválido.' };
      patch.hotkey = v;
    }
    if (payload?.volume !== undefined) patch.volume = normalizeVolume(payload.volume);
    if (payload?.enabled !== undefined) patch.enabled = normalizeEnabled(payload.enabled);

    if (payload?.mimeType !== undefined || payload?.originalName !== undefined || payload?.sourceFilePath !== undefined) {
      const mimeType = resolveMimeType({
        mimeType: payload?.mimeType,
        originalName: payload?.originalName,
        sourceFilePath: payload?.sourceFilePath || payload?.storagePath,
      });
      if (!isAllowedMimeType(mimeType)) {
        return { ok: false, error: 'Formato no soportado para reemplazar audio. Usa mp3, wav, ogg, webm, m4a, aac o flac.' };
      }
      patch.mimeType = mimeType;
    }

    if (payload?.originalName !== undefined) patch.originalName = String(payload.originalName || '').slice(0, 255);
    if (payload?.storagePath !== undefined) {
      const bucketForPath = payload?.storageBucket !== undefined
        ? String(payload.storageBucket || '').trim()
        : getSoundboardBucket();
      patch.storagePath = normalizeStoragePath(payload.storagePath, bucketForPath);
    }
    if (payload?.storageBucket !== undefined) {
      const bucket = String(payload.storageBucket || '').trim();
      if (!bucket) return { ok: false, error: 'El bucket no puede quedar vacío.' };
      patch.storageBucket = bucket;
    }
    return { ok: true, value: patch };
  }

  async function uploadAudioToStorage({ bucket, storagePath, sourceFilePath, audioBase64, mimeType }) {
    const supabase = getSupabase();
    if (!supabase) return { ok: false, error: 'Supabase no conectado.' };

    const b = String(bucket || getSoundboardBucket()).trim();
    const p = normalizeStoragePath(storagePath, b);
    if (!b) return { ok: false, error: 'Bucket inválido.' };
    if (!p) return { ok: false, error: 'Ruta de bucket inválida.' };

    let body = null;
    if (sourceFilePath) {
      if (!fs.existsSync(sourceFilePath)) return { ok: false, error: 'El archivo seleccionado no existe.' };
      try {
        body = fs.readFileSync(sourceFilePath);
      } catch (err) {
        return { ok: false, error: err?.message || 'No se pudo leer el archivo seleccionado.' };
      }
    } else {
      const clean = normalizeAudioBase64(audioBase64);
      if (!clean) return { ok: false, error: 'No se recibió audio para subir.' };
      try {
        body = Buffer.from(clean, 'base64');
      } catch {
        return { ok: false, error: 'No se pudo decodificar el audio.' };
      }
    }
    if (!body || !body.length) return { ok: false, error: 'Audio vacío.' };

    let data = null;
    let error = null;
    try {
      const res = await withTimeout(
        supabase.storage.from(b).upload(p, body, {
          contentType: mimeType || undefined,
          upsert: true,
          cacheControl: '3600',
        }),
        SUPABASE_OP_TIMEOUT_MS,
        'subida de audio al bucket'
      );
      data = res?.data || null;
      error = res?.error || null;
    } catch (err) {
      return { ok: false, error: err?.message || 'Error subiendo el archivo al bucket.' };
    }
    if (error) {
      const full = [error.message || 'No se pudo subir el archivo al bucket.', error.code, error.details, error.hint].filter(Boolean).join(' | ');
      return { ok: false, error: full };
    }

    return { ok: true, data, sizeBytes: Math.max(0, Number(body.length || 0)), storageBucket: b, storagePath: p };
  }

  async function insertSoundSupabase(payload) {
    const supabase = getSupabase();
    if (!supabase) {
      const res = { ok: false, error: 'Supabase no conectado.' };
      logOpError('upload supabase', res.error);
      return res;
    }

    const valid = validateCreateStoragePayload(payload);
    if (!valid.ok) return valid;
    const base = valid.value;
    const sourceFilePath = String(payload?.sourceFilePath || '').trim();
    const audioBase64 = normalizeAudioBase64(payload?.audioBase64);

    let storagePath = base.storagePath;
    if (!storagePath && (sourceFilePath || audioBase64)) {
      const seedId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      storagePath = joinObjectPath(seedId, base.mimeType, base.originalName, sourceFilePath);
    }
    if (!storagePath) {
      const res = { ok: false, error: 'Falta la ruta dentro del bucket (ej: sounds/airhorn.mp3).' };
      logOpError('upload supabase', res.error);
      return res;
    }

    let sizeBytes = 0;
    if (sourceFilePath || audioBase64) {
      const uploaded = await uploadAudioToStorage({
        bucket: base.storageBucket,
        storagePath,
        sourceFilePath,
        audioBase64,
        mimeType: base.mimeType,
      });
      if (!uploaded.ok) {
        logOpError('upload supabase(storage)', uploaded.error);
        return uploaded;
      }
      storagePath = uploaded.storagePath;
      sizeBytes = uploaded.sizeBytes;
    }

    const row = {
      name: base.name,
      original_name: base.originalName,
      mime_type: base.mimeType,
      audio_base64: '',
      storage_bucket: base.storageBucket,
      storage_path: storagePath,
      size_bytes: sizeBytes,
      hotkey: base.hotkey,
      volume: base.volume,
      enabled: base.enabled,
      updated_at: new Date().toISOString(),
    };

    let data = null;
    let error = null;
    try {
      const res = await withTimeout(
        supabase
          .from('soundboard_sounds')
          .insert(row)
          .select('id,name,original_name,mime_type,audio_base64,storage_bucket,storage_path,size_bytes,hotkey,volume,enabled,created_at,updated_at')
          .single(),
        SUPABASE_OP_TIMEOUT_MS,
        'subida de sonido'
      );
      data = res?.data;
      error = res?.error || null;
    } catch (err) {
      const res = { ok: false, error: err?.message || 'Error subiendo sonido en Supabase.' };
      logOpError('upload supabase', res.error);
      return res;
    }

    if (error) {
      const message = String(error.message || 'No se pudo guardar el sonido.');
      if (message.toLowerCase().includes('storage_bucket') || message.toLowerCase().includes('storage_path')) {
        const res = { ok: false, error: 'Faltan columnas en soundboard_sounds: ejecutá la migración para agregar storage_bucket y storage_path.' };
        logOpError('upload supabase', res.error);
        return res;
      }
      if (message.toLowerCase().includes('soundboard_sounds_hotkey_uq')) {
        const res = { ok: false, error: 'Ese atajo ya está asignado a otro sonido.' };
        logOpError('upload supabase', res.error);
        return res;
      }
      const full = [message, error.code, error.details, error.hint].filter(Boolean).join(' | ');
      const res = { ok: false, error: full };
      logOpError('upload supabase', res.error);
      return res;
    }

    return { ok: true, sound: rowToCache(data) };
  }

  function buildLocalIndexRow(sound) {
    return {
      id: sound.id,
      name: sound.name,
      originalName: sound.originalName,
      mimeType: sound.mimeType,
      fileName: sound.fileName,
      sizeBytes: sound.sizeBytes,
      hotkey: sound.hotkey,
      volume: sound.volume,
      enabled: sound.enabled,
      createdAt: sound.createdAt,
      updatedAt: sound.updatedAt,
    };
  }

  async function insertSoundLocal(payload) {
    const name = normalizeName(payload?.name);
    const originalName = String(payload?.originalName || '').slice(0, 255);
    const mimeType = resolveMimeType({
      mimeType: payload?.mimeType,
      originalName,
      sourceFilePath: payload?.sourceFilePath,
    });
    const hotkey = normalizeHotkey(payload?.hotkey);
    const volume = normalizeVolume(payload?.volume);
    const enabled = normalizeEnabled(payload?.enabled);

    if (!name) return { ok: false, error: 'El nombre es obligatorio.' };
    if (!isAllowedMimeType(mimeType)) return { ok: false, error: 'Formato no soportado. Usa mp3, wav, ogg, webm, m4a, aac o flac.' };

    const idx = readLocalIndex();
    if (!idx.ok) return idx;

    const newId = uuid();
    const hkCheck = ensureNoHotkeyConflict(idx.sounds.map(localRowToCache), newId, hotkey);
    if (!hkCheck.ok) return hkCheck;

    let savedAudio = null;
    const sourceFilePath = String(payload?.sourceFilePath || '').trim();
    if (sourceFilePath) {
      savedAudio = await copyLocalAudioFileFromPath({
        id: newId,
        mimeType,
        originalName,
        sourceFilePath,
      });
    } else {
      const valid = validateCreatePayload(payload);
      if (!valid.ok) return valid;
      savedAudio = writeLocalAudioFile({
        id: newId,
        mimeType: valid.value.mimeType,
        originalName: valid.value.originalName,
        audioBase64: valid.value.audioBase64,
      });
    }
    if (!savedAudio.ok) return savedAudio;

    const now = new Date().toISOString();
    const sound = {
      id: newId,
      name,
      originalName,
      mimeType,
      audioBase64: '',
      fileName: savedAudio.fileName,
      filePath: savedAudio.filePath,
      sizeBytes: savedAudio.sizeBytes,
      hotkey,
      volume,
      enabled,
      createdAt: now,
      updatedAt: now,
      storage: 'local',
    };

    const nextRows = [...idx.sounds, buildLocalIndexRow(sound)];
    const write = writeLocalIndex(nextRows);
    if (!write.ok) {
      deleteLocalAudioFile(savedAudio.fileName);
      return write;
    }

    return { ok: true, sound };
  }

  async function insertSound(payload) {
    const res = await insertSoundSupabase(payload);
    if (!res.ok) {
      logOpError('upload (supabase)', res.error);
      return res;
    }

    cacheLoaded = false;
    await refreshAndRegisterHotkeys({ force: true });
    return res;
  }

  async function updateSoundSupabase(id, payload) {
    const sid = String(id || '').trim();
    if (!sid) return { ok: false, error: 'ID inválido.' };

    const supabase = getSupabase();
    if (!supabase) {
      const res = { ok: false, error: 'Supabase no conectado.' };
      logOpError('update supabase', res.error);
      return res;
    }

    const valid = validateUpdateStoragePayload(payload);
    if (!valid.ok) return valid;

    const patch = valid.value;

    const sound = soundsCache.find((s) => s.id === sid);
    if (!sound) return { ok: false, error: 'Sonido no encontrado.' };

    const sourceFilePath = String(payload?.sourceFilePath || '').trim();
    const audioBase64 = normalizeAudioBase64(payload?.audioBase64);
    const hasAudioReplacement = !!(sourceFilePath || audioBase64);
    const nextBucket = patch.storageBucket || sound.storageBucket || getSoundboardBucket();
    let nextPath = patch.storagePath !== undefined ? patch.storagePath : sound.storagePath;

    if (hasAudioReplacement && !nextPath) {
      const srcName = patch.originalName !== undefined ? patch.originalName : sound.originalName;
      const srcMime = patch.mimeType !== undefined ? patch.mimeType : sound.mimeType;
      nextPath = joinObjectPath(sid, srcMime, srcName, sourceFilePath);
    }

    if (hasAudioReplacement) {
      const uploadMime = patch.mimeType !== undefined ? patch.mimeType : sound.mimeType;
      const uploaded = await uploadAudioToStorage({
        bucket: nextBucket,
        storagePath: nextPath,
        sourceFilePath,
        audioBase64,
        mimeType: uploadMime,
      });
      if (!uploaded.ok) {
        logOpError('update supabase(storage)', uploaded.error);
        return uploaded;
      }
      patch.storageBucket = uploaded.storageBucket;
      patch.storagePath = uploaded.storagePath;
      patch.sizeBytes = uploaded.sizeBytes;
    }

    if (patch.storagePath !== undefined && !patch.storagePath) {
      return { ok: false, error: 'La ruta en bucket no puede quedar vacía.' };
    }

    if (!Object.keys(patch).length) return { ok: false, error: 'No hay cambios para guardar.' };

    const localConflict = patch.hotkey !== undefined
      ? ensureNoHotkeyConflict(soundsCache, sid, patch.hotkey)
      : { ok: true };
    if (!localConflict.ok) return localConflict;

    const dbPatch = {
      updated_at: new Date().toISOString(),
    };
    if (patch.name !== undefined) dbPatch.name = patch.name;
    if (patch.hotkey !== undefined) dbPatch.hotkey = patch.hotkey;
    if (patch.volume !== undefined) dbPatch.volume = patch.volume;
    if (patch.enabled !== undefined) dbPatch.enabled = patch.enabled;
    if (patch.sizeBytes !== undefined) dbPatch.size_bytes = patch.sizeBytes;
    if (patch.mimeType !== undefined) dbPatch.mime_type = patch.mimeType;
    if (patch.originalName !== undefined) dbPatch.original_name = patch.originalName;
    if (patch.storageBucket !== undefined) dbPatch.storage_bucket = patch.storageBucket;
    if (patch.storagePath !== undefined) dbPatch.storage_path = patch.storagePath;

    let data = null;
    let error = null;
    try {
      const res = await withTimeout(
        supabase
          .from('soundboard_sounds')
          .update(dbPatch)
          .eq('id', sid)
          .select('id,name,original_name,mime_type,audio_base64,storage_bucket,storage_path,size_bytes,hotkey,volume,enabled,created_at,updated_at')
          .maybeSingle(),
        SUPABASE_OP_TIMEOUT_MS,
        'actualización de sonido'
      );
      data = res?.data;
      error = res?.error || null;
    } catch (err) {
      const res = { ok: false, error: err?.message || 'Error actualizando sonido en Supabase.' };
      logOpError('update supabase', res.error);
      return res;
    }

    if (error) {
      const message = String(error.message || 'No se pudo actualizar el sonido.');
      if (message.toLowerCase().includes('storage_bucket') || message.toLowerCase().includes('storage_path')) {
        const res = { ok: false, error: 'Faltan columnas en soundboard_sounds: ejecutá la migración para agregar storage_bucket y storage_path.' };
        logOpError('update supabase', res.error);
        return res;
      }
      if (message.toLowerCase().includes('soundboard_sounds_hotkey_uq')) {
        const res = { ok: false, error: 'Ese atajo ya está asignado a otro sonido.' };
        logOpError('update supabase', res.error);
        return res;
      }
      const full = [message, error.code, error.details, error.hint].filter(Boolean).join(' | ');
      const res = { ok: false, error: full };
      logOpError('update supabase', res.error);
      return res;
    }

    if (!data) return { ok: false, error: 'Sonido no encontrado.' };
    return { ok: true, sound: rowToCache(data) };
  }

  async function updateSoundLocal(id, payload) {
    const sid = String(id || '').trim();
    if (!sid) return { ok: false, error: 'ID inválido.' };

    const valid = validateUpdatePayload(payload);
    if (!valid.ok) return valid;

    const idx = readLocalIndex();
    if (!idx.ok) return idx;

    const current = idx.sounds.find((s) => String(s.id) === sid);
    if (!current) return { ok: false, error: 'Sonido no encontrado.' };

    const sourceFilePath = String(payload?.sourceFilePath || '').trim();
    const inferredMimeType = sourceFilePath
      ? resolveMimeType({
          mimeType: payload?.mimeType,
          originalName: payload?.originalName || current.originalName,
          sourceFilePath,
        })
      : '';

    const merged = {
      ...current,
      ...(valid.value.name !== undefined ? { name: valid.value.name } : {}),
      ...(valid.value.hotkey !== undefined ? { hotkey: valid.value.hotkey } : {}),
      ...(valid.value.volume !== undefined ? { volume: valid.value.volume } : {}),
      ...(valid.value.enabled !== undefined ? { enabled: valid.value.enabled } : {}),
      ...(valid.value.mimeType !== undefined ? { mimeType: valid.value.mimeType } : {}),
      ...(inferredMimeType ? { mimeType: inferredMimeType } : {}),
      ...(valid.value.originalName !== undefined ? { originalName: valid.value.originalName } : {}),
      updatedAt: new Date().toISOString(),
    };

    const hkCheck = ensureNoHotkeyConflict(idx.sounds.map(localRowToCache), sid, merged.hotkey);
    if (!hkCheck.ok) return hkCheck;

    if (sourceFilePath || valid.value.audioBase64 !== undefined) {
      const saved = sourceFilePath
        ? await copyLocalAudioFileFromPath({
            id: sid,
            mimeType: merged.mimeType,
            originalName: merged.originalName,
            sourceFilePath,
          })
        : writeLocalAudioFile({
            id: sid,
            mimeType: merged.mimeType,
            originalName: merged.originalName,
            audioBase64: valid.value.audioBase64,
          });
      if (!saved.ok) return saved;

      if (merged.fileName && merged.fileName !== saved.fileName) {
        deleteLocalAudioFile(merged.fileName);
      }
      merged.fileName = saved.fileName;
      merged.sizeBytes = saved.sizeBytes;
    }

    const nextRows = idx.sounds.map((s) => (String(s.id) === sid ? merged : s));
    const write = writeLocalIndex(nextRows);
    if (!write.ok) return write;

    return { ok: true, sound: localRowToCache(merged) };
  }

  async function updateSound(id, payload) {
    const res = await updateSoundSupabase(id, payload);
    if (!res.ok) {
      logOpError('update (supabase)', res.error);
      return res;
    }

    cacheLoaded = false;
    await refreshAndRegisterHotkeys({ force: true });
    return res;
  }

  async function deleteSoundSupabase(id) {
    const sid = String(id || '').trim();
    if (!sid) return { ok: false, error: 'ID inválido.' };

    const supabase = getSupabase();
    if (!supabase) {
      const res = { ok: false, error: 'Supabase no conectado.' };
      logOpError('delete supabase', res.error);
      return res;
    }

    let error = null;
    try {
      const res = await withTimeout(
        supabase.from('soundboard_sounds').delete().eq('id', sid),
        SUPABASE_OP_TIMEOUT_MS,
        'eliminación de sonido'
      );
      error = res?.error || null;
    } catch (err) {
      const res = { ok: false, error: err?.message || 'Error eliminando sonido en Supabase.' };
      logOpError('delete supabase', res.error);
      return res;
    }
    if (error) {
      const full = [error.message || 'No se pudo eliminar.', error.code, error.details, error.hint].filter(Boolean).join(' | ');
      const res = { ok: false, error: full };
      logOpError('delete supabase', res.error);
      return res;
    }

    return { ok: true };
  }

  async function deleteSoundLocal(id) {
    const sid = String(id || '').trim();
    if (!sid) return { ok: false, error: 'ID inválido.' };

    const idx = readLocalIndex();
    if (!idx.ok) return idx;

    const current = idx.sounds.find((s) => String(s.id) === sid);
    if (!current) return { ok: false, error: 'Sonido no encontrado.' };

    const nextRows = idx.sounds.filter((s) => String(s.id) !== sid);
    const write = writeLocalIndex(nextRows);
    if (!write.ok) return write;

    deleteLocalAudioFile(current.fileName);
    return { ok: true };
  }

  async function deleteSound(id) {
    const res = await deleteSoundSupabase(id);
    if (!res.ok) {
      logOpError('delete (supabase)', res.error);
      return res;
    }

    cacheLoaded = false;
    await refreshAndRegisterHotkeys({ force: true });
    return res;
  }

  async function setStorageModeAndReload() {
    const next = setStorageMode();
    cacheLoaded = false;
    const refreshed = await refreshAndRegisterHotkeys({ force: true });
    if (!refreshed.ok) {
      logOpError('switch storage mode', refreshed.error);
      return refreshed;
    }
    return { ok: true, storageMode: next };
  }

  async function migrateSupabaseToLocal() {
    return { ok: false, error: 'La migración a local fue desactivada. Soundboard ahora usa solo Supabase Storage.' };
  }

  async function ensureReady() {
    const loaded = await loadCache();
    if (!loaded.ok) {
      logOpError('ensure ready', loaded.error);
      return loaded;
    }
    return refreshAndRegisterHotkeys();
  }

  function destroy() {
    clearRegisteredHotkeys();
    hotkeyErrors.clear();
  }

  return {
    ensureReady,
    getState,
    refreshAndRegisterHotkeys,
    playSoundById,
    insertSound,
    updateSound,
    deleteSound,
    setHotkeysEnabled,
    areHotkeysEnabled,
    getStorageMode,
    setStorageModeAndReload,
    migrateSupabaseToLocal,
    getAudioPayload,
    normalizeHotkey,
    destroy,
  };
}

module.exports = { createSoundboardService };
