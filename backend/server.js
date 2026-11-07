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

// Everything the stats dashboard needs, for the last N days (7, 30 or 90). All anonymous counts.
let devicesCol = null;
app.get('/v1/dashboard', async (req, res) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const now = Date.now(), DAY = 86_400_000;
    const start = new Date(now - days * DAY), prevStart = new Date(now - 2 * days * DAY);
    const plat = { $ifNull: ['$platform', 'macos'] };
    const dayOf = (f) => ({ $dateToString: { format: '%Y-%m-%d', date: f } });
    const [total, byPlatform, inRange, prevRange, today, installDays, dlDays, dlTotal, dlRange, dlPrev, dlBySource, byVersion, byArch, byOS, waiting, recent, phoneAgg, online] = await Promise.all([
      installs.countDocuments(),
      installs.aggregate([{ $group: { _id: plat, n: { $sum: 1 } } }]).toArray(),
      installs.countDocuments({ firstSeen: { $gte: start } }),
      installs.countDocuments({ firstSeen: { $gte: prevStart, $lt: start } }),
      installs.countDocuments({ firstSeen: { $gte: new Date(now - DAY) } }),
      installs.aggregate([{ $match: { firstSeen: { $gte: start } } }, { $group: { _id: { d: dayOf('$firstSeen'), p: plat }, n: { $sum: 1 } } }]).toArray(),
      downloads.aggregate([{ $match: { at: { $gte: start } } }, { $group: { _id: { d: dayOf('$at'), w: { $regexMatch: { input: { $ifNull: ['$source', ''] }, regex: /-win$/ } } }, n: { $sum: 1 } } }]).toArray(),
      downloads.countDocuments(),
      downloads.countDocuments({ at: { $gte: start } }),
      downloads.countDocuments({ at: { $gte: prevStart, $lt: start } }),
      downloads.aggregate([{ $group: { _id: '$source', n: { $sum: 1 } } }]).toArray(),
      installs.aggregate([{ $group: { _id: { v: '$appVersion', p: plat }, n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray(),
      installs.aggregate([{ $group: { _id: { a: '$arch', p: plat }, n: { $sum: 1 } } }]).toArray(),
      installs.aggregate([{ $group: { _id: { o: '$osVersion', p: plat }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 10 }]).toArray(),
      waitlist.countDocuments(),
      installs.find({}, { projection: { _id: 0, firstSeen: 1, platform: 1, appVersion: 1, osVersion: 1, arch: 1 } }).sort({ firstSeen: -1 }).limit(15).toArray(),
      devicesCol.aggregate([{ $project: { n: { $size: { $ifNull: ['$phones', []] } } } }, { $group: { _id: null, phones: { $sum: '$n' }, macs: { $sum: { $cond: [{ $gt: ['$n', 0] }, 1, 0] } } } }]).toArray(),
      devicesCol.countDocuments({ lastSeen: { $gte: new Date(now - 120_000) }, 'phones.0': { $exists: true } }),
    ]);
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * DAY).toISOString().slice(0, 10);
      const get = (arr, f) => arr.filter(f).reduce((t, x) => t + x.n, 0);
      series.push({
        day: d,
        mac: get(installDays, (x) => x._id.d === d && x._id.p !== 'windows'),
        windows: get(installDays, (x) => x._id.d === d && x._id.p === 'windows'),
        dlMac: get(dlDays, (x) => x._id.d === d && !x._id.w),
        dlWindows: get(dlDays, (x) => x._id.d === d && x._id.w),
      });
    }
    const p = Object.fromEntries(byPlatform.map((x) => [x._id, x.n]));
    res.set('Cache-Control', 'no-store').json({
      days, updatedAt: new Date().toISOString(),
      installs: { total, mac: p.macos || 0, windows: p.windows || 0, inRange, prevRange, today },
      downloads: { total: dlTotal, inRange: dlRange, prevRange: dlPrev, bySource: Object.fromEntries(dlBySource.map((x) => [x._id || 'other', x.n])) },
      phones: { paired: (phoneAgg[0] || {}).phones || 0, computers: (phoneAgg[0] || {}).macs || 0, online },
      windowsWaitlist: waiting,
      series,
      versions: byVersion.map((x) => ({ version: x._id.v || 'unknown', platform: x._id.p, n: x.n })),
      chips: byArch.map((x) => ({ arch: x._id.a || 'unknown', platform: x._id.p, n: x.n })),
      systems: byOS.map((x) => ({ os: x._id.o || 'unknown', platform: x._id.p, n: x.n })),
      recent: recent.map((r) => ({ at: r.firstSeen, platform: r.platform || 'macos', version: r.appVersion || '', os: r.osVersion || '', arch: r.arch || '' })),
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load dashboard' }); }
});

app.get('/v1/stats', async (req, res) => {
  try { res.json(await stats()); } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load stats' }); }
});

// The stats dashboard
app.get('/', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'public', 'dashboard', 'index.html')); });
app.use('/dashboard', express.static(path.join(__dirname, 'public', 'dashboard')));

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
  devicesCol = client.db(DB_NAME).collection('devices');
  downloads = client.db(DB_NAME).collection('download_clicks');
  await downloads.createIndex({ at: -1 });
  await waitlist.createIndex({ voterId: 1 }, { unique: true });
  app.listen(PORT, '127.0.0.1', () => console.log(`Mimo backend listening on ${PORT}`));
})().catch((e) => { console.error(e); process.exit(1); });
