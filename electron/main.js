const {
  app, BaseWindow, WebContentsView, Menu, ipcMain, shell, session, screen, nativeTheme, clipboard, ClipboardItem, dialog, net, nativeImage,
} = require("electron");
const AdmZip = require("adm-zip");
const { spawn, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const SIDEBAR_W = 280;
const PRELOAD = path.join(__dirname, "preload.js");
const COLORS = ["#7c8cff", "#ff7c9c", "#5fd6a0", "#ffb86b", "#c27cff"];
const uiFile = name => path.join(__dirname, "ui", name);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- config (profiles + settings) ----

let config = {
  collapsed: false,
  adblock: true,
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
let lightsShown = false;
let dragTimer = null;

const send = (name, payload) => {
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send("event", name, payload);
};

// ---- layout / sliding sidebar ----

function layout() {
  const { width, height } = win.getContentBounds();
  const left = Math.round(contentLeft);
  ui.setBounds({ x: Math.round(sidebarX), y: 0, width: SIDEBAR_W, height });
  for (const v of tabs.values()) {
    v.setBounds({ x: left, y: 0, width: Math.max(width - left, 1), height });
  }
  placeShotPopup();
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
  animate(on ? 0 : -SIDEBAR_W, contentLeft, 180);
  sidebarState();
}

function toggleSidebar() {
  collapsed = !collapsed;
  config.collapsed = collapsed;
  saveConfig();
  peeking = false;
  if (collapsed) raiseUi();
  animate(collapsed ? -SIDEBAR_W : 0, collapsed ? 0 : SIDEBAR_W, 240);
  sidebarState();
}

// Cursor polling is simpler and more reliable than a transparent hot-zone view over the page.
function watchCursor() {
  const mac = process.platform === "darwin";
  setInterval(() => {
    if (extPopup) {
      if (extPopup.webContents.isFocused()) extPopupFocused = true;
      else if (extPopupFocused) closeExtPopup();
    }
    if (!win || win.isDestroyed() || !win.isFocused()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getContentBounds();
    const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    const rel = p.x - b.x;
    const relY = p.y - b.y;
    if (mac) {
      // Native traffic lights stay hidden until the pointer nears the top-left corner.
      const near = inside && rel < 120 && relY < 44;
      if (near !== lightsShown) {
        lightsShown = near;
        win.setWindowButtonVisibility(near);
      }
    }
    if (!collapsed) return;
    if (!peeking && inside && rel <= 3) peek(true);
    else if (peeking && !sidebarBusy && (!inside || rel > SIDEBAR_W + 12)) peek(false);
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
    }
  } catch (e) { console.error("ad blocker:", e.message); }
}

function ensureSession(profileId) {
  const ses = session.fromPartition(webPartition(profileId));
  if (knownSessions.has(ses)) return ses;
  knownSessions.add(ses);
  // Some sites refuse to work when the UA names Electron.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|alcove|Alcove)\/\S+/gi, ""));
  // Camera, mic, location, notifications etc. stay denied until the app has a permission prompt.
  ses.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(["fullscreen", "clipboard-sanitized-write"].includes(permission)));
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
function onBlocked(request) {
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

async function initBlocker() {
  try {
    const { ElectronBlocker } = require("@ghostery/adblocker-electron");
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: path.join(app.getPath("userData"), "adblock-engine.bin"),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    blocker.on("request-blocked", onBlocked);
    applyBlocking();
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
  wc.on("dom-ready", () => { if (STORE_URL.test(wc.getURL())) injectStoreFixes(wc); });
  wc.on("console-message", (e, _level, legacyMessage) => {
    const message = typeof e.message === "string" ? e.message : legacyMessage;
    if (message === STORE_MARK && STORE_URL.test(wc.getURL())) send("store-install", { id, url: wc.getURL() });
  });
  wc.on("did-navigate", (_e, u) => send("tab-url", { id, url: u }));
  wc.on("did-navigate-in-page", (_e, u, isMainFrame) => { if (isMainFrame) send("tab-url", { id, url: u }); });
  wc.on("page-title-updated", (_e, title) => send("tab-title", { id, title }));
  wc.setWindowOpenHandler(({ url: u }) => {
    send("new-tab-request", { url: u });
    return { action: "deny" };
  });
  showOnly(id);
  // Give the ad blocker a moment to load its rules so the first page is filtered too.
  Promise.race([blockerReady, sleep(3000)]).then(() => {
    if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {}); // aborted loads (redirects) reject
  });
}

function showOnly(id) {
  for (const [k, v] of tabs) v.setVisible(k === id);
}

function closeTab(id) {
  const v = tabs.get(id);
  if (!v) return;
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
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.existsSync(path.join(dir, "manifest.json"))) continue;
    try { await ses.extensions.loadExtension(dir); } catch (e) { console.error("extension", name, e.message); }
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
  ui.webContents.loadFile(uiFile("index.html"));
  sidebarX = collapsed ? -SIDEBAR_W : 0;
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
  window_action: ({ action }) => windowAction(action),
  drag_start: startDrag,
  drag_end: () => clearInterval(dragTimer),
  sidebar_busy: ({ busy }) => { sidebarBusy = !!busy; },
  get_settings: () => ({ adblock: config.adblock, collapsed, adblockReady: !!blocker }),
  set_adblock: ({ enabled }) => {
    config.adblock = !!enabled;
    saveConfig();
    applyBlocking();
  },
  get_profiles: () => ({ profiles: config.profiles, active: config.activeProfile }),
  create_profile: ({ name }) => createProfile(String(name).trim().slice(0, 30) || "Profile"),
  switch_profile: ({ id }) => { setImmediate(() => switchProfile(id)); },
  delete_profile: ({ id }) => deleteProfile(id),
};

const fromOurPages = e =>
  [ui, palette, region, shotView].some(v => v && e.sender === v.webContents);

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
    { label: "Library", submenu: [
      item("bookmarks", "Bookmarks", "CmdOrCtrl+Shift+B"),
      item("history", "History", "CmdOrCtrl+Y"),
      item("downloads", "Downloads", "CmdOrCtrl+Shift+J"),
    ] },
    { role: "windowMenu" },
  ]);
}

app.whenReady().then(() => {
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
      ? { titleBarStyle: "hidden", trafficLightPosition: { x: 16, y: 11 } }
      : { frame: false }),
  });
  if (process.platform === "darwin") win.setWindowButtonVisibility(false);
  createUi();
  win.on("resize", layout);
  watchCursor();
});

app.on("window-all-closed", () => app.quit());
