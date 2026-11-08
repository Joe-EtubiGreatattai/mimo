// Mimo for Windows — Electron shell: tray icon, window, notifications, start at login.
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const QRCode = require('qrcode');
const { Engine } = require('./engine');

const SMOKE = process.argv.includes('--smoke-test');
const ICONS = path.join(__dirname, 'icons');

if (!SMOKE && !app.requestSingleInstanceLock()) { app.quit(); }
app.setAppUserModelId('com.great.mimo');

let win = null, tray = null, engine = null, quitting = false;

function emptyRecycleBin() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve();
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Clear-RecycleBin -Force -ErrorAction SilentlyContinue'], { windowsHide: true }, () => resolve());
  });
}

function createWindow(tab) {
  if (win) { if (tab) win.webContents.send('tab', tab); win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 440, height: 760, minWidth: 380, minHeight: 560,
    title: 'Mimo', icon: path.join(ICONS, 'icon.png'), show: false, backgroundColor: '#EEF4FB',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { win.show(); if (tab) win.webContents.send('tab', tab); });
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function trayIcon() {
  const tone = engine ? engine.mood.tone : 'green';
  const file = ['red', 'orange', 'purple'].includes(tone) ? 'tray-alert.png' : 'tray.png';
  return nativeImage.createFromPath(path.join(ICONS, file));
}

function updateTray() {
  if (!tray || !engine) return;
  const m = engine.mood;
  tray.setImage(trayIcon());
  tray.setToolTip(`Mimo · ${engine.free} GB free · ${m.text}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${engine.free} GB free — ${m.text}`, enabled: false },
    { type: 'separator' },
    { label: 'Open Mimo', click: () => createWindow() },
    { label: engine.s.askFirst ? 'Find things to clean' : 'Clean now', click: () => engine.cleanNow() },
    { label: 'Check now', click: () => engine.check(true) },
    { type: 'separator' },
    { label: 'Quit Mimo', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ---------- over-the-air updates ----------
// Checks GitHub Releases every 6 hours, downloads new versions in the background
// and installs them silently when Mimo isn't busy, then starts him again.
let autoUpdater = null;
function setStatus(t) { if (engine) { engine.updateStatus = t; engine.changed(); } }
function setupUpdates() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => setStatus('Checking for updates…'));
  autoUpdater.on('update-available', (i) => setStatus(`Downloading Mimo ${i.version}…`));
  autoUpdater.on('update-not-available', () => setStatus(`You're on the latest version (${app.getVersion()}).`));
  autoUpdater.on('error', () => setStatus("Couldn't check for updates. I'll try again later."));
  autoUpdater.on('update-downloaded', (i) => {
    setStatus(`Mimo ${i.version} is ready. Installing…`);
    engine.s.justUpdatedTo = i.version; engine.save();
    const install = () => {
      if (engine.isCleaning || engine.isScanning || engine.isMapping) return setTimeout(install, 60_000);
      quitting = true;
      autoUpdater.quitAndInstall(true, true); // silent install, then start Mimo again
    };
    setTimeout(install, 5000);
  });
  const check = () => { if (engine.s.autoUpdate !== false) autoUpdater.checkForUpdates().catch(() => {}); };
  setTimeout(check, 60_000);
  setInterval(check, 6 * 3600_000);
}

function notify({ title, body, category }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(ICONS, 'icon.png'), silent: false });
  n.on('click', () => createWindow(category === 'review' ? 'review' : category === 'places' ? 'places' : undefined));
  n.show();
}

async function smokeTest() {
  // Used by the Windows build to prove the app starts, reads the disk, sizes folders and renders its window.
  const os = require('os');
  const e = new Engine({ settingsFile: path.join(os.tmpdir(), 'mimo-smoke', 'settings.json'), appVersion: app.getVersion(), fetchImpl: null });
  const free = e.readDisk();
  const places = e.placesAll();
  const size = await e.sizeOf(path.join(__dirname));
  const w = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true } });
  engine = e;
  registerIpc();
  await w.loadFile(path.join(__dirname, 'ui', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));
  const rendered = await w.webContents.executeJavaScript('document.querySelector("#free") && document.querySelector("#free").textContent');
  console.log(JSON.stringify({ ok: true, free, total: e.total, places: places.map((p) => p.id), appSize: size, rendered }));
  app.exit(free > 0 && size > 0 && rendered !== null ? 0 : 1);
}

function registerIpc() {
  ipcMain.handle('state', () => engine.snapshot());
  ipcMain.handle('qr', (_e, text) => QRCode.toDataURL(text, { margin: 1, width: 360, color: { dark: '#13202F', light: '#FFFFFF' } }));
  ipcMain.handle('action', async (_e, name, args = {}) => {
    switch (name) {
      case 'check': engine.check(true); engine.report(); return true;
      case 'cleanNow': await engine.cleanNow(); return true;
      case 'scanReview': await engine.prepareReview('manual'); return true;
      case 'approve': return engine.approve(args.ids);
      case 'dismiss': engine.dismiss(); return true;
      case 'setPlace': engine.setPlace(args.id, args.on); engine.scan(); return true;
      case 'setDays': engine.setDays(args.id, args.days); return true;
      case 'addPlace': engine.addCustomPlace(args.path, args.clearEverything); engine.scan(); return true;
      case 'removePlace': engine.removeCustomPlace(args.id); return true;
      case 'remap': engine.runMap(false); return true;
      case 'setting': {
        const allowed = ['cleanBelowGB', 'askFirst', 'reportMinutes', 'countInstall', 'startAtLogin', 'autoUpdate'];
        if (!allowed.includes(args.key)) return false;
        engine.set(args.key, args.value);
        if (args.key === 'startAtLogin') app.setLoginItemSettings({ openAtLogin: !!args.value, args: ['--hidden'] });
        return true;
      }
      case 'checkUpdate':
        if (!autoUpdater) { setStatus('Updates work in the installed app.'); return true; }
        autoUpdater.checkForUpdates().catch(() => setStatus("Couldn't check for updates. I'll try again later."));
        return true;
      case 'testNotification': engine.report(); return true;
      case 'pair': await engine.startPairing(); return true;
      case 'cancelPair': engine.cancelPairing(); return true;
      case 'unpairAll': await engine.unpairAll(); return true;
      case 'reveal': if (args.path) shell.showItemInFolder(args.path); return true;
      case 'openLog': shell.openPath(path.join(app.getPath('userData'), 'mimo.log')); return true;
      case 'openUrl': if (/^https:\/\//.test(args.url)) shell.openExternal(args.url); return true;
      case 'quit': quitting = true; app.quit(); return true;
      default: return false;
    }
  });
}

app.whenReady().then(async () => {
  if (SMOKE) return smokeTest();

  engine = new Engine({
    settingsFile: path.join(app.getPath('userData'), 'settings.json'),
    trash: (p) => shell.trashItem(p),
    emptyRecycleBin,
    appVersion: app.getVersion(),
  });
  registerIpc();

  let pending = null;
  engine.on('change', () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; updateTray(); if (win) win.webContents.send('state', engine.snapshot()); }, 120);
  });
  engine.on('notify', notify);
  engine.on('openReview', () => createWindow('review'));

  if (engine.s.startAtLogin && app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });

  tray = new Tray(trayIcon());
  tray.on('click', () => (win && win.isVisible() ? win.hide() : createWindow()));
  updateTray();

  const startedHidden = process.argv.includes('--hidden');
  if (!startedHidden || !engine.map) createWindow(engine.map ? undefined : 'places');
  engine.start();
  if (engine.s.justUpdatedTo === app.getVersion()) {
    delete engine.s.justUpdatedTo; engine.save();
    engine.add('download', `Updated myself to Mimo ${app.getVersion()}`);
    notify({ title: 'Mimo 🐶', body: `Woof! I just updated myself to Mimo ${app.getVersion()}.` });
  }
  setupUpdates();
});

app.on('second-instance', () => createWindow());
app.on('before-quit', () => { quitting = true; if (engine) engine.stop(); });
app.on('window-all-closed', (e) => { /* keep running in the tray */ });
