const { ipcRenderer } = require('electron');

// contextIsolation is off (see main.js), so the renderer already has full
// require() access and this is just a plain global assignment rather than a
// contextBridge call (contextBridge requires contextIsolation to be on).
window.electronAPI = {
  backendLog: (cb) => ipcRenderer.on('backend-log', (evt, data) => cb(data)),
  backendExit: (cb) => ipcRenderer.on('backend-exit', (evt, data) => cb(data)),
  showError: (msg) => ipcRenderer.invoke('show-error', msg),
  backendStatus: () => ipcRenderer.invoke('backend-status'),
  // allow renderer to react to an 'excite' event sent from main
  onExcite: (cb) => ipcRenderer.on('excite', () => cb()),
  // open logs via main
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openDocs: () => ipcRenderer.invoke('open-docs'),
  openAvatarNotice: () => ipcRenderer.invoke('open-avatar-notice')
};
