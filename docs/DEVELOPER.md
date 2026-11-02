# Alcove: developer guide

Alcove is a productivity and privacy focused browser for macOS and Windows, with a sidebar-first design, built on
Electron (Chromium). This guide is for developers working on it: how it is put together, how to run, build and
test it, where each feature lives, and the traps we already fell into.

> **Status (2026-11-02).** Everything below was built and tested on macOS (Apple silicon). The Windows build
> is produced by CI but **has never been run by hand**. Start there; see [Windows checklist](#11-windows-checklist).

- [1. Quick start](#1-quick-start)
- [2. Repository map](#2-repository-map)
- [3. Architecture](#3-architecture)
- [4. IPC: how the pages talk to the app](#4-ipc-how-the-pages-talk-to-the-app)
- [5. State and storage](#5-state-and-storage)
- [6. Features, one by one](#6-features-one-by-one)
- [7. Security model](#7-security-model)
- [8. Testing](#8-testing)
- [9. Conventions](#9-conventions)
- [10. Gotchas we already hit](#10-gotchas-we-already-hit)
- [11. Windows checklist](#11-windows-checklist)
- [12. Known gaps and ideas](#12-known-gaps-and-ideas)

---

## 1. Quick start

**You need:** Node 22 (what CI uses) and npm. Electron 45 brings its own Chromium 156 and Node 24.

```bash
cd electron
npm install
npm start          # copies ../ui into electron/ui, then runs electron .
```

| Command (in `electron/`) | What it does |
| --- | --- |
| `npm start` | `sync-ui`, then run the app unpackaged |
| `npm run sync-ui` | copy `../ui` to `electron/ui` (the app loads its pages from there) |
| `npm run dist` | `sync-ui`, then `electron-builder`: a `.dmg` on macOS, an NSIS installer `.exe` on Windows, in `electron/dist/` |
| `npm run dist -- --mac --arm64` | macOS Apple-silicon build only |

**Edit `ui/`, never `electron/ui/`.** `electron/ui/` is a git-ignored copy that `sync-ui` overwrites on every
start and build. (`ui/` sits at the repo root, beside `electron/`; `sync-ui` copies it in.)

**Dev data is separate from the installed app.** An unpackaged run stores its data in
`~/Library/Application Support/Alcove Dev` (macOS), so developing never touches the installed app's profile.
The installed app uses `.../Alcove`. A single-instance lock means a second copy with the same data folder just
focuses the first; use `ALCOVE_USER_DATA` (below) to run a throwaway copy beside it.

**Installing a build by hand on macOS** (quit Alcove first):

```bash
rm -rf /Applications/Alcove.app && ditto electron/dist/mac-arm64/Alcove.app /Applications/Alcove.app
```

The macOS build is unsigned (`identity: null`), so the first launch on another Mac needs right-click > Open.
The Windows installer is unsigned too, so SmartScreen will warn.

**CI.** `.github/workflows/build-electron.yml` builds Windows and macOS on every push to `main` and uploads the
installers as artifacts (`alcove-electron-windows`, `alcove-electron-macos`). You can also start it by hand
from the Actions tab.

**Environment variables** (all optional, mostly for testing):

| Variable | Effect |
| --- | --- |
| `ALCOVE_USER_DATA` | use this folder as the data folder (throwaway profiles for tests) |
| `ALCOVE_TEST=1` | enables the `debug_*` commands (see [Testing](#8-testing)) |
| `ALCOVE_TEST_WIN=1` | use the Windows window buttons (the `caption` view, shown on hover) on any OS, to check them without a Windows machine |
| `ALCOVE_DOWNLOAD_DIR` | where downloads, saved images and the video downloader write |
| `ALCOVE_PERF=1` | print startup timing marks and main-thread stalls |
| `ALCOVE_DOM_OBSERVER=1` | turn the ad blocker's DOM observer back on (off by default, for measuring only) |
| `ALCOVE_IMPORT_ROOT` | pretend this folder is a browser profile for the import feature (tests) |
| `ALCOVE_YTDLP`, `ALCOVE_FFMPEG` | use these binaries instead of the downloaded ones |

---

## 2. Repository map

```
alcove/
├─ electron/                 the app
│  ├─ main.js                the whole main process (~2600 lines): windows, tabs, IPC commands, features
│  ├─ preload.js             exposes window.__TAURI__ (the IPC shim) to Alcove's own pages
│  ├─ yt-preload.js          session preload for every web page: YouTube ad skipper, SponsorBlock,
│  │                         the Markdown editor's file bridge (window.alcoveMd) and the start page's bridge (window.alcoveStart)
│  ├─ scripts/sync-ui.js     copies ../ui to electron/ui
│  ├─ package.json           scripts + electron-builder config
│  └─ build/icon.png         app icon source
├─ ui/                       every page Alcove draws itself (plain HTML/CSS/JS, no framework, no bundler)
│  ├─ index.html, app.js, style.css     the sidebar: tabs, spaces, address bar, panels
│  ├─ palette.html, palette.js          Cmd+K command palette
│  ├─ settings.html, settings.js        Settings page
│  ├─ tools.html, tools-page.js         Tools page (interface)
│  ├─ tools.js                          Tools engine (runs inside the sidebar page)
│  ├─ tools-shared.js                   state shape and helpers used by both of the above
│  ├─ newtab.html                       the start page: what a new tab shows (search, shortcuts, today's report, tools)
│  ├─ markdown.html                     the Markdown editor (one file: HTML, CSS and JS)
│  ├─ blocked.html                      page shown when Focus mode blocks a site
│  ├─ caption.html                      Windows only: the Minimize / Maximize / Close buttons
│  ├─ peek.html, divider.html, strip.html, region.html, shot.html   small overlay views
│  ├─ engines.js                        search engines, shared by sidebar, palette, settings and main
│  └─ vendor/qrcode.js                  qrcode-generator (MIT), for "QR code for this page"
├─ README.md, LICENSE        what Alcove is, install and build steps, privacy and code signing policy; the MIT license
├─ docs/DEVELOPER.md         this file
└─ .github/workflows/        CI
```

Alcove began as a Tauri app. That build was removed once Electron became the only one; it is still in git
history (`git log --all -- src-tauri`) if you ever need it.

Runtime dependencies are deliberately few: `@ghostery/adblocker-electron` (ad blocking), `adm-zip` (unpacking
extensions), and the vendored QR generator. Everything else is hand-written.

---

## 3. Architecture

### 3.1 One window, many views

Alcove is a single `BaseWindow` with no title bar and a stack of `WebContentsView`s on top of each other. Nothing
is an `<iframe>` and there is no `<webview>`.

| View | Page | What it is |
| --- | --- | --- |
| `ui` | `ui/index.html` | the sidebar. Always alive, even when hidden. It owns the tab list and is the app's UI brain |
| tab views | websites, plus `ui/newtab.html`, `ui/markdown.html` and `ui/blocked.html` | one per open tab, in the web session |
| `strip` | `ui/strip.html` | the margin above the page: drag handle, double-click to maximize |
| `caption` | `ui/caption.html` | Windows only: flat Minimize / Maximize-Restore / Close buttons, hidden until the pointer reaches the top right |
| `palette` | `ui/palette.html` | Cmd+K. Re-created on every open so it is always on top |
| `settingsView`, `toolsView` | `settings.html`, `tools.html` | full-page overlays that fill the page area (never both at once) |
| peek + backdrop | `peek.html` | the Shift-click preview |
| `divider` | `divider.html` | the drag handle between split-view panes |
| region, shot popup, extension popup | `region.html`, `shot.html` | screenshot selection, save popup, extension toolbar popups |

The sidebar and the overlay pages use the **UI session** (`uiPartition`); websites use the **web session**
(`webPartition`). See [State and storage](#5-state-and-storage).

### 3.2 Layout

The page sits in a rounded "card" with an 8 px margin on every side (`MARGIN`, `CARD_RADIUS`). Key functions in
`main.js`:

- `contentRect()` is where tab views go. With the default **overlay** sidebar it never depends on whether the
  sidebar is shown: the page keeps its full width.
- `pageRect()` is where full-page overlays (Settings, Tools) go. It is the same rectangle but starts beside the
  sidebar when the sidebar is showing, so it is never covered.
- `layout()` positions everything. It runs on every animation frame and on window resize.
- `sidebarMode` (setting): `overlay` (default; the sidebar floats over the page, rounded, in front) or `docked`
  (the page moves aside). Helpers: `floating()`, `dockedLeft()`, `clearLeft()`.
- `raiseUi()` re-adds the sidebar view so it is above any view added after it. Call it after adding a view that
  must not cover a floating sidebar.
- Edge peek: `watchCursor()` polls the cursor every 50 ms (more reliable than a transparent hot-zone view). When
  the sidebar is hidden, touching the left edge slides it in.
- Window buttons (macOS) are hidden and shown by `windowButtons()` as the pointer nears the top-left, even when
  Alcove is not the focused window. On macOS the native traffic lights are repositioned with
  `setWindowButtonPosition` when the sidebar floats.
- **Windows** has the same layout as the Mac (page card 8 px from the top, no title row). Its window buttons are the
  `caption` view (`ui/caption.html`): Windows-style Minimize, Maximize/Restore and Close (46 x 32 px each, close turns
  red on hover) on a small opaque bar over the page's top right corner. Like the Mac's they are hidden until the
  pointer goes there: `windowButtons()` shows the view when the pointer is in the top 10 px of the window above the
  buttons (a taller zone would cover a page's own sign-in and menu buttons), keeps it while the pointer stays over
  it, and hides it 400 ms after the pointer leaves. It is hidden in full screen. The view learns the maximized
  state from the `window-state` event. Set `ALCOVE_TEST_WIN=1` to see this on a Mac.

### 3.3 Glass

- **Window material.** macOS vibrancy: `sidebar` for Frosted, `under-window` for Clear. Windows 11: acrylic via
  `setBackgroundMaterial`. A transparent window is *not* used (it would show the desktop unblurred and drop the
  macOS shadow).
- **Over a page.** A view cannot blur what is behind it, so while the sidebar floats, `updateBackdrop()` captures
  the part of the page under it about 4 times a second, shrinks it, and sends it to the sidebar (`glass-backdrop`
  event). The sidebar blurs it (`#glass-bg` in `style.css`), tints it, and switches between dark text on a light
  tint and light text on a dark tint from the picture's brightness (`on-light` / `on-dark` classes).
- **Settings:** `glass`, `glassStyle` (`frosted` | `clear`), `frost` (tint), `blur`, `shine`.

### 3.4 Start-up (`main.js`, bottom)

1. `app.setPath("userData", ...)`, then the single-instance lock.
2. `app.whenReady`: `loadConfig()`, the application menu, the web session setup (ad blocker, request filter,
   session preload, permissions, extensions), then `createUi()` and `createStrip()`.
3. The sidebar page loads, asks for what it needs with commands, and restores its tabs from its own storage.

---

## 4. IPC: how the pages talk to the app

### 4.1 The shim

`electron/preload.js` gives every Alcove page a `window.__TAURI__` object. The name comes from the first,
Tauri-based version of Alcove, whose API the pages were written against; Tauri is no longer used, and this is just
a thin wrapper (renaming it would be a mechanical change across `ui/` if you want it gone):

```js
const { invoke } = window.__TAURI__.core;      // invoke("command_name", { args }) -> Promise
const { listen } = window.__TAURI__.event;     // listen("event-name", ({ payload }) => ...)
```

- `invoke` goes to `ipcMain.handle("invoke", (e, cmd, args))`, which looks `cmd` up in the **`commands`** object in
  `main.js` and returns whatever the handler returns (must be structured-cloneable; do not return timers or views).
- Events go the other way: `send(name, payload)` in main reaches the sidebar. Other views get theirs through
  `view.webContents.send("event", name, payload)` (see `settingChanged`).

### 4.2 The gate

`fromOurPages(e)` accepts an `invoke` only from the views in its list (`ui`, `palette`, `region`, `shotView`,
`peekBackdrop`, `divider`, `strip`, `settingsView`, `toolsView`). **Websites never get the shim**, so they cannot
call commands. If you add a new view that needs commands, add it to that list.

### 4.3 Adding a command

1. Add a handler to `commands` in `main.js`: `my_command: ({ a, b }) => { ... return value; }`.
2. Validate everything that comes in. Pages are ours, but treat arguments as untrusted (see `SETTING_RULES`).
3. Call it from a page: `const r = await invoke("my_command", { a, b });` (the sidebar wraps it as
   `call("my_command", args)`, which returns `null` instead of throwing).
4. If a handler defers work with `setImmediate`, wrap it in braces so it returns `undefined`; returning the timer
   handle makes IPC fail with "object could not be cloned".
5. Test-only commands start with `debug_` and must check `process.env.ALCOVE_TEST === "1"`.

### 4.4 Commands by area

| Area | Commands |
| --- | --- |
| Tabs and layout | `open_tab` `switch_tab` `close_tab` `navigate` `nav_action` `zoom` `find` `clear_find` `mute_tab` `mute_all` `toggle_dark` `search_tabs` `pip` `focus_ui` `toggle_sidebar` `sidebar_busy` `set_chrome_color` `window_action` `drag_start` `drag_end` |
| Split and peek | `set_split` `split_drag` `split_ratio` `open_peek` `peek_close` `peek_open_tab` |
| Palette | `show_palette` `hide_palette` `copy_text` `fx_rates` |
| Settings | `get_app_settings` `set_app_setting` `reset_settings` `get_app_info` `choose_download_dir` `set_default_browser` `clear_data` `open_settings` `close_settings` `take_startup` |
| Site data | `get_site_settings` `site_permissions` `remove_site_permission` `reset_site_permissions` `remove_force_dark` |
| Privacy | `get_settings` `set_adblock` `set_adblock_site` `adblock_stats` `set_sponsorblock` |
| Screenshots | `screenshot` `screenshot_region` `region_done` `region_cancel` `shot_save_as` `shot_copy` `shot_discard` |
| Extensions | `list_extensions` `install_extension` `install_unpacked_extension` `remove_extension` `extension_popup` `store_button` |
| Video download | `video_tools` `install_downloader` `download_video` `cancel_video` |
| Profiles and import | `get_profiles` `create_profile` `switch_profile` `delete_profile` `list_import_sources` `import_browser` `take_pending_import` |
| Tools | `open_tools` `close_tools` `toggle_tools` `tools_op` `notify` `activity` `focus_mode` `focus_state` `eyedropper` `page_images` `save_images` |
| Markdown | `md_url` `md_recent` `md_recent_folders` (the editor itself uses its own bridge, see 6.6) |
| Start page | `add_shortcut` (the start page itself uses its own bridge, see 6.7) |
| Misc | `reveal` |
| Tests only | `debug_window_buttons` `debug_page_menu` `debug_open_devtools` `debug_layout` `debug_resize` `debug_leave_answer` `debug_destroy_view` `debug_throw` `debug_windows` `debug_focus_popup` `debug_menu` `debug_review_answer` `debug_describe_extension` |

### 4.5 Events sent to the sidebar

`download` `new-tab-request` `screenshot-saved` `settings-changed` `settings-open` `shortcut` `sidebar-state`
`split-ratio` `split-request` `store-install` `tab-audio` `tab-blocked` `tab-focused` `tab-title` `tab-url`
`toast` `tools-op` `video-download` `window-state` (Windows caption view) `glass-backdrop`. The `shortcut` event carries the id of a
menu accelerator; the sidebar maps ids to behaviour in its `actions` table (`ui/app.js`).

### 4.6 The session preload and its channels

`yt-preload.js` is registered with `ses.registerPreloadScript({ type: "frame" })` on the web session, so it runs
in **every frame of every website**, at document start. It does three things:

1. On YouTube: installs the ad skipper (see 6.2).
2. On YouTube: SponsorBlock lookups, through `ipcMain.handle("alcove-sb")`.
3. On `ui/markdown.html` only (checked by `location`): exposes `window.alcoveMd`, the Markdown editor's file
   bridge (see 6.6), over `ipcMain.handle("alcove-md")`.
4. On `ui/newtab.html` only: exposes `window.alcoveStart`, the start page's bridge (see 6.7), over
   `ipcMain.handle("alcove-start")`.

Other direct channels: `alcove-yt-mode` (sync, asks whether to skip ads) and `alcove-yt-diag` (stuck-ad reports,
written to `yt-diagnostics.log`).

---

## 5. State and storage

### 5.1 Where things live

| Where | What | Written by |
| --- | --- | --- |
| `<userData>/config.json` | the main process's settings and lists (see 5.2) | `main.js` (`saveConfig`) |
| `<userData>/adblock-engine.bin` | cached ad-block rules; rebuilt when older than a day | ad blocker |
| `<userData>/bin/` | `yt-dlp` and `ffmpeg`, downloaded on first use of the video downloader | `main.js` |
| `<userData>/yt-diagnostics.log` | stuck-ad reports | `yt-preload.js` via main |
| `<userData>/extensions/<profile id>/` | unpacked Chrome extensions, one folder per profile | `main.js` |
| UI session `localStorage` | the sidebar's tabs and everything the pages store (5.3) | the pages |
| web session | cookies, site storage; **per profile** | Chromium |

`userData` is `.../Alcove` when installed, `.../Alcove Dev` when run unpackaged, or `ALCOVE_USER_DATA`.

### 5.2 `config.json`

`collapsed`, `adblock`, `adblockAllow` (hostnames), `sponsorBlock`, `sitePermissions` (`"origin permission"` ->
bool), `forceDark` (hostnames), `activeProfile`, `profiles` (`{ id, name, color }`), `recentMd` and
`recentMdFolders` (Markdown editor), `shortcuts` (websites pinned to the start page, `{ name, url }`, at most 24,
http(s) only) and `settings` (below). Missing keys fall back to defaults in `loadConfig`.

`saveConfig` writes `config.json.tmp` and renames it over the real file (mode 0600), keeping the previous version as
`config.json.bak`. `loadConfig` sets an unreadable file aside as `config.json.corrupt-<time>`, falls back to the `.bak`,
and then forces every key into its expected shape (arrays, the `profiles` list with a `default` entry, only settings
that pass `SETTING_RULES`; `downloadDir` may be any string).

**Settings** (`config.settings`) are defined in two tables near the top of `main.js`: `DEFAULT_SETTINGS` and
`SETTING_RULES` (a validator per key). To add a setting:

1. add the default and a rule in those two tables,
2. add a control in `ui/settings.js`,
3. react to it in `applySetting(key)` if it needs more than being read (it is applied live, via the
   `settings-changed` event to the sidebar, Settings and Tools pages),
4. read it with `S().yourKey` in main, or `appSettings.yourKey` in the sidebar.

### 5.3 Page storage keys (`localStorage` in the UI session)

| Key | Owner | Contents |
| --- | --- | --- |
| `alcove-state-v1` | sidebar | spaces, tabs, groups, pins, active tab |
| `alcove-bookmarks`, `alcove-history`, `alcove-downloads`, `alcove-closed` | sidebar | bookmarks, history (capped), downloads, recently closed tabs |
| `alcove-tools-v1` | **Tools engine only** | timers, Pomodoro, alarms, focus, task log, world-clock zones, sound |
| `alcove-tools-ctx` | Tools engine only | what the sidebar is showing, for the Tools page |
| `alcove-time-v1` | Tools engine only | seconds per site and space, per day (35 days kept) |
| `alcove-notes-v1`, `alcove-todos-v1`, `alcove-tools-tab` | Tools page | per-space notes and to-dos (a done item keeps `doneOn`), last tab |
| `alcove-done-v1` | Tools page | `{ "2026-11-02": { todos: n } }`: to-dos ticked per day (35 days). Unticking takes the count off the day it was ticked; clearing done items keeps it |

The Markdown editor is a *tab*, so its keys live in the **web** session's storage on a `file://` origin:
`alcove-md-draft` (untitled draft), `alcove-md-prefs` (text size, font, view), `alcove-md-side` (panel state),
`alcove-md-folders` (mounted folders; `alcove-md-folder` is the older single-folder key, still read once),
`alcove-md-done-v1` (`{ "2026-11-02": n }`, to-dos ticked in the editor per day; the start page reads it from the same storage).

### 5.4 Profiles and sessions

Each profile has its own web session (`persist:web-<id>`; the default profile uses `persist:alcove`) and its own
UI storage (`persist:ui-<id>`; the default profile uses the default session). Switching profiles re-creates the
sidebar. The ad blocker (Ghostery) registers global IPC handlers per session, so it is enabled only on the active
web session (`applyBlocking`).

---

## 6. Features, one by one

### 6.1 Tabs, spaces, split view, peek, palette

- State lives in the sidebar (`ui/app.js`, saved to `alcove-state-v1`). A **space** has tabs, groups and pins; a
  tab has `{ id, url, title, pinned, groupId, parentId }`. Tabs opened from a page nest under it (`childTab`).
- The sidebar tells main what to show (`open_tab`, `switch_tab`); main creates the `WebContentsView` in `openTab`
  and tracks which one is on screen in `shownId`.
- **Split view** shows two tab views side by side with a draggable `divider` view; `layout()` handles the bounds.
- **Peek** (Shift-click a link) is a floating preview window with a backdrop.
- **Closing a tab** goes through `closeTab` in `main.js`, which calls `webContents.close({ waitForBeforeUnload: true })`:
  a page with unsaved work (the Markdown editor, for a saved file with changes) asks "Leave this page?"
  (`will-prevent-unload`, `askLeave`), and if the user stays the call resolves `false` and the sidebar keeps the tab.
  The same question appears when a navigation would leave such a page. Switching profile and deleting a space close
  tabs with `force`. Whoever closes a view (the sidebar, or the page itself with `window.close()`), its `destroyed`
  event runs `dropTab` and sends `tab-closed`, so the sidebar drops the row. A view whose page is gone has no
  `webContents`: use `deadView(v)` before touching one. `uncaughtException` and `unhandledRejection` are logged, not shown.
- **Links and `window.open`** are routed by `setWindowOpenHandler` in `openTab`: Cmd/Ctrl+click opens a background
  tab, Shift+click opens Peek, and everything else becomes a tab, **except a popup that asks for a size**
  (`window.open(url, name, "width=500,height=600")`). That one gets a real child window in the same session
  (`popupWindow`, `popupCreated`), because sign-in popups ("Sign in with Google", most OAuth flows) report back to
  their opener with `postMessage` and then call `window.close()`. A tab made from just the popup's URL has no opener,
  so the sign-in ended on a blank page. A popup's own links open as tabs. Like Chromium's popup blocker, a popup needs a
  click or key press in the opener within five seconds (`view.alcoveGesture`, set from `input-event` and
  `before-input-event`), one gesture opens one popup, and a tab keeps at most two. The popup window's title is its
  host, never the page's title. Menu shortcuts are app-wide, so `item()` in the menu sends close and reload to a focused
  popup (`BrowserWindow.getFocusedWindow()`; the app's own window is a `BaseWindow`, so it never matches) instead of to the tab behind it.
- **Palette** (`ui/palette.js`; its view is a fresh one on every open, positioned by `placePalette()`, which `layout()` calls so it
  stays centred as the window resizes): fuzzy and frecency ranking, site shortcuts (`yt …`), calculator, unit and
  currency conversion, ASIN links, QR code, page actions. A new command needs a row in `COMMANDS`
  (`palette.js`) and a handler in the sidebar's `actions` table (`app.js`).

### 6.2 Ad blocking, privacy, YouTube

- `installRequestFilter(ses)` is the single `webRequest.onBeforeRequest` hook. In order: **Focus mode** blocking,
  HTTPS-only upgrade, then the Ghostery engine (unless the site is on the allow list or the request belongs to
  YouTube).
- **YouTube is exempt from request blocking on purpose.** Tested: any change to the player's ad data (removing,
  emptying, keeping only the heartbeat) made YouTube hold the real video back 5 to 7 seconds on every load. So
  `yt-preload.js` leaves the data alone and **skips** each ad the moment it starts (mute, 16x speed, seek to end,
  click Skip), and a CSS cover shows the video's thumbnail meanwhile. A watchdog logs stuck ads.
- SponsorBlock: hash-prefix lookup in main (`alcove-sb`), segments skipped by the injected script.
- Site permissions (camera, microphone, location, notifications, clipboard-read) are asked once per site and
  remembered in `sitePermissions`.

### 6.3 Extensions, downloads, screenshots, import

- **Extensions** load into the web session with `ses.extensions.loadExtension`; Web Store pages get an
  "Add to Alcove" button injected (`injectStoreFixes`), and installs unpack the CRX with `adm-zip`. A store install first
  checks the package with `electron/crx.js` (`verifyCrx`: the CRX must be signed by the key its 32-letter ID is derived
  from, CRX2 and CRX3), then shows a review (`describeExtension`, `confirmExtension`: name, version and what it can do in
  plain words, Cancel is the default), and only then unpacks and loads it. Cancelling returns `{ cancelled: true }`.
  The page can still ask for an install (its button logs a marker that `openTab` turns into `store-install`), but nothing
  is added without the review. Unpacked folders chosen by the user skip it. Installed extensions are not updated.
  Tested against a synthetic CRX2/CRX3 set and one real store package.
- **Video download** drives the open-source `yt-dlp` (and `ffmpeg`), downloaded once into `<userData>/bin`. Both are
  verified before they are kept: yt-dlp against the `SHA2-256SUMS` file of the same release (it changes often, so it
  is not pinned), ffmpeg against a SHA-256 pinned in `FFMPEG_SHA256` for release `FFMPEG_TAG` (bump them together: the
  values are the `digest` fields of `gh api repos/eugeneware/ffmpeg-static/releases/tags/<tag>`). The file is written to
  a temporary name and renamed, so a bad or cut-off download is never run. yt-dlp is not updated after install.
  Alcove implements no extraction itself.
- **Screenshots**: visible area, full page (DevTools protocol, capped for very tall pages) and region
  (`region.html` overlay), each ending in the `shot.html` save popup.
- **Import** copies the bookmarks, history (last 3000 entries) and extensions of a Chrome-family browser profile
  (Chrome, Edge, Brave, Arc, Vivaldi) into a new Alcove profile (`list_import_sources`, `import_browser`). It does
  not import passwords or cookies.

### 6.4 Settings page

`ui/settings.html` + `settings.js`. Sections are data (`SECTIONS`), rows are built with small helpers. It reads and
writes through `get_app_settings` / `set_app_setting` and listens for `settings-changed`.

### 6.5 The Tools page

**Split on purpose.** The always-running engine lives in the *sidebar* page (`ui/tools.js`) because the sidebar is
the one page that is never closed. The Tools page (`tools.html` + `tools-page.js`) is only an interface:

```
Tools page --invoke("tools_op", {op, args})--> main --send("tools-op")--> sidebar engine
                                                                              |  mutates state, save()
Tools page <------------- storage event (alcove-tools-v1 changed) -----------+
```

- **Single writer.** Only the engine writes `alcove-tools-v1`, `alcove-tools-ctx` and `alcove-time-v1`. The page
  sends **ops** and re-renders when the `storage` event fires. (Notes and to-dos are the exception: the page
  writes them itself, because no other code touches them.)
- `tools-shared.js` holds the state shape (`loadState`), formatters, `alarmDue`, the Amazon/link helpers, and is
  loaded by both sides.
- **Timers use timestamps** (`end`, `start`+`acc`), never counters, so they survive reloads and background
  throttling, and both sides can derive the same display. The page animates the stopwatch dial and rings with
  `requestAnimationFrame`.
- **Ops** the engine accepts: `sw-start|pause|reset|lap`, `timer-start|add|pause|resume|cancel`,
  `pomo-start|cfg|pause|resume|skip|stop`, `focus-start|end|sites`, `track-toggle|clear-today`,
  `task-start|stop|clear-log`, `zones`, `refresh`, `open-url`, `new-tab`, `alarm-add|toggle|delete|dismiss|snooze`,
  `sound-toggle|test`.
- **Alarms**: `{ time, label, repeat: once|daily|weekly|monthly, days, dom, on, last }`. `checkAlarms()` runs
  every second; `last` (a `date time` stamp) prevents ringing twice in a minute; a one-off alarm switches itself
  off; a 31st-of-the-month alarm rings on a short month's last day. Older alarms without `repeat` are read as
  weekly (days) or once (`repeatKind`). Ringing = a chime, an OS notification, and `open_tools` on the Alarms tab;
  `st.ringing` drives the banner and the sidebar chip. Snooze adds a one-off alarm.
- **Sound** is synthesized with Web Audio in the sidebar (`chime()`); nothing is downloaded. The sidebar view has
  `backgroundThrottling: false` so timers keep ticking in the background.
- **Focus mode** is enforced in the main process (`focus`, `focusBlocks`, in `installRequestFilter`): a blocked
  main-frame request is cancelled and the tab loads `ui/blocked.html`. Tabs already open are left alone until
  they navigate.
- **Time tracking**: every 5 s the engine asks main `activity` (window focused? idle time via `powerMonitor`) and
  credits the active site and space.
- **Page helpers**: auto-refresh (an interval per tab in the engine), eyedropper (`EyeDropper` run inside the
  page; the Tools page closes first so the picker can see the tab), download all images (`page_images`,
  `save_images`), clean link, Amazon ASIN links (Keepa, CamelCamelCamel, Seller Central).

### 6.6 The Markdown editor (`ui/markdown.html`)

A normal **tab** showing a single self-contained file. It is opened with `newTab(<md_url>)`. A `.md` file opened
in any tab is redirected to it (`mdFileOfUrl` in the tab's `did-navigate`).

**Views.** `mode` is `visual`, `code`, `split` (code + live preview) or `graph`. `prefs.mode`/`prefs.split` remember
the last editing view; Graph is somewhere to look from, never remembered.

**The text is the source of truth** (`ta.value`, the `<textarea>`). Both views edit it:

- *Code view* edits the textarea. Edits go through `replaceRange()`, which uses `execCommand` so the browser's
  undo works, and **never aims it at the hidden textarea** (it checks `document.activeElement`).
- *Visual view* is a `contenteditable` page. Every change is converted back to Markdown by `domToMarkdown()` and
  written into `ta.value` (debounced 150 ms, `syncSoon`). **Switching views does not rewrite the file**:
  `visDirty` is only set by real edits, so nothing is normalised until you type.
- Going the other way, `render()` (Markdown -> HTML) fills the visual page (`renderVisual`) and the preview.

**The renderer is escape-first.** `render()`/`inline()` escape all HTML before formatting, keep only `http(s)`
and `mailto:` links and `http(s)` images, and support backslash escapes. A document cannot inject markup.
Supported: headings, paragraphs, bold/italic/strike/code, links, images, lists (nested, ordered, to-do),
quotes, fenced code, tables (alignment), rules, `#tags`, front matter (hidden in the preview).

**Typing in Visual view** (`vis.addEventListener("keydown")`): `# ` heading, `- ` list, `1. ` numbered list,
`[] ` to-do, `> ` quote, ```` ```js ```` + Enter code block, `---` + Enter divider, `#tag ` becomes a tag chip. Enter
continues lists and to-dos, and leaves quotes and code blocks on an empty line. Tab indents list items and moves
between table cells.

**Tags.** Front matter `tags: [a, b]` (also block-list form) and inline `#tags`. The tag bar edits front matter
through `setTags`. Clicking any tag chip opens a search for it.

**Folders ("mounted" like vaults).**

- `bridge.openFolder()` (dialog) or a remembered path adds a root to the main process's `mdRoots`; the page keeps
  `folders` and persists them in `alcove-md-folders`. Mounting and unmounting in one editor tab is mirrored in the
  others through the `storage` event.
- Unmount removes the root from `mdRoots` (the editor can no longer list it), keeps the files, and offers Undo.
  *Unmount and forget* also removes it from `recentMdFolders`.
- The tree lists only folders and `md|markdown|mdown|mkd|txt` files, skips hidden entries, `node_modules` and
  symlinks, and loads one directory at a time.

**The file bridge (`window.alcoveMd`, channel `alcove-md`).** Operations and their checks, in `main.js`:

| Op | Does | Checks |
| --- | --- | --- |
| `open`, `read` | read a file (max 5 MB) | extension must be Markdown/text; remembers it as writable |
| `save` | write atomically (temp + rename) | path must be one this session read or saved |
| `saveAs` | save dialog, then write | name sanitised; `.md` added if missing |
| `openFolder`, `folder` | mount a folder | `folder` only accepts paths in `recentMdFolders` |
| `list` | one directory's entries | must be inside a mounted root |
| `newFile`, `newFolder` | create | inside a mounted root; name sanitised; refuses to overwrite |
| `graph` | scan every note for links and tags | mounted root; max 3000 files, depth 12, 1 MB per file |
| `search` | text or `#tag` search | mounted roots; max 150 notes, 30 matches per note |
| `recentFolders`, `unmount`, `forget`, `reveal` | housekeeping | `reveal` only inside a mounted root |

Every call also checks `e.senderFrame.url` is exactly `ui/markdown.html`.

**Graph view.** `mdGraph` reads each note once (`mdScan` pulls `[[wiki links]]`, relative `.md` links, tags;
code blocks are ignored), resolves links (wiki links by path, then by shallowest file name), and reports
unresolved links as "ghost" nodes. The page lays them out with a small force simulation on a `<canvas>`
(grid-based repulsion, springs, drag, pan, zoom, search, "this note" depth). Several mounted folders are
scanned separately and merged on the page.

**Search.** `mdSearch` supports plain text, match case, regular expressions, file-name matches and `#tag` (prefix,
front matter and inline). With an empty query it returns the tags in use with counts. A result click opens the
note (`openAt`) and selects the match: by line and column in Code view, by "nth occurrence of that text" in
Visual view, falling back to Code view when the match is not visible text. Search reads from disk, so unsaved
edits are not searched.

### 6.7 The start page (`ui/newtab.html`)

What a new tab shows. Setting `newTab` is `start` (default), `engine` (the search engine's home page), `blank` or
`custom`; `loadConfig` moves a saved `engine` to `start` once (`settingsVersion` 3), so an explicit choice made
afterwards sticks. `app.js` builds the URL with `newTabUrl()`.

It is a normal tab on a `file://` page, self-contained like the Markdown editor, with four parts:

- **Search bar** with the address bar's rules (`normalize`: scheme, domain, `localhost`, else the chosen engine).
  Typing anywhere focuses it.
- **Shortcuts**: pinned websites. Add, edit, remove and drag to reorder on the page; "Add to Start Page" in a page's
  right-click menu and "Add to start page" in a sidebar tab's menu add one too (`addShortcut` in `main.js`, command
  `add_shortcut`). Stored in `config.shortcuts`, so they are shared by all profiles. Icons come from
  `<origin>/favicon.ico`, the same way the sidebar's tabs get theirs; a coloured letter is the fallback. Tiles are
  real links, so Cmd/Ctrl+click opens a background tab.
- **Today**: a live report, refreshed every second from data polled every 2 s. To-dos done (counted per day in
  `alcove-done-v1`, with the open count from `alcove-todos-v1`), Markdown to-dos done (`alcove-md-done-v1`, which the
  editor writes and the page sees at once through the `storage` event), browsing time and top sites
  (`alcove-time-v1`), task time (the task log plus the task running now) and Pomodoros. "Copy report" puts the day
  as plain text on the clipboard.
- **Tools**: a tile per Tools tab with a live status (timer, Pomodoro and stopwatch countdowns, next alarm, focus
  mode, world clock) and quick-start buttons for 5, 15 and 25 minute timers and a Pomodoro.

**Layout and resizing.** The sidebar floats over every page, so the start page's view spans the whole window and
its left edge can sit under the sidebar. `layout()` ends with `sendInset`, which tells the page the width of the
sidebar's right edge (`sideCover`, animated by `animate()` together with `sidebarX` and `contentLeft`, so the number
follows the slide with no jump; `0` while the sidebar is hidden or docked, and not changed by a hover peek). The page
sets `--inset` as left padding on `body` and centres its content in the rest. Inside that space it adapts with CSS
container queries on `main` (a column count that follows `minmax(min(Npx, 100%), 1fr)` grids, a compact search bar
under 560 px). The window is at least 640 px wide, so the visible part can be about 344 px. The Tools and Settings
pages are different: they are separate views placed beside the sidebar (`pageRect()`), so their own viewport is the
available width and they use plain media queries (Tools: under 600 px its tab bar moves to its own row).

**The bridge (`window.alcoveStart`, channel `alcove-start`).** The Tools engine and the to-do list live in the
*sidebar's* storage, which the tab cannot read, so the page asks `main.js`:

| Call | What it does |
| --- | --- |
| `settings` | search engine, custom search URL and accent only |
| `inset`, `onInset(cb)` | how many pixels of the page's left edge the floating sidebar covers: the value now, then every change (see below) |
| `toolsData` | the four storage values above as JSON text, read from the sidebar with `executeJavaScript` |
| `shortcuts`, `setShortcuts` | read and replace the list (validated: http(s), at most 24, names cut to 40) |
| `openTools(tab)` | opens the Tools page on that tab |
| `openMarkdown` | loads the Markdown editor in this tab |
| `startTimer(min)`, `startPomodoro` | the only two engine ops allowed (`START_OPS`), minutes clamped to 1-600 |
| `copy(text)` | clipboard, capped at 8000 characters |

Every call checks `e.senderFrame.url` is exactly `ui/newtab.html`. The engine stays the single writer of its keys:
the page only sends ops.

---

## 7. Security model

- **Websites get no app access.** Only Alcove's own views get `window.__TAURI__`, and every command passes
  `fromOurPages`. Websites run sandboxed with context isolation and no Node.
- **Alcove's own pages are not websites.** Tabs that show them (`ui/newtab.html`, `ui/markdown.html`, `ui/blocked.html`, anything
  under `UI_PREFIX`) get no "View Page Source" or "Inspect" in their right-click menu, their developer tools are
  closed if opened (`devtools-opened`), and `view-source:` of them is refused. Websites keep the normal menu.
- **The start page bridge is narrow too** (6.7): one `file://` page, sender URL checked, a fixed list of calls, and
  only two engine ops (a timer and a Pomodoro). It exposes no file or navigation access.
- **The Markdown bridge is narrow**: exists only on one `file://` page, checks the sender's URL, reads only
  Markdown/text files, writes only to paths the session opened or the user chose in a dialog, lists only inside
  folders the user mounted, and never returns file contents it was not asked for.
- **Site permissions** (`askPermission`): one dialog at a time and one per site and permission; **Block** is the default
  button and "Remember" starts unticked, so a stray Enter cannot grant camera, microphone, location or notifications.
  The check handler answers `true` only for the permissions the request handler allows outright (`ALWAYS_ALLOWED`).
- **HTTPS-Only** leaves plain http alone for local addresses only (`isLocalHttp` parses the host: loopback, private
  ranges, `.local`, `.test`; `localhost.evil.com` and `10.evil.com` are not local).
- **Settings** are validated per key (`SETTING_RULES`); arguments to commands are validated in the handler.
- **Content from files or pages is data.** The Markdown renderer escapes first; the Tools page and sidebar build
  DOM with `textContent` and elements rather than HTML strings wherever the text is not ours.
- **Private data stays local.** Time tracking, notes, to-dos and timers are stored on the device only. The app
  contacts the network for: the ad-block lists, SponsorBlock (a short hash prefix), exchange rates (palette), the
  yt-dlp and ffmpeg downloads, and the Chrome Web Store when installing extensions.

---

## 8. Testing

**There is no automated test suite yet.** Behaviour was verified by driving a real instance through the Chrome
DevTools protocol (CDP) and by hand. The approach is worth reusing.

### 8.1 Run a throwaway instance with a debug port

```bash
T=$(mktemp -d)   # a fresh profile; never test against the installed app's data
ALCOVE_USER_DATA="$T" ALCOVE_TEST=1 ALCOVE_DOWNLOAD_DIR="$T/dl" \
  electron/node_modules/.bin/electron electron --remote-debugging-port=9333 \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  --disable-background-timer-throttling
```

The three `--disable-...` flags keep timers and rendering alive when the window is not in front, which matters
for anything timing-based. `http://127.0.0.1:9333/json` lists every view (sidebar, tabs, Tools, Settings,
palette) as a CDP target.

### 8.2 Drive it

A minimal helper (Node 22+, built-in `WebSocket`):

```js
const targets = async () => (await fetch("http://127.0.0.1:9333/json")).json();
const ev = (t, expr) => new Promise(res => {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
    params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) { ws.close(); res(d.result?.result?.value); } };
});
// call any command from the sidebar page:
const ui = (await targets()).find(t => t.url.includes("index.html"));
await ev(ui, `window.__TAURI__.core.invoke("get_app_info")`);
```

Useful patterns: click real buttons with `el.click()` and read the DOM back; read `localStorage` to check state;
`Page.captureScreenshot` on a target to *look* at a page (it captures the page's own pixels, not native
vibrancy); dispatch `KeyboardEvent`s to exercise typing handlers; seed `config.json` in the throwaway folder
before launch.

### 8.3 Test hooks

With `ALCOVE_TEST=1`: `debug_layout` (where the sidebar, strip, caption buttons, page card, shown tab, Tools and
Settings views are), `debug_resize` (`{ w, h }`: sets the window's content size, to test responsive layouts; read the
result with `debug_layout` and scan a page for elements wider than `innerWidth`),
`debug_window_buttons` (runs the window-button hover logic for a point), `debug_page_menu` (returns the
labels of a tab's right-click menu), `debug_open_devtools` (tries to open developer tools on a tab).

### 8.4 What this does not cover

Native menus and accelerators, native file dialogs, the macOS vibrancy blur and traffic-light placement, real
notification banners, and **everything on Windows**. Check those by hand before a release.

### 8.5 Release checklist (manual)

Open and close the sidebar (button, edge hover, `Cmd+S`); open links in a background tab and Peek; split view;
install a Chrome extension; ad blocking on and off; a YouTube video (no black frame, ads skipped); a download and a
screenshot; each Tools tab including a real alarm; the Markdown editor in both views with a folder mounted;
Settings changes applying live; quit and relaunch (tabs restored).

---

## 9. Conventions

- **Write code that reads like the code around it**: same naming, comment density and idiom. Comments say *why*.
- **No framework, no bundler, no new runtime dependency** unless there is no reasonable alternative. Pages are plain
  scripts; share code through small files loaded with `<script>`.
- **Edit `ui/`**, not `electron/ui/`.
- **Pages that are always alive** (the sidebar) should do work; overlay pages should only present it.
- **One writer per piece of state.** If two places write, they will race.
- **Validate at the boundary**: command arguments, setting values, paths from pages.
- **Commit messages**: a short imperative subject, then a body that says what and why. Verify a change in a
  throwaway instance before committing.
- Before touching glass, layout or timing, read the matching section above; several behaviours are the result of
  measured dead ends.

---

## 10. Gotchas we already hit

- **`style.css` gives every `<svg>` `fill: none; stroke: currentColor`.** Custom SVG (the stopwatch dial) inherits
  an outline on text and circles. Reset with `stroke: none` on the elements that should be solid.
- **`display` beats `hidden`.** A panel with its own `display: flex` ignores the `hidden` attribute. Pages that
  toggle `hidden` need `[hidden] { display: none !important; }` (the Markdown editor has it).
- **`execCommand` acts on the focused editable.** Never call it while the other editor is focused: in Visual view
  the textarea is hidden and a stray `insertText` would land in the page. See `replaceRange`.
- **Chromium `contenteditable` quirks:** `formatBlock` leaves bare text in `<blockquote>` (normalise to `<p>`);
  Enter in a quote splits it into two quotes; a lone trailing space after an inline element is collapsed away when
  you type (use `&nbsp;`; the serializer turns it back into a space); a `<ul>` can end up inside a `<p>`;
  `Range.intersectsNode` is false for a caret on a list's edge.
- **A caret set inside an `input` event can be overridden** when the editing command finishes. Set it again with
  `setTimeout(0)` if it is not where you left it (see `autoTag`).
- **`e.currentTarget` is `null` after an `await`.** Capture it first.
- **IPC return values must be cloneable.** A command that returns a `setImmediate` handle fails.
- **Electron's `will-navigate` blocks `location.reload()`** on a view that prevents navigation (the sidebar does).
  Reload through CDP `Page.reload` in tests.
- **Ghostery registers global IPC handlers per session**, so enable it on one session at a time.
- **Test instances share the single-instance lock and the storage lock** of their data folder. Always give a test
  its own `ALCOVE_USER_DATA`; a test that shares the real profile slows startup (a storage `LOCK` wait) and can
  corrupt your session.
- **Anything that needs `window.opener` must stay a window.** Electron cannot turn a popup into a tab and keep the
  opener, so `window.open` calls with a size are real windows (6.1). To test a sign-in flow without a real account,
  serve two local pages: one that calls `window.open('/popup', 'x', 'width=480,height=620')`, and a popup that sends
  `opener.postMessage(...)` and `window.close()`. Run the CDP call with `userGesture: true`.
- **The native `prompt()` does not exist in Electron.** The editor uses its own small popover (`ask()`).
- **`webContents.capturePage` on an offscreen or hidden view returns an empty image.** `updateBackdrop` skips
  those cases.

---

## 11. Windows checklist

The code already branches on `process.platform` and uses `path` for separators, but none of it has run on
Windows. Verify in this order:

1. **It builds and starts.** Get the CI artifact (`alcove-electron-windows`), install it, launch. Check the
   console (`ALCOVE_PERF=1`) for errors.
2. **Window frame.** The window is frameless (`frame: false`): `ui/strip.html` is the drag area and `ui/caption.html`
   the Minimize / Maximize / Close buttons, which appear on hover at the top right (checked on a Mac with
   `ALCOVE_TEST_WIN=1`, never on Windows). Check that they appear when the pointer hits the top edge at the right
   (including a maximized window, where that edge is the top of the screen), stay while it is over them, hide
   after it leaves, look and behave like Windows ones, the icon switches to Restore when maximized, dragging (`startDrag()`, cursor polling) and double-click to maximize work,
   and multi-monitor DPI. Known gap: a frameless window gets no Aero Snap or Windows 11 snap-layout flyout; the
   native alternative is `titleBarStyle: "hidden"` with `titleBarOverlay`, which draws real caption buttons.
3. **Glass.** Windows 11 acrylic via `setBackgroundMaterial("acrylic")`. Check that it renders, that the
   over-the-page backdrop (`updateBackdrop`) and adaptive text look right, and what happens on Windows 10 (no
   acrylic): `glass` may need to default to off there.
4. **Shortcuts.** Accelerators use `CmdOrCtrl`; macOS-only ones (`Cmd+Alt+Right`) have Windows variants
   (`Ctrl+Alt+Right`, `Alt+1..9`). Check none collide with Windows or Chromium shortcuts.
5. **Paths.** Folder code splits on both `/` and `\` (`under()` in the editor) and uses `path.sep` in main.
   Check mounting a folder on another drive, a path with spaces, and long paths.
6. **External tools.** `yt-dlp.exe` and the Windows `ffmpeg` download in `main.js` (`findBinary`, the asset names).
   Check the video downloader end to end.
7. **Notifications and sound.** Alarms use Electron `Notification` and Web Audio. Check the Windows toast and
   Focus Assist behaviour.
8. **Default browser.** `set_default_browser` and opening links from other apps (`isWebUrl`, `second-instance`).
9. **Installer.** NSIS config is minimal (`win.target: nsis`). Decide on icon, install scope, auto-update and
   code signing (SmartScreen warns on unsigned installers).
10. **The Markdown editor.** Open/save dialogs, drag a file onto the window (`webUtils.getPathForFile`), and
    CRLF files (the scanner handles `\r\n`, check the editor round trip).

---

## 12. Known gaps and ideas

- **Windows** is untested (above).
- **No automated tests.** The CDP scripts in 8.2 are the starting point for a regression suite.
- **Licence: MIT** (`LICENSE`, `"license"` in `electron/package.json`). Provenance note: the sidebar design was
  influenced by the Nook browser (GPL-3.0, macOS-only). Alcove contains none of its code and uses a different name
  and icon because of Nook's trademark policy. Dependencies keep their own licences (README lists them); keep the
  notice at the top of `ui/vendor/qrcode.js`.
- **Code signing.** Installers are unsigned, so Chrome and SmartScreen warn on Windows. The plan is free signing from
  the SignPath Foundation, which needs a public repository, a public release, a "Code signing policy" section
  naming the team roles (the README has a placeholder), two-factor authentication on GitHub and SignPath, and a
  build signed from CI with a manual approval per release. The signed release workflow is written after approval,
  because SignPath dictates its steps.
- Markdown editor: no rename or delete in the file tree, search ignores unsaved edits, the Visual view normalises
  the file the first time you edit it (blank lines between blocks, `*` bullets become `-`).
- Glass could not be checked pixel-for-pixel from automated tests (native vibrancy is not capturable); judge by eye.
- Ideas discussed but not built: an AI assistant with the user's own API key (summarise pages, ask questions;
  key kept in the OS keychain), clipboard history, lap export for the stopwatch.
