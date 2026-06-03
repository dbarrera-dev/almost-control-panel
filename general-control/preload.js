const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getConfig: () => ipcRenderer.invoke('gc-get-config'),
  saveConfig: (config) => ipcRenderer.invoke('gc-save-config', config),
  getState: () => ipcRenderer.invoke('gc-get-state'),
  refresh: () => ipcRenderer.invoke('gc-refresh'),
  sendCommand: (payload) => ipcRenderer.invoke('gc-send-command', payload),
  pruneOldCommands: (sourceId) => ipcRenderer.invoke('gc-prune-old-commands', sourceId),
  onStateUpdated: (cb) => ipcRenderer.on('gc-state-updated', (_, data) => cb(data)),
};

contextBridge.exposeInMainWorld('gcApi', api);
