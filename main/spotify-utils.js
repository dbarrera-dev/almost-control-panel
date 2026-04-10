const { httpsRequest } = require('./net');

async function getSpotifyAccessToken(clientId, clientSecret, refreshToken) {
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await httpsRequest('POST', 'accounts.spotify.com', '/api/token',
    { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  return r.data;
}


function parseSpotifyLink(input) {
  if (!input) return null;
  const s = String(input).trim();
  // spotify:track:ID
  const uriMatch = s.match(/^spotify:track:([a-zA-Z0-9]+)$/);
  if (uriMatch) return `spotify:track:${uriMatch[1]}`;
  // https://open.spotify.com/track/ID or /intl-xx/track/ID
  const urlMatch = s.match(/open\.spotify\.com\/(?:intl-[a-z]{2}\/)?track\/([a-zA-Z0-9]+)/i);
  if (urlMatch) return `spotify:track:${urlMatch[1]}`;
  return null;
}

function parseYouTubeLink(input) {
  if (/music\.youtube\.com\/watch/i.test(input)) return 'ytmusic';
  if (/(:www\.)youtube\.com\/watch|youtu\.be\//i.test(input)) return 'youtube';
  return null;
}

async function youtubeToSpotifyQuery(url) {
  try {
    const r = await httpsRequest('GET', 'www.youtube.com',
      `/oembed?url=${encodeURIComponent(url)}&format=json`,
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    if (!r.data?.title) return null;
    const rawTitle = r.data.title;
    const rawAuthor = (r.data.author_name || '').replace(/ - Topic$/i, '').trim();

    const title = stripNoise(rawTitle) || rawTitle.trim();
    const author = stripNoise(rawAuthor) || rawAuthor.trim();

    const dashMatch = title.match(/^(.+?)\s*[|:\-]\s*(.+)$/);
    if (dashMatch) {
      const left = dashMatch[1].trim();
      const right = dashMatch[2].trim();
      return `${left} - ${right}`;
    }

    if (author && !title.toLowerCase().includes(author.toLowerCase())) {
      return `${title} ${author}`;
    }
    return title;
  } catch { return null; }
}


// Palabras que indican versión no estudio — se penalizan fuerte
const LIVE_KEYWORDS = [
  'live', 'en vivo', 'en directo', 'directo', 'concert', 'tour', 'festival',
  'acoustic', 'acústico', 'unplugged', 'session', 'sessions', 'radio edit',
  'cover', 'tribute', 'karaoke', 'instrumental version', 'demo', 'rehearsal',
  'rehersal', 'bootleg', 'home recording', 'bedroom', 'stripped',
];

// Palabras que indican versión alternativa — se penalizan levemente
const ALT_KEYWORDS = [
  'remix', 'rmx', 'edit', 'version', 'versión', 'remaster', 'remastered',
  'anniversary', 'aniversario', 'deluxe', 'extended', 'bonus', 'reprise',
  'interlude', 'skit', 'intro', 'outro',
];

// Palabras ruidosas tipicas de titulos de YouTube que no ayudan a buscar
const NOISE_WORDS = [
  'official', 'video', 'lyrics', 'lyric', 'audio', 'visualizer', 'mv', 'clip',
  'hq', 'hd', '4k', 'oficial', 'video oficial', 'audio oficial', 'letra',
  'letras', 'subtitulado', 'subtitulos', 'official music video', 'lyric video',
  'visualizer video', 'audio video',
];

function stripNoise(str) {
  if (!str) return '';
  let s = String(str);
  s = s.replace(/[\u2013\u2014\u2212]/g, '-');
  s = s.replace(/\u2022/g, '-');
  // Quitar contenido entre parentesis/corchetes
  s = s.replace(/[\(\[\{].*?[\)\]\}]/g, ' ');
  // Quitar comillas y caracteres raros
  s = s.replace(/["']/g, ' ');
  // Eliminar palabras ruidosas
  const noiseRe = new RegExp(`\\b(${NOISE_WORDS.join('|')})\\b`, 'gi');
  s = s.replace(noiseRe, ' ');
  s = s.replace(/\b(feat\.?|ft\.?|featuring)\b/gi, ' ');
  // Normalizar espacios
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function normalizeText(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreTextMatch(haystackRaw, needleRaw, maxScore) {
  const h = normalizeText(haystackRaw);
  const n = normalizeText(stripNoise(needleRaw));
  if (!n) return 0;
  if (h === n) return maxScore;
  if (h.startsWith(n)) return Math.round(maxScore * 0.85);
  if (h.includes(n)) return Math.round(maxScore * 0.7);
  const nWords = n.split(' ').filter(w => w.length > 1);
  if (!nWords.length) return 0;
  const matched = nWords.filter(w => h.includes(w)).length;
  return Math.round((matched / nWords.length) * maxScore * 0.6);
}

function scorePenalties(track, queryRaw) {
  let penalty = 0;
  const nameLower = normalizeText(track.name);
  const albumLower = normalizeText(track.album?.name || '');
  const qLower = normalizeText(queryRaw || '');
  const wantsLive = LIVE_KEYWORDS.some(kw => qLower.includes(normalizeText(kw)));
  const wantsAlt = ALT_KEYWORDS.some(kw => qLower.includes(normalizeText(kw)));

  const hasLive = LIVE_KEYWORDS.some(kw => nameLower.includes(normalizeText(kw)) || albumLower.includes(normalizeText(kw)));
  const hasAlt = ALT_KEYWORDS.some(kw => nameLower.includes(normalizeText(kw)) || albumLower.includes(normalizeText(kw)));

  if (hasLive) penalty += wantsLive ? -5 : -40;
  if (hasAlt) penalty += wantsAlt ? -5 : -15;
  if (wantsLive && hasLive) penalty += 5;
  if (wantsAlt && hasAlt) penalty += 5;

  if (/[\(\[\{]/.test(track.name)) penalty += wantsAlt ? -2 : -5;
  return penalty;
}

function scoreTrackParts(track, a, b, queryRaw) {
  const titleScore = scoreTextMatch(track.name, a, 60);
  const artists = track.artists.map(artist => artist.name).join(' ');
  const artistScore = scoreTextMatch(artists, b, 35);
  let score = titleScore + artistScore;
  if (titleScore >= 45 && artistScore >= 20) score += 10; // match fuerte en ambos
  if (typeof track.popularity === 'number') score += Math.round(track.popularity / 12);
  score += scorePenalties(track, queryRaw);
  return score;
}

function tokenOverlapScore(queryRaw, targetRaw, maxScore) {
  const qTokens = normalizeText(stripNoise(queryRaw)).split(' ').filter(w => w.length > 1);
  const tTokens = normalizeText(targetRaw).split(' ').filter(w => w.length > 1);
  if (!qTokens.length || !tTokens.length) return 0;
  const tSet = new Set(tTokens);
  const matched = qTokens.filter(w => tSet.has(w)).length;
  return Math.round((matched / qTokens.length) * maxScore);
}

// Calcula qué tan parecido es el nombre del track + artistas al query
// Devuelve un score de 0-100 (mayor = mejor)
function scoreTrack(track, queryRaw, parts) {
  const q = normalizeText(stripNoise(queryRaw));
  const trackNameNorm = normalizeText(track.name);
  const artists = track.artists.map(a => a.name);
  const artistStr = normalizeText(artists.join(' '));
  let score = 0;

  //  Coincidencia nombre del track 
  if (trackNameNorm === q) score += 60;
  else if (trackNameNorm.startsWith(q)) score += 50;
  else if (trackNameNorm.includes(q)) score += 40;
  else {
    // Coincidencia por palabras del query en el nombre
    const qWords = q.split(' ').filter(w => w.length > 1);
    if (qWords.length) {
      const matchedInName = qWords.filter(w => trackNameNorm.includes(w)).length;
      score += Math.round((matchedInName / qWords.length) * 30);
    }
  }

  //  Bonus si el artista aparece en el query 
  const artistWords = artistStr.split(' ').filter(w => w.length > 2);
  const artistInQuery = artistWords.filter(w => q.includes(w)).length;
  if (artistInQuery > 0) score += Math.min(20, artistInQuery * 10);

  //  Bonus popularidad Spotify (0-100  0-10 pts) 
  if (typeof track.popularity === 'number') score += Math.round(track.popularity / 10);

  score += scorePenalties(track, queryRaw);
  score += tokenOverlapScore(queryRaw, track.name, 25);
  score += tokenOverlapScore(queryRaw, artists.join(' '), 15);

  // Si hay partes (titulo/artista) comparar ambos rdenes y usar el mejor
  if (parts && parts.length === 2) {
    const [a, b] = parts;
    const p1 = scoreTrackParts(track, a, b, queryRaw);
    const p2 = scoreTrackParts(track, b, a, queryRaw);
    score = Math.max(score, p1, p2);
  }

  return score;
}


// Extrae las dos partes cuando el usuario escribe "A - B" o "A por B"
// No asume cual es título y cual artista — prueba los dos órdenes
function splitQuery(q) {
  const dashMatch = q.match(/^(.+?)\s*[|:\/\-]\s*(.+)$/);
  if (dashMatch) return [dashMatch[1].trim(), dashMatch[2].trim()];
  // "titulo por artista"  poco comn pero por si acaso
  const porMatch = q.match(/^(.+)\s+por\s+(.+)$/i);
  if (porMatch) return [porMatch[1].trim(), porMatch[2].trim()];
  const byMatch = q.match(/^(.+)\s+by\s+(.+)$/i);
  if (byMatch) return [byMatch[1].trim(), byMatch[2].trim()];
  const deMatch = q.match(/^(.+)\s+de\s+(.+)$/i);
  if (deMatch) return [deMatch[1].trim(), deMatch[2].trim()];
  return null;
}


async function searchSpotifyTrack(query, accessToken) {
  const headers = { 'Authorization': `Bearer ${accessToken}` };
  const qRaw = query.trim();
  const q = stripNoise(qRaw) || qRaw;
  let candidates = [];

  const fetchTracks = async (endpoint) => {
    const r = await httpsRequest('GET', 'api.spotify.com', endpoint, headers);
    return r.data?.tracks?.items || [];
  };

  const parts = splitQuery(q);

  if (parts) {
    const [a, b] = parts;
    // Prueba los dos ordenes: "titulo - artista" y "artista - titulo"
    const [r1, r2] = await Promise.all([
      fetchTracks(`/v1/search?q=${encodeURIComponent(`track:${a} artist:${b}`)}&type=track&limit=6&market=from_token`),
      fetchTracks(`/v1/search?q=${encodeURIComponent(`track:${b} artist:${a}`)}&type=track&limit=6&market=from_token`),
    ]);
    candidates.push(...r1, ...r2);
  }

  if (!parts) {
    const tokens = normalizeText(q).split(' ').filter(w => w.length > 1);
    if (tokens.length >= 2 && tokens.length <= 7) {
      const pairs = [];
      const pushPair = (artistTokens, titleTokens) => {
        if (!artistTokens.length || !titleTokens.length) return;
        pairs.push([titleTokens.join(' '), artistTokens.join(' ')]);
      };
      // Artist primero / ultimo
      pushPair([tokens[0]], tokens.slice(1));
      pushPair([tokens[tokens.length - 1]], tokens.slice(0, -1));
      if (tokens.length >= 3) {
        pushPair(tokens.slice(0, 2), tokens.slice(2));
        pushPair(tokens.slice(-2), tokens.slice(0, -2));
      }
      const seenPairs = new Set();
      const uniqPairs = pairs.filter(([t, a]) => {
        const key = `${t}|||${a}`;
        if (seenPairs.has(key)) return false;
        seenPairs.add(key);
        return true;
      });
      for (const [t, a] of uniqPairs) {
        const r = await fetchTracks(`/v1/search?q=${encodeURIComponent(`track:${t} artist:${a}`)}&type=track&limit=6&market=from_token`);
        candidates.push(...r);
      }
    }

    const trackOnly = await fetchTracks(`/v1/search?q=${encodeURIComponent(`track:${q}`)}&type=track&limit=10&market=from_token`);
    candidates.push(...trackOnly);
  }

  // Busqueda libre con el query completo (mas resultados para tener mas candidatos)
  const free = await fetchTracks(`/v1/search?q=${encodeURIComponent(q)}&type=track&limit=12&market=from_token`);
  candidates.push(...free);

  // Si aun hay pocos, buscar solo con palabras clave (por si hay typos o guiones pegados)
  if (candidates.length < 5) {
    const simplified = normalizeText(q).replace(/\s+/g, ' ');
    const extra = await fetchTracks(`/v1/search?q=${encodeURIComponent(simplified)}&type=track&limit=12&market=from_token`);
    candidates.push(...extra);
  }

  // Si el query limpio difiere mucho, intentar con el raw
  if (candidates.length < 8 && q !== qRaw) {
    const raw = await fetchTracks(`/v1/search?q=${encodeURIComponent(qRaw)}&type=track&limit=10&market=from_token`);
    candidates.push(...raw);
  }

  if (!candidates.length) return null;

  // Deduplicar por track ID
  const seen = new Set();
  candidates = candidates.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });

  // Ordenar por score descendente
  const scored = candidates.map(t => ({ t, score: scoreTrack(t, q, parts) }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  best.t._score = best.score;
  return best.t;
}


async function spotifyGetTrackName(clientId, clientSecret, refreshToken, trackUri) {
  try {
    const tokenData = await getSpotifyAccessToken(clientId, clientSecret, refreshToken);
    if (!tokenData.access_token) return null;
    const trackId = trackUri.split(':')[2];
    const r = await httpsRequest('GET', 'api.spotify.com', `/v1/tracks/${trackId}`,
      { 'Authorization': `Bearer ${tokenData.access_token}` });
    if (!r.data.name) return null;
    const artists = (r.data.artists || []).map(a => a.name).join(', ');
    return `${r.data.name} — ${artists}`;
  } catch { return null; }
}


module.exports = {
  getSpotifyAccessToken,
  parseSpotifyLink,
  parseYouTubeLink,
  youtubeToSpotifyQuery,
  searchSpotifyTrack,
  spotifyGetTrackName,
};
