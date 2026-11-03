const {
  app, BaseWindow, BrowserWindow, WebContentsView, Menu, ipcMain, shell, session, screen, nativeTheme, clipboard, ClipboardItem, dialog, net, nativeImage, systemPreferences, Notification, powerMonitor,
} = require("electron");
const AdmZip = require("adm-zip");
const { crxToZip, verifyCrx } = require("./crx");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const { pathToFileURL, fileURLToPath } = require("url");
const { searchUrl } = require(path.join(__dirname, "ui", "engines.js"));

// A bug in one place must not put Electron's native error dialog in front of the user (a page closing itself while a timer
// still holds its view, for one): log it and carry on.
// Before the window is up nothing can work, so an error then is shown and the app quits (rather than sitting there with no
// window and no message).
const onProcessError = kind => err => {
  console.error(`${kind}:`, (err && err.stack) || err);
  if (globalThis.__alcoveStarted) return;
  try { require("electron").dialog.showErrorBox("Alcove couldn't start", String((err && err.message) || err)); } catch {}
  require("electron").app.exit(1);
};
process.on("uncaughtException", onProcessError("uncaught exception"));
process.on("unhandledRejection", onProcessError("unhandled rejection"));

// Windows attributes notifications (the alarms) and the taskbar entry to this id; it matches the installer's appId.
if (process.platform === "win32") app.setAppUserModelId("com.xupbrands.alcove");

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
  lastUpdateCheck: 0, // when the start-up update check last ran (ms)
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
  checkUpdates: false,                      // ask GitHub for a newer release when Alcove starts (at most once a day); off unless the user turns it on
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
  checkUpdates: v => typeof v === "boolean",
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

const isPlainObject = v => !!v && typeof v === "object" && !Array.isArray(v);
// A JSON file's content: undefined if it isn't there, null if it can't be read or parsed, else the parsed value.
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return e.code === "ENOENT" ? undefined : null; }
}

function loadConfig() {
  const file = configPath();
  let saved = readJsonFile(file);
  if (saved !== undefined && !isPlainObject(saved)) {
    // Damaged (a crash or a full disk mid-write, or a file edited by hand). Never overwrite it blindly: set it aside
    // and fall back to the last good copy that saveConfig keeps, if there is one.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {}
    console.error("config.json was unreadable; set aside, using the backup if there is one");
    const backup = readJsonFile(`${file}.bak`);
    saved = isPlainObject(backup) ? backup : undefined;
  }
  config = { ...config, ...(saved || {}) };
  // Whatever was saved, the rest of the app can rely on these shapes.
  for (const k of ["adblockAllow", "forceDark", "shortcuts", "recentMd", "recentMdFolders"]) if (!Array.isArray(config[k])) config[k] = [];
  if (!isPlainObject(config.sitePermissions)) config.sitePermissions = {};
  if (typeof config.lastUpdateCheck !== "number") config.lastUpdateCheck = 0;
  config.profiles = (Array.isArray(config.profiles) ? config.profiles : [])
    .filter(p => isPlainObject(p) && typeof p.id === "string" && p.id && typeof p.name === "string")
    .map(p => ({ id: p.id, name: p.name.slice(0, 60), color: typeof p.color === "string" ? p.color : COLORS[0] }));
  if (!config.profiles.some(p => p.id === "default")) config.profiles.unshift({ id: "default", name: "Default", color: COLORS[0] });
  // Settings keep only values that pass their rule (a bad zoom or search URL would break every tab or search); the
  // download folder is chosen in a dialog, so any string is a valid saved value.
  const given = isPlainObject(config.settings) ? config.settings : {};
  config.settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(given)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (k === "downloadDir" ? typeof v === "string" : SETTING_RULES[k] && SETTING_RULES[k](v)) config.settings[k] = v;
  }
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
// Written to a temporary file and renamed over the real one, so a crash or a full disk can't leave half a file; the
// previous version is kept as config.json.bak, which loadConfig falls back to.
function saveConfig() {
  if (privateSnapshot) return; // private mode: nothing reaches the disk
  const file = configPath(), tmp = `${file}.tmp`;
  const text = JSON.stringify(config, null, 2);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    try { fs.copyFileSync(file, `${file}.bak`); } catch {}
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.writeFileSync(file, text, { mode: 0o600 }); } catch { console.error("couldn't save config:", e.message); } // e.g. a locked file on Windows
  }
}

// Each profile gets its own cookie jar (web) and its own sidebar storage (ui: tabs, bookmarks, history).
// The default profile keeps the original partitions so existing data carries over.
// Private mode is a throwaway profile (id PRIVATE, never in config.profiles). Its partitions have no "persist:" prefix, so
// cookies, cache, tabs, history, bookmarks, timers and notes live in memory only. privateToken is new for every private session,
// so nothing carries over from the last one even though the process lives on.
const PRIVATE = "private";
let privateToken = "";
const webPartition = id => (id === PRIVATE ? `alcove-private-${privateToken}` : id === "default" ? "persist:alcove" : `persist:web-${id}`);
const uiPartition = id => (id === PRIVATE ? `alcove-private-ui-${privateToken}` : id === "default" ? undefined : `persist:ui-${id}`);
// The config as it was when private mode began. While it is set saveConfig writes nothing, and leaving private mode puts it
// back, so no permission, allow-list entry, recent file or setting touched in private mode survives it.
let privateSnapshot = null;

// ---- state ----

let win;
let ui;
let palette = null;
// A view whose page has been destroyed (it closed itself, or was closed) has no webContents any more.
const deadView = v => !v || !v.webContents || v.webContents.isDestroyed();
const tabs = new Map();      // tab id -> WebContentsView
const wcToTab = new Map();   // webContents id -> tab id
let shuttingDown = false;    // the app is quitting (its pages are being destroyed on purpose)
app.on("before-quit", () => { shuttingDown = true; });
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
let sideCover = 0;      // x of the right edge of a shown, floating sidebar (0 when hidden); animates with it. The start page lays itself out right of it
const coverTarget = () => (collapsed ? 0 : SIDEBAR_W + MARGIN);
let animTimer = null;
let peekHoldUntil = 0; // keeps the startup peek on screen briefly
let dragTimer = null;

const send = (name, payload) => {
  if (!deadView(ui)) ui.webContents.send("event", name, payload);
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
  placePalette();
  sendInset(c);
}

// The start page lays itself out right of a floating sidebar (the sidebar floats over every page, and its content
// would otherwise sit partly under it). It is told how many pixels of its left edge are covered, now and as the sidebar
// slides or the window resizes; docked, the page view already starts beside the sidebar, so the answer is 0.
const insetSent = new WeakMap(); // webContents -> last value the page has
const insetFor = c => (floating() ? Math.max(0, Math.round(sideCover) - c.x) : 0);
function sendInset(c) {
  const inset = insetFor(c);
  for (const v of tabs.values()) {
    const wc = v.webContents;
    if (!wc || wc.isDestroyed() || insetSent.get(wc) === inset || !wc.getURL().startsWith(NEWTAB_PAGE)) continue;
    insetSent.set(wc, inset);
    wc.send("alcove-inset", inset);
  }
}

// The margin above the page doubles as a title bar: drag to move the window, double-click to zoom.
let strip = null;
let caption = null; // Windows only: the Minimize / Maximize / Close buttons, over the page's top right corner while shown
function createStrip() {
  strip = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  strip.setBackgroundColor("#00000000");
  strip.webContents.loadFile(uiFile("strip.html")).catch(() => {});
  win.contentView.addChildView(strip);
  layout();
}

// Windows: flat Minimize / Maximize-Restore / Close at the top right. Hidden until the pointer goes there.
function createCaption() {
  caption = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  caption.setBackgroundColor("#00000000");
  caption.webContents.loadFile(uiFile("caption.html")).catch(() => {});
  win.contentView.addChildView(caption);
  caption.setVisible(false);
  const state = () => { if (!deadView(caption)) caption.webContents.send("event", "window-state", { maximized: win.isMaximized() }); };
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
  if (!floating() || (collapsed && !peeking) || Math.abs(sidebarX) > 1 || !win.isVisible() || win.isMinimized() || !win.isFocused()) return;
  const v = tabs.get(shownId);
  if (deadView(v)) return;
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
function animate(toX, toLeft, ms = 200, toCover = sideCover) {
  clearInterval(animTimer);
  const fromX = sidebarX;
  const fromLeft = contentLeft;
  const fromCover = sideCover;
  const start = Date.now();
  animTimer = setInterval(() => {
    const t = Math.min((Date.now() - start) / ms, 1);
    const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
    sidebarX = fromX + (toX - fromX) * e;
    contentLeft = fromLeft + (toLeft - fromLeft) * e;
    sideCover = fromCover + (toCover - fromCover) * e;
    layout();
    if (t === 1) clearInterval(animTimer);
  }, 16);
}

const sidebarState = () => send("sidebar-state", { collapsed, peek: peeking, floating: floating() });

function peek(on) {
  if (!collapsed || peeking === on) return;
  peeking = on;
  if (on) raiseUi();
  animate(on ? 0 : HIDE_X, contentLeft, 180, coverTarget()); // a peek is an overlay: the start page does not move for it (cover stays 0 while hidden)
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
  animate(collapsed ? HIDE_X : 0, dockedLeft(), 240, coverTarget());
  sidebarState();
}

// Cursor polling is simpler and more reliable than a transparent hot-zone view over the page.
function watchCursor() {
  // Polled every 50 ms while it matters (the window is focused, or the pointer is over it: peek and the window buttons), and
  // every 250 ms otherwise, so an idle or covered window isn't woken twenty times a second.
  let slow = false;
  const poll = () => {
    setTimeout(() => { try { tickCursor(); } finally { poll(); } }, slow ? 250 : 50);
  };
  const tickCursor = () => {
    if (extPopup && deadView(extPopup)) closeExtPopup();
    if (extPopup) {
      if (extPopup.webContents.isFocused()) extPopupFocused = true;
      else if (extPopupFocused) closeExtPopup();
    }
    if (!win || win.isDestroyed()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getContentBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    const rel = p.x - b.x;
    slow = !inside && !win.isFocused() && !buttonsShown && !peeking;
    windowButtons(p, b); // before the focus check: a background window's buttons work too
    if (!win.isFocused()) return;
    if (!collapsed) return;
    if (!peeking && inside && rel <= 3) peek(true);
    else if (peeking && !sidebarBusy && Date.now() > peekHoldUntil && (!inside || rel > SIDEBAR_W + 12)) peek(false);
  };
  poll();
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
  const b0 = win.getBounds();
  clearInterval(dragTimer);
  const began = Date.now();
  dragTimer = setInterval(() => {
    if (Date.now() - began > 15000 || !win || win.isDestroyed()) return clearInterval(dragTimer); // failsafe if mouseup is missed
    const p = screen.getCursorScreenPoint();
    // The size is set again with every move: on a screen scaled to a fraction (125%, 150%) Windows rounds a bare
    // setPosition and the window grows a pixel at a time while it is dragged.
    win.setBounds({ x: b0.x + p.x - start.x, y: b0.y + p.y - start.y, width: b0.width, height: b0.height });
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
// HTTPS-Only leaves plain http alone for local addresses: loopback, private ranges, and .local / .test names. The host is
// parsed, not matched against the URL's text, so "localhost.evil.com", "10.evil.com" and "x.test@evil.com" don't count.
function isLocalHttp(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ""); } catch { return false; }
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) { const a = +m[1], b = +m[2]; return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254); }
  return /\.(local|test)$/.test(h);
}
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
    if (S().httpsOnly && details.resourceType === "mainFrame" && /^http:\/\//i.test(details.url) && !isLocalHttp(details.url)) {
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

// One question at a time, and one per site and permission: a page that fires several requests (or the same one in a
// loop) gets a single dialog, not a stack of them.
const pendingPermission = new Map(); // "origin permission" -> the question being asked
let permissionChain = Promise.resolve();
function askPermission(wc, permission, details) {
  let origin;
  try { origin = new URL(details.requestingUrl || wc.getURL()).origin; } catch { return Promise.resolve(false); }
  const key = permKey(origin, permission);
  if (key in config.sitePermissions) return Promise.resolve(config.sitePermissions[key]);
  if (pendingPermission.has(key)) return pendingPermission.get(key);
  const answer = permissionChain
    .then(() => (key in config.sitePermissions ? config.sitePermissions[key] : askPermissionNow(origin, key, permission, details)))
    .finally(() => pendingPermission.delete(key));
  permissionChain = answer.catch(() => {});
  pendingPermission.set(key, answer);
  return answer;
}

async function askPermissionNow(origin, key, permission, details) {
  // Block is the default button and "Remember" starts unticked: an Enter pressed while the page asks (it can do so at
  // any moment) must never grant access, let alone for good.
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: "question",
    buttons: ["Allow", "Block"],
    defaultId: 1,
    cancelId: 1,
    message: `${new URL(origin).host} wants to ${permissionText(permission, details)}`,
    checkboxLabel: "Remember for this site",
    checkboxChecked: false,
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
    if (!ASKABLE[permission]) return ALWAYS_ALLOWED.includes(permission); // the same list the request handler allows
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

// Loaded only while ad blocking is on (switching it on later loads it then), so with it off nothing is fetched at start-up.
let blockerLoading = null;
const ensureBlocker = () => (blocker ? Promise.resolve() : (blockerLoading ||= initBlocker().finally(() => { blockerLoading = null; })));

async function initBlocker() {
  perf("blocker: start");
  const cache = path.join(app.getPath("userData"), "adblock-engine.bin");
  let stale = "";
  try {
    // Rules go stale quickly (YouTube changes its ads often), so the cached engine is rebuilt daily. The old copy is only set
    // aside while that happens: if the lists can't be fetched (offline, a proxy that blocks them) it comes back and is used,
    // rather than leaving the browser with no blocking at all.
    try {
      if (Date.now() - fs.statSync(cache).mtimeMs > ENGINE_MAX_AGE_MS) { stale = `${cache}.stale`; fs.renameSync(cache, stale); }
    } catch { stale = ""; }
    const { ElectronBlocker } = require("@ghostery/adblocker-electron");
    // Electron's own network stack, so the system proxy and certificates apply (Node's fetch ignores them).
    const build = () => ElectronBlocker.fromPrebuiltAdsAndTracking((url, opts) => net.fetch(url, opts), {
      path: cache,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    try { blocker = await build(); } catch (e) {
      if (!stale) throw e;
      fs.renameSync(stale, cache);
      stale = "";
      blocker = await build(); // from the old copy, no network
    }
    perf("blocker: engine loaded");
    blocker.on("request-blocked", onBlocked);
    applyBlocking();
    perf("blocker: ready");
  } catch (e) {
    console.error("ad blocker unavailable:", e.message);
  } finally {
    if (stale) { try { fs.rmSync(stale, { force: true }); } catch {} }
  }
}

// ---- tabs ----

// Sign-in popups. A page that opens a sized popup expects it to be a real window: the popup reports back to its
// opener (postMessage) and closes itself (window.close()). A tab made from just the popup's URL has no opener, so
// "Sign in with Google" (ClickUp, and most sites) ended on a blank page. The popup is a small window in the same
// session (the same cookies), centred on the app, with no menu bar.
function popupWindow(features, view) {
  // Like Chromium's own popup blocker: a popup needs a click or key press behind it (within five seconds, the length of
  // a user activation), one gesture opens one popup, and a tab keeps at most two open. Without this any page could
  // flood the screen with windows, or put up a convincing fake sign-in.
  if (Date.now() - (view.alcoveGesture || 0) > 5000 || (view.alcovePopups || 0) >= 2) return { action: "deny" };
  view.alcoveGesture = 0;
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
function popupCreated(popup, view) {
  popup.setMenuBarVisibility(false);
  popup.center();
  view.alcovePopups = (view.alcovePopups || 0) + 1;
  popup.once("closed", () => { view.alcovePopups = Math.max(0, (view.alcovePopups || 1) - 1); });
  const wc = popup.webContents;
  // The window's title says where it is, not what the page claims, so it can't pose as an Alcove dialog.
  const where = () => { try { return new URL(wc.getURL()).host || "Sign in"; } catch { return "Sign in"; } };
  popup.on("page-title-updated", e => e.preventDefault()); // (the window's event: the page's title doesn't reach the title bar)
  wc.on("did-navigate", () => popup.setTitle(where()));
  popup.setTitle(where());
  wc.setWindowOpenHandler(({ url: u }) => { send("new-tab-request", { url: u }); return { action: "deny" }; });
}

function openTab(id, url) {
  if (tabs.has(id) && !deadView(tabs.get(id))) { showOnly(id); return; } // asked twice (two activations at once): there is one view per tab
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
  // A page that closes itself (window.close()) is reported to the sidebar so it drops the row. Not while the app is shutting down
  // or switching profile: then every page is destroyed on purpose, and the sidebar must keep its tabs for the next start.
  wc.once("destroyed", () => { dropTab(id); if (!shuttingDown && !view.alcoveQuiet) send("tab-closed", { id }); });
  wc.on("will-prevent-unload", e => askLeave(id, view, wc, e));
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
  wc.on("did-navigate-in-page", (_e, u, isMainFrame) => { if (isMainFrame) send("tab-url", { id, url: u, inPage: true }); }); // (not history: maps and scroll-spy pages change the address constantly)
  wc.on("render-process-gone", (_e, d) => { if (d.reason !== "clean-exit") send("tab-crashed", { id, reason: d.reason }); });
  wc.on("page-title-updated", (_e, title) => send("tab-title", { id, title }));
  // Cmd/Ctrl+click opens a background tab; Shift+click (a featureless new window) opens Peek. A popup that asks
  // for a size ("Sign in with Google" and other sign-in flows) gets a real window (see popupWindow); other links
  // and window.open calls become tabs.
  wc.setWindowOpenHandler(({ url: u, disposition, features }) => {
    if (disposition === "new-window" && features) return popupWindow(features, view);
    if (disposition === "background-tab") send("new-tab-request", { url: u, background: true, from: id });
    else if (disposition === "new-window") openPeek(u);
    else send("new-tab-request", { url: u, from: id });
    return { action: "deny" };
  });
  wc.on("did-create-window", w => popupCreated(w, view));
  const gesture = () => { view.alcoveGesture = Date.now(); };
  wc.on("before-input-event", (_e, input) => { if (input.type === "keyDown") gesture(); });
  wc.on("input-event", (_e, ev) => { if (/^(mouseDown|mouseUp|rawKeyDown|keyDown|touchEnd|gestureTap)$/.test(ev.type)) gesture(); });
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
    divider.webContents.loadFile(uiFile("divider.html")).catch(() => {});
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

const peekInfo = info => { if (!deadView(peekBackdrop)) peekBackdrop.webContents.send("event", "peek-info", info); };

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
  const thisPeek = peekView;
  pwc.once("destroyed", () => { if (peekView === thisPeek) closePeek(); }); // the previewed page closed itself
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
    try { win.contentView.removeChildView(v); } catch {}
    if (!deadView(v)) v.webContents.close();
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
  toolsView.webContents.loadFile(uiFile("tools.html"), tab ? { hash: String(tab) } : undefined).catch(() => {});
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
  settingsView.webContents.loadFile(uiFile("settings.html"), section ? { hash: String(section) } : undefined).catch(() => {});
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
    animate(collapsed ? HIDE_X : 0, dockedLeft(), 220, coverTarget());
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

// Forget a tab's view and bookkeeping. Runs when its page is destroyed, whoever closed it (the sidebar, or the page itself
// with window.close(), as OAuth "you can close this window" pages do), and is safe to run twice.
function dropTab(id) {
  const v = tabs.get(id);
  if (!v) return;
  if (split && (split.left === id || split.right === id)) setSplit(null);
  try { win.contentView.removeChildView(v); } catch {}
  for (const [wcId, t] of wcToTab) if (t === id) wcToTab.delete(wcId);
  tabs.delete(id);
  lastFind.delete(id);
  blocked.delete(id);
}

// Close a tab after giving its page the chance to say no: a page with unsaved work asks "Leave this page?" (the Markdown
// editor does, for a saved file with changes). Resolves true once the tab is gone, false if the user chose to stay.
// force skips the question (switching profiles, deleting a space).
function closeTab(id, force) {
  const v = tabs.get(id);
  if (!v) return Promise.resolve(true);
  const wc = v.webContents;
  if (deadView(v)) { dropTab(id); return Promise.resolve(true); }
  if (force) { v.alcoveQuiet = true; wc.close(); return Promise.resolve(true); }
  return new Promise(resolve => {
    v.alcoveClosing = ok => { v.alcoveClosing = null; resolve(ok); };
    wc.once("destroyed", () => v.alcoveClosing && v.alcoveClosing(true));
    wc.close({ waitForBeforeUnload: true });
  });
}

// Closing the window (Cmd+Q, the close button) with unsaved Markdown edits asks first. The editor keeps those edits as a
// draft either way (see ui/markdown.html), so the question is "quit now?", not "lose your work?". Only the editor is asked:
// it is the page that holds work of the user's own, and it answers through window.__alcoveDirty().
let testQuit = ""; // tests only (debug_quit_answer): "quit" or "cancel" answers without a dialog
async function dirtyNotes() {
  const names = [];
  for (const v of tabs.values()) {
    if (deadView(v) || !v.webContents.getURL().startsWith(MD_PAGE)) continue;
    try {
      const name = await Promise.race([
        v.webContents.executeJavaScript('typeof window.__alcoveDirty === "function" ? window.__alcoveDirty() : ""'),
        new Promise(resolve => setTimeout(() => resolve(""), 1000)), // a page that doesn't answer is not held up for
      ]);
      if (name) names.push(String(name).slice(0, 80));
    } catch {}
  }
  return names;
}
async function confirmQuit(names) {
  if (testQuit) return testQuit === "quit";
  const { response } = await dialog.showMessageBox(win, {
    type: "question", buttons: ["Cancel", "Quit"], defaultId: 0, cancelId: 0,
    message: names.length === 1 ? `“${names[0]}” has unsaved changes` : `${names.length} notes have unsaved changes`,
    detail: "If you quit now they are kept as a draft, and offered again the next time you open the note.",
  });
  return response === 1;
}
function guardClose() {
  let asking = false, confirmed = false;
  win.on("close", e => {
    if (confirmed) return;
    e.preventDefault();
    if (asking) return; // a second click on the close button while the question is up
    asking = true;
    (async () => {
      try {
        const names = await dirtyNotes();
        if (names.length && !(await confirmQuit(names))) { shuttingDown = false; return; } // Cmd+Q had set it; the user stayed
        confirmed = true;
        shuttingDown = true;
        win.close();
      } finally { asking = false; }
    })();
  });
}

// "Leave this page?" for a tab whose page asked to be asked (an unload guard), whether it is being closed or navigated away.
let testLeave = ""; // tests only (debug_leave_answer): "leave" or "stay" answers the question without a dialog
function askLeave(id, v, wc, e) {
  const title = (wc.getTitle() || wc.getURL() || "this page").slice(0, 80);
  const choice = testLeave ? (testLeave === "leave" ? 0 : 1) : dialog.showMessageBoxSync(win, {
    type: "question", buttons: ["Leave", "Stay"], defaultId: 1, cancelId: 1,
    message: `Leave “${title}”?`, detail: "Changes you made may not be saved.",
  });
  if (choice === 0) { e.preventDefault(); return; } // preventDefault ignores the page's guard and lets it go
  if (v.alcoveClosing) v.alcoveClosing(false);        // staying: the close is cancelled
  send("tab-url", { id, url: wc.getURL() });          // a navigation that was cancelled leaves the address bar as it was
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
const { MD_EXT, MD_SKIP, MD_GRAPH_MAX_FILES, mdScan, mdFiles, searchNotes } = require("./md-search");
const MD_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "mdown", "mkd", "txt"] }];
const MD_MAX = 5 * 1024 * 1024;
const { Worker } = require("worker_threads");
const MD_SEARCH_LIMIT_MS = 6000;
const mdAllowed = new Set(); // files this session opened or saved: the only ones the editor may write

// Folders: the editor shows a file tree for a folder the user picked (or one picked before, from the recent
// list). It can only list inside those folders, and only shows folders and Markdown or text files.
const mdRoots = new Set();
const mdInside = p => [...mdRoots].some(r => p === r || p.startsWith(r + path.sep));
const realPath = p => { try { return fs.realpathSync(p); } catch { return p; } };
// What the editor page may read: a file this session opened or saved, one from the recent list, or one inside an open
// folder (judged by where it really is, so a link inside the folder can't lead out of it). The file a tab was opened
// on and a file dropped on the editor are allowed where they come in (see the "alcove-md" handler).
const mdReadable = p => mdAllowed.has(p) || (config.recentMd || []).includes(p) || mdInside(realPath(p));
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
  const rootDir = realPath(path.resolve(p)); // roots are kept as real paths so mdInside can't be fooled by a link
  mdRoots.add(rootDir);
  config.recentMdFolders = [rootDir, ...(config.recentMdFolders || []).filter(x => x !== rootDir)].slice(0, 20);
  saveConfig();
  return { root: rootDir, ...mdList(rootDir) };
}

const mdRemember = p => {
  config.recentMd = [p, ...(config.recentMd || []).filter(x => x !== p)].slice(0, 8);
  saveConfig();
};

function mdRead(p, trusted) {
  p = path.resolve(String(p || ""));
  if (!MD_EXT.test(p)) return { error: "Only Markdown or text files can be opened here." };
  if (!trusted && !mdReadable(p)) return { error: "Open this file with Open… or drop it on the editor first." };
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { error: "That isn't a file." };
    if (st.size > MD_MAX) return { error: "This file is larger than 5 MB." };
    const text = fs.readFileSync(p, "utf8");
    mdAllowed.add(p);
    mdRemember(p);
    return { path: p, text, mtime: st.mtimeMs };
  } catch (e) {
    return { error: e.code === "ENOENT" ? "File not found." : "Couldn't read this file." };
  }
}

// expected: the file's modified time when the editor opened it. If the file has changed since (another app, another device,
// a sync service), nothing is written and { conflict: true } lets the editor ask; saving again without it overwrites.
function mdWrite(p, text, expected) {
  if (typeof text !== "string" || text.length > 2 * MD_MAX) return { error: "Nothing to save, or the document is too large." };
  let tmp = "";
  try {
    // A note that is a link is saved through to the file it points at (so a notes folder synced by links keeps working),
    // but only if that is a Markdown or text file too.
    const target = fs.existsSync(p) ? fs.realpathSync(p) : p;
    if (!MD_EXT.test(target)) return { error: "This file is a link to something that isn't a Markdown or text file." };
    const before = fs.existsSync(target) ? fs.statSync(target) : null;
    if (before && typeof expected === "number" && Math.abs(before.mtimeMs - expected) > 1) return { conflict: true, mtime: before.mtimeMs };
    const mode = before ? before.mode & 0o777 : 0o644; // keep the file's permissions
    // The temporary file has a random name and is created exclusively ("wx"), so a link planted at a guessable name
    // can't redirect the write; the rename then swaps it in whole, so a crash never leaves half a note.
    tmp = path.join(path.dirname(target), `.${path.basename(target)}.${require("crypto").randomBytes(6).toString("hex")}.alcove-tmp`);
    fs.writeFileSync(tmp, text, { encoding: "utf8", flag: "wx", mode });
    fs.renameSync(tmp, target);
    mdAllowed.add(p);
    mdRemember(p);
    return { path: p, mtime: fs.statSync(target).mtimeMs };
  } catch {
    if (tmp) { try { fs.rmSync(tmp, { force: true }); } catch {} }
    return { error: "Couldn't save the file. Check that the folder is writable." };
  }
}

// Search across the open folders. A plain-text or tag query can't run away, so it runs here; a regular expression typed by the
// user can (a pattern like (a+)+$ may run for minutes), so it runs in a worker thread that is stopped after a few seconds.
async function mdSearch(o) {
  const roots = (Array.isArray(o && o.roots) ? o.roots : []).map(r => path.resolve(String(r))).filter(r => mdRoots.has(r));
  if (!roots.length) return { error: "Load a folder first." };
  if (!(o && o.regex && String(o.q || "").trim())) return searchNotes(o, roots);
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); worker.terminate().catch(() => {}); resolve(r); };
    const worker = new Worker(path.join(__dirname, "md-search.js"), { workerData: { mdSearch: true, o, roots } });
    const timer = setTimeout(() => finish({ error: "That pattern takes too long to search. Try a simpler one." }), MD_SEARCH_LIMIT_MS);
    worker.once("message", finish);
    worker.once("error", () => finish({ error: "The search failed." }));
  });
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
  if (op === "inset") { const n = insetFor(contentRect()); insetSent.set(e.sender, n); return n; } // current value; later changes are pushed
  if (op === "settings") return { searchEngine: S().searchEngine, customSearch: S().customSearch, accent: S().accent, private: !!privateSnapshot };
  if (op === "tools-data") { // the Tools engine's state, time tracking, to-dos and to-do tallies: JSON text, or null
    if (deadView(ui)) return null;
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

ipcMain.handle("alcove-md", async (e, op, a, b, c) => {
  if (!e.senderFrame || e.senderFrame.url.split(/[?#]/)[0] !== MD_PAGE) throw new Error("forbidden");
  if (op === "read") { // the file this tab was opened on (?file=…) is allowed; anything else must have been opened, dropped or mounted
    let own = null;
    try { own = new URL(e.senderFrame.url).searchParams.get("file"); } catch {}
    return mdRead(a, !!own && path.resolve(String(a || "")) === path.resolve(own));
  }
  if (op === "allow") { // sent by the preload for a file the user dropped on the editor; the page itself can't call this
    const f = path.resolve(String(a || ""));
    if (MD_EXT.test(f)) mdAllowed.add(f);
    return true;
  }
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
    const dir = realPath(path.resolve(String(a || "")));
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
    return canceled || !filePaths[0] ? null : mdRead(filePaths[0], true);
  }
  if (op === "save") {
    const p = path.resolve(String(a || ""));
    return mdAllowed.has(p) && MD_EXT.test(p) ? mdWrite(p, b, c) : { error: "Use Save As to choose where this goes." };
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
const downloadDir = () => devEnv("ALCOVE_DOWNLOAD_DIR") || downloadsFolder(); // env override is for tests (not in a packaged app)

// Environment overrides that only make sense in development and tests (a path to run, a folder to write to). A packaged app
// ignores them, so a process that can set our environment can't make Alcove run or write somewhere of its choosing.
const devEnv = name => (app.isPackaged ? undefined : process.env[name]);

function findBinary(name, envVar) {
  if (envVar && devEnv(envVar) && fs.existsSync(devEnv(envVar))) return devEnv(envVar);
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

// These two tools are downloaded when the user sets up video download, then run. Both downloads are checked against a
// SHA-256 before anything is written, and written to a temporary file that is renamed into place, so a corrupt, cut-off
// or swapped download is never kept or run.
const sha256 = buf => require("crypto").createHash("sha256").update(buf).digest("hex");
function installExecutable(dest, data) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${require("crypto").randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o755, flag: "wx" });
    fs.renameSync(tmp, dest);
  } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}
async function fetchBuffer(url) {
  const res = await net.fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// yt-dlp: the official release, checked against the SHA2-256SUMS file published with it. (That guards against a corrupt
// or cut-off download and a swapped file on the way; the release itself is trusted. It changes often, so it is not pinned.)
async function installDownloader() {
  const asset = { darwin: "yt-dlp_macos", win32: "yt-dlp.exe" }[process.platform] || "yt-dlp";
  const base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/";
  const sums = (await fetchBuffer(`${base}SHA2-256SUMS`)).toString("utf8");
  const line = sums.split(/\r?\n/).map(l => l.trim().split(/\s+/)).find(f => f.length === 2 && f[1].replace(/^\*/, "") === asset);
  if (!line || !/^[0-9a-f]{64}$/i.test(line[0])) throw new Error("couldn't find the published checksum for the download");
  const data = await fetchBuffer(base + asset);
  if (sha256(data) !== line[0].toLowerCase()) throw new Error("the download didn't match its published checksum; try again");
  installExecutable(path.join(binDir(), exeName("yt-dlp")), data);
  return true;
}

// YouTube only serves separate video and audio streams, so video needs ffmpeg to merge them.
// ffmpeg: release b6.1.1 of eugeneware/ffmpeg-static, pinned. These are the SHA-256 values GitHub reports for each
// archive of that release (an ia32 build for Windows doesn't exist there). Bump the tag and the table together.
const FFMPEG_TAG = "b6.1.1";
const FFMPEG_SHA256 = {
  "darwin-arm64": "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
  "darwin-x64": "929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106",
  "win32-x64": "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
  "linux-x64": "bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa",
  "linux-arm64": "754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0",
};
async function installFfmpeg() {
  const plat = `${process.platform}-${process.arch}`;
  const want = FFMPEG_SHA256[plat];
  if (!want) throw new Error(`no ffmpeg build for ${process.platform} ${process.arch}`);
  const archive = await fetchBuffer(`https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/ffmpeg-${plat}.gz`);
  if (sha256(archive) !== want) throw new Error("the ffmpeg download didn't match its checksum; try again");
  installExecutable(path.join(binDir(), exeName("ffmpeg")), require("zlib").gunzipSync(archive));
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
  if (profileId === PRIVATE) return; // extensions are off in private mode, as in Chrome's incognito
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

// What an extension asks for, in plain words, for the review before it is added.
const PERMISSION_TEXT = {
  tabs: "See the addresses and titles of your tabs", history: "Read and change your browsing history", bookmarks: "Read and change your bookmarks",
  cookies: "Read and change your cookies", webRequest: "See your web requests", webRequestBlocking: "Block or change your web requests",
  declarativeNetRequest: "Block or change content on pages", declarativeNetRequestWithHostAccess: "Block or change content on pages",
  activeTab: "Use the page you are on when you click its button", scripting: "Run code on pages", userScripts: "Run custom scripts on pages",
  downloads: "Manage your downloads", clipboardRead: "Read what you copy", clipboardWrite: "Write to your clipboard",
  nativeMessaging: "Talk to programs on your computer", management: "See and manage your other extensions", proxy: "Control your network proxy",
  privacy: "Change your privacy settings", debugger: "Debug pages (full access to them)", geolocation: "Know your location",
  notifications: "Show notifications", contextMenus: "Add items to the right-click menu", webNavigation: "See where you navigate",
  identity: "Use your accounts to sign in", topSites: "See your most visited sites", tabCapture: "Capture the contents of tabs",
  desktopCapture: "Capture your screen", pageCapture: "Save pages", browsingData: "Clear your browsing data", sessions: "See your recently closed tabs",
};
const QUIET_PERMISSIONS = new Set(["storage", "unlimitedStorage", "alarms", "offscreen", "idle", "sidePanel", "fontSettings", "i18n", "theme", "action"]);

// The extension's name, resolving a "__MSG_name__" placeholder from its default locale.
function manifestName(zip, m) {
  const name = String(m.name || "");
  const ph = /^__MSG_(.+)__$/.exec(name);
  if (!ph) return name;
  try {
    const entry = zip.getEntry(`_locales/${m.default_locale || "en"}/messages.json`);
    const msgs = JSON.parse(entry.getData().toString("utf8").replace(/^\uFEFF/, ""));
    const hit = Object.entries(msgs).find(([k]) => k.toLowerCase() === ph[1].toLowerCase());
    return (hit && hit[1] && hit[1].message) || name;
  } catch { return name; }
}

// { name, version, lines } for the review dialog, from the extension's manifest.
function describeExtension(zipBuf, id) {
  const zip = new AdmZip(zipBuf);
  const entry = zip.getEntry("manifest.json");
  if (!entry) throw new Error("no manifest.json found in that extension");
  const m = JSON.parse(entry.getData().toString("utf8").replace(/^\uFEFF/, ""));
  const perms = (Array.isArray(m.permissions) ? m.permissions : []).map(String);
  const isHost = p => p === "<all_urls>" || p.includes("://");
  const hosts = [...(Array.isArray(m.host_permissions) ? m.host_permissions : []).map(String), ...perms.filter(isHost),
    ...(Array.isArray(m.content_scripts) ? m.content_scripts : []).flatMap(c => (c && Array.isArray(c.matches) ? c.matches.map(String) : []))];
  const lines = [];
  if (hosts.some(h => h === "<all_urls>" || /^(\*|https?):\/\/\*\/\*/.test(h))) lines.push("Read and change everything on every website you visit");
  else if (hosts.length) {
    const names = [...new Set(hosts.map(h => (h.match(/^[^:]+:\/\/([^/]+)/) || [])[1] || h))];
    lines.push(`Read and change your data on ${names.slice(0, 4).join(", ")}${names.length > 4 ? ` and ${names.length - 4} more` : ""}`);
  }
  for (const p of perms) {
    if (isHost(p) || QUIET_PERMISSIONS.has(p)) continue;
    lines.push(PERMISSION_TEXT[p] || `Permission: ${p}`);
  }
  return { id, name: manifestName(zip, m) || id, version: String(m.version || ""), lines: [...new Set(lines)] };
}

let testReview = ""; // tests only (debug_review_answer): "add" or "cancel" answers the review without a dialog
async function confirmExtension(info) {
  if (testReview) return testReview === "add";
  const { response } = await dialog.showMessageBox(win, {
    type: "question", buttons: ["Add extension", "Cancel"], defaultId: 1, cancelId: 1,
    message: `Add “${info.name.slice(0, 80)}” to Alcove?`,
    detail: `${info.version ? `Version ${info.version}\n\n` : ""}${info.lines.length ? `It can:\n${info.lines.slice(0, 10).map(l => `• ${l}`).join("\n")}` : "It asks for no special access."}\n\nOnly add extensions you trust.`,
  });
  return response === 0;
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
  if (privateSnapshot) throw new Error("extensions are turned off in private mode");
  const m = String(input).match(/[a-p]{32}/);
  if (!m) throw new Error("no extension ID found in that text");
  const id = m[0];
  const x = encodeURIComponent(`id=${id}&installsource=ondemand&uc`);
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome}&acceptformat=crx2,crx3&x=${x}`;
  const res = await net.fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  // The package must be signed by the key the ID comes from, and the user sees what it asks for before it is added.
  const zip = verifyCrx(Buffer.from(await res.arrayBuffer()), id);
  if (!(await confirmExtension(describeExtension(zip, id)))) return { cancelled: true };
  return installCrx(zip, id);
}

async function installUnpacked() {
  if (privateSnapshot) throw new Error("extensions are turned off in private mode");
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
  try { win.contentView.removeChildView(extPopup); } catch {}
  if (!deadView(extPopup)) extPopup.webContents.close();
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
  const thisPopup = extPopup;
  thisPopup.webContents.once("destroyed", () => { if (extPopup === thisPopup) closeExtPopup(); }); // it closed itself (window.close())
  win.contentView.addChildView(extPopup);
  extPopup.webContents.loadURL(`chrome-extension://${id}/${page}`).catch(() => {});
  extPopup.webContents.focus();
}

// ---- import from Chrome and other Chromium browsers ----

// Bookmarks, history and installed extensions are plain files in each browser profile. Passwords and
// cookies are encrypted with a Keychain/DPAPI key, so they are not imported (sites need one new sign-in).
function browserRoots() {
  if (devEnv("ALCOVE_IMPORT_ROOT")) return [{ browser: "Test Browser", dir: devEnv("ALCOVE_IMPORT_ROOT") }]; // tests only
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

// Near the top, centred over the page area. layout() calls this, so the palette follows the window as it resizes
// and the docked sidebar as it slides.
function placePalette() {
  if (!palette) return;
  const { width, height } = win.getContentBounds();
  const left = dockedLeft();
  const w = Math.min(Math.max(width - left - 40, 300), 580);
  const x = left + Math.max((width - left - w) / 2, 0);
  palette.setBounds({
    x: Math.round(x), y: 70, width: Math.round(w), height: Math.max(Math.min(420, height - 90), 200),
  });
}

// Re-created on every open so it always sits above the tab views.
function showPalette() {
  hidePalette();
  palette = new WebContentsView({
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, sandbox: true,
      partition: uiPartition(config.activeProfile), // same storage as the sidebar
    },
  });
  placePalette();
  win.contentView.addChildView(palette);
  palette.webContents.loadFile(uiFile("palette.html")).catch(() => {});
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
  ui.webContents.on("render-process-gone", (_e, d) => { // the sidebar's process died: its tabs are closed and it reloads, reopening the active one
    if (d.reason === "clean-exit" || shuttingDown) return;
    console.error("the sidebar crashed:", d.reason);
    for (const id of [...tabs.keys()]) closeTab(id, true);
    setTimeout(() => { if (!deadView(ui)) ui.webContents.reload(); }, 400);
  });
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
  sideCover = coverTarget();
  peeking = false;
  layout();
}

function activeProfile() {
  if (config.activeProfile === PRIVATE) return { id: PRIVATE, name: "Private", color: "#7a5af8" };
  return config.profiles.find(p => p.id === config.activeProfile);
}

// Closes every page and the sidebar of the current profile, makes `id` the active one and opens its sidebar.
function swapSession(id) {
  hidePalette();
  closePeek();
  closeSettings();
  setSplit(null);
  closeRegion();
  closeShotPopup();
  closeExtPopup();
  for (const tabId of [...tabs.keys()]) closeTab(tabId, true);
  const old = ui;
  config.activeProfile = id;
  ensureSession(id);
  applyBlocking();
  createUi();
  win.contentView.removeChildView(old);
  setImmediate(() => old.webContents.close()); // the request may have come from the old view
  const p = activeProfile();
  win.setTitle(p.id === "default" ? "Alcove" : `Alcove — ${p.name}`);
}

function switchProfile(id) {
  if (privateSnapshot) { if (config.profiles.some(p => p.id === id)) endPrivate(id); return; } // choosing a profile leaves private mode
  if (id === config.activeProfile || !config.profiles.some(p => p.id === id)) return;
  swapSession(id);
  saveConfig();
}

// ---- private mode ----
// Starting it closes the pages of the current profile (they come back when it ends) and opens a profile with nothing in it: no
// cookies, no history, no tabs. Ad blocking, Do Not Track and the site permission prompts work as usual; extensions are off.
function startPrivate() {
  if (privateSnapshot || !win || win.isDestroyed()) return;
  privateSnapshot = JSON.parse(JSON.stringify(config));
  privateToken = require("crypto").randomBytes(8).toString("hex");
  swapSession(PRIVATE);
  Menu.setApplicationMenu(buildMenu());
}

// Ends it: the pages and the sidebar of the private session are closed, the config goes back to what it was, and the private
// session's storage is wiped. `toId` is the profile to land on (default: the one private mode was started from).
function endPrivate(toId) {
  if (!privateSnapshot) return;
  const parts = [webPartition(PRIVATE), uiPartition(PRIVATE)];
  const snap = privateSnapshot;
  const to = toId && snap.profiles.some(p => p.id === toId) ? toId : snap.activeProfile;
  config = snap;
  privateSnapshot = null;
  swapSession(to);
  if (to !== snap.activeProfile) saveConfig();
  nativeTheme.themeSource = S().theme; // a theme picked in private mode is not kept
  Menu.setApplicationMenu(buildMenu());
  for (const part of parts) {
    const ses = session.fromPartition(part);
    knownSessions.delete(ses);
    ses.clearStorageData().catch(() => {});
    ses.clearCache().catch(() => {});
  }
  privateToken = "";
}

function createProfile(name) {
  if (privateSnapshot) throw new Error("leave private mode first");
  const n = config.profiles.length;
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "profile";
  const profile = { id: `${slug}-${Math.random().toString(36).slice(2, 6)}`, name, color: COLORS[n % COLORS.length] };
  config.profiles.push(profile);
  saveConfig();
  return profile;
}

async function deleteProfile(id) {
  if (privateSnapshot) throw new Error("leave private mode first");
  if (id === "default" || id === config.activeProfile) throw new Error("cannot delete this profile");
  config.profiles = config.profiles.filter(p => p.id !== id);
  saveConfig();
  await session.fromPartition(webPartition(id)).clearStorageData();
  await session.fromPartition(uiPartition(id)).clearStorageData();
}

// ---- IPC ----

const wcOf = id => { const wc = tabs.get(id)?.webContents; return wc && !wc.isDestroyed() ? wc : undefined; };
// ---- updates ----
// Alcove doesn't update itself. "Check for updates" (Settings > About, the palette) asks GitHub for the latest published release
// of the repository named in package.json and, if it is newer than this version, offers the release page to download from; the
// start-up check does the same once a day, only if the person turned it on. Nothing is downloaded or installed here.
const UPDATE_REPO = (() => {
  try { return /github\.com[/:]([^/]+\/[^/.]+)/.exec(require("./package.json").repository.url)[1]; } catch { return ""; }
})();
const versionParts = v => String(v).replace(/^v/i, "").split(/[-+]/)[0].split(".").map(n => parseInt(n, 10) || 0);
const isNewer = (a, b) => {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function checkForUpdate() {
  const current = app.getVersion();
  if (!UPDATE_REPO) return { current, error: "This build doesn't say where its releases are." };
  const test = devEnv("ALCOVE_UPDATE_API"); // tests only: a local server standing in for GitHub
  const api = test || `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
  let res;
  try { res = await net.fetch(api, { headers: { accept: "application/vnd.github+json", "user-agent": `Alcove/${current}` } }); }
  catch { return { current, error: "Couldn't reach GitHub. Check your connection." }; }
  if (res.status === 404) return { current, none: true }; // no published release (or the repository isn't public yet)
  if (!res.ok) return { current, error: `GitHub answered ${res.status}. Try again later.` };
  let release;
  try { release = await res.json(); } catch { return { current, error: "GitHub's answer wasn't readable." }; }
  const tag = String((release && release.tag_name) || "");
  if (!/^v?\d+\.\d+\.\d+/.test(tag)) return { current, error: "The latest release has no version number." };
  // The page to open must be this repository's release page: the answer is data from the network, not an instruction.
  const url = String((release && release.html_url) || "");
  if (!url.startsWith(test ? "http://127.0.0.1" : `https://github.com/${UPDATE_REPO}/releases/`)) return { current, error: "The latest release has an unexpected address." };
  return { current, latest: tag.replace(/^v/i, ""), newer: isNewer(tag, current), url };
}

async function startupUpdateCheck() {
  if (!S().checkUpdates || Date.now() - (config.lastUpdateCheck || 0) < 20 * 3600 * 1000) return;
  config.lastUpdateCheck = Date.now();
  saveConfig();
  const r = await checkForUpdate();
  if (r.newer) send("update-available", r);
}

const fxCache = new Map();

const commands = {
  check_update: () => checkForUpdate(),
  open_tab: ({ id, url }) => openTab(id, url),
  switch_tab: ({ id }) => showOnly(id),
  close_tab: ({ id, force }) => closeTab(id, !!force), // true once closed; false if the page asked "Leave this page?" and the user stayed
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
    return { win: win.getContentBounds(), ui: b(ui), strip: b(strip), caption: b(caption), captionVisible: caption ? caption.getVisible() : null, page: contentRect(), tab: b(tabs.get(shownId)), tools: b(toolsView), settings: b(settingsView), palette: b(palette), sideCover: Math.round(sideCover), extPopup: deadView(extPopup) ? null : b(extPopup), maximized: win.isMaximized(), IS_WIN };
  },
  debug_windows: () => { // test hook: the popup windows (real windows besides the app's own)
    if (process.env.ALCOVE_TEST !== "1") return null;
    return BrowserWindow.getAllWindows().map(w => ({ title: w.getTitle(), url: w.webContents.getURL(), focused: w.isFocused(), w: w.getBounds().width, h: w.getBounds().height }));
  },
  debug_focus_popup: () => { // test hook: focus the first popup window
    if (process.env.ALCOVE_TEST !== "1") return null;
    const w = BrowserWindow.getAllWindows()[0];
    if (!w) return false;
    app.focus({ steal: true }); w.focus();
    return w.isFocused();
  },
  debug_menu: ({ label }) => { // test hook: click a menu item by its label, as its accelerator would
    if (process.env.ALCOVE_TEST !== "1") return null;
    const find = items => { for (const i of items) { if (i.label === label) return i; const f = i.submenu && find(i.submenu.items); if (f) return f; } return null; };
    const item = find(Menu.getApplicationMenu().items);
    if (item) item.click();
    return !!item;
  },
  debug_review_answer: ({ answer }) => { if (process.env.ALCOVE_TEST === "1") testReview = answer === "add" || answer === "cancel" ? answer : ""; },
  debug_describe_extension: ({ path: file }) => { // test hook: the review text for a package on disk
    if (process.env.ALCOVE_TEST !== "1") return null;
    return describeExtension(crxToZip(fs.readFileSync(file)), "test");
  },
  debug_install_unpacked: ({ dir }) => { // test hook: load an unpacked extension without the folder dialog
    if (process.env.ALCOVE_TEST !== "1") return null;
    return installFromDir(String(dir), `local-test-${path.basename(String(dir)).replace(/[^\w.-]+/g, "_")}`);
  },
  debug_peek: ({ on }) => { if (process.env.ALCOVE_TEST === "1") peek(!!on); return process.env.ALCOVE_TEST === "1"; }, // test hook: as the cursor at the left edge would
  debug_crash: ({ what, id }) => { // test hook: kill the process behind the sidebar or a tab, as an out-of-memory crash would
    if (process.env.ALCOVE_TEST !== "1") return null;
    const v = what === "sidebar" ? ui : tabs.get(id);
    if (deadView(v)) return false;
    v.webContents.forcefullyCrashRenderer();
    return true;
  },
  debug_quit: () => { if (process.env.ALCOVE_TEST === "1") setImmediate(() => app.quit()); return process.env.ALCOVE_TEST === "1"; }, // test hook: as Cmd+Q would
  debug_quit_answer: ({ answer }) => { if (process.env.ALCOVE_TEST === "1") testQuit = answer === "quit" || answer === "cancel" ? answer : ""; },
  debug_close_window: () => { if (process.env.ALCOVE_TEST === "1") win.close(); return process.env.ALCOVE_TEST === "1"; }, // test hook: as the close button would
  debug_leave_answer: ({ answer }) => { if (process.env.ALCOVE_TEST === "1") testLeave = answer === "leave" || answer === "stay" ? answer : ""; },
  debug_destroy_view: ({ what, id }) => { // test hook: a page destroying its own view, as window.close() does
    if (process.env.ALCOVE_TEST !== "1") return null;
    const v = what === "peek" ? peekView : what === "ext" ? extPopup : tabs.get(id);
    if (deadView(v)) return false;
    v.webContents.close();
    return true;
  },
  debug_throw: () => { // test hook: an uncaught exception and an unhandled rejection in the main process
    if (process.env.ALCOVE_TEST !== "1") return null;
    setTimeout(() => { throw new Error("test: uncaught exception"); }, 0);
    setTimeout(() => { Promise.reject(new Error("test: unhandled rejection")); }, 0);
    return true;
  },
  debug_resize: ({ w, h }) => { // test hook: set the window's content size
    if (process.env.ALCOVE_TEST !== "1") return null;
    win.setContentSize(Math.round(w), Math.round(h));
    return win.getContentBounds();
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
    // Windows 10 and 11 don't let an app make itself the default: the user picks it in Default apps, so that page is opened.
    if (process.platform === "win32") shell.openExternal("ms-settings:defaultapps").catch(() => {});
    return { ok, isDefault: app.isDefaultProtocolClient("https"), pick: process.platform === "win32" };
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
    if (config.adblock && !blocker) blockerReady = ensureBlocker(); // first time on this run: load it (it applies itself)
    else applyBlocking();
  },
  get_profiles: () => ({ profiles: config.profiles, active: privateSnapshot ? privateSnapshot.activeProfile : config.activeProfile, private: !!privateSnapshot }),
  list_import_sources: () => listImportSources(),
  import_browser: args => importFromBrowser(args),
  take_pending_import: () => {
    const d = pendingImports.get(config.activeProfile) || null;
    pendingImports.delete(config.activeProfile);
    return d;
  },
  create_profile: ({ name }) => createProfile(String(name).trim().slice(0, 30) || "Profile"),
  switch_profile: ({ id }) => { setImmediate(() => switchProfile(id)); },
  private_start: () => { setImmediate(startPrivate); },
  private_end: () => { setImmediate(() => endPrivate()); },
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
  const item = (id, label, accelerator) => ({ label, accelerator, click: () => {
    // Menu shortcuts are app-wide. A sign-in popup is its own window, so a key pressed there acts on it (close, reload), never
    // on the tab behind it (Cmd+W there used to close the page that was waiting for the sign-in).
    const popup = BrowserWindow.getFocusedWindow();
    if (popup) { if (id === "close-tab") popup.close(); else if (id === "reload") popup.webContents.reload(); return; }
    send("shortcut", id);
  } });
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
      { label: "New Private Session", accelerator: "CmdOrCtrl+Shift+N", enabled: !privateSnapshot, click: () => { setImmediate(startPrivate); } },
      { label: "Leave Private Session", enabled: !!privateSnapshot, click: () => { setImmediate(() => endPrivate()); } },
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
  blockerReady = config.adblock ? ensureBlocker() : Promise.resolve();
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
  guardClose();
  watchCursor();
  setTimeout(() => startupUpdateCheck().catch(() => {}), 15000); // not while the window is still settling
  globalThis.__alcoveStarted = true; // from here on, stray errors are logged instead of ending the app (see onProcessError)
});

app.on("window-all-closed", () => app.quit());
