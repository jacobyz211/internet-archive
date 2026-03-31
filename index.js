const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

// ─── In-memory token store ────────────────────────────────────────────────────
// No Redis — keeps the server dead-simple and compatible with any Node version.
// Tokens reset on restart (Render free tier restarts on inactivity anyway).
const TOKENS     = new Map();
const IP_BUCKETS = new Map();

function generateToken() { return crypto.randomBytes(16).toString('hex'); }

function ipBucket(ip) {
  var now = Date.now();
  var b   = IP_BUCKETS.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 86400000 }; IP_BUCKETS.set(ip, b); }
  return b;
}

function getToken(token) { return TOKENS.get(token) || null; }

function rateOk(entry) {
  var now = Date.now();
  entry.win = (entry.win || []).filter(function(t) { return now - t < 60000; });
  if (entry.win.length >= 60) return false;
  entry.win.push(now);
  return true;
}

function auth(req, res, next) {
  var entry = getToken(req.params.token);
  if (!entry) return res.status(404).json({ error: 'Unknown token. Visit ' + base(req) + ' to generate one.' });
  if (!rateOk(entry)) return res.status(429).json({ error: 'Rate limit: 60 req/min.' });
  next();
}

function base(req) {
  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}

// ─── Archive.org helpers ──────────────────────────────────────────────────────
var IA = 'https://archive.org';

async function iaGet(url) {
  var r = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'EclipseAddon/1.0' },
    responseType: 'text'
  });
  return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
}

var FMT = { 'VBR MP3': 1, 'MP3': 2, '256Kbps MP3': 3, '128Kbps MP3': 4, 'Ogg Vorbis': 5, '64Kbps MP3': 6 };
var SKIP = /^(cover|folder|albumart|artwork|._)/i;

function bestAudio(files) {
  var audio = files.filter(function(f) {
    var n = (f.name || '').toLowerCase();
    return !SKIP.test(f.name) && (n.endsWith('.mp3') || n.endsWith('.ogg'));
  });
  // Deduplicate bitrate variants — keep best quality per track
  var groups = {};
  audio.forEach(function(f) {
    var k = f.name.replace(/\.(mp3|ogg)$/i, '').replace(/[_-]*(vbr|64kb|128kb|256kb)$/i, '').toLowerCase();
    if (!groups[k] || (FMT[f.format] || 99) < (FMT[groups[k].format] || 99)) groups[k] = f;
  });
  var out = Object.values(groups);
  out.sort(function(a, b) {
    var na = a.name.match(/^(\d+)/), nb = b.name.match(/^(\d+)/);
    if (na && nb) return +na[1] - +nb[1];
    return a.name.localeCompare(b.name);
  });
  return out;
}

function t(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

// ─── Config page ──────────────────────────────────────────────────────────────
function page(baseUrl) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Eclipse \u2022 Internet Archive</title>'
    + '<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d0d;color:#e0e0e0;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;min-height:100vh;'
    + 'display:flex;flex-direction:column;align-items:center;padding:52px 20px 72px}'
    + '.logo{width:60px;height:60px;background:#3a30e8;border-radius:16px;display:flex;align-items:center;'
    + 'justify-content:center;font-size:22px;font-weight:900;color:#fff;margin-bottom:22px}'
    + '.card{background:#141414;border:1px solid #202020;border-radius:20px;padding:38px;'
    + 'max-width:500px;width:100%;box-shadow:0 28px 70px rgba(0,0,0,.5)}'
    + 'h1{font-size:21px;font-weight:700;color:#fff;margin-bottom:8px}'
    + 'p.sub{font-size:13px;color:#666;line-height:1.65;margin-bottom:24px}'
    + '.pills{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:30px}'
    + '.pill{font-size:11px;font-weight:600;padding:4px 11px;border-radius:20px}'
    + '.g{background:#0c1f0c;color:#5dba5d;border:1px solid #1b3b1b}'
    + '.b{background:#0a0a1e;color:#897ce0;border:1px solid #18183a}'
    + 'button.go{width:100%;background:#3a30e8;border:none;border-radius:11px;color:#fff;'
    + 'font-size:15px;font-weight:700;padding:15px;cursor:pointer;margin-bottom:18px;transition:.15s}'
    + 'button.go:hover{background:#2e25c4}button.go:disabled{background:#1e1e1e;color:#444;cursor:not-allowed}'
    + '.box{display:none;background:#0c0c0c;border:1px solid #1c1c1c;border-radius:13px;padding:18px;margin-bottom:18px}'
    + '.lbl{font-size:10px;color:#444;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}'
    + '.url{font-size:12px;color:#897ce0;word-break:break-all;font-family:monospace;margin-bottom:14px;line-height:1.5}'
    + 'button.cp{width:100%;background:#181818;border:1px solid #202020;border-radius:8px;color:#888;'
    + 'font-size:13px;font-weight:600;padding:10px;cursor:pointer;transition:.15s}'
    + 'button.cp:hover{background:#1e1e1e;color:#ccc}'
    + 'hr{border:none;border-top:1px solid #191919;margin:26px 0}'
    + '.steps{display:flex;flex-direction:column;gap:12px}'
    + '.step{display:flex;gap:12px;align-items:flex-start}'
    + '.n{width:26px;height:26px;min-width:26px;background:#181818;border:1px solid #252525;'
    + 'border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#555}'
    + '.s{font-size:13px;color:#555;line-height:1.6}.s strong{color:#999}'
    + '.note{background:#09091a;border:1px solid #15153a;border-radius:11px;padding:14px 16px;'
    + 'margin-top:22px;font-size:12px;color:#6050a0;line-height:1.7}'
    + 'footer{margin-top:36px;font-size:11px;color:#2a2a2a}</style></head><body>'
    + '<div class="logo">IA</div><div class="card">'
    + '<h1>Internet Archive for Eclipse</h1>'
    + '<p class="sub">Millions of free, legal recordings \u2014 live concerts, vintage albums, radio shows and more. No login or API key needed.</p>'
    + '<div class="pills"><span class="pill g">\u2713 No API key</span><span class="pill g">\u2713 Zero setup</span>'
    + '<span class="pill b">\u2713 Instant search</span><span class="pill b">\u2713 Auto best quality</span></div>'
    + '<button class="go" id="gb" onclick="gen()">Generate My Addon URL</button>'
    + '<div class="box" id="bx"><div class="lbl">Your URL \u2014 paste into Eclipse</div>'
    + '<div class="url" id="ur"></div><button class="cp" onclick="cp()">\u29c3 Copy</button></div>'
    + '<hr><div class="steps">'
    + '<div class="step"><div class="n">1</div><div class="s">Click Generate and copy your URL</div></div>'
    + '<div class="step"><div class="n">2</div><div class="s">Open <strong>Eclipse</strong> \u2192 Library \u2192 Cloud \u2192 Add Connection \u2192 Addon</div></div>'
    + '<div class="step"><div class="n">3</div><div class="s">Paste and tap <strong>Install</strong></div></div>'
    + '<div class="step"><div class="n">4</div><div class="s">Search for any artist, concert, or album</div></div>'
    + '</div><div class="note">\u2139\ufe0f Search returns results instantly with one API call. Audio is resolved only when you tap Play, so nothing ever hangs.</div></div>'
    + '<footer>Eclipse Internet Archive \u2022 ' + baseUrl + '</footer>'
    + '<script>var u="";'
    + 'function gen(){'
    + 'var b=document.getElementById("gb");b.disabled=true;b.textContent="Generating...";'
    + 'fetch("/generate",{method:"POST"}).then(r=>r.json()).then(d=>{'
    + 'if(d.error){alert(d.error);b.disabled=false;b.textContent="Generate My Addon URL";return;}'
    + 'u=d.manifestUrl;document.getElementById("ur").textContent=u;'
    + 'document.getElementById("bx").style.display="block";'
    + 'b.textContent="Regenerate";b.disabled=false;'
    + '}).catch(e=>{alert(e.message);b.disabled=false;b.textContent="Generate My Addon URL";});}'
    + 'function cp(){if(!u)return;navigator.clipboard.writeText(u).then(()=>{'
    + 'var b=document.querySelector(".cp");b.textContent="Copied!";'
    + 'setTimeout(()=>b.textContent="\u29c3 Copy",1500);});}'
    + '<\/script></body></html>';
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', function(req, res) {
  res.setHeader('Content-Type', 'text/html');
  res.send(page(base(req)));
});

app.post('/generate', function(req, res) {
  var ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x').split(',')[0].trim();
  var b  = ipBucket(ip);
  if (b.count >= 10) return res.status(429).json({ error: 'Too many tokens today.' });
  var token = generateToken();
  TOKENS.set(token, { createdAt: Date.now(), win: [] });
  b.count++;
  console.log('[TOKEN] created ' + token.slice(0, 8) + '... total=' + TOKENS.size);
  res.json({ token: token, manifestUrl: base(req) + '/u/' + token + '/manifest.json' });
});

app.get('/u/:token/manifest.json', auth, function(req, res) {
  res.json({
    id:          'com.eclipse.internetarchive.' + req.params.token.slice(0, 8),
    name:        'Internet Archive',
    version:     '4.0.0',
    description: 'Search and stream millions of free recordings from the Internet Archive.',
    icon:        'https://archive.org/favicon.ico',
    resources:   ['search', 'stream'],
    types:       ['track']
  });
});

// Search — one HTTP request, returns instantly
app.get('/u/:token/search', auth, async function(req, res) {
  var q = t(req.query.q || '');
  if (!q) return res.json({ tracks: [] });

  try {
    var musicQ = q + ' mediatype:audio (subject:music OR collection:etree OR collection:audio_music)';
    var url    = IA + '/advancedsearch.php'
      + '?q='   + encodeURIComponent(musicQ)
      + '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year'
      + '&rows=20&page=1&output=json&sort[]=downloads+desc';

    var data = await iaGet(url);
    var docs = (data && data.response && data.response.docs) ? data.response.docs : [];

    // Fallback: plain audio search if music filter returned nothing
    if (!docs.length) {
      url  = IA + '/advancedsearch.php'
        + '?q='   + encodeURIComponent(q + ' mediatype:audio')
        + '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year'
        + '&rows=20&page=1&output=json&sort[]=downloads+desc';
      data = await iaGet(url);
      docs = (data && data.response && data.response.docs) ? data.response.docs : [];
    }

    var tracks = docs.map(function(d) {
      return {
        id:         d.identifier,
        title:      t(d.title) || d.identifier,
        artist:     t(d.creator) || 'Internet Archive',
        year:       d.year || null,
        artworkURL: IA + '/services/img/' + d.identifier
      };
    });

    console.log('[search] "' + q + '" -> ' + tracks.length + ' results');
    res.json({ tracks: tracks });

  } catch (err) {
    console.error('[search] ' + err.message);
    res.status(500).json({ error: err.message, tracks: [] });
  }
});

// Stream — one metadata fetch only when user taps Play
app.get('/u/:token/stream/:id(*)', auth, async function(req, res) {
  var id = decodeURIComponent(req.params.id || '').trim();
  if (!id) return res.status(400).json({ error: 'Missing identifier.' });

  try {
    var data  = await iaGet(IA + '/metadata/' + id + '/files');
    var files = Array.isArray(data) ? data : (data.result || []);
    var best  = bestAudio(files);

    if (!best.length) return res.status(404).json({ error: 'No audio found for: ' + id });

    var f = best[0];
    console.log('[stream] ' + id + ' -> ' + f.name);
    res.json({
      url:    IA + '/download/' + id + '/' + encodeURIComponent(f.name),
      format: f.name.toLowerCase().endsWith('.ogg') ? 'ogg' : 'mp3'
    });

  } catch (err) {
    console.error('[stream] ' + id + ': ' + err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', function(_req, res) {
  res.json({ status: 'ok', tokens: TOKENS.size, uptime: Math.floor(process.uptime()) + 's' });
});

app.listen(PORT, function() {
  console.log('Internet Archive addon running on port ' + PORT);
});
