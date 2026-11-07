// Remote control relay: lets a Mimo user pair their phone with their own Mac.
// - The Mac proves who it is with a secret it generated (stored here only as a SHA-256 hash).
// - Pairing uses a 6-character code that the Mac shows for 10 minutes.
// - Each paired phone gets its own token (also stored only as a hash).
// - The Mac sends a status snapshot (storage totals, categories, activity — never file names)
//   and polls for commands the phone queued.
const crypto = require('crypto');
const express = require('express');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMANDS = new Set(['check', 'scan', 'clean', 'dismiss', 'setThreshold', 'setAskFirst', 'setPlace', 'notify', 'remap']);

function limiter(perMinute) {
  const hits = new Map();
  setInterval(() => hits.clear(), 60_000).unref();
  return (req, res, next) => {
    const k = (req.ip || 'x') + req.baseUrl + req.path;
    const n = (hits.get(k) || 0) + 1;
    hits.set(k, n);
    if (n > perMinute) return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
    next();
  };
}

module.exports = function remote(db) {
  const router = express.Router();
  const devices = db.collection('devices');
  const pairings = db.collection('pairings');
  const commands = db.collection('commands');
  devices.createIndex({ deviceId: 1 }, { unique: true });
  devices.createIndex({ 'phones.tokenHash': 1 });
  pairings.createIndex({ codeHash: 1 }, { unique: true });
  pairings.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  commands.createIndex({ deviceId: 1, status: 1, createdAt: 1 });
  commands.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 86400 });

  router.use(express.json({ limit: '64kb' }));

  // --- Mac side -------------------------------------------------------------
  async function deviceAuth(req, res, next) {
    const id = String(req.get('X-Mimo-Device') || '').toLowerCase();
    const secret = String(req.get('Authorization') || '').replace(/^Bearer /, '');
    if (!UUID.test(id) || secret.length < 32) return res.status(401).json({ error: 'Not signed in' });
    const d = await devices.findOne({ deviceId: id });
    if (!d || d.secretHash !== sha(secret)) return res.status(401).json({ error: 'Not signed in' });
    req.device = d;
    next();
  }

  // Start pairing. Registers the Mac on first use.
  router.post('/pair/start', limiter(10), async (req, res) => {
    const { deviceId, secret, name } = req.body || {};
    if (!UUID.test(deviceId || '') || typeof secret !== 'string' || secret.length < 32) return res.status(400).json({ error: 'Bad request' });
    const id = deviceId.toLowerCase();
    const existing = await devices.findOne({ deviceId: id });
    if (existing && existing.secretHash !== sha(secret)) return res.status(409).json({ error: 'This Mac is registered with a different key' });
    if (!existing) await devices.insertOne({ deviceId: id, secretHash: sha(secret), createdAt: new Date(), phones: [] });
    await devices.updateOne({ deviceId: id }, { $set: { name: String(name || 'Mac').slice(0, 60), lastSeen: new Date() } });
    await pairings.deleteMany({ deviceId: id });
    const code = newCode();
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await pairings.insertOne({ codeHash: sha(code), deviceId: id, expiresAt });
    res.json({ code, expiresAt });
  });

  router.post('/device/status', limiter(30), deviceAuth, async (req, res) => {
    const status = req.body && req.body.status;
    if (!status || typeof status !== 'object') return res.status(400).json({ error: 'Missing status' });
    await devices.updateOne({ _id: req.device._id }, { $set: { status, lastSeen: new Date(), name: String(status.name || req.device.name || 'Mac').slice(0, 60) } });
    res.json({ ok: true, phones: (req.device.phones || []).length });
  });

  router.get('/device/commands', limiter(30), deviceAuth, async (req, res) => {
    await devices.updateOne({ _id: req.device._id }, { $set: { lastSeen: new Date() } });
    const list = await commands.find({ deviceId: req.device.deviceId, status: 'pending' }).sort({ createdAt: 1 }).limit(10).toArray();
    if (list.length) await commands.updateMany({ _id: { $in: list.map((c) => c._id) } }, { $set: { status: 'delivered', deliveredAt: new Date() } });
    res.json({ commands: list.map((c) => ({ id: String(c._id), type: c.type, args: c.args || {} })), phones: (req.device.phones || []).length });
  });

  router.post('/device/commands/:id', limiter(60), deviceAuth, async (req, res) => {
    const { ObjectId } = require('mongodb');
    let _id; try { _id = new ObjectId(req.params.id); } catch { return res.status(400).json({ error: 'Bad id' }); }
    const { ok, message } = req.body || {};
    await commands.updateOne({ _id, deviceId: req.device.deviceId }, { $set: { status: ok ? 'done' : 'failed', message: String(message || '').slice(0, 200), finishedAt: new Date() } });
    res.json({ ok: true });
  });

  router.post('/device/unpair-all', limiter(10), deviceAuth, async (req, res) => {
    await devices.updateOne({ _id: req.device._id }, { $set: { phones: [] } });
    await pairings.deleteMany({ deviceId: req.device.deviceId });
    res.json({ ok: true, phones: 0 });
  });

  // --- Phone side -----------------------------------------------------------
  async function phoneAuth(req, res, next) {
    const t = String(req.get('Authorization') || '').replace(/^Bearer /, '');
    if (t.length < 32) return res.status(401).json({ error: 'Not paired' });
    const h = sha(t);
    const d = await devices.findOne({ 'phones.tokenHash': h });
    if (!d) return res.status(401).json({ error: 'Not paired' });
    req.device = d; req.tokenHash = h;
    next();
  }

  router.post('/pair/claim', limiter(10), async (req, res) => {
    const code = String((req.body || {}).code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 6) return res.status(400).json({ error: 'Enter the 6-character code shown in Mimo' });
    const p = await pairings.findOneAndDelete({ codeHash: sha(code), expiresAt: { $gt: new Date() } });
    const pairing = p && (p.value !== undefined ? p.value : p);
    if (!pairing) return res.status(404).json({ error: 'That code is wrong or has expired. Make a new one in Mimo › Settings › Phone.' });
    const t = token();
    const label = String((req.body || {}).label || 'Phone').slice(0, 40);
    await devices.updateOne({ deviceId: pairing.deviceId }, { $push: { phones: { tokenHash: sha(t), label, createdAt: new Date() } } });
    const d = await devices.findOne({ deviceId: pairing.deviceId });
    res.json({ token: t, name: d.name || 'Mac' });
  });

  router.get('/remote/status', limiter(40), phoneAuth, async (req, res) => {
    const d = req.device;
    const recent = await commands.find({ deviceId: d.deviceId }).sort({ createdAt: -1 }).limit(8).toArray();
    res.json({
      name: d.name || 'Mac',
      lastSeen: d.lastSeen || null,
      online: d.lastSeen ? Date.now() - new Date(d.lastSeen).getTime() < 90_000 : false,
      status: d.status || null,
      commands: recent.map((c) => ({ id: String(c._id), type: c.type, status: c.status, message: c.message || '', createdAt: c.createdAt })),
    });
  });

  router.post('/remote/commands', limiter(20), phoneAuth, async (req, res) => {
    const { type, args } = req.body || {};
    if (!COMMANDS.has(type)) return res.status(400).json({ error: 'Unknown command' });
    const a = {};
    if (type === 'clean') a.ids = Array.isArray(args && args.ids) ? args.ids.filter((x) => typeof x === 'string').slice(0, 50).map((x) => x.slice(0, 300)) : [];
    if (type === 'setThreshold') { const gb = Number(args && args.gb); if (!(gb >= 5 && gb <= 500)) return res.status(400).json({ error: 'Pick a value from 5 to 500 GB' }); a.gb = Math.round(gb / 5) * 5; }
    if (type === 'setAskFirst') a.on = Boolean(args && args.on);
    if (type === 'setPlace') { a.id = String((args && args.id) || '').slice(0, 300); a.on = Boolean(args && args.on); }
    const pendingCount = await commands.countDocuments({ deviceId: req.device.deviceId, status: 'pending' });
    if (pendingCount >= 20) return res.status(429).json({ error: 'Your Mac has too many commands waiting. Is it online?' });
    const r = await commands.insertOne({ deviceId: req.device.deviceId, type, args: a, status: 'pending', createdAt: new Date() });
    res.status(201).json({ id: String(r.insertedId) });
  });

  router.post('/remote/unpair', limiter(10), phoneAuth, async (req, res) => {
    await devices.updateOne({ _id: req.device._id }, { $pull: { phones: { tokenHash: req.tokenHash } } });
    res.json({ ok: true });
  });

  return router;
};
