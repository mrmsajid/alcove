const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = id => document.getElementById(id);
const COLORS = ["#7c8cff", "#ff7c9c", "#5fd6a0", "#ffb86b", "#c27cff"];
// Settings (search engine, new tab page, accent, text size, zoom…), kept in sync with the Settings page.
let appSettings = {};
const START_PAGE = new URL("newtab.html", location.href).href; // the default new tab: a search bar and the tools
const newTabUrl = () => appSettings.newTab === "blank" ? "about:blank"
  : appSettings.newTab === "custom" && appSettings.newTabUrl ? appSettings.newTabUrl
  : appSettings.newTab === "engine" ? engineHome(appSettings)
  : START_PAGE;
function applyAppSettings(s) {
  appSettings = s || {};
  document.documentElement.style.setProperty("--accent", appSettings.accent || "#76767f");
  const size = { small: "12.5px", large: "15px" }[appSettings.textSize] || "13.5px";
  document.documentElement.style.fontSize = document.body.style.fontSize = size;
}
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
for (const sp of state.spaces) {
  sp.groups ||= []; // tab groups: { id, name, color, collapsed }
  sp.split = null;  // split view isn't restored after a restart
}
const GROUP_COLORS = ["#7c8cff", "#ff7c9c", "#5fd6a0", "#ffb86b", "#c27cff", "#6cc7ff", "#9aa0a6"];
let renamingGroup = null; // group id whose name is being edited
const opened = new Set(); // tab ids with a live webview this session
const CLOSED_KEY = "alcove-closed"; // recently closed tabs (newest first), shared with the palette
const audio = new Map();  // tab id -> { audible, muted }
let panel = null;
let dragId = null;
const seen = new Map(); // tab id -> first render time, so only new tabs animate in
document.body.classList.add(/Mac/.test(navigator.userAgent) ? "mac" : "win");
// A command the app doesn't have, or that fails, shouldn't break the page, so failures are swallowed.
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
  return searchUrl(appSettings, v);
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

async function newTab(url = newTabUrl(), from = null) {
  const tab = childTab(url, from) || { id: uid(), url, title: "New Tab", pinned: false };
  if (!space().tabs.includes(tab)) space().tabs.push(tab);
  await activate(tab.id);
}

// A tab opened from a page nests under that page's tab in the sidebar (after its earlier children).
function childTab(url, from) {
  const s = space();
  const parent = from && s.tabs.find(t => t.id === from);
  if (!parent || parent.pinned) return null;
  const tab = { id: uid(), url, title: hostOf(url) || "New Tab", pinned: false, groupId: parent.groupId || null, parentId: parent.id };
  let at = s.tabs.indexOf(parent);
  s.tabs.forEach((t, k) => { if (t.parentId === parent.id) at = k; });
  s.tabs.splice(at + 1, 0, tab);
  parent.kidsCollapsed = false;
  return tab;
}

// Opened with Cmd/Ctrl+click or "Open Link in Background": nests under its opener, loaded when first shown.
function backgroundTab(url, from = null) {
  const s = space();
  const cur = activeTab();
  let tab = childTab(url, from || (cur && cur.id));
  if (!tab) {
    tab = { id: uid(), url, title: hostOf(url) || "New Tab", pinned: false, groupId: cur && !cur.pinned ? cur.groupId || null : null };
    const i = cur ? s.tabs.indexOf(cur) : -1;
    s.tabs.splice(i >= 0 ? i + 1 : s.tabs.length, 0, tab);
  }
  render();
  return tab;
}

// Most-recently-used tabs per space, for Ctrl+Tab.
const recentTabs = new Map(); // space id -> [tab ids], newest first
function noteRecent(id) {
  if (!id) return;
  const list = (recentTabs.get(space().id) || []).filter(x => x !== id && findTab(x));
  list.unshift(id);
  recentTabs.set(space().id, list.slice(0, 20));
}
const orderedTabs = () => [...space().tabs.filter(t => t.pinned), ...space().tabs.filter(t => !t.pinned)];
const previousTab = () => (recentTabs.get(space().id) || []).find(x => x !== space().active && space().tabs.some(t => t.id === x));

// ---- split view ----

const inSplit = id => !!space().split && (space().split.left === id || space().split.right === id);

async function ensureOpen(id) {
  const t = findTab(id);
  if (t && !opened.has(id)) {
    await invoke("open_tab", { id, url: t.url });
    opened.add(id);
  }
}

async function startSplit(leftId, rightId) {
  if (!leftId || !rightId || leftId === rightId) return;
  await ensureOpen(leftId);
  await ensureOpen(rightId);
  const s = space();
  s.split = { left: leftId, right: rightId, ratio: (s.split && s.split.ratio) || 0.5 };
  s.active = rightId;
  noteRecent(rightId);
  await call("set_split", { split: s.split });
  render();
}

async function exitSplit() {
  const s = space();
  if (!s.split) return;
  s.split = null;
  await call("set_split", { split: null });
  await activate(s.active);
}

async function activate(id) {
  call("close_settings"); // choosing a tab shows that tab, not Settings
  const s = space();
  if (s.split && !inSplit(id)) s.split = null; // picking a tab outside the split leaves split view
  await call("set_split", { split: s.split || null });
  s.active = id;
  noteRecent(id);
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

const closing = new Set(); // tab ids being closed, so a second Cmd+W (or a key repeat) can't close the neighbour too
async function closeTab(id) {
  if (closing.has(id)) return;
  const s = space();
  const t = s.tabs.find(t => t.id === id);
  if (!t) return;
  closing.add(id);
  try {
    // The page may ask "Leave this page?" (unsaved Markdown edits, a form half filled in): if the user stays, the tab stays.
    if (opened.has(id) && (await invoke("close_tab", { id }).catch(() => true)) === false) return;
    opened.delete(id);
    if (inSplit(id)) s.split = null;
    const el = document.querySelector(`.tab[data-id="${id}"]`);
    if (el && !t.pinned) { el.classList.add("leaving"); await sleep(150); }
    await finishClose(s, t);
  } finally { closing.delete(id); }
}

// The tab's page is gone: take its row out (a pinned tab stays, unloaded) and show the next one.
async function finishClose(s, t) {
  const id = t.id;
  const i = s.tabs.indexOf(t); // looked up now: the list may have changed while the row faded out
  if (i < 0) return;
  if (t.pinned) {
    t.url = t.pinUrl || t.url; // pinned tabs unload instead of disappearing
  } else {
    s.tabs.splice(i, 1);
    write(CLOSED_KEY, [{ url: t.url, title: t.title, ts: Date.now() }, ...read(CLOSED_KEY, [])].slice(0, 25));
  }
  if (s.active === id) {
    const rest = s.tabs.filter(x => x.id !== id);
    const next = rest[Math.min(i, rest.length - 1)];
    await activate(next ? next.id : null);
  } else {
    render();
  }
}

// A page closed itself (window.close(), an OAuth "you can close this window" page): its view is already gone.
listen("tab-closed", ({ payload }) => {
  const id = payload.id;
  if (closing.has(id) || !opened.delete(id)) return; // closed from here, or already handled
  const t = findTab(id);
  const s = t && state.spaces.find(sp => sp.tabs.includes(t));
  if (s) finishClose(s, t);
});

async function reopenClosed(url) {
  const list = read(CLOSED_KEY, []);
  const i = url ? list.findIndex(c => c.url === url) : 0;
  const t = i >= 0 ? list.splice(i, 1)[0] : (url ? { url } : null);
  write(CLOSED_KEY, list);
  if (t) await newTab(t.url);
}

// ---- tab cleanup (palette commands) ----

async function closeDuplicates() {
  const cur = activeTab();
  const seen = new Set(cur ? [cur.url] : []);
  const dupes = [];
  for (const t of orderedTabs()) {
    if (cur && t.id === cur.id) continue;
    if (seen.has(t.url) && !t.pinned) dupes.push(t.id);
    else seen.add(t.url);
  }
  for (const id of dupes) await closeTab(id);
  toast(dupes.length ? `Closed ${plural(dupes.length, "duplicate tab")}` : "No duplicate tabs");
}

async function closeMany(ids, what) {
  if (ids.length >= 6 && !confirm(`Close ${ids.length} ${what}?`)) return;
  for (const id of ids) await closeTab(id);
  toast(ids.length ? `Closed ${plural(ids.length, "tab")} · reopen with ⌘⇧T` : "Nothing to close");
}
const closeOthers = () => closeMany(space().tabs.filter(t => !t.pinned && t.id !== space().active).map(t => t.id), "other tabs");
function closeBelow() {
  const list = orderedTabs().filter(t => !t.pinned);
  const i = list.findIndex(t => t.id === space().active);
  return closeMany(i >= 0 ? list.slice(i + 1).map(t => t.id) : [], "tabs below this one");
}

// Groups loose tabs by site: every site with two or more tabs gets its own tab group.
function tidyTabs() {
  const s = space();
  const bySite = new Map();
  for (const t of s.tabs) {
    if (t.pinned || t.groupId) continue;
    const host = hostOf(t.url);
    if (!host) continue;
    if (!bySite.has(host)) bySite.set(host, []);
    bySite.get(host).push(t);
  }
  let made = 0;
  for (const [host, list] of bySite) {
    if (list.length < 2) continue;
    const label = host.split(".").slice(-2, -1)[0] || host;
    const g = { id: uid(), name: label.charAt(0).toUpperCase() + label.slice(1), color: GROUP_COLORS[s.groups.length % GROUP_COLORS.length], collapsed: false };
    s.groups.push(g);
    for (const t of list) { t.groupId = g.id; t.parentId = null; }
    made++;
  }
  render();
  toast(made ? `Grouped tabs into ${plural(made, "site group")}` : "No site has more than one tab");
}

async function moveTabToSpace(index) {
  const s = space();
  const t = activeTab();
  const target = state.spaces[index];
  if (!t || !target || target === s) return;
  if (inSplit(t.id)) await exitSplit();
  s.tabs = s.tabs.filter(x => x.id !== t.id);
  Object.assign(t, { groupId: null, parentId: null, pinned: false });
  target.tabs.push(t);
  const next = orderedTabs()[0];
  s.active = next ? next.id : null;
  state.space = index;
  await activate(t.id);
  toast(`Moved to ${target.name}`);
}

function togglePin(id) {
  const t = findTab(id);
  if (!t) return;
  t.pinned = !t.pinned;
  t.pinUrl = t.pinned ? t.url : undefined;
  if (t.pinned) t.groupId = null;
  render();
}

// Drop before another tab (joining its pinned area or group), at the end of a group, or at the end of a list.
function moveTab(id, beforeId, { pinned = false, toGroup = null } = {}) {
  if (id === beforeId) return;
  const tabs = space().tabs;
  const i = tabs.findIndex(t => t.id === id);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  t.parentId = null;
  const j = beforeId ? tabs.findIndex(x => x.id === beforeId) : -1;
  if (toGroup) {
    let last = -1;
    tabs.forEach((x, k) => { if (!x.pinned && x.groupId === toGroup) last = k; });
    t.pinned = false;
    t.groupId = toGroup;
    tabs.splice(last >= 0 ? last + 1 : tabs.length, 0, t);
  } else if (j >= 0) {
    t.pinned = tabs[j].pinned;
    t.groupId = t.pinned ? null : tabs[j].groupId || null;
    tabs.splice(j, 0, t);
  } else {
    t.pinned = !!pinned;
    t.groupId = null;
    tabs.push(t);
  }
  if (t.pinned && !t.pinUrl) t.pinUrl = t.url;
  render();
}

// ---- tab groups ----

const groupById = id => space().groups.find(g => g.id === id);
const groupTabs = gid => space().tabs.filter(t => !t.pinned && t.groupId === gid);

function focusRename() {
  setTimeout(() => {
    const input = document.querySelector(".group-head input");
    if (input) { input.focus(); input.select(); }
  }, 0);
}

function newGroup(tabId) {
  const s = space();
  const t = s.tabs.find(x => x.id === tabId);
  if (!t) return;
  const g = { id: uid(), name: "New group", color: GROUP_COLORS[s.groups.length % GROUP_COLORS.length], collapsed: false };
  s.groups.push(g);
  t.pinned = false;
  t.pinUrl = undefined;
  t.groupId = g.id;
  renamingGroup = g.id;
  render();
  focusRename();
}

async function newGroupWithTab() {
  await newTab();
  const t = activeTab();
  if (t) newGroup(t.id);
}

async function newTabInGroup(gid) {
  const s = space();
  const tab = { id: uid(), url: newTabUrl(), title: "New Tab", pinned: false, groupId: gid };
  let last = -1;
  s.tabs.forEach((x, k) => { if (!x.pinned && x.groupId === gid) last = k; });
  s.tabs.splice(last >= 0 ? last + 1 : s.tabs.length, 0, tab);
  const g = groupById(gid);
  if (g) g.collapsed = false;
  await activate(tab.id);
}

function commitRename(gid, value) {
  const g = groupById(gid);
  if (g && value.trim()) g.name = value.trim().slice(0, 40);
  renamingGroup = null;
  render();
}

function toggleGroup(gid) {
  const g = groupById(gid);
  if (g) { g.collapsed = !g.collapsed; render(); }
}

function recolorGroup(gid) {
  const g = groupById(gid);
  if (!g) return;
  g.color = GROUP_COLORS[(GROUP_COLORS.indexOf(g.color) + 1) % GROUP_COLORS.length];
  render();
}

function ungroup(gid) {
  for (const t of space().tabs) if (t.groupId === gid) t.groupId = null;
  space().groups = space().groups.filter(g => g.id !== gid);
  render();
}

async function closeGroup(gid) {
  for (const t of groupTabs(gid)) await closeTab(t.id);
}

function setTabGroup(tabId, gid) {
  if (gid) return moveTab(tabId, null, { toGroup: gid });
  const t = findTab(tabId);
  if (t) { t.groupId = null; render(); }
}

function groupEl(g, members) {
  const s = space();
  const wrap = document.createElement("div");
  wrap.className = "group" + (g.collapsed ? " collapsed" : "");
  wrap.style.setProperty("--g", g.color);
  const head = document.createElement("div");
  head.className = "group-head";
  head.title = g.collapsed ? "Expand group" : "Collapse group";
  const dot = document.createElement("span");
  dot.className = "gdot";
  let name;
  if (renamingGroup === g.id) {
    name = document.createElement("input");
    name.value = g.name;
    name.addEventListener("click", e => e.stopPropagation());
    name.addEventListener("keydown", e => {
      if (e.key === "Enter") commitRename(g.id, name.value);
      if (e.key === "Escape") { renamingGroup = null; render(); }
    });
    name.addEventListener("blur", () => { if (renamingGroup === g.id) commitRename(g.id, name.value); });
  } else {
    name = document.createElement("span");
    name.className = "gname";
    name.textContent = g.name;
  }
  const count = document.createElement("span");
  count.className = "gcount";
  count.textContent = members.length;
  const chev = document.createElement("span");
  chev.className = "chev";
  chev.innerHTML = '<svg><use href="#i-down"/></svg>';
  head.append(dot, name, count, chev);

  head.addEventListener("click", () => { if (renamingGroup !== g.id) toggleGroup(g.id); });
  head.addEventListener("dblclick", e => { e.stopPropagation(); renamingGroup = g.id; render(); focusRename(); });
  head.addEventListener("contextmenu", e => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: "Rename group", fn: () => { renamingGroup = g.id; render(); focusRename(); } },
      { label: "Change color", fn: () => recolorGroup(g.id) },
      { label: "New tab in group", fn: () => newTabInGroup(g.id) },
      { label: g.collapsed ? "Expand" : "Collapse", fn: () => toggleGroup(g.id) },
      { label: "Ungroup", fn: () => ungroup(g.id) },
      { label: `Close group (${members.length})`, fn: () => closeGroup(g.id) },
    ]);
  });
  head.addEventListener("dragover", e => { if (!dragId) return; e.preventDefault(); head.classList.add("drop-into"); });
  head.addEventListener("dragleave", () => head.classList.remove("drop-into"));
  head.addEventListener("drop", e => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragId) return;
    g.collapsed = false;
    moveTab(dragId, null, { toGroup: g.id });
  });

  const body = document.createElement("div");
  body.className = "group-tabs";
  // A collapsed group still shows its active tab so the current page never disappears from the list.
  body.append(...(g.collapsed ? members.filter(t => t.id === s.active).map(t => tabEl(t))
    : members.filter(t => isRoot(t, members)).flatMap(t => tabTree(t, members, 0))));
  wrap.append(head, body);
  return wrap;
}

async function openUrl(url, inNewTab = false) {
  call("close_settings");
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
  const rect = $("open-library").getBoundingClientRect();
  showMenu(rect.left, rect.top - 3 * 32 - 14, [
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
  const base = appSettings.defaultZoom || 1; // Settings › Appearance › Page zoom
  t.zoom = delta === 0 ? base : Math.min(3, Math.max(0.5, Math.round(((t.zoom || base) + delta) * 10) / 10));
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

// Search result pages read better as their query, with the engine as a quiet suffix.
function displayTitle(t) {
  try {
    const u = new URL(t.url);
    const q = u.searchParams.get("q");
    const engine = /(^|\.)google\./.test(u.hostname) && u.pathname === "/search" ? "Google"
      : /(^|\.)duckduckgo\.com$/.test(u.hostname) ? "DuckDuckGo"
      : /(^|\.)bing\.com$/.test(u.hostname) && u.pathname === "/search" ? "Bing"
      : /(^|\.)search\.brave\.com$/.test(u.hostname) ? "Brave"
      : /(^|\.)ecosia\.org$/.test(u.hostname) && u.pathname === "/search" ? "Ecosia"
      : /(^|\.)perplexity\.ai$/.test(u.hostname) ? "Perplexity"
      : /(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/results" ? "YouTube" : null;
    const query = q || (engine === "YouTube" && u.searchParams.get("search_query"));
    if (engine && query) return { main: query, sub: engine };
  } catch {}
  return { main: t.title || t.url, sub: "" };
}

function tabEl(t, depth = 0, kids = 0) {
  const el = document.createElement("div");
  el.className = "tab" + (t.pinned ? " pin" : "") + (t.id === space().active ? " active" : "") + (inSplit(t.id) ? " in-split" : "")
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
  const dt = displayTitle(t);
  title.textContent = dt.main;
  if (dt.sub) {
    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = dt.sub;
    title.append(sub);
  }
  if (!t.pinned && depth) el.style.paddingLeft = `${8 + depth * 18}px`;
  const pin = document.createElement("button");
  pin.className = "pin-btn";
  pin.title = "Pin tab";
  pin.innerHTML = '<svg><use href="#i-pin"/></svg>';
  const close = document.createElement("button");
  close.className = "close";
  close.innerHTML = '<svg><use href="#i-x"/></svg>';
  if (!t.pinned && kids) {
    // Parent of opened-from tabs: the chevron shows or hides its children.
    const chev = document.createElement("button");
    chev.className = "kids" + (t.kidsCollapsed ? " collapsed" : "");
    chev.title = t.kidsCollapsed ? `Show ${kids} tab${kids === 1 ? "" : "s"}` : "Hide tabs opened from here";
    chev.innerHTML = '<svg><use href="#i-down"/></svg>';
    chev.addEventListener("click", e => { e.stopPropagation(); t.kidsCollapsed = !t.kidsCollapsed; render(); });
    el.append(chev);
  }
  const snd = audio.get(t.id);
  let sound = null;
  if (snd && (snd.audible || snd.muted)) {
    sound = document.createElement("button");
    sound.className = "sound" + (snd.muted ? " muted" : "");
    sound.title = snd.muted ? "Unmute tab" : "Mute tab";
    sound.innerHTML = `<svg><use href="#${snd.muted ? "i-muted" : "i-speaker"}"/></svg>`;
    sound.addEventListener("click", e => { e.stopPropagation(); call("mute_tab", { id: t.id }); });
  }
  el.append(favNode(t), title, ...(sound ? [sound] : []), pin, close);
  pin.addEventListener("click", e => { e.stopPropagation(); togglePin(t.id); });

  el.addEventListener("click", () => activate(t.id));
  el.addEventListener("auxclick", e => { if (e.button === 1) closeTab(t.id); });
  close.addEventListener("click", e => { e.stopPropagation(); closeTab(t.id); });
  el.addEventListener("contextmenu", e => {
    e.preventDefault();
    const groupItems = t.pinned ? [] : [
      { label: "Add to new group", fn: () => newGroup(t.id) },
      ...space().groups.filter(g => g.id !== t.groupId).map(g => ({ label: `Move to “${g.name}”`, fn: () => setTabGroup(t.id, g.id) })),
      ...(t.groupId ? [{ label: "Remove from group", fn: () => setTabGroup(t.id, null) }] : []),
    ];
    const cur = space().active;
    const splitItems = inSplit(t.id) ? [{ label: "Exit split view", fn: exitSplit }]
      : cur && cur !== t.id ? [{ label: "Split view with current tab", fn: () => startSplit(cur, t.id) }] : [];
    showMenu(e.clientX, e.clientY, [
      { label: t.pinned ? "Unpin tab" : "Pin tab", fn: () => togglePin(t.id) },
      ...splitItems,
      ...groupItems,
      { label: "Duplicate", fn: () => newTab(t.url) },
      ...(/^https?:/.test(t.url) ? [{ label: "Add to start page", fn: () => call("add_shortcut", { url: t.url, name: t.title }).then(ok => toast(ok ? "Added to the start page" : "Already on the start page, or the list is full")) }] : []),
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

// Tab tree: a tab whose opener is in the same list is drawn under it (up to 3 levels deep).
const isRoot = (t, pool) => !t.parentId || !pool.some(p => p.id === t.parentId);
function tabTree(t, pool, depth) {
  const kids = pool.filter(k => k.parentId === t.id);
  const out = [tabEl(t, depth, kids.length)];
  for (const k of kids) {
    if (t.kidsCollapsed && k.id !== space().active) continue; // the active tab always stays visible
    out.push(...tabTree(k, pool, Math.min(depth + 1, 3)));
  }
  return out;
}

function render() {
  write(STATE_KEY, state);
  const s = space();
  // Drop groups that no longer have tabs (except one being named right now).
  s.groups = (s.groups || []).filter(g => g.id === renamingGroup || s.tabs.some(t => !t.pinned && t.groupId === g.id));
  for (const t of s.tabs) if (t.groupId && !s.groups.some(g => g.id === t.groupId)) t.groupId = null;
  $("pinned").replaceChildren(...s.tabs.filter(t => t.pinned).map(tabEl));
  // Don't rebuild the list while a group name is being typed, or the text box would be replaced mid-edit.
  const typing = renamingGroup && document.activeElement && document.activeElement.closest(".group-head");
  if (!typing) {
    const items = [];
    const drawn = new Set();
    const loose = s.tabs.filter(x => !x.pinned && !x.groupId);
    for (const t of s.tabs.filter(x => !x.pinned)) {
      if (!t.groupId) {
        if (isRoot(t, loose)) items.push(...tabTree(t, loose, 0));
        continue;
      }
      if (drawn.has(t.groupId)) continue;
      drawn.add(t.groupId);
      items.push(groupEl(groupById(t.groupId), groupTabs(t.groupId)));
    }
    $("tabs").replaceChildren(...items);
  }

  $("spaces").replaceChildren(...state.spaces.map((sp, i) => {
    const d = document.createElement("div");
    d.className = "space-dot" + (i === state.space ? " active" : "") + (sp.icon ? " emoji" : "");
    if (sp.icon) d.textContent = sp.icon;
    else d.style.background = sp.color;
    d.title = sp.name;
    d.addEventListener("click", () => switchSpace(i));
    d.addEventListener("contextmenu", e => { e.preventDefault(); spaceMenu(i, e.clientX, e.clientY); });
    return d;
  }));
  const title = $("space-title");
  if (!title.querySelector("input")) {
    title.textContent = (s.icon ? s.icon + "  " : "") + s.name;
    title.title = "Double-click to rename · right-click for space options";
  }

  const t = activeTab();
  const addr = $("addr");
  if (document.activeElement !== addr) addr.value = t ? t.url : "";
  renderAddr(t);
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

// The sidebar and the window frame around the page share one neutral color. With glass on, it becomes a
// translucent tint over the frosted window (Settings › Appearance › Frost), and the sidebar page itself
// is transparent so both look the same.
const hexRgb = h => {
  h = String(h).trim().replace("#", "");
  if (h.length === 3) h = [...h].map(c => c + c).join("");
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0);
};
const mixHex = (a, b, t) => "#" + hexRgb(a).map((x, i) => Math.round(x * t + hexRgb(b)[i] * (1 - t)).toString(16).padStart(2, "0")).join("");
let sentChrome = null;

// When the address bar isn't being edited it shows the site in bold and the path dimmed.
function renderAddr(t) {
  const d = $("addr-display");
  d.replaceChildren();
  if (!t) return;
  if (/\/blocked\.html(\?|$)/.test(t.url)) { d.textContent = "Focus mode"; return; } // a site blocked by Tools › Focus mode
  if (t.url.split(/[?#]/)[0] === START_PAGE) { d.textContent = "Search or enter address"; return; }
  try {
    const u = new URL(t.url);
    if (/^https?:$/.test(u.protocol)) {
      const host = document.createElement("b");
      host.textContent = u.hostname.replace(/^www\./, "");
      const rest = document.createElement("span");
      rest.textContent = (u.pathname === "/" ? "" : u.pathname) + u.search;
      d.append(host, rest);
      return;
    }
  } catch {}
  d.textContent = t.url;
}

function renderChrome() {
  document.documentElement.style.setProperty("--space", space().color);
  document.body.classList.toggle("theme-light", space().theme === "light");
  document.body.classList.toggle("theme-dark", space().theme === "dark");
  const solid = mixHex("#000000", getComputedStyle(document.body).getPropertyValue("--bg"), 0);
  const glass = appSettings.glass !== false && /Mac|Windows/.test(navigator.userAgent);
  const clear = glass && appSettings.glassStyle === "clear" && /Mac/.test(navigator.userAgent);
  const frost = Number.isFinite(appSettings.frost) ? appSettings.frost : 55;
  // Frosted: 0 → mostly clear blur, 100 → solid. Clear glass: 0 → just the blur, rising to solid at 100.
  const alpha = Math.round((clear ? 0.03 + 0.87 * Math.pow(frost / 100, 1.4) : 0.15 + 0.85 * frost / 100) * 100) / 100;
  const shine = Number.isFinite(appSettings.shine) ? appSettings.shine : 40;
  document.body.classList.toggle("glass-clear", clear);
  document.body.classList.toggle("liquid", glass && shine > 0);
  document.documentElement.style.setProperty("--shine", String(shine / 100));
  const [r, g, b] = hexRgb(solid);
  const chrome = glass ? `rgba(${r}, ${g}, ${b}, ${alpha})` : solid;
  document.body.classList.toggle("glass", glass);
  document.documentElement.style.setProperty("--chrome", glass ? "transparent" : solid);
  document.documentElement.style.setProperty("--chrome-solid", solid);
  document.documentElement.style.setProperty("--chrome-tint", glass ? chrome : solid);
  document.documentElement.style.setProperty("--tint-a", String(alpha));
  const blur = Number.isFinite(appSettings.blur) ? appSettings.blur : 55;
  document.documentElement.style.setProperty("--glass-blur", `${Math.round(4 + 0.4 * blur)}px`);
  if (chrome !== sentChrome) { sentChrome = chrome; call("set_chrome_color", { color: chrome }); }
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

// ---- space options ----

function spaceMenu(i, x, y) {
  const sp = state.spaces[i];
  const themes = { auto: "Match system", light: "Light", dark: "Dark" };
  const next = { auto: "light", light: "dark", dark: "auto" }[sp.theme || "auto"];
  showMenu(x, Math.min(y, window.innerHeight - 230), [
    { label: "Rename space…", fn: () => setTimeout(() => spaceInput(i, "name"), 0) },
    { label: "Set emoji icon…", fn: () => setTimeout(() => spaceInput(i, "icon"), 0) },
    ...(sp.icon ? [{ label: "Remove icon", fn: () => { sp.icon = ""; render(); } }] : []),
    { label: "Change color", fn: () => { sp.color = COLORS[(COLORS.indexOf(sp.color) + 1) % COLORS.length]; render(); } },
    { label: `Appearance: ${themes[sp.theme || "auto"]} → ${themes[next]}`, fn: () => { sp.theme = next; render(); } },
    ...(state.spaces.length > 1 ? [{ label: "Delete space…", fn: () => deleteSpace(i) }] : []),
  ]);
}

// Inline text box in the menu, used for the space name and emoji icon.
function spaceInput(i, field) {
  const sp = state.spaces[i];
  const input = document.createElement("input");
  input.className = "menu-input";
  input.value = field === "name" ? sp.name : sp.icon || "";
  input.placeholder = field === "name" ? "Space name, then Enter" : "Type or paste an emoji, then Enter";
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") hideMenu();
    if (e.key !== "Enter") return;
    const v = input.value.trim();
    if (field === "name" && v) sp.name = v.slice(0, 30);
    if (field === "icon") sp.icon = [...v].slice(0, 2).join(""); // keep it to one emoji (some are 2 code points)
    hideMenu();
    render();
  });
  $("menu").replaceChildren(input);
  const r = $("spaces").getBoundingClientRect();
  placeMenu(r.left, r.top - 60);
  input.focus();
  input.select();
}

async function deleteSpace(i) {
  const sp = state.spaces[i];
  if (state.spaces.length < 2 || !confirm(`Delete “${sp.name}” and close its ${sp.tabs.length} tabs?`)) return;
  for (const t of sp.tabs) if (opened.delete(t.id)) await invoke("close_tab", { id: t.id, force: true });
  state.spaces.splice(i, 1);
  if (state.space === i) state.space = 0;
  else if (state.space > i) state.space -= 1;
  await activate(space().active);
}

function stepSpace(delta) {
  const n = state.spaces.length;
  if (n > 1) switchSpace((state.space + delta + n) % n);
}

function newSpace() {
  const n = state.spaces.length;
  state.spaces.push({ id: uid(), name: "Space " + (n + 1), color: COLORS[n % COLORS.length], tabs: [], active: null, groups: [], split: null });
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
  $("panel-title").textContent = { bookmarks: "Bookmarks", history: "History", downloads: "Downloads", extensions: "Extensions", import: "Import from browser" }[panel];
  $("panel-search").hidden = panel === "downloads" || panel === "import";
  $("panel-search").placeholder = panel === "extensions" ? "Chrome Web Store link or ID, then Enter" : "Search";
  $("panel-clear").hidden = panel === "bookmarks" || panel === "import";
  $("panel-clear").textContent = panel === "extensions" ? "Load unpacked…" : "Clear";
  if (panel === "extensions") return renderExtensions();
  if (panel === "import") return renderImport();
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

// ---- import from Chrome, Edge, Brave, Arc, Vivaldi ----

const importWhat = { bookmarks: true, history: true, extensions: true };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function renderImport() {
  const sources = await call("list_import_sources");
  if (panel !== "import") return;
  const opts = document.createElement("div");
  opts.className = "import-opts";
  for (const [key, label] of [["bookmarks", "Bookmarks"], ["history", "History"], ["extensions", "Extensions"]]) {
    const l = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = importWhat[key];
    box.addEventListener("change", () => { importWhat[key] = box.checked; });
    l.append(box, label);
    opts.append(l);
  }
  const rows = [];
  for (const src of sources || []) {
    for (const p of src.profiles) {
      rows.push(row(`${src.browser} · ${p.name}`,
        `${plural(p.bookmarks, "bookmark")} · ${plural(p.extensions, "extension")}${p.history ? " · history" : ""}`, () => {}, [
          { label: "Import", title: "Add to this Alcove profile", fn: () => runImport(src, p, false) },
          { label: "New profile", title: `Create an Alcove profile named “${p.name}”`, fn: () => runImport(src, p, true) },
        ]));
    }
  }
  const empty = Object.assign(document.createElement("div"), {
    className: "empty",
    textContent: sources ? "No Chrome, Edge, Brave, Arc or Vivaldi profiles found on this computer." : "Import is only available in the Electron build.",
  });
  const note = Object.assign(document.createElement("div"), {
    className: "import-note",
    textContent: "Passwords and sign-ins aren't imported (the other browser keeps them encrypted), so you'll sign in to sites once.",
  });
  $("panel-body").replaceChildren(opts, ...(rows.length ? rows : [empty]), note);
}

// Adds imported bookmarks and history to this profile, skipping ones already here.
function mergeImport({ bookmarks = [], history = [] }) {
  const bm = read(BM_KEY, []);
  const have = new Set(bm.map(b => b.url));
  let added = 0;
  for (const b of bookmarks) if (!have.has(b.url)) { bm.push({ url: b.url, title: b.title }); have.add(b.url); added++; }
  write(BM_KEY, bm);
  const h = read(HIST_KEY, []);
  const seenH = new Set(h.map(x => `${x.url}|${x.ts}`));
  const fresh = history.filter(x => !seenH.has(`${x.url}|${x.ts}`));
  write(HIST_KEY, h.concat(fresh).sort((a, b) => b.ts - a.ts).slice(0, 3000));
  render();
  return { bookmarks: added, history: fresh.length };
}

async function runImport(src, p, asNew) {
  if (!Object.values(importWhat).some(Boolean)) return toast("Choose what to import first");
  toast(`Importing from ${src.browser}…`, 30000);
  try {
    const r = await invoke("import_browser", { root: src.root, dir: p.dir, what: importWhat, asNew, name: p.name });
    if (asNew) return toast(`Created profile “${r.profile}”. Switching to it…`, 3000); // the new sidebar applies the rest
    const n = mergeImport(r);
    toast(`Imported ${plural(n.bookmarks, "bookmark")}, ${plural(n.history, "history item")} and ${plural(r.extensions.length, "extension")}`, 6000);
    refreshExtensions();
  } catch (e) {
    toast(`Import failed: ${errText(e)}`, 6000);
  }
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
    if (x && x.cancelled) { toast("Not added", 2000); renderExtensions(); return; } // the user said no in the review
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
  items.push({ label: "Import from Chrome…", fn: () => openPanel("import") });
  items.push({ label: "Settings…", fn: () => call("open_settings") });
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
  "import": () => openPanel("import"),
  "tools": () => call("toggle_tools"),
  "world-clock": () => call("open_tools", { tab: "clocks" }),
  "notes": () => call("open_tools", { tab: "notes" }),
  "markdown-open": () => window.Tools.markdown("open"),
  "markdown-new": () => window.Tools.markdown("new"),
  "markdown-folder": () => window.Tools.markdown("folder"),
  "pomodoro": () => window.Tools.pomodoro(),
  "focus-mode": () => window.Tools.focus(25),
  "end-focus": () => window.Tools.stopFocus(),
  "color-picker": () => window.Tools.colorPicker(),
  "download-images": () => window.Tools.images(),
  "copy-asin": () => window.Tools.asin(),
  "clean-link": () => window.Tools.cleanLink(),
  "download-video": () => downloadVideo("video"),
  "browse-extensions": browseStore,
  "new-space": newSpace,
  "pin-tab": () => { const t = activeTab(); if (t) togglePin(t.id); },
  "recent-tab": () => { const id = previousTab(); if (id) activate(id); },
  "tab-last": () => { const list = orderedTabs(); if (list.length) activate(list[list.length - 1].id); },
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map(n => [`tab-${n}`, () => { const t = orderedTabs()[n - 1]; if (t) activate(t.id); }])),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [`space-${n}`, () => { if (state.spaces[n - 1]) switchSpace(n - 1); }])),
  "next-space": () => stepSpace(1),
  "prev-space": () => stepSpace(-1),
  "split-recent": () => { const a = space().active, b = previousTab(); if (a && b) startSplit(b, a); else toast("Open another tab first"); },
  "exit-split": exitSplit,
  "pip": async () => {
    const t = activeTab();
    if (!t || !opened.has(t.id)) return;
    const r = await call("pip", { id: t.id });
    if (r === "none") toast("No video on this page");
    else if (r && String(r).startsWith("error")) toast("Picture in picture isn't available for this video");
  },
  "toggle-sponsorblock": () => setSponsorBlock(!sponsorBlock),
  "tidy-tabs": tidyTabs,
  "settings": () => call("open_settings"),
  "close-duplicates": closeDuplicates,
  "close-others": closeOthers,
  "close-below": closeBelow,
  "mute-tab": async () => {
    const t = activeTab();
    if (!t || !opened.has(t.id)) return;
    const m = await call("mute_tab", { id: t.id });
    toast(m ? "Tab muted" : "Tab unmuted");
  },
  "mute-all": () => { call("mute_all", { muted: true }); toast("All tabs muted"); },
  "unmute-all": () => { call("mute_all", { muted: false }); toast("All tabs unmuted"); },
  "force-dark": async () => {
    const t = activeTab();
    if (!t || !opened.has(t.id)) return;
    const r = await call("toggle_dark", { id: t.id });
    if (r) toast(r.on ? `Dark mode forced on ${r.host}` : `Forced dark mode off for ${r.host}`);
  },
  "new-group": () => { const t = activeTab(); if (t && !t.pinned && !t.groupId) newGroup(t.id); else newGroupWithTab(); },
};

listen("shortcut", e => actions[e.payload]?.());

listen("palette-action", ({ payload: p }) => {
  if (p.type === "tab") goToTab(p.id);
  else if (p.type === "url") openUrl(p.url, !!p.newTab);
  else if (p.type === "cmd") actions[p.id]?.();
  else if (p.type === "space") switchSpace(p.index);
  else if (p.type === "profile") call("switch_profile", { id: p.id });
  else if (p.type === "split") { const a = space().active; if (a) startSplit(a, p.id); }
  else if (p.type === "move") moveTabToSpace(p.index);
  else if (p.type === "reopen") reopenClosed(p.url);
  else if (p.type === "toast") toast(p.text);
});
// While the sidebar floats over a page, the app sends a small picture of the page under it for the glass.
// It also says how bright that part of the page is: over a bright page the glass turns light with dark text,
// over a dark one it stays dark with light text (with some hysteresis, so it doesn't flicker around the middle).
let glassLight = false;
listen("glass-backdrop", ({ payload }) => {
  $("glass-img").style.backgroundImage = `url(${payload.url})`;
  if (glassLight ? payload.lum < 0.42 : payload.lum > 0.58) glassLight = !glassLight;
  document.body.classList.toggle("on-light", glassLight);
  document.body.classList.toggle("on-dark", !glassLight);
});
listen("toast", ({ payload }) => toast(payload.text, payload.ms || 1600));
listen("tab-audio", ({ payload: p }) => { audio.set(p.id, { audible: p.audible, muted: p.muted }); render(); });

listen("new-tab-request", ({ payload }) => {
  if (payload.background) { backgroundTab(payload.url, payload.from); toast("Opened in background", 1500); }
  else newTab(payload.url, payload.from);
});
listen("split-request", ({ payload }) => {
  const t = backgroundTab(payload.url);
  startSplit(payload.with, t.id);
});
// Clicking into a split pane makes it the active tab (address bar, back/forward follow it).
listen("tab-focused", ({ payload }) => {
  const s = space();
  if (s.split && inSplit(payload.id) && s.active !== payload.id) { s.active = payload.id; noteRecent(payload.id); render(); }
});
listen("split-ratio", ({ payload }) => { if (space().split) space().split.ratio = payload.ratio; });

listen("sidebar-state", ({ payload: p }) => {
  document.body.classList.toggle("overlay", p.floating ?? (p.collapsed && p.peek));
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
$("new-group").addEventListener("click", () => newGroupWithTab());
$("space-title").addEventListener("dblclick", () => spaceInput(state.space, "name"));
$("space-title").addEventListener("contextmenu", e => { e.preventDefault(); spaceMenu(state.space, e.clientX, e.clientY); });
$("new-space").addEventListener("click", newSpace);
for (const a of ["back", "forward", "reload"]) $(a).addEventListener("click", () => navAction(a));
$("yt-video").addEventListener("click", () => downloadVideo("video"));
$("yt-audio").addEventListener("click", () => downloadVideo("audio"));
$("open-library").addEventListener("click", e => {
  e.stopPropagation();
  const r = $("open-library").getBoundingClientRect();
  showMenu(r.left, r.top - 6 * 32 - 14, [
    { label: "Bookmarks", fn: () => openPanel("bookmarks") },
    { label: "History", fn: () => openPanel("history") },
    { label: "Downloads", fn: () => openPanel("downloads") },
    { label: "Extensions", fn: () => openPanel("extensions") },
    { label: "Screenshot…", fn: () => setTimeout(screenshotMenu, 0) },
    { label: "Import from browser…", fn: () => openPanel("import") },
    { label: "Settings…", fn: () => call("open_settings") },
  ]);
});
$("open-palette").addEventListener("click", () => call("show_palette"));

// Drag handle (the window has no native title bar; Windows draws its buttons in ui/caption.html).
$("topbar").addEventListener("mousedown", e => { if (e.button === 0 && !e.target.closest("button")) call("drag_start"); });
$("topbar").addEventListener("dblclick", e => { if (!e.target.closest("button")) call("window_action", { action: "maximize" }); });
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

let sponsorBlock = true;
async function setSponsorBlock(on) {
  sponsorBlock = on;
  await call("set_sponsorblock", { enabled: on });
  toast(on ? "Sponsor segments will be skipped" : "Sponsor skipping off");
  navAction("reload");
}
let sitePerms = []; // remembered permissions for the current site, loaded when the shield opens

$("shield").addEventListener("mousedown", async () => {
  const t = activeTab();
  sitePerms = (t && (await call("site_permissions", { url: t.url }))) || [];
});
$("shield").addEventListener("click", e => {
  e.stopPropagation();
  const t = activeTab();
  const n = (t && blocked.get(t.id)) || 0;
  const rect = $("shield").getBoundingClientRect();
  const host = t ? hostOf(t.url) : "";
  const here = host && siteOff(host);
  const items = [];
  if (t) {
    items.push({ label: isBookmarked(t.url) ? "Remove bookmark" : "Bookmark this page", fn: toggleBookmark });
    items.push({ label: "Copy link", fn: () => navigator.clipboard.writeText(t.url).then(() => toast("Link copied")) });
  }
  items.push({ label: !adblock ? "Ad blocker is off" : here ? `Ad blocker is off on ${host}` : `Ad blocker is on · ${n} blocked here`, fn: () => {} });
  if (adblock && host) {
    items.push({ label: here ? `Turn on for ${host}` : `Turn off for ${host}`, fn: () => setSiteAllowed(host, !here) });
  }
  items.push(adblock ? { label: "Turn off for all sites", fn: () => setAdblock(false) } : { label: "Turn on", fn: () => setAdblock(true) });
  if (/(^|\.)youtube\.com$/.test(host)) {
    items.push({ label: `Skip sponsor segments: ${sponsorBlock ? "On" : "Off"}`, fn: () => setSponsorBlock(!sponsorBlock) });
  }
  if (t && sitePerms.length) {
    items.push({ label: `Reset permissions for ${host} (${sitePerms.length})`, fn: async () => {
      await call("reset_site_permissions", { url: t.url });
      toast(`Permissions reset for ${host}`);
    } });
  }
  showMenu(Math.max(rect.right - 230, 8), rect.bottom + 6, items);
});

// While typing, keep a peeking sidebar on screen even if the pointer wanders off.
for (const id of ["addr", "find-input", "panel-search"]) {
  $(id).addEventListener("focus", () => call("sidebar_busy", { busy: true }));
  $(id).addEventListener("blur", () => call("sidebar_busy", { busy: false }));
}

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
  $(id).addEventListener("drop", e => { e.preventDefault(); if (dragId) moveTab(dragId, null, { pinned }); });
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
  sponsorBlock = s.sponsorBlock !== false;
  document.body.classList.toggle("collapsed", s.collapsed);
  $("toggle-sidebar").title = s.collapsed ? "Show sidebar" : "Hide sidebar";
  renderChrome();
});
loadProfiles();
refreshExtensions();
listen("settings-changed", ({ payload }) => { applyAppSettings(payload); render(); renderPanel(); });
// Startup preference (once per app launch): a new tab or a chosen page on top of the restored tabs.
call("get_app_settings").then(async s => {
  if (!s) return;
  applyAppSettings(s);
  render();
  const start = await call("take_startup");
  if (start && start.mode === "newtab") newTab();
  else if (start && start.mode === "custom" && start.url) newTab(start.url);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderChrome); // follow system light/dark
// A profile created by "Import … as new profile" receives its bookmarks and history here.
call("take_pending_import").then(d => {
  if (!d) return;
  const n = mergeImport(d);
  toast(`Imported ${plural(n.bookmarks, "bookmark")} and ${plural(n.history, "history item")}`, 5000);
});
refreshVideoTools();

// Restore: reopen the active tab of the current space; other tabs open lazily.
renderPanel();
activate(space().active && activeTab() ? space().active : null).then(() => {
  if (!space().tabs.length) newTab();
});
