const { contextBridge, ipcRenderer } = require('electron');

// contextIsolation is on (see main.js) -- the renderer has no Node access
// of its own, so this is the only bridge between it and the main process.
// Preload scripts always keep full Node/require access regardless of the
// renderer's own contextIsolation setting; that's what makes contextBridge
// possible here.
contextBridge.exposeInMainWorld('electronAPI', {
  backendLog: (cb) => ipcRenderer.on('backend-log', (evt, data) => cb(data)),
  backendExit: (cb) => ipcRenderer.on('backend-exit', (evt, data) => cb(data)),
  showError: (msg) => ipcRenderer.invoke('show-error', msg),
  backendStatus: () => ipcRenderer.invoke('backend-status'),
  // allow renderer to react to an 'excite' event sent from main
  onExcite: (cb) => ipcRenderer.on('excite', () => cb()),
  // open logs via main
  openLogs: () => ipcRenderer.invoke('open-logs'),
  openDocs: () => ipcRenderer.invoke('open-docs'),
  openAvatarNotice: () => ipcRenderer.invoke('open-avatar-notice'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (evt, status) => cb(status)),
  // Live2D model/config resolution (see avatar/resolve-model.js) -- the
  // renderer has no fs/path access of its own, so this is how it finds out
  // whether a model is configured and what's in it.
  resolveAvatarModel: () => ipcRenderer.invoke('avatar:resolve-model'),
  fetchSampleAvatar: () => ipcRenderer.invoke('avatar:fetch-sample'),
  // Native file picker for manually linking a local GGUF model (Settings >
  // Model and the first-run wizard) -- see model-management.js's
  // /models/scan + /models/path on the backend for the other half.
  browseModelFile: () => ipcRenderer.invoke('browse-model-file'),
  // Startup loading screen: getStartupStatus() catches up on whatever
  // already happened before this listener was attached (see
  // main.js's startupState), onStartupProgress() streams what happens
  // after that.
  getStartupStatus: () => ipcRenderer.invoke('get-startup-status'),
  onStartupProgress: (cb) => ipcRenderer.on('startup-progress', (evt, update) => cb(update)),
  // Closing screen: no snapshot getter like startup has -- shutdown always
  // begins while this renderer is already up and listening (see main.js's
  // before-quit handler), so there's nothing that could have been missed.
  onShutdownProgress: (cb) => ipcRenderer.on('shutdown-progress', (evt, update) => cb(update)),
});
