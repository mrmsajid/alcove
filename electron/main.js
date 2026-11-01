const {
  app, BaseWindow, WebContentsView, Menu, ipcMain, shell, session, screen, nativeTheme, clipboard, ClipboardItem, dialog, net, nativeImage, systemPreferences,
} = require("electron");
const AdmZip = require("adm-zip");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SIDEBAR_W = 280;
const PRELOAD = path.join(__dirname, "preload.js");
const COLORS = ["#7c8cff", "#ff7c9c", "#5fd6a0", "#ffb86b", "#c27cff"];
const uiFile = name => path.join(__dirname, "ui", name);

// Development and test runs keep their own data so they never touch an installed Alcove's
// tabs, cookies or settings (two processes sharing one profile block each other's storage).
if (process.env.ALCOVE_USER_DATA) app.setPath("userData", process.env.ALCOVE_USER_DATA);
else if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "Alcove Dev"));

// One Alcove per profile folder: a second launch focuses the existing window instead.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) app.quit();
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Startup timing marks, printed only when ALCOVE_PERF=1.
const perf = label => { if (process.env.ALCOVE_PERF === "1") console.log(`[perf] ${Math.round(performance.now())}ms ${label}`); };

// ---- config (profiles + settings) ----

let config = {
  collapsed: false,
  adblock: true,
  adblockAllow: [], // hostnames where the blocker is off
  sponsorBlock: true, // skip sponsor segments on YouTube
  sitePermissions: {}, // "origin permission" -> allowed (true/false), for remembered choices
  forceDark: [], // hostnames shown with a forced dark theme
  activeProfile: "default",
  profiles: [{ id: "default", name: "Default", color: COLORS[0] }],
};
const configPath = () => path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) }; } catch {}
  if (!config.profiles.some(p => p.id === config.activeProfile)) config.activeProfile = "default";
}
function saveConfig() {
  try { fs.writeFileSync(configPath(), JSON.stringify(config, null, 2)); } catch {}
}

// Each profile gets its own cookie jar (web) and its own sidebar storage (ui: tabs, bookmarks, history).
// The default profile keeps the original partitions so existing data carries over.
const webPartition = id => (id === "default" ? "persist:alcove" : `persist:web-${id}`);
const uiPartition = id => (id === "default" ? undefined : `persist:ui-${id}`);

// ---- state ----

let win;
let ui;
let palette = null;
const tabs = new Map();      // tab id -> WebContentsView
const wcToTab = new Map();   // webContents id -> tab id
const lastFind = new Map();
const blocked = new Map();   // tab id -> blocked request count
const knownSessions = new Set();
let blocker = null;
let blockerReady = Promise.resolve();

let collapsed = false;
let peeking = false;
let sidebarBusy = false;
let sidebarX = 0;       // x of the sidebar view; negative while hidden
let contentLeft = SIDEBAR_W; // x where web content starts; animates with the sidebar
let animTimer = null;
let peekHoldUntil = 0; // keeps the startup peek on screen briefly
let dragTimer = null;

const send = (name, payload) => {
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send("event", name, payload);
};

// ---- layout / sliding sidebar ----

// Web pages sit in a rounded card with a small gap on every side. With the sidebar hidden, the card
// leaves a slim strip at the top for the window buttons, which doubles as a drag handle.
const GAP = 8;
const HIDE_X = -(SIDEBAR_W + GAP + 4); // sidebar x when hidden (fully off screen)
let uiRadius = -1;
const STRIP_H = 34;
const CARD_RADIUS = 10;

function contentRect() {
  const { width, height } = win.getContentBounds();
  const hidden = 1 - Math.min(1, Math.max(0, contentLeft / SIDEBAR_W)); // 0 = sidebar shown, 1 = hidden (animates)
  const x = Math.round(contentLeft + GAP * hidden);
  const y = Math.round(GAP + (STRIP_H - GAP) * hidden);
  return { x, y, w: Math.max(width - x - GAP, 1), h: Math.max(height - y - GAP, 1), hidden, width };
}

function layout() {
  const { height } = win.getContentBounds();
  // Docked: flush with the window. Sliding out over the page (sidebar collapsed): a floating rounded panel.
  const floating = collapsed;
  ui.setBounds(floating
    ? { x: Math.round(sidebarX) + GAP, y: GAP, width: SIDEBAR_W, height: height - 2 * GAP }
    : { x: Math.round(sidebarX), y: 0, width: SIDEBAR_W, height });
  const radius = floating ? 14 : 0;
  if (radius !== uiRadius && typeof ui.setBorderRadius === "function") { ui.setBorderRadius(radius); uiRadius = radius; }
  const c = contentRect();
  const lw = split ? Math.round((c.w - DIVIDER_W) * split.ratio) : 0;
  for (const [k, v] of tabs) {
    if (split && k === split.left) v.setBounds({ x: c.x, y: c.y, width: lw, height: c.h });
    else if (split && k === split.right) v.setBounds({ x: c.x + lw + DIVIDER_W, y: c.y, width: c.w - lw - DIVIDER_W, height: c.h });
    else v.setBounds({ x: c.x, y: c.y, width: c.w, height: c.h });
  }
  if (divider && split) {
    // While dragging, the divider covers both panes so it keeps receiving the mouse.
    divider.setBounds(dividerDragging ? { x: c.x, y: c.y, width: c.w, height: c.h } : { x: c.x + lw, y: c.y, width: DIVIDER_W, height: c.h });
  }
  if (strip) {
    strip.setVisible(c.hidden > 0.5);
    strip.setBounds({ x: 0, y: 0, width: c.width, height: STRIP_H });
  }
  placePeek();
  placeShotPopup();
}

// Top strip shown while the sidebar is hidden: drag to move the window, double-click to zoom,
// and on Windows it carries the window buttons (macOS draws its own there).
let strip = null;
function createStrip() {
  strip = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  strip.setBackgroundColor("#00000000");
  strip.webContents.loadFile(uiFile("strip.html"));
  win.contentView.addChildView(strip);
  layout();
}

const raiseUi = () => win.contentView.addChildView(ui); // re-adding moves a view to the top

// Slides the sidebar and the page edge together so content glides instead of jumping.
function animate(toX, toLeft, ms = 200) {
  clearInterval(animTimer);
  const fromX = sidebarX;
  const fromLeft = contentLeft;
  const start = Date.now();
  animTimer = setInterval(() => {
    const t = Math.min((Date.now() - start) / ms, 1);
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
    sidebarX = fromX + (toX - fromX) * e;
    contentLeft = fromLeft + (toLeft - fromLeft) * e;
    layout();
    if (t === 1) clearInterval(animTimer);
  }, 16);
}

const sidebarState = () => send("sidebar-state", { collapsed, peek: peeking });

function peek(on) {
  if (!collapsed || peeking === on) return;
  peeking = on;
  if (on) raiseUi();
  animate(on ? 0 : HIDE_X, contentLeft, 180);
  sidebarState();
}

// With the sidebar collapsed, a blank page would leave no visible controls at all, so on launch the
// sidebar slides in for a moment to show where it lives.
function introPeek() {
  if (!collapsed) return;
  peekHoldUntil = Date.now() + 1600;
  peek(true);
  setTimeout(() => {
    if (!collapsed || !peeking || sidebarBusy || !win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getContentBounds();
    const over = p.x >= b.x && p.x < b.x + SIDEBAR_W + 12 && p.y >= b.y && p.y < b.y + b.height;
    if (!over) peek(false);
  }, 1700);
}

function toggleSidebar() {
  collapsed = !collapsed;
  config.collapsed = collapsed;
  saveConfig();
  peeking = false;
  if (collapsed) raiseUi();
  animate(collapsed ? HIDE_X : 0, collapsed ? 0 : SIDEBAR_W, 240);
  sidebarState();
}

// Cursor polling is simpler and more reliable than a transparent hot-zone view over the page.
function watchCursor() {
  setInterval(() => {
    if (extPopup) {
      if (extPopup.webContents.isFocused()) extPopupFocused = true;
      else if (extPopupFocused) closeExtPopup();
    }
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getContentBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    const rel = p.x - b.x;
    if (!win.isFocused()) return;
    if (!collapsed) return;
    if (!peeking && inside && rel <= 3) peek(true);
    else if (peeking && !sidebarBusy && Date.now() > peekHoldUntil && (!inside || rel > SIDEBAR_W + 12)) peek(false);
  }, 50);
}

// Frameless window: the sidebar's top strip acts as the title bar.
function startDrag() {
  if (win.isMaximized() || win.isFullScreen()) return;
  const start = screen.getCursorScreenPoint();
  const [x0, y0] = win.getPosition();
  clearInterval(dragTimer);
  const began = Date.now();
  dragTimer = setInterval(() => {
    if (Date.now() - began > 15000) return clearInterval(dragTimer); // failsafe if mouseup is missed
    const p = screen.getCursorScreenPoint();
    win.setPosition(x0 + p.x - start.x, y0 + p.y - start.y);
  }, 8);
}

function windowAction(action) {
  if (action === "close") win.close();
  else if (action === "minimize") win.minimize();
  else if (action === "maximize") {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
}

// ---- sessions, downloads, ad blocker ----

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let n = 1; ; n++) {
    const c = path.join(dir, `${name} (${n})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
}

const COSMETIC_CHANNELS = [
  "@ghostery/adblocker/inject-cosmetic-filters",
  "@ghostery/adblocker/is-mutation-observer-enabled",
];

const adStats = { cosmeticCalls: 0, observerChecks: 0 };

const YT_PAGE = /^https:\/\/(?:www\.|m\.|music\.)?youtube\.com\//;

// Requests from YouTube's service worker aren't tied to a tab, so they're matched by who started them.
// Blocking one of YouTube's ad requests leaves the player waiting on an ad that never arrives.
function startedByYouTube(details) {
  if (YT_PAGE.test(details.referrer || "")) return true;
  try { return !!details.frame && YT_PAGE.test(details.frame.url || ""); } catch { return false; }
}

// The user switched the blocker off for this site.
function userAllowed(wc) {
  try {
    const host = new URL(wc.getURL()).hostname.replace(/^www\./, "");
    return config.adblockAllow.some(d => host === d || host.endsWith(`.${d}`));
  } catch { return false; }
}

// YouTube answers stripped ad data by holding the player in a black "ad" state for the full ad
// length, so on YouTube we don't strip; instead the page skips ads as they start (see below).
function siteAllowed(wc) {
  try { return userAllowed(wc) || YT_PAGE.test(wc.getURL()); } catch { return false; }
}

const YT_HIDE_CSS = `
  ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-sparkles-web-renderer,
  ytd-display-ad-renderer, ytd-companion-slot-renderer, ytd-action-companion-ad-renderer,
  ytd-banner-promo-renderer, ytd-statement-banner-renderer, ytd-merch-shelf-renderer,
  #player-ads, #masthead-ad, .ytp-ad-overlay-container, .ytp-featured-product,
  ytd-player-legacy-desktop-watch-ads-renderer, ytd-promoted-video-renderer, ytd-compact-promoted-video-renderer,
  ytd-search-pyv-renderer, ytd-ads-engagement-panel-content-renderer,
  ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
  ytd-engagement-panel-section-list-renderer:has(ytd-ads-engagement-panel-content-renderer, ad-badge-view-model),
  ytd-rich-item-renderer:has(ytd-ad-slot-renderer, ad-badge-view-model),
  ytd-item-section-renderer:has(> #contents > ytd-ad-slot-renderer),
  yt-lockup-view-model:has(ad-badge-view-model), #shopping-timely-shelf, yt-overlay-product-sticker { display: none !important; }
  /* While an ad is being skipped, show the video's own thumbnail (set by the page script) so it
     looks like the video is just loading. */
  #movie_player.ad-showing:not([data-alcove-stuck]) video, #movie_player.ad-interrupting:not([data-alcove-stuck]) video { opacity: 0 !important; }
  .alcove-sb {
    position: absolute; left: 16px; bottom: 72px; z-index: 70; pointer-events: none; padding: 6px 11px; border-radius: 8px;
    background: rgba(0, 0, 0, .72); color: #fff; font: 500 13px -apple-system, "Segoe UI", sans-serif;
  }
  #movie_player.ad-showing:not([data-alcove-stuck])::after, #movie_player.ad-interrupting:not([data-alcove-stuck])::after {
    content: ""; position: absolute; inset: 0; z-index: 2147483647; pointer-events: none;
    background: #000; background-image: var(--alcove-thumb, none); background-size: cover; background-position: center;
  }
`;

// The ad removal and the backup skipper run inside the page; see yt-preload.js.

// When a YouTube ad state lasts too long, the page reports what the player was doing. Kept small and
// local (Alcove's data folder) so a stuck case can be diagnosed afterwards.
ipcMain.on("alcove-yt-diag", (_e, info) => {
  const entry = { at: new Date().toISOString(), ...info, recentBlocks: recentBlocks.filter(b => Date.now() - b.t < 30000) };
  const file = path.join(app.getPath("userData"), "yt-diagnostics.log");
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 200000) fs.rmSync(file);
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {}
});

// The web session's early page script asks whether to run YouTube mode on this host.
// SponsorBlock (community-marked sponsor segments). The lookup sends only the first 4 hex characters
// of the video ID's SHA-256, so the service can't tell which video is being watched.
const sponsorCache = new Map();
ipcMain.handle("alcove-sb", async (_e, videoId) => {
  const id = String(videoId);
  if (!config.sponsorBlock || !/^[\w-]{11}$/.test(id)) return [];
  if (sponsorCache.has(id)) return sponsorCache.get(id);
  const prefix = require("crypto").createHash("sha256").update(id).digest("hex").slice(0, 4);
  const cats = encodeURIComponent(JSON.stringify(["sponsor", "selfpromo", "interaction"]));
  try {
    const res = await net.fetch(`https://sponsor.ajay.app/api/skipSegments/${prefix}?categories=${cats}`);
    const list = res.ok ? await res.json() : [];
    const hit = Array.isArray(list) ? list.find(x => x.videoID === id) : null;
    const segs = hit ? hit.segments
      .filter(x => !x.actionType || x.actionType === "skip")
      .map(x => ({ start: x.segment[0], end: x.segment[1], category: x.category })) : [];
    sponsorCache.set(id, segs);
    if (sponsorCache.size > 200) sponsorCache.delete(sponsorCache.keys().next().value);
    return segs;
  } catch { return []; }
});

ipcMain.on("alcove-yt-mode", (e, host) => {
  const h = String(host).replace(/^www\./, "");
  const off = !config.adblock || config.adblockAllow.some(d => h === d || h.endsWith(`.${d}`));
  e.returnValue = off ? null : { css: YT_HIDE_CSS, sponsor: config.sponsorBlock };
});

// Fallback styling for pages where the early script didn't run (safe to apply twice).
function applyYouTubeMode(wc) {
  if (!config.adblock || userAllowed(wc)) return;
  wc.insertCSS(YT_HIDE_CSS).catch(() => {});
}

// Replaces the blocker's own handlers so we can (1) skip sites the user turned the blocker off for and
// (2) stop the page's DOM observer from messaging us on every change, which is very costly on busy
// pages like YouTube. Page-specific rules and scripts still apply.
function installBlockerHooks(ses) {
  const [inject, observer] = COSMETIC_CHANNELS;
  ipcMain.removeHandler(inject);
  ipcMain.removeHandler(observer);
  ipcMain.handle(inject, (event, url, msg) => {
    adStats.cosmeticCalls++;
    return siteAllowed(event.sender) ? undefined : blocker.onInjectCosmeticFilters(event, url, msg);
  });
  ipcMain.handle(observer, () => {
    adStats.observerChecks++;
    return process.env.ALCOVE_DOM_OBSERVER === "1"; // env switch is for measuring only
  });
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if ((details.webContents && siteAllowed(details.webContents)) || startedByYouTube(details)) callback({});
    else blocker.onBeforeRequest(details, callback);
  });
}

// Only the active profile's web session is filtered. The blocker registers global IPC
// handlers per session, so it can only be enabled on one session at a time.
function applyBlocking() {
  if (!blocker) return;
  const active = session.fromPartition(webPartition(config.activeProfile));
  try {
    for (const ses of knownSessions) {
      const want = config.adblock && ses === active;
      if (blocker.isBlockingEnabled(ses) && !want) blocker.disableBlockingInSession(ses);
    }
    if (config.adblock && !blocker.isBlockingEnabled(active)) {
      for (const ch of COSMETIC_CHANNELS) ipcMain.removeHandler(ch);
      blocker.enableBlockingInSession(active);
      installBlockerHooks(active);
    }
  } catch (e) { console.error("ad blocker:", e.message); }
}

// ---- site permissions: ask once per site, remember the answer ----

const ALWAYS_ALLOWED = ["fullscreen", "clipboard-sanitized-write", "pointerLock"];
const ASKABLE = {
  media: "use your camera or microphone",
  geolocation: "know your location",
  notifications: "show notifications",
  "clipboard-read": "read what you copy",
};
const permKey = (origin, permission) => `${origin} ${permission}`;

function permissionText(permission, details) {
  if (permission === "media") {
    const t = details.mediaTypes || [];
    if (t.includes("video") && t.includes("audio")) return "use your camera and microphone";
    if (t.includes("video")) return "use your camera";
    if (t.includes("audio")) return "use your microphone";
  }
  return ASKABLE[permission];
}

async function askPermission(wc, permission, details) {
  let origin;
  try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch { return false; }
  const key = permKey(origin, permission);
  if (key in config.sitePermissions) return config.sitePermissions[key];
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Allow", "Block"],
    defaultId: 0,
    cancelId: 1,
    message: `${new URL(origin).host} wants to ${permissionText(permission, details)}`,
    checkboxLabel: "Remember for this site",
    checkboxChecked: true,
  });
  const ok = response === 0;
  if (checkboxChecked) { config.sitePermissions[key] = ok; saveConfig(); }
  // macOS also asks once per app before a site can use the camera or microphone.
  if (ok && permission === "media" && process.platform === "darwin") {
    for (const t of details.mediaTypes || []) {
      const kind = t === "video" ? "camera" : "microphone";
      if (systemPreferences.getMediaAccessStatus(kind) !== "granted") await systemPreferences.askForMediaAccess(kind);
    }
  }
  return ok;
}

function ensureSession(profileId) {
  const ses = session.fromPartition(webPartition(profileId));
  if (knownSessions.has(ses)) return ses;
  knownSessions.add(ses);
  // Some sites refuse to work when the UA names Electron.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|alcove|Alcove)\/\S+/gi, ""));
  // Camera, mic, location, notifications etc. stay denied until the app has a permission prompt.
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (ALWAYS_ALLOWED.includes(permission)) return cb(true);
    if (!ASKABLE[permission]) return cb(false);
    askPermission(wc, permission, details).then(cb, () => cb(false));
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (!ASKABLE[permission]) return true;
    let o; try { o = new URL(origin).origin; } catch { return false; } // Electron passes it with a trailing slash
    return config.sitePermissions[permKey(o, permission)] === true;
  });
  try {
    ses.registerPreloadScript({ type: "frame", filePath: path.join(__dirname, "yt-preload.js") });
  } catch (e) { console.error("youtube preload:", e.message); }
  ses.on("will-download", (_e, item) => {
    const dest = uniquePath(path.join(app.getPath("downloads"), item.getFilename()));
    item.setSavePath(dest);
    const url = item.getURL();
    send("download", { state: "started", url, path: dest });
    item.once("done", (_ev, state) =>
      send("download", { state: state === "completed" ? "done" : "failed", url, path: dest }));
  });
  loadProfileExtensions(profileId, ses);
  return ses;
}

const dirtyBlocked = new Set();
let flushTimer = null;
const recentBlocks = []; // last few blocked requests, for the YouTube diagnostic log

function onBlocked(request) {
  recentBlocks.push({ t: Date.now(), url: String(request.url).slice(0, 160), from: String(request.sourceUrl || "").slice(0, 80), type: request.type });
  if (recentBlocks.length > 40) recentBlocks.shift();
  const id = wcToTab.get(request.tabId);
  if (!id) return;
  blocked.set(id, (blocked.get(id) || 0) + 1);
  dirtyBlocked.add(id);
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    for (const d of dirtyBlocked) send("tab-blocked", { id: d, count: blocked.get(d) || 0 });
    dirtyBlocked.clear();
  }, 250);
}

const ENGINE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function initBlocker() {
  perf("blocker: start");
  try {
    // Rules go stale quickly (YouTube changes its ads often), so rebuild the cached engine daily.
    const cache = path.join(app.getPath("userData"), "adblock-engine.bin");
    try {
      if (Date.now() - fs.statSync(cache).mtimeMs > ENGINE_MAX_AGE_MS) fs.rmSync(cache);
    } catch {}
    const { ElectronBlocker } = require("@ghostery/adblocker-electron");
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: path.join(app.getPath("userData"), "adblock-engine.bin"),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    perf("blocker: engine loaded");
    blocker.on("request-blocked", onBlocked);
    applyBlocking();
    perf("blocker: ready");
  } catch (e) {
    console.error("ad blocker unavailable:", e.message);
  }
}

// ---- tabs ----

function openTab(id, url) {
  const view = new WebContentsView({
    webPreferences: {
      partition: webPartition(config.activeProfile),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  if (typeof view.setBorderRadius === "function") view.setBorderRadius(CARD_RADIUS);
  const wc = view.webContents;
  tabs.set(id, view);
  wcToTab.set(wc.id, id);
  win.contentView.addChildView(view);
  if (collapsed) raiseUi();
  layout();
  wc.on("did-start-navigation", d => {
    if (d.isMainFrame && !d.isSameDocument) {
      blocked.set(id, 0);
      send("tab-blocked", { id, count: 0 });
    }
  });
  wc.on("dom-ready", () => {
    const u = wc.getURL();
    if (STORE_URL.test(u)) injectStoreFixes(wc);
    if (YT_PAGE.test(u)) applyYouTubeMode(wc);
    if (config.forceDark.includes(hostKey(u))) applyDark(wc, true);
  });
  wc.on("console-message", (e, _level, legacyMessage) => {
    const message = typeof e.message === "string" ? e.message : legacyMessage;
    if (message === STORE_MARK && STORE_URL.test(wc.getURL())) send("store-install", { id, url: wc.getURL() });
  });
  wc.on("did-navigate", (_e, u) => send("tab-url", { id, url: u }));
  wc.on("did-navigate-in-page", (_e, u, isMainFrame) => { if (isMainFrame) send("tab-url", { id, url: u }); });
  wc.on("page-title-updated", (_e, title) => send("tab-title", { id, title }));
  // Cmd/Ctrl+click opens a background tab; Shift+click (a featureless new window) opens Peek.
  // Popups that ask for a size (sign-in windows, for example) still become normal tabs.
  wc.setWindowOpenHandler(({ url: u, disposition, features }) => {
    if (disposition === "background-tab") send("new-tab-request", { url: u, background: true, from: id });
    else if (disposition === "new-window" && !features) openPeek(u);
    else send("new-tab-request", { url: u, from: id });
    return { action: "deny" };
  });
  wc.on("context-menu", (_e, p) => pageMenu(id, wc, p).popup());
  wc.on("audio-state-changed", e => send("tab-audio", { id, audible: typeof e.audible === "boolean" ? e.audible : wc.isCurrentlyAudible(), muted: wc.isAudioMuted() }));
  wc.on("focus", () => send("tab-focused", { id })); // tells the sidebar which split pane is active
  showOnly(id);
  // Give the ad blocker a moment to load its rules so the first page is filtered too.
  perf(`tab ${id}: created`);
  wc.once("did-finish-load", () => perf(`tab ${id}: did-finish-load`));
  Promise.race([blockerReady, sleep(3000)]).then(() => {
    perf(`tab ${id}: loadURL`);
    if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {}); // aborted loads (redirects) reject
  });
}

function showOnly(id) {
  for (const [k, v] of tabs) v.setVisible(split ? k === split.left || k === split.right : k === id);
}

// ---- split view ----

let split = null;           // { left, right, ratio }: two tab ids shown side by side
let divider = null;         // thin view between the panes
let dividerDragging = false;
const DIVIDER_W = 8;

function setSplit(next) {
  split = next && next.left !== next.right && tabs.has(next.left) && tabs.has(next.right)
    ? { left: next.left, right: next.right, ratio: Math.min(0.8, Math.max(0.2, Number(next.ratio) || 0.5)) }
    : null;
  if (split && !divider) {
    divider = new WebContentsView({
      webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, partition: uiPartition(config.activeProfile) },
    });
    divider.setBackgroundColor("#00000000");
    divider.webContents.loadFile(uiFile("divider.html"));
  } else if (!split && divider) {
    win.contentView.removeChildView(divider);
    divider.webContents.close();
    divider = null;
    dividerDragging = false;
  }
  if (divider) win.contentView.addChildView(divider); // keep it above the panes
  if (split) showOnly();
  layout();
}

// ---- peek: links opened in a floating preview over the current page ----

let peekView = null;          // the previewed page
let peekBackdrop = null;  // dimmed layer behind it with the Open/Close controls

function placePeek() {
  if (!peekView) return;
  const c = contentRect();
  peekBackdrop.setBounds({ x: c.x, y: c.y, width: c.w, height: c.h });
  const pw = Math.round(Math.min(c.w - 48, Math.max(c.w * 0.84, 360)));
  peekView.setBounds({ x: c.x + Math.round((c.w - pw) / 2), y: c.y + 48, width: Math.max(pw, 200), height: Math.max(c.h - 68, 200) });
}

const peekInfo = info => { if (peekBackdrop) peekBackdrop.webContents.send("event", "peek-info", info); };

function openPeek(url) {
  closePeek();
  peekBackdrop = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, partition: uiPartition(config.activeProfile) },
  });
  peekBackdrop.setBackgroundColor("#00000000");
  peekView = new WebContentsView({
    webPreferences: { partition: webPartition(config.activeProfile), sandbox: true, contextIsolation: true },
  });
  if (typeof peekView.setBorderRadius === "function") peekView.setBorderRadius(CARD_RADIUS + 2);
  win.contentView.addChildView(peekBackdrop);
  win.contentView.addChildView(peekView);
  placePeek();
  peekBackdrop.webContents.loadFile(uiFile("peek.html")).then(() => peekInfo({ url })).catch(() => {});
  const pwc = peekView.webContents;
  pwc.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "Escape") { e.preventDefault(); closePeek(); }
    else if (input.key === "Enter" && (input.meta || input.control)) { e.preventDefault(); peekToTab(); }
  });
  pwc.on("did-navigate", (_e, u) => peekInfo({ url: u }));
  pwc.on("page-title-updated", (_e, title) => peekInfo({ url: pwc.getURL(), title }));
  pwc.setWindowOpenHandler(({ url: u }) => { send("new-tab-request", { url: u }); return { action: "deny" }; });
  pwc.on("context-menu", (_e, p) => pageMenu(null, pwc, p).popup());
  pwc.loadURL(url).catch(() => {});
  pwc.focus();
}

function closePeek() {
  for (const v of [peekView, peekBackdrop]) {
    if (!v) continue;
    win.contentView.removeChildView(v);
    v.webContents.close();
  }
  peekView = peekBackdrop = null;
}

function peekToTab() {
  if (!peekView) return;
  const url = peekView.webContents.getURL();
  closePeek();
  send("new-tab-request", { url });
}

// ---- forced dark mode for sites without one ----

const DARK_CSS = `
  html { filter: invert(.92) hue-rotate(180deg) !important; background: #fff !important; }
  img, video, picture, canvas, iframe, embed, object, [style*="background-image"] { filter: invert(1) hue-rotate(180deg) !important; }
`;
const darkKeys = new WeakMap(); // webContents -> inserted CSS key
const hostKey = url => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

async function applyDark(wc, on) {
  const key = darkKeys.get(wc);
  if (key) { await wc.removeInsertedCSS(key).catch(() => {}); darkKeys.delete(wc); }
  if (on) darkKeys.set(wc, await wc.insertCSS(DARK_CSS).catch(() => null));
}

// ---- picture in picture ----

// Picks the playing (or largest) video on the page; a user gesture is required, which executeJavaScript can grant.
function pictureInPicture(wc) {
  if (!wc) return Promise.resolve("none");
  return wc.executeJavaScript(`(async () => {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return "closed"; }
    const vids = [...document.querySelectorAll("video")].filter(v => v.readyState > 0);
    const v = vids.find(x => !x.paused) || vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
    if (!v) return "none";
    v.disablePictureInPicture = false;
    await v.requestPictureInPicture();
    return "opened";
  })()`, true).catch(e => `error: ${e.message}`);
}

// ---- page right-click menu ----

function pageMenu(tabId, wc, p) {
  const items = [];
  const sep = () => { if (items.length && items[items.length - 1].type !== "separator") items.push({ type: "separator" }); };
  if (p.linkURL && /^https?:/i.test(p.linkURL)) {
    items.push(
      { label: "Open Link in New Tab", click: () => send("new-tab-request", { url: p.linkURL, from: tabId }) },
      { label: "Open Link in Background", click: () => send("new-tab-request", { url: p.linkURL, background: true, from: tabId }) },
      { label: "Open Link in Peek", click: () => openPeek(p.linkURL) },
      ...(tabId ? [{ label: "Open Link in Split View", click: () => send("split-request", { url: p.linkURL, with: tabId }) }] : []),
      { label: "Copy Link Address", click: () => clipboard.writeText(p.linkURL) },
    );
    sep();
  }
  if (p.mediaType === "image" && p.srcURL) {
    items.push(
      { label: "Open Image in New Tab", click: () => send("new-tab-request", { url: p.srcURL }) },
      { label: "Save Image", click: () => wc.downloadURL(p.srcURL) },
      { label: "Copy Image", click: () => wc.copyImageAt(p.x, p.y) },
      { label: "Copy Image Address", click: () => clipboard.writeText(p.srcURL) },
    );
    sep();
  }
  if (p.mediaType === "video") {
    items.push({ label: "Picture in Picture", click: () => pictureInPicture(wc) });
    sep();
  }
  const text = (p.selectionText || "").trim();
  if (p.isEditable) {
    items.push({ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" });
    sep();
  } else if (text) {
    const short = text.length > 28 ? `${text.slice(0, 28)}…` : text;
    items.push(
      { role: "copy" },
      { label: `Search for “${short}”`, click: () => send("new-tab-request", { url: `https://duckduckgo.com/?q=${encodeURIComponent(text)}` }) },
    );
    sep();
  }
  if (!p.linkURL && p.mediaType === "none" && !p.isEditable && !text) {
    items.push(
      { label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: "Reload", click: () => wc.reload() },
    );
    sep();
    if (tabId) items.push({ label: "Take Screenshot…", click: () => send("shortcut", "screenshot-region") });
    items.push({ label: "View Page Source", click: () => send("new-tab-request", { url: `view-source:${wc.getURL()}` }) });
  }
  sep();
  items.push({ label: "Inspect", click: () => { wc.openDevTools({ mode: "detach" }); wc.inspectElement(p.x, p.y); } });
  return Menu.buildFromTemplate(items);
}

function closeTab(id) {
  const v = tabs.get(id);
  if (!v) return;
  if (split && (split.left === id || split.right === id)) setSplit(null);
  win.contentView.removeChildView(v);
  wcToTab.delete(v.webContents.id);
  v.webContents.close();
  tabs.delete(id);
  lastFind.delete(id);
  blocked.delete(id);
}

// ---- screenshots ----

// "full" captures the whole scrollable page through the DevTools protocol (capped for huge pages).
async function screenshot(id, mode) {
  const wc = wcOf(id);
  if (!wc) throw new Error("tab not open");
  let png;
  if (mode === "full") {
    wc.debugger.attach("1.3");
    try {
      const metrics = await wc.debugger.sendCommand("Page.getLayoutMetrics");
      const size = metrics.cssContentSize || metrics.contentSize;
      const shot = await wc.debugger.sendCommand("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 16000), scale: 1 },
      });
      png = Buffer.from(shot.data, "base64");
    } finally {
      wc.debugger.detach();
    }
  } else {
    png = (await wc.capturePage()).toPNG();
  }
  return showShotPopup(png);
}

// Every capture is held in memory and shown in a small popup; nothing is written until the user saves.
let shotView = null;
let pendingPng = null;

function placeShotPopup() {
  if (!shotView) return;
  const { width, height } = win.getContentBounds();
  shotView.setBounds({ x: width - 356, y: height - 306, width: 340, height: 290 });
}

function closeShotPopup() {
  if (!shotView) return;
  win.contentView.removeChildView(shotView);
  shotView.webContents.close();
  shotView = null;
  pendingPng = null;
}

async function showShotPopup(png) {
  if (!png.length) throw new Error("empty capture");
  closeShotPopup();
  pendingPng = png;
  const img = nativeImage.createFromBuffer(png);
  const size = img.getSize();
  shotView = new WebContentsView({
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, sandbox: true,
      partition: uiPartition(config.activeProfile),
    },
  });
  placeShotPopup();
  win.contentView.addChildView(shotView);
  await shotView.webContents.loadFile(uiFile("shot.html"));
  shotView.webContents.send("event", "shot-image", {
    dataUrl: img.resize({ width: Math.min(size.width, 680) }).toDataURL(),
    width: size.width,
    height: size.height,
  });
  shotView.webContents.focus();
  return { shown: true };
}

async function copyShot() {
  if (!pendingPng) return false;
  await clipboard.write([new ClipboardItem({ "image/png": new Blob([pendingPng], { type: "image/png" }) })]);
  return true;
}

async function saveShotAs() {
  if (!pendingPng) return null;
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath("downloads"), `Alcove ${stamp}.png`),
    filters: [{ name: "PNG image", extensions: ["png"] }],
  });
  if (canceled || !filePath) return null; // popup stays open so the user can retry or copy instead
  fs.writeFileSync(filePath, pendingPng);
  closeShotPopup();
  send("screenshot-saved", { path: filePath });
  return filePath;
}

// Region capture: freeze the page, let the user drag a box on an overlay, then crop the frozen frame.
let region = null;
let regionImage = null;
let regionWidth = 1;

function closeRegion() {
  if (!region) return;
  win.contentView.removeChildView(region);
  region.webContents.close();
  region = null;
  regionImage = null;
}

async function startRegion(id) {
  const wc = wcOf(id);
  const view = tabs.get(id);
  if (!wc || !view) throw new Error("tab not open");
  const img = await wc.capturePage();
  if (img.isEmpty()) throw new Error("empty capture");
  closeRegion();
  const b = view.getBounds();
  regionImage = img;
  regionWidth = b.width;
  region = new WebContentsView({
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, sandbox: true,
      partition: uiPartition(config.activeProfile),
    },
  });
  region.setBounds(b);
  win.contentView.addChildView(region);
  await region.webContents.loadFile(uiFile("region.html"));
  region.webContents.send("event", "region-image", { dataUrl: img.toDataURL() });
  region.webContents.focus();
}

async function finishRegion(rect) {
  if (!regionImage) return;
  const size = regionImage.getSize();
  const k = size.width / regionWidth;
  const x = Math.max(0, Math.round(rect.x * k));
  const y = Math.max(0, Math.round(rect.y * k));
  const crop = {
    x, y,
    width: Math.max(1, Math.min(Math.round(rect.width * k), size.width - x)),
    height: Math.max(1, Math.min(Math.round(rect.height * k), size.height - y)),
  };
  const png = regionImage.crop(crop).toPNG();
  closeRegion();
  await showShotPopup(png);
}

// ---- video downloads (yt-dlp) ----

// Alcove drives the open-source yt-dlp program; it does not implement any extraction itself.
const YT_HOST = /^(?:www\.|m\.|music\.)?youtube\.com$|^youtu\.be$/;
const binDir = () => path.join(app.getPath("userData"), "bin");
const exeName = n => (process.platform === "win32" ? `${n}.exe` : n);
const downloadDir = () => process.env.ALCOVE_DOWNLOAD_DIR || app.getPath("downloads"); // env override is for tests

function findBinary(name, envVar) {
  if (envVar && process.env[envVar] && fs.existsSync(process.env[envVar])) return process.env[envVar];
  const own = path.join(binDir(), exeName(name));
  if (fs.existsSync(own)) return own;
  // GUI apps on macOS get a minimal PATH, so add the usual package-manager folders.
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"].join(path.delimiter);
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [name], {
      env: { ...process.env, PATH: `${process.env.PATH || ""}${path.delimiter}${extra}` },
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/)[0] || null;
  } catch { return null; }
}

const videoTools = () => ({ ytdlp: findBinary("yt-dlp", "ALCOVE_YTDLP"), ffmpeg: findBinary("ffmpeg", "ALCOVE_FFMPEG") });

// One-time download of the official yt-dlp release into Alcove's own data folder.
async function installDownloader() {
  const asset = { darwin: "yt-dlp_macos", win32: "yt-dlp.exe" }[process.platform] || "yt-dlp";
  const res = await net.fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  fs.mkdirSync(binDir(), { recursive: true });
  const dest = path.join(binDir(), exeName("yt-dlp"));
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
  return true;
}

// YouTube only serves separate video and audio streams, so video needs ffmpeg to merge them.
async function installFfmpeg() {
  const plat = process.platform;
  const asset = `ffmpeg-${plat}-${process.arch}.gz`;
  const supported = ["darwin-arm64", "darwin-x64", "win32-x64", "win32-ia32", "linux-x64", "linux-arm64"];
  if (!supported.includes(`${plat}-${process.arch}`)) throw new Error(`no ffmpeg build for ${plat} ${process.arch}`);
  const res = await net.fetch(`https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${asset}`, { redirect: "follow" });
  if (!res.ok) throw new Error(`ffmpeg download failed (${res.status})`);
  fs.mkdirSync(binDir(), { recursive: true });
  const dest = path.join(binDir(), exeName("ffmpeg"));
  fs.writeFileSync(dest, require("zlib").gunzipSync(Buffer.from(await res.arrayBuffer())), { mode: 0o755 });
}

// Installs whichever of yt-dlp and ffmpeg is missing.
async function installTools() {
  const t = videoTools();
  if (!t.ytdlp) await installDownloader();
  if (!t.ffmpeg) await installFfmpeg();
  return true;
}

const jobs = new Map(); // job id -> child process
let jobSeq = 0;

function startVideoDownload(url, kind) {
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error("not a valid link"); }
  if (!YT_HOST.test(host)) throw new Error("this downloader only handles YouTube links");
  const { ytdlp, ffmpeg } = videoTools();
  if (!ytdlp) throw new Error("downloader not set up");

  const audio = kind === "audio";
  if (!audio && !ffmpeg) throw new Error("video needs ffmpeg (run the setup)");
  // Audio-only streams can be saved as-is (m4a); ffmpeg, when present, converts to mp3.
  const format = audio ? (ffmpeg ? "ba/b" : "ba[ext=m4a]/ba") : "bv*+ba/b";
  const args = [
    "--no-playlist", "--newline", "--no-warnings", "--no-simulate", "--print", "after_move:filepath",
    "--progress", // --print makes yt-dlp quiet, which would also hide the percentage we show
    "-f", format, "-o", path.join(downloadDir(), "%(title).120B [%(id)s].%(ext)s"),
    // Speed: fetch up to 8 fragments at once, and request large files in 10 MB pieces
    // (which also avoids YouTube slowing down one long connection).
    "-N", "8", "--http-chunk-size", "10M",
  ];
  if (ffmpeg) args.push("--ffmpeg-location", path.dirname(ffmpeg));
  if (ffmpeg && audio) args.push("-x", "--audio-format", "mp3");
  if (ffmpeg && !audio) args.push("--merge-output-format", "mp4");
  args.push("--", url);

  const id = ++jobSeq;
  const child = spawn(ytdlp, args, { stdio: ["ignore", "pipe", "pipe"] });
  jobs.set(id, child);
  let filePath = null;
  let lastErr = "";
  let buf = "";
  const onLine = line => {
    const m = line.match(/^\[download\]\s+([\d.]+)%/);
    if (m) send("video-download", { job: id, state: "progress", percent: Math.min(100, parseFloat(m[1])) });
    else if (line && !line.startsWith("[") && path.isAbsolute(line.trim())) filePath = line.trim();
  };
  child.stdout.on("data", d => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    lines.forEach(onLine);
  });
  child.stderr.on("data", d => { lastErr = d.toString().trim().split(/\r?\n/).pop() || lastErr; });
  child.on("error", e => { jobs.delete(id); send("video-download", { job: id, state: "error", message: e.message }); });
  child.on("close", code => {
    if (buf) onLine(buf);
    const cancelled = !jobs.has(id);
    jobs.delete(id);
    if (cancelled) send("video-download", { job: id, state: "cancelled" });
    else if (code === 0 && filePath) send("video-download", { job: id, state: "done", path: filePath });
    else send("video-download", { job: id, state: "error", message: lastErr || `downloader exited with code ${code}` });
  });
  return { job: id, ffmpeg: !!ffmpeg };
}

function cancelVideoDownload(job) {
  const child = jobs.get(job);
  if (!child) return;
  jobs.delete(job); // marks it as cancelled for the close handler
  child.kill();
}

// ---- extensions ----

// The Web Store refuses non-Chrome browsers ("Switch to Chrome", disabled button). On store pages we
// relabel the button to "Add to Alcove", enable it, hide the banner, and report clicks to the sidebar.
const STORE_URL = /^https:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)\//;
const STORE_MARK = "__alcove_install__";

const storeScript = installed => `(() => {
  const MARK = ${JSON.stringify(STORE_MARK)};
  window.__alcoveInstalled = window.__alcoveInstalled || new Set(${JSON.stringify(installed)});
  if (window.__alcoveApply) { window.__alcoveApply(); return; }
  const extId = () => (location.href.match(/[a-p]{32}/) || [])[0];
  const isDone = () => window.__alcoveInstalled.has(extId());
  const label = () => (isDone() ? "Added to Alcove ✓" : "Add to Alcove");
  const deep = function* (root) {
    for (const el of root.querySelectorAll("*")) {
      yield el;
      if (el.shadowRoot) yield* deep(el.shadowRoot);
    }
  };
  const up = el => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  const button = el => {
    for (let n = el; n; n = up(n)) if (n.tagName === "BUTTON" || n.getAttribute?.("role") === "button") return n;
    return el;
  };
  const apply = () => {
    for (const el of deep(document)) {
      if (el.children.length) continue;
      const t = (el.textContent || "").trim();
      if (/^(add to chrome|add to alcove|added to alcove ✓)$/i.test(t)) {
        if (el.textContent !== label()) el.textContent = label();
        const b = button(el);
        b.removeAttribute("disabled");
        b.removeAttribute("aria-disabled");
        b.disabled = false;
        const bg = isDone() ? "#5f6368" : "#1a73e8";
        for (const [k, v] of [["background", bg], ["color", "#fff"], ["cursor", "pointer"], ["pointer-events", "auto"], ["opacity", "1"]]) {
          b.style.setProperty(k, v, "important");
        }
        if (!b.__alcove) {
          b.__alcove = true;
          b.addEventListener("click", ev => {
            ev.preventDefault();
            ev.stopImmediatePropagation();
            if (!isDone()) console.log(MARK);
          }, true);
        }
      } else if (/^switch to chrome to install/i.test(t)) {
        let n = el;
        while (up(n) && (up(n).textContent || "").trim().length < 90) n = up(n);
        n.style.setProperty("display", "none", "important");
      }
    }
  };
  window.__alcoveApply = apply;
  apply();
  setInterval(apply, 700); // the store is a single-page app and re-renders inside shadow roots
})()`;

function injectStoreFixes(wc) {
  let installed = [];
  try { installed = fs.readdirSync(extRoot(config.activeProfile)); } catch {}
  wc.executeJavaScript(storeScript(installed)).catch(() => {});
}

const activeWebSession = () => session.fromPartition(webPartition(config.activeProfile));
const extRoot = profileId => path.join(app.getPath("userData"), "extensions", profileId);

async function loadProfileExtensions(profileId, ses) {
  const root = extRoot(profileId);
  if (!fs.existsSync(root)) return;
  perf("extensions: start");
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.existsSync(path.join(dir, "manifest.json"))) continue;
    try { await ses.extensions.loadExtension(dir); } catch (e) { console.error("extension", name, e.message); }
    perf(`extensions: loaded ${name}`);
  }
}

// A .crx is a zip with a header in front; skip the header to get the zip.
function crxToZip(buf) {
  if (buf.subarray(0, 4).toString() !== "Cr24") return buf;
  const version = buf.readUInt32LE(4);
  if (version === 3) return buf.subarray(12 + buf.readUInt32LE(8));
  if (version === 2) return buf.subarray(16 + buf.readUInt32LE(8) + buf.readUInt32LE(12));
  throw new Error("unsupported CRX version");
}

function summarize(ext) {
  const m = ext.manifest || {};
  return {
    id: ext.id,
    name: ext.name,
    version: ext.version,
    description: m.description && !m.description.startsWith("__MSG_") ? m.description : "",
    popup: !!(m.action?.default_popup || m.browser_action?.default_popup),
    folder: path.basename(ext.path), // the Web Store ID for store installs
  };
}

// Replaces any earlier copy in the same folder, then loads the extension into the active profile.
async function installFromDir(srcDir, folderName) {
  const ses = activeWebSession();
  const dest = path.join(extRoot(config.activeProfile), folderName);
  for (const old of ses.extensions.getAllExtensions()) {
    if (path.resolve(old.path) === path.resolve(dest)) await ses.extensions.removeExtension(old.id);
  }
  if (path.resolve(srcDir) !== path.resolve(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(srcDir, dest, { recursive: true });
  }
  if (!fs.existsSync(path.join(dest, "manifest.json"))) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw new Error("no manifest.json found in that extension");
  }
  return summarize(await ses.extensions.loadExtension(dest));
}

async function installCrx(buf, folderName) {
  const tmp = fs.mkdtempSync(path.join(app.getPath("temp"), "alcove-ext-"));
  try {
    new AdmZip(crxToZip(buf)).extractAllTo(tmp, true);
    return await installFromDir(tmp, folderName);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Chrome Web Store link or bare 32-letter extension ID.
async function installFromStore(input) {
  const m = String(input).match(/[a-p]{32}/);
  if (!m) throw new Error("no extension ID found in that text");
  const id = m[0];
  const x = encodeURIComponent(`id=${id}&installsource=ondemand&uc`);
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome}&acceptformat=crx2,crx3&x=${x}`;
  const res = await net.fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return installCrx(Buffer.from(await res.arrayBuffer()), id);
}

async function installUnpacked() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Choose an unpacked extension folder",
    properties: ["openDirectory"],
  });
  if (canceled || !filePaths[0]) return null;
  const dir = filePaths[0];
  return installFromDir(dir, `local-${path.basename(dir).replace(/[^\w.-]+/g, "_")}`);
}

async function removeExtension(id) {
  const ses = activeWebSession();
  const ext = ses.extensions.getExtension(id);
  if (!ext) return;
  const dir = path.resolve(ext.path);
  await ses.extensions.removeExtension(id);
  if (dir.startsWith(path.resolve(extRoot(config.activeProfile)) + path.sep)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Extension popups open in a small view; the cursor loop closes it once it loses focus.
let extPopup = null;
let extPopupFocused = false;

function closeExtPopup() {
  if (!extPopup) return;
  win.contentView.removeChildView(extPopup);
  extPopup.webContents.close();
  extPopup = null;
}

function openExtPopup(id) {
  const ext = activeWebSession().extensions.getExtension(id);
  const m = ext?.manifest || {};
  const page = m.action?.default_popup || m.browser_action?.default_popup;
  if (!page) throw new Error("this extension has no popup");
  closeExtPopup();
  const { width, height } = win.getContentBounds();
  const left = Math.round(contentLeft);
  extPopup = new WebContentsView({
    webPreferences: { partition: webPartition(config.activeProfile), sandbox: true, contextIsolation: true },
  });
  extPopup.setBounds({
    x: left + 12, y: 12,
    width: Math.max(Math.min(400, width - left - 24), 200),
    height: Math.max(Math.min(560, height - 24), 200),
  });
  extPopupFocused = false;
  win.contentView.addChildView(extPopup);
  extPopup.webContents.loadURL(`chrome-extension://${id}/${page}`).catch(() => {});
  extPopup.webContents.focus();
}

// ---- import from Chrome and other Chromium browsers ----

// Bookmarks, history and installed extensions are plain files in each browser profile. Passwords and
// cookies are encrypted with a Keychain/DPAPI key, so they are not imported (sites need one new sign-in).
function browserRoots() {
  if (process.env.ALCOVE_IMPORT_ROOT) return [{ browser: "Test Browser", dir: process.env.ALCOVE_IMPORT_ROOT }]; // tests only
  const home = app.getPath("home");
  if (process.platform === "darwin") {
    const as = path.join(home, "Library", "Application Support");
    return [
      { browser: "Google Chrome", dir: path.join(as, "Google", "Chrome") },
      { browser: "Microsoft Edge", dir: path.join(as, "Microsoft Edge") },
      { browser: "Brave", dir: path.join(as, "BraveSoftware", "Brave-Browser") },
      { browser: "Arc", dir: path.join(as, "Arc", "User Data") },
      { browser: "Vivaldi", dir: path.join(as, "Vivaldi") },
      { browser: "Chromium", dir: path.join(as, "Chromium") },
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return [
      { browser: "Google Chrome", dir: path.join(local, "Google", "Chrome", "User Data") },
      { browser: "Microsoft Edge", dir: path.join(local, "Microsoft", "Edge", "User Data") },
      { browser: "Brave", dir: path.join(local, "BraveSoftware", "Brave-Browser", "User Data") },
      { browser: "Vivaldi", dir: path.join(local, "Vivaldi", "User Data") },
    ];
  }
  const cfg = path.join(home, ".config");
  return [
    { browser: "Google Chrome", dir: path.join(cfg, "google-chrome") },
    { browser: "Chromium", dir: path.join(cfg, "chromium") },
    { browser: "Brave", dir: path.join(cfg, "BraveSoftware", "Brave-Browser") },
    { browser: "Microsoft Edge", dir: path.join(cfg, "microsoft-edge") },
  ];
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return null; } };

function bookmarksOf(profileDir) {
  const data = readJson(path.join(profileDir, "Bookmarks"));
  const out = [];
  const walk = n => {
    if (!n || typeof n !== "object") return;
    if (n.type === "url" && /^https?:/i.test(n.url || "")) out.push({ url: n.url, title: n.name || n.url });
    for (const c of n.children || []) walk(c);
  };
  if (data && data.roots) for (const r of Object.values(data.roots)) walk(r);
  return out;
}

// Chrome stores history in SQLite and keeps the file open, so read a copy.
function historyOf(profileDir, limit = 3000) {
  const src = path.join(profileDir, "History");
  if (!fs.existsSync(src)) return [];
  const tmp = path.join(app.getPath("temp"), `alcove-import-history-${Date.now()}.sqlite`);
  try {
    fs.copyFileSync(src, tmp);
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(tmp, { readOnly: true });
    const stmt = db.prepare("SELECT url, title, last_visit_time AS t FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?");
    stmt.setReadBigInts(true);
    const rows = stmt.all(limit);
    db.close();
    // Chrome times are microseconds since 1601-01-01.
    return rows
      .filter(r => /^https?:/i.test(r.url))
      .map(r => ({ url: r.url, title: r.title || r.url, ts: Number(BigInt(r.t) / 1000n) - 11644473600000 }));
  } catch (e) {
    console.error("history import:", e.message);
    return [];
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function extensionName(manifest, dir) {
  const name = manifest.name || "";
  const m = /^__MSG_(\w+)__$/.exec(name);
  if (!m) return name;
  for (const loc of [manifest.default_locale, "en", "en_US"].filter(Boolean)) {
    const msgs = readJson(path.join(dir, "_locales", loc, "messages.json"));
    const hit = msgs && (msgs[m[1]] || msgs[m[1].toLowerCase()] || Object.entries(msgs).find(([k]) => k.toLowerCase() === m[1].toLowerCase())?.[1]);
    if (hit && hit.message) return hit.message;
  }
  return name;
}

// Installed extensions live unpacked in Extensions/<id>/<version>/; take the newest version.
function extensionsOf(profileDir) {
  const root = path.join(profileDir, "Extensions");
  let ids = [];
  try { ids = fs.readdirSync(root).filter(id => /^[a-p]{32}$/.test(id)); } catch { return []; }
  const out = [];
  for (const id of ids) {
    let versions = [];
    try { versions = fs.readdirSync(path.join(root, id)).filter(v => fs.existsSync(path.join(root, id, v, "manifest.json"))); } catch {}
    if (!versions.length) continue;
    versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const dir = path.join(root, id, versions[versions.length - 1]);
    out.push({ id, dir, name: extensionName(readJson(path.join(dir, "manifest.json")) || {}, dir) });
  }
  return out;
}

function listImportSources() {
  const out = [];
  for (const r of browserRoots()) {
    const state = readJson(path.join(r.dir, "Local State"));
    const cache = state && state.profile && state.profile.info_cache;
    if (!cache) continue;
    const profiles = Object.entries(cache)
      .filter(([dir]) => fs.existsSync(path.join(r.dir, dir)))
      .map(([dir, info]) => {
        const pdir = path.join(r.dir, dir);
        return {
          dir,
          name: info.name || dir,
          bookmarks: bookmarksOf(pdir).length,
          extensions: extensionsOf(pdir).length,
          history: fs.existsSync(path.join(pdir, "History")),
        };
      });
    if (profiles.length) out.push({ browser: r.browser, root: r.dir, profiles });
  }
  return out;
}

const pendingImports = new Map(); // new profile id -> { bookmarks, history }, handed to its sidebar on load

async function importFromBrowser({ root, dir, what = {}, asNew = false, name }) {
  const r = browserRoots().find(x => path.resolve(x.dir) === path.resolve(String(root)));
  if (!r) throw new Error("unknown browser");
  const pdir = path.resolve(r.dir, String(dir));
  if (path.dirname(pdir) !== path.resolve(r.dir) || !fs.existsSync(pdir)) throw new Error("profile not found");
  const data = {
    bookmarks: what.bookmarks ? bookmarksOf(pdir) : [],
    history: what.history ? historyOf(pdir) : [],
  };
  const exts = what.extensions ? extensionsOf(pdir) : [];

  if (asNew) {
    // Copy extensions into the new profile's folder; they load when the app switches to it.
    const profile = createProfile(String(name || dir).slice(0, 30));
    let copied = 0;
    for (const x of exts) {
      try {
        const dest = path.join(extRoot(profile.id), x.id);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(x.dir, dest, { recursive: true });
        copied++;
      } catch (e) { console.error("extension import:", x.id, e.message); }
    }
    pendingImports.set(profile.id, data);
    setImmediate(() => switchProfile(profile.id));
    return { profile: profile.name, bookmarks: data.bookmarks.length, history: data.history.length, extensions: copied };
  }

  const installed = [];
  for (const x of exts) {
    try { installed.push((await installFromDir(x.dir, x.id)).name); } catch (e) { console.error("extension import:", x.id, e.message); }
  }
  return { ...data, extensions: installed };
}

// ---- command palette ----

function hidePalette() {
  if (!palette) return;
  win.contentView.removeChildView(palette);
  palette.webContents.close();
  palette = null;
}

// Re-created on every open so it always sits above the tab views.
function showPalette() {
  hidePalette();
  const { width, height } = win.getContentBounds();
  const left = collapsed ? 0 : SIDEBAR_W;
  const w = Math.min(Math.max(width - left - 40, 300), 580);
  const x = left + Math.max((width - left - w) / 2, 0);
  palette = new WebContentsView({
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, sandbox: true,
      partition: uiPartition(config.activeProfile), // same storage as the sidebar
    },
  });
  palette.setBounds({
    x: Math.round(x), y: 70, width: Math.round(w), height: Math.max(Math.min(420, height - 90), 200),
  });
  win.contentView.addChildView(palette);
  palette.webContents.loadFile(uiFile("palette.html"));
  palette.webContents.focus();
}

// ---- sidebar view + profiles ----

function createUi() {
  ui = new WebContentsView({
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, sandbox: true,
      partition: uiPartition(config.activeProfile),
    },
  });
  ui.webContents.on("will-navigate", e => e.preventDefault());
  ui.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.contentView.addChildView(ui);
  ui.webContents.once("did-finish-load", () => {
    perf("sidebar: did-finish-load");
    introPeek();
  });
  ui.webContents.once("did-start-loading", () => perf("sidebar: did-start-loading"));
  ui.webContents.once("dom-ready", () => perf("sidebar: dom-ready"));
  ui.webContents.on("console-message", (e, _l, legacy) => {
    const m = typeof e.message === "string" ? e.message : legacy;
    if (m && m.startsWith("[perf]")) perf(`sidebar says: ${m.slice(7)}`);
  });
  ui.webContents.loadFile(uiFile("index.html"));
  sidebarX = collapsed ? HIDE_X : 0;
  uiRadius = -1;
  contentLeft = collapsed ? 0 : SIDEBAR_W;
  peeking = false;
  layout();
}

function activeProfile() {
  return config.profiles.find(p => p.id === config.activeProfile);
}

function switchProfile(id) {
  if (id === config.activeProfile || !config.profiles.some(p => p.id === id)) return;
  hidePalette();
  closePeek();
  setSplit(null);
  closeRegion();
  closeShotPopup();
  closeExtPopup();
  for (const tabId of [...tabs.keys()]) closeTab(tabId);
  const old = ui;
  config.activeProfile = id;
  saveConfig();
  ensureSession(id);
  applyBlocking();
  createUi();
  win.contentView.removeChildView(old);
  setImmediate(() => old.webContents.close()); // the request may have come from the old view
  const p = activeProfile();
  win.setTitle(p.id === "default" ? "Alcove" : `Alcove — ${p.name}`);
}

function createProfile(name) {
  const n = config.profiles.length;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile";
  const profile = { id: `${slug}-${Math.random().toString(36).slice(2, 6)}`, name, color: COLORS[n % COLORS.length] };
  config.profiles.push(profile);
  saveConfig();
  return profile;
}

async function deleteProfile(id) {
  if (id === "default" || id === config.activeProfile) throw new Error("cannot delete this profile");
  config.profiles = config.profiles.filter(p => p.id !== id);
  saveConfig();
  await session.fromPartition(webPartition(id)).clearStorageData();
  await session.fromPartition(uiPartition(id)).clearStorageData();
}

// ---- IPC ----

const wcOf = id => tabs.get(id)?.webContents;
const fxCache = new Map();

const commands = {
  open_tab: ({ id, url }) => openTab(id, url),
  switch_tab: ({ id }) => showOnly(id),
  close_tab: ({ id }) => closeTab(id),
  navigate: ({ id, url }) => { wcOf(id)?.loadURL(url).catch(() => {}); },
  nav_action: ({ id, action }) => {
    const wc = wcOf(id);
    if (!wc) return;
    if (action === "back") wc.navigationHistory.goBack();
    else if (action === "forward") wc.navigationHistory.goForward();
    else if (action === "reload") wc.reload();
  },
  set_split: ({ split: next }) => setSplit(next || null),
  split_drag: ({ active }) => { dividerDragging = !!active; if (divider) win.contentView.addChildView(divider); layout(); },
  split_ratio: ({ ratio }) => {
    if (!split) return;
    split.ratio = Math.min(0.8, Math.max(0.2, Number(ratio) || 0.5));
    layout();
    send("split-ratio", { ratio: split.ratio });
  },
  open_peek: ({ url }) => openPeek(String(url)),
  // Test hook (ALCOVE_TEST=1 only): the labels the page menu would show for a given right-click.
  debug_page_menu: ({ id, params }) => process.env.ALCOVE_TEST === "1" && wcOf(id)
    ? pageMenu(id, wcOf(id), { mediaType: "none", selectionText: "", isEditable: false, linkURL: "", srcURL: "", x: 0, y: 0, ...params }).items.map(i => i.type === "separator" ? "—" : i.label || i.role)
    : null,
  peek_close: () => setImmediate(closePeek),
  peek_open_tab: () => setImmediate(peekToTab),
  pip: ({ id }) => pictureInPicture(wcOf(id)),
  copy_text: ({ text }) => clipboard.writeText(String(text)),
  mute_tab: ({ id }) => {
    const wc = wcOf(id);
    if (!wc) return null;
    wc.setAudioMuted(!wc.isAudioMuted());
    send("tab-audio", { id, audible: wc.isCurrentlyAudible(), muted: wc.isAudioMuted() });
    return wc.isAudioMuted();
  },
  mute_all: ({ muted }) => {
    for (const [id, v] of tabs) {
      v.webContents.setAudioMuted(!!muted);
      send("tab-audio", { id, audible: v.webContents.isCurrentlyAudible(), muted: !!muted });
    }
  },
  toggle_dark: async ({ id }) => {
    const wc = wcOf(id);
    const host = wc && hostKey(wc.getURL());
    if (!host) return null;
    const on = !config.forceDark.includes(host);
    config.forceDark = on ? [...config.forceDark, host] : config.forceDark.filter(h => h !== host);
    saveConfig();
    for (const v of tabs.values()) if (hostKey(v.webContents.getURL()) === host) await applyDark(v.webContents, on);
    return { host, on };
  },
  // Finds text inside the pages of open tabs (tabs not loaded yet can't be searched).
  search_tabs: async ({ q }) => {
    const needle = String(q).toLowerCase().slice(0, 100);
    if (needle.length < 3) return [];
    const out = [];
    await Promise.all([...tabs].map(async ([id, v]) => {
      try {
        const text = await Promise.race([
          v.webContents.executeJavaScript(`(document.body && document.body.innerText || "").slice(0, 200000)`),
          sleep(800).then(() => ""),
        ]);
        const i = String(text).toLowerCase().indexOf(needle);
        if (i >= 0) out.push({ id, snippet: text.slice(Math.max(0, i - 40), i + needle.length + 60).replace(/\s+/g, " ").trim() });
      } catch {}
    }));
    return out;
  },
  // Daily exchange rates (open.er-api.com, no account needed), cached for 6 hours.
  fx_rates: async ({ base }) => {
    const b = String(base).toUpperCase();
    if (!/^[A-Z]{3}$/.test(b)) return null;
    const hit = fxCache.get(b);
    if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.data;
    try {
      const res = await net.fetch(`https://open.er-api.com/v6/latest/${b}`);
      const j = res.ok ? await res.json() : null;
      if (!j || j.result !== "success") return null;
      const data = { rates: j.rates, updated: j.time_last_update_utc };
      fxCache.set(b, { at: Date.now(), data });
      return data;
    } catch { return null; }
  },
  set_sponsorblock: ({ enabled }) => { config.sponsorBlock = !!enabled; saveConfig(); },
  site_permissions: ({ url }) => {
    let origin; try { origin = new URL(String(url)).origin; } catch { return []; }
    return Object.entries(config.sitePermissions).filter(([k]) => k.startsWith(`${origin} `)).map(([k, v]) => ({ permission: k.slice(origin.length + 1), allowed: v }));
  },
  reset_site_permissions: ({ url }) => {
    let origin; try { origin = new URL(String(url)).origin; } catch { return; }
    for (const k of Object.keys(config.sitePermissions)) if (k.startsWith(`${origin} `)) delete config.sitePermissions[k];
    saveConfig();
  },
  zoom: ({ id, factor }) => { wcOf(id)?.setZoomFactor(Math.min(5, Math.max(0.25, factor))); },
  find: ({ id, text, backwards }) => {
    const wc = wcOf(id);
    if (!wc || !text) return;
    const again = lastFind.get(id) === text;
    lastFind.set(id, text);
    wc.findInPage(text, { forward: !backwards, findNext: again });
  },
  clear_find: ({ id }) => {
    lastFind.delete(id);
    wcOf(id)?.stopFindInPage("clearSelection");
  },
  focus_ui: () => {
    if (collapsed && !peeking) peek(true); // typing in the address bar needs the sidebar on screen
    ui.webContents.focus();
  },
  show_palette: showPalette,
  hide_palette: () => setImmediate(hidePalette),
  reveal: ({ path: p }) => shell.showItemInFolder(p),
  screenshot: ({ id, mode }) => screenshot(id, mode),
  screenshot_region: ({ id }) => startRegion(id),
  region_done: ({ rect }) => finishRegion(rect),
  region_cancel: () => closeRegion(),
  shot_save_as: () => saveShotAs(),
  shot_copy: () => copyShot(),
  shot_discard: () => closeShotPopup(),

  list_extensions: () => activeWebSession().extensions.getAllExtensions().map(summarize),
  install_extension: ({ input }) => installFromStore(input),
  install_unpacked_extension: () => installUnpacked(),
  remove_extension: ({ id }) => removeExtension(id),
  extension_popup: ({ id }) => openExtPopup(id),

  video_tools: () => { const t = videoTools(); return { ready: !!t.ytdlp, ffmpeg: !!t.ffmpeg }; },
  install_downloader: () => installTools(),
  download_video: ({ url, kind }) => startVideoDownload(String(url), kind),
  cancel_video: ({ job }) => cancelVideoDownload(job),
  store_button: ({ id, folder }) => wcOf(id)?.executeJavaScript(
    `window.__alcoveInstalled && window.__alcoveInstalled.add(${JSON.stringify(folder)}); window.__alcoveApply && window.__alcoveApply();`,
  ).catch(() => {}),

  toggle_sidebar: toggleSidebar,
  set_chrome_color: ({ color }) => { if (/^#[0-9a-f]{6}$/i.test(String(color))) win.setBackgroundColor(color); },
  window_action: ({ action }) => windowAction(action),
  drag_start: startDrag,
  drag_end: () => clearInterval(dragTimer),
  sidebar_busy: ({ busy }) => { sidebarBusy = !!busy; },
  get_settings: () => ({ adblock: config.adblock, adblockAllow: config.adblockAllow, sponsorBlock: config.sponsorBlock, collapsed, adblockReady: !!blocker }),
  set_adblock_site: ({ host, allowed }) => {
    const h = String(host).replace(/^www\./, "").toLowerCase();
    config.adblockAllow = config.adblockAllow.filter(d => d !== h);
    if (allowed) config.adblockAllow.push(h);
    saveConfig();
    return config.adblockAllow;
  },
  adblock_stats: () => adStats,
  set_adblock: ({ enabled }) => {
    config.adblock = !!enabled;
    saveConfig();
    applyBlocking();
  },
  get_profiles: () => ({ profiles: config.profiles, active: config.activeProfile }),
  list_import_sources: () => listImportSources(),
  import_browser: args => importFromBrowser(args),
  take_pending_import: () => {
    const d = pendingImports.get(config.activeProfile) || null;
    pendingImports.delete(config.activeProfile);
    return d;
  },
  create_profile: ({ name }) => createProfile(String(name).trim().slice(0, 30) || "Profile"),
  switch_profile: ({ id }) => { setImmediate(() => switchProfile(id)); },
  delete_profile: ({ id }) => deleteProfile(id),
};

const fromOurPages = e =>
  [ui, palette, region, shotView, peekBackdrop, divider, strip].some(v => v && e.sender === v.webContents);

ipcMain.handle("invoke", (e, cmd, args) => {
  if (!fromOurPages(e)) throw new Error("forbidden");
  const handler = commands[cmd];
  if (!handler) throw new Error(`unknown command: ${cmd}`);
  return handler(args || {});
});

ipcMain.on("emit", (e, name, payload) => {
  if (fromOurPages(e)) send(name, payload);
});

// ---- menu ----

// Native accelerators keep shortcuts working while a web page has keyboard focus.
function buildMenu() {
  const item = (id, label, accelerator) => ({ label, accelerator, click: () => send("shortcut", id) });
  const mac = process.platform === "darwin";
  return Menu.buildFromTemplate([
    ...(mac ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      item("new-tab", "New Tab", "CmdOrCtrl+T"),
      item("reopen-tab", "Reopen Closed Tab", "CmdOrCtrl+Shift+T"),
      item("close-tab", "Close Tab", "CmdOrCtrl+W"),
      { type: "separator" },
      item("palette", "Command Palette", "CmdOrCtrl+K"),
      item("focus-address", "Open Location", "CmdOrCtrl+L"),
      item("bookmark", "Bookmark This Page", "CmdOrCtrl+D"),
      item("download-video", "Download YouTube Video", "CmdOrCtrl+Shift+D"),
      item("screenshot-region", "Screenshot Selected Area", "CmdOrCtrl+Shift+4"),
      item("screenshot", "Screenshot Visible Area", "CmdOrCtrl+Shift+S"),
      item("screenshot-full", "Screenshot Full Page", "CmdOrCtrl+Alt+Shift+S"),
      ...(mac ? [] : [{ type: "separator" }, { role: "quit" }]),
    ] },
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      { type: "separator" },
      item("find", "Find in Page", "CmdOrCtrl+F"),
    ] },
    { label: "View", submenu: [
      { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+S", click: toggleSidebar },
      { type: "separator" },
      item("reload", "Reload", "CmdOrCtrl+R"),
      item("back", "Back", "CmdOrCtrl+["),
      item("forward", "Forward", "CmdOrCtrl+]"),
      { type: "separator" },
      item("zoom-in", "Zoom In", "CmdOrCtrl+="),
      item("zoom-out", "Zoom Out", "CmdOrCtrl+-"),
      item("zoom-reset", "Actual Size", "CmdOrCtrl+0"),
    ] },
    { label: "Tabs", submenu: [
      item("recent-tab", "Switch to Recent Tab", "Ctrl+Tab"),
      { type: "separator" },
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(n => item(`tab-${n}`, `Tab ${n}`, `CmdOrCtrl+${n}`)),
      item("tab-last", "Last Tab", "CmdOrCtrl+9"),
      { type: "separator" },
      item("split-recent", "Split View with Recent Tab"),
      item("exit-split", "Exit Split View"),
      item("pip", "Picture in Picture", "CmdOrCtrl+Alt+P"),
    ] },
    { label: "Spaces", submenu: [
      item("next-space", "Next Space", mac ? "Cmd+Alt+Right" : "Ctrl+Alt+Right"),
      item("prev-space", "Previous Space", mac ? "Cmd+Alt+Left" : "Ctrl+Alt+Left"),
      { type: "separator" },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => item(`space-${n}`, `Space ${n}`, mac ? `Ctrl+${n}` : `Alt+${n}`)),
    ] },
    { label: "Library", submenu: [
      item("bookmarks", "Bookmarks", "CmdOrCtrl+Shift+B"),
      item("history", "History", "CmdOrCtrl+Y"),
      item("downloads", "Downloads", "CmdOrCtrl+Shift+J"),
      { type: "separator" },
      { label: "Import from Browser…", click: () => send("shortcut", "import") },
    ] },
    { role: "windowMenu" },
  ]);
}

app.on("second-instance", () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  if (!gotInstanceLock) return;
  perf("app ready");
  if (process.env.ALCOVE_PERF === "1") { // report main-thread stalls longer than 200ms during startup
    let last = performance.now();
    const lag = setInterval(() => {
      const now = performance.now();
      if (now - last > 300) perf(`main thread stalled ~${Math.round(now - last - 100)}ms`);
      last = now;
    }, 100);
    setTimeout(() => clearInterval(lag), 8000);
  }
  loadConfig();
  collapsed = !!config.collapsed;
  ensureSession(config.activeProfile);
  blockerReady = initBlocker();
  Menu.setApplicationMenu(buildMenu());

  const p = activeProfile();
  win = new BaseWindow({
    width: 1280, height: 800, minWidth: 640, minHeight: 400,
    title: p.id === "default" ? "Alcove" : `Alcove — ${p.name}`,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#17171c" : "#f4f4f7",
    autoHideMenuBar: true,
    // No title bar: window controls live in the sidebar (native lights on macOS, drawn ones elsewhere).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden", trafficLightPosition: { x: 18, y: 15 } }
      : { frame: false }),
  });
  perf("window created");
  createUi();
  createStrip();
  win.on("resize", layout);
  watchCursor();
});

app.on("window-all-closed", () => app.quit());
