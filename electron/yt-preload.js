// Runs in every page of the web session before the page's own scripts. On YouTube it installs the ad
// skipper right away, so it is already watching when an ad starts.
//
// Why skip instead of removing ads from YouTube's data: tested 2026-11-02, any change to the player's
// ad data (deleting it, emptying it, or keeping only the heartbeat) made YouTube hold the real video
// back ~5-7 s on every load, sometimes indefinitely. Skipping leaves the data intact: videos start in
// ~1.5 s and an ad, when one is served, is gone within a fraction of a second.
const { contextBridge, webFrame, ipcRenderer, webUtils } = require("electron");

// Executed inside YouTube's own page (main world), before any of its scripts.
function youtubePage(sponsorBlock) {
  if (window.__alcoveYT) return;
  window.__alcoveYT = true;

  // While an ad plays, the page CSS covers the player with the video's own thumbnail (so it just looks
  // like the video is loading); here the ad is muted, jumped to its end and skipped, then sound returns.
  const videoId = () => new URLSearchParams(location.search).get("v") || (location.pathname.match(/\/shorts\/([\w-]+)/) || [])[1];
  let wasMuted = null;
  let watched = null;
  let adSince = 0;       // when the current ad state began
  let reported = false;  // diagnostic sent for this ad state

  // SponsorBlock: segments come from the app (see main.js) and are skipped as playback reaches them.
  let sbFor = null;
  let segments = [];
  const SB_LABELS = { sponsor: "Skipped sponsor", selfpromo: "Skipped self-promotion", interaction: "Skipped subscribe reminder" };
  window.addEventListener("message", e => {
    const r = e.source === window && e.data && e.data.__alcoveSBResult;
    if (r && r.id === sbFor) segments = r.segments || [];
  });
  const skippedNote = (p, category) => {
    const note = document.createElement("div");
    note.className = "alcove-sb";
    note.textContent = SB_LABELS[category] || "Skipped segment";
    p.appendChild(note);
    setTimeout(() => note.remove(), 2200);
  };
  const tick = () => {
    const p = document.getElementById("movie_player");
    if (p && p !== watched) {
      watched = p;
      new MutationObserver(tick).observe(p, { attributes: true, attributeFilter: ["class"] });
    }
    const v = p && p.querySelector("video");
    if (!v) return;
    if (!v.__alcoveHooked) {
      v.__alcoveHooked = true;
      for (const ev of ["loadedmetadata", "durationchange", "playing"]) v.addEventListener(ev, tick);
    }
    if (p.classList.contains("ad-showing") || p.classList.contains("ad-interrupting")) {
      if (!adSince) adSince = Date.now();
      // Never leave the cover up on a player that is stuck: after 2.5 s show YouTube's own state and
      // report what the player was doing.
      if (Date.now() - adSince > 2500 && !p.hasAttribute("data-alcove-stuck")) {
        p.setAttribute("data-alcove-stuck", "");
        if (!reported) {
          reported = true;
          window.postMessage({ __alcoveDiag: {
            video: videoId(), page: location.pathname + location.search.slice(0, 20),
            stuckMs: Date.now() - adSince, classes: p.className.slice(0, 200),
            state: typeof p.getPlayerState === "function" ? p.getPlayerState() : null,
            t: v.currentTime, duration: String(v.duration), paused: v.paused, readyState: v.readyState,
            networkState: v.networkState, error: v.error ? v.error.code : null, rate: v.playbackRate,
            src: (v.currentSrc || "").slice(0, 30), skipButton: !!document.querySelector(".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern"),
          } }, "*");
        }
      }
      const id = videoId();
      if (id && p.dataset.alcoveThumb !== id) {
        p.dataset.alcoveThumb = id;
        p.style.setProperty("--alcove-thumb",
          `url("https://i.ytimg.com/vi/${id}/maxresdefault.jpg"), url("https://i.ytimg.com/vi/${id}/hqdefault.jpg")`);
      }
      if (wasMuted === null) wasMuted = v.muted;
      v.muted = true;
      try { v.playbackRate = 16; } catch {}
      if (isFinite(v.duration) && v.duration > 0.5 && v.currentTime < v.duration - 0.3) v.currentTime = v.duration - 0.1;
      document.querySelectorAll(".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern").forEach(b => b.click());
    } else {
      if (sponsorBlock && location.pathname === "/watch") {
        const id = videoId();
        if (id && id !== sbFor) { sbFor = id; segments = []; window.postMessage({ __alcoveSB: id }, "*"); }
        for (const s of segments) {
          if (v.currentTime >= s.start && v.currentTime < s.end - 0.4) { v.currentTime = s.end; skippedNote(p, s.category); break; }
        }
      }
      adSince = 0;
      reported = false;
      p.removeAttribute("data-alcove-stuck");
      if (wasMuted !== null) {
        v.muted = wasMuted;
        wasMuted = null;
        if (v.playbackRate > 2) v.playbackRate = 1;
      }
    }
  };
  setInterval(tick, 100);
  tick();
}

const YT = /^(?:www\.|m\.|music\.)?youtube\.com$/;
if (window === window.top && YT.test(location.hostname)) {
  // Forward the page's stuck-ad report to the app (the page itself has no app access).
  window.addEventListener("message", e => {
    if (e.source !== window || !e.data) return;
    if (e.data.__alcoveDiag) ipcRenderer.send("alcove-yt-diag", e.data.__alcoveDiag);
    if (e.data.__alcoveSB) {
      const id = String(e.data.__alcoveSB);
      ipcRenderer.invoke("alcove-sb", id).then(segments => window.postMessage({ __alcoveSBResult: { id, segments } }, "*"), () => {});
    }
  });
  const mode = ipcRenderer.sendSync("alcove-yt-mode", location.hostname); // { css } or null when off
  if (mode) {
    webFrame.insertCSS(mode.css);
    // Runs synchronously, so it is in place before YouTube's own scripts.
    if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: youtubePage, args: [!!mode.sponsor] });
    else webFrame.executeJavaScript(`(${youtubePage.toString()})(${!!mode.sponsor})`);
  }
}

// The start page (ui/newtab.html) gets a small bridge to the tools: its settings, the Tools engine's saved state
// (timers, time tracking, to-dos), a copy command and a few launchers. main.js checks that the caller is that page.
if (window === window.top && location.protocol === "file:" && /\/ui\/newtab\.html$/.test(location.pathname)) {
  const start = (op, a, b) => ipcRenderer.invoke("alcove-start", op, a, b);
  contextBridge.exposeInMainWorld("alcoveStart", {
    settings: () => start("settings"),
    inset: () => start("inset"),
    onInset: cb => ipcRenderer.on("alcove-inset", (_e, n) => cb(Number(n) || 0)),
    toolsData: () => start("tools-data"),
    copy: text => start("copy", text),
    shortcuts: () => start("shortcuts"),
    setShortcuts: list => start("shortcuts-set", list),
    openTools: tab => start("tools", tab),
    openMarkdown: () => start("markdown"),
    startTimer: minutes => start("op", "timer-start", minutes),
    startPomodoro: () => start("op", "pomo-start"),
    setPrivate: on => start("private", !!on), // the private-session switch beside the search bar
  });
}

// The Markdown editor page (ui/markdown.html) is the only page that gets a file bridge. main.js checks that
// the caller is that page and that the path is a Markdown or text file before reading or writing anything.
if (window === window.top && location.protocol === "file:" && /\/ui\/markdown\.html$/.test(location.pathname)) {
  const md = (op, a, b, c) => ipcRenderer.invoke("alcove-md", op, a, b, c);
  contextBridge.exposeInMainWorld("alcoveMd", {
    open: () => md("open"),
    read: p => md("read", p),
    save: (p, text, mtime) => md("save", p, text, mtime),
    saveAs: (name, text) => md("saveAs", name, text),
    openFolder: () => md("openFolder"),
    folder: p => md("folder", p),
    list: p => md("list", p),
    recentFolders: () => md("recentFolders"),
    unmount: (dir, forget) => md("unmount", dir, forget),
    forget: () => md("forget"),
    reveal: p => md("reveal", p),
    newFile: (dir, name) => md("newFile", dir, name),
    newFolder: (dir, name) => md("newFolder", dir, name),
    graph: p => md("graph", p),
    search: o => md("search", o),
  });
  // A file dropped on the page opens in the editor (the page gets the path, never the File object).
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  window.addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); }, true);
  window.addEventListener("drop", e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    const dropped = f ? webUtils.getPathForFile(f) : ""; // empty for a File a script made up
    // Tell the app first: it only lets the editor read files it knows the user opened or dropped.
    if (dropped) md("allow", dropped).then(() => window.postMessage({ __alcoveMdDrop: dropped }, "*"));
  }, true);
}

// ---- gestures, in every tab's top page: swipe between pages, and the mouse's back and forward buttons ----
// Two fingers sideways on a trackpad (or a swipe in from the left or right edge of a touch screen) shows an arrow that follows the
// fingers; past the line it turns blue, and letting go there goes back or forward. A page that scrolls sideways keeps the swipe: it only
// counts when nothing under the pointer can scroll further that way and the page didn't take the wheel itself. The app does the
// navigating (main.js, "alcove-nav") and says whether it's switched on. A plain mouse wheel never swipes: it scrolls up and down, and
// Shift + wheel (sideways scrolling) is left alone.
if (window === window.top) {
  const nav = (op, kind) => ipcRenderer.invoke("alcove-nav", op, kind);
  const LINE = 150; // how far to swipe, in px of finger travel
  const ease = k => 1 - Math.pow(1 - k, 3);
  let ui = null, can = null;
  function arrow(progress, dir, ok) { // dir 1 = back (arrow on the left), -1 = forward (on the right)
    if (!ui) {
      // a closed shadow root on <html>, styled through the CSSOM only (so any page CSP allows it); it never takes the pointer
      const host = document.createElement("alcove-swipe"), root = host.attachShadow({ mode: "closed" });
      const dot = document.createElement("div"), NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), p = document.createElementNS(NS, "path");
      svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", "22"); svg.setAttribute("height", "22");
      for (const [k, v] of [["d", "M14.5 5.5 8 12l6.5 6.5"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2.5"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"]]) p.setAttribute(k, v);
      svg.append(p); dot.append(svg); root.append(dot);
      ui = { host, dot, svg };
    }
    if (!ui.host.isConnected) { ui.host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647"; document.documentElement.append(ui.host); }
    const k = Math.max(0, Math.min(1, progress)), done = k >= 1 && ok;
    ui.dot.style.cssText = `position:absolute;top:50%;${dir > 0 ? `left:${(can && can.inset) || 0}px` : "right:0"};width:46px;height:46px;margin-top:-23px;border-radius:50%;` +
      `display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.28);` +
      `background:${done ? "#3b74ff" : "rgba(28,28,32,.86)"};transition:background .12s;` +
      `transform:translateX(${dir * (-52 + 76 * ease(k))}px) scale(${done ? 1.06 : .72 + .28 * k});opacity:${ok ? Math.min(1, k * 1.8) : .3 * k}`;
    ui.svg.style.transform = dir > 0 ? "" : "scaleX(-1)";
  }
  function hide() {
    if (!ui || !ui.host.isConnected) return;
    ui.dot.style.transition = "transform .2s ease, opacity .2s ease"; ui.dot.style.opacity = "0";
    setTimeout(() => ui.host.remove(), 220);
  }
  // can this element, or one around it, still scroll sideways this way? then the swipe is the page's
  function scrollsX(el, dx) {
    const room = e => (dx < 0 ? e.scrollLeft > 0 : e.scrollLeft + e.clientWidth < e.scrollWidth - 1);
    for (let e = el && el.nodeType === 1 ? el : el && el.parentElement; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (e.scrollWidth > e.clientWidth + 1 && /(auto|scroll|overlay)/.test(getComputedStyle(e).overflowX) && room(e)) return true;
    }
    const s = document.scrollingElement || document.documentElement;
    return s.scrollWidth > s.clientWidth + 1 && room(s);
  }
  function commit(amount, kind) {
    const dir = amount > 0 ? 1 : -1, ok = can && can.on && (dir > 0 ? can.back : can.forward);
    if (Math.abs(amount) >= LINE && ok) nav(dir > 0 ? "back" : "forward", kind);
    hide();
  }

  // trackpad: wheel events with a sideways delta; a gesture ends when the events (momentum included) pause
  let acc = 0, lastT = 0, state = "idle", endTimer = 0;
  window.addEventListener("wheel", e => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return; // pinch zoom, zoom, or a mouse's sideways scroll
    const now = performance.now();
    if (now - lastT > 220) { state = "idle"; acc = 0; }
    lastT = now;
    if (state === "blocked") return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerWidth : 1, dx = e.deltaX * unit, dy = e.deltaY * unit;
    if (state === "idle") {
      if (Math.abs(dx) < 1.5 || Math.abs(dx) < Math.abs(dy) * 1.4) { if (Math.abs(dy) > 2) state = "blocked"; return; } // a scroll up or down
      if (e.defaultPrevented || scrollsX(e.target, dx)) { state = "blocked"; return; }
      state = "track"; can = null; nav("can", "swipe").then(c => { can = c; }, () => {});
    }
    if (Math.abs(dy) > Math.abs(dx) * 2) return;
    acc -= dx;
    if (can && can.on) arrow(Math.abs(acc) / LINE, acc > 0 ? 1 : -1, acc > 0 ? can.back : can.forward);
    clearTimeout(endTimer);
    endTimer = setTimeout(() => { if (state === "track") { state = "idle"; commit(acc, "swipe"); acc = 0; } }, 160);
  }, { passive: true });

  // touch screen: one finger swiping in from the left (back) or right (forward) edge
  let t0 = null;
  window.addEventListener("touchstart", e => {
    t0 = null;
    if (e.touches.length !== 1) return;
    const t = e.touches[0], edge = t.clientX < 24 ? 1 : t.clientX > innerWidth - 24 ? -1 : 0;
    if (edge) { t0 = { x: t.clientX, y: t.clientY, edge, d: 0 }; can = null; nav("can", "swipe").then(c => { can = c; }, () => {}); }
  }, { passive: true, capture: true });
  window.addEventListener("touchmove", e => {
    if (!t0 || e.touches.length !== 1) return;
    const t = e.touches[0], dx = t.clientX - t0.x, dy = t.clientY - t0.y;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) { t0 = null; hide(); return; } // that was a scroll
    t0.d = Math.max(0, dx * t0.edge) * t0.edge;
    if (can && can.on) arrow(Math.abs(t0.d) / (LINE * .8), t0.edge, t0.edge > 0 ? can.back : can.forward);
  }, { passive: true, capture: true });
  const touchEnd = () => { if (!t0) return; const d = t0.d / .8; t0 = null; commit(d, "swipe"); };
  window.addEventListener("touchend", touchEnd, { passive: true, capture: true });
  window.addEventListener("touchcancel", () => { t0 = null; hide(); }, { passive: true, capture: true });

  // the mouse's own back and forward buttons (the 4th and 5th)
  window.addEventListener("mouseup", e => { if (e.button === 3 || e.button === 4) nav(e.button === 3 ? "back" : "forward", "button"); }, true);
}
