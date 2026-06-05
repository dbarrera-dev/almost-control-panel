const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const allowed = new Set(['splash-status', 'splash-progress', 'splash-version']);
  if (!allowed.has(channel)) return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('splashApi', { on });
