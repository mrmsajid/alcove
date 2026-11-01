// Runs in every page of the web session before the page's own scripts. On YouTube it installs the ad
// skipper right away, so it is already watching when an ad starts.
//
// Why skip instead of removing ads from YouTube's data: tested 2026-11-02, any change to the player's
// ad data (deleting it, emptying it, or keeping only the heartbeat) made YouTube hold the real video
// back ~5-7 s on every load, sometimes indefinitely. Skipping leaves the data intact: videos start in
// ~1.5 s and an ad, when one is served, is gone within a fraction of a second.
const { contextBridge, webFrame, ipcRenderer } = require("electron");

// Executed inside YouTube's own page (main world), before any of its scripts.
function youtubePage() {
  if (window.__alcoveYT) return;
  window.__alcoveYT = true;

  // While an ad plays, the page CSS covers the player with the video's own thumbnail (so it just looks
  // like the video is loading); here the ad is muted, jumped to its end and skipped, then sound returns.
  const videoId = () => new URLSearchParams(location.search).get("v") || (location.pathname.match(/\/shorts\/([\w-]+)/) || [])[1];
  let wasMuted = null;
  let watched = null;
  let adSince = 0;       // when the current ad state began
  let reported = false;  // diagnostic sent for this ad state
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
    if (e.source === window && e.data && e.data.__alcoveDiag) ipcRenderer.send("alcove-yt-diag", e.data.__alcoveDiag);
  });
  const mode = ipcRenderer.sendSync("alcove-yt-mode", location.hostname); // { css } or null when off
  if (mode) {
    webFrame.insertCSS(mode.css);
    // Runs synchronously, so it is in place before YouTube's own scripts.
    if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: youtubePage });
    else webFrame.executeJavaScript(`(${youtubePage.toString()})()`);
  }
}
