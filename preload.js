const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window
  minimize: () => ipcRenderer.invoke('window-minimize'),
  maximize: () => ipcRenderer.invoke('window-maximize'),
  close:    () => ipcRenderer.invoke('window-close'),

  // Config
  getConfig:  ()    => ipcRenderer.invoke('get-config'),
  saveConfig: (cfg) => ipcRenderer.invoke('save-config', cfg),

  // Bot
  connectBot:    (cfg) => ipcRenderer.invoke('connect-bot', cfg),
  disconnectBot: ()    => ipcRenderer.invoke('disconnect-bot'),

  // Torneo
  crearTorneo:          (nombre)  => ipcRenderer.invoke('crear-torneo', nombre),
  getTorneoActivo:      ()        => ipcRenderer.invoke('get-torneo-activo'),
  cerrarTorneoDb:       (id)      => ipcRenderer.invoke('cerrar-torneo-db', id),
  getParticipantes:     (id)      => ipcRenderer.invoke('get-participantes', id),
  getTorneos:           ()        => ipcRenderer.invoke('get-torneos'),
  generarEquipos:       (data)    => ipcRenderer.invoke('generar-equipos', data),
  eliminarParticipante: (data)    => ipcRenderer.invoke('eliminar-participante', data),
  eliminarTorneo:       (id)      => ipcRenderer.invoke('eliminar-torneo', id),

  // Spotify
  getSpotifyStatus:  () => ipcRenderer.invoke('get-spotify-status'),
  spotifyNowPlaying: () => ipcRenderer.invoke('spotify-now-playing'),
  openSpotifyConnect: () => ipcRenderer.invoke('open-spotify-connect'),

  // Utils
  openUrl: (url) => ipcRenderer.invoke('open-url', url),

  // Overlay
  overlayLoadAll:  ()           => ipcRenderer.invoke('overlay-load-all'),
  overlayUpdate:   (key, value) => ipcRenderer.invoke('overlay-update', { key, value }),
  bracketUpdate:   (id, data)   => ipcRenderer.invoke('bracket-update', { id, data }),
  bracketReset:    ()           => ipcRenderer.invoke('bracket-reset'),

  // Events
  onBotStatus:          (cb) => ipcRenderer.on('bot-status',          (_, d) => cb(d)),
  onBotLog:             (cb) => ipcRenderer.on('bot-log',             (_, d) => cb(d)),
  onNewParticipante:    (cb) => ipcRenderer.on('new-participante',    (_, d) => cb(d)),
  onRemoveParticipante: (cb) => ipcRenderer.on('remove-participante', (_, d) => cb(d)),
});
