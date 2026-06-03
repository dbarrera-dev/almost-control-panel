const { httpsRequest } = require('./net');

async function getSpotifyAccessToken(clientId, clientSecret, refreshToken) {
  const body = `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`;
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await httpsRequest(
    'POST',
    'accounts.spotify.com',
    '/api/token',
    { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  );
  return r.data;
}

function parseSpotifyResource(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  const uriMatch = s.match(/spotify:(track|album|playlist|artist|episode|show):([a-zA-Z0-9]+)/i);
  if (uriMatch) {
    const type = String(uriMatch[1] || '').toLowerCase();
    const id = String(uriMatch[2] || '').trim();
    if (type && id) return { type, id, uri: `spotify:${type}:${id}` };
  }

  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      const host = String(u.hostname || '').toLowerCase();
      if (host === 'open.spotify.com' || host === 'play.spotify.com') {
        const parts = String(u.pathname || '').split('/').filter(Boolean);
        while (parts.length && /^intl-[a-z0-9-]+$/i.test(parts[0])) parts.shift();
        if (parts[0] && /^embed(?:-podcast)?$/i.test(parts[0])) parts.shift();
        const type = String(parts[0] || '').toLowerCase();
        const id = String(parts[1] || '').trim();
        if (/^(track|album|playlist|artist|episode|show)$/i.test(type) && /^[a-zA-Z0-9]+$/.test(id)) {
          return { type, id, uri: `spotify:${type}:${id}` };
        }
      }
    }
  } catch {}

  const urlMatch = s.match(/(?:https?:\/\/)?(?:open|play)\.spotify\.com\/(?:intl-[a-z0-9-]+\/)?(?:embed(?:-podcast)?\/)?(track|album|playlist|artist|episode|show)\/([a-zA-Z0-9]+)/i);
  if (urlMatch) {
    const type = String(urlMatch[1] || '').toLowerCase();
    const id = String(urlMatch[2] || '').trim();
    if (type && id) return { type, id, uri: `spotify:${type}:${id}` };
  }

  return null;
}

function parseSpotifyLink(input) {
  const parsed = parseSpotifyResource(input);
  if (!parsed || parsed.type !== 'track') return null;
  return parsed.uri;
}

function parseYouTubeLink(input) {
  const s = String(input || '');
  if (/music\.youtube\.com\/watch/i.test(s)) return 'ytmusic';
  if (/(?:www\.)?youtube\.com\/watch|youtu\.be\//i.test(s)) return 'youtube';
  return null;
}

function parseYouTubeResource(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  let url = null;
  try {
    if (/^https?:\/\//i.test(raw)) url = new URL(raw);
  } catch {
    url = null;
  }
  if (!url) return null;

  const host = String(url.hostname || '').toLowerCase();
  const path = String(url.pathname || '');
  const isYouTubeHost = host.includes('youtube.com') || host === 'youtu.be';
  if (!isYouTubeHost) return null;

  const isMusic = host.startsWith('music.');
  const listId = String(url.searchParams.get('list') || '').trim();
  const hasVideoId =
    !!String(url.searchParams.get('v') || '').trim()
    || (host === 'youtu.be' && path.length > 1)
    || /\/shorts\/[^/]+/i.test(path);
  const playlistInPath = /\/playlist/i.test(path);
  const browseInPath = /\/browse/i.test(path);
  const listLooksAlbum = /^OLAK5uy/i.test(listId) || /^MPREb/i.test(listId);

  if (playlistInPath || (listId && !hasVideoId)) {
    return { platform: isMusic ? 'ytmusic' : 'youtube', kind: listLooksAlbum ? 'album' : 'playlist' };
  }
  if (browseInPath && (listId || /^MPREb/i.test(String(url.searchParams.get('browseId') || '')))) {
    return { platform: 'ytmusic', kind: listLooksAlbum ? 'album' : 'playlist' };
  }
  if (hasVideoId) {
    return { platform: isMusic ? 'ytmusic' : 'youtube', kind: 'video' };
  }

  return { platform: isMusic ? 'ytmusic' : 'youtube', kind: 'unknown' };
}

const NOISE_WORDS = [
  'official', 'video', 'lyrics', 'lyric', 'audio', 'visualizer', 'mv', 'clip',
  'hq', 'hd', '4k', 'oficial', 'video oficial', 'audio oficial', 'letra',
  'letras', 'subtitulado', 'subtitulos', 'official music video', 'lyric video',
  'visualizer video', 'audio video',
];

const REQUEST_PREFIX_RE = /^(?:pon(?:e|eme|me)?|reproduce|reproduc[ií]|play|busca|quiero(?:\s+escuchar)?|please|pls)\s+/i;

const VARIANT_GROUPS = {
  remix: ['remix', 'rmx', 'bootleg', 'edit', 'vip mix', 'mix'],
  live: ['live', 'en vivo', 'en directo', 'directo', 'concert', 'festival', 'tour'],
  acoustic: ['acoustic', 'acustic', 'acustico', 'unplugged', 'session', 'stripped'],
  speed: ['sped up', 'speed up', 'slowed', 'nightcore', '8d'],
  alt: ['remaster', 'remastered', 'anniversary', 'deluxe', 'version', 'bonus track'],
  karaoke: ['karaoke'],
  instrumental: ['instrumental', 'instrumental version'],
  cover: ['cover', 'tribute'],
};

const SEARCH_FALLBACK_MARKETS = [null, 'US', 'AR', 'UY', 'ES', 'MX', 'BR'];
const SEARCH_FAST_FALLBACK_MARKETS = [null, 'US'];
const SEARCH_FAST_FIRST_QUERY_LIMIT = 3;
const SEARCH_FAST_STRATEGY_LIMIT = 8;
const SEARCH_DEEP_STRATEGY_LIMIT = 6;
const SPOTIFY_SEARCH_MAX_LIMIT = 10;

function clampSearchLimit(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return SPOTIFY_SEARCH_MAX_LIMIT;
  return Math.max(1, Math.min(SPOTIFY_SEARCH_MAX_LIMIT, Math.round(num)));
}

function cleanUserText(str) {
  if (!str) return '';
  let s = String(str).trim();
  s = s.replace(/[\u2013\u2014\u2212]/g, '-');
  s = s.replace(/\u2022/g, '-');
  s = s.replace(/[\u00a1\u00bf]/g, ' ');
  s = s.replace(/[^\p{L}\p{N}\s\-|:/'&().]/gu, ' ');
  s = s.replace(REQUEST_PREFIX_RE, '');
  const noiseRe = new RegExp(`\\b(${NOISE_WORDS.join('|')})\\b`, 'gi');
  s = s.replace(noiseRe, ' ');
  s = s.replace(/\b(feat\.?|ft\.?|featuring)\b/gi, ' feat ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function normalizeText(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normalizeText(text).split(' ').filter(t => t.length > 1);
}

function overlapRatio(a, b) {
  const at = tokens(a);
  const bt = new Set(tokens(b));
  if (!at.length || !bt.size) return 0;
  const hit = at.filter(t => bt.has(t)).length;
  return hit / at.length;
}

function tokenSetRatio(a, b) {
  const setA = new Set(tokens(a));
  const setB = new Set(tokens(b));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  setA.forEach((t) => { if (setB.has(t)) inter++; });
  return (2 * inter) / (setA.size + setB.size);
}

function fuzzyTokenStats(queryText, candidateText) {
  const qTokens = tokens(queryText);
  const cTokens = tokens(candidateText);
  if (!qTokens.length || !cTokens.length) {
    return { avg: 0, min: 0, strongRatio: 0, exactRatio: 0, count: qTokens.length };
  }

  const bestByQuery = qTokens.map((qToken) => {
    let best = 0;
    for (const cToken of cTokens) {
      const ratio = fuzzyRatio(qToken, cToken);
      if (ratio > best) best = ratio;
      if (best >= 0.999) break;
    }
    return best;
  });

  const sum = bestByQuery.reduce((acc, value) => acc + value, 0);
  const avg = sum / bestByQuery.length;
  const min = Math.min(...bestByQuery);
  const strongRatio = bestByQuery.filter((value) => value >= 0.72).length / bestByQuery.length;
  const exactRatio = bestByQuery.filter((value) => value >= 0.96).length / bestByQuery.length;
  return { avg, min, strongRatio, exactRatio, count: bestByQuery.length };
}

function betterTokenStats(primary, secondary) {
  if (!primary) return secondary || { avg: 0, min: 0, strongRatio: 0, exactRatio: 0, count: 0 };
  if (!secondary) return primary;
  if (secondary.avg > primary.avg) return secondary;
  if (secondary.avg < primary.avg) return primary;
  if (secondary.min > primary.min) return secondary;
  return primary;
}

function titleOnlyMatchSignals(intentText, trackName, artistsText = '') {
  const query = normalizeText(intentText);
  const title = normalizeText(trackName);
  const combined = normalizeText(`${trackName || ''} ${artistsText || ''}`.trim());
  const titleStats = fuzzyTokenStats(query, title);
  const combinedStats = fuzzyTokenStats(query, combined);
  const stats = betterTokenStats(titleStats, combinedStats);
  const overlap = Math.max(overlapRatio(query, title), overlapRatio(query, combined));
  const fuzzy = Math.max(fuzzyRatio(query, title), fuzzyRatio(query, combined));
  return { stats, overlap, fuzzy };
}

function isWeakTitleOnlyCandidate(track, intent) {
  if (!track || intent?.type !== 'title_only') return false;
  const query = normalizeText(intent.clean || intent.title || intent.raw || '');
  const queryTokens = tokens(query);
  if (queryTokens.length < 2 || query.length < 7) return false;
  const artistsText = (track.artists || []).map(a => a?.name || '').join(' ');
  const signals = titleOnlyMatchSignals(query, track.name || '', artistsText);
  const { stats, overlap, fuzzy } = signals;
  if ((stats.count || 0) >= 2 && stats.min < 0.18) return true;
  if ((stats.count || 0) >= 2 && stats.min < 0.32 && stats.avg < 0.69 && overlap < 0.66 && fuzzy < 0.70) {
    return true;
  }
  return false;
}

function levenshteinDistance(a, b) {
  const s = normalizeText(a);
  const t = normalizeText(b);
  const n = s.length;
  const m = t.length;
  if (!n) return m;
  if (!m) return n;

  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[n][m];
}

function fuzzyRatio(a, b) {
  const sa = normalizeText(a);
  const sb = normalizeText(b);
  if (!sa || !sb) return 0;
  const maxLen = Math.max(sa.length, sb.length);
  if (!maxLen) return 0;
  const dist = levenshteinDistance(sa, sb);
  return Math.max(0, 1 - (dist / maxLen));
}

function titleMatchScore(trackName, wantedTitle) {
  const trackNorm = normalizeText(trackName);
  const wantedNorm = normalizeText(wantedTitle);
  if (!wantedNorm) return 0;
  if (trackNorm === wantedNorm) return 130;
  if (trackNorm.startsWith(wantedNorm)) return 105;
  if (trackNorm.includes(wantedNorm)) return 80;
  const overlap = overlapRatio(wantedNorm, trackNorm);
  const setRatio = tokenSetRatio(wantedNorm, trackNorm);
  const fuzzy = fuzzyRatio(wantedNorm, trackNorm);
  const tokenStats = fuzzyTokenStats(wantedNorm, trackNorm);
  let typoScore = tokenStats.avg * 68;
  if (tokenStats.min >= 0.72) typoScore += 26;
  else if (tokenStats.min >= 0.60) typoScore += 12;
  else if (tokenStats.count >= 2) typoScore -= (0.60 - tokenStats.min) * 85;
  typoScore += tokenStats.exactRatio * 10;
  return Math.round(Math.max(overlap * 60, setRatio * 72, fuzzy * 55, typoScore));
}

function artistMatchScore(artists, wantedArtist) {
  if (!wantedArtist) return 0;
  const allArtists = artists.join(' ');
  const allNorm = normalizeText(allArtists);
  const wantedNorm = normalizeText(wantedArtist);
  if (!wantedNorm) return 0;
  if (allNorm === wantedNorm) return 95;
  if (allNorm.includes(wantedNorm)) return 80;
  const overlap = overlapRatio(wantedNorm, allNorm);
  const setRatio = tokenSetRatio(wantedNorm, allNorm);
  const fuzzy = fuzzyRatio(wantedNorm, allNorm);
  return Math.round(Math.max(overlap * 70, setRatio * 78, fuzzy * 60));
}

function requestedVariants(queryRaw) {
  const q = normalizeText(queryRaw);
  const wants = {};
  for (const [group, words] of Object.entries(VARIANT_GROUPS)) {
    wants[group] = words.some(w => q.includes(normalizeText(w)));
  }
  return wants;
}

function variantPenalty(track, wants) {
  const name = normalizeText(track.name);
  const album = normalizeText(track.album?.name || '');
  const txt = `${name} ${album}`.trim();

  let penalty = 0;
  for (const [group, words] of Object.entries(VARIANT_GROUPS)) {
    const found = words.some(w => txt.includes(normalizeText(w)));
    if (!found) continue;
    if (wants[group]) {
      penalty += 8;
      continue;
    }
    if (group === 'alt') penalty -= 55;
    else if (group === 'remix') penalty -= 85;
    else penalty -= 120;
  }

  if (/[\(\[]/.test(track.name) && !Object.values(wants).some(Boolean)) {
    penalty -= 8;
  }
  return penalty;
}

function parseIntent(rawQuery) {
  const raw = String(rawQuery || '').trim();
  const clean = cleanUserText(raw);

  const dash = clean.match(/^(.+?)\s*[-|:]\s*(.+)$/);
  if (dash) {
    return {
      raw,
      clean,
      type: 'split_ambiguous',
      partA: dash[1].trim(),
      partB: dash[2].trim(),
    };
  }

  const by = clean.match(/^(.+?)\s+by\s+(.+)$/i);
  if (by) {
    return { raw, clean, type: 'title_artist', title: by[1].trim(), artist: by[2].trim() };
  }

  const por = clean.match(/^(.+?)\s+por\s+(.+)$/i);
  if (por) {
    return { raw, clean, type: 'title_artist', title: por[1].trim(), artist: por[2].trim() };
  }

  return { raw, clean, type: 'title_only', title: clean || raw };
}

function buildNoSeparatorPairs(text) {
  const tks = tokens(text);
  if (tks.length < 2 || tks.length > 8) return [];
  const pairs = [];

  const pushPair = (titleArr, artistArr, weight) => {
    if (!titleArr.length || !artistArr.length) return;
    pairs.push({
      title: titleArr.join(' '),
      artist: artistArr.join(' '),
      weight,
    });
  };

  const maxCut = tks.length === 2 ? 1 : Math.min(3, tks.length - 1);
  for (let cut = 1; cut <= maxCut; cut++) {
    const artistFirstWeight = tks.length === 2 ? 12 : 19;
    const artistLastWeight = tks.length === 2 ? 10 : 17;
    pushPair(tks.slice(cut), tks.slice(0, cut), artistFirstWeight); // artista primero
    pushPair(tks.slice(0, tks.length - cut), tks.slice(tks.length - cut), artistLastWeight); // artista último
  }

  const seen = new Set();
  return pairs.filter(p => {
    const key = `${p.title}|||${p.artist}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getIntentMappings(intent) {
  if (intent.type === 'title_artist' || intent.type === 'artist_title') {
    return [{ title: intent.title, artist: intent.artist, bias: 0 }];
  }
  if (intent.type === 'split_ambiguous') {
    return [
      { title: intent.partA, artist: intent.partB, bias: 0 },   // prioridad: título - artista
      { title: intent.partB, artist: intent.partA, bias: -15 }, // fallback: artista - título
    ];
  }
  return [{ title: intent.title || intent.clean, artist: '', bias: 0 }];
}

function buildSearchStrategies(intent) {
  const strategies = [];
  const seen = new Set();

  const add = (q, limit, weight) => {
    const key = `${q}|||${limit}`;
    if (!q || seen.has(key)) return;
    seen.add(key);
    strategies.push({ q, limit, weight });
  };

  const mappings = getIntentMappings(intent);
  mappings.forEach(m => {
    if (!m.artist) return;
    add(`track:"${m.title}" artist:"${m.artist}"`, 10, 40 + m.bias);
    add(`track:${m.title} artist:${m.artist}`, 10, 34 + m.bias);
    add(`${m.artist} ${m.title}`, 12, 28 + m.bias);
  });

  const baseTitle = mappings[0]?.title || intent.clean;
  add(`track:"${baseTitle}"`, 12, 34);
  add(`track:${baseTitle}`, 12, 28);
  add(intent.clean, 15, 24);

  if (intent.type === 'title_only') {
    const guessedPairs = buildNoSeparatorPairs(intent.clean);
    guessedPairs.forEach(p => {
      add(`track:${p.title} artist:${p.artist}`, 8, p.weight);
    });

    // Fallback robusto: ampliar búsqueda por tokens largos cuando no hay match claro.
    const titleTokens = tokens(intent.clean).filter(t => t.length >= 4);
    titleTokens.forEach((t) => add(t, 8, 10));
    if (titleTokens.length >= 2) {
      add(titleTokens.slice(0, 2).join(' '), 10, 12);
      add(titleTokens.slice(-2).join(' '), 10, 11);
    }
  }

  return strategies;
}

function isClearlyCorrectFirstResult(track, intent) {
  if (!track) return false;
  const trackArtists = (track.artists || []).map(a => a.name || '');
  const wants = requestedVariants(intent.raw);
  if (variantPenalty(track, wants) < -90) return false;

  const mappings = getIntentMappings(intent);
  for (const m of mappings) {
    const titleScore = titleMatchScore(track.name, m.title);
    if (m.artist) {
      const artistScore = artistMatchScore(trackArtists, m.artist);
      if (titleScore >= 105 && artistScore >= 70) return true;
    } else if (titleScore >= 120) {
      return true;
    }
  }
  return false;
}

function scoreTrack(track, context) {
  const { intent, sourceWeight, resultIndex } = context;
  const artists = (track.artists || []).map(a => a.name || '');
  const wants = requestedVariants(intent.raw);
  const mappings = getIntentMappings(intent);

  let score = 0;
  let bestMappingScore = -Infinity;

  mappings.forEach(m => {
    const tScore = titleMatchScore(track.name, m.title);
    const aScore = m.artist ? artistMatchScore(artists, m.artist) : 0;
    let local = tScore + aScore + (m.bias || 0);
    if (m.artist) {
      const strictArtistRatio = overlapRatio(m.artist, artists.join(' '));
      if (strictArtistRatio < 0.25) local -= 120;
    }
    if (local > bestMappingScore) bestMappingScore = local;
  });

  score += bestMappingScore;
  score += sourceWeight;
  score += Math.max(0, 22 - (resultIndex * 3));
  score += Math.round((Number(track.popularity) || 0) / 14);
  const combinedText = `${track.name || ''} ${artists.join(' ')}`.trim();
  const overlap = overlapRatio(intent.clean, combinedText);
  const titleSignals = titleOnlyMatchSignals(intent.clean, track.name || '', artists.join(' '));
  const titleTokenStats = titleSignals.stats;
  let lexicalBonus = Math.round(Math.max(overlap, titleSignals.overlap) * 28);
  if (intent.type === 'title_only') {
    lexicalBonus += Math.round((titleTokenStats.min * 20) + (titleTokenStats.strongRatio * 10));
    if (titleTokenStats.count >= 2 && titleTokenStats.min < 0.45 && titleTokenStats.avg < 0.63) {
      lexicalBonus -= 18;
    }
    if (titleTokenStats.count >= 2 && titleTokenStats.min < 0.22) {
      lexicalBonus -= 42;
    } else if (titleTokenStats.count >= 2 && titleTokenStats.min < 0.30 && titleTokenStats.avg < 0.68) {
      lexicalBonus -= 24;
    }
  }
  score += lexicalBonus;
  score += variantPenalty(track, wants);

  if (intent.type === 'title_only' && isWeakTitleOnlyCandidate(track, intent)) {
    score -= 65;
  }

  if (track?.is_playable === false) score -= 140;
  const restrictionReason = String(track?.restrictions?.reason || '').toLowerCase();
  if (restrictionReason === 'explicit') score -= 85;
  else if (restrictionReason) score -= 120;

  return score;
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function computeConfidence(bestScore, secondScore, isExactLike) {
  const gap = bestScore - secondScore;
  let confidence = 45;
  confidence += clamp((bestScore - 66) * 0.32, 0, 30);
  confidence += clamp(gap * 2.1, 0, 22);
  if (isExactLike) confidence += 12;
  return Math.round(clamp(confidence, 0, 100));
}

function isExactLikeMatch(track, intent) {
  const artists = (track.artists || []).map(a => a.name || '');
  const mappings = getIntentMappings(intent);
  return mappings.some(m => {
    const t = titleMatchScore(track.name, m.title);
    if (m.artist) {
      const a = artistMatchScore(artists, m.artist);
      return t >= 105 && a >= 70;
    }
    return t >= 120;
  });
}

async function youtubeToSpotifyQuery(url) {
  const meta = await youtubeToSpotifyMetadata(url);
  return meta?.ok && meta.query ? meta.query : null;
}

const YOUTUBE_UNRELIABLE_AUTHOR = /\b(unknown|various artists?|varios artistas?)\b/i;
const YOUTUBE_UNRELIABLE_TITLE = /\b(full album|playlist|mix|compilation|set\s+\d+h|live set|podcast)\b/i;
const YOUTUBE_PARODY_KEYWORDS = /\b(parody|parodia)\b/i;
const YOUTUBE_DERIVATIVE_HINTS = /\b(parody|parodia|karaoke|tribute|nightcore|sped up|speed up|slowed)\b/i;

function chooseArtistTitleFromSplit(partA, partB, fallbackArtist) {
  const a = String(partA || '').trim();
  const b = String(partB || '').trim();
  const fa = String(fallbackArtist || '').trim();
  if (!a || !b) return { artist: fa || a || b, title: b || a };
  if (!fa) return { artist: a, title: b }; // patrón más común en YouTube: "Artista - Canción"

  const scoreA = artistMatchScore([a], fa);
  const scoreB = artistMatchScore([b], fa);
  if (scoreA === scoreB) return { artist: a, title: b };
  if (scoreA > scoreB) return { artist: a, title: b };
  return { artist: b, title: a };
}

function extractOriginalFromParody(rawTitle) {
  const src = String(rawTitle || '').trim();
  if (!src || !YOUTUBE_PARODY_KEYWORDS.test(src)) return null;

  const normalized = src
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  const patterns = [
    /\bparod(?:y|ia)\s+(?:of|de)\s*["']?(.+?)["']?\s+(?:by|de)\s+([^)]+?)(?:\)|$)/i,
    /\((?:[^)]*?)\bparod(?:y|ia)\s+(?:of|de)\s*["']?(.+?)["']?\s+(?:by|de)\s+([^)]+?)\)/i,
  ];

  for (const re of patterns) {
    const match = normalized.match(re);
    if (!match) continue;
    const parsedTitle = cleanUserText(match[1] || '');
    const parsedArtist = cleanUserText(match[2] || '');
    if (tokens(parsedTitle).length >= 2 && tokens(parsedArtist).length >= 1) {
      return { title: parsedTitle, artist: parsedArtist };
    }
  }
  return null;
}

function isReliableYoutubeMeta({ title, artist, rawTitle = '', rawAuthor = '', resolvedFromParody = false }) {
  const cleanTitle = cleanUserText(title);
  const cleanArtist = cleanUserText(artist);
  if (!cleanTitle || !cleanArtist) return false;
  if (YOUTUBE_UNRELIABLE_AUTHOR.test(cleanArtist)) return false;
  if (YOUTUBE_UNRELIABLE_TITLE.test(cleanTitle)) return false;
  const rawCombined = `${rawTitle} ${rawAuthor}`.trim();
  if (!resolvedFromParody && YOUTUBE_DERIVATIVE_HINTS.test(rawCombined)) return false;
  const titleTokensLoose = normalizeText(cleanTitle).split(' ').filter(Boolean);
  const artistTokensLoose = normalizeText(cleanArtist).split(' ').filter(Boolean);
  // Tolerar títulos cortos tipo "I Drive" o "U", evitando vacíos/ruido.
  if (titleTokensLoose.length < 1) return false;
  if (titleTokensLoose.length < 2 && normalizeText(cleanTitle).length < 3) return false;
  if (artistTokensLoose.length < 1) return false;
  const overlap = overlapRatio(cleanTitle, cleanArtist);
  if (overlap > 0.8) return false;
  return true;
}

async function youtubeToSpotifyMetadata(url) {
  try {
    const r = await httpsRequest(
      'GET',
      'www.youtube.com',
      `/oembed?url=${encodeURIComponent(url)}&format=json`,
      { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    );
    if (!r.data?.title) {
      return { ok: false, reliable: false, reason: 'missing_title', query: null, title: '', artist: '' };
    }

    const rawTitle = String(r.data.title || '').trim();
    const rawAuthor = String(r.data.author_name || '').replace(/ - Topic$/i, '').trim();

    const cleanedTitle = cleanUserText(rawTitle) || rawTitle;
    const cleanedAuthor = cleanUserText(rawAuthor) || rawAuthor;

    let artist = cleanedAuthor;
    let title = cleanedTitle;
    let reason = null;
    const parodyOriginal = extractOriginalFromParody(rawTitle);
    if (parodyOriginal) {
      artist = parodyOriginal.artist;
      title = parodyOriginal.title;
      reason = 'parody_original_hint';
    } else {
      const split = cleanedTitle.match(/^(.+?)\s*[-|:]\s*(.+)$/);
      if (split) {
        const picked = chooseArtistTitleFromSplit(split[1], split[2], cleanedAuthor);
        artist = picked.artist;
        title = picked.title;
      }
    }

    const reliable = isReliableYoutubeMeta({
      title,
      artist,
      rawTitle,
      rawAuthor,
      resolvedFromParody: !!parodyOriginal,
    });
    const query = reliable ? `${artist} ${title}`.trim() : null;
    return {
      ok: !!query,
      reliable,
      reason: reliable ? reason : (reason || 'unreliable_metadata'),
      query,
      title,
      artist,
      rawTitle,
      rawAuthor,
    };
  } catch {
    return { ok: false, reliable: false, reason: 'oembed_failed', query: null, title: '', artist: '' };
  }
}

function buildFirstResultQueries(intent) {
  const out = [];
  const seen = new Set();
  const push = (q) => {
    const key = String(q || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(key);
  };

  const mappings = getIntentMappings(intent);
  mappings.forEach(m => {
    if (m.artist) {
      push(`track:${m.title} artist:${m.artist}`);
      push(`${m.artist} ${m.title}`);
      push(`${m.title} ${m.artist}`);
    } else {
      push(`track:${m.title}`);
      push(m.title);
    }
  });

  push(intent.clean);
  return out;
}

function withScoreMeta(track, score, confidence, source) {
  if (!track) return null;
  track._score = score;
  track._confidence = confidence;
  track._source = source;
  return track;
}

async function searchSpotifyTrack(query, accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return null;

  const intent = parseIntent(rawQuery);
  const strategies = buildSearchStrategies(intent);
  const collected = new Map();

  const searchCache = new Map();

  const fetchTracksSingle = async (searchQuery, limit, market) => {
    const safeLimit = clampSearchLimit(limit);
    const marketParam = market ? `&market=${encodeURIComponent(market)}` : '';
    const endpoint = `/v1/search?q=${encodeURIComponent(searchQuery)}&type=track&limit=${safeLimit}${marketParam}`;
    const r = await httpsRequest('GET', 'api.spotify.com', endpoint, headers);
    return {
      status: Number(r?.status || 0),
      items: r.data?.tracks?.items || [],
    };
  };

  const fetchTracks = async (searchQuery, limit, options = {}) => {
    const mode = options.mode === 'fast' ? 'fast' : 'full';
    const safeLimit = clampSearchLimit(limit);
    const key = `${mode}|||${searchQuery}|||${safeLimit}`;
    if (searchCache.has(key)) return searchCache.get(key);

    const merged = [];
    const seen = new Set();
    const addAll = (items) => {
      for (const item of items || []) {
        const id = String(item?.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(item);
      }
    };

    const primary = await fetchTracksSingle(searchQuery, safeLimit, null);
    addAll(primary.items);

    const fallbackMarkets = mode === 'fast' ? SEARCH_FAST_FALLBACK_MARKETS : SEARCH_FALLBACK_MARKETS;
    const fallbackTarget = mode === 'fast' ? Math.max(1, Math.min(2, safeLimit)) : Math.min(3, safeLimit);

    // Fast mode: abrir solo mercados mínimos para respuesta rápida.
    // Full mode: ampliar más para cubrir catálogos regionales.
    if (merged.length < fallbackTarget) {
      const candidates = fallbackMarkets.filter(Boolean);
      const parallelMarkets = mode === 'fast' ? candidates.slice(0, 2) : candidates.slice(0, 3);
      if (parallelMarkets.length) {
        const parallelResults = await Promise.all(
          parallelMarkets.map(market => fetchTracksSingle(searchQuery, safeLimit, market))
        );
        parallelResults.forEach(res => addAll(res.items));
      }
      if (mode === 'full' && merged.length < Math.max(safeLimit, 12)) {
        for (const market of candidates.slice(3)) {
          const extra = await fetchTracksSingle(searchQuery, safeLimit, market);
          addAll(extra.items);
          if (merged.length >= Math.max(safeLimit, 12)) break;
        }
      }
    }

    const out = merged.slice(0, Math.max(safeLimit, mode === 'fast' ? 10 : 20));
    searchCache.set(key, out);
    return out;
  };

  const pickBestFromCollected = () => {
    if (!collected.size) return null;
    const sorted = [...collected.values()].sort((a, b) => b.score - a.score);
    const best = sorted[0];
    if (!best?.track) return null;
    const second = sorted[1];
    const secondScore = second?.score ?? (best.score - 40);
    const exactLike = isExactLikeMatch(best.track, intent);
    const confidence = computeConfidence(best.score, secondScore, exactLike);
    return withScoreMeta(best.track, best.score, confidence, 'scored_fallback');
  };

  // 1) Spotify-like flow: tomar primera opción de búsquedas bien formadas.
  let bestFirst = null;
  const firstQueries = buildFirstResultQueries(intent).slice(0, SEARCH_FAST_FIRST_QUERY_LIMIT);
  for (const qFirst of firstQueries) {
    const top = (await fetchTracks(qFirst, 1, { mode: 'fast' }))[0];
    if (!top) continue;
    const score = scoreTrack(top, { intent, sourceWeight: 34, resultIndex: 0 });
    const exactLike = isExactLikeMatch(top, intent);
    const weakTitleOnly = isWeakTitleOnlyCandidate(top, intent);
    const confidenceGap = weakTitleOnly ? 2 : 6;
    let confidence = computeConfidence(score, score - confidenceGap, exactLike);
    if (weakTitleOnly && !exactLike) confidence = Math.max(0, confidence - 20);
    const enriched = withScoreMeta(top, score, confidence, 'first_result');
    enriched._weakTitleOnly = weakTitleOnly;
    if (!bestFirst || enriched._confidence > bestFirst._confidence) bestFirst = enriched;
    if (!weakTitleOnly && (exactLike || confidence >= 78)) return enriched;
  }

  if (bestFirst && !bestFirst._weakTitleOnly) {
    const minConfidence = intent.type === 'title_only' ? 66 : 58;
    if (bestFirst._confidence >= minConfidence) return bestFirst;
  }

  // 2) Fast fallback con score global para mantener baja latencia.
  const fastStrategies = strategies.slice(0, SEARCH_FAST_STRATEGY_LIMIT);
  for (const strategy of fastStrategies) {
    const tracks = await fetchTracks(strategy.q, strategy.limit, { mode: 'fast' });

    if (tracks[0] && isClearlyCorrectFirstResult(tracks[0], intent)) {
      return withScoreMeta(tracks[0], 1000, 95, 'strict_first');
    }

    tracks.forEach((track, index) => {
      if (!track?.id) return;
      const score = scoreTrack(track, {
        intent,
        sourceWeight: strategy.weight,
        resultIndex: index,
      });
      const prev = collected.get(track.id);
      if (!prev || score > prev.score) collected.set(track.id, { track, score });
    });

    const provisional = pickBestFromCollected();
    if (provisional && provisional._confidence >= 72) {
      if (bestFirst && !bestFirst._weakTitleOnly && bestFirst._confidence >= Math.max(55, provisional._confidence - 8)) {
        return bestFirst;
      }
      return provisional;
    }
  }

  const fastPick = pickBestFromCollected();
  if (fastPick && fastPick._confidence >= 64) {
    if (bestFirst && !bestFirst._weakTitleOnly && bestFirst._confidence >= Math.max(55, fastPick._confidence - 8)) {
      return bestFirst;
    }
    return fastPick;
  }

  // 3) Deep fallback: ampliar mercados/estrategias solo cuando la búsqueda rápida no es clara.
  const deepStrategies = strategies.slice(0, SEARCH_DEEP_STRATEGY_LIMIT);
  for (const strategy of deepStrategies) {
    const deepLimit = Math.max(strategy.limit, 12);
    const tracks = await fetchTracks(strategy.q, deepLimit, { mode: 'full' });
    tracks.forEach((track, index) => {
      if (!track?.id) return;
      const score = scoreTrack(track, {
        intent,
        sourceWeight: strategy.weight,
        resultIndex: index,
      });
      const prev = collected.get(track.id);
      if (!prev || score > prev.score) collected.set(track.id, { track, score });
    });
  }

  if (!collected.size) {
    // Último recurso: query amplia al estilo buscador global y scoring interno.
    const broad = await fetchTracks(intent.clean || rawQuery, 50, { mode: 'full' });
    broad.forEach((track, index) => {
      if (!track?.id) return;
      const score = scoreTrack(track, {
        intent,
        sourceWeight: 16,
        resultIndex: index,
      });
      const prev = collected.get(track.id);
      if (!prev || score > prev.score) collected.set(track.id, { track, score });
    });
    if (!collected.size) return bestFirst || null;
  }

  const robustPick = pickBestFromCollected();
  if (!robustPick) return bestFirst || null;

  if (bestFirst && !bestFirst._weakTitleOnly && bestFirst._confidence >= Math.max(55, robustPick._confidence - 8)) {
    return bestFirst;
  }
  return robustPick;
}

async function spotifyGetTrackName(clientId, clientSecret, refreshToken, trackUri) {
  try {
    const tokenData = await getSpotifyAccessToken(clientId, clientSecret, refreshToken);
    if (!tokenData.access_token) return null;
    const trackId = trackUri.split(':')[2];
    const r = await httpsRequest('GET', 'api.spotify.com', `/v1/tracks/${trackId}`, {
      Authorization: `Bearer ${tokenData.access_token}`,
    });
    if (!r.data.name) return null;
    const artists = (r.data.artists || []).map(a => a.name).join(', ');
    return `${r.data.name} — ${artists}`;
  } catch {
    return null;
  }
}

module.exports = {
  getSpotifyAccessToken,
  parseSpotifyResource,
  parseSpotifyLink,
  parseYouTubeLink,
  parseYouTubeResource,
  youtubeToSpotifyMetadata,
  youtubeToSpotifyQuery,
  searchSpotifyTrack,
  spotifyGetTrackName,
};
