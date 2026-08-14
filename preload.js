const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Utilisé côté renderer pour les ajustements spécifiques à une plateforme
  // (ex : laisser de la place aux boutons natifs macOS en haut à gauche)
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  pickSamples: () => ipcRenderer.invoke('pick-samples'),
  pickXml: () => ipcRenderer.invoke('pick-xml'),
  scanFolder: (dir) => ipcRenderer.invoke('scan-folder', dir),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  readCover: (src) => ipcRenderer.invoke('read-cover', src),
  cacheLoad: () => ipcRenderer.invoke('cache-load'),
  cacheSave: (o) => ipcRenderer.invoke('cache-save', o),
  cacheSaveSync: (o) => ipcRenderer.sendSync('cache-save-sync', o),
  rbGrids: () => ipcRenderer.invoke('rb-grids'),
  // acctIdx : index du compte SoundCloud à utiliser (b2b) — absent = compte 0
  scResolve: (url, acctIdx) => ipcRenderer.invoke('sc-resolve', url, acctIdx),
  scFetchTrack: (scId, acctIdx) => ipcRenderer.invoke('sc-fetch-track', scId, acctIdx),
  scDownloadTo: (scId, name, acctIdx) => ipcRenderer.invoke('sc-download-to', scId, name, acctIdx),
  stemsSeparate: (p) => ipcRenderer.invoke('stems-separate', p),
  remoteStart: () => ipcRenderer.invoke('remote-start'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  remoteState: (s) => ipcRenderer.send('remote-state', s),
  onRemoteCmd: (cb) => ipcRenderer.on('remote-cmd', (_e, d) => cb(d)),
  fsRoots: () => ipcRenderer.invoke('fs-roots'),
  fsList: (dir) => ipcRenderer.invoke('fs-list', dir),
  saveRecording: (data, name) => ipcRenderer.invoke('save-recording', data, name),
  exportPlaylist: (name, items) => ipcRenderer.invoke('export-playlist', name, items),
  scLogin: () => ipcRenderer.invoke('sc-login'),
  scRemoveAccount: (acctIdx) => ipcRenderer.invoke('sc-remove-account', acctIdx),
  scStatus: () => ipcRenderer.invoke('sc-status'),
  scMyPlaylists: (acctIdx) => ipcRenderer.invoke('sc-my-playlists', acctIdx),
  scMyLikes: (acctIdx) => ipcRenderer.invoke('sc-my-likes', acctIdx),
  scSearch: (q, acctIdx) => ipcRenderer.invoke('sc-search', q, acctIdx),
  remoteWave: (d, payload) => ipcRenderer.send('remote-wave', d, payload),
  remoteLib: (data) => ipcRenderer.send('remote-lib', data),
  guestGet: () => ipcRenderer.invoke('guest-get'),
  guestQr: (url) => ipcRenderer.invoke('guest-qr', url),
  guestClear: () => ipcRenderer.invoke('guest-clear'),
  onGuestReq: (cb) => ipcRenderer.on('guest-req', (_e, d) => cb(d))
});
