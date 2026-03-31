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
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: false });
  redis.on('connect', function() { console.log('[Redis] Connected'); });
  redis.on('error',   function(e) { console.error('[Redis] ' + e.message); });
} else {
  console.warn('[Redis] No REDIS_URL — tokens will not persist across restarts.');
}

async function redisSave(token, entry) {
  if (!redis) return;
  try {
    await redis.set('ia:token:' + token, JSON.stringify({
      createdAt: entry.createdAt, lastUsed: entry.lastUsed, reqCount: entry.reqCount
    }));
  } catch (e) { console.error('[Redis] Save: ' + e.message); }
}

async function redisLoad(token) {
  if (!redis) return null;
  try { var d = await redis.get('ia:token:' + token); return d ? JSON.parse(d) : null; }
  catch (e) { return null; }
}

// ─── Token store ──────────────────────────────────────────────────────────────
const TOKEN_CACHE = new Map();
const IP_CREATES  = new Map();
const RATE_MAX       = 60;
const RATE_WINDOW_MS = 60000;

function generateToken() { return crypto.randomBytes(14).toString('hex'); }

function getOrCreateIpBucket(ip) {
  var now = Date.now(); var b = IP_CREATES.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86400000 }; IP_CREATES.set(ip, b); }
  return b;
}

async function getTokenEntry(token) {
  if (TOKEN_CACHE.has(token)) return TOKEN_CACHE.get(token);
  var saved = await redisLoad(token);
  if (!saved) return null;
  var entry = { createdAt: saved.createdAt, lastUsed: saved.lastUsed, reqCount: saved.reqCount || 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry); return entry;
}

function checkRateLimit(entry) {
  var now = Date.now();
  entry.rateWin = (entry.rateWin || []).filter(function(t) { return now - t < RATE_WINDOW_MS; });
  if (entry.rateWin.length >= RATE_MAX) return false;
  entry.rateWin.push(now); entry.lastUsed = now; entry.reqCount = (entry.reqCount || 0) + 1; return true;
}

async function tokenMiddleware(req, res, next) {
  var entry = await getTokenEntry(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Invalid token. Generate a new one at ' + getBaseUrl(req) });
  if (!checkRateLimit(entry)) return res.status(429).json({ error: 'Rate limit exceeded (60 req/min).' });
  req.tokenEntry = entry;
  if (entry.reqCount % 20 === 0) redisSave(req.params.token, entry);
  next();
}

function getBaseUrl(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}

// ─── Archive.org API helpers ──────────────────────────────────────────────────
var IA_BASE = 'https://archive.org';

async function iaGet(url, opts) {
  var res = await axios.get(url, Object.assign({
    headers: { 'User-Agent': 'EclipseAddon/1.0', 'Accept': 'application/json' },
    timeout: 12000,
    responseType: 'text'
  }, opts || {}));
  var body = res.data;
  return typeof body === 'string' ? JSON.parse(body) : body;
}

var AUDIO_FMTS = ['VBR MP3', 'MP3', '128Kbps MP3', '64Kbps MP3', 'Ogg Vorbis', 'Flac'];

function pickBestAudio(files) {
  for (var fi = 0; fi < AUDIO_FMTS.length; fi++) {
    for (var i = 0; i < files.length; i++) {
      if (files[i].format === AUDIO_FMTS[fi] && !files[i].name.endsWith('_64kb.mp3')) {
        return files[i];
      }
    }
  }
  for (var j = 0; j < files.length; j++) {
    var n = files[j].name.toLowerCase();
    if (n.endsWith('.mp3') || n.endsWith('.ogg')) return files[j];
  }
  return null;
}

function cleanText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function encodeTrackId(identifier, filename) {
  return Buffer.from(identifier + '\x00' + filename).toString('base64url');
}

function decodeTrackId(id) {
  try {
    var s = Buffer.from(id, 'base64url').toString('utf8');
    var idx = s.indexOf('\x00');
    if (idx < 0) return null;
    return { identifier: s.slice(0, idx), filename: s.slice(idx + 1) };
  } catch (e) { return null; }
}

async function fetchItemTracks(identifier, title, creator, year) {
  try {
    var meta = await iaGet(IA_BASE + '/metadata/' + identifier + '/files');
    var files = Array.isArray(meta) ? meta : (meta.result || []);
    var audioFiles = files.filter(function(f) {
      var fmt = (f.format || '').toLowerCase();
      var nm  = (f.name  || '').toLowerCase();
      return fmt.includes('mp3') || fmt.includes('ogg') || fmt.includes('vbr') ||
             nm.endsWith('.mp3') || nm.endsWith('.ogg');
    });
    if (!audioFiles.length) return [];

    var best = pickBestAudio(audioFiles);
    if (!best) return [];

    var fname  = best.name;
    var trackTitle = cleanText(best.title || fname.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')) || cleanText(title);
    var artworkURL = 'https://archive.org/services/img/' + identifier;

    return [{
      id:         encodeTrackId(identifier, fname),
      title:      trackTitle,
      artist:     cleanText(creator) || 'Unknown Artist',
      album:      cleanText(title)   || null,
      year:       year               || null,
      artworkURL: artworkURL,
      format:     fname.toLowerCase().endsWith('.ogg') ? 'ogg' : 'mp3'
    }];
  } catch (e) {
    console.error('[meta] ' + identifier + ': ' + e.message);
    return [];
  }
}

// ─── Config page ──────────────────────────────────────────────────────────────
function buildConfigPage(baseUrl) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Eclipse • Internet Archive Addon</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0f0f0f;color:#e8e8e8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px}.logo{margin-bottom:20px}.card{background:#161616;border:1px solid #232323;border-radius:18px;padding:36px;max-width:520px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.5)}h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}p.sub{font-size:14px;color:#777;margin-bottom:22px;line-height:1.6}.pills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:32px}.pill{border-radius:20px;font-size:11px;font-weight:600;padding:4px 10px;background:#0a0a1a;color:#a07cf0;border:1px solid #1a1a3a}.pill.green{background:#0d1f0d;color:#6db86d;border-color:#1e3a1e}button.primary{width:100%;background:#4a3cf5;border:none;border-radius:10px;color:#fff;font-size:15px;font-weight:700;padding:14px;cursor:pointer;transition:background .15s;margin-bottom:18px}button.primary:hover{background:#3d2fd4}button.primary:disabled{background:#252525;color:#444;cursor:not-allowed}.result{display:none;background:#0f0f0f;border:1px solid #1e1e1e;border-radius:12px;padding:18px;margin-bottom:18px}.rlabel{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}.rurl{font-size:12px;color:#a07cf0;word-break:break-all;font-family:"SF Mono",monospace;margin-bottom:14px;line-height:1.5}button.copy{width:100%;background:#1a1a1a;border:1px solid #222;border-radius:8px;color:#aaa;font-size:13px;font-weight:600;padding:10px;cursor:pointer;transition:all .15s}button.copy:hover{background:#202020;color:#fff}.divider{border:none;border-top:1px solid #1a1a1a;margin:28px 0}.steps{display:flex;flex-direction:column;gap:14px}.step{display:flex;gap:14px;align-items:flex-start}.step-n{background:#1a1a1a;border:1px solid #252525;border-radius:50%;width:26px;height:26px;min-width:26px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#666}.step-t{font-size:13px;color:#666;line-height:1.6}.step-t strong{color:#aaa}.note{background:#0a0a1a;border:1px solid #1a1a3a;border-radius:10px;padding:14px 16px;margin-top:24px;font-size:12px;color:#7060b0;line-height:1.7}footer{margin-top:36px;font-size:12px;color:#333;text-align:center}</style></head><body>'
    + '<svg class="logo" width="52" height="52" viewBox="0 0 52 52" fill="none"><circle cx="26" cy="26" r="26" fill="#4a3cf5"/><text x="26" y="34" font-family="Arial Black,sans-serif" font-size="13" font-weight="900" fill="#fff" text-anchor="middle">IA</text></svg>'
    + '<div class="card"><h1>Internet Archive for Eclipse</h1><p class="sub">Access millions of free, legal recordings from the Internet Archive. No login or API key needed — ever.</p>'
    + '<div class="pills"><span class="pill green">✓ Zero setup</span><span class="pill">✓ No API key needed</span><span class="pill">✓ Unique per user</span><span class="pill">✓ Live concerts + albums</span><span class="pill">✓ Persists across restarts</span></div>'
    + '<button class="primary" id="genBtn" onclick="generate()">Generate My Addon URL</button>'
    + '<div class="result" id="result"><div class="rlabel">Your addon URL — paste this into Eclipse</div><div class="rurl" id="rurl"></div><button class="copy" onclick="copyUrl()">⧃ Copy URL</button></div>'
    + '<hr class="divider"><div class="steps">'
    + '<div class="step"><div class="step-n">1</div><div class="step-t">Click Generate and copy your URL</div></div>'
    + '<div class="step"><div class="step-n">2</div><div class="step-t">Open <strong>Eclipse Music</strong> → Library → Cloud → Add Connection → Addon</div></div>'
    + '<div class="step"><div class="step-n">3</div><div class="step-t">Paste your URL and tap Install</div></div>'
    + '<div class="step"><div class="step-n">4</div><div class="step-t"><strong>Internet Archive</strong> appears in your search — millions of recordings, live shows, and albums</div></div>'
    + '</div><div class="note">ℹ️ The Internet Archive hosts millions of free, legal audio recordings including vintage albums, live concerts, podcasts, and radio shows. Your URL is saved to Redis and survives server restarts.</div>'
    + '</div><footer>Eclipse Internet Archive Addon • ' + baseUrl + '</footer>'
    + '<script>var gurl="";function generate(){var btn=document.getElementById("genBtn");btn.disabled=true;btn.textContent="Generating...";fetch("/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({})}).then(function(r){return r.json();}).then(function(d){if(d.error){alert(d.error);btn.disabled=false;btn.textContent="Generate My Addon URL";return;}gurl=d.manifestUrl;document.getElementById("rurl").textContent=gurl;document.getElementById("result").style.display="block";btn.textContent="Regenerate URL";btn.disabled=false;}).catch(function(e){alert("Failed: "+e.message);btn.disabled=false;btn.textContent="Generate My Addon URL";});}function copyUrl(){if(!gurl)return;navigator.clipboard.writeText(gurl).then(function(){var b=document.querySelector(".copy");b.textContent="Copied!";setTimeout(function(){b.textContent="⧃ Copy URL";},1500);});}<\/script></body></html>';
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

  var token = generateToken();
  var entry = { createdAt: Date.now(), lastUsed: Date.now(), reqCount: 0, rateWin: [] };
  TOKEN_CACHE.set(token, entry);
  await redisSave(token, entry);
  bucket.count++;

  console.log('[TOKEN] Created. IP: ' + ip + ' | total: ' + TOKEN_CACHE.size);
  res.json({ token: token, manifestUrl: getBaseUrl(req) + '/u/' + token + '/manifest.json' });
});

app.get('/u/:token/manifest.json', tokenMiddleware, function(req, res) {
  res.json({
    id:          'com.eclipse.internetarchive.' + req.params.token.slice(0, 8),
    name:        'Internet Archive',
    version:     '1.0.0',
    description: 'Search and stream millions of free recordings from the Internet Archive.',
    icon:        'https://archive.org/favicon.ico',
    resources:   ['search', 'stream'],
    types:       ['track']
  });
});

app.get('/u/:token/search', tokenMiddleware, async function(req, res) {
  var q = cleanText(req.query.q || '');
  if (!q) return res.json({ tracks: [] });
  try {
    var searchUrl = IA_BASE + '/advancedsearch.php?q=' + encodeURIComponent(q + ' mediatype:audio')
      + '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&fl[]=format'
      + '&rows=15&page=1&output=json&sort[]=downloads+desc';

    var data    = await iaGet(searchUrl);
    var docs    = (data && data.response && data.response.docs) ? data.response.docs : [];
    console.log('[/search] q="' + q + '" -> ' + docs.length + ' items, fetching audio files...');

    var promises = docs.slice(0, 12).map(function(doc) {
      return fetchItemTracks(doc.identifier, doc.title, doc.creator, doc.year);
    });
    var results = await Promise.all(promises);

    var tracks = [];
    results.forEach(function(arr) { tracks = tracks.concat(arr); });

    console.log('[/search] Returning ' + tracks.length + ' tracks');
    res.json({ tracks: tracks });
  } catch (err) {
    console.error('[/search] ' + err.message);
    res.status(500).json({ error: 'Search failed: ' + err.message, tracks: [] });
  }
});

app.get('/u/:token/stream/:id(*)', tokenMiddleware, async function(req, res) {
  var raw     = req.params.id || '';
  var decoded = decodeTrackId(raw);
  if (!decoded) return res.status(400).json({ error: 'Invalid track ID.' });

  var identifier = decoded.identifier;
  var filename   = decoded.filename;
  var streamUrl  = IA_BASE + '/download/' + identifier + '/' + encodeURIComponent(filename);

  console.log('[/stream] ' + identifier + ' / ' + filename);
  res.json({
    url:    streamUrl,
    format: filename.toLowerCase().endsWith('.ogg') ? 'ogg' : 'mp3'
  });
});

app.get('/health', function(_req, res) {
  res.json({
    status:         'ok',
    redisConnected: !!(redis && redis.status === 'ready'),
    activeTokens:   TOKEN_CACHE.size,
    uptime:         Math.floor(process.uptime()) + 's'
  });
});

app.listen(PORT, function() {
  console.log('🏛 Eclipse Internet Archive Addon on port ' + PORT);
});
