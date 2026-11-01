// Exposes the same `window.__TAURI__` surface the sidebar and palette already use,
// so ../ui works unchanged on both the Tauri and Electron builds.
const { contextBridge, ipcRenderer } = require("electron");

const listeners = new Map();
ipcRenderer.on("event", (_e, name, payload) => {
  for (const cb of listeners.get(name) || []) cb({ payload });
});

contextBridge.exposeInMainWorld("__TAURI__", {
  core: {
    invoke: (cmd, args) => ipcRenderer.invoke("invoke", cmd, args),
  },
  event: {
    listen: async (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(cb);
      return () => listeners.get(name).delete(cb);
    },
    emit: async (name, payload) => ipcRenderer.send("emit", name, payload),
  },
});
