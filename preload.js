const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

// Expose IPC renderer to window context for GUI communication
contextBridge.exposeInMainWorld('electronAPI', {
  send: (channel, data) => {
    ipcRenderer.send(channel, data);
  },
  on: (channel, func) => {
    ipcRenderer.on(channel, (event, ...args) => func(...args));
  },
  off: (channel, func) => {
    ipcRenderer.off(channel, func);
  }
});

// Expose path.resolve for GUI
contextBridge.exposeInMainWorld('pathResolve', (dir, ...paths) => {
  return path.resolve(dir, ...paths);
});
