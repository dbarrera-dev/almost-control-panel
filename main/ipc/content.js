const crypto = require('crypto');
const { httpsRequest } = require('../net');

const CONTENT_BUCKET_DEFAULT = 'almost-content';
const STORAGE_SIGNED_URL_SECONDS = 60 * 60 * 24 * 365 * 10;
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};
const ALLOWED_IMAGE_MIME = new Set(Object.keys(IMAGE_MIME_EXT));

function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function safeName(value, fallback = 'image') {
  return String(value || fallback)
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || fallback;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return normalizeList(parsed);
    } catch {}
    return value.trim() ? [value.trim()] : [];
  }
  return [];
}

function parseDataUrl(input) {
  const raw = String(input || '').trim();
  const m = raw.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!m) return { ok: false, error: 'Formato de imagen inválido.' };
  const mimeType = String(m[1] || '').toLowerCase();
  if (!ALLOWED_IMAGE_MIME.has(mimeType)) {
    return { ok: false, error: 'Formato no soportado. Usá JPG, PNG, WEBP o GIF.' };
  }
  let body = null;
  try {
    body = Buffer.from(String(m[2] || '').replace(/\s+/g, ''), 'base64');
  } catch {
    return { ok: false, error: 'No se pudo decodificar la imagen.' };
  }
  if (!body?.length) return { ok: false, error: 'Imagen vacía.' };
  if (body.length > IMAGE_MAX_BYTES) return { ok: false, error: 'La imagen supera 8MB.' };
  return { ok: true, mimeType, body };
}

function hexToDiscordColor(value) {
  const hex = String(value || '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return 0xe07000;
  return parseInt(hex, 16);
}

function maskWebhookUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return `${u.origin}${u.pathname.slice(0, 24)}...${u.pathname.slice(-6)}`;
  } catch {
    const raw = String(url || '');
    return raw.length > 18 ? `${raw.slice(0, 18)}...` : raw;
  }
}

function getContentBucket(loadConfig) {
  const cfg = loadConfig();
  return String(cfg.contentStorageBucket || '').trim() || CONTENT_BUCKET_DEFAULT;
}

async function createSignedUrl(supabase, bucket, storagePath) {
  const signed = await supabase.storage.from(bucket).createSignedUrl(storagePath, STORAGE_SIGNED_URL_SECONDS);
  return String(signed?.data?.signedUrl || '').trim();
}

async function uploadImage({ state, loadConfig, payload }) {
  const supabase = state.supabase;
  if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
  const parsed = parseDataUrl(payload?.dataUrl);
  if (!parsed.ok) return parsed;

  const folderRaw = String(payload?.folder || 'content').trim().toLowerCase();
  const folder = folderRaw === 'announcements' ? 'announcements' : 'ideas';
  const bucket = getContentBucket(loadConfig);
  const ext = IMAGE_MIME_EXT[parsed.mimeType] || '.bin';
  const base = safeName(String(payload?.fileName || '').replace(/\.[^.]+$/, '') || 'image');
  const storagePath = `${folder}/${Date.now()}-${base}${ext}`;

  const up = await supabase.storage.from(bucket).upload(storagePath, parsed.body, {
    contentType: parsed.mimeType,
    upsert: true,
    cacheControl: '3600',
  });
  if (up?.error) {
    return { ok: false, error: up.error.message || 'No se pudo subir la imagen al bucket.', bucket };
  }

  const signedUrl = await createSignedUrl(supabase, bucket, storagePath);
  if (!signedUrl) return { ok: false, error: 'Imagen subida, pero no se pudo crear URL firmada.', bucket, storagePath };
  return { ok: true, url: signedUrl, bucket, storagePath };
}

function buildEmbedPayload({ title, body, imageUrl, footerText, embedColor, botName, botAvatarUrl }) {
  const embed = {
    title: String(title || '').trim(),
    description: String(body || '').trim(),
    color: hexToDiscordColor(embedColor),
  };
  const img = String(imageUrl || '').trim();
  if (img) embed.image = { url: img };
  const ft = String(footerText || '').trim();
  if (ft) embed.footer = { text: ft };
  const name = String(botName || 'Almost Bot').trim() || 'Almost Bot';
  const avatar = String(botAvatarUrl || '').trim();
  return {
    username: name,
    ...(avatar ? { avatar_url: avatar } : {}),
    embeds: [embed],
  };
}

// Envía un anuncio ya persistido (programado o reintento) y actualiza su estado.
async function deliverAnnouncementRow(supabase, row, saveLog) {
  let webhookUrl = null;
  let channelName = row.channel_name;
  if (row.webhook_id) {
    const { data: wh } = await supabase
      .from('discord_webhooks')
      .select('webhook_url, name')
      .eq('id', row.webhook_id)
      .maybeSingle();
    if (wh) { webhookUrl = wh.webhook_url; channelName = wh.name; }
  }

  let sent = { ok: false, error: 'Webhook no encontrado.' };
  if (webhookUrl) {
    sent = await sendDiscordWebhook(webhookUrl, buildEmbedPayload({
      title: row.title,
      body: row.body,
      imageUrl: row.image_url,
      footerText: row.footer_text,
      embedColor: row.embed_color,
      botName: row.bot_name,
      botAvatarUrl: row.bot_avatar_url,
    }));
  }

  const now = new Date().toISOString();
  const { data: updated } = await supabase.from('discord_announcements').update({
    status: sent.ok ? 'sent' : 'failed',
    sent_at: sent.ok ? now : null,
    error_text: sent.ok ? null : String(sent.error || 'Error enviando webhook').slice(0, 1000),
    channel_name: channelName,
  }).eq('id', row.id).select().maybeSingle();

  if (saveLog) {
    saveLog(sent.ok ? 'info' : 'warn', `Anuncio ${sent.ok ? 'enviado' : 'falló'}: ${row.title} → #${channelName}`);
  }
  return { ok: sent.ok, row: updated, error: sent.ok ? undefined : (updated?.error_text || sent.error) };
}

// Tick del scheduler: recupera envíos colgados, busca los vencidos y los envía.
async function processDueAnnouncements({ state, saveLog, notify }) {
  const supabase = state.supabase;
  if (!supabase) return;

  // Recuperar filas que quedaron en "sending" por un cierre abrupto (> 5 min).
  const staleIso = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await supabase.from('discord_announcements')
    .update({ status: 'scheduled' })
    .eq('status', 'sending')
    .lt('updated_at', staleIso);

  const nowIso = new Date().toISOString();
  const { data: due, error } = await supabase.from('discord_announcements')
    .select('*')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(10);
  if (error || !due?.length) return;

  let processed = 0;
  for (const row of due) {
    // Reclamar la fila de forma atómica para evitar envíos duplicados.
    const { data: claimed } = await supabase.from('discord_announcements')
      .update({ status: 'sending' })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select()
      .maybeSingle();
    if (!claimed) continue;
    await deliverAnnouncementRow(supabase, claimed, saveLog);
    processed++;
  }
  if (processed && typeof notify === 'function') notify('discord-announcements-changed', { processed });
}

function startAnnouncementScheduler({ state, saveLog, notify }) {
  const tick = () => { processDueAnnouncements({ state, saveLog, notify }).catch(() => {}); };
  setTimeout(tick, 8000);
  return setInterval(tick, 20000);
}

async function sendDiscordWebhook(webhookUrl, payload) {
  let url = null;
  try {
    url = new URL(String(webhookUrl || ''));
  } catch {
    return { ok: false, error: 'URL de webhook inválida.' };
  }
  if (url.protocol !== 'https:' || !/(^|\.)discord(?:app)?\.com$/i.test(url.hostname)) {
    return { ok: false, error: 'El webhook debe ser una URL HTTPS de Discord.' };
  }
  const path = `${url.pathname}${url.search || ''}`;
  const r = await httpsRequest('POST', url.hostname, path, {
    'Content-Type': 'application/json',
    'User-Agent': 'AlmostControl/1.0',
  }, JSON.stringify(payload), 20000);
  if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
  const err = typeof r.data === 'string' ? r.data : (r.data?.message || r.data?.error || `HTTP ${r.status}`);
  return { ok: false, status: r.status, error: err };
}

function registerContentIpc({ ipcMain, loadConfig, saveConfig, saveLog, state, notify }) {
  ipcMain.handle('content-upload-image', async (_, payload) => uploadImage({ state, loadConfig, payload }));

  ipcMain.handle('content-ideas-get', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.', data: [] };
    const { data, error } = await supabase.from('content_ideas').select('*').order('updated_at', { ascending: false });
    if (error) return { ok: false, error: error.message, data: [] };
    return { ok: true, data: (data || []).map((row) => ({
      ...row,
      reference_links: normalizeList(row.reference_links),
      images: normalizeList(row.images),
    })) };
  });

  ipcMain.handle('content-ideas-add', async (_, idea) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const now = new Date().toISOString();
    const row = {
      title: String(idea?.title || '').trim(),
      category: String(idea?.category || 'General').trim() || 'General',
      notes_html: String(idea?.notesHtml || '').trim(),
      notes_text: String(idea?.notesText || '').trim(),
      reference_links: normalizeList(idea?.referenceLinks),
      images: normalizeList(idea?.images),
      status: String(idea?.status || 'idea').trim() || 'idea',
      created_at: now,
      updated_at: now,
    };
    if (!row.title) return { ok: false, error: 'El título es obligatorio.' };
    const { data, error } = await supabase.from('content_ideas').insert(row).select().single();
    if (error) return { ok: false, error: error.message };
    saveLog('info', `Idea creada: ${row.title}`);
    return { ok: true, data };
  });

  ipcMain.handle('content-ideas-update', async (_, { id, data }) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const patch = { updated_at: new Date().toISOString() };
    if (data?.title !== undefined) patch.title = String(data.title || '').trim();
    if (data?.category !== undefined) patch.category = String(data.category || 'General').trim() || 'General';
    if (data?.notesHtml !== undefined) patch.notes_html = String(data.notesHtml || '').trim();
    if (data?.notesText !== undefined) patch.notes_text = String(data.notesText || '').trim();
    if (data?.referenceLinks !== undefined) patch.reference_links = normalizeList(data.referenceLinks);
    if (data?.images !== undefined) patch.images = normalizeList(data.images);
    if (data?.status !== undefined) patch.status = String(data.status || 'idea').trim() || 'idea';
    const { data: row, error } = await supabase.from('content_ideas').update(patch).eq('id', id).select().maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: row };
  });

  ipcMain.handle('content-ideas-delete', async (_, id) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const { data: idea } = await supabase.from('content_ideas').select('title').eq('id', id).maybeSingle();
    const { error } = await supabase.from('content_ideas').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    saveLog('warn', `Idea eliminada: ${idea?.title || id}`);
    return { ok: true };
  });

  ipcMain.handle('discord-settings-get', async () => {
    const cfg = loadConfig();
    return {
      ok: true,
      data: {
        botName: cfg.discordBotName || 'Almost Bot',
        botAvatarUrl: cfg.discordBotAvatarUrl || '',
        contentStorageBucket: cfg.contentStorageBucket || CONTENT_BUCKET_DEFAULT,
      },
    };
  });

  ipcMain.handle('discord-settings-set', async (_, data) => {
    const cfg = loadConfig();
    cfg.discordBotName = String(data?.botName || 'Almost Bot').trim() || 'Almost Bot';
    cfg.discordBotAvatarUrl = String(data?.botAvatarUrl || '').trim();
    if (data?.contentStorageBucket !== undefined) {
      cfg.contentStorageBucket = String(data.contentStorageBucket || CONTENT_BUCKET_DEFAULT).trim() || CONTENT_BUCKET_DEFAULT;
    }
    saveConfig(cfg);
    return { ok: true };
  });

  ipcMain.handle('discord-webhooks-get', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.', data: [] };
    const { data, error } = await supabase.from('discord_webhooks').select('*').order('created_at', { ascending: false });
    if (error) return { ok: false, error: error.message, data: [] };
    return { ok: true, data: data || [] };
  });

  ipcMain.handle('discord-webhooks-add', async (_, input) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const name = String(input?.name || '').trim();
    const webhookUrl = String(input?.url || '').trim();
    if (!name || !webhookUrl) return { ok: false, error: 'Nombre y URL son obligatorios.' };
    const { data, error } = await supabase.from('discord_webhooks').insert({
      name,
      webhook_url: webhookUrl,
      enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).select().single();
    if (error) return { ok: false, error: error.message };
    saveLog('info', `Webhook Discord agregado: #${name}`);
    return { ok: true, data };
  });

  ipcMain.handle('discord-webhooks-delete', async (_, id) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const { error } = await supabase.from('discord_webhooks').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

  ipcMain.handle('discord-webhooks-test', async (_, id) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const { data: wh, error } = await supabase.from('discord_webhooks').select('*').eq('id', id).maybeSingle();
    if (error || !wh) return { ok: false, error: error?.message || 'Webhook no encontrado.' };
    const cfg = loadConfig();
    const payload = {
      username: cfg.discordBotName || 'Almost Bot',
      ...(cfg.discordBotAvatarUrl ? { avatar_url: cfg.discordBotAvatarUrl } : {}),
      content: `Prueba de Almost Control para #${wh.name}`,
    };
    const sent = await sendDiscordWebhook(wh.webhook_url, payload);
    if (!sent.ok) return sent;
    return { ok: true };
  });

  ipcMain.handle('discord-announcements-get', async () => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.', data: [] };
    const { data, error } = await supabase.from('discord_announcements').select('*').order('created_at', { ascending: false });
    if (error) return { ok: false, error: error.message, data: [] };
    return { ok: true, data: data || [] };
  });

  ipcMain.handle('discord-announcements-send', async (_, input) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const title = String(input?.title || '').trim();
    const body = String(input?.body || '').trim();
    const webhookId = String(input?.webhookId || '').trim();
    if (!title) return { ok: false, error: 'El título es obligatorio.' };
    if (!body) return { ok: false, error: 'El mensaje es obligatorio.' };
    if (!webhookId) return { ok: false, error: 'Seleccioná un webhook.' };

    const { data: wh, error: whErr } = await supabase.from('discord_webhooks').select('*').eq('id', webhookId).maybeSingle();
    if (whErr || !wh) return { ok: false, error: whErr?.message || 'Webhook no encontrado.' };

    const cfg = loadConfig();
    const payload = buildEmbedPayload({
      title,
      body,
      imageUrl: input?.imageUrl,
      footerText: input?.footerText,
      embedColor: input?.embedColor,
      botName: cfg.discordBotName,
      botAvatarUrl: cfg.discordBotAvatarUrl,
    });
    const sent = await sendDiscordWebhook(wh.webhook_url, payload);
    const now = new Date().toISOString();
    const row = {
      title,
      body,
      image_url: String(input?.imageUrl || '').trim() || null,
      footer_text: String(input?.footerText || '').trim() || null,
      embed_color: String(input?.embedColor || '#e07000').trim() || '#e07000',
      webhook_id: webhookId,
      channel_name: wh.name,
      bot_name: cfg.discordBotName || 'Almost Bot',
      bot_avatar_url: cfg.discordBotAvatarUrl || null,
      status: sent.ok ? 'sent' : 'failed',
      error_text: sent.ok ? null : String(sent.error || 'Error enviando webhook').slice(0, 1000),
      sent_at: sent.ok ? now : null,
      scheduled_at: null,
      created_at: now,
      updated_at: now,
    };
    const { data, error } = await supabase.from('discord_announcements').insert(row).select().single();
    if (error) return { ok: false, error: error.message, sent };
    saveLog(sent.ok ? 'info' : 'warn', `Anuncio Discord ${sent.ok ? 'enviado' : 'falló'}: ${title} → #${wh.name} (${maskWebhookUrl(wh.webhook_url)})`);
    return { ok: sent.ok, data, error: sent.ok ? undefined : row.error_text };
  });

  // Programar un anuncio para envío futuro.
  ipcMain.handle('discord-announcements-schedule', async (_, input) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const title = String(input?.title || '').trim();
    const body = String(input?.body || '').trim();
    const webhookId = String(input?.webhookId || '').trim();
    if (!title) return { ok: false, error: 'El título es obligatorio.' };
    if (!body) return { ok: false, error: 'El mensaje es obligatorio.' };
    if (!webhookId) return { ok: false, error: 'Seleccioná un webhook.' };
    const when = new Date(input?.scheduledAt || '');
    if (isNaN(when.getTime())) return { ok: false, error: 'Fecha de programación inválida.' };
    if (when.getTime() < Date.now() + 30 * 1000) return { ok: false, error: 'La fecha debe ser al menos 30 segundos en el futuro.' };
    if (input?.imageUrl && !/^https?:\/\//i.test(String(input.imageUrl).trim())) {
      return { ok: false, error: 'La URL de imagen no es válida.' };
    }

    const { data: wh, error: whErr } = await supabase.from('discord_webhooks').select('*').eq('id', webhookId).maybeSingle();
    if (whErr || !wh) return { ok: false, error: whErr?.message || 'Webhook no encontrado.' };

    const cfg = loadConfig();
    const now = new Date().toISOString();
    const row = {
      title,
      body,
      image_url: String(input?.imageUrl || '').trim() || null,
      footer_text: String(input?.footerText || '').trim() || null,
      embed_color: String(input?.embedColor || '#e07000').trim() || '#e07000',
      webhook_id: webhookId,
      channel_name: wh.name,
      bot_name: cfg.discordBotName || 'Almost Bot',
      bot_avatar_url: cfg.discordBotAvatarUrl || null,
      status: 'scheduled',
      error_text: null,
      sent_at: null,
      scheduled_at: when.toISOString(),
      created_at: now,
      updated_at: now,
    };
    const { data, error } = await supabase.from('discord_announcements').insert(row).select().single();
    if (error) return { ok: false, error: error.message };
    saveLog('info', `Anuncio programado: ${title} → #${wh.name} (${when.toISOString()})`);
    return { ok: true, data };
  });

  // Editar un anuncio que todavía está programado.
  ipcMain.handle('discord-announcements-update', async (_, { id, data }) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const { data: existing, error: exErr } = await supabase.from('discord_announcements').select('*').eq('id', id).maybeSingle();
    if (exErr || !existing) return { ok: false, error: exErr?.message || 'Anuncio no encontrado.' };
    if (existing.status !== 'scheduled') return { ok: false, error: 'Solo se pueden editar anuncios programados.' };

    const patch = { updated_at: new Date().toISOString() };
    if (data?.title !== undefined) {
      const t = String(data.title || '').trim();
      if (!t) return { ok: false, error: 'El título es obligatorio.' };
      patch.title = t;
    }
    if (data?.body !== undefined) {
      const b = String(data.body || '').trim();
      if (!b) return { ok: false, error: 'El mensaje es obligatorio.' };
      patch.body = b;
    }
    if (data?.imageUrl !== undefined) patch.image_url = String(data.imageUrl || '').trim() || null;
    if (data?.footerText !== undefined) patch.footer_text = String(data.footerText || '').trim() || null;
    if (data?.embedColor !== undefined) patch.embed_color = String(data.embedColor || '#e07000').trim() || '#e07000';
    if (data?.webhookId) {
      const { data: wh } = await supabase.from('discord_webhooks').select('*').eq('id', data.webhookId).maybeSingle();
      if (!wh) return { ok: false, error: 'Webhook no encontrado.' };
      patch.webhook_id = data.webhookId;
      patch.channel_name = wh.name;
    }
    if (data?.scheduledAt !== undefined) {
      const when = new Date(data.scheduledAt || '');
      if (isNaN(when.getTime())) return { ok: false, error: 'Fecha de programación inválida.' };
      if (when.getTime() < Date.now() + 30 * 1000) return { ok: false, error: 'La fecha debe ser al menos 30 segundos en el futuro.' };
      patch.scheduled_at = when.toISOString();
    }
    const { data: row, error } = await supabase.from('discord_announcements')
      .update(patch).eq('id', id).eq('status', 'scheduled').select().maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!row) return { ok: false, error: 'El anuncio ya no se puede editar.' };
    return { ok: true, data: row };
  });

  // Enviar ahora un anuncio programado o reintentar uno fallido.
  ipcMain.handle('discord-announcements-send-now', async (_, id) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const { data: claimed } = await supabase.from('discord_announcements')
      .update({ status: 'sending' })
      .eq('id', id)
      .in('status', ['scheduled', 'failed'])
      .select()
      .maybeSingle();
    if (!claimed) return { ok: false, error: 'El anuncio ya no está disponible para enviar.' };
    const result = await deliverAnnouncementRow(supabase, claimed, saveLog);
    return { ok: result.ok, data: result.row, error: result.ok ? undefined : result.error };
  });

  ipcMain.handle('discord-announcements-delete', async (_, id) => {
    const supabase = state.supabase;
    if (!supabase) return { ok: false, error: 'Sin conexión a Supabase.' };
    const { error } = await supabase.from('discord_announcements').delete().eq('id', id);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  });

  // Scheduler de anuncios programados (corre en el proceso principal).
  startAnnouncementScheduler({ state, saveLog, notify });
}

module.exports = { registerContentIpc };
