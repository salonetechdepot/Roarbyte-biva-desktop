// Runs before the BIVA web page with no Node access exposed to it.
// The page can detect the desktop app with `window.bivaDesktop?.isDesktop`.
const { contextBridge, ipcRenderer } = require("electron");
const { version } = require("../package.json");

contextBridge.exposeInMainWorld("bivaDesktop", {
  isDesktop: true,
  platform: process.platform,
  version,
  update: () => ipcRenderer.invoke("biva-update:install"),
  install: () => ipcRenderer.invoke("biva-update:install"),
  offline: {
    status: () => ipcRenderer.invoke("biva-offline:status"),
    read: (key) => ipcRenderer.invoke("biva-offline:read", key),
    writeCache: (key, statusCode, body) => ipcRenderer.invoke("biva-offline:write-cache", key, statusCode, body),
    enqueue: (entry) => ipcRenderer.invoke("biva-offline:enqueue", entry),
    drop: (id) => ipcRenderer.invoke("biva-offline:drop", id),
    setMeta: (key, value) => ipcRenderer.invoke("biva-offline:set-meta", key, value),
    markSynced: () => ipcRenderer.invoke("biva-offline:mark-synced"),
  },
});
