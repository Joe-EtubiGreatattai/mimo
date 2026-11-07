// Runs Mimo's Windows engine against a fake user folder laid out like Windows.
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-test-'));
const home = path.join(root, 'Users', 'great');
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
process.env.TEMP = path.join(process.env.LOCALAPPDATA, 'Temp');
const old = (Date.now() - 90 * 86400000) / 1000;
function file(p, bytes, oldFile) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, Buffer.alloc(bytes, 1)); if (oldFile) fs.utimesSync(p, old, old); }
const L = process.env.LOCALAPPDATA, R = process.env.APPDATA;
file(path.join(L, 'Google/Chrome/User Data/Default/Cache/Cache_Data/f_000001'), 300000);
file(path.join(L, 'Google/Chrome/User Data/Default/Code Cache/js/abc'), 100000);
file(path.join(process.env.TEMP, 'old.tmp'), 50000, true);
file(path.join(process.env.TEMP, 'new.tmp'), 50000, false);
file(path.join(L, 'Packages/5319275A.WhatsAppDesktop_cv1g1gvanyjgm/LocalState/shared/transfers/IMG-1.jpg'), 400000, true);
file(path.join(L, 'Packages/5319275A.WhatsAppDesktop_cv1g1gvanyjgm/LocalState/shared/transfers/IMG-2.jpg'), 400000, false);
file(path.join(R, 'discord/Cache/Cache_Data/data_1'), 120000);
file(path.join(L, 'Mozilla/Firefox/Profiles/ab12.default/cache2/entries/X'), 80000);
file(path.join(home, 'Downloads/setup-old.exe'), 700000, true);
file(path.join(home, 'Documents/thesis.docx'), 90000, true);
file(path.join(home, 'code/app/node_modules/react/index.js'), 250000);
fs.utimesSync(path.join(home, 'code/app/node_modules'), old, old);
file(path.join(home, 'Videos/big.mp4'), 2000000);

const { Engine } = require('../src/engine');
const trashed = [];
const settingsFile = path.join(root, 'userData', 'settings.json');
const calls = [];
const fakeFetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
  const ok = (data) => ({ ok: true, status: 200, json: async () => data });
  if (url.endsWith('/installs') || url.endsWith('/cleanups')) return ok({ ok: true });
  if (url.endsWith('/pair/start')) return ok({ code: 'ABC234' });
  if (url.endsWith('/device/status')) return ok({ ok: true, phones: 1 });
  if (url.endsWith('/device/commands')) return ok({ commands: calls.filter((c) => c.url.endsWith('/device/commands')).length === 1 ? [{ id: 'c1', type: 'setThreshold', args: { gb: 25 } }] : [], phones: 1 });
  return ok({ ok: true });
};
const e = new Engine({ settingsFile, trash: async (p) => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); }, appVersion: '1.3.0', fetchImpl: fakeFetch });
const notes = []; e.on('notify', (n) => notes.push(n.body));

(async () => {
  // disk
  assert(e.readDisk() > 0, 'reads free space'); assert(e.total > 0);
  // places that exist on this "PC"
  const ids = e.placesAll().map((p) => p.id);
  for (const id of ['temp', 'chrome', 'whatsapp', 'discord', 'firefox', 'installers', 'bin']) assert(ids.includes(id), 'finds place ' + id);
  assert(!ids.includes('edge'), 'skips places that are not installed');
  // map
  await e.runMap(true);
  assert(e.map.folders > 10, 'mapped folders');
  assert.strictEqual(e.map.nodeModules.length, 1, 'found node_modules');
  assert(e.map.tree.length >= 0);
  assert(e.placesAll().some((p) => p.id === 'node_modules'), 'offers node_modules place');
  assert(e.map.known.chrome >= 400000, 'sized chrome cache');
  // review flow (ask first)
  e.setPlace('installers', true); e.setPlace('node_modules', true);
  await e.prepareReview('manual');
  const f = Object.fromEntries(e.findings.map((x) => [x.id, x]));
  assert(e.pendingReview, 'waiting for OK');
  assert.strictEqual(f.temp.items.length, 1, 'only old temp file');
  assert.strictEqual(f.whatsapp.items.length, 1, 'only old WhatsApp media');
  assert.strictEqual(f.installers.items.length, 1, 'old installer');
  assert(f.chrome.bytes >= 400000, 'chrome cache size');
  assert(!e.findings.some((x) => x.items.some((i) => i.path.includes('thesis'))), 'never touches documents');
  // approve only WhatsApp + chrome + temp
  e.approve(['whatsapp', 'chrome', 'temp']);
  await new Promise((r) => setTimeout(r, 300));
  while (e.isCleaning || e.isScanning) await new Promise((r) => setTimeout(r, 50));
  assert(trashed.some((p) => p.endsWith('IMG-1.jpg')), 'WhatsApp media went to the Recycle Bin');
  assert(!trashed.some((p) => p.includes('Chrome')), 'caches deleted, not trashed');
  assert(!fs.existsSync(path.join(L, 'Google/Chrome/User Data/Default/Cache/Cache_Data')), 'chrome cache cleared');
  assert(fs.existsSync(path.join(process.env.TEMP, 'new.tmp')), 'recent temp file kept');
  assert(!fs.existsSync(path.join(process.env.TEMP, 'old.tmp')), 'old temp file removed');
  assert(fs.existsSync(path.join(home, 'Downloads/setup-old.exe')), 'unselected installer kept');
  assert(fs.existsSync(path.join(home, 'Documents/thesis.docx')), 'documents untouched');
  const report = calls.find((c) => c.url.endsWith('/cleanups'));
  assert(report && report.body.bytes >= 5_000_00 && report.body.trigger === 'review', 'cleanup reported');
  assert(report.body.categories.every((c) => !/thesis|IMG-/.test(JSON.stringify(c))), 'cleanup report has no file names');
  assert(report.body.categories.some((c) => c.id === 'whatsapp'), 'cleanup report has categories');
  // custom place
  e.addCustomPlace(path.join(home, 'Videos'), false);
  assert(e.placesAll().some((p) => p.custom), 'custom place added');
  e.removeCustomPlace('custom:' + path.join(home, 'Videos'));
  // install ping + remote
  await e.reportInstall();
  const ping = calls.find((c) => c.url.endsWith('/installs'));
  assert(ping && ping.body.platform === 'windows' && /^[0-9a-f-]{36}$/.test(ping.body.installId), 'install ping');
  await e.startPairing();
  assert.strictEqual(e.pairCode, 'ABC234');
  await e.remoteTick();
  assert.strictEqual(e.s.cleanBelowGB, 25, 'phone command applied');
  assert.strictEqual(e.s.pairedPhones, 1);
  const status = calls.find((c) => c.url.endsWith('/device/status')).body.status;
  assert(status.places.length && !JSON.stringify(status).includes('thesis') && !JSON.stringify(status).includes('IMG-'), 'phone status has no file names');
  const done = calls.find((c) => c.url.endsWith('/device/commands/c1'));
  assert(done && done.body.ok, 'command result reported');
  // settings persisted
  const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.strictEqual(saved.cleanBelowGB, 25);
  console.log('ALL ENGINE TESTS PASSED', { findings: Object.keys(f), freed: e.lastFreed, notes: notes.length, activity: e.activity.length });
  fs.rmSync(root, { recursive: true, force: true });
})().catch((err) => { console.error('TEST FAILED:', err.message); process.exit(1); });
