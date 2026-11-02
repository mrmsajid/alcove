const {
  app, BaseWindow, WebContentsView, Menu, ipcMain, shell, session, screen, nativeTheme, clipboard, ClipboardItem, dialog, net, nativeImage, systemPreferences, Notification, powerMonitor,
} = require("electron");
const AdmZip = require("adm-zip");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { pathToFileURL, fileURLToPath } = require("url");
const { searchUrl } = require(path.join(__dirname, "ui", "engines.js"));

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
  shortcuts: [], // websites pinned to the start page: [{ name, url }]
  activeProfile: "default",
  profiles: [{ id: "default", name: "Default", color: COLORS[0] }],
  settings: {},
};

// User-adjustable settings (Settings page). Unknown or missing values fall back to these.
const DEFAULT_SETTINGS = {
  searchEngine: "duckduckgo", customSearch: "",
  startup: "restore", startupUrl: "",       // restore | newtab | custom
  newTab: "start", newTabUrl: "",           // start (ui/newtab.html) | engine | blank | custom
  downloadDir: "", askDownload: false,
  theme: "system", accent: "#76767f", textSize: "default", defaultZoom: 1, compact: false,
  glass: true, frost: 55,                   // frosted see-through sidebar and frame; frost 0 = clear, 100 = solid
  sidebarMode: "overlay",                   // overlay: sidebar floats over the page | docked: page makes room for it
  blur: 55,                                 // how soft the glass blurs the page behind a floating sidebar
  glassStyle: "frosted",                    // frosted (soft tinted blur) | clear (lighter blur, almost no tint; macOS). Applies live
  shine: 40,                                // specular edges and color fringe on glass controls (0 = off)
  dnt: true, httpsOnly: false, spellcheck: true,
};
const SETTING_RULES = {
  searchEngine: v => typeof v === "string" && v.length < 30,
  customSearch: v => typeof v === "string" && (v === "" || (/^https?:\/\//.test(v) && v.includes("%s"))),
  startup: v => ["restore", "newtab", "custom"].includes(v),
  startupUrl: v => typeof v === "string" && v.length < 2000,
  newTab: v => ["start", "engine", "blank", "custom"].includes(v),
  newTabUrl: v => typeof v === "string" && v.length < 2000,
  downloadDir: v => v === "",               // set a folder through choose_download_dir
  askDownload: v => typeof v === "boolean",
  theme: v => ["system", "light", "dark"].includes(v),
  accent: v => /^#[0-9a-f]{6}$/i.test(v),
  textSize: v => ["small", "default", "large"].includes(v),
  defaultZoom: v => typeof v === "number" && v >= 0.5 && v <= 2,
  compact: v => typeof v === "boolean",
  dnt: v => typeof v === "boolean",
  httpsOnly: v => typeof v === "boolean",
  spellcheck: v => typeof v === "boolean",
  glass: v => typeof v === "boolean",
  frost: v => typeof v === "number" && v >= 0 && v <= 100,
  sidebarMode: v => ["overlay", "docked"].includes(v),
  blur: v => typeof v === "number" && v >= 0 && v <= 100,
  glassStyle: v => ["frosted", "clear"].includes(v),
  shine: v => typeof v === "number" && v >= 0 && v <= 100,
};
// Clear glass is the same blurred glass with a lighter material and almost no tint (the sidebar page sets
// the tint), so it switches live. A fully transparent window would show the desktop unblurred, which is
// hard to read, and macOS drops the window shadow on transparent windows.
const wantsClear = () => process.platform === "darwin" && S().glass && S().glassStyle === "clear";
const glassMaterial = () => (wantsClear() ? "under-window" : "sidebar");
const S = () => config.settings;
const configPath = () => path.join(app.getPath("userData"), "config.json");

function loadConfig() {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(configPath(), "utf8")) }; } catch {}
  config.settings = { ...DEFAULT_SETTINGS, ...(config.settings || {}) };
  // v2: the old blue default accent (saved by earlier builds) becomes the new neutral default.
  if ((config.settingsVersion || 1) < 2) {
    if (config.settings.accent === "#7c8cff") config.settings.accent = DEFAULT_SETTINGS.accent;
    config.settingsVersion = 2;
  }
  // v3: new tabs open the start page. Earlier builds saved "engine" (the search engine's home page) as the default,
  // so it is moved over once; choosing it again in Settings sticks.
  if (config.settingsVersion < 3) {
    if (config.settings.newTab === "engine") config.settings.newTab = DEFAULT_SETTINGS.newTab;
    config.settingsVersion = 3;
  }
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

// Web pages sit in a rounded card with a small gap on every side. With the sidebar hidden the card
// takes the whole window and the sidebar slides out over it, so the page never resizes. The window
// buttons stay hidden until the pointer nears them (see windowButtons), so they take no room either.
const MARGIN = 8;
const gap = () => (S().compact ? 0 : MARGIN); // Settings › Appearance › Compact layout removes it
// Windows has no native window buttons here, so ui/caption.html draws Minimize / Maximize / Close in the top right
// corner. Like the Mac's, they stay hidden until the pointer goes there (see windowButtons). ALCOVE_TEST_WIN=1
// shows that on a Mac, for testing.
const IS_WIN = process.platform === "win32" || process.env.ALCOVE_TEST_WIN === "1";
const CAPTION_W = 138; // three 46 px buttons
const CAPTION_H = 32;
const HIDE_X = -(SIDEBAR_W + MARGIN + 4); // sidebar x when hidden (fully off screen)
// The sidebar floats over the page by default and never resizes it. In "docked" mode (Settings) the page
// makes room for it instead, and only floats when the sidebar is hidden and slides out from the edge.
const docked = () => S().sidebarMode === "docked";
const floating = () => collapsed || !docked();
const dockedLeft = () => (docked() && !collapsed ? SIDEBAR_W : 0); // where the page starts
// Left edge of the page area that the sidebar doesn't cover (for popups placed beside it).
const clearLeft = () => (collapsed ? 0 : docked() ? SIDEBAR_W : SIDEBAR_W + MARGIN);
let uiRadius = -1;
let lightsFloat = null;
const CARD_RADIUS = 10;
const cardRadius = () => (S().compact ? 0 : CARD_RADIUS);

function contentRect() {
  const { width, height } = win.getContentBounds();
  const hidden = 1 - Math.min(1, Math.max(0, contentLeft / SIDEBAR_W)); // 0 = sidebar shown, 1 = hidden (animates)
  const g = gap();
  const x = Math.round(contentLeft + g * hidden);
  return { x, y: g, w: Math.max(width - x - g, 1), h: Math.max(height - 2 * g, 1), hidden, width };
}

function layout() {
  const { height } = win.getContentBounds();
  // Docked: flush with the window. Otherwise a floating rounded panel over the page.
  const float = floating();
  ui.setBounds(float
    ? { x: Math.round(sidebarX) + MARGIN, y: MARGIN, width: SIDEBAR_W, height: height - 2 * MARGIN }
    : { x: Math.round(sidebarX), y: 0, width: SIDEBAR_W, height });
  // Keep the macOS window buttons level with the sidebar's top row, which sits lower when it floats.
  if (process.platform === "darwin" && float !== lightsFloat && typeof win.setWindowButtonPosition === "function") {
    lightsFloat = float;
    win.setWindowButtonPosition(float ? { x: 18 + MARGIN, y: 15 + MARGIN - 3 } : { x: 18, y: 15 });
  }
  const radius = float ? 14 : 0;
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
    const left = Math.round(contentLeft);
    strip.setBounds({ x: left, y: 0, width: Math.max(c.width - left, 1), height: Math.max(gap(), 1) });
    strip.setVisible(gap() > 0);
  }
  if (caption) caption.setBounds({ x: Math.max(c.width - CAPTION_W, 0), y: 0, width: CAPTION_W, height: CAPTION_H });
  placePeek();
  placeSettings();
  placeTools();
  placeShotPopup();
}

// The margin above the page doubles as a title bar: drag to move the window, double-click to zoom.
let strip = null;
let caption = null; // Windows only: the Minimize / Maximize / Close buttons, over the page's top right corner while shown
function createStrip() {
  strip = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  strip.setBackgroundColor("#00000000");
  strip.webContents.loadFile(uiFile("strip.html"));
  win.contentView.addChildView(strip);
  layout();
}

// Windows: flat Minimize / Maximize-Restore / Close at the top right. Hidden until the pointer goes there.
function createCaption() {
  caption = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  caption.setBackgroundColor("#00000000");
  caption.webContents.loadFile(uiFile("caption.html"));
  win.contentView.addChildView(caption);
  caption.setVisible(false);
  const state = () => { if (caption && !caption.webContents.isDestroyed()) caption.webContents.send("event", "window-state", { maximized: win.isMaximized() }); };
  caption.webContents.on("did-finish-load", state);
  win.on("maximize", state);
  win.on("unmaximize", state);
  layout();
}

const raiseUi = () => win.contentView.addChildView(ui); // re-adding moves a view to the top

// Glass over pages. The sidebar floats over the page, and a view can't blur what's behind it, so while it's
// showing, the part of the page under it is captured a few times a second, shrunk, and sent to the sidebar,
// which draws it blurred behind its tint (#glass-bg in ui/style.css). Only runs while that's visible.
let backdropBusy = false;
let lastBackdrop = "";
async function updateBackdrop() {
  if (backdropBusy || !win || win.isDestroyed() || !ui || !S().glass) return;
  if (!floating() || (collapsed && !peeking) || Math.abs(sidebarX) > 1 || !win.isVisible() || win.isMinimized()) return;
  const v = tabs.get(shownId);
  if (!v) return;
  backdropBusy = true;
  try {
    const b = v.getBounds();
    const x = Math.max(0, MARGIN - b.x), w = Math.min(SIDEBAR_W, b.width - x);
    if (w < 40) return;
    const img = await v.webContents.capturePage({ x, y: 0, width: w, height: b.height });
    if (img.isEmpty()) return;
    const small = img.resize({ width: Math.max(24, Math.round(w / 4)), quality: "good" });
    const url = "data:image/jpeg;base64," + small.toJPEG(60).toString("base64");
    if (url === lastBackdrop) return;
    lastBackdrop = url;
    // Average brightness (0-1) so the sidebar can switch between dark text on a light tint and light text on a dark one.
    const px = small.toBitmap();
    let sum = 0, n = 0;
    for (let i = 0; i + 3 < px.length; i += 16) { sum += 0.2126 * px[i + 2] + 0.7152 * px[i + 1] + 0.0722 * px[i]; n++; } // BGRA
    send("glass-backdrop", { url, lum: n ? sum / n / 255 : 0.5 });
  } catch {} finally { backdropBusy = false; }
}
setInterval(updateBackdrop, 250);

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

const sidebarState = () => send("sidebar-state", { collapsed, peek: peeking, floating: floating() });

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
  if (floating()) raiseUi();
  animate(collapsed ? HIDE_X : 0, dockedLeft(), 240);
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
    windowButtons(p, b); // before the focus check: a background window's buttons work too
    if (!win.isFocused()) return;
    if (!collapsed) return;
    if (!peeking && inside && rel <= 3) peek(true);
    else if (peeking && !sidebarBusy && Date.now() > peekHoldUntil && (!inside || rel > SIDEBAR_W + 12)) peek(false);
  }, 50);
}

// Window buttons are hidden until the pointer is near them. On the Mac: along the top of the sidebar while it's
// showing, or in the window's top-left corner while it's hidden. On Windows: the top right corner, where the
// edge of the window brings them up (a taller zone would cover a page's own sign-in and menu buttons). They
// linger briefly after the pointer leaves so they don't flicker, and stay on in full screen on the Mac.
let buttonsShown = null; // last visibility given to the buttons; null = unknown, set it again
let buttonsSeenAt = 0;
function windowButtons(p, b) {
  const x = p.x - b.x, y = p.y - b.y;
  let near;
  if (IS_WIN) {
    const shown = buttonsSeenAt > 0;
    near = !win.isFullScreen() && x >= b.width - CAPTION_W - (shown ? 12 : 0) && x < b.width && y >= 0 && y < (shown ? CAPTION_H + 12 : 10);
  } else {
    const sidebarShown = !collapsed || peeking;
    near = x >= 0 && y >= 0 && x < (sidebarShown ? SIDEBAR_W + MARGIN : 96) && y < (buttonsSeenAt ? 52 : 40);
  }
  const now = Date.now();
  if (near) buttonsSeenAt = now;
  else if (now - buttonsSeenAt > 400) buttonsSeenAt = 0;
  const want = buttonsSeenAt > 0 || (!IS_WIN && win.isFullScreen());
  if (want === buttonsShown) return;
  buttonsShown = want;
  if (!IS_WIN) win.setWindowButtonVisibility(want);
  else if (caption) {
    if (want) win.contentView.addChildView(caption); // above the page and the other views
    caption.setVisible(want);
  }
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
}

// The single request filter for a web session: upgrades page loads to HTTPS when asked to, then lets the
// ad blocker decide (unless the site is exempt). Re-installed after the blocker is switched on or off,
// because the blocker replaces the session's handler.
const LOCAL_HTTP = /^http:\/\/(localhost|127\.|\[::1\]|10\.|192\.168\.|[^/]*\.local\b|[^/]*\.test\b)/i;
// Focus mode (Tools panel): while it's on, new page loads for the chosen sites are refused and the tab
// shows ui/blocked.html instead. Pages that are already open are left alone until they navigate.
let focus = null; // { until, sites }
const focusActive = () => { if (focus && Date.now() >= focus.until) focus = null; return focus; };
const focusBlocks = url => {
  const f = focusActive();
  const h = f && hostKey(url);
  return !!h && f.sites.some(s => h === s || h.endsWith("." + s));
};

function installRequestFilter(ses) {
  ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    if (details.resourceType === "mainFrame" && focusBlocks(details.url)) return callback({ cancel: true });
    if (S().httpsOnly && details.resourceType === "mainFrame" && /^http:\/\//i.test(details.url) && !LOCAL_HTTP.test(details.url)) {
      return callback({ redirectURL: details.url.replace(/^http:/i, "https:") });
    }
    const filtering = blocker && blocker.isBlockingEnabled(ses);
    if (!filtering || (details.webContents && siteAllowed(details.webContents)) || startedByYouTube(details)) return callback({});
    blocker.onBeforeRequest(details, callback);
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
  for (const ses of knownSessions) installRequestFilter(ses);
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

// Settings › Downloads › Location (falls back to the system Downloads folder if it's gone).
const downloadsFolder = () => (S().downloadDir && fs.existsSync(S().downloadDir) ? S().downloadDir : app.getPath("downloads"));

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
    const url = item.getURL();
    if (S().askDownload) {
      // Leaving the save path unset makes Electron show the save dialog.
      item.setSaveDialogOptions({ defaultPath: path.join(downloadsFolder(), item.getFilename()) });
      send("download", { state: "started", url, path: item.getFilename() });
      item.once("done", (_ev, state) =>
        send("download", { state: state === "completed" ? "done" : "failed", url, path: item.getSavePath() || item.getFilename() }));
      return;
    }
    const dest = uniquePath(path.join(downloadsFolder(), item.getFilename()));
    item.setSavePath(dest);
    send("download", { state: "started", url, path: dest });
    item.once("done", (_ev, state) =>
      send("download", { state: state === "completed" ? "done" : "failed", url, path: dest }));
  });
  // Settings › Privacy: ask sites not to track (Do Not Track + Global Privacy Control).
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (S().dnt) { details.requestHeaders.DNT = "1"; details.requestHeaders["Sec-GPC"] = "1"; }
    callback({ requestHeaders: details.requestHeaders });
  });
  ses.setSpellCheckerEnabled(S().spellcheck);
  installRequestFilter(ses);
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

// Sign-in popups. A page that opens a sized popup expects it to be a real window: the popup reports back to its
// opener (postMessage) and closes itself (window.close()). A tab made from just the popup's URL has no opener, so
// "Sign in with Google" (ClickUp, and most sites) ended on a blank page. The popup is a small window in the same
// session (the same cookies), centred on the app, with no menu bar.
function popupWindow(features) {
  const n = k => { const m = new RegExp(`(?:^|[,\\s])${k}\\s*=\\s*(\\d+)`, "i").exec(features); return m ? Number(m[1]) : 0; };
  const width = Math.min(Math.max(n("width") || 500, 360), 1100);
  const height = Math.min(Math.max(n("height") || 650, 320), 900);
  return {
    action: "allow",
    overrideBrowserWindowOptions: {
      parent: win, width, height, show: true, autoHideMenuBar: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1d1d20" : "#ffffff",
    },
  };
}
function popupCreated(popup) {
  popup.setMenuBarVisibility(false);
  popup.center();
  popup.webContents.setWindowOpenHandler(({ url: u }) => { send("new-tab-request", { url: u }); return { action: "deny" }; });
}

function openTab(id, url) {
  const view = new WebContentsView({
    webPreferences: {
      partition: webPartition(config.activeProfile),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      zoomFactor: S().defaultZoom, // Settings › Appearance › Page zoom
    },
  });
  if (typeof view.setBorderRadius === "function") view.setBorderRadius(cardRadius());
  const wc = view.webContents;
  tabs.set(id, view);
  wcToTab.set(wc.id, id);
  win.contentView.addChildView(view);
  if (floating()) raiseUi();
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
  wc.on("did-fail-load", (_e, code, _desc, failedUrl, isMainFrame) => {
    if (isMainFrame && code === -20 /* ERR_BLOCKED_BY_CLIENT */ && focusBlocks(failedUrl)) {
      wc.loadFile(uiFile("blocked.html"), { query: { host: hostKey(failedUrl), until: String(focus.until), url: failedUrl } }).catch(() => {});
    }
  });
  wc.on("did-navigate", (_e, u) => {
    const f = mdFileOfUrl(u);
    if (f) { wc.loadURL(`${MD_PAGE}?file=${encodeURIComponent(f)}`).catch(() => {}); return; }
    send("tab-url", { id, url: u });
  });
  wc.on("did-navigate-in-page", (_e, u, isMainFrame) => { if (isMainFrame) send("tab-url", { id, url: u }); });
  wc.on("page-title-updated", (_e, title) => send("tab-title", { id, title }));
  // Cmd/Ctrl+click opens a background tab; Shift+click (a featureless new window) opens Peek. A popup that asks
  // for a size ("Sign in with Google" and other sign-in flows) gets a real window (see popupWindow); other links
  // and window.open calls become tabs.
  wc.setWindowOpenHandler(({ url: u, disposition, features }) => {
    if (disposition === "new-window" && features) return popupWindow(features);
    if (disposition === "background-tab") send("new-tab-request", { url: u, background: true, from: id });
    else if (disposition === "new-window") openPeek(u);
    else send("new-tab-request", { url: u, from: id });
    return { action: "deny" };
  });
  wc.on("did-create-window", popupCreated);
  wc.on("context-menu", (_e, p) => { const menu = pageMenu(id, wc, p); if (menu.items.length) menu.popup(); });
  wc.on("devtools-opened", () => { if (isOwnPage(wc.getURL())) wc.closeDevTools(); });
  wc.on("will-navigate", (e, u) => { if (isOwnSource(u)) e.preventDefault(); });
  wc.on("audio-state-changed", e => send("tab-audio", { id, audible: typeof e.audible === "boolean" ? e.audible : wc.isCurrentlyAudible(), muted: wc.isAudioMuted() }));
  wc.on("focus", () => send("tab-focused", { id })); // tells the sidebar which split pane is active
  showOnly(id);
  // Give the ad blocker a moment to load its rules so the first page is filtered too.
  perf(`tab ${id}: created`);
  wc.once("did-finish-load", () => perf(`tab ${id}: did-finish-load`));
  Promise.race([blockerReady, sleep(3000)]).then(() => {
    perf(`tab ${id}: loadURL`);
    if (!wc.isDestroyed() && !isOwnSource(url)) wc.loadURL(url).catch(() => {}); // aborted loads (redirects) reject
  });
}

let shownId = null; // the tab on screen (the left pane in split view)
function showOnly(id) {
  shownId = split ? split.left : id;
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

// ---- settings page: shown over the page area like a page of its own ----

let settingsView = null;
let startupTaken = false;

// Full-page views (Settings, Tools) fill the page card but start beside the sidebar instead of under it.
function pageRect() {
  const c = contentRect();
  const x = Math.max(c.x, clearLeft());
  return { x, y: c.y, width: Math.max(c.x + c.w - x, 1), height: c.h };
}

function placeSettings() {
  if (!settingsView) return;
  settingsView.setBounds(pageRect());
}

// Tools: its own page. The sidebar keeps the timers and tracking running (ui/tools.js); this page is the
// interface for them.
let toolsView = null;
function placeTools() {
  if (!toolsView) return;
  toolsView.setBounds(pageRect());
}

function openTools(tab) {
  if (toolsView) {
    if (tab) toolsView.webContents.executeJavaScript(`location.hash = ${JSON.stringify(String(tab))}; location.reload()`).catch(() => {});
    toolsView.webContents.focus();
    return;
  }
  closeSettings();
  toolsView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, partition: uiPartition(config.activeProfile) },
  });
  if (typeof toolsView.setBorderRadius === "function") toolsView.setBorderRadius(cardRadius());
  win.contentView.addChildView(toolsView);
  if (floating()) raiseUi();
  placeTools();
  toolsView.webContents.loadFile(uiFile("tools.html"), tab ? { hash: String(tab) } : undefined);
  toolsView.webContents.focus();
}

function closeTools() {
  if (!toolsView) return;
  win.contentView.removeChildView(toolsView);
  toolsView.webContents.close();
  toolsView = null;
}

function openSettings(section) {
  if (settingsView) { settingsView.webContents.focus(); return; }
  closeTools();
  settingsView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true, partition: uiPartition(config.activeProfile) },
  });
  if (typeof settingsView.setBorderRadius === "function") settingsView.setBorderRadius(cardRadius());
  win.contentView.addChildView(settingsView);
  if (floating()) raiseUi();
  placeSettings();
  settingsView.webContents.loadFile(uiFile("settings.html"), section ? { hash: String(section) } : undefined);
  settingsView.webContents.focus();
  send("settings-open", { open: true });
}

function closeSettings() {
  if (!settingsView) return;
  win.contentView.removeChildView(settingsView);
  settingsView.webContents.close();
  settingsView = null;
  send("settings-open", { open: false });
}

// Glass: the window shows the desktop blurred behind it (macOS vibrancy, Windows 11 acrylic). The sidebar
// page is transparent and the window color carries the frost tint, so sidebar and frame match.
function applyGlass() {
  if (!win || win.isDestroyed()) return;
  if (process.platform === "darwin") win.setVibrancy(S().glass ? glassMaterial() : null);
  if (process.platform === "win32" && typeof win.setBackgroundMaterial === "function") {
    try { win.setBackgroundMaterial(S().glass ? "acrylic" : "none"); } catch {}
  }
}

function applySetting(key) {
  if (key === "glass" || key === "glassStyle") applyGlass();
  if (key === "sidebarMode" && ui) {
    if (floating()) raiseUi();
    animate(collapsed ? HIDE_X : 0, dockedLeft(), 220);
    sidebarState();
  }
  if (key === "theme") nativeTheme.themeSource = S().theme;
  if (key === "compact") {
    for (const v of tabs.values()) if (typeof v.setBorderRadius === "function") v.setBorderRadius(cardRadius());
    if (settingsView && typeof settingsView.setBorderRadius === "function") settingsView.setBorderRadius(cardRadius());
    if (toolsView && typeof toolsView.setBorderRadius === "function") toolsView.setBorderRadius(cardRadius());
    layout();
  }
  if (key === "spellcheck") for (const ses of knownSessions) ses.setSpellCheckerEnabled(S().spellcheck);
}

function settingChanged(key) {
  saveConfig();
  if (key) applySetting(key);
  send("settings-changed", S());
  if (settingsView) settingsView.webContents.send("event", "settings-changed", S());
  if (toolsView) toolsView.webContents.send("event", "settings-changed", S());
}

// Links opened from other apps once Alcove is the default browser.
const isWebUrl = u => /^https?:\/\//i.test(String(u));
const pendingUrls = process.argv.filter(isWebUrl);
function openFromOs(url) {
  if (!isWebUrl(url)) return;
  if (ui && !ui.webContents.isLoading()) send("new-tab-request", { url });
  else pendingUrls.push(url);
  if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
}
app.on("open-url", (e, url) => { e.preventDefault(); openFromOs(url); });

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
  const own = isOwnPage(wc.getURL());
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
      { label: `Search for “${short}”`, click: () => send("new-tab-request", { url: searchUrl(S(), text), from: tabId }) },
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
    if (!own && /^https?:/.test(wc.getURL())) items.push({ label: "Add to Start Page", click: () => send("toast", { text: addShortcut(wc.getURL(), wc.getTitle()) ? "Added to the start page" : "Already on the start page, or the list is full" }) });
    if (!own) items.push({ label: "View Page Source", click: () => send("new-tab-request", { url: `view-source:${wc.getURL()}` }) });
  }
  sep();
  if (!own) items.push({ label: "Inspect", click: () => { wc.openDevTools({ mode: "detach" }); wc.inspectElement(p.x, p.y); } });
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

// ---- Markdown viewer / editor (Tools panel) ----

// The editor is a normal tab showing ui/markdown.html. The session preload gives that one page a file
// bridge (see yt-preload.js); it can only read and write Markdown or text files.
const MD_PAGE = pathToFileURL(uiFile("markdown.html")).href;

// Alcove's own pages (the Markdown editor, the focus-mode page…) are tools, not websites: they don't offer
// "View Page Source" or "Inspect", and their developer tools can't be opened.
const UI_PREFIX = pathToFileURL(path.join(__dirname, "ui") + path.sep).href;
const isOwnPage = u => String(u).startsWith(UI_PREFIX);
const isOwnSource = u => /^view-source:/i.test(String(u)) && isOwnPage(String(u).replace(/^view-source:/i, ""));
const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i;
const MD_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }];
const MD_MAX = 5 * 1024 * 1024;
const mdAllowed = new Set(); // files this session opened or saved: the only ones the editor may write

// Folders: the editor shows a file tree for a folder the user picked (or one picked before, from the recent
// list). It can only list inside those folders, and only shows folders and Markdown or text files.
const mdRoots = new Set();
const MD_SKIP = /^(\.|node_modules$|__pycache__$)/;
const mdInside = p => [...mdRoots].some(r => p === r || p.startsWith(r + path.sep));
const mdName = (s, ext) => {
  const n = String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^\.+/, "").trim().slice(0, 100);
  return n ? (ext && !MD_EXT.test(n) ? n + ext : n) : "";
};

function mdList(dir) {
  dir = path.resolve(String(dir || ""));
  if (!mdInside(dir)) return { error: "That folder isn't open." };
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => !MD_SKIP.test(d.name) && (d.isDirectory() || (d.isFile() && MD_EXT.test(d.name)))) // links are skipped, so a tree can't leave its folder
      .map(d => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    return { dir, entries: entries.slice(0, 2000) };
  } catch { return { error: "Couldn't read this folder." }; }
}

// Graph view: every note in the folder, which notes link to which ([[wiki links]] and relative .md links),
// and the tags in each. Reads each file once; very large files and huge folders are capped.
const MD_NOTE = /\.(md|markdown|mdown|mkd)$/i;
const MD_GRAPH_MAX_FILES = 3000;

function mdScan(text) {
  let body = text, tags = [];
  const fm = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (fm) {
    body = text.slice(fm[0].length);
    const lines = fm[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^tags\s*:\s*(.*)$/i);
      if (!m) continue;
      const v = m[1].trim();
      if (v.startsWith("[")) tags.push(...v.replace(/^\[|\]\s*$/g, "").split(","));
      else if (v) tags.push(...v.split(/[,\s]+/));
      else for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) tags.push(lines[j].replace(/^\s*-\s+/, ""));
    }
  }
  const clean = body.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "").replace(/`[^`\n]*`/g, ""); // links and tags in code don't count
  const wiki = [...clean.matchAll(/\[\[([^\]|#\n]+?)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)].map(m => m[1].trim()).filter(Boolean);
  const rel = [...clean.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]).filter(h => !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith("#"));
  for (const m of clean.matchAll(/(^|[\s(])#([A-Za-z][\w/-]{0,39})(?![\w/-])/g)) tags.push(m[2]);
  tags = [...new Set(tags.map(t => t.trim().replace(/^["']|["']$/g, "").replace(/^#+/, "")).filter(Boolean))];
  return { tags, wiki, rel, words: (body.match(/\S+/g) || []).length };
}

// Every file of the given kind under a folder (hidden folders, node_modules and links are skipped).
async function mdFiles(rootDir, kind = MD_EXT) {
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 12) return;
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (files.length >= MD_GRAPH_MAX_FILES) return;
      if (MD_SKIP.test(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full, depth + 1);
      else if (d.isFile() && kind.test(d.name)) files.push(full);
    }
  };
  await walk(rootDir, 0);
  return files;
}

// Search across the loaded folders: text in notes (and their names), or #tags. With no query it returns the
// tags in use instead, so the panel can offer them. Reads each file once; results are capped.
async function mdSearch(o) {
  const roots = (Array.isArray(o && o.roots) ? o.roots : []).map(r => path.resolve(String(r))).filter(r => mdRoots.has(r));
  if (!roots.length) return { error: "Load a folder first." };
  const q = String((o && o.q) || "").trim().slice(0, 200);
  const tagMode = q.length > 1 && q.startsWith("#");
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = null;
  if (q && !tagMode) {
    try { re = new RegExp(o.regex ? q : esc(q), o.matchCase ? "g" : "gi"); } catch { return { error: "That isn't a valid pattern." }; }
  }
  const want = tagMode ? q.slice(1).toLowerCase() : "";
  const found = [];
  for (const r of roots) for (const f of await mdFiles(r)) found.push({ root: r, path: f });
  const rows = new Array(found.length), tagCount = new Map();
  let next = 0;
  const worker = async () => {
    while (next < found.length) {
      const i = next++, { root: r, path: f } = found[i];
      let text = "";
      try { const st = await fs.promises.stat(f); if (st.size <= 1024 * 1024) text = await fs.promises.readFile(f, "utf8"); } catch {}
      const name = path.basename(f);
      const row = { path: f, name, root: r, rel: path.relative(r, f).split(path.sep).join("/"), tags: [], matches: [], nameMatch: false };
      if (!q || tagMode) {
        const tags = mdScan(text).tags;
        if (!q) for (const t of tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
        const hit = tags.filter(t => t.toLowerCase().startsWith(want));
        if (tagMode && hit.length) {
          row.tags = hit;
          const inline = new RegExp(`(^|[\\s(])#(?:${hit.map(esc).join("|")})(?![\\w/-])`, "i");
          const lines = text.split("\n");
          let fenced = false;
          lines.forEach((line, ln) => {
            if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
            if (fenced || row.matches.length >= 30) return;
            const mm = inline.exec(line);
            if (mm) { const col = mm.index + mm[1].length; row.matches.push({ line: ln + 1, col, len: line.slice(col).match(/^#[\w/-]+/)[0].length, text: line.slice(Math.max(0, col - 60), col + 120), at: Math.min(col, 60), nth: 0 }); }
            else if (ln < 40 && /^tags\s*:/i.test(line)) row.matches.push({ line: ln + 1, col: 0, len: line.length, text: line.slice(0, 160), at: 0, nth: 0, front: true });
          });
          rows[i] = row;
        }
        continue;
      }
      row.nameMatch = (() => { re.lastIndex = 0; return re.test(name); })();
      const seen = new Map();
      const lines = text.split("\n");
      for (let ln = 0; ln < lines.length && row.matches.length < 30; ln++) {
        const line = lines[ln].replace(/\r$/, "");
        if (line.length > 4000) continue;
        re.lastIndex = 0;
        let mm;
        while ((mm = re.exec(line)) && row.matches.length < 30) {
          if (!mm[0]) { re.lastIndex++; continue; }
          const key = o.matchCase ? mm[0] : mm[0].toLowerCase(), nth = seen.get(key) || 0;
          seen.set(key, nth + 1);
          const from = Math.max(0, mm.index - 60);
          row.matches.push({ line: ln + 1, col: mm.index, len: mm[0].length, text: line.slice(from, mm.index + mm[0].length + 120), at: mm.index - from, nth, found: mm[0] });
        }
      }
      if (row.matches.length || row.nameMatch) rows[i] = row;
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  if (!q) return { tags: [...tagCount].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 300), files: found.length };
  const results = rows.filter(Boolean).sort((x, y) => (y.matches.length - x.matches.length) || x.name.localeCompare(y.name));
  return {
    q, tagMode, files: found.length,
    total: results.reduce((n, r) => n + r.matches.length, 0),
    results: results.slice(0, 150),
    truncated: results.length > 150 || found.length >= MD_GRAPH_MAX_FILES,
  };
}

async function mdGraph(rootDir) {
  rootDir = path.resolve(String(rootDir || ""));
  if (!mdRoots.has(rootDir)) return { error: "That folder isn't open." };
  const files = await mdFiles(rootDir, MD_NOTE);

  const scans = new Array(files.length);
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      try {
        const st = await fs.promises.stat(files[i]);
        scans[i] = st.size > 1024 * 1024 ? { tags: [], wiki: [], rel: [], words: 0 } : mdScan(await fs.promises.readFile(files[i], "utf8"));
      } catch { scans[i] = { tags: [], wiki: [], rel: [], words: 0 }; }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));

  const posix = f => path.relative(rootDir, f).split(path.sep).join("/");
  const noExt = s => s.replace(/\.(md|markdown|mdown|mkd)$/i, "");
  const byAbs = new Map(), byRel = new Map(), byName = new Map();
  files.forEach((f, i) => {
    byAbs.set(f, i);
    byAbs.set(f.toLowerCase(), i);
    const r = noExt(posix(f)).toLowerCase();
    byRel.set(r, i);
    const n = r.split("/").pop();
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(i);
  });
  const resolveWiki = name => {
    const key = noExt(name.replace(/\\/g, "/")).toLowerCase();
    if (byRel.has(key)) return byRel.get(key);
    const c = byName.get(key.split("/").pop());
    if (!c) return -1;
    const exact = key.includes("/") ? c.find(i => noExt(posix(files[i])).toLowerCase().endsWith("/" + key)) : undefined;
    return exact ?? c.slice().sort((a, b) => files[a].length - files[b].length)[0]; // the shallowest match, like most note apps
  };

  const edges = new Set(), ghosts = new Map();
  files.forEach((f, i) => {
    const link = j => { if (j >= 0 && j !== i) edges.add(i < j ? `${i},${j}` : `${j},${i}`); };
    for (const w of scans[i].wiki) {
      const j = resolveWiki(w);
      if (j >= 0) link(j);
      else { const k = w.toLowerCase(); if (!ghosts.has(k)) ghosts.set(k, { name: w, from: new Set() }); ghosts.get(k).from.add(i); }
    }
    for (const h of scans[i].rel) {
      let target;
      try { target = decodeURIComponent(h.split("#")[0].split("?")[0]); } catch { continue; }
      if (!target) continue;
      const abs = path.resolve(path.dirname(f), target);
      link(byAbs.get(abs) ?? byAbs.get(abs.toLowerCase()) ?? byAbs.get(abs + ".md") ?? -1);
    }
  });

  return {
    root: rootDir,
    nodes: files.map((f, i) => ({ path: f, name: noExt(path.basename(f)), folder: path.posix.dirname(posix(f)).replace(/^\.$/, ""), tags: scans[i].tags, words: scans[i].words })),
    edges: [...edges].map(e => e.split(",").map(Number)),
    ghosts: [...ghosts.values()].slice(0, 500).map(g => ({ name: g.name, from: [...g.from] })),
    truncated: files.length >= MD_GRAPH_MAX_FILES,
  };
}

function mdAdoptRoot(p) {
  const rootDir = path.resolve(p);
  mdRoots.add(rootDir);
  config.recentMdFolders = [rootDir, ...(config.recentMdFolders || []).filter(x => x !== rootDir)].slice(0, 20);
  saveConfig();
  return { root: rootDir, ...mdList(rootDir) };
}

const mdRemember = p => {
  config.recentMd = [p, ...(config.recentMd || []).filter(x => x !== p)].slice(0, 8);
  saveConfig();
};

function mdRead(p) {
  p = path.resolve(String(p || ""));
  if (!MD_EXT.test(p)) return { error: "Only Markdown or text files can be opened here." };
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { error: "That isn't a file." };
    if (st.size > MD_MAX) return { error: "This file is larger than 5 MB." };
    const text = fs.readFileSync(p, "utf8");
    mdAllowed.add(p);
    mdRemember(p);
    return { path: p, text };
  } catch (e) {
    return { error: e.code === "ENOENT" ? "File not found." : "Couldn't read this file." };
  }
}

function mdWrite(p, text) {
  if (typeof text !== "string" || text.length > 2 * MD_MAX) return { error: "Nothing to save, or the document is too large." };
  try {
    const tmp = `${p}.alcove-tmp`;
    fs.writeFileSync(tmp, text, "utf8");
    fs.renameSync(tmp, p); // never leaves a half-written file behind
    mdAllowed.add(p);
    mdRemember(p);
    return { path: p };
  } catch { return { error: "Couldn't save the file. Check that the folder is writable." }; }
}

// The start page (ui/newtab.html, what a new tab shows) reads the Tools engine's saved state from the sidebar and
// can start a timer or open a tool. It is the only caller allowed, and it can only run the ops listed here.
const NEWTAB_PAGE = pathToFileURL(uiFile("newtab.html")).href;
const MAX_SHORTCUTS = 24;
const cleanShortcuts = list => (Array.isArray(list) ? list : []).flatMap(x => {
  try {
    const u = new URL(String(x && x.url));
    if (!/^https?:$/.test(u.protocol)) return [];
    const name = String((x && x.name) || u.hostname.replace(/^www\./, "")).trim().slice(0, 40);
    return [{ name: name || u.hostname, url: u.href }];
  } catch { return []; }
}).slice(0, MAX_SHORTCUTS);
function addShortcut(url, name) { // false when it isn't a website, is already there, or the list is full
  const [item] = cleanShortcuts([{ url, name }]);
  if (!item || (config.shortcuts || []).some(x => x.url === item.url)) return false;
  if ((config.shortcuts || []).length >= MAX_SHORTCUTS) return false;
  config.shortcuts = [...(config.shortcuts || []), item];
  saveConfig();
  return true;
}
const START_OPS = { "timer-start": m => [Math.min(600, Math.max(1, Math.round(Number(m)) || 25))], "pomo-start": () => [] };
ipcMain.handle("alcove-start", async (e, op, a, b) => {
  if (!e.senderFrame || e.senderFrame.url.split(/[?#]/)[0] !== NEWTAB_PAGE) throw new Error("forbidden");
  if (op === "settings") return { searchEngine: S().searchEngine, customSearch: S().customSearch, accent: S().accent };
  if (op === "tools-data") { // the Tools engine's state, time tracking, to-dos and to-do tallies: JSON text, or null
    if (!ui || ui.webContents.isDestroyed()) return null;
    const keys = ["alcove-tools-v1", "alcove-time-v1", "alcove-todos-v1", "alcove-done-v1"];
    return ui.webContents.executeJavaScript(`JSON.stringify(${JSON.stringify(keys)}.map(k => localStorage.getItem(k)))`).catch(() => null);
  }
  if (op === "shortcuts") return config.shortcuts || [];
  if (op === "shortcuts-set") { config.shortcuts = cleanShortcuts(a); saveConfig(); return config.shortcuts; }
  if (op === "copy") { clipboard.writeText(String(a).slice(0, 8000)); return; }
  if (op === "tools") { setImmediate(() => openTools(String(a || "timers").slice(0, 20))); return; }
  if (op === "markdown") { e.sender.loadURL(MD_PAGE).catch(() => {}); return; }
  if (op === "op" && Object.hasOwn(START_OPS, a)) { send("tools-op", { op: a, args: START_OPS[a](b) }); return; }
  throw new Error("unknown op");
});

ipcMain.handle("alcove-md", async (e, op, a, b) => {
  if (!e.senderFrame || e.senderFrame.url.split(/[?#]/)[0] !== MD_PAGE) throw new Error("forbidden");
  if (op === "read") return mdRead(a);
  if (op === "openFolder") {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"], defaultPath: app.getPath("documents") });
    return canceled || !filePaths[0] ? null : mdAdoptRoot(filePaths[0]);
  }
  if (op === "folder") { // reopening a folder chosen earlier
    const p = path.resolve(String(a || ""));
    return (config.recentMdFolders || []).includes(p) && fs.existsSync(p) ? mdAdoptRoot(p) : { error: "Choose the folder again." };
  }
  if (op === "list") return mdList(a);
  if (op === "unmount") { // the editor can no longer list this folder; forget: also drop it from the recent list
    const r = path.resolve(String(a || ""));
    mdRoots.delete(r);
    if (b) { config.recentMdFolders = (config.recentMdFolders || []).filter(x => x !== r); saveConfig(); }
    return true;
  }
  if (op === "forget") { // clear the recent list, keeping what's mounted
    config.recentMdFolders = (config.recentMdFolders || []).filter(x => mdRoots.has(x));
    saveConfig();
    return true;
  }
  if (op === "reveal") {
    const r = path.resolve(String(a || ""));
    if (mdInside(r) && fs.existsSync(r)) shell.showItemInFolder(r);
    return true;
  }
  if (op === "recentFolders") return (config.recentMdFolders || []).filter(d => fs.existsSync(d));
  if (op === "graph") return mdGraph(a);
  if (op === "search") return mdSearch(a || {});
  if (op === "newFile" || op === "newFolder") {
    const dir = path.resolve(String(a || ""));
    if (!mdInside(dir)) return { error: "That folder isn't open." };
    const name = mdName(b || "Untitled", op === "newFile" ? ".md" : "");
    if (!name) return { error: "Give it a name." };
    const target = path.join(dir, name);
    try {
      if (fs.existsSync(target)) return { error: `“${name}” already exists.` };
      if (op === "newFile") { fs.writeFileSync(target, "", { flag: "wx" }); mdAllowed.add(target); mdRemember(target); }
      else fs.mkdirSync(target);
      return { path: target };
    } catch { return { error: "Couldn't create that. Check that the folder is writable." }; }
  }
  if (op === "open") {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: MD_FILTERS, defaultPath: app.getPath("documents") });
    return canceled || !filePaths[0] ? null : mdRead(filePaths[0]);
  }
  if (op === "save") {
    const p = path.resolve(String(a || ""));
    return mdAllowed.has(p) && MD_EXT.test(p) ? mdWrite(p, b) : { error: "Use Save As to choose where this goes." };
  }
  if (op === "saveAs") {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("documents"), String(a || "Untitled.md").replace(/[\\/:*?"<>|]+/g, "-")),
      filters: MD_FILTERS,
    });
    if (canceled || !filePath) return null;
    return mdWrite(MD_EXT.test(filePath) ? filePath : `${filePath}.md`, b);
  }
  throw new Error("unknown operation");
});

// A .md file opened in a tab (typed, dropped, or from a link) shows in the editor, in view mode.
const mdFileOfUrl = u => {
  try {
    const x = new URL(u);
    return x.protocol === "file:" && /\.(md|markdown|mdown|mkd)$/i.test(x.pathname) ? fileURLToPath(x) : null;
  } catch { return null; }
};

// ---- page helpers (Tools panel) ----

// Images on the page that are big enough to matter (icons and tracking pixels are skipped).
async function pageImages(id) {
  const wc = wcOf(id);
  if (!wc) return [];
  const list = await wc.executeJavaScript(`(() => {
    const out = new Map();
    const add = (u, w, h) => { try { u = new URL(u, location.href).href; } catch { return; } if (/^https?:/.test(u) && !out.has(u)) out.set(u, { url: u, w, h }); };
    for (const i of document.images) if (i.naturalWidth >= 120 && i.naturalHeight >= 120) add(i.currentSrc || i.src, i.naturalWidth, i.naturalHeight);
    const og = document.querySelector('meta[property="og:image"]');
    if (og && og.content) add(og.content, 0, 0);
    return [...out.values()].slice(0, 300);
  })()`).catch(() => []);
  return Array.isArray(list) ? list : [];
}

const IMAGE_EXT = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/avif": ".avif", "image/svg+xml": ".svg" };

// Saves every image from pageImages into <downloads>/Alcove images/<site> <time>/.
async function saveImages(id) {
  const wc = wcOf(id);
  const images = await pageImages(id);
  if (!wc || !images.length) return { saved: 0, total: 0, dir: null };
  const d = new Date(), p2 = n => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}`;
  const dir = path.join(downloadDir(), "Alcove images", `${hostKey(wc.getURL()) || "page"} ${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  const referer = wc.getURL();
  let saved = 0, next = 0;
  const worker = async () => {
    while (next < images.length) {
      const i = next++;
      try {
        const u = new URL(images[i].url);
        const res = await wc.session.fetch(u.href, { headers: { referer } });
        if (!res.ok) continue;
        const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const ext0 = path.extname(u.pathname).toLowerCase();
        const ext = IMAGE_EXT[type] || (/^\.(jpe?g|png|webp|gif|avif|svg)$/.test(ext0) ? ext0 : ".jpg");
        const base = path.basename(u.pathname, path.extname(u.pathname)).replace(/[^\w.-]+/g, "_").slice(0, 60) || "image";
        fs.writeFileSync(path.join(dir, `${String(i + 1).padStart(2, "0")}-${base}${ext}`), Buffer.from(await res.arrayBuffer()));
        saved++;
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (saved) shell.openPath(dir);
  return { saved, total: images.length, dir };
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
    defaultPath: path.join(downloadsFolder(), `Alcove ${stamp}.png`),
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
const downloadDir = () => process.env.ALCOVE_DOWNLOAD_DIR || downloadsFolder(); // env override is for tests

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
  const left = clearLeft();
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
  const left = dockedLeft();
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
      backgroundThrottling: false, // the Tools panel's timers and time tracking keep ticking in the background
    },
  });
  ui.setBackgroundColor("#00000000"); // lets the glass show through when it's on
  ui.webContents.on("will-navigate", e => e.preventDefault());
  ui.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.contentView.addChildView(ui);
  ui.webContents.once("did-finish-load", () => {
    perf("sidebar: did-finish-load");
    sidebarState(); // tells the sidebar page whether it floats over the page
    introPeek();
    // Links handed over by the OS before the sidebar was ready.
    setTimeout(() => { for (const u of pendingUrls.splice(0)) send("new-tab-request", { url: u }); }, 800);
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
  contentLeft = dockedLeft();
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
  closeSettings();
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
  navigate: ({ id, url }) => { if (!isOwnSource(url)) wcOf(id)?.loadURL(url).catch(() => {}); },
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
  // Test hook: runs the window-button hover logic for a point relative to the window.
  debug_window_buttons: ({ x, y }) => {
    if (process.env.ALCOVE_TEST !== "1") return null;
    const b = win.getContentBounds();
    windowButtons({ x: b.x + x, y: b.y + y }, b);
    return { shown: buttonsShown, collapsed, peeking, content: contentRect(),
      pos: typeof win.getWindowButtonPosition === "function" ? win.getWindowButtonPosition() : null };
  },
  debug_page_menu: ({ id, params }) => process.env.ALCOVE_TEST === "1" && wcOf(id)
    ? pageMenu(id, wcOf(id), { mediaType: "none", selectionText: "", isEditable: false, linkURL: "", srcURL: "", x: 0, y: 0, ...params }).items.map(i => i.type === "separator" ? "—" : i.label || i.role)
    : null,
  debug_layout: () => { // test hook: where the views are
    if (process.env.ALCOVE_TEST !== "1") return null;
    const b = v => (v ? v.getBounds() : null);
    return { win: win.getContentBounds(), ui: b(ui), strip: b(strip), caption: b(caption), captionVisible: caption ? caption.getVisible() : null, page: contentRect(), maximized: win.isMaximized(), IS_WIN };
  },
  debug_open_devtools: async ({ id }) => { // test hook: try to open the developer tools on a tab and say whether they stayed open
    if (process.env.ALCOVE_TEST !== "1" || !wcOf(id)) return null;
    wcOf(id).openDevTools({ mode: "detach" });
    await sleep(900);
    const open = wcOf(id).isDevToolsOpened();
    if (open) wcOf(id).closeDevTools();
    return { open };
  },
  peek_close: () => { setImmediate(closePeek); },
  peek_open_tab: () => { setImmediate(peekToTab); },
  pip: ({ id }) => pictureInPicture(wcOf(id)),
  copy_text: ({ text }) => clipboard.writeText(String(text)),
  add_shortcut: ({ url, name }) => addShortcut(url, name), // the sidebar's tab menu: "Add to start page"
  // Tools panel
  md_url: () => MD_PAGE,
  md_recent: () => (config.recentMd || []).filter(p => fs.existsSync(p)),
  md_recent_folders: () => (config.recentMdFolders || []).filter(p => fs.existsSync(p)),
  notify: ({ title, body }) => {
    if (Notification.isSupported()) new Notification({ title: String(title || "").slice(0, 80), body: String(body || "").slice(0, 200) }).show();
  },
  activity: () => ({ focused: !!win && !win.isDestroyed() && win.isFocused(), idle: powerMonitor.getSystemIdleTime() }),
  focus_mode: ({ minutes, sites }) => {
    const m = Number(minutes);
    if (!(m > 0)) { focus = null; return null; }
    const list = (Array.isArray(sites) ? sites : [])
      .map(s => String(s).toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[\/?#].*$/, ""))
      .filter(s => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s));
    focus = { until: Date.now() + Math.min(m, 480) * 60000, sites: list };
    return { until: focus.until, sites: list };
  },
  focus_state: () => { const f = focusActive(); return f ? { until: f.until, sites: f.sites } : null; },
  eyedropper: async ({ id }) => {
    const wc = wcOf(id);
    if (!wc) return null;
    closeTools(); // the picker samples the screen, so the Tools page can't be covering the tab
    send("toast", { text: "Click anywhere to pick a color. Esc cancels.", ms: 4000 });
    try {
      const hex = await wc.executeJavaScript("new EyeDropper().open().then(r => r.sRGBHex)", true);
      if (hex) { clipboard.writeText(hex); send("toast", { text: `${hex} copied` }); }
      return hex || null;
    } catch { return null; } // cancelled with Esc, or the page can't be sampled
  },
  page_images: ({ id }) => pageImages(id),
  save_images: ({ id }) => saveImages(id),

  // Settings
  get_app_settings: () => S(),
  // The "on startup" preference applies once per launch (the sidebar reloads when switching profiles).
  take_startup: () => { if (startupTaken) return null; startupTaken = true; return { mode: S().startup, url: S().startupUrl }; },
  set_app_setting: ({ key, value }) => {
    if (!SETTING_RULES[key] || !SETTING_RULES[key](value)) throw new Error(`invalid setting: ${key}`);
    S()[key] = value;
    settingChanged(key);
    return S();
  },
  choose_download_dir: async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: "Choose where downloads are saved", defaultPath: downloadsFolder(), properties: ["openDirectory", "createDirectory"],
    });
    if (canceled || !filePaths[0]) return null;
    S().downloadDir = filePaths[0];
    settingChanged("downloadDir");
    return filePaths[0];
  },
  reset_settings: () => {
    config.settings = { ...DEFAULT_SETTINGS };
    for (const k of Object.keys(DEFAULT_SETTINGS)) applySetting(k);
    settingChanged();
    return S();
  },
  get_app_info: () => ({
    version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome,
    platform: process.platform, packaged: app.isPackaged, isDefault: app.isDefaultProtocolClient("https"),
    clearActive: wantsClear(),
    downloadDir: downloadsFolder(), adblock: config.adblock, sponsorBlock: config.sponsorBlock,
  }),
  set_default_browser: () => {
    if (!app.isPackaged) return { ok: false, reason: "Only the installed app can become the default browser." };
    const ok = app.setAsDefaultProtocolClient("http") && app.setAsDefaultProtocolClient("https");
    return { ok, isDefault: app.isDefaultProtocolClient("https") };
  },
  clear_data: async ({ cookies, cache }) => {
    const ses = activeWebSession();
    if (cookies) await ses.clearStorageData();
    if (cache) await ses.clearCache();
    return true;
  },
  get_site_settings: () => ({
    permissions: Object.entries(config.sitePermissions).map(([key, allowed]) => ({
      key, origin: key.split(" ")[0], permission: key.split(" ").slice(1).join(" "), allowed,
    })),
    adblockAllow: config.adblockAllow,
    forceDark: config.forceDark,
  }),
  remove_site_permission: ({ key }) => { delete config.sitePermissions[String(key)]; saveConfig(); },
  remove_force_dark: ({ host }) => {
    config.forceDark = config.forceDark.filter(h => h !== host);
    saveConfig();
    for (const v of tabs.values()) if (hostKey(v.webContents.getURL()) === host) applyDark(v.webContents, false);
  },
  open_settings: ({ section } = {}) => openSettings(section),
  close_settings: () => { setImmediate(() => { closeSettings(); closeTools(); }); }, // choosing a tab shows that tab
  open_tools: ({ tab } = {}) => { setImmediate(() => openTools(tab)); },
  close_tools: () => { setImmediate(closeTools); },
  toggle_tools: () => { setImmediate(() => (toolsView ? closeTools() : openTools())); },
  tools_op: ({ op, args }) => { send("tools-op", { op, args }); }, // the sidebar runs the Tools engine
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
  hide_palette: () => { setImmediate(hidePalette); },
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
  // Window color behind the sidebar and around the page card (translucent when glass is on).
  set_chrome_color: ({ color }) => {
    const c = String(color);
    if (/^#[0-9a-f]{6}$/i.test(c) || /^rgba\(\d{1,3}, ?\d{1,3}, ?\d{1,3}, ?(0|1|0?\.\d+)\)$/.test(c)) win.setBackgroundColor(c);
  },
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
  [ui, palette, region, shotView, peekBackdrop, divider, strip, caption, settingsView, toolsView].some(v => v && e.sender === v.webContents);

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
    ...(mac ? [{ label: app.name, submenu: [
      { role: "about" },
      { type: "separator" },
      { label: "Settings…", accelerator: "Cmd+,", click: () => openSettings() },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ] }] : []),
    { label: "File", submenu: [
      item("new-tab", "New Tab", "CmdOrCtrl+T"),
      item("reopen-tab", "Reopen Closed Tab", "CmdOrCtrl+Shift+T"),
      item("close-tab", "Close Tab", "CmdOrCtrl+W"),
      { type: "separator" },
      item("palette", "Command Palette", "CmdOrCtrl+K"),
      item("focus-address", "Open Location", "CmdOrCtrl+L"),
      item("bookmark", "Bookmark This Page", "CmdOrCtrl+D"),
      ...(mac ? [] : [{ label: "Settings…", accelerator: "Ctrl+,", click: () => openSettings() }]),
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
      item("tools", "Show Tools", "CmdOrCtrl+Shift+U"),
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

app.on("second-instance", (_e, argv) => {
  for (const u of (argv || []).filter(isWebUrl)) openFromOs(u);
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
  nativeTheme.themeSource = S().theme;
  collapsed = !!config.collapsed;
  ensureSession(config.activeProfile);
  blockerReady = initBlocker();
  Menu.setApplicationMenu(buildMenu());

  const p = activeProfile();
  win = new BaseWindow({
    width: 1280, height: 800, minWidth: 640, minHeight: 400,
    title: p.id === "default" ? "Alcove" : `Alcove — ${p.name}`,
    backgroundColor: S().glass ? "#00000000" : nativeTheme.shouldUseDarkColors ? "#1d1d20" : "#ececef",
    ...(process.platform === "darwin" && S().glass ? { vibrancy: glassMaterial(), visualEffectState: "active" } : {}),
    autoHideMenuBar: true,
    // No title bar: window controls live in the sidebar (native lights on macOS, drawn ones elsewhere).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hidden", trafficLightPosition: { x: 18, y: 15 } }
      : { frame: false }),
  });
  perf("window created");
  if (process.platform === "darwin") {
    win.setWindowButtonVisibility(false); // shown on hover (windowButtons)
    buttonsShown = false;
    win.on("leave-full-screen", () => { buttonsShown = null; }); // macOS may restore them; set again
  }
  if (process.platform === "win32") applyGlass();
  createUi();
  createStrip();
  if (IS_WIN) createCaption();
  win.on("resize", layout);
  watchCursor();
});

app.on("window-all-closed", () => app.quit());
