const path = require('path'), os = require('os'), fs = require('fs'), assert = require('assert');
const { Engine } = require(path.resolve('src/engine.js'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-loop-'));
const e = new Engine({ settingsFile: path.join(dir, 's.json'), fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
e.notify = () => {}; e.s.askFirst = false; e.s.cleanBelowGB = 20;
e.readDisk = () => { e.free = 12; e.total = 256; return e.free; };
let scans = 0, cleans = 0;
e.scan = async () => { scans++; e.findings = [{ id: 'chrome', bytes: 5_000_000 }]; };
e.clean = () => { cleans++; };
(async () => {
  for (let i = 0; i < 5; i++) { e.check(); await new Promise((r) => setTimeout(r, 5)); }
  assert.strictEqual(scans, 1, 'only one try while still below the level');
  assert.strictEqual(cleans, 0, 'no clean for a few MB');
  e.readDisk = () => { e.free = 6; e.total = 256; return e.free; };  // dropped another 6 GB
  e.scan = async () => { scans++; e.findings = [{ id: 'chrome', bytes: 900_000_000 }]; };
  e.check(); await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(scans, 2, 'tries again when space drops 5 GB more');
  assert.strictEqual(cleans, 1, 'cleans when there is something worth clearing');
  console.log('LOOP TEST PASSED');
})().catch((err) => { console.error('LOOP TEST FAILED', err.message); process.exit(1); });
