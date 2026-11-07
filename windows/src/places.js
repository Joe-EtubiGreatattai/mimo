// Places Mimo recognises on Windows. Paths use environment folders so they work for any user.
// mode:
//   contents  – delete everything inside (rebuilds itself)
//   older     – move files older than N days to the Recycle Bin
//   installers– move old .exe/.msi/.zip/.iso in Downloads to the Recycle Bin
//   nodeModules – delete node_modules in projects untouched for N days
//   recycleBin – empty the Recycle Bin (permanent)
const path = require('path');
const os = require('os');

function folders() {
  const home = os.homedir();
  return {
    home,
    local: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
    roaming: process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
    temp: process.env.TEMP || process.env.TMP || os.tmpdir(),
  };
}

function knownPlaces() {
  const f = folders();
  const L = (...p) => path.join(f.local, ...p);
  const R = (...p) => path.join(f.roaming, ...p);
  const H = (...p) => path.join(f.home, ...p);
  return [
    { id: 'temp', name: 'Temporary files', icon: 'clock', paths: [f.temp], mode: 'older', days: 2, defaultOn: true, permanent: true },
    { id: 'chrome', name: 'Chrome cache', icon: 'globe', paths: [L('Google', 'Chrome', 'User Data', 'Default', 'Cache'), L('Google', 'Chrome', 'User Data', 'Default', 'Code Cache')], mode: 'contents', defaultOn: true },
    { id: 'edge', name: 'Edge cache', icon: 'globe', paths: [L('Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), L('Microsoft', 'Edge', 'User Data', 'Default', 'Code Cache')], mode: 'contents', defaultOn: true },
    { id: 'firefox', name: 'Firefox cache', icon: 'globe', glob: { root: L('Mozilla', 'Firefox', 'Profiles'), child: 'cache2' }, mode: 'contents', defaultOn: true },
    { id: 'whatsapp', name: 'Old WhatsApp media', icon: 'message', paths: [L('Packages', '5319275A.WhatsAppDesktop_cv1g1gvanyjgm', 'LocalState', 'shared', 'transfers'), R('WhatsApp', 'Cache')], mode: 'older', days: 30, defaultOn: true },
    { id: 'teams', name: 'Microsoft Teams cache', icon: 'message', paths: [R('Microsoft', 'Teams', 'Cache'), R('Microsoft', 'Teams', 'Service Worker', 'CacheStorage'), L('Packages', 'MSTeams_8wekyb3d8bbwe', 'LocalCache', 'Microsoft', 'MSTeams', 'EBWebView', 'Default', 'Cache')], mode: 'contents', defaultOn: true },
    { id: 'slack', name: 'Slack cache', icon: 'message', paths: [R('Slack', 'Cache'), R('Slack', 'Service Worker', 'CacheStorage'), R('Slack', 'Code Cache')], mode: 'contents', defaultOn: true },
    { id: 'discord', name: 'Discord cache', icon: 'message', paths: [R('discord', 'Cache'), R('discord', 'Code Cache')], mode: 'contents', defaultOn: true },
    { id: 'spotify', name: 'Spotify cache', icon: 'music', paths: [L('Spotify', 'Data')], mode: 'contents', defaultOn: true },
    { id: 'crashdumps', name: 'Crash dumps', icon: 'alert', paths: [L('CrashDumps')], mode: 'contents', defaultOn: true },
    { id: 'npm', name: 'npm cache', icon: 'box', paths: [L('npm-cache', '_cacache')], mode: 'contents', defaultOn: true },
    { id: 'yarn', name: 'Yarn cache', icon: 'box', paths: [L('Yarn', 'Cache')], mode: 'contents', defaultOn: true },
    { id: 'pip', name: 'pip cache', icon: 'box', paths: [L('pip', 'cache')], mode: 'contents', defaultOn: true },
    { id: 'gradle', name: 'Gradle caches', icon: 'box', paths: [H('.gradle', 'caches')], mode: 'contents', defaultOn: true },
    { id: 'nuget', name: 'NuGet packages', icon: 'box', paths: [H('.nuget', 'packages')], mode: 'contents', defaultOn: false },
    { id: 'installers', name: 'Old installers in Downloads', icon: 'download', paths: [H('Downloads')], mode: 'installers', days: 30, defaultOn: false },
    { id: 'bin', name: 'Empty the Recycle Bin', icon: 'trash', paths: [], mode: 'recycleBin', defaultOn: false, permanent: true },
  ].map((p) => ({ permanent: p.mode === 'contents' || p.mode === 'nodeModules' || p.mode === 'recycleBin', ...p }));
}

const nodeModulesPlace = { id: 'node_modules', name: 'node_modules in old projects', icon: 'code', paths: [], mode: 'nodeModules', days: 60, defaultOn: false, permanent: true };

function describe(p, days) {
  switch (p.mode) {
    case 'contents': return p.custom ? 'Everything inside is deleted permanently.' : 'Deleted. Rebuilds itself when needed.';
    case 'older': return p.permanent ? `Files older than ${days} days are deleted.` : `Files older than ${days} days move to the Recycle Bin.`;
    case 'installers': return `Installers older than ${days} days move to the Recycle Bin.`;
    case 'nodeModules': return `Deleted in projects untouched for ${days} days. Run npm install to restore.`;
    case 'recycleBin': return 'Permanently deletes what is already in your Recycle Bin.';
    default: return '';
  }
}

module.exports = { folders, knownPlaces, nodeModulesPlace, describe };
