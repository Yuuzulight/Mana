const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  backendLog: (cb) => ipcRenderer.on('backend-log', (evt, data) => cb(data)),
  backendExit: (cb) => ipcRenderer.on('backend-exit', (evt, data) => cb(data)),
  showError: (msg) => ipcRenderer.invoke('show-error', msg),
  backendStatus: () => ipcRenderer.invoke('backend-status'),
});
