const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const COLORS = ["#7c8cff", "#ff7c9c", "#5fd6a0", "#ffb86b", "#c27cff"];
const HOME = "https://duckduckgo.com";
const KEY = "alcove-state-v1";

let state = load() || {
  spaces: [{ id: uid(), name: "Space 1", color: COLORS[0], tabs: [], active: null }],
  space: 0,
};
const opened = new Set(); // tab ids with a live webview this session

function uid() { return Math.random().toString(36).slice(2, 10); }
function load() { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }

const space = () => state.spaces[state.space];
const activeTab = () => space().tabs.find(t => t.id === space().active);
const findTab = id => state.spaces.flatMap(s => s.tabs).find(t => t.id === id);

function normalize(input) {
  const v = input.trim();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (!/\s/.test(v) && /^[^\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(v)) return "https://" + v;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(v)) return "http://" + v;
  return "https://duckduckgo.com/?q=" + encodeURIComponent(v);
}

async function newTab(url = HOME) {
  const tab = { id: uid(), url, title: "New Tab" };
  space().tabs.push(tab);
  await activate(tab.id);
}

async function activate(id) {
  const s = space();
  s.active = id;
  const tab = activeTab();
  if (tab && !opened.has(tab.id)) {
    await invoke("open_tab", { id: tab.id, url: tab.url });
    opened.add(tab.id);
  } else {
    await invoke("switch_tab", { id: tab ? tab.id : null });
  }
  render();
}

async function closeTab(id) {
  const s = space();
  const i = s.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  s.tabs.splice(i, 1);
  if (opened.delete(id)) await invoke("close_tab", { id });
  if (s.active === id) {
    const next = s.tabs[Math.min(i, s.tabs.length - 1)];
    await activate(next ? next.id : null);
  } else {
    render();
  }
}

function render() {
  save();
  const s = space();
  const tabs = document.getElementById("tabs");
  tabs.replaceChildren(...s.tabs.map(t => {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === s.active ? " active" : "");
    el.innerHTML = '<span class="fav"></span><span class="title"></span><button class="close">×</button>';
    el.querySelector(".fav").textContent = (t.title || "?")[0].toUpperCase();
    el.querySelector(".title").textContent = t.title || t.url;
    el.addEventListener("click", () => activate(t.id));
    el.querySelector(".close").addEventListener("click", e => { e.stopPropagation(); closeTab(t.id); });
    return el;
  }));

  document.getElementById("spaces").replaceChildren(...state.spaces.map((sp, i) => {
    const d = document.createElement("div");
    d.className = "space-dot" + (i === state.space ? " active" : "");
    d.style.background = sp.color;
    d.title = sp.name;
    d.addEventListener("click", () => switchSpace(i));
    return d;
  }));

  const addr = document.getElementById("addr");
  if (document.activeElement !== addr) addr.value = activeTab() ? activeTab().url : "";
}

async function switchSpace(i) {
  state.space = i;
  await activate(space().active);
}

document.getElementById("addr-form").addEventListener("submit", async e => {
  e.preventDefault();
  const url = normalize(document.getElementById("addr").value);
  if (!url) return;
  document.getElementById("addr").blur();
  const tab = activeTab();
  if (!tab) return newTab(url);
  tab.url = url;
  if (opened.has(tab.id)) await invoke("navigate", { id: tab.id, url });
  else await activate(tab.id);
});

document.getElementById("new-tab").addEventListener("click", () => newTab());
document.getElementById("new-space").addEventListener("click", async () => {
  const n = state.spaces.length;
  state.spaces.push({ id: uid(), name: "Space " + (n + 1), color: COLORS[n % COLORS.length], tabs: [], active: null });
  await switchSpace(n);
});
for (const action of ["back", "forward", "reload"]) {
  document.getElementById(action).addEventListener("click", () => {
    const tab = activeTab();
    if (tab && opened.has(tab.id)) invoke("nav_action", { id: tab.id, action });
  });
}

document.addEventListener("keydown", e => {
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.key === "l") { e.preventDefault(); const a = document.getElementById("addr"); a.focus(); a.select(); }
  else if (e.key === "t") { e.preventDefault(); newTab(); }
  else if (e.key === "w") { e.preventDefault(); const t = activeTab(); if (t) closeTab(t.id); }
});

listen("tab-url", ({ payload }) => {
  const t = findTab(payload.id);
  if (t) { t.url = payload.url; render(); }
});
listen("tab-title", ({ payload }) => {
  const t = findTab(payload.id);
  if (t) { t.title = payload.title; render(); }
});

// Restore: reopen the active tab of the current space; other tabs open lazily.
activate(space().active && activeTab() ? space().active : null).then(() => {
  if (!space().tabs.length) newTab();
});
