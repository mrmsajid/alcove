const { app, BaseWindow, WebContentsView, Menu, ipcMain, shell, session } = require("electron");
const path = require("path");
const fs = require("fs");

const SIDEBAR_W = 280;
const PARTITION = "persist:alcove";
const PRELOAD = path.join(__dirname, "preload.js");
const uiFile = name => path.join(__dirname, "ui", name);

let win;
let ui;
let palette = null;
const tabs = new Map(); // tab id -> WebContentsView
const lastFind = new Map();

const send = (name, payload) => {
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send("event", name, payload);
};

function layout() {
  const { width, height } = win.getContentBounds();
  ui.setBounds({ x: 0, y: 0, width: SIDEBAR_W, height });
  for (const v of tabs.values()) {
    v.setBounds({ x: SIDEBAR_W, y: 0, width: Math.max(width - SIDEBAR_W, 1), height });
  }
}

function showOnly(id) {
  for (const [k, v] of tabs) v.setVisible(k === id);
}

function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let n = 1; ; n++) {
    const c = path.join(dir, `${name} (${n})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
}

function setupSession() {
  const ses = session.fromPartition(PARTITION);
  // Some sites refuse to work when the UA names Electron.
  ses.setUserAgent(ses.getUserAgent().replace(/\s(Electron|alcove|Alcove)\/\S+/gi, ""));
  // Deny camera, mic, geolocation, notifications etc. until the app has a permission prompt.
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
}

function openTab(id, url) {
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const wc = view.webContents;
  tabs.set(id, view);
  win.contentView.addChildView(view);
  layout();
  wc.on("did-navigate", (_e, u) => send("tab-url", { id, url: u }));
  wc.on("did-navigate-in-page", (_e, u, isMainFrame) => { if (isMainFrame) send("tab-url", { id, url: u }); });
  wc.on("page-title-updated", (_e, title) => send("tab-title", { id, title }));
  wc.setWindowOpenHandler(({ url: u }) => {
    send("new-tab-request", { url: u });
    return { action: "deny" };
  });
  wc.loadURL(url).catch(() => {}); // aborted loads (redirects) reject; the page events cover the rest
  showOnly(id);
}

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
  const w = Math.min(Math.max(width - SIDEBAR_W - 40, 300), 580);
  const x = SIDEBAR_W + Math.max((width - SIDEBAR_W - w) / 2, 0);
  palette = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  palette.setBounds({ x: Math.round(x), y: 70, width: Math.round(w), height: Math.max(Math.min(420, height - 90), 200) });
  win.contentView.addChildView(palette);
  palette.webContents.loadFile(uiFile("palette.html"));
  palette.webContents.focus();
}

const wcOf = id => tabs.get(id)?.webContents;

const commands = {
  open_tab: ({ id, url }) => openTab(id, url),
  switch_tab: ({ id }) => showOnly(id),
  close_tab: ({ id }) => {
    const v = tabs.get(id);
    if (!v) return;
    win.contentView.removeChildView(v);
    v.webContents.close();
    tabs.delete(id);
    lastFind.delete(id);
  },
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
  focus_ui: () => ui.webContents.focus(),
  show_palette: showPalette,
  hide_palette: () => setImmediate(hidePalette),
  reveal: ({ path: p }) => shell.showItemInFolder(p),
};

const fromOurPages = e => e.sender === ui?.webContents || e.sender === palette?.webContents;

ipcMain.handle("invoke", (e, cmd, args) => {
  if (!fromOurPages(e)) throw new Error("forbidden");
  const handler = commands[cmd];
  if (!handler) throw new Error(`unknown command: ${cmd}`);
  return handler(args || {});
});

ipcMain.on("emit", (e, name, payload) => {
  if (fromOurPages(e)) send(name, payload);
});

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
      ...(mac ? [] : [{ type: "separator" }, { role: "quit" }]),
    ] },
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
      { type: "separator" },
      item("find", "Find in Page", "CmdOrCtrl+F"),
    ] },
    { label: "View", submenu: [
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
  setupSession();
  Menu.setApplicationMenu(buildMenu());

  win = new BaseWindow({
    width: 1280, height: 800, minWidth: 640, minHeight: 400,
    title: "Alcove", backgroundColor: "#1c1c22", autoHideMenuBar: true,
  });

  ui = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  });
  ui.webContents.on("will-navigate", e => e.preventDefault());
  ui.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.contentView.addChildView(ui);
  ui.webContents.loadFile(uiFile("index.html"));
  layout();
  win.on("resize", layout);
});

app.on("window-all-closed", () => app.quit());
