const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const UA      = 'Mozilla/5.0 (compatible; EclipseIAAddon/1.0.0)';
const IA_BASE = 'https://archive.org';

// ─── Redis ───────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck:     false
  });
  redis.on('connect', () => console.log('[Redis] Connected'));
  redis.on('error',   e  => console.error('[Redis] Error: ' + e.message));
}

async function cacheGet(key) {
  if (!redis) return null;
  try {
    const d = await redis.get(key);
    return d ? JSON.parse(d) : null;
  } catch (_e) { return null; }
}

async function cacheSet(key, value, ttlSeconds) {
  if (!redis) return;
  try { await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds); }
  catch (_e) {}
}

// ─── Token store ─────────────────────────────────────────────────────────────
const TOKEN_CACHE       = new Map();
const IP_CREATES        = new Map();
const MAX_TOKENS_PER_IP = 10;
const RATE_MAX          = 120;
const RATE_WINDOW_MS    = 60000;

function generateToken() {
  return crypto.randomBytes(14).toString('hex');
}

function getOrCreateIpBucket(ip) {
  const now = Date.now();
  let b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 86400000 };
    IP_CREATES.set(ip, b);
  }
  return b;
}

async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  const saved = await cacheGet('ia:token:' + token);
  if (!saved) return null;
  const entry = {
    createdAt: saved.createdAt,
    lastUsed:  saved.lastUsed,
    reqCount:  saved.reqCount,
    rateWin:   []
  };
  TOKEN_CACHE.set(token, entry);
  return entry;
}

async function saveToken(token, entry) {
  await cacheSet('ia:token:' + token, {
    createdAt: entry.createdAt,
    lastUsed:  entry.lastUsed,
    reqCount:  entry.reqCount
  }, 30 * 24 * 3600);
}

function checkRateLimit(entry) {
  const now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(t => now - t < RATE_WINDOW_MS);
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now);
  entry.lastUsed = now;
  entry.reqCount = (entry.reqCount || 0) + 1;
  return true;
}

async function tokenMiddleware(req, res, next) {
  const entry = await getTokenEntry(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Invalid token.' });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded.' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) saveToken(req.params.token, entry);
  next();
}

function getBaseUrl(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}

// ─── Internet Archive API helpers ────────────────────────────────────────────
async function iaGet(url, params) {
  const r = await axios.get(url, {
    params:  params || {},
    headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    timeout: 15000
  });
  return r.data;
}

// Fetch item metadata, cached in Redis for 1 hour
async function fetchMetadata(identifier) {
  const key    = 'ia:meta:' + identifier;
  const cached = await cacheGet(key);
  if (cached) return cached;
  const data = await iaGet(`${IA_BASE}/metadata/${identifier}`);
  if (data && data.metadata) await cacheSet(key, data, 3600);
  return data;
}

// ─── FIX 1: Two-tier search (targeted first, then broad fallback) ─────────────
//
// Targeted: only items where the query is in title OR creator field.
//           Sorted by downloads (most popular first).
// Broad:    general full-text search as a fallback if targeted returns < 3 hits.
// This prevents podcast episodes that *mention* an artist from dominating results.
//
async function searchAudio(query, limit) {
  const safeKey = 'ia:search2:' + query.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 60);
  const cached  = await cacheGet(safeKey);
  if (cached) return cached;

  const fields = 'identifier,title,creator,year,date,description,subject,downloads';

  // Tier 1 — title/creator match, sorted by downloads
  let docs = [];
  try {
    const r = await iaGet(`${IA_BASE}/advancedsearch.php`, {
      q:        `(title:("${query}") OR creator:("${query}")) AND mediatype:audio`,
      output:   'json',
      rows:     limit || 20,
      page:     1,
      'fl[]':   fields,
      'sort[]': 'downloads desc'
    });
    docs = (r && r.response && r.response.docs) || [];
  } catch (_e) {}

  // Tier 2 — broad fallback if we got fewer than 3 targeted hits
  if (docs.length < 3) {
    try {
      const r2 = await iaGet(`${IA_BASE}/advancedsearch.php`, {
        q:        `(${query}) AND mediatype:audio`,
        output:   'json',
        rows:     limit || 20,
        page:     1,
        'fl[]':   fields,
        'sort[]': 'downloads desc'
      });
      const broadDocs = (r2 && r2.response && r2.response.docs) || [];
      // Merge: targeted first, then broad (no duplicates)
      const seen = new Set(docs.map(d => d.identifier));
      for (const d of broadDocs) {
        if (!seen.has(d.identifier)) { seen.add(d.identifier); docs.push(d); }
        if (docs.length >= (limit || 20)) break;
      }
    } catch (_e) {}
  }

  await cacheSet(safeKey, docs, 180); // 3-minute cache
  return docs;
}

// ─── FIX 2: Robust audio file detection ───────────────────────────────────────
//
// Previous version only checked file extension. IA stores files with:
//   - format: "VBR MP3", "128Kbps MP3", "Ogg Vorbis", "Flac", "Shorten", etc.
//   - extensions: .mp3, .flac, .ogg, .shn (Shorten — used in etree concerts), .m4a, etc.
// We now check BOTH extension AND format field, and exclude non-audio by extension.
//
const NON_AUDIO_EXT = /\.(xml|sqlite|jpg|jpeg|png|gif|txt|nfo|log|pdf|torrent|zip|gz|bz2|json|cue|m3u|m3u8|sha1|md5|htm|html|css|js|db|idx|ffp|st5|md5|asc|info)$/i;
const AUDIO_EXT     = /\.(mp3|flac|ogg|oga|m4a|aac|wav|opus|shn|wma|spx|ra|rm|ape|wv)$/i;
const AUDIO_FMT     = /\b(mp3|flac|ogg|vorbis|aac|m4a|wav|opus|shorten|wma|audio)\b/i;

function isAudioFile(f) {
  if (!f || !f.name) return false;
  if (f.source === 'metadata') return false;             // .xml, .sqlite descriptors
  if (NON_AUDIO_EXT.test(f.name)) return false;          // obvious non-audio by extension
  if (AUDIO_EXT.test(f.name)) return true;               // known audio extension ✓
  if (AUDIO_FMT.test(f.format || '')) return true;       // known audio format field ✓
  return false;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatFromFile(f) {
  const ext = (f.name || '').split('.').pop().toLowerCase();
  const fmt = (f.format || '').toLowerCase();
  if (ext === 'flac' || /flac/.test(fmt))            return 'flac';
  if (ext === 'ogg'  || /ogg|vorbis/.test(fmt))      return 'ogg';
  if (ext === 'm4a'  || /m4a|aac/.test(fmt))         return 'm4a';
  if (ext === 'wav'  || /wav/.test(fmt))              return 'wav';
  if (ext === 'opus' || /opus/.test(fmt))             return 'ogg';
  return 'mp3'; // default / shn derivatives are usually served as mp3
}

function parseDuration(d) {
  if (!d) return null;
  if (typeof d === 'number') return Math.floor(d);
  const s = String(d).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.floor(parseFloat(s));
  const parts = s.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + Math.floor(parts[2]);
  if (parts.length === 2) return parts[0] * 60  + Math.floor(parts[1]);
  return null;
}

function cleanStr(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function firstOf(v) {
  return Array.isArray(v) ? v[0] : v;
}

// ─── FIX 3: Better track title extraction ─────────────────────────────────────
//
// IA file entries can have:
//   - file.title:  clean track title (when set by uploader)
//   - file.name:   filename — may be a hash (e.g. "iztbbkgurvn1w...") or clean
// If file.title is absent or looks like a hash, fall back to item title + track number.
//
function isHashName(s) {
  return /^[a-f0-9]{8,}$/i.test(s) || /^[a-zA-Z0-9]{20,}$/.test(s);
}

function cleanFilenameAsTitle(filename) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildTrackId(identifier, filename) {
  return identifier + '___' + Buffer.from(filename).toString('base64url');
}

function parseTrackId(id) {
  const sep = id.indexOf('___');
  if (sep === -1) return { identifier: id, filename: null };
  return {
    identifier: id.slice(0, sep),
    filename:   Buffer.from(id.slice(sep + 3), 'base64url').toString('utf8')
  };
}

function artworkUrl(identifier) {
  return `${IA_BASE}/services/img/${identifier}`;
}

function buildTrack(identifier, file, meta, trackIndex) {
  let rawTitle = cleanStr(firstOf(file.title));
  if (!rawTitle || isHashName(rawTitle)) {
    const fromFilename = cleanFilenameAsTitle(file.name);
    rawTitle = isHashName(fromFilename)
      ? (cleanStr(firstOf(meta && meta.title)) + (trackIndex != null ? ' — Track ' + (trackIndex + 1) : ''))
      : fromFilename;
  }
  const title  = rawTitle || 'Unknown Track';
  const artist = cleanStr(
    firstOf(file.artist)  ||
    firstOf(file.creator) ||
    firstOf(meta && meta.creator) ||
    'Internet Archive'
  );
  const album  = cleanStr(firstOf(meta && meta.title) || '');

  return {
    id:         buildTrackId(identifier, file.name),
    title,
    artist,
    album:      album || null,
    duration:   parseDuration(file.length),
    artworkURL: artworkUrl(identifier),
    format:     formatFromFile(file),
    streamURL:  `${IA_BASE}/download/${identifier}/${encodeURIComponent(file.name)}`
  };
}

function pickBestFile(files) {
  const audio = files.filter(isAudioFile);
  if (!audio.length) return null;

  const score = f => {
    let s = 0;
    const ext = (f.name || '').split('.').pop().toLowerCase();
    if (ext === 'mp3') s += 10;
    else if (ext === 'flac' || ext === 'ogg') s += 5;
    const t = cleanStr(firstOf(f.title));
    if (t && !isHashName(t)) s += 20;
    return s;
  };

  return audio.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

function sortAudioFiles(files) {
  return files.slice().sort((a, b) => {
    const at = parseInt(firstOf(a.track) || '0') || 0;
    const bt = parseInt(firstOf(b.track) || '0') || 0;
    if (at && bt) return at - bt;
    return (a.name || '').localeCompare(b.name || '');
  });
}

// ─── Config page ──────────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  let h = '';
  h += '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">';
  h += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  h += '<title>Internet Archive Addon for Eclipse</title>';
  h += '<style>*{box-sizing:border-box;margin:0;padding:0}';
  h += 'body{background:#0a0a0f;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}';
  h += '.logo{margin-bottom:24px;display:flex;align-items:center;gap:14px}';
  h += '.logo-text{font-size:20px;font-weight:700;color:#fff;line-height:1.2}.logo-sub{font-size:12px;color:#555}';
  h += '.card{background:#111118;border:1px solid #1e1e2e;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}';
  h += 'h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}';
  h += 'p.sub{font-size:14px;color:#777;margin-bottom:20px;line-height:1.6}';
  h += '.tip{background:#0a0f1e;border:1px solid #1a2a4a;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#4a7abb;line-height:1.7}.tip b{color:#6aadff}';
  h += '.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}';
  h += '.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#0d1a2e;color:#4a9eff;border:1px solid #1a3a6e}';
  h += '.pill.g{background:#0d1f0d;color:#5a9e5a;border-color:#1a3a1a}';
  h += '.lbl{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#555;margin-bottom:6px;margin-top:16px}';
  h += '.box{display:none;background:#0a0a0f;border:1px solid #1e1e2e;border-radius:12px;padding:18px;margin-bottom:14px}';
  h += '.blbl{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}';
  h += '.burl{font-size:12px;color:#4a9eff;word-break:break-all;font-family:"SF Mono",monospace;margin-bottom:14px;line-height:1.5}';
  h += 'button{cursor:pointer;border:none;border-radius:10px;font-size:15px;font-weight:700;padding:13px;width:100%;margin-top:6px;margin-bottom:12px;transition:background .15s}';
  h += '.bb{background:#1a4a8a;color:#fff}.bb:hover{background:#2260aa}.bb:disabled{background:#1a1a2a;color:#444;cursor:not-allowed}';
  h += '.bd{background:#141420;color:#aaa;border:1px solid #1e1e2e;font-size:13px;padding:10px}.bd:hover{background:#1e1e2e;color:#fff}';
  h += 'hr{border:none;border-top:1px solid #1a1a2a;margin:24px 0}';
  h += '.steps{display:flex;flex-direction:column;gap:12px}.step{display:flex;gap:12px;align-items:flex-start}';
  h += '.sn{background:#141420;border:1px solid #1e1e2e;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#555}';
  h += '.st{font-size:13px;color:#666;line-height:1.6}.st b{color:#aaa}';
  h += 'footer{margin-top:32px;font-size:12px;color:#333;text-align:center;line-height:1.8}</style></head><body>';
  h += '<div class="logo"><svg width="44" height="44" viewBox="0 0 44 44" fill="none"><rect width="44" height="44" rx="10" fill="#1a3a6e"/><path d="M8 22 C8 14 14 8 22 8 C30 8 36 14 36 22 C36 30 30 36 22 36" stroke="#4a9eff" stroke-width="2.5" stroke-linecap="round" fill="none"/><circle cx="22" cy="22" r="4" fill="#4a9eff"/><line x1="22" y1="8" x2="22" y2="36" stroke="#4a9eff" stroke-width="1" opacity="0.3"/><line x1="8" y1="22" x2="36" y2="22" stroke="#4a9eff" stroke-width="1" opacity="0.3"/></svg>';
  h += '<div><div class="logo-text">Internet Archive</div><div class="logo-sub">Eclipse Music Addon</div></div></div>';
  h += '<div class="card"><h1>Internet Archive for Eclipse</h1>';
  h += '<div class="tip"><b>Free forever.</b> The Internet Archive is a nonprofit library — millions of concerts, old-time radio shows, audiobooks, and historical recordings, all freely streamable.</div>';
  h += '<p class="sub">Search and stream audio from archive.org directly inside Eclipse. Best for live concerts (Grateful Dead, Phish, etc.), old-time radio, audiobooks, and rare recordings.</p>';
  h += '<div class="pills"><span class="pill">Live concerts</span><span class="pill">Old-time radio</span><span class="pill g">Free &amp; open</span><span class="pill">Audiobooks</span><span class="pill">Historical recordings</span></div>';
  h += '<button class="bb" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL — paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyBtn" onclick="copyUrl()">Copy URL</button></div>';
  h += '<hr><div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Click <b>Generate</b> above and copy your URL</div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> → Settings → Connections → Add Connection → Addon</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap <b>Install</b></div></div>';
  h += '<div class="step"><div class="sn">4</div><div class="st">Select <b>Internet Archive</b> in the search dropdown — works best for live concerts, old radio, and audiobooks</div></div>';
  h += '</div></div>';
  h += '<footer>Internet Archive Addon for Eclipse v1.1.0 • <a href="' + baseUrl + '/health" target="_blank" style="color:#333;text-decoration:none">' + baseUrl + '</a></footer>';
  h += '<script>';
  h += 'var _url="";';
  h += 'function generate(){var btn=document.getElementById("genBtn");btn.disabled=true;btn.textContent="Generating...";';
  h += 'fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})}).then(r=>r.json()).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}';
  h += '_url=d.manifestUrl;document.getElementById("genUrl").textContent=_url;document.getElementById("genBox").style.display="block";btn.disabled=false;btn.textContent="Regenerate URL";}).catch(function(e){alert("Error: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});}';
  h += 'function copyUrl(){if(!_url)return;navigator.clipboard.writeText(_url).then(function(){var b=document.getElementById("copyBtn");b.textContent="Copied!";setTimeout(function(){b.textContent="Copy URL";},1500);});}';
  h += '</script></body></html>';
  return h;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.get('/health', (req, res) => {
  res.json({
    status:         'ok',
    version:        '1.1.0',
    redisConnected: !!(redis && redis.status === 'ready'),
    activeTokens:   TOKEN_CACHE.size,
    timestamp:      new Date().toISOString()
  });
});

app.post('/generate', async (req, res) => {
  const ip     = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= MAX_TOKENS_PER_IP) {
    return res.status(429).json({ error: 'Too many tokens today from this IP.' });
  }
  const token = generateToken();
  const entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await saveToken(token, entry);
  bucket.count++;
  res.json({ token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

// ─── Manifest ─────────────────────────────────────────────────────────────────
app.get('/u/:token/manifest.json', tokenMiddleware, (req, res) => {
  res.json({
    id:          'com.eclipse.internetarchive.' + req.params.token.slice(0, 8),
    name:        'Internet Archive',
    version:     '1.1.0',
    description: 'Stream millions of free audio recordings — live concerts, old-time radio, audiobooks, and rare historical recordings from archive.org.',
    icon:        'https://archive.org/images/glogo.jpg',
    resources:   ['search', 'stream', 'catalog'],
    types:       ['track', 'album']
  });
});

// ─── Search ───────────────────────────────────────────────────────────────────
app.get('/u/:token/search', tokenMiddleware, async (req, res) => {
  const q = cleanStr(req.query.q);
  if (!q) return res.json({ tracks: [], albums: [] });

  try {
    const docs = await searchAudio(q, 20);
    if (!docs.length) return res.json({ tracks: [], albums: [] });

    const albums = docs.map(doc => ({
      id:         doc.identifier,
      title:      cleanStr(firstOf(doc.title) || doc.identifier),
      artist:     cleanStr(firstOf(doc.creator) || 'Internet Archive'),
      artworkURL: artworkUrl(doc.identifier),
      year:       cleanStr(firstOf(doc.year) || (firstOf(doc.date) || '').slice(0, 4)) || null,
      trackCount: null
    }));

    const topDocs    = docs.slice(0, 5);
    const trackProms = topDocs.map(doc =>
      fetchMetadata(doc.identifier)
        .then(meta => {
          if (!meta || !meta.files) return null;
          const audio = meta.files.filter(isAudioFile);
          if (!audio.length) return null;
          const best = pickBestFile(audio);
          if (!best) return null;
          return buildTrack(doc.identifier, best, meta.metadata, null);
        })
        .catch(() => null)
    );
    const tracks = (await Promise.all(trackProms)).filter(Boolean);

    res.json({ tracks, albums });
  } catch (e) {
    console.error('[search] error:', e.message);
    res.status(500).json({ error: 'Search failed.', tracks: [], albums: [] });
  }
});

// ─── Album detail ─────────────────────────────────────────────────────────────
app.get('/u/:token/album/:id', tokenMiddleware, async (req, res) => {
  const identifier = req.params.id;
  try {
    const meta = await fetchMetadata(identifier);
    if (!meta || !meta.metadata) return res.status(404).json({ error: 'Item not found.' });

    const m          = meta.metadata;
    const allFiles   = meta.files || [];
    const audioFiles = sortAudioFiles(allFiles.filter(isAudioFile));

    console.log(`[album] ${identifier}: ${allFiles.length} total files, ${audioFiles.length} audio`);

    res.json({
      id:          identifier,
      title:       cleanStr(firstOf(m.title) || identifier),
      artist:      cleanStr(firstOf(m.creator) || 'Internet Archive'),
      artworkURL:  artworkUrl(identifier),
      year:        cleanStr((firstOf(m.year) || firstOf(m.date) || '').slice(0, 4)) || null,
      description: cleanStr(firstOf(m.description) || ''),
      trackCount:  audioFiles.length,
      tracks:      audioFiles.map((f, i) => buildTrack(identifier, f, m, i))
    });
  } catch (e) {
    console.error('[album] error:', e.message);
    res.status(500).json({ error: 'Failed to load album: ' + e.message });
  }
});

// ─── Stream resolution ────────────────────────────────────────────────────────
app.get('/u/:token/stream/:id', tokenMiddleware, async (req, res) => {
  const { identifier, filename } = parseTrackId(req.params.id);

  if (!filename) {
    try {
      const meta = await fetchMetadata(identifier);
      const best = pickBestFile((meta.files || []).filter(isAudioFile));
      if (!best) return res.status(404).json({ error: 'No audio file found for this item.' });
      return res.json({
        url:    `${IA_BASE}/download/${identifier}/${encodeURIComponent(best.name)}`,
        format: formatFromFile(best)
      });
    } catch (e) {
      return res.status(500).json({ error: 'Stream resolution failed: ' + e.message });
    }
  }

  res.json({
    url:    `${IA_BASE}/download/${identifier}/${encodeURIComponent(filename)}`,
    format: filename.split('.').pop().toLowerCase() || 'mp3'
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[IA Addon] v1.1.0 running on http://0.0.0.0:${PORT}`);
});
