const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = id => document.getElementById(id);
const COLORS = ["#7c8cff", "#ff7c9c", "#5fd6a0", "#ffb86b", "#c27cff"];
const HOME = "https://duckduckgo.com";
const STATE_KEY = "alcove-state-v1";
const BM_KEY = "alcove-bookmarks";
const HIST_KEY = "alcove-history";
const DL_KEY = "alcove-downloads";

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

let state = read(STATE_KEY, null) || {
  spaces: [{ id: uid(), name: "Space 1", color: COLORS[0], tabs: [], active: null }],
  space: 0,
};
const opened = new Set(); // tab ids with a live webview this session
const closed = [];        // recently closed tabs, for Reopen Closed Tab
let panel = null;
let dragId = null;
const seen = new Map(); // tab id -> first render time, so only new tabs animate in
document.body.classList.add(/Mac/.test(navigator.userAgent) ? "mac" : "win");
// Newer commands may be missing on other shells (e.g. the Tauri build), so failures are swallowed.
const call = (cmd, args) => invoke(cmd, args).catch(() => null);
let adblock = true;
let adblockAllow = []; // hostnames where the blocker is off
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
const siteOff = host => adblockAllow.some(d => host === d || host.endsWith("." + d));
let profiles = { profiles: [], active: "default" };
const blocked = new Map(); // tab id -> requests blocked on the current page

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

let toastTimer;
function toast(msg, ms = 1600, actions = []) {
  const el = $("toast");
  const text = document.createElement("span");
  text.textContent = msg;
  el.replaceChildren(text, ...actions.map(a => {
    const b = document.createElement("button");
    b.textContent = a.label;
    b.addEventListener("click", () => { el.hidden = true; a.fn(); });
    return b;
  }));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---- tabs ----

async function newTab(url = HOME) {
  const tab = { id: uid(), url, title: "New Tab", pinned: false };
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
    if (tab.zoom && tab.zoom !== 1) invoke("zoom", { id: tab.id, factor: tab.zoom });
  } else {
    await invoke("switch_tab", { id: tab ? tab.id : null });
  }
  closeFind();
  render();
}

async function goToTab(id) {
  const i = state.spaces.findIndex(s => s.tabs.some(t => t.id === id));
  if (i < 0) return;
  state.space = i;
  panel = null;
  await activate(id);
}

async function closeTab(id) {
  const s = space();
  const i = s.tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const t = s.tabs[i];
  const el = document.querySelector(`.tab[data-id="${id}"]`);
  if (el && !t.pinned) { el.classList.add("leaving"); await sleep(150); }
  if (opened.delete(id)) await invoke("close_tab", { id });
  if (t.pinned) {
    t.url = t.pinUrl || t.url; // pinned tabs unload instead of disappearing
  } else {
    s.tabs.splice(i, 1);
    closed.push({ url: t.url, title: t.title });
  }
  if (s.active === id) {
    const rest = s.tabs.filter(x => x.id !== id);
    const next = rest[Math.min(i, rest.length - 1)];
    await activate(next ? next.id : null);
  } else {
    render();
  }
}

async function reopenClosed() {
  const t = closed.pop();
  if (t) await newTab(t.url);
}

function togglePin(id) {
  const t = findTab(id);
  if (!t) return;
  t.pinned = !t.pinned;
  t.pinUrl = t.pinned ? t.url : undefined;
  render();
}

function moveTab(id, beforeId, pinned) {
  if (id === beforeId) return;
  const tabs = space().tabs;
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  const j = beforeId ? tabs.findIndex(x => x.id === beforeId) : -1;
  if (j >= 0) {
    t.pinned = tabs[j].pinned;
    tabs.splice(j, 0, t);
  } else {
    t.pinned = !!pinned;
    tabs.push(t);
  }
  if (t.pinned && !t.pinUrl) t.pinUrl = t.url;
  render();
}

async function openUrl(url, inNewTab = false) {
  panel = null;
  renderPanel();
  const t = activeTab();
  if (!t || inNewTab) return newTab(url);
  t.url = url;
  if (opened.has(t.id)) await invoke("navigate", { id: t.id, url });
  else await activate(t.id);
  render();
}

function navAction(action) {
  const t = activeTab();
  if (t && opened.has(t.id)) invoke("nav_action", { id: t.id, action });
}

// ---- history / bookmarks ----

function recordHistory(tab) {
  if (!/^https?:/.test(tab.url)) return;
  const h = read(HIST_KEY, []);
  if (h[0] && h[0].url === tab.url) h[0].ts = Date.now();
  else h.unshift({ url: tab.url, title: tab.title || tab.url, ts: Date.now() });
  write(HIST_KEY, h.slice(0, 3000));
}

const isBookmarked = url => read(BM_KEY, []).some(b => b.url === url);

function toggleBookmark() {
  const t = activeTab();
  if (!t) return;
  let b = read(BM_KEY, []);
  if (b.some(x => x.url === t.url)) {
    b = b.filter(x => x.url !== t.url);
    toast("Bookmark removed");
  } else {
    b.unshift({ url: t.url, title: t.title || t.url });
    toast("Bookmarked");
  }
  write(BM_KEY, b);
  render();
  if (panel === "bookmarks") renderPanel();
}

// ---- screenshots ----

async function shoot(mode) {
  const t = activeTab();
  if (!t || !opened.has(t.id)) return toast("Nothing to capture");
  try {
    // The capture opens its own preview popup (save as / copy / discard).
    await invoke(mode === "region" ? "screenshot_region" : "screenshot", { id: t.id, mode });
  } catch {
    toast("Screenshot failed");
  }
}

listen("screenshot-saved", ({ payload }) =>
  toast("Screenshot saved", 6000, [{ label: "Show", fn: () => call("reveal", { path: payload.path }) }]));

function screenshotMenu() {
  const rect = $("screenshot").getBoundingClientRect();
  showMenu(rect.left - 90, rect.top - 3 * 32 - 14, [
    { label: "Selected area", fn: () => shoot("region") },
    { label: "Visible area", fn: () => shoot("visible") },
    { label: "Full page", fn: () => shoot("full") },
  ]);
}

// ---- YouTube downloads (powered by yt-dlp) ----

const errText = e => String(e.message || e).replace(/^Error invoking remote method 'invoke': Error: /, "");

async function setUpDownloader() {
  toast("Setting up the downloader (yt-dlp and ffmpeg, about 55 MB)…", 120000);
  try {
    await invoke("install_downloader");
    toast("Downloader ready. Click Video or Audio.", 4000);
  } catch (e) {
    toast(`Setup failed: ${errText(e)}`, 6000);
  }
  refreshVideoTools();
}

async function downloadVideo(kind) {
  const t = activeTab();
  if (!t || !YT_RE.test(t.url)) return toast("Open a YouTube video first");
  if (kind === "video" ? !(videoTools.ready && videoTools.ffmpeg) : !videoTools.ready) return setUpDownloader();
  if (!read("alcove-yt-consent", false)) {
    const ok = confirm("Only download videos you own or have permission to save.\n\n"
      + "Downloading may go against YouTube's Terms of Service and copyright law, and you are responsible for what you save.\n\nContinue?");
    if (!ok) return;
    write("alcove-yt-consent", true);
  }
  try {
    const r = await invoke("download_video", { url: t.url, kind });
    videoJob = { id: r.job, title: t.title || "video", kind, percent: 0, url: t.url };
    showVideoProgress();
    renderChrome();
  } catch (e) {
    toast(`Could not start: ${errText(e)}`, 6000);
  }
}

function showVideoProgress() {
  if (!videoJob) return;
  toast(`Downloading ${videoJob.kind}… ${Math.round(videoJob.percent)}%`, 60000, [
    { label: "Cancel", fn: () => call("cancel_video", { job: videoJob.id }) },
  ]);
}

listen("video-download", ({ payload: p }) => {
  if (!videoJob || p.job !== videoJob.id) return;
  if (p.state === "progress") {
    videoJob.percent = p.percent;
    showVideoProgress();
    return;
  }
  const job = videoJob;
  videoJob = null;
  if (p.state === "done") {
    const d = read(DL_KEY, []);
    d.unshift({ url: job.url, path: p.path, state: "done", ts: Date.now() });
    write(DL_KEY, d.slice(0, 200));
    if (panel === "downloads") renderPanel();
    toast("Saved to Downloads", 8000, [{ label: "Show", fn: () => call("reveal", { path: p.path }) }]);
  } else if (p.state === "cancelled") toast("Download cancelled", 2500);
  else toast(`Download failed: ${p.message}`, 7000);
  renderChrome();
});

// ---- find / zoom ----

function openFind() {
  if (!activeTab()) return;
  $("findbar").hidden = false;
  invoke("focus_ui").then(() => { $("find-input").focus(); $("find-input").select(); });
}

function closeFind() {
  if ($("findbar").hidden) return;
  $("findbar").hidden = true;
  const t = activeTab();
  if (t && opened.has(t.id)) invoke("clear_find", { id: t.id });
}

function doFind(backwards) {
  const t = activeTab();
  const text = $("find-input").value;
  if (t && opened.has(t.id) && text) invoke("find", { id: t.id, text, backwards });
}

async function setZoom(delta) {
  const t = activeTab();
  if (!t || !opened.has(t.id)) return;
  t.zoom = delta === 0 ? 1 : Math.min(3, Math.max(0.5, Math.round(((t.zoom || 1) + delta) * 10) / 10));
  await invoke("zoom", { id: t.id, factor: t.zoom });
  write(STATE_KEY, state);
  toast(`Zoom ${Math.round(t.zoom * 100)}%`);
}

// ---- rendering ----

function favNode(t) {
  const span = document.createElement("span");
  span.className = "fav";
  span.textContent = (t.title || t.url || "?")[0].toUpperCase();
  try {
    const u = new URL(t.url);
    if (/^https?:$/.test(u.protocol)) {
      const img = new Image();
      img.onload = () => span.replaceChildren(img);
      img.src = u.origin + "/favicon.ico";
    }
  } catch {}
  return span;
}

function tabEl(t) {
  const el = document.createElement("div");
  el.className = "tab" + (t.pinned ? " pin" : "") + (t.id === space().active ? " active" : "")
    + (opened.has(t.id) ? "" : " unloaded");
  el.draggable = true;
  el.dataset.id = t.id;
  if (!seen.has(t.id)) seen.set(t.id, Date.now());
  const age = Date.now() - seen.get(t.id);
  if (age < 220) { // re-renders mid-animation resume it instead of restarting or cutting it off
    el.classList.add("enter");
    el.style.animationDelay = `-${age}ms`;
  }
  el.title = t.title || t.url;
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = t.title || t.url;
  const close = document.createElement("button");
  close.className = "close";
  close.innerHTML = '<svg><use href="#i-x"/></svg>';
  el.append(favNode(t), title, close);

  el.addEventListener("click", () => activate(t.id));
  el.addEventListener("auxclick", e => { if (e.button === 1) closeTab(t.id); });
  close.addEventListener("click", e => { e.stopPropagation(); closeTab(t.id); });
  el.addEventListener("contextmenu", e => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: t.pinned ? "Unpin tab" : "Pin tab", fn: () => togglePin(t.id) },
      { label: "Duplicate", fn: () => newTab(t.url) },
      { label: "Copy link", fn: () => navigator.clipboard.writeText(t.url).then(() => toast("Link copied")) },
      { label: t.pinned ? "Unload tab" : "Close tab", fn: () => closeTab(t.id) },
    ]);
  });
  el.addEventListener("dragstart", e => {
    dragId = t.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", t.id);
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => { dragId = null; render(); });
  el.addEventListener("dragover", e => {
    if (!dragId) return;
    e.preventDefault();
    el.classList.add("drop-before");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-before"));
  el.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    if (dragId) moveTab(dragId, t.id);
  });
  return el;
}

function render() {
  write(STATE_KEY, state);
  const s = space();
  $("pinned").replaceChildren(...s.tabs.filter(t => t.pinned).map(tabEl));
  $("tabs").replaceChildren(...s.tabs.filter(t => !t.pinned).map(tabEl));

  $("spaces").replaceChildren(...state.spaces.map((sp, i) => {
    const d = document.createElement("div");
    d.className = "space-dot" + (i === state.space ? " active" : "");
    d.style.background = sp.color;
    d.title = sp.name;
    d.addEventListener("click", () => switchSpace(i));
    return d;
  }));

  const t = activeTab();
  const addr = $("addr");
  if (document.activeElement !== addr) addr.value = t ? t.url : "";
  $("star").classList.toggle("on", !!t && isBookmarked(t.url));
  renderChrome();
}

const STORE_RE = /^https:\/\/(?:chromewebstore\.google\.com\/detail|chrome\.google\.com\/webstore\/detail)\/(?:[^/?#]*\/)?([a-p]{32})(?:[/?#]|$)/;
let installedFolders = new Set(); // folder names of installed extensions (the store ID for store installs)
const refreshExtensions = () => call("list_extensions").then(l => {
  installedFolders = new Set((l || []).map(x => x.folder));
  renderChrome();
});

const YT_RE = /^https:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?|shorts\/)|youtu\.be\/)/;
let videoTools = { ready: false, ffmpeg: false };
const refreshVideoTools = () => call("video_tools").then(v => { if (v) { videoTools = v; renderChrome(); } });
let videoJob = null; // the running download, if any

function renderChrome() {
  document.documentElement.style.setProperty("--space", space().color);
  const t = activeTab();
  $("yt-banner").hidden = !(t && YT_RE.test(t.url));
  const full = videoTools.ready && videoTools.ffmpeg;
  $("yt-text").textContent = videoJob ? "Downloading…" : full ? "Save this video" : "Download videos from YouTube";
  $("yt-video").textContent = full ? "Video" : "Set up";
  $("yt-audio").hidden = !videoTools.ready;
  $("yt-video").disabled = $("yt-audio").disabled = !!videoJob;
  const storeId = t && (STORE_RE.exec(t.url) || [])[1];
  $("store-banner").hidden = !storeId || installedFolders.has(storeId);
  if (storeId) {
    const name = (t.title || "this extension").replace(/\s*[-–]\s*Chrome Web Store\s*$/, "") || "this extension";
    $("store-text").textContent = `Add ${name} to Alcove`;
    $("store-text").title = name;
  }
  const count = (t && blocked.get(t.id)) || 0;
  const off = !adblock || (t && siteOff(hostOf(t.url)));
  $("shield").classList.toggle("off", !!off);
  $("shield-count").textContent = !off && count ? String(count) : "";
  $("shield").title = off ? "Ad blocker off here (click for options)" : `Ad blocker on · ${count} blocked on this page`;
  const p = profiles.profiles.find(x => x.id === profiles.active);
  $("profile").textContent = (p ? p.name : "D")[0].toUpperCase();
  $("profile").style.background = p ? p.color : "var(--accent)";
  $("profile").title = p ? `Profile: ${p.name}` : "Profile";
}

async function switchSpace(i) {
  for (const id of ["tabs", "pinned"]) {
    $(id).classList.remove("swap");
    void $(id).offsetWidth; // restart the animation
    $(id).classList.add("swap");
  }
  state.space = i;
  panel = null;
  renderPanel();
  await activate(space().active);
}

function newSpace() {
  const n = state.spaces.length;
  state.spaces.push({ id: uid(), name: "Space " + (n + 1), color: COLORS[n % COLORS.length], tabs: [], active: null });
  return switchSpace(n);
}

// ---- panels (bookmarks / history / downloads) ----

function row(title, sub, onClick, actions = []) {
  const el = document.createElement("div");
  el.className = "row";
  const main = document.createElement("div");
  main.className = "main";
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = title;
  const u = document.createElement("div");
  u.className = "u";
  u.textContent = sub;
  main.append(t, u);
  el.append(main);
  el.addEventListener("click", onClick);
  for (const a of actions) {
    const b = document.createElement("button");
    b.textContent = a.label;
    b.title = a.title || "";
    b.addEventListener("click", e => { e.stopPropagation(); a.fn(); });
    el.append(b);
  }
  return el;
}

function openPanel(name) {
  panel = panel === name ? null : name;
  $("panel-search").value = "";
  renderPanel();
}

function renderPanel() {
  document.body.classList.toggle("panel-open", !!panel);
  $("panel").hidden = !panel;
  if (!panel) return;
  $("panel-title").textContent = { bookmarks: "Bookmarks", history: "History", downloads: "Downloads", extensions: "Extensions" }[panel];
  $("panel-search").hidden = panel === "downloads";
  $("panel-search").placeholder = panel === "extensions" ? "Chrome Web Store link or ID, then Enter" : "Search";
  $("panel-clear").hidden = panel === "bookmarks";
  $("panel-clear").textContent = panel === "extensions" ? "Load unpacked…" : "Clear";
  if (panel === "extensions") return renderExtensions();
  const q = $("panel-search").value.trim().toLowerCase();
  const match = x => !q || (x.title || "").toLowerCase().includes(q) || x.url.toLowerCase().includes(q);
  let rows = [];

  if (panel === "bookmarks") {
    rows = read(BM_KEY, []).filter(match).map(b => row(b.title, b.url, () => openUrl(b.url), [
      { label: "×", title: "Remove", fn: () => {
        write(BM_KEY, read(BM_KEY, []).filter(x => x.url !== b.url));
        renderPanel();
        render();
      } },
    ]));
  } else if (panel === "history") {
    rows = read(HIST_KEY, []).filter(match).slice(0, 200).map(h =>
      row(h.title || h.url, h.url, () => openUrl(h.url)));
  } else {
    rows = read(DL_KEY, []).map(d => row(
      d.path.split(/[\\/]/).pop(),
      d.state === "done" ? "Done · click to show in folder" : d.state === "failed" ? "Failed" : "Downloading…",
      () => invoke("reveal", { path: d.path }),
    ));
  }
  $("panel-body").replaceChildren(...(rows.length ? rows : [Object.assign(document.createElement("div"),
    { className: "empty", textContent: "Nothing here yet" })]));
}

// ---- extensions ----

const STORE_HOME = "https://chromewebstore.google.com/category/extensions";

function browseStore() {
  panel = null;
  renderPanel();
  newTab(STORE_HOME);
}

async function renderExtensions() {
  const list = await call("list_extensions");
  if (panel !== "extensions") return;
  if (!list) {
    $("panel-body").replaceChildren(Object.assign(document.createElement("div"),
      { className: "empty", textContent: "Extensions are only available in the Electron build." }));
    return;
  }
  const rows = list.map(x => row(x.name, `v${x.version}${x.description ? " · " + x.description : ""}`,
    () => { if (x.popup) call("extension_popup", { id: x.id }); },
    [{ label: "×", title: "Remove", fn: async () => {
      if (!confirm(`Remove "${x.name}"?`)) return;
      await call("remove_extension", { id: x.id });
      toast("Removed. Restart Alcove to fully unload it.", 4000);
      refreshExtensions();
      renderExtensions();
    } }]));
  const browse = document.createElement("button");
  browse.className = "browse-btn";
  browse.innerHTML = '<svg><use href="#i-puzzle"/></svg>Browse Chrome Web Store';
  browse.addEventListener("click", browseStore);
  $("panel-body").replaceChildren(browse, ...(rows.length ? rows : [Object.assign(document.createElement("div"),
    { className: "empty", textContent: "No extensions yet. Browse the store, paste a link above, or load an unpacked folder." })]));
}

async function installExtension(input, tabId) {
  toast("Installing extension…", 8000);
  try {
    const x = await invoke("install_extension", { input });
    if (tabId) call("store_button", { id: tabId, folder: x.folder }); // flips the store page's button to "Added"
    $("panel-search").value = "";
    toast(`Added ${x.name}`, 3000);
    refreshExtensions();
    setTimeout(() => navAction("reload"), 2000); // let the extension start, then apply it to the open page
  } catch (e) {
    toast(`Install failed: ${String(e.message || e).replace(/^Error invoking remote method 'invoke': Error: /, "")}`, 5000);
  }
  renderExtensions();
}

async function loadUnpacked() {
  try {
    const x = await invoke("install_unpacked_extension");
    if (x) {
      toast(`Loaded ${x.name}`, 3000);
      refreshExtensions();
      setTimeout(() => navAction("reload"), 2000);
    }
  } catch (e) {
    toast(`Could not load: ${String(e.message || e).replace(/^Error invoking remote method 'invoke': Error: /, "")}`, 5000);
  }
  renderExtensions();
}

// ---- context menu ----

function showMenu(x, y, items) {
  const m = $("menu");
  m.replaceChildren(...items.map(i => {
    const d = document.createElement("div");
    d.className = "item";
    const label = document.createElement("span");
    label.className = "grow";
    label.textContent = i.label;
    d.append(label);
    if (i.remove) {
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "×";
      x.title = "Delete";
      x.addEventListener("click", e => { e.stopPropagation(); hideMenu(); i.remove(); });
      d.append(x);
    }
    d.addEventListener("click", () => { hideMenu(); i.fn(); });
    return d;
  }));
  placeMenu(x, y);
}

// ---- profiles ----

function profileMenu() {
  const rect = $("profile").getBoundingClientRect();
  const items = profiles.profiles.map(p => ({
    label: (p.id === profiles.active ? "✓  " : "     ") + p.name,
    fn: () => { if (p.id !== profiles.active) call("switch_profile", { id: p.id }); },
    remove: p.id === "default" || p.id === profiles.active ? null : () => {
      if (confirm(`Delete profile "${p.name}" and all its data?`)) {
        call("delete_profile", { id: p.id }).then(loadProfiles);
      }
    },
  }));
  items.push({ label: "New profile…", fn: () => setTimeout(newProfile, 0) });
  showMenu(rect.left, rect.top - items.length * 32 - 14, items);
}

function newProfile() {
  const input = document.createElement("input");
  input.className = "menu-input";
  input.placeholder = "Profile name, then Enter";
  input.addEventListener("keydown", async e => {
    if (e.key === "Escape") hideMenu();
    if (e.key !== "Enter" || !input.value.trim()) return;
    const p = await call("create_profile", { name: input.value.trim() });
    hideMenu();
    if (p) call("switch_profile", { id: p.id });
  });
  const rect = $("profile").getBoundingClientRect();
  $("menu").replaceChildren(input);
  placeMenu(rect.left, rect.top - 60);
  input.focus();
}

const loadProfiles = () => call("get_profiles").then(p => { if (p) { profiles = p; renderChrome(); } });
function placeMenu(x, y) {
  const m = $("menu");
  m.hidden = false;
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 4) + "px";
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 4) + "px";
}
const hideMenu = () => { $("menu").hidden = true; };

// ---- shortcuts (native menu accelerators and palette commands) ----

const focusAddr = () => invoke("focus_ui").then(() => { $("addr").focus(); $("addr").select(); });

const actions = {
  "new-tab": () => newTab(),
  "reopen-tab": reopenClosed,
  "close-tab": () => { const t = activeTab(); if (t) closeTab(t.id); },
  "palette": () => invoke("show_palette"),
  "focus-address": focusAddr,
  "bookmark": toggleBookmark,
  "find": openFind,
  "screenshot-region": () => shoot("region"),
  "screenshot": () => shoot("visible"),
  "screenshot-full": () => shoot("full"),
  "reload": () => navAction("reload"),
  "back": () => navAction("back"),
  "forward": () => navAction("forward"),
  "zoom-in": () => setZoom(0.1),
  "zoom-out": () => setZoom(-0.1),
  "zoom-reset": () => setZoom(0),
  "bookmarks": () => openPanel("bookmarks"),
  "history": () => openPanel("history"),
  "downloads": () => openPanel("downloads"),
  "extensions": () => openPanel("extensions"),
  "download-video": () => downloadVideo("video"),
  "browse-extensions": browseStore,
  "new-space": newSpace,
  "pin-tab": () => { const t = activeTab(); if (t) togglePin(t.id); },
};

listen("shortcut", e => actions[e.payload]?.());

listen("palette-action", ({ payload: p }) => {
  if (p.type === "tab") goToTab(p.id);
  else if (p.type === "url") openUrl(p.url, !!p.newTab);
  else if (p.type === "cmd") actions[p.id]?.();
});

listen("new-tab-request", ({ payload }) => newTab(payload.url));

listen("sidebar-state", ({ payload: p }) => {
  document.body.classList.toggle("overlay", p.collapsed && p.peek);
  $("toggle-sidebar").title = p.collapsed ? "Show sidebar" : "Hide sidebar";
});

listen("tab-blocked", ({ payload }) => {
  blocked.set(payload.id, payload.count);
  renderChrome();
});

listen("tab-url", ({ payload }) => {
  const t = findTab(payload.id);
  if (!t) return;
  t.url = payload.url;
  recordHistory(t);
  render();
});

listen("tab-title", ({ payload }) => {
  const t = findTab(payload.id);
  if (!t) return;
  t.title = payload.title;
  const h = read(HIST_KEY, []);
  const e = h.find(x => x.url === t.url);
  if (e && e.title !== t.title) { e.title = t.title; write(HIST_KEY, h); }
  render();
});

listen("download", ({ payload: p }) => {
  const d = read(DL_KEY, []);
  if (p.state === "started") {
    d.unshift({ url: p.url, path: p.path, state: "downloading", ts: Date.now() });
    toast("Download started");
  } else {
    const e = d.find(x => x.url === p.url && x.state === "downloading");
    if (e) { e.state = p.state; if (p.path) e.path = p.path; }
    toast(p.state === "done" ? "Download finished" : "Download failed");
  }
  write(DL_KEY, d.slice(0, 200));
  if (panel === "downloads") renderPanel();
});

// ---- wiring ----

$("addr-form").addEventListener("submit", e => {
  e.preventDefault();
  const url = normalize($("addr").value);
  if (!url) return;
  $("addr").blur();
  openUrl(url);
});
$("addr").addEventListener("focus", () => $("addr").select());

$("new-tab").addEventListener("click", () => newTab());
$("new-space").addEventListener("click", newSpace);
for (const a of ["back", "forward", "reload"]) $(a).addEventListener("click", () => navAction(a));
$("star").addEventListener("click", toggleBookmark);
$("yt-video").addEventListener("click", () => downloadVideo("video"));
$("yt-audio").addEventListener("click", () => downloadVideo("audio"));
$("screenshot").addEventListener("click", e => { e.stopPropagation(); screenshotMenu(); });

// Window controls and drag handle (the window has no native title bar).
for (const b of document.querySelectorAll(".dot")) {
  b.addEventListener("click", () => call("window_action", { action: b.dataset.act }));
  b.addEventListener("mousedown", e => e.stopPropagation());
}
$("titlebar").addEventListener("mousedown", e => { if (e.button === 0) call("drag_start"); });
$("titlebar").addEventListener("dblclick", () => call("window_action", { action: "maximize" }));
for (const ev of ["mouseup", "blur"]) window.addEventListener(ev, () => call("drag_end"));
$("toggle-sidebar").addEventListener("click", () => call("toggle_sidebar"));
$("profile").addEventListener("click", e => { e.stopPropagation(); profileMenu(); });
// A menu (not a bare toggle) so the blocker can't be switched off by a stray click.
async function setSiteAllowed(host, allowed) {
  adblockAllow = (await call("set_adblock_site", { host, allowed })) || adblockAllow;
  toast(allowed ? `Ad blocker off on ${host}` : `Ad blocker on for ${host}`);
  renderChrome();
  navAction("reload");
}

async function setAdblock(on) {
  adblock = on;
  await call("set_adblock", { enabled: on });
  toast(on ? "Ad blocker on" : "Ad blocker off");
  renderChrome();
  navAction("reload"); // apply to the page being viewed
}

$("shield").addEventListener("click", e => {
  e.stopPropagation();
  const t = activeTab();
  const n = (t && blocked.get(t.id)) || 0;
  const rect = $("shield").getBoundingClientRect();
  const host = t ? hostOf(t.url) : "";
  const here = host && siteOff(host);
  const items = [{ label: !adblock ? "Ad blocker is off" : here ? `Ad blocker is off on ${host}` : `Ad blocker is on · ${n} blocked here`, fn: () => {} }];
  if (adblock && host) {
    items.push({ label: here ? `Turn on for ${host}` : `Turn off for ${host}`, fn: () => setSiteAllowed(host, !here) });
  }
  items.push(adblock ? { label: "Turn off for all sites", fn: () => setAdblock(false) } : { label: "Turn on", fn: () => setAdblock(true) });
  showMenu(Math.max(rect.right - 210, 8), rect.bottom + 6, items);
});

// While typing, keep a peeking sidebar on screen even if the pointer wanders off.
for (const id of ["addr", "find-input", "panel-search"]) {
  $(id).addEventListener("focus", () => call("sidebar_busy", { busy: true }));
  $(id).addEventListener("blur", () => call("sidebar_busy", { busy: false }));
}
$("open-bookmarks").addEventListener("click", () => openPanel("bookmarks"));
$("open-history").addEventListener("click", () => openPanel("history"));
$("open-downloads").addEventListener("click", () => openPanel("downloads"));
$("open-extensions").addEventListener("click", () => openPanel("extensions"));
$("store-add").addEventListener("click", () => { const t = activeTab(); if (t) installExtension(t.url, t.id); });
listen("store-install", ({ payload }) => installExtension(payload.url, payload.id));
$("panel-close").addEventListener("click", () => { panel = null; renderPanel(); });
$("panel-search").addEventListener("input", () => { if (panel !== "extensions") renderPanel(); });
$("panel-search").addEventListener("keydown", e => {
  if (e.key === "Enter" && panel === "extensions" && $("panel-search").value.trim()) installExtension($("panel-search").value);
});
$("panel-clear").addEventListener("click", () => {
  if (panel === "extensions") return loadUnpacked();
  write(panel === "history" ? HIST_KEY : DL_KEY, []);
  renderPanel();
});

$("find-input").addEventListener("input", () => doFind(false));
$("find-input").addEventListener("keydown", e => {
  if (e.key === "Enter") doFind(e.shiftKey);
  if (e.key === "Escape") closeFind();
});
$("find-next").addEventListener("click", () => doFind(false));
$("find-prev").addEventListener("click", () => doFind(true));
$("find-close").addEventListener("click", closeFind);

// Dropping on empty list space moves the tab to the end of that group.
for (const [id, pinned] of [["pinned", true], ["tabs", false]]) {
  $(id).addEventListener("dragover", e => { if (dragId) e.preventDefault(); });
  $(id).addEventListener("drop", e => { e.preventDefault(); if (dragId) moveTab(dragId, null, pinned); });
}

document.addEventListener("click", hideMenu);
window.addEventListener("blur", hideMenu);
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  hideMenu();
  if (panel) { panel = null; renderPanel(); }
});

call("get_settings").then(s => {
  if (!s) return;
  adblock = s.adblock;
  adblockAllow = s.adblockAllow || [];
  document.body.classList.toggle("collapsed", s.collapsed);
  $("toggle-sidebar").title = s.collapsed ? "Show sidebar" : "Hide sidebar";
  renderChrome();
});
loadProfiles();
refreshExtensions();
refreshVideoTools();

// Restore: reopen the active tab of the current space; other tabs open lazily.
renderPanel();
activate(space().active && activeTab() ? space().active : null).then(() => {
  if (!space().tabs.length) newTab();
});
