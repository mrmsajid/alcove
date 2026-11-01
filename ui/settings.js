const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;
const $ = id => document.getElementById(id);
const MAC = /Mac/.test(navigator.userAgent);
const errText = e => String(e && e.message || e).replace(/^Error invoking remote method 'invoke': Error: /, "");

let S = {};       // app settings
let info = {};    // version, default-browser status, downloads folder…
let sites = { permissions: [], adblockAllow: [], forceDark: [] };

// ---- tiny DOM helpers ----

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "class") el.className = v;
    else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false));
  return el;
}
const row = (title, desc, ...ctl) => h("div", { class: "row", "data-find": `${title} ${desc || ""}` },
  h("div", { class: "what" }, h("div", { class: "t" }, title), desc ? h("div", { class: "d" }, desc) : null),
  h("div", { class: "ctl" }, ...ctl));
const toggle = (on, fn) => h("button", { class: "switch" + (on ? " on" : ""), role: "switch", "aria-checked": String(!!on), on: { click: () => fn(!on) } });
const seg = (value, options, fn) => h("div", { class: "seg" }, ...options.map(([v, label]) =>
  h("button", { class: v === value ? "on" : "", on: { click: () => fn(v) } }, label)));
const radios = (value, options, fn) => h("div", { class: "radios" }, ...options.map(([v, label, sub]) =>
  h("div", { class: "radio" + (v === value ? " on" : ""), "data-find": label, on: { click: () => fn(v) } }, h("span", { class: "dot2" }), label, sub ? h("span", { class: "sub2" }, sub) : null)));
const card = (...rows) => h("div", { class: "card" }, ...rows);

let flashTimer;
function flash(msg) {
  $("flash").textContent = msg;
  $("flash").hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { $("flash").hidden = true; }, 2200);
}

async function set(key, value) {
  try { S = await invoke("set_app_setting", { key, value }); } catch (e) { flash(`Couldn't save: ${errText(e)}`); }
  render();
}

// URL text box that saves on Enter or when leaving it.
function urlInput(value, placeholder, key, check) {
  const input = h("input", { type: "text", value: value || "", placeholder, spellcheck: "false" });
  const save = () => {
    const v = input.value.trim();
    if (v === (S[key] || "")) return;
    if (v && check && !check(v)) return flash("That doesn't look right. Check the address.");
    set(key, v);
  };
  input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
  input.addEventListener("blur", save);
  return h("div", { class: "inline" }, input);
}
const isUrl = v => /^https?:\/\/\S+\.\S+/.test(v) || /^https?:\/\/localhost/.test(v);

// ---- sections ----

const SECTIONS = [
  ["search", "Search engine", () => [
    card(
      radios(S.searchEngine, [
        ...Object.entries(ENGINES).map(([id, e]) => [id, e.name, id === "duckduckgo" ? "private, default" : ""]),
        ["custom", "Custom…", "any search URL"],
      ], v => set("searchEngine", v)),
      S.searchEngine === "custom" ? urlInput(S.customSearch, "https://example.com/search?q=%s  (use %s for the search words)", "customSearch", v => isUrl(v) && v.includes("%s")) : null,
    ),
    h("div", { class: "d", style: "color:var(--muted);font-size:12px;margin:8px 4px" }, "Used when you type words in the address bar or ⌘K. Shortcuts like “yt …” and “amz …” still work."),
  ]],
  ["startup", "On startup & new tab", () => [
    h("h2", { style: "font-size:13px;color:var(--muted);margin:0 0 8px" }, "When Alcove opens"),
    card(
      radios(S.startup, [["restore", "Continue where you left off"], ["newtab", "Open a new tab"], ["custom", "Open a specific page"]], v => set("startup", v)),
      S.startup === "custom" ? urlInput(S.startupUrl, "https://…", "startupUrl", isUrl) : null,
    ),
    h("h2", { style: "font-size:13px;color:var(--muted);margin:18px 0 8px" }, "New tabs open"),
    card(
      radios(S.newTab, [["engine", `${(ENGINES[S.searchEngine] || { name: "Search engine" }).name} home page`], ["blank", "A blank page"], ["custom", "A specific page"]], v => set("newTab", v)),
      S.newTab === "custom" ? urlInput(S.newTabUrl, "https://…", "newTabUrl", isUrl) : null,
    ),
  ]],
  ["appearance", "Appearance", () => [card(
    row("Theme", "Light or dark for Alcove and for sites that support it.", seg(S.theme, [["system", "System"], ["light", "Light"], ["dark", "Dark"]], v => set("theme", v))),
    row("Accent color", "Buttons, highlights and focus rings.",
      h("div", { class: "swatches" }, ...["#7c8cff", "#5fd6a0", "#ff7c9c", "#ffb86b", "#c27cff", "#6cc7ff", "#e8e8ee"].map(c =>
        h("button", { class: "swatch" + (S.accent === c ? " on" : ""), style: `background:${c}`, title: c, on: { click: () => set("accent", c) } })))),
    row("Sidebar text size", null, seg(S.textSize, [["small", "Small"], ["default", "Default"], ["large", "Large"]], v => set("textSize", v))),
    row("Page zoom", "Default zoom for new pages. ⌘+ / ⌘− still change one tab.",
      h("select", { on: { change: e => set("defaultZoom", parseFloat(e.target.value)) } },
        ...[0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2].map(z => h("option", { value: z, selected: Math.abs(S.defaultZoom - z) < 0.001 }, `${Math.round(z * 100)}%`)))),
    row("Compact layout", "Remove the margin and rounded corners around pages.", toggle(S.compact, v => set("compact", v))),
  )]],
  ["downloads", "Downloads", () => [card(
    row("Location", null,
      h("span", { class: "path", title: info.downloadDir }, info.downloadDir || ""),
      h("button", { class: "btn", on: { click: async () => { if (await invoke("choose_download_dir")) await refreshInfo(); } } }, "Change…"),
      S.downloadDir ? h("button", { class: "btn", title: "Use the system Downloads folder", on: { click: async () => { await set("downloadDir", ""); await refreshInfo(); } } }, "Reset") : null),
    row("Ask where to save each file", "Show a save dialog for every download.", toggle(S.askDownload, v => set("askDownload", v))),
    row("Download list", "Files you've downloaded in Alcove.", h("button", { class: "btn", on: { click: () => sidebar("downloads") } }, "Show")),
  )]],
  ["privacy", "Privacy & security", () => [
    card(
      row("Ad & tracker blocker", "Blocks ads and trackers. On YouTube, ads are skipped instead.", toggle(info.adblock, async v => { await invoke("set_adblock", { enabled: v }); await refreshInfo(); })),
      row("Skip YouTube sponsor segments", "Uses SponsorBlock. Only a short hash of the video is sent.", toggle(info.sponsorBlock, async v => { await invoke("set_sponsorblock", { enabled: v }); await refreshInfo(); })),
      row("Ask sites not to track you", "Sends Do Not Track and Global Privacy Control with every request.", toggle(S.dnt, v => set("dnt", v))),
      row("Always use secure connections", "Upgrade pages to HTTPS. Sites without HTTPS won't load.", toggle(S.httpsOnly, v => set("httpsOnly", v))),
      row("Spell check", "Underline misspelled words while you type.", toggle(S.spellcheck, v => set("spellcheck", v))),
    ),
    h("h2", { style: "font-size:13px;color:var(--muted);margin:18px 0 8px" }, "Clear browsing data"),
    clearDataCard(),
  ]],
  ["sites", "Site settings", () => {
    const perm = { media: "Camera / microphone", geolocation: "Location", notifications: "Notifications", "clipboard-read": "Clipboard" };
    const list = (items, empty) => items.length ? items : [h("div", { class: "empty" }, empty)];
    return [
      h("h2", { style: "font-size:13px;color:var(--muted);margin:0 0 8px" }, "Permissions you've answered"),
      card(...list(sites.permissions.map(p => h("div", { class: "item-row", "data-find": `${p.origin} ${perm[p.permission] || p.permission}` },
        h("span", { class: "grow" }, p.origin.replace(/^https?:\/\//, "")), h("span", {}, perm[p.permission] || p.permission),
        h("span", { class: "pill2 " + (p.allowed ? "ok" : "no") }, p.allowed ? "Allowed" : "Blocked"),
        h("button", { class: "btn", on: { click: async () => { await invoke("remove_site_permission", { key: p.key }); await refreshSites(); } } }, "Reset"))),
        "No site has asked for your camera, microphone, location or notifications yet.")),
      h("h2", { style: "font-size:13px;color:var(--muted);margin:18px 0 8px" }, "Ad blocker turned off on"),
      card(...list(sites.adblockAllow.map(host => h("div", { class: "item-row", "data-find": host },
        h("span", { class: "grow" }, host),
        h("button", { class: "btn", on: { click: async () => { await invoke("set_adblock_site", { host, allowed: false }); await refreshSites(); } } }, "Turn back on"))),
        "The ad blocker is on everywhere.")),
      h("h2", { style: "font-size:13px;color:var(--muted);margin:18px 0 8px" }, "Forced dark mode"),
      card(...list(sites.forceDark.map(host => h("div", { class: "item-row", "data-find": host },
        h("span", { class: "grow" }, host),
        h("button", { class: "btn", on: { click: async () => { await invoke("remove_force_dark", { host }); await refreshSites(); } } }, "Remove"))),
        "No sites. Use ⌘K → “Force Dark Mode on This Site”.")),
    ];
  }],
  ["browser", "Default browser & data", () => [card(
    row("Default browser", info.isDefault ? "Alcove opens links from other apps." : "Make Alcove open links from email, chat and other apps.",
      info.isDefault ? h("span", { class: "pill2 ok" }, "Alcove is your default browser")
        : h("button", { class: "btn primary", on: { click: async () => {
          const r = await invoke("set_default_browser");
          flash(r.ok ? "Confirm the change in the system dialog if one appears." : r.reason || "Couldn't change the default browser.");
          setTimeout(refreshInfo, 1500);
        } } }, "Make default")),
    row("Import from another browser", "Bookmarks, history and extensions from Chrome, Edge, Brave, Arc or Vivaldi.", h("button", { class: "btn", on: { click: () => sidebar("import") } }, "Import…")),
    row("Extensions", "Add, open or remove Chrome extensions.", h("button", { class: "btn", on: { click: () => sidebar("extensions") } }, "Manage")),
    row("Bookmarks", null, h("button", { class: "btn", on: { click: () => sidebar("bookmarks") } }, "Show")),
  )]],
  ["shortcuts", "Keyboard shortcuts", () => {
    const k = s => MAC ? s.replace(/Mod\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Ctrl\+/g, "⌃").replace(/Shift\+/g, "⇧") : s.replace(/Mod\+/g, "Ctrl+");
    const list = [
      ["Command palette", "Mod+K"], ["New tab", "Mod+T"], ["Close tab", "Mod+W"], ["Reopen closed tab", "Mod+Shift+T"],
      ["Switch to recent tab", "Ctrl+Tab"], ["Go to tab 1–8 / last tab", "Mod+1 … Mod+9"], ["Address bar", "Mod+L"],
      ["Find in page", "Mod+F"], ["Bookmark this page", "Mod+D"], ["Hide / show sidebar", "Mod+S"],
      ["Next / previous space", MAC ? "Mod+Alt+→ / ←" : "Ctrl+Alt+→ / ←"], ["Go to space 1–9", MAC ? "Ctrl+1 … 9" : "Alt+1 … 9"],
      ["Screenshot area / visible / full page", "Mod+Shift+4 / Mod+Shift+S / Mod+Alt+Shift+S"], ["Picture in picture", "Mod+Alt+P"],
      ["Download YouTube video", "Mod+Shift+D"], ["Zoom in / out / reset", "Mod+= / Mod+- / Mod+0"], ["Settings", "Mod+,"],
      ["Open link in background", "Mod+click"], ["Open link in Peek", "Shift+click"],
    ];
    return [card(h("div", { class: "keys" }, ...list.flatMap(([what, keys]) => [h("span", { "data-find": what }, what), h("kbd", {}, k(keys))])))];
  }],
  ["about", "About Alcove", () => [card(
    h("div", { class: "about", "data-find": "version about" },
      h("b", {}, "Alcove"), h("br"),
      `Version ${info.version || ""} · Chromium ${info.chrome || ""} · Electron ${info.electron || ""}`, h("br"),
      h("span", { style: "color:var(--muted)" }, "A sidebar-first browser for Mac and Windows, inspired by Nook.")),
    row("Reset settings", "Put every setting on this page back to its default.", h("button", { class: "btn danger", on: { click: async () => {
      if (!confirm("Reset all settings to their defaults?")) return;
      S = await invoke("reset_settings");
      render();
      flash("Settings reset");
    } } }, "Reset")),
  )]],
];

function clearDataCard() {
  const opts = [["history", "Browsing history", true], ["downloads", "Download list", true], ["closed", "Recently closed tabs", true], ["cookies", "Cookies and site data (signs you out of sites)", false], ["cache", "Cached images and files", true]];
  const boxes = {};
  const checks = h("div", { class: "checks" }, ...opts.map(([k, label, on]) => {
    boxes[k] = h("input", { type: "checkbox", checked: on });
    return h("label", { "data-find": label }, boxes[k], label);
  }));
  const go = h("button", { class: "btn primary", on: { click: async () => {
    const pick = Object.fromEntries(Object.entries(boxes).map(([k, b]) => [k, b.checked]));
    if (!Object.values(pick).some(Boolean)) return flash("Choose what to clear");
    if (!confirm("Clear the selected browsing data? This can't be undone.")) return;
    // Sidebar data (same storage as this page):
    if (pick.history) localStorage.setItem("alcove-history", "[]");
    if (pick.downloads) localStorage.setItem("alcove-downloads", "[]");
    if (pick.closed) localStorage.setItem("alcove-closed", "[]");
    if (pick.cookies || pick.cache) await invoke("clear_data", { cookies: pick.cookies, cache: pick.cache });
    await emit("palette-action", { type: "toast", text: "Browsing data cleared" });
    flash("Cleared");
  } } }, "Clear data");
  return card(checks, h("div", { class: "row" }, h("div", { class: "what" }, h("div", { class: "d" }, "Bookmarks, settings and open tabs are kept.")), h("div", { class: "ctl" }, go)));
}

// Opens a sidebar panel (bookmarks, downloads, import…) and closes Settings.
async function sidebar(cmd) {
  await emit("palette-action", { type: "cmd", id: cmd });
  invoke("close_settings");
}

// ---- rendering, navigation, search ----

let current = location.hash.slice(1) || "search";

function render() {
  document.documentElement.style.setProperty("--accent", S.accent || "#7c8cff");
  const scroll = $("main").scrollTop;
  $("sections").replaceChildren(...SECTIONS.map(([id, title, build]) =>
    h("section", { id }, h("h2", {}, title), ...build())));
  $("nav").replaceChildren(h("h1", {}, "Settings"), ...SECTIONS.map(([id, title]) =>
    h("a", { class: id === current ? "on" : "", on: { click: () => go(id) } }, title)));
  applyFind();
  $("main").scrollTop = scroll;
}

function go(id) {
  current = id;
  $("find").value = "";
  applyFind();
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  for (const a of $("nav").querySelectorAll("a")) a.classList.toggle("on", a.textContent === SECTIONS.find(s => s[0] === id)[1]);
}

// Search hides rows (and whole sections) that don't mention the words typed.
function applyFind() {
  const q = $("find").value.trim().toLowerCase();
  for (const sec of $("sections").children) {
    let any = false;
    const units = sec.querySelectorAll(".row, .radio, .item-row, .checks label, .keys span, .about");
    for (const el of units) {
      const hit = !q || (el.dataset.find || el.textContent).toLowerCase().includes(q) || sec.querySelector("h2").textContent.toLowerCase().includes(q);
      el.classList.toggle("hidden-by-search", !hit);
      if (el.matches(".keys span")) el.nextElementSibling?.classList.toggle("hidden-by-search", !hit);
      any ||= hit;
    }
    sec.classList.toggle("hidden-by-search", !any);
  }
}

// Keep the left list in step with scrolling.
$("main").addEventListener("scroll", () => {
  if ($("find").value) return;
  let best = SECTIONS[0][0];
  for (const [id] of SECTIONS) { const el = document.getElementById(id); if (el && el.getBoundingClientRect().top < 140) best = id; }
  if (best !== current) { current = best; for (const a of $("nav").querySelectorAll("a")) a.classList.toggle("on", a.textContent === SECTIONS.find(s => s[0] === best)[1]); }
});

async function refreshInfo() { info = await invoke("get_app_info"); render(); }
async function refreshSites() { sites = await invoke("get_site_settings"); render(); }

$("find").addEventListener("input", applyFind);
$("close").addEventListener("click", () => invoke("close_settings"));
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { if ($("find").value) { $("find").value = ""; applyFind(); } else invoke("close_settings"); }
  if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); $("find").focus(); }
});
listen("settings-changed", ({ payload }) => { S = payload; render(); });

Promise.all([invoke("get_app_settings"), invoke("get_app_info"), invoke("get_site_settings")]).then(([s, i, st]) => {
  S = s; info = i; sites = st;
  render();
  if (location.hash) go(location.hash.slice(1));
});
