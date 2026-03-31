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
  try {
    redis = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck:     false,
      connectTimeout:       5000
    });
    redis.on('connect', function() { console.log('[Redis] Connected'); });
    redis.on('error',   function(e) { console.error('[Redis] ' + e.message); });
  } catch (e) {
    console.error('[Redis] Init failed: ' + e.message);
    redis = null;
  }
} else {
  console.warn('[Redis] No REDIS_URL set — tokens will reset on restart.');
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('ia:token:' + token, JSON.stringify({
      createdAt: entry.createdAt,
      lastUsed:  entry.lastUsed,
      reqCount:  entry.reqCount
    }), 'EX', 60 * 60 * 24 * 365);
  } catch (e) {}
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
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86400000 }; IP_CREATES.set(ip, b); }
  return b;
}

async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  var saved = await redisLoad(token);
  if (!saved) return null;
  var entry = { createdAt: saved.createdAt, lastUsed: saved.lastUsed, reqCount: saved.reqCount || 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  return entry;
}

function checkRateLimit(entry) {
  var now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(function(t) { return now - t < RATE_WINDOW_MS; });
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now);
  entry.lastUsed = now;
  entry.reqCount = (entry.reqCount || 0) + 1;
  return true;
}

async function tokenMiddleware(req, res, next) {
  var entry = await getTokenEntry(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Invalid token. Visit ' + getBaseUrl(req) + ' to generate a new one.' });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded (60 req/min).' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}

function getBaseUrl(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}

// ─── Archive.org helpers ──────────────────────────────────────────────────────
var IA_BASE = 'https://archive.org';

async function iaGet(url, timeoutMs) {
  var r = await axios.get(url, {
    headers:      { 'User-Agent': 'EclipseAddon/1.0', Accept: 'application/json' },
    timeout:      timeoutMs || 8000,
    responseType: 'text'
  });
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
}

function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// Format preference order for picking best audio file
var FMT_RANK = { 'VBR MP3': 1, 'MP3': 2, '256Kbps MP3': 3, '128Kbps MP3': 4, 'Ogg Vorbis': 5, '64Kbps MP3': 6 };
var SKIP_NAMES = /^(cover|folder|albumart|artwork|thumbnail|._)/i;

function isAudioFile(f) {
  var nm  = (f.name   || '').toLowerCase();
  var fmt = (f.format || '').toLowerCase();
  return !SKIP_NAMES.test(f.name)
      && (nm.endsWith('.mp3') || nm.endsWith('.ogg'))
      && (fmt.includes('mp3') || fmt.includes('ogg') || fmt.includes('vbr'));
}

// Group duplicate bitrate variants, pick best quality per unique track
function bestTracksFromFiles(files) {
  var groups = Object.create(null);
  files.forEach(function(f) {
    if (!isAudioFile(f)) return;
    var key = f.name
      .replace(/\.(mp3|ogg)$/i, '')
      .replace(/[_-]*(vbr|64kb|128kb|256kb)$/i, '')
      .toLowerCase();
    if (!groups[key]) groups[key] = [];
    groups[key].push(f);
  });
  return Object.values(groups).map(function(g) {
    return g.sort(function(a, b) { return (FMT_RANK[a.format] || 99) - (FMT_RANK[b.format] || 99); })[0];
  }).filter(Boolean);
}

// ─── Config page ──────────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Eclipse \u2022 Internet Archive</title>'
    + '<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d0d;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:52px 20px 72px}.logo{width:60px;height:60px;background:#3a30e8;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:#fff;margin-bottom:22px;letter-spacing:-1px}.card{background:#141414;border:1px solid #202020;border-radius:20px;padding:38px;max-width:500px;width:100%;box-shadow:0 28px 70px rgba(0,0,0,.55)}h1{font-size:21px;font-weight:700;color:#fff;margin-bottom:7px}p.sub{font-size:13px;color:#666;line-height:1.65;margin-bottom:24px}.pills{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:32px}.pill{font-size:11px;font-weight:600;padding:4px 11px;border-radius:20px}.pill.g{background:#0c1f0c;color:#5dba5d;border:1px solid #1b3b1b}.pill.b{background:#0a0a1e;color:#897ce0;border:1px solid #18183a}button.main{width:100%;background:#3a30e8;border:none;border-radius:11px;color:#fff;font-size:15px;font-weight:700;padding:15px;cursor:pointer;transition:.15s;margin-bottom:18px}button.main:hover{background:#2e25c4}button.main:disabled{background:#1e1e1e;color:#444;cursor:not-allowed}.result{display:none;background:#0c0c0c;border:1px solid #1c1c1c;border-radius:13px;padding:18px;margin-bottom:18px}.rl{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.08em;margin-bottom:9px}.ru{font-size:12px;color:#897ce0;word-break:break-all;font-family:"SF Mono",monospace;line-height:1.55;margin-bottom:14px}button.cp{width:100%;background:#181818;border:1px solid #1f1f1f;border-radius:8px;color:#888;font-size:13px;font-weight:600;padding:10px;cursor:pointer;transition:.15s}button.cp:hover{background:#1e1e1e;color:#ccc}hr{border:none;border-top:1px solid #191919;margin:26px 0}.steps{display:flex;flex-direction:column;gap:13px}.step{display:flex;gap:13px;align-items:flex-start}.sn{background:#181818;border:1px solid #222;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#555}.st{font-size:13px;color:#555;line-height:1.6}.st strong{color:#999}.note{background:#09091a;border:1px solid #15153a;border-radius:11px;padding:14px 16px;margin-top:24px;font-size:12px;color:#6050a0;line-height:1.7}footer{margin-top:36px;font-size:11px;color:#2a2a2a;text-align:center}</style>'
    + '</head><body>'
    + '<div class="logo">IA</div>'
    + '<div class="card">'
    + '<h1>Internet Archive for Eclipse</h1>'
    + '<p class="sub">Millions of free, legal recordings \u2014 live concerts, vintage albums, radio shows and more. No login or API key ever needed.</p>'
    + '<div class="pills"><span class="pill g">\u2713 No API key</span><span class="pill g">\u2713 Zero setup</span><span class="pill b">\u2713 Fast search</span><span class="pill b">\u2713 Best quality auto-select</span><span class="pill b">\u2713 Redis token persistence</span></div>'
    + '<button class="main" id="gb" onclick="gen()">Generate My Addon URL</button>'
    + '<div class="result" id="res"><div class="rl">Your addon URL \u2014 paste into Eclipse</div><div class="ru" id="ru"></div><button class="cp" onclick="cp()">\u29c3\ufe0e Copy URL</button></div>'
    + '<hr>'
    + '<div class="steps">'
    + '<div class="step"><div class="sn">1</div><div class="st">Click Generate and copy your unique URL</div></div>'
    + '<div class="step"><div class="sn">2</div><div class="st">Open <strong>Eclipse</strong> \u2192 Library \u2192 Cloud \u2192 Add Connection \u2192 Addon</div></div>'
    + '<div class="step"><div class="sn">3</div><div class="st">Paste your URL and tap <strong>Install</strong></div></div>'
    + '<div class="step"><div class="sn">4</div><div class="st"><strong>Internet Archive</strong> appears in search \u2014 concerts, albums, radio shows</div></div>'
    + '</div>'
    + '<div class="note">\u2139\ufe0f Search results appear instantly. Audio files are resolved only when you play a track, keeping search fast and reliable.</div>'
    + '</div>'
    + '<footer>Eclipse Internet Archive Addon \u2022 ' + baseUrl + '</footer>'
    + '<script>var u="";function gen(){var b=document.getElementById("gb");b.disabled=true;b.textContent="Generating...";fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);b.disabled=false;b.textContent="Generate My Addon URL";return;}u=d.manifestUrl;document.getElementById("ru").textContent=u;document.getElementById("res").style.display="block";b.textContent="Regenerate";b.disabled=false;}).catch(function(e){alert("Failed: "+e.message);b.disabled=false;b.textContent="Generate My Addon URL";});}function cp(){if(!u)return;navigator.clipboard.writeText(u).then(function(){var b=document.querySelector(".cp");b.textContent="Copied!";setTimeout(function(){b.textContent="\u29c3\ufe0e Copy URL";},1500);});}<\/script>'
    + '</body></html>';
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', function(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.send(buildConfigPage(getBaseUrl(req)));
});

app.post('/generate', async function(req, res) {
  var ip     = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  var bucket = getOrCreateIpBucket(ip);
  if (bucket.count >= 10) return res.status(429).json({ error: 'Too many tokens from this IP today.' });
  var token  = generateToken();
  var entry  = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;
  console.log('[TOKEN] Created | total: ' + TOKEN_CACHE.size);
  res.json({ token: token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.get('/u/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id:          'com.eclipse.internetarchive.' + req.params.token.slice(0, 8),
    name:        'Internet Archive',
    version:     '3.0.0',
    description: 'Search millions of free, legal recordings from the Internet Archive.',
    icon:        'https://archive.org/favicon.ico',
    resources:   ['search', 'stream'],
    types:       ['track']
  });
});

// ─── SEARCH ───────────────────────────────────────────────────────────────────
// ONE request to archive.org search — returns instantly, no metadata waterfalls.
// Track ID = the archive.org identifier (e.g. "GratefulDead1977-05-08.SBD")
// Audio file resolution is deferred to /stream.

app.get('/u/:token/search', tokenMiddleware, async function(req, res) {
  var q = clean(req.query.q || '');
  if (!q) return res.json({ tracks: [] });

  try {
    // Try music-collection search first; fall back to plain audio if empty
    var queries = [
      q + ' mediatype:audio (subject:music OR collection:etree OR collection:audio_music)',
      q + ' mediatype:audio'
    ];

    var docs = [];
    for (var i = 0; i < queries.length; i++) {
      var url = IA_BASE + '/advancedsearch.php'
        + '?q='       + encodeURIComponent(queries[i])
        + '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&fl[]=description'
        + '&rows=20&page=1&output=json&sort[]=downloads+desc';
      var data = await iaGet(url, 8000);
      docs = (data && data.response && data.response.docs) ? data.response.docs : [];
      if (docs.length) break;
    }

    var tracks = docs.map(function(doc) {
      return {
        id:         doc.identifier,
        title:      clean(doc.title) || doc.identifier,
        artist:     clean(doc.creator) || 'Internet Archive',
        album:      null,
        year:       doc.year || null,
        artworkURL: 'https://archive.org/services/img/' + doc.identifier
      };
    });

    console.log('[/search] "' + q + '" \u2192 ' + tracks.length + ' results');
    res.json({ tracks: tracks });

  } catch (err) {
    console.error('[/search] ' + err.message);
    res.status(500).json({ error: 'Search failed: ' + err.message, tracks: [] });
  }
});

// ─── STREAM ───────────────────────────────────────────────────────────────────
// Called only when the user actually taps Play on a track.
// Fetches metadata for that ONE item and returns the best audio file URL.

app.get('/u/:token/stream/:id(*)', tokenMiddleware, async function(req, res) {
  var identifier = decodeURIComponent(req.params.id || '').trim();
  if (!identifier) return res.status(400).json({ error: 'Missing track identifier.' });

  try {
    var meta  = await iaGet(IA_BASE + '/metadata/' + identifier + '/files', 8000);
    var files = Array.isArray(meta) ? meta : (meta.result || []);
    var best  = bestTracksFromFiles(files);

    if (!best.length) {
      return res.status(404).json({ error: 'No playable audio files found for: ' + identifier });
    }

    // Sort by track number, then alphabetically
    best.sort(function(a, b) {
      var ma = (a.name || '').match(/^(\d+)/);
      var mb = (b.name || '').match(/^(\d+)/);
      if (ma && mb) return parseInt(ma[1]) - parseInt(mb[1]);
      return (a.name || '').localeCompare(b.name || '');
    });

    var f   = best[0];
    var url = IA_BASE + '/download/' + identifier + '/' + encodeURIComponent(f.name);

    console.log('[/stream] ' + identifier + ' \u2192 ' + f.name);
    res.json({
      url:    url,
      format: f.name.toLowerCase().endsWith('.ogg') ? 'ogg' : 'mp3'
    });

  } catch (err) {
    console.error('[/stream] ' + identifier + ': ' + err.message);
    res.status(500).json({ error: 'Could not resolve stream: ' + err.message });
  }
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
  console.log('\uD83C\uDFDB  Eclipse Internet Archive Addon v3 running on port ' + PORT);
});
