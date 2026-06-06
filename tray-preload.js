const { contextBridge, ipcRenderer } = require('electron');

// API mínima para el menú custom del tray.
contextBridge.exposeInMainWorld('trayApi', {
  action: (name) => ipcRenderer.send('tray-menu-action', name),
  setSize: (height) => ipcRenderer.send('tray-menu-size', height),
});
