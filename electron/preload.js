const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("calendar", {
  // Pull the current cache on mount.
  get: () => ipcRenderer.invoke("events:get"),

  // Subscribe to pushes from the main process when the cache file changes.
  // Returns an unsubscribe function so React can clean up on unmount.
  subscribe: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("events:update", handler);
    return () => ipcRenderer.removeListener("events:update", handler);
  },

  refresh: () => ipcRenderer.send("events:refresh"),
  hide: () => ipcRenderer.send("window:hide")
});