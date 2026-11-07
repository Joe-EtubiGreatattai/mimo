const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mimo', {
  state: () => ipcRenderer.invoke('state'),
  action: (name, args) => ipcRenderer.invoke('action', name, args),
  qr: (text) => ipcRenderer.invoke('qr', text),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onTab: (cb) => ipcRenderer.on('tab', (_e, t) => cb(t)),
});
