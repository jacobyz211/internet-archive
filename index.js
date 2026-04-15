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

// Search IA audio items, cache results for 5 minutes
async function searchAudio(query, limit) {
  const safeKey = query.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 60);
  const key     = 'ia:search:' + safeKey;
  const cached  = await cacheGet(key);
  if (cached) return cached;

  const data = await iaGet(`${IA_BASE}/advancedsearch.php`, {
    q:       `(${query}) AND mediatype:audio`,
    output:  'json',
    rows:    limit || 20,
    page:    1,
    'fl[]':  'identifier,title,creator,year,date,description,subject,downloads'
  });

  const docs = (data && data.response && data.response.docs) || [];
  await cacheSet(key, docs, 300);
  return docs;
}

// ─── Audio file helpers ───────────────────────────────────────────────────────
function isAudioFile(f) {
  return /\.(mp3|flac|ogg|m4a|aac|wav|opus)$/i.test(f.name || '')
    && f.source !== 'metadata'
    && f.source !== 'collection';
}

function formatFromName(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  const map  = { mp3: 'mp3', flac: 'flac', ogg: 'ogg', m4a: 'm4a', aac: 'aac', wav: 'wav', opus: 'ogg' };
  return map[ext] || 'mp3';
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
  // IA fields can be a string or an array
  return Array.isArray(v) ? v[0] : v;
}

// Build a stable, URL-safe track ID: identifier___base64url(filename)
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

// Build an Eclipse-compatible track object from an IA file entry + item metadata
function buildTrack(identifier, file, meta) {
  const title  = cleanStr(firstOf(file.title)  || file.name.replace(/\.[^.]+$/, '').replace(/[_-]/g, ' '));
  const artist = cleanStr(firstOf(file.artist) || firstOf(file.creator) || firstOf(meta && meta.creator) || 'Internet Archive');
  const album  = cleanStr(firstOf(meta && meta.title) || '');
  return {
    id:         buildTrackId(identifier, file.name),
    title,
    artist,
    album:      album || null,
    duration:   parseDuration(file.length),
    artworkURL: artworkUrl(identifier),
    format:     formatFromName(file.name),
    streamURL:  `${IA_BASE}/download/${identifier}/${encodeURIComponent(file.name)}`
  };
}

// Prefer MP3 > FLAC > other for a single representative track
function pickBestFile(files) {
  const audio = files.filter(isAudioFile);
  return audio.find(f => /\.mp3$/i.test(f.name))
      || audio.find(f => /\.flac$/i.test(f.name))
      || audio[0]
      || null;
}

// Sort audio files by track number, then filename
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
  h += 'h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}h2{font-size:16px;font-weight:700;margin-bottom:14px;color:#fff}';
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
  // Logo
  h += '<div class="logo"><svg width="44" height="44" viewBox="0 0 44 44" fill="none"><rect width="44" height="44" rx="10" fill="#1a3a6e"/><path d="M8 22 C8 14 14 8 22 8 C30 8 36 14 36 22 C36 30 30 36 22 36" stroke="#4a9eff" stroke-width="2.5" stroke-linecap="round" fill="none"/><circle cx="22" cy="22" r="4" fill="#4a9eff"/><line x1="22" y1="8" x2="22" y2="36" stroke="#4a9eff" stroke-width="1" opacity="0.3"/><line x1="8" y1="22" x2="36" y2="22" stroke="#4a9eff" stroke-width="1" opacity="0.3"/></svg>';
  h += '<div><div class="logo-text">Internet Archive</div><div class="logo-sub">Eclipse Music Addon</div></div></div>';
  // Main card
  h += '<div class="card"><h1>Internet Archive for Eclipse</h1>';
  h += '<div class="tip"><b>Free forever.</b> The Internet Archive is a nonprofit library — millions of concerts, old-time radio shows, audiobooks, and historical recordings, all freely streamable.</div>';
  h += '<p class="sub">Search and stream audio from archive.org directly inside Eclipse. Browse live concert recordings, rare albums, classic radio, and more.</p>';
  h += '<div class="pills"><span class="pill">Live concerts</span><span class="pill">Old-time radio</span><span class="pill g">Free &amp; open</span><span class="pill">Audiobooks</span><span class="pill">Historical recordings</span></div>';
  h += '<button class="bb" id="genBtn" onclick="generate()">Generate My Addon URL</button>';
  h += '<div class="box" id="genBox"><div class="blbl">Your addon URL — paste into Eclipse</div><div class="burl" id="genUrl"></div><button class="bd" id="copyBtn" onclick="copyUrl()">Copy URL</button></div>';
  h += '<hr><div class="steps">';
  h += '<div class="step"><div class="sn">1</div><div class="st">Click <b>Generate</b> above and copy your URL</div></div>';
  h += '<div class="step"><div class="sn">2</div><div class="st">Open <b>Eclipse</b> → Settings → Connections → Add Connection → Addon</div></div>';
  h += '<div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap <b>Install</b></div></div>';
  h += '<div class="step"><div class="sn">4</div><div class="st">Select <b>Internet Archive</b> in the search dropdown and start exploring</div></div>';
  h += '</div></div>';
  // Footer
  h += '<footer>Internet Archive Addon for Eclipse v1.0.0 • <a href="' + baseUrl + '/health" target="_blank" style="color:#333;text-decoration:none">' + baseUrl + '</a></footer>';
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
    version:        '1.0.0',
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
    version:     '1.0.0',
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

    // All docs → albums (each IA item = an album/collection of audio files)
    const albums = docs.map(doc => ({
      id:         doc.identifier,
      title:      cleanStr(firstOf(doc.title) || doc.identifier),
      artist:     cleanStr(firstOf(doc.creator) || 'Internet Archive'),
      artworkURL: artworkUrl(doc.identifier),
      year:       cleanStr(firstOf(doc.year) || (firstOf(doc.date) || '').slice(0, 4)) || null,
      trackCount: null
    }));

    // Fetch full metadata for top 5 docs in parallel → extract representative track
    const topDocs    = docs.slice(0, 5);
    const trackProms = topDocs.map(doc =>
      fetchMetadata(doc.identifier)
        .then(meta => {
          if (!meta || !meta.files) return null;
          const audio = meta.files.filter(isAudioFile);
          if (!audio.length) return null;
          const best = pickBestFile(audio);
          if (!best) return null;
          return buildTrack(doc.identifier, best, meta.metadata);
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
    const audioFiles = sortAudioFiles((meta.files || []).filter(isAudioFile));

    res.json({
      id:          identifier,
      title:       cleanStr(firstOf(m.title) || identifier),
      artist:      cleanStr(firstOf(m.creator) || 'Internet Archive'),
      artworkURL:  artworkUrl(identifier),
      year:        cleanStr((firstOf(m.year) || firstOf(m.date) || '').slice(0, 4)) || null,
      description: cleanStr(firstOf(m.description) || ''),
      trackCount:  audioFiles.length,
      tracks:      audioFiles.map(f => buildTrack(identifier, f, m))
    });
  } catch (e) {
    console.error('[album] error:', e.message);
    res.status(500).json({ error: 'Failed to load album: ' + e.message });
  }
});

// ─── Stream resolution ────────────────────────────────────────────────────────
app.get('/u/:token/stream/:id', tokenMiddleware, async (req, res) => {
  const { identifier, filename } = parseTrackId(req.params.id);

  // If the id was just an identifier (legacy/fallback), pick the best file
  if (!filename) {
    try {
      const meta = await fetchMetadata(identifier);
      const best = pickBestFile((meta.files || []).filter(isAudioFile));
      if (!best) return res.status(404).json({ error: 'No audio file found for this item.' });
      return res.json({
        url:    `${IA_BASE}/download/${identifier}/${encodeURIComponent(best.name)}`,
        format: formatFromName(best.name)
      });
    } catch (e) {
      return res.status(500).json({ error: 'Stream resolution failed: ' + e.message });
    }
  }

  // Tracks already carry a streamURL, so this is mainly a safety fallback
  res.json({
    url:    `${IA_BASE}/download/${identifier}/${encodeURIComponent(filename)}`,
    format: formatFromName(filename)
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[IA Addon] Running on http://0.0.0.0:${PORT}`);
});
