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

// The Markdown editor page (ui/markdown.html) is the only page that gets a file bridge. main.js checks that
// the caller is that page and that the path is a Markdown or text file before reading or writing anything.
if (window === window.top && location.protocol === "file:" && /\/ui\/markdown\.html$/.test(location.pathname)) {
  const md = (op, a, b) => ipcRenderer.invoke("alcove-md", op, a, b);
  contextBridge.exposeInMainWorld("alcoveMd", {
    open: () => md("open"),
    read: p => md("read", p),
    save: (p, text) => md("save", p, text),
    saveAs: (name, text) => md("saveAs", name, text),
    openFolder: () => md("openFolder"),
    folder: p => md("folder", p),
    list: p => md("list", p),
    recentFolders: () => md("recentFolders"),
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
    if (f) window.postMessage({ __alcoveMdDrop: webUtils.getPathForFile(f) }, "*");
  }, true);
}
