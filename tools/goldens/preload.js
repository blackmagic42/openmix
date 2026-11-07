// Preload of the golden-render page (owner: host; tools/make-goldens.js):
// the only bridge from the page to the generator's main process — write a
// file under the output folder, record a case, log, finish.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('goldens', {
  write: (rel, data) => ipcRenderer.invoke('golden-write', rel, data),
  addCase: (entry) => ipcRenderer.invoke('golden-case', entry),
  log: (line) => ipcRenderer.invoke('golden-log', line),
  done: (r) => ipcRenderer.invoke('golden-done', r)
});
