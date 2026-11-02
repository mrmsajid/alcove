// Gives Alcove's own pages `window.__TAURI__`: `core.invoke` (run a command from main.js) and
// `event.listen` / `emit`. The name is left over from the first, Tauri-based version of Alcove, whose
// API the pages were written against. Tauri itself is no longer used.
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
