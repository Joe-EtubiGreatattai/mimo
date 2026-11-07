// Mimo's brain for Windows. Plain Node (no Electron imports) so it can be tested anywhere.
// main.js gives it: a settings file path, a trash() function, an emptyRecycleBin() function and a notify() callback.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { folders, knownPlaces, nodeModulesPlace, describe } = require('./places');

const API = 'https://mimo.techtree.lifestyle/v1';
const GB = 1e9;
const fmt = (b) => {
  if (!b) return 'Zero KB';
  const u = ['bytes', 'KB', 'MB', 'GB', 'TB']; let i = 0, n = b;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const yieldNow = () => new Promise((r) => setImmediate(r));

const DEFAULTS = {
  cleanBelowGB: 15, askFirst: true, reportMinutes: 30, countInstall: true, startAtLogin: true,
  enabled: {}, days: {}, customPlaces: [], installId: null, deviceSecret: null,
  installReported: false, remoteOn: false, pairedPhones: 0,
};

class Engine extends EventEmitter {
  constructor({ settingsFile, trash, emptyRecycleBin, appVersion = '0.0.0', platform = 'windows', fetchImpl } = {}) {
    super();
    this.settingsFile = settingsFile;
    this.trash = trash || ((p) => fsp.rm(p, { recursive: true, force: true }));
    this.emptyRecycleBin = emptyRecycleBin || (async () => {});
    this.appVersion = appVersion;
    this.platform = platform;
    this.fetch = fetchImpl || globalThis.fetch;
    this.home = os.homedir();
    this.mapFile = settingsFile ? path.join(path.dirname(settingsFile), 'map.json') : null;
    this.s = { ...DEFAULTS, ...this.readJSON(settingsFile) };
    if (!this.s.installId) this.s.installId = crypto.randomUUID();
    if (!this.s.deviceSecret) this.s.deviceSecret = crypto.randomBytes(32).toString('hex');
    this.save();
    this.map = this.readJSON(this.mapFile) || null;

    this.free = 0; this.total = 0;
    this.isCleaning = false; this.isScanning = false; this.isMapping = false;
    this.cleaningStep = ''; this.mapProgress = { folders: 0, bytes: 0, current: '' };
    this.findings = []; this.selected = new Set(); this.pendingReview = false;
    this.activity = []; this.lastFreed = null; this.totalFreed = 0;
    this.lastCheck = Date.now(); this.lastReport = Date.now(); this.lastNudge = 0; this.warned = false;
    this.pairCode = null; this.pairExpires = 0; this.remoteError = null;
    this.remoteBusy = false; this.lastPoll = 0; this.lastPush = 0; this.statusDirty = true;
    this.timers = [];
  }

  // ---------- persistence ----------
  readJSON(file) { try { return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch { return null; } }
  save() {
    if (!this.settingsFile) return;
    try { fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true }); fs.writeFileSync(this.settingsFile, JSON.stringify(this.s, null, 2)); } catch {}
  }
  set(key, value) { this.s[key] = value; this.save(); this.changed(); }

  changed() { this.statusDirty = true; this.emit('change'); }
  add(icon, text) {
    this.activity.unshift({ time: Date.now(), icon, text });
    this.activity = this.activity.slice(0, 40);
    this.log(text);
    this.changed();
  }
  log(line) {
    if (!this.settingsFile) return;
    try { fs.appendFileSync(path.join(path.dirname(this.settingsFile), 'mimo.log'), `${new Date().toISOString()}: ${line}\n`); } catch {}
  }
  notify(text, category) { this.emit('notify', { title: 'Mimo 🐶', body: text, category }); }

  // ---------- lifecycle ----------
  start() {
    this.readDisk();
    this.add('paw', 'Mimo started — watching every minute');
    this.notify(`Woof! Mimo is on duty 🐶 You have ${this.free} GB free. I'll check every minute.`);
    this.timers.push(setInterval(() => this.check(), 60_000));
    this.timers.push(setInterval(() => this.remoteTick(), 5_000));
    setTimeout(() => this.check(), 2000);
    setTimeout(() => this.reportInstall(), 5000);
    if (!this.map) setTimeout(() => this.runMap(true), 1500);
    else this.scan();
  }
  stop() { this.timers.forEach(clearInterval); this.timers = []; }

  // ---------- disk ----------
  readDisk() {
    try {
      const root = path.parse(this.home).root || '/';
      const st = fs.statfsSync(root);
      this.free = Math.floor((st.bavail * st.bsize) / GB);
      this.total = Math.floor((st.blocks * st.bsize) / GB);
    } catch {}
    return this.free;
  }
  get warnGB() { return this.s.cleanBelowGB + 10; }
  get mood() {
    if (this.isMapping) return { text: 'Mapping your PC', emoji: '🗺️', tone: 'teal' };
    if (this.isCleaning) return { text: 'Cleaning up for you', emoji: '🧹', tone: 'blue' };
    if (this.pendingReview) return { text: 'Waiting for your OK', emoji: '🐾', tone: 'purple' };
    if (this.free < this.s.cleanBelowGB) return { text: 'Running low', emoji: '😟', tone: 'red' };
    if (this.free < this.warnGB) return { text: 'Getting tight', emoji: '👀', tone: 'orange' };
    return { text: 'All good', emoji: '😊', tone: 'green' };
  }

  // ---------- places ----------
  placesAll() {
    const list = knownPlaces().filter((p) => p.mode === 'recycleBin' || this.resolvePaths(p).some((x) => fs.existsSync(x)));
    if (this.map && this.map.nodeModules && this.map.nodeModules.length) list.push({ ...nodeModulesPlace });
    for (const c of this.s.customPlaces) list.push({ ...c });
    return list.map((p) => ({ ...p, days: this.s.days[p.id] ?? p.days ?? 30 }));
  }
  resolvePaths(p) {
    if (p.glob) {
      try { return fs.readdirSync(p.glob.root).map((d) => path.join(p.glob.root, d, p.glob.child)).filter((x) => fs.existsSync(x)); } catch { return []; }
    }
    return p.paths || [];
  }
  isOn(p) { return this.s.enabled[p.id] ?? (p.custom ? true : p.defaultOn); }
  enabledPlaces() { return this.placesAll().filter((p) => this.isOn(p)); }
  setPlace(id, on) { this.s.enabled[id] = on; this.save(); this.findings = this.findings.filter((f) => f.id !== id); this.selected.delete(id); this.changed(); }
  setDays(id, d) { this.s.days[id] = Math.max(1, Math.min(730, Math.round(d))); this.save(); this.findings = this.findings.filter((f) => f.id !== id); this.changed(); }
  addCustomPlace(dir, clearEverything) {
    const id = 'custom:' + dir;
    if (this.s.customPlaces.some((c) => c.id === id)) return;
    const name = path.basename(dir) || dir;
    this.s.customPlaces.push({ id, name, icon: 'folder', paths: [dir], mode: clearEverything ? 'contents' : 'older', days: 30, defaultOn: true, custom: true, permanent: !!clearEverything });
    this.s.enabled[id] = true; this.save();
    this.add('plus', `Added ${name} to my cleaning places`);
  }
  removeCustomPlace(id) {
    const c = this.s.customPlaces.find((x) => x.id === id);
    this.s.customPlaces = this.s.customPlaces.filter((x) => x.id !== id);
    delete this.s.enabled[id]; this.save();
    this.findings = this.findings.filter((f) => f.id !== id); this.selected.delete(id);
    if (c) this.add('minus', `Removed ${c.name} from my cleaning places`);
  }
  knownSize(p) {
    if (!this.map) return null;
    if (p.mode === 'nodeModules') return (this.map.nodeModules || []).reduce((t, x) => t + x.bytes, 0);
    return this.map.known ? this.map.known[p.id] ?? null : null;
  }

  // ---------- sizes ----------
  async sizeOf(target, budget = { n: 0 }) {
    let st;
    try { st = await fsp.lstat(target); } catch { return 0; }
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    let total = 0, dir;
    try { dir = await fsp.opendir(target); } catch { return 0; }
    try {
      for await (const e of dir) {
        if (++budget.n % 2000 === 0) await yieldNow();
        const p = path.join(target, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) total += await this.sizeOf(p, budget);
        else if (e.isFile()) { try { total += (await fsp.stat(p)).size; } catch {} }
      }
    } catch {}
    return total;
  }

  async olderFiles(root, cutoff, out, budget = { n: 0 }) {
    let dir;
    try { dir = await fsp.opendir(root); } catch { return out; }
    try {
      for await (const e of dir) {
        if (++budget.n % 2000 === 0) await yieldNow();
        const p = path.join(root, e.name);
        if (e.isSymbolicLink() || /mimo/i.test(e.name)) continue;
        if (e.isDirectory()) await this.olderFiles(p, cutoff, out, budget);
        else if (e.isFile()) {
          try { const st = await fsp.stat(p); if (st.mtimeMs < cutoff) out.push({ path: p, bytes: st.size }); } catch {}
        }
      }
    } catch {}
    return out;
  }

  async itemsFor(p) {
    const cutoff = Date.now() - (p.days || 30) * 86_400_000;
    const out = [];
    if (p.mode === 'recycleBin') {
      const bytes = await this.recycleBinSize();
      return bytes > 0 ? [{ path: '$Recycle.Bin', bytes, label: 'Recycle Bin' }] : [];
    }
    if (p.mode === 'nodeModules') {
      for (const n of (this.map && this.map.nodeModules) || []) {
        try { const st = await fsp.stat(n.path); if (st.mtimeMs < cutoff) out.push({ path: n.path, bytes: n.bytes, label: path.basename(path.dirname(n.path)) + '/node_modules' }); } catch {}
      }
      return out;
    }
    for (const root of this.resolvePaths(p)) {
      if (p.mode === 'contents') {
        let kids = [];
        try { kids = await fsp.readdir(root); } catch {}
        for (const k of kids) {
          if (/mimo/i.test(k)) continue;
          const full = path.join(root, k);
          const bytes = await this.sizeOf(full);
          if (bytes > 0) out.push({ path: full, bytes });
        }
      } else if (p.mode === 'older') {
        await this.olderFiles(root, cutoff, out);
      } else if (p.mode === 'installers') {
        let kids = [];
        try { kids = await fsp.readdir(root, { withFileTypes: true }); } catch {}
        for (const k of kids) {
          if (!k.isFile() || !/\.(exe|msi|zip|iso|7z|rar)$/i.test(k.name)) continue;
          const full = path.join(root, k.name);
          try { const st = await fsp.stat(full); if (st.mtimeMs < cutoff) out.push({ path: full, bytes: st.size }); } catch {}
        }
      }
    }
    return out;
  }

  async recycleBinSize() {
    if (process.platform !== 'win32') return 0;
    const root = path.parse(this.home).root;
    const bin = path.join(root, '$Recycle.Bin');
    let total = 0;
    try { for (const sid of await fsp.readdir(bin)) total += await this.sizeOf(path.join(bin, sid)); } catch {}
    return total;
  }

  // ---------- watching ----------
  check(manual = false) {
    this.readDisk(); this.lastCheck = Date.now();
    if (manual) this.add('search', `Checked: ${this.free} GB free`);
    if (this.map && Date.now() - this.map.date > 7 * 86_400_000 && !this.isMapping && !this.isCleaning) this.runMap(false);
    if (this.free < this.s.cleanBelowGB && !this.isCleaning && !this.isScanning) {
      if (this.s.askFirst) {
        if (!this.pendingReview) this.prepareReview('low');
        else if (Date.now() - this.lastNudge >= this.s.reportMinutes * 60_000) this.nudge();
      } else {
        this.add('alert', `Low on space (${this.free} GB) — started cleaning`);
        this.notify(`Only ${this.free} GB left — fetching the broom 🧹`);
        this.scan().then(() => this.clean(this.findings.map((f) => f.id), 'auto'));
      }
      this.changed();
      return;
    }
    if (this.free < this.warnGB && !this.warned) {
      this.warned = true;
      this.add('alert', `Space getting tight: ${this.free} GB`);
      this.notify(`Heads up: only ${this.free} GB left. I'll ${this.s.askFirst ? 'ask you about cleaning' : 'start cleaning'} at ${this.s.cleanBelowGB} GB.`);
    } else if (this.free >= this.warnGB) this.warned = false;
    if (Date.now() - this.lastReport >= this.s.reportMinutes * 60_000) this.report();
    this.changed();
  }

  friendlyLine() {
    const f = this.free;
    if (this.pendingReview) return `Psst 🐾 I've got ${fmt(this.foundBytes())} ready to clean. Click to review.`;
    if (f < this.s.cleanBelowGB) return `Ruff… only ${f} GB left 😟`;
    if (f < this.warnGB) return pick([`Sniff sniff 👀 ${f} GB free — getting a bit tight, I'm watching closely.`, `Heads up, friend: ${f} GB left. I'll step in at ${this.s.cleanBelowGB} GB 🧹`, `Ears up 🐕 ${f} GB free. Not panicking yet, but I'm close by.`]);
    return pick([`Woof! 🐶 Still on patrol — ${f} GB free. All good!`, `Tail wagging 🐕 You've got ${f} GB free. Nothing to clean.`, `Mimo checking in 🐾 ${f} GB free and looking healthy.`, `Good news from your storage dog: ${f} GB free ✅`, `Just did my rounds 🦴 ${f} GB free. Carry on!`, `Sniffed every corner 👃 ${f} GB free — all clear.`]);
  }
  report() { this.readDisk(); this.lastReport = Date.now(); this.add('bell', 'Sent you a storage update'); this.notify(this.friendlyLine()); }
  foundBytes() { return this.findings.reduce((t, f) => t + f.bytes, 0); }

  // ---------- review ----------
  async prepareReview(reason) {
    await this.scan();
    if (!this.findings.length) {
      this.add('check', 'Looked for things to clean — found nothing');
      if (reason === 'manual') this.notify('I sniffed around and found nothing to clean 🐶');
      return;
    }
    this.selected = new Set(this.findings.map((f) => f.id));
    this.pendingReview = true;
    this.add('tray', `Found ${fmt(this.foundBytes())} to clean — waiting for your OK`);
    if (reason === 'low') { this.lastNudge = Date.now(); this.notify(`Only ${this.free} GB left. I found ${fmt(this.foundBytes())} I can clean — click to review 🐾`, 'review'); }
    else this.emit('openReview');
    this.changed();
  }
  nudge() { this.lastNudge = Date.now(); this.lastReport = Date.now(); this.notify(`Still waiting on you 🐾 ${fmt(this.foundBytes())} is ready to clean and you have ${this.free} GB free.`, 'review'); }
  cleanNow() {
    if (this.s.askFirst) return this.prepareReview('manual');
    this.add('sparkles', 'You asked me to clean up');
    this.notify('On it! Cleaning up now… 🧹');
    return this.scan().then(() => this.clean(this.findings.map((f) => f.id), 'manual'));
  }
  approve(ids, trigger = 'review') {
    const valid = new Set((ids || [...this.selected]).filter((id) => this.findings.some((f) => f.id === id)));
    if (!valid.size) return false;
    const bytes = this.findings.filter((f) => valid.has(f.id)).reduce((t, f) => t + f.bytes, 0);
    this.pendingReview = false;
    this.add('thumb', `You approved ${fmt(bytes)} for cleaning`);
    this.clean([...valid], trigger);
    return true;
  }
  dismiss() { this.pendingReview = false; this.lastNudge = Date.now(); this.add('hand', 'You said not now — I\'ll ask again if space stays low'); }

  // ---------- scanning & cleaning ----------
  async scan() {
    if (this.isScanning) return;
    this.isScanning = true; this.changed();
    const out = [];
    for (const p of this.enabledPlaces()) {
      const items = (await this.itemsFor(p)).sort((a, b) => b.bytes - a.bytes);
      if (items.length) out.push({ id: p.id, place: p, items, bytes: items.reduce((t, i) => t + i.bytes, 0) });
    }
    this.findings = out;
    this.selected = new Set([...this.selected].filter((id) => out.some((f) => f.id === id)));
    this.isScanning = false; this.changed();
  }

  async clean(ids, trigger = 'review') {
    if (this.isCleaning) return;
    const work = this.findings.filter((f) => ids.includes(f.id));
    if (!work.length) { this.add('check', 'Nothing to clean'); return; }
    this.isCleaning = true; this.changed();
    const before = this.readDisk();
    let removed = 0, n = 0;
    const cleared = [];
    for (const f of work) {
      this.cleaningStep = `Clearing ${f.place.name.toLowerCase()}…`; this.changed();
      let bytes = 0;
      if (f.place.mode === 'recycleBin') { try { await this.emptyRecycleBin(); bytes = f.bytes; } catch {} }
      else for (const item of f.items) {
        try {
          if (f.place.permanent) {
            await fsp.rm(item.path, { recursive: true, force: true, maxRetries: 1 });
            if (fs.existsSync(item.path)) continue; // locked files stay behind
          } else await this.trash(item.path);
          bytes += item.bytes;
        } catch { /* in use or protected: skip */ }
        if (++n % 50 === 0) await yieldNow();
      }
      removed += bytes;
      // Built-in places by id; your own folders only as "Your folders" (never their names).
      if (bytes > 0) cleared.push({ id: f.place.custom ? 'custom' : f.place.id, name: f.place.custom ? 'Your folders' : f.place.name, bytes });
    }
    this.reportCleanup(removed, cleared, trigger);
    const after = this.readDisk();
    const freed = Math.max(after - before, Math.round(removed / GB));
    this.lastFreed = freed; this.totalFreed += freed;
    this.isCleaning = false; this.cleaningStep = '';
    this.lastReport = Date.now();
    this.findings = this.findings.filter((f) => !ids.includes(f.id)); this.selected.clear();
    this.add('sparkles', `Cleaned ${work.map((f) => f.place.name.toLowerCase()).join(', ')} — cleared ${fmt(removed)}`);
    this.notify(`Good boy report 🐾 Cleared ${fmt(removed)} — you now have ${this.free} GB free.`);
    this.scan();
  }

  // ---------- mapping ----------
  async runMap(firstTime) {
    if (this.isMapping) return;
    this.isMapping = true; this.mapProgress = { folders: 0, bytes: 0, current: '' };
    this.add('map', firstTime ? 'Mapping your PC for the first time' : 'Refreshing my map of your PC');
    if (firstTime) this.notify('Hi, I\'m Mimo 🐶 I\'m sniffing through your folders to learn where space goes. This takes a few minutes.');
    const home = this.home;
    const depth1 = new Map(), depth2 = new Map();
    const nodeModules = [];
    let folderCount = 0, fileCount = 0, total = 0, lastEmit = 0;
    const budget = { n: 0 };
    const addUp = (rel, bytes) => {
      const parts = rel.split(path.sep).filter(Boolean);
      if (parts.length >= 1) { const k = path.join(home, parts[0]); depth1.set(k, (depth1.get(k) || 0) + bytes); }
      if (parts.length >= 2) { const k = path.join(home, parts[0], parts[1]); depth2.set(k, (depth2.get(k) || 0) + bytes); }
    };
    const walk = async (dirPath) => {
      let dir;
      try { dir = await fsp.opendir(dirPath); } catch { return; }
      try {
        for await (const e of dir) {
          if (++budget.n % 1500 === 0) await yieldNow();
          if (e.isSymbolicLink()) continue;
          const p = path.join(dirPath, e.name);
          if (e.isDirectory()) {
            folderCount++;
            if (e.name === 'node_modules') {
              const bytes = await this.sizeOf(p);
              let mtime = Date.now(); try { mtime = (await fsp.stat(p)).mtimeMs; } catch {}
              nodeModules.push({ path: p, bytes, modified: mtime });
              total += bytes; addUp(path.relative(home, dirPath) + path.sep + e.name, bytes);
              continue;
            }
            if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); this.mapProgress = { folders: folderCount, bytes: total, current: p.replace(home, '~') }; this.emit('change'); }
            await walk(p);
          } else if (e.isFile()) {
            fileCount++;
            try { const st = await fsp.stat(p); total += st.size; addUp(path.relative(home, dirPath), st.size); } catch {}
          }
        }
      } catch {}
    };
    await walk(home);

    const tree = [...depth1.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
      .filter(([, b]) => b > 50e6)
      .map(([p, b]) => ({
        folder: { path: p, bytes: b },
        children: [...depth2.entries()].filter(([k]) => path.dirname(k) === p).sort((a, c) => c[1] - a[1]).slice(0, 10).map(([k, v]) => ({ path: k, bytes: v })),
      }));
    const known = {};
    for (const p of knownPlaces()) {
      if (p.mode === 'recycleBin') { known[p.id] = await this.recycleBinSize(); continue; }
      let b = 0; for (const r of this.resolvePaths(p)) if (fs.existsSync(r)) b += await this.sizeOf(r);
      known[p.id] = b;
    }
    this.map = { date: Date.now(), folders: folderCount, files: fileCount, totalBytes: total, tree, known, nodeModules: nodeModules.sort((a, b) => b.bytes - a.bytes) };
    try { if (this.mapFile) fs.writeFileSync(this.mapFile, JSON.stringify(this.map)); } catch {}
    this.isMapping = false;
    const cleanable = Object.values(known).reduce((t, x) => t + x, 0) + nodeModules.reduce((t, x) => t + x.bytes, 0);
    this.add('check', `Mapped ${folderCount.toLocaleString()} folders, ${fmt(total)} in total`);
    if (firstTime) this.notify(`Done mapping 🗺️ I found up to ${fmt(cleanable)} I could look after. Pick the places you want me to clean.`, 'places');
    await this.scan();
  }

  // ---------- anonymous counts ----------
  async reportCleanup(bytes, categories, trigger) {
    if (!this.s.countInstall || !bytes || !this.fetch) return;
    try {
      await this.fetch(API + '/cleanups', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId: this.s.installId, platform: this.platform, appVersion: this.appVersion, arch: process.arch, trigger, bytes, categories }) });
    } catch {}
  }

  async reportInstall() {
    if (!this.s.countInstall || this.s.installReported || !this.fetch) return;
    try {
      const r = await this.fetch(API + '/installs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ installId: this.s.installId, appVersion: this.appVersion, osVersion: `Windows ${os.release()}`, arch: process.arch, platform: this.platform }) });
      if (r.ok) { this.s.installReported = true; this.save(); this.log('Install counted anonymously'); }
    } catch {}
  }

  // ---------- phone remote ----------
  async remote(pathname, method = 'GET', body) {
    const r = await this.fetch(API + pathname, { method, headers: { 'Content-Type': 'application/json', 'X-Mimo-Device': this.s.installId, Authorization: 'Bearer ' + this.s.deviceSecret }, body: body ? JSON.stringify(body) : undefined });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Mimo's server answered ${r.status}`);
    return data;
  }
  async startPairing() {
    this.remoteError = null; this.changed();
    try {
      const r = await this.remote('/pair/start', 'POST', { deviceId: this.s.installId, secret: this.s.deviceSecret, name: os.hostname() });
      this.pairCode = r.code; this.pairExpires = Date.now() + 10 * 60_000;
      this.set('remoteOn', true);
      this.add('phone', 'Showing a code to pair your phone');
    } catch { this.remoteError = 'Couldn\'t reach Mimo\'s server. Check your internet and try again.'; this.changed(); }
  }
  cancelPairing() { this.pairCode = null; this.pairExpires = 0; this.changed(); }
  async unpairAll() {
    try { await this.remote('/device/unpair-all', 'POST', {}); this.set('pairedPhones', 0); this.pairCode = null; this.add('phone', 'Unpaired all phones'); }
    catch { this.remoteError = 'Couldn\'t reach Mimo\'s server to unpair. Try again.'; this.changed(); }
  }
  updatePhones(n) {
    if (typeof n !== 'number') return;
    if (n > this.s.pairedPhones && this.pairCode) {
      this.pairCode = null;
      this.add('phone', 'Paired with your phone');
      this.notify('Your phone is paired 📱 You can now check on me and tell me what to clean from anywhere.');
    }
    if (n !== this.s.pairedPhones) this.set('pairedPhones', n);
  }
  async remoteTick() {
    if (!this.s.remoteOn || this.remoteBusy) return;
    if (this.pairCode && Date.now() > this.pairExpires) this.cancelPairing();
    const active = this.s.pairedPhones > 0 || this.pairCode;
    if (Date.now() - this.lastPoll < (active ? 5000 : 60000)) return;
    this.remoteBusy = true; this.lastPoll = Date.now();
    try {
      if (active && (this.statusDirty || Date.now() - this.lastPush > 20000)) {
        this.statusDirty = false; this.lastPush = Date.now();
        const r = await this.remote('/device/status', 'POST', { status: this.statusForPhone() });
        this.updatePhones(r.phones);
      }
      const r = await this.remote('/device/commands');
      this.updatePhones(r.phones);
      for (const c of r.commands || []) {
        const [ok, message] = await this.runRemote(c.type, c.args || {});
        try { await this.remote('/device/commands/' + c.id, 'POST', { ok, message }); } catch {}
        this.statusDirty = true; this.lastPoll = 0;
      }
    } catch { /* offline: try next tick */ }
    this.remoteBusy = false;
  }
  async runRemote(type, args) {
    switch (type) {
      case 'check': this.check(true); return [true, `Checked: ${this.free} GB free`];
      case 'notify': this.notify('Hello from your phone 📱 ' + this.friendlyLine()); return [true, 'Notification sent to your PC'];
      case 'scan': this.add('phone', 'Your phone asked me to look for things to clean'); this.prepareReview('manual'); return [true, 'Looking for things to clean'];
      case 'clean': {
        const ok = this.approve(args.ids || [], 'phone');
        return ok ? [true, 'Cleaning started'] : [false, 'Nothing to clean right now. Tap Scan first.'];
      }
      case 'dismiss': this.dismiss(); return [true, 'OK, not now'];
      case 'setThreshold': { const gb = Math.max(5, Math.min(500, Number(args.gb) || this.s.cleanBelowGB)); this.set('cleanBelowGB', gb); this.add('phone', `Your phone set cleaning to start below ${gb} GB`); return [true, `Mimo now steps in below ${gb} GB`]; }
      case 'setAskFirst': this.set('askFirst', !!args.on); this.add('phone', args.on ? 'Your phone turned on Ask me first' : 'Your phone turned on Clean automatically'); return [true, args.on ? 'Mimo will ask before deleting' : 'Mimo will clean on his own'];
      case 'setPlace': {
        const p = this.placesAll().find((x) => x.id === args.id);
        if (!p) return [false, 'That place isn\'t on this PC anymore'];
        this.setPlace(p.id, !!args.on); this.add('phone', `Your phone turned ${args.on ? 'on' : 'off'} ${p.name}`); this.scan();
        return [true, `${p.name} turned ${args.on ? 'on' : 'off'}`];
      }
      case 'remap': this.runMap(false); return [true, 'Mapping your PC'];
      default: return [false, 'This version of Mimo doesn\'t know that command. Update Mimo on your PC.'];
    }
  }

  // ---------- snapshots ----------
  statusForPhone() {
    const m = this.mood;
    return {
      name: os.hostname(), appVersion: this.appVersion, platform: this.platform,
      freeGB: this.free, totalGB: this.total, mood: `${m.text} ${m.emoji}`,
      isCleaning: this.isCleaning, isScanning: this.isScanning, isMapping: this.isMapping, cleaningStep: this.cleaningStep,
      pendingReview: this.pendingReview, cleanBelowGB: this.s.cleanBelowGB, askFirst: this.s.askFirst,
      lastFreed: this.lastFreed || 0, totalFreed: this.totalFreed,
      findings: this.findings.map((f) => ({ id: f.id, name: f.place.name, bytes: f.bytes, count: f.items.length, permanent: !!f.place.permanent })),
      places: this.placesAll().map((p) => ({ id: p.id, name: p.name, on: this.isOn(p), bytes: this.knownSize(p) })),
      activity: this.activity.slice(0, 15).map((a) => ({ time: new Date(a.time).toISOString(), text: a.text })),
      updatedAt: new Date().toISOString(),
    };
  }

  // Everything the desktop window needs.
  snapshot() {
    return {
      free: this.free, total: this.total, mood: this.mood, lastCheck: this.lastCheck,
      isCleaning: this.isCleaning, isScanning: this.isScanning, isMapping: this.isMapping,
      cleaningStep: this.cleaningStep, mapProgress: this.mapProgress,
      pendingReview: this.pendingReview, selected: [...this.selected],
      lastFreed: this.lastFreed, totalFreed: this.totalFreed,
      findings: this.findings.map((f) => ({ id: f.id, name: f.place.name, icon: f.place.icon, bytes: f.bytes, count: f.items.length, permanent: !!f.place.permanent,
        top: f.items.slice(0, 8).map((i) => ({ label: i.label || path.basename(i.path), bytes: i.bytes, path: i.path })) })),
      places: this.placesAll().map((p) => ({ id: p.id, name: p.name, icon: p.icon, on: this.isOn(p), bytes: this.knownSize(p), detail: describe(p, p.days), days: p.days,
        usesDays: ['older', 'installers', 'nodeModules'].includes(p.mode), custom: !!p.custom, permanent: !!p.permanent,
        path: p.custom ? p.paths[0] : null, count: p.mode === 'nodeModules' && this.map ? this.map.nodeModules.length : null })),
      map: this.map ? { date: this.map.date, folders: this.map.folders, totalBytes: this.map.totalBytes, tree: this.map.tree } : null,
      activity: this.activity.slice(0, 40),
      settings: { cleanBelowGB: this.s.cleanBelowGB, askFirst: this.s.askFirst, reportMinutes: this.s.reportMinutes, countInstall: this.s.countInstall, startAtLogin: this.s.startAtLogin },
      nextReport: this.lastReport + this.s.reportMinutes * 60_000,
      phone: { code: this.pairCode, expires: this.pairExpires, paired: this.s.pairedPhones, error: this.remoteError, url: 'https://mimo.techtree.lifestyle/app/' + (this.pairCode ? '#pair=' + this.pairCode : '') },
      home: this.home, version: this.appVersion,
    };
  }
}

module.exports = { Engine, fmt };
