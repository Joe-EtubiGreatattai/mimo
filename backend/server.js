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

let installs, waitlist, downloads, cleanups;

// The landing page (GitHub Pages) calls the Windows waitlist from the browser.
const ALLOWED_ORIGINS = ['https://joe-etubigreatattai.github.io'];
app.use(['/v1/windows', '/v1/downloads', '/v1/cleared'], (req, res, next) => {
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

// Space cleared: Mimo reports how much each clean cleared, by category. No file or folder names.
app.post('/v1/cleanups', rateLimit, async (req, res) => {
  try {
    const { installId, platform, appVersion, arch, trigger, bytes, categories } = req.body || {};
    const b = Number(bytes);
    if (!UUID.test(installId || '') || !(b > 0 && b < 20e12)) return res.status(400).json({ error: 'Bad cleanup report' });
    const cats = (Array.isArray(categories) ? categories : []).slice(0, 30)
      .filter((c) => c && /^[\w:-]{1,40}$/.test(String(c.id || '')) && Number(c.bytes) > 0 && Number(c.bytes) < 20e12)
      .map((c) => ({ id: String(c.id), name: clean(c.name, 50) || String(c.id), bytes: Number(c.bytes) }));
    await cleanups.insertOne({
      at: new Date(), installId: installId.toLowerCase(), bytes: b, categories: cats,
      platform: platform === 'windows' ? 'windows' : 'macos', appVersion: clean(appVersion), arch: clean(arch, 12),
      trigger: ['auto', 'review', 'phone', 'manual'].includes(trigger) ? trigger : 'other',
    });
    // a clean also tells us which version that computer runs now
    if (clean(appVersion)) await installs.updateOne({ installId: installId.toLowerCase() }, { $set: { appVersion: clean(appVersion), lastSeen: new Date() } }).catch(() => {});
    res.status(201).json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not record cleanup' }); }
});

// Daily check-in: the "clean below" level each person picked and how much free space they have. Anonymous.
app.post('/v1/checkins', rateLimit, async (req, res) => {
  try {
    const { installId, platform, appVersion, cleanBelowGB, askFirst, freeGB, totalGB } = req.body || {};
    const lvl = Number(cleanBelowGB), free = Number(freeGB), total = Number(totalGB);
    if (!UUID.test(installId || '') || !(lvl >= 1 && lvl <= 2000) || !(free >= 0 && free <= 100000) || !(total > 0 && total <= 100000))
      return res.status(400).json({ error: 'Bad check-in' });
    const now = new Date();
    await installs.updateOne(
      { installId: installId.toLowerCase() },
      {
        $setOnInsert: { installId: installId.toLowerCase(), firstSeen: now },
        $set: { lastSeen: now, checkedInAt: now, appVersion: clean(appVersion), platform: platform === 'windows' ? 'windows' : 'macos',
          cleanBelowGB: Math.round(lvl), askFirst: askFirst !== false, freeGB: Math.round(free), totalGB: Math.round(total) },
      },
      { upsert: true }
    );
    res.status(201).json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not record check-in' }); }
});

// Download button clicks. The page sends these with sendBeacon (plain text), so accept text too.
const SOURCES = new Set(['hero', 'footer', 'nav', 'readme', 'other', 'hero-win', 'footer-win', 'nav-win']);
app.get('/v1/downloads', async (req, res) => {
  try { res.json({ downloads: await downloads.countDocuments() }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Could not load downloads' }); }
});
// Public running total for the website: how much space Mimo has cleared for everyone. Cached briefly.
let clearedCache = { at: 0, body: null };
app.get('/v1/cleared', async (req, res) => {
  try {
    if (!clearedCache.body || Date.now() - clearedCache.at > 20_000) {
      const [a] = await cleanups.aggregate([{ $group: { _id: null, bytes: { $sum: '$bytes' }, n: { $sum: 1 }, computers: { $addToSet: '$installId' } } }, { $project: { bytes: 1, n: 1, computers: { $size: '$computers' } } }]).toArray();
      clearedCache = { at: Date.now(), body: { bytes: (a || {}).bytes || 0, cleans: (a || {}).n || 0, computers: (a || {}).computers || 0 } };
    }
    res.set('Cache-Control', 'public, max-age=20').json(clearedCache.body);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not load total' }); }
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
// Real downloads, counted by GitHub across every release (includes links shared outside the website)
let gh = { mac: 0, windows: 0, total: 0, at: 0 };
async function githubDownloads() {
  if (Date.now() - gh.at < 600_000) return gh;
  try {
    const r = await fetch('https://api.github.com/repos/Joe-EtubiGreatattai/mimo/releases?per_page=100', { headers: { 'User-Agent': 'mimo-backend', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('GitHub ' + r.status);
    let mac = 0, windows = 0;
    for (const rel of await r.json()) for (const a of rel.assets || []) {
      if (/\.dmg$/i.test(a.name)) mac += a.download_count; else if (/\.exe$/i.test(a.name)) windows += a.download_count;
    }
    gh = { mac, windows, total: mac + windows, at: Date.now() };
  } catch (e) { console.error('github downloads', e.message); gh.at = Date.now() - 540_000; }
  return gh;
}
app.get('/v1/dashboard', async (req, res) => {
  try {
    const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
    const now = Date.now(), DAY = 86_400_000;
    const start = new Date(now - days * DAY), prevStart = new Date(now - 2 * days * DAY);
    const plat = { $ifNull: ['$platform', 'macos'] };
    const dayOf = (f) => ({ $dateToString: { format: '%Y-%m-%d', date: f } });
    const [total, byPlatform, inRange, prevRange, today, installDays, dlDays, dlTotal, dlRange, dlPrev, dlBySource, byVersion, byArch, byOS, waiting, recent, phoneAgg, online, clAll, clRange, clPrev, clDays, clCats, clTriggers, clPlatform] = await Promise.all([
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
      cleanups.aggregate([{ $group: { _id: null, bytes: { $sum: '$bytes' }, n: { $sum: 1 }, computers: { $addToSet: '$installId' } } }, { $project: { bytes: 1, n: 1, computers: { $size: '$computers' } } }]).toArray(),
      cleanups.aggregate([{ $match: { at: { $gte: start } } }, { $group: { _id: null, bytes: { $sum: '$bytes' }, n: { $sum: 1 } } }]).toArray(),
      cleanups.aggregate([{ $match: { at: { $gte: prevStart, $lt: start } } }, { $group: { _id: null, bytes: { $sum: '$bytes' } } }]).toArray(),
      cleanups.aggregate([{ $match: { at: { $gte: start } } }, { $group: { _id: { d: dayOf('$at'), p: '$platform' }, bytes: { $sum: '$bytes' } } }]).toArray(),
      cleanups.aggregate([{ $unwind: '$categories' }, { $group: { _id: '$categories.id', name: { $last: '$categories.name' }, bytes: { $sum: '$categories.bytes' }, mac: { $sum: { $cond: [{ $eq: ['$platform', 'windows'] }, 0, '$categories.bytes'] } }, n: { $sum: 1 } } }, { $sort: { bytes: -1 } }, { $limit: 10 }]).toArray(),
      cleanups.aggregate([{ $group: { _id: '$trigger', n: { $sum: 1 }, bytes: { $sum: '$bytes' } } }]).toArray(),
      cleanups.aggregate([{ $group: { _id: '$platform', bytes: { $sum: '$bytes' } } }]).toArray(),
    ]);
    const G = await githubDownloads();
    // Storage levels from computers that checked in during the last 30 days
    const lv = await installs.find({ checkedInAt: { $gte: new Date(now - 30 * DAY) } }, { projection: { _id: 0, platform: 1, cleanBelowGB: 1, askFirst: 1, freeGB: 1, totalGB: 1 } }).toArray();
    const median = (xs) => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y), m = a.length >> 1; return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2); };
    const bucket = (list, val, edges) => edges.map(([label, lo, hi]) => {
      const inB = list.filter((x) => val(x) >= lo && val(x) < hi);
      return { label, n: inB.length, mac: inB.filter((x) => x.platform !== 'windows').length, windows: inB.filter((x) => x.platform === 'windows').length };
    });
    const levels = {
      computers: lv.length,
      medianCleanBelow: median(lv.map((x) => x.cleanBelowGB)),
      medianFree: median(lv.map((x) => x.freeGB)),
      medianFreePct: median(lv.map((x) => Math.round((x.freeGB / Math.max(1, x.totalGB)) * 100))),
      runningLow: lv.filter((x) => x.freeGB < x.cleanBelowGB).length,
      askFirst: lv.filter((x) => x.askFirst !== false).length,
      cleanBelow: bucket(lv, (x) => x.cleanBelowGB, [['Under 10 GB', 0, 10], ['10–14 GB', 10, 15], ['15 GB (default)', 15, 16], ['16–25 GB', 16, 26], ['26–50 GB', 26, 51], ['Over 50 GB', 51, Infinity]]),
      free: bucket(lv, (x) => x.freeGB, [['Under 10 GB', 0, 10], ['10–25 GB', 10, 25], ['25–50 GB', 25, 50], ['50–100 GB', 50, 100], ['100–250 GB', 100, 250], ['250 GB or more', 250, Infinity]]),
    };
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
        clearedMac: clDays.filter((x) => x._id.d === d && x._id.p !== 'windows').reduce((t, x) => t + x.bytes, 0),
        clearedWindows: clDays.filter((x) => x._id.d === d && x._id.p === 'windows').reduce((t, x) => t + x.bytes, 0),
      });
    }
    const p = Object.fromEntries(byPlatform.map((x) => [x._id, x.n]));
    res.set('Cache-Control', 'no-store').json({
      days, updatedAt: new Date().toISOString(),
      installs: { total, mac: p.macos || 0, windows: p.windows || 0, inRange, prevRange, today },
      downloads: { total: dlTotal, inRange: dlRange, prevRange: dlPrev, bySource: Object.fromEntries(dlBySource.map((x) => [x._id || 'other', x.n])) },
      levels,
      github: { mac: G.mac, windows: G.windows, total: G.total },
      phones: { paired: (phoneAgg[0] || {}).phones || 0, computers: (phoneAgg[0] || {}).macs || 0, online },
      windowsWaitlist: waiting,
      cleared: {
        total: (clAll[0] || {}).bytes || 0, cleans: (clAll[0] || {}).n || 0, computers: (clAll[0] || {}).computers || 0,
        inRange: (clRange[0] || {}).bytes || 0, cleansInRange: (clRange[0] || {}).n || 0, prevRange: (clPrev[0] || {}).bytes || 0,
        mac: (clPlatform.find((x) => x._id === 'macos') || {}).bytes || 0, windows: (clPlatform.find((x) => x._id === 'windows') || {}).bytes || 0,
        categories: clCats.map((c) => ({ id: c._id, name: c.name, bytes: c.bytes, mac: c.mac, windows: c.bytes - c.mac, cleans: c.n })),
        triggers: Object.fromEntries(clTriggers.map((t) => [t._id, { cleans: t.n, bytes: t.bytes }])),
      },
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
  cleanups = client.db(DB_NAME).collection('cleanups');
  await cleanups.createIndex({ at: -1 });
  downloads = client.db(DB_NAME).collection('download_clicks');
  await downloads.createIndex({ at: -1 });
  await waitlist.createIndex({ voterId: 1 }, { unique: true });
  app.listen(PORT, '127.0.0.1', () => console.log(`Mimo backend listening on ${PORT}`));
})().catch((e) => { console.error(e); process.exit(1); });
