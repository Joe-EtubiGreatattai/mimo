// Mimo backend — counts installs.
// Mimo sends one ping on first launch with a random install ID it generates itself.
// No names, emails, IP addresses or file information are stored.
require('dotenv').config();
const express = require('express');
const { MongoClient } = require('mongodb');
const path = require('path');
const remote = require('./remote');

const PORT = Number(process.env.PORT || 5060);
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'mimo';
if (!MONGODB_URI) { console.error('MONGODB_URI is not set'); process.exit(1); }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => (req.path.startsWith('/v1/remote') || req.path.startsWith('/v1/device') || req.path.startsWith('/v1/pair')) ? next() : express.json({ limit: '4kb' })(req, res, next));

// The phone app (installable PWA)
app.use('/app', express.static(path.join(__dirname, 'public/app'), {
  setHeaders: (res, p) => { if (p.endsWith('sw.js') || p.endsWith('.html')) res.set('Cache-Control', 'no-cache'); }
}));

let installs, waitlist, downloads;

// The landing page (GitHub Pages) calls the Windows waitlist from the browser.
const ALLOWED_ORIGINS = ['https://joe-etubigreatattai.github.io'];
app.use(['/v1/windows', '/v1/downloads'], (req, res, next) => {
  const o = req.headers.origin;
  if (o && (ALLOWED_ORIGINS.includes(o) || /^https?:\/\/localhost(:\d+)?$/.test(o))) {
    res.set('Access-Control-Allow-Origin', o);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Small in-memory rate limit: 30 requests per minute per IP (IPs are never stored).
const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();
function rateLimit(req, res, next) {
  const k = req.ip || 'x';
  const n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  if (n > 30) return res.status(429).json({ error: 'Too many requests' });
  next();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v, max = 40) => (typeof v === 'string' ? v.replace(/[^\w .()+-]/g, '').slice(0, max) : undefined);

app.get('/health', (req, res) => res.json({ ok: true }));

// Mimo calls this once, the first time it runs on a Mac.
app.post('/v1/installs', rateLimit, async (req, res) => {
  try {
    const { installId, appVersion, osVersion, arch, platform } = req.body || {};
    if (!UUID.test(installId || '')) return res.status(400).json({ error: 'installId must be a UUID' });
    const now = new Date();
    const r = await installs.updateOne(
      { installId: installId.toLowerCase() },
      {
        $setOnInsert: { installId: installId.toLowerCase(), firstSeen: now },
        $set: { lastSeen: now, appVersion: clean(appVersion), osVersion: clean(osVersion), arch: clean(arch, 12), platform: ['windows', 'macos'].includes(platform) ? platform : (/^windows/i.test(osVersion || '') ? 'windows' : 'macos') },
      },
      { upsert: true }
    );
    res.status(r.upsertedCount ? 201 : 200).json({ ok: true, new: Boolean(r.upsertedCount) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not record install' });
  }
});

// Download button clicks. The page sends these with sendBeacon (plain text), so accept text too.
const SOURCES = new Set(['hero', 'footer', 'nav', 'readme', 'other', 'hero-win', 'footer-win', 'nav-win']);
app.get('/v1/downloads', async (req, res) => {
  try { res.json({ downloads: await downloads.countDocuments() }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not load downloads' }); }
});
app.post('/v1/downloads', rateLimit, express.text({ type: ['text/plain', 'application/json'], limit: '1kb' }), async (req, res) => {
  try {
    let source = 'other';
    try { const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); if (SOURCES.has(b.source)) source = b.source; } catch {}
    await downloads.insertOne({ at: new Date(), source });
    res.status(201).json({ ok: true, downloads: await downloads.countDocuments() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not record download' }); }
});

// Windows waitlist: each browser makes a random ID so the same person isn't counted twice.
app.get('/v1/windows', async (req, res) => {
  try { res.json({ waiting: await waitlist.countDocuments() }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not load waitlist' }); }
});
app.post('/v1/windows', rateLimit, async (req, res) => {
  try {
    const { voterId } = req.body || {};
    if (!UUID.test(voterId || '')) return res.status(400).json({ error: 'voterId must be a UUID' });
    const r = await waitlist.updateOne(
      { voterId: voterId.toLowerCase() },
      { $setOnInsert: { voterId: voterId.toLowerCase(), joinedAt: new Date() } },
      { upsert: true }
    );
    res.status(r.upsertedCount ? 201 : 200).json({ ok: true, new: Boolean(r.upsertedCount), waiting: await waitlist.countDocuments() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not join waitlist' }); }
});

async function stats() {
  const now = Date.now();
  const since = (days) => new Date(now - days * 86_400_000);
  const [total, d1, d7, d30, byVersion, byArch, byDay, windowsWaiting, downloadClicks, downloads7d, byPlatform, winDownloads] = await Promise.all([
    installs.countDocuments(),
    installs.countDocuments({ firstSeen: { $gte: since(1) } }),
    installs.countDocuments({ firstSeen: { $gte: since(7) } }),
    installs.countDocuments({ firstSeen: { $gte: since(30) } }),
    installs.aggregate([{ $group: { _id: '$appVersion', count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(),
    installs.aggregate([{ $group: { _id: '$arch', count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray(),
    installs.aggregate([
      { $match: { firstSeen: { $gte: since(30) } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$firstSeen' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    waitlist.countDocuments(),
    downloads.countDocuments(),
    downloads.countDocuments({ at: { $gte: since(7) } }),
    installs.aggregate([{ $group: { _id: { $ifNull: ['$platform', 'macos'] }, count: { $sum: 1 } } }]).toArray(),
    downloads.countDocuments({ source: /-win$/ }),
  ]);
  const map = (a) => a.map((x) => ({ [x._id || 'unknown']: x.count })).reduce((o, x) => Object.assign(o, x), {});
  return { totalInstalls: total, last24h: d1, last7d: d7, last30d: d30, byVersion: map(byVersion), byChip: map(byArch), byDay: map(byDay), windowsWaiting, downloadClicks, downloads7d, byPlatform: map(byPlatform), windowsDownloads: winDownloads, updatedAt: new Date().toISOString() };
}

app.get('/v1/stats', async (req, res) => {
  try { res.json(await stats()); } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load stats' }); }
});

// A tiny page you can open in a browser to see the count.
app.get('/', async (req, res) => {
  let s;
  try { s = await stats(); } catch { return res.status(500).send('Stats unavailable'); }
  const rows = Object.entries(s.byDay).slice(-14).map(([d, c]) => `<tr><td>${d}</td><td>${c}</td></tr>`).join('') || '<tr><td colspan="2">No installs yet</td></tr>';
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mimo installs</title><style>
body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:32px 16px;background:#F5F9FD;color:#13202F}
main{max-width:560px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}p{margin:0;color:#4A5B6E}
.big{font-size:64px;font-weight:800;margin:16px 0 4px;font-variant-numeric:tabular-nums}
.row{display:flex;flex-wrap:wrap;gap:16px 24px;margin:16px 0 28px}.row div b{display:block;font-size:22px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td{padding:6px 0;border-bottom:1px solid #dde7f0}td:last-child{text-align:right}
@media (prefers-color-scheme:dark){body{background:#0D1622;color:#E9F1FA}p{color:#9DB0C4}td{border-color:#223247}}
</style></head><body><main>
<h1>Mimo installs</h1><p>Updated ${new Date(s.updatedAt).toUTCString()}</p>
<div class="big">${s.totalInstalls.toLocaleString()}</div><p>Macs that have installed Mimo</p>
<div class="row"><div><b>${s.last24h}</b>last 24 hours</div><div><b>${s.last7d}</b>last 7 days</div><div><b>${s.last30d}</b>last 30 days</div><div><b>${s.windowsWaiting}</b>waiting for Windows</div></div>
<div class="row"><div><b>${(s.byPlatform.macos || 0).toLocaleString()}</b>Mac installs</div><div><b>${(s.byPlatform.windows || 0).toLocaleString()}</b>Windows installs</div></div>
<div class="row"><div><b>${s.downloadClicks.toLocaleString()}</b>download clicks</div><div><b>${s.windowsDownloads.toLocaleString()}</b>of them for Windows</div><div><b>${s.downloads7d}</b>clicks in the last 7 days</div></div>
<table><tr><td><b>Day</b></td><td><b>New installs</b></td></tr>${rows}</table>
</main></body></html>`);
});

let remoteRouter = null;
app.use('/v1', (req, res, next) => remoteRouter ? remoteRouter(req, res, next) : res.status(503).json({ error: 'Starting up' }));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

(async () => {
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  remoteRouter = remote(client.db(DB_NAME));
  installs = client.db(DB_NAME).collection('installs');
  await installs.createIndex({ installId: 1 }, { unique: true });
  await installs.createIndex({ firstSeen: -1 });
  waitlist = client.db(DB_NAME).collection('windows_waitlist');
  downloads = client.db(DB_NAME).collection('download_clicks');
  await downloads.createIndex({ at: -1 });
  await waitlist.createIndex({ voterId: 1 }, { unique: true });
  app.listen(PORT, '127.0.0.1', () => console.log(`Mimo backend listening on ${PORT}`));
})().catch((e) => { console.error(e); process.exit(1); });
