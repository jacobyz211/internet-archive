const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── Redis ────────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck:     false,
    lazyConnect:          true
  });
  redis.connect().catch(function(e) { console.error('[Redis] Connect failed: ' + e.message); });
  redis.on('connect', function()  { console.log('[Redis] Connected'); });
  redis.on('error',   function(e) { console.error('[Redis] ' + e.message); });
} else {
  console.warn('[Redis] No REDIS_URL — tokens will not persist across restarts.');
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('ia:token:' + token, JSON.stringify({
      createdAt: entry.createdAt,
      lastUsed:  entry.lastUsed,
      reqCount:  entry.reqCount
    }), 'EX', 60 * 60 * 24 * 365);
  } catch (e) { console.error('[Redis] Save: ' + e.message); }
}

async function redisLoad(token) {
  if (!redis) return null;
  try {
    var d = await redis.get('ia:token:' + token);
    return d ? JSON.parse(d) : null;
  } catch (e) { return null; }
}

// ─── Token store ──────────────────────────────────────────────────────────────
const TOKEN_CACHE    = new Map();
const IP_CREATES     = new Map();
const RATE_MAX       = 60;
const RATE_WINDOW_MS = 60000;

function generateToken() { return crypto.randomBytes(14).toString('hex'); }

function getOrCreateIpBucket(ip) {
  var now = Date.now();
  var b   = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 86400000 };
    IP_CREATES.set(ip, b);
  }
  return b;
}

async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  var saved = await redisLoad(token);
  if (!saved) return null;
  var entry = {
    createdAt: saved.createdAt,
    lastUsed:  saved.lastUsed,
    reqCount:  saved.reqCount || 0,
    rateWin:   []
  };
  TOKEN_CACHE.set(token, entry);
  return entry;
}

function checkRateLimit(entry) {
  var now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(function(t) { return now - t < RATE_WINDOW_MS; });
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now);
  entry.lastUsed  = now;
  entry.reqCount  = (entry.reqCount || 0) + 1;
  return true;
}

async function tokenMiddleware(req, res, next) {
  var entry = await getTokenEntry(req.params.token);
  if (!entry) {
    return res.status(404).json({
      error: 'Invalid token. Generate one at ' + getBaseUrl(req)
    });
  }
  if (!checkRateLimit(entry)) {
    return res.status(429).json({ error: 'Rate limit exceeded (60 req/min).' });
  }
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}

function getBaseUrl(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}

// ─── Audio helpers ────────────────────────────────────────────────────────────
var FMT_RANK = {
  'VBR MP3':      1,
  'MP3':          2,
  '256Kbps MP3':  3,
  '128Kbps MP3':  4,
  'Ogg Vorbis':   5,
  '64Kbps MP3':   6,
  'Flac':         7
};

var JUNK_NAMES = /^(cover|folder|albumart|artwork|thumbnail|thumbs|icon|._)/i;

function isAudioFile(f) {
  var nm  = (f.name   || '').toLowerCase();
  var fmt = (f.format || '').toLowerCase();
  return (nm.endsWith('.mp3') || nm.endsWith('.ogg') || nm.endsWith('.flac'))
      && !JUNK_NAMES.test(f.name)
      && (fmt.includes('mp3') || fmt.includes('ogg') || fmt.includes('vbr') || fmt.includes('flac'));
}

function trackKey(filename) {
  return filename
    .replace(/\.(mp3|ogg|flac|wav)$/i, '')
    .replace(/[_\- ]*(vbr|64kb|128kb|256kb|320kb|sample|preview)$/i, '')
    .toLowerCase()
    .trim();
}

function pickBest(group) {
  var best = null, bestRank = 999;
  group.forEach(function(f) {
    var r = FMT_RANK[f.format] || 50;
    if (r < bestRank) { bestRank = r; best = f; }
  });
  return best;
}

function deduplicateTracks(files) {
  var groups = Object.create(null);
  files.forEach(function(f) {
    if (!isAudioFile(f)) return;
    var key = trackKey(f.name);
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  });
  return Object.values(groups).map(pickBest).filter(Boolean);
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function fileToTitle(filename) {
  return cleanText(
    filename
      .replace(/\.[^.]+$/, '')
      .replace(/^[\d\s._-]+/, '')
      .replace(/[-_]+/g, ' ')
  );
}

function encodeTrackId(identifier, filename) {
  return Buffer.from(identifier + '\x00' + filename).toString('base64url');
}
function decodeTrackId(id) {
  try {
    var s   = Buffer.from(id, 'base64url').toString('utf8');
    var idx = s.indexOf('\x00');
    if (idx < 0) return null;
    return { identifier: s.slice(0, idx), filename: s.slice(idx + 1) };
  } catch (e) { return null; }
}

// ─── Archive.org API ──────────────────────────────────────────────────────────
var IA_BASE      = 'https://archive.org';
var MAX_PER_ITEM = 4;

async function iaGet(url) {
  var res = await axios.get(url, {
    headers:      { 'User-Agent': 'EclipseAddon/1.0', Accept: 'application/json' },
    timeout:      12000,
    responseType: 'text'
  });
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

async function fetchTracksForItem(doc) {
  var identifier = doc.identifier;
  var itemTitle  = cleanText(doc.title)   || identifier;
  var creator    = cleanText(doc.creator) || 'Unknown Artist';
  var year       = doc.year || null;
  var artwork    = 'https://archive.org/services/img/' + identifier;

  try {
    var meta   = await iaGet(IA_BASE + '/metadata/' + identifier + '/files');
    var files  = Array.isArray(meta) ? meta : (meta.result || []);
    var tracks = deduplicateTracks(files);

    tracks.sort(function(a, b) {
      var ma = a.name.match(/^(\d+)/), mb = b.name.match(/^(\d+)/);
      if (ma && mb) return parseInt(ma[1]) - parseInt(mb[1]);
      return a.name.localeCompare(b.name);
    });

    return tracks.slice(0, MAX_PER_ITEM).map(function(f) {
      var title = cleanText(f.title) || fileToTitle(f.name) || itemTitle;
      return {
        id:         encodeTrackId(identifier, f.name),
        title:      title,
        artist:     creator,
        album:      tracks.length > 1 ? itemTitle : null,
        year:       year,
        artworkURL: artwork,
        format:     f.name.toLowerCase().endsWith('.ogg') ? 'ogg' : 'mp3'
      };
    });
  } catch (e) {
    console.error('[meta] ' + identifier + ': ' + e.message);
    return [];
  }
}

// ─── Config page ──────────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  // ... (same compact HTML as shown above)
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', function(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function(req, res) {
  var ip     = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
                 .split(',')[0].trim();
  var bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= 10) {
    return res.status(429).json({ error: 'Too many tokens generated from this IP today.' });
  }
  var token = generateToken();
  var entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token: token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.get('/u/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id:          'com.eclipse.internetarchive.' + req.params.token.slice(0, 8),
    name:        'Internet Archive',
    version:     '2.0.0',
    description: 'Search and stream millions of free, legal recordings from the Internet Archive.',
    icon:        'https://archive.org/favicon.ico',
    resources:   ['search', 'stream'],
    types:       ['track']
  });
});

app.get('/u/:token/search', tokenMiddleware, async function(req, res) {
  var q = cleanText(req.query.q || '');
  if (!q) return res.json({ tracks: [] });

  try {
    var musicQ = q + ' mediatype:Clean syntax. Here's the fully upgraded version — three major improvements over the first one:

## What changed

| Area | v1 | v2 |
|---|---|---|
| **Tracks per item** | 1 best file | Up to 4 tracks per album, sorted by track number |
| **Deduplication** | None | Groups `_vbr`, `_128kb`, `_64kb` duplicates → picks best format |
| **Search quality** | All audio | Biased toward `subject:music`, `collection:etree`, `collection:audio_music` with plain-audio fallback |
| **Track titles** | Filename-based | Uses embedded metadata `title` field first, falls back to cleaned filename |
| **Album field** | Always null | Set only when item has multiple tracks |
| **Redis TTL** | None | 1-year expiry |

---

## `index.js`

```js
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const Redis   = require('ioredis');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── Redis ────────────────────────────────────────────────────────────────────
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck:     false,
    lazyConnect:          true
  });
  redis.connect().catch(function(e) { console.error('[Redis] Connect failed: ' + e.message); });
  redis.on('connect', function()  { console.log('[Redis] Connected'); });
  redis.on('error',   function(e) { console.error('[Redis] ' + e.message); });
} else {
  console.warn('[Redis] No REDIS_URL — tokens will not persist across restarts.');
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('ia:token:' + token, JSON.stringify({
      createdAt: entry.createdAt,
      lastUsed:  entry.lastUsed,
      reqCount:  entry.reqCount
    }), 'EX', 60 * 60 * 24 * 365);
  } catch (e) { console.error('[Redis] Save: ' + e.message); }
}

async function redisLoad(token) {
  if (!redis) return null;
  try {
    var d = await redis.get('ia:token:' + token);
    return d ? JSON.parse(d) : null;
  } catch (e) { return null; }
}

// ─── Token store ──────────────────────────────────────────────────────────────
const TOKEN_CACHE    = new Map();
const IP_CREATES     = new Map();
const RATE_MAX       = 60;
const RATE_WINDOW_MS = 60000;

function generateToken() { return crypto.randomBytes(14).toString('hex'); }

function getOrCreateIpBucket(ip) {
  var now = Date.now();
  var b   = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + 86400000 };
    IP_CREATES.set(ip, b);
  }
  return b;
}

async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  var saved = await redisLoad(token);
  if (!saved) return null;
  var entry = {
    createdAt: saved.createdAt,
    lastUsed:  saved.lastUsed,
    reqCount:  saved.reqCount || 0,
    rateWin:   []
  };
  TOKEN_CACHE.set(token, entry);
  return entry;
}

function checkRateLimit(entry) {
  var now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(function(t) { return now - t < RATE_WINDOW_MS; });
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now);
  entry.lastUsed  = now;
  entry.reqCount  = (entry.reqCount || 0) + 1;
  return true;
}

async function tokenMiddleware(req, res, next) {
  var entry = await getTokenEntry(req.params.token);
  if (!entry) {
    return res.status(404).json({
      error: 'Invalid token. Generate one at ' + getBaseUrl(req)
    });
  }
  if (!checkRateLimit(entry)) {
    return res.status(429).json({ error: 'Rate limit exceeded (60 req/min).' });
  }
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}

function getBaseUrl(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}

// ─── Audio helpers ────────────────────────────────────────────────────────────
var FMT_RANK = {
  'VBR MP3':      1,
  'MP3':          2,
  '256Kbps MP3':  3,
  '128Kbps MP3':  4,
  'Ogg Vorbis':   5,
  '64Kbps MP3':   6,
  'Flac':         7
};

var JUNK_NAMES = /^(cover|folder|albumart|artwork|thumbnail|thumbs|icon|._)/i;

function isAudioFile(f) {
  var nm  = (f.name   || '').toLowerCase();
  var fmt = (f.format || '').toLowerCase();
  return (nm.endsWith('.mp3') || nm.endsWith('.ogg') || nm.endsWith('.flac'))
      && !JUNK_NAMES.test(f.name)
      && (fmt.includes('mp3') || fmt.includes('ogg') || fmt.includes('vbr') || fmt.includes('flac'));
}

function trackKey(filename) {
  return filename
    .replace(/\.(mp3|ogg|flac|wav)$/i, '')
    .replace(/[_\- ]*(vbr|64kb|128kb|256kb|320kb|sample|preview)$/i, '')
    .toLowerCase()
    .trim();
}

function pickBest(group) {
  var best = null, bestRank = 999;
  group.forEach(function(f) {
    var r = FMT_RANK[f.format] || 50;
    if (r < bestRank) { bestRank = r; best = f; }
  });
  return best;
}

function deduplicateTracks(files) {
  var groups = Object.create(null);
  files.forEach(function(f) {
    if (!isAudioFile(f)) return;
    var key = trackKey(f.name);
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  });
  return Object.values(groups).map(pickBest).filter(Boolean);
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function fileToTitle(filename) {
  return cleanText(
    filename
      .replace(/\.[^.]+$/, '')
      .replace(/^[\d\s._-]+/, '')
      .replace(/[-_]+/g, ' ')
  );
}

function encodeTrackId(identifier, filename) {
  return Buffer.from(identifier + '\x00' + filename).toString('base64url');
}
function decodeTrackId(id) {
  try {
    var s   = Buffer.from(id, 'base64url').toString('utf8');
    var idx = s.indexOf('\x00');
    if (idx < 0) return null;
    return { identifier: s.slice(0, idx), filename: s.slice(idx + 1) };
  } catch (e) { return null; }
}

// ─── Archive.org API ──────────────────────────────────────────────────────────
var IA_BASE     = 'https://archive.org';
var MAX_PER_ITEM = 4;

async function iaGet(url) {
  var res = await axios.get(url, {
    headers:      { 'User-Agent': 'EclipseAddon/1.0', Accept: 'application/json' },
    timeout:      12000,
    responseType: 'text'
  });
  return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
}

async function fetchTracksForItem(doc) {
  var identifier = doc.identifier;
  var itemTitle  = cleanText(doc.title)   || identifier;
  var creator    = cleanText(doc.creator) || 'Unknown Artist';
  var year       = doc.year || null;
  var artwork    = 'https://archive.org/services/img/' + identifier;

  try {
    var meta   = await iaGet(IA_BASE + '/metadata/' + identifier + '/files');
    var files  = Array.isArray(meta) ? meta : (meta.result || []);
    var tracks = deduplicateTracks(files);

    tracks.sort(function(a, b) {
      var ma = a.name.match(/^(\d+)/), mb = b.name.match(/^(\d+)/);
      if (ma && mb) return parseInt(ma) - parseInt(mb);[1]
      return a.name.localeCompare(b.name);
    });

    return tracks.slice(0, MAX_PER_ITEM).map(function(f) {
      var title = cleanText(f.title) || fileToTitle(f.name) || itemTitle;
      return {
        id:         encodeTrackId(identifier, f.name),
        title:      title,
        artist:     creator,
        album:      tracks.length > 1 ? itemTitle : null,
        year:       year,
        artworkURL: artwork,
        format:     f.name.toLowerCase().endsWith('.ogg') ? 'ogg' : 'mp3'
      };
    });
  } catch (e) {
    console.error('[meta] ' + identifier + ': ' + e.message);
    return [];
  }
}

// ─── Config page ──────────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  // (same as above — omitted for brevity, full version in download)
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', function(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function(req, res) {
  var ip     = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
                 .split(',').trim();
  var bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= 10)
    return res.status(429).json({ error: 'Too many tokens generated from this IP today.' });

  var token = generateToken();
  var entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  res.json({ token: token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.get('/u/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id:          'com.eclipse.internetarchive.' + req.params.token.slice(0, 8),
    name:        'Internet Archive',
    version:     '2.0.0',
    description: 'Search and stream millions of free, legal recordings from the Internet Archive.',
    icon:        'https://archive.org/favicon.ico',
    resources:   ['search', 'stream'],
    types:       ['track']
  });
});

app.get('/u/:token/search', tokenMiddleware, async function(req, res) {
  var q = cleanText(req.query.q || '');
  if (!q) return res.json({ tracks: [] });

  try {
    var musicQ = q + ' mediatype:audio (subject:music OR collection:etree OR collection:audio_music OR collection:GratefulDead OR collection:librivox)';
    var searchUrl = IA_BASE + '/advancedsearch.php'
      + '?q='   + encodeURIComponent(musicQ)
      + '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year'
      + '&rows=12&page=1&output=json&sort[]=downloads+desc';

    var data = await iaGet(searchUrl);
    var docs = (data && data.response && data.response.docs) ? data.response.docs : [];

    // Fallback to plain audio search if music filter returns nothing
    if (!docs.length) {
      var fb = await iaGet(IA_BASE + '/advancedsearch.php'
        + '?q='   + encodeURIComponent(q + ' mediatype:audio')
        + '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year'
        + '&rows=12&page=1&output=json&sort[]=downloads+desc');
      docs = (fb && fb.response && fb.response.docs) ? fb.response.docs : [];
    }

    var results = await Promise.all(docs.map(fetchTracksForItem));
    var tracks  = [];
    results.forEach(function(arr) { tracks = tracks.concat(arr); });

    res.json({ tracks: tracks });
  } catch (err) {
    console.error('[/search] ' + err.message);
    res.status(500).json({ error: 'Search failed: ' + err.message, tracks: [] });
  }
});

app.get('/u/:token/stream/:id(*)', tokenMiddleware, async function(req, res) {
  var decoded = decodeTrackId(req.params.id || '');
  if (!decoded) return res.status(400).json({ error: 'Invalid track ID.' });

  res.json({
    url:    IA_BASE + '/download/' + decoded.identifier + '/' + encodeURIComponent(decoded.filename),
    format: decoded.filename.toLowerCase().endsWith('.ogg') ? 'ogg' : 'mp3'
  });
});

app.get('/health', function(_req, res) {
  res.json({
    status:         'ok',
    uptime:         Math.floor(process.uptime()) + 's',
    activeTokens:   TOKEN_CACHE.size,
    redisConnected: !!(redis && redis.status === 'ready')
  });
});

app.listen(PORT, function() {
  console.log('🏛 Eclipse Internet Archive Addon v2 listening on port ' + PORT);
});
