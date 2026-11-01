// Runs in every page of the web session before the page's own scripts. On YouTube it installs the ad
// cover and skipper right away, so they are already watching when an ad starts (injecting them
// after the page loads let the first ~second of an ad through).
const { webFrame, ipcRenderer } = require("electron");

const YT = /^(?:www\.|m\.|music\.)?youtube\.com$/;
if (window === window.top && YT.test(location.hostname)) {
  const mode = ipcRenderer.sendSync("alcove-yt-mode", location.hostname); // { css, script } or null
  if (mode) {
    webFrame.insertCSS(mode.css);
    webFrame.executeJavaScript(mode.script);
  }
}
