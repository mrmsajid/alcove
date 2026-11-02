const { invoke } = window.__TAURI__.core;
const { emit } = window.__TAURI__.event;

const $ = id => document.getElementById(id);
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const enc = encodeURIComponent;
const MAC = /Mac/.test(navigator.userAgent);

// Shortcut labels: "Mod" is ⌘ on macOS and Ctrl elsewhere.
const keyLabel = k => !k ? "" : MAC
  ? k.replace(/Mod\+/g, "⌘").replace(/Alt\+/g, "⌥").replace(/Ctrl\+/g, "⌃").replace(/Shift\+/g, "⇧").replace(/Right$/, "→").replace(/Left$/, "←")
  : k.replace(/Mod\+/g, "Ctrl+").replace(/Right$/, "→").replace(/Left$/, "←");

// [id, label, shortcut, extra search words]
const COMMANDS = [
  ["new-tab", "New Tab", "Mod+T"],
  ["reopen-tab", "Reopen Closed Tab", "Mod+Shift+T", "undo restore"],
  ["close-tab", "Close Tab", "Mod+W"],
  ["recent-tab", "Switch to Recent Tab", "Ctrl+Tab", "previous last"],
  ["pin-tab", "Pin / Unpin Tab"],
  ["new-group", "New Tab Group", "", "folder"],
  ["tidy-tabs", "Tidy Tabs by Site", "", "organize group sort clean"],
  ["close-duplicates", "Close Duplicate Tabs", "", "dedupe clean"],
  ["close-others", "Close Other Tabs", "", "clean"],
  ["close-below", "Close Tabs Below", "", "clean"],
  ["mute-tab", "Mute / Unmute Tab", "", "sound audio silence"],
  ["mute-all", "Mute All Tabs", "", "sound audio silence"],
  ["unmute-all", "Unmute All Tabs", "", "sound audio"],
  ["split-recent", "Split View with Recent Tab", "", "side by side"],
  ["exit-split", "Exit Split View"],
  ["pip", "Picture in Picture", "Mod+Alt+P", "video float"],
  ["copy-link", "Copy Link", "", "url address"],
  ["copy-markdown", "Copy as Markdown Link", "", "url md"],
  ["copy-title", "Copy Page Title"],
  ["qr", "Show QR Code for This Page", "", "phone share"],
  ["translate", "Translate Page", "", "language english"],
  ["wayback", "Open Archived Copy (Wayback Machine)", "", "archive cache old"],
  ["force-dark", "Force Dark Mode on This Site", "", "night theme invert"],
  ["bookmark", "Bookmark This Page", "Mod+D", "favorite save"],
  ["find", "Find in Page", "Mod+F", "search text"],
  ["screenshot-region", "Screenshot Selected Area", "Mod+Shift+4", "capture"],
  ["screenshot", "Screenshot Visible Area", "Mod+Shift+S", "capture"],
  ["screenshot-full", "Screenshot Full Page", "Mod+Alt+Shift+S", "capture"],
  ["download-video", "Download YouTube Video", "Mod+Shift+D"],
  ["toggle-sponsorblock", "Toggle YouTube Sponsor Skipping", "", "sponsorblock"],
  ["new-space", "New Space"],
  ["next-space", "Next Space", MAC ? "Mod+Alt+Right" : "Ctrl+Alt+Right"],
  ["prev-space", "Previous Space", MAC ? "Mod+Alt+Left" : "Ctrl+Alt+Left"],
  ["reload", "Reload", "Mod+R", "refresh"],
  ["zoom-in", "Zoom In", "Mod+="],
  ["zoom-out", "Zoom Out", "Mod+-"],
  ["zoom-reset", "Actual Size", "Mod+0", "zoom reset"],
  ["bookmarks", "Show Bookmarks", "Mod+Shift+B"],
  ["history", "Show History", "Mod+Y"],
  ["downloads", "Show Downloads", "Mod+Shift+J"],
  ["extensions", "Show Extensions"],
  ["browse-extensions", "Browse Chrome Web Store Extensions"],
  ["import", "Import from Browser (Chrome, Edge, Brave, Arc)"],
  ["tools", "Show Tools", "Mod+Shift+U", "timer stopwatch pomodoro clock notes focus time tracker"],
  ["pomodoro", "Start Pomodoro (25 min)", "", "timer focus work"],
  ["focus-mode", "Start Focus Mode (25 min)", "", "block distractions sites concentrate"],
  ["end-focus", "End Focus Mode", "", "unblock"],
  ["world-clock", "Show World Clock", "", "time zones clocks cities"],
  ["check-updates", "Check for Updates", "", "version release new download upgrade"],
  ["notes", "Show Notes", "", "scratchpad write"],
  ["markdown-open", "Open Markdown File…", "", "md edit view read document"],
  ["markdown-new", "New Markdown Document", "", "md write edit"],
  ["markdown-folder", "Mount Markdown Folder…", "", "md notes vault directory files open load unmount"],
  ["color-picker", "Pick a Color from the Page", "", "eyedropper hex"],
  ["download-images", "Download All Images on This Page", "", "save pictures photos"],
  ["copy-asin", "Copy Amazon ASIN", "", "product amazon keepa"],
  ["clean-link", "Copy Link Without Tracking", "", "utm clean url share"],
  ["settings", "Settings", "Mod+,", "preferences options search engine downloads theme"],
];

// Site shortcuts: "yt lofi", "amz yoga mat", "w Lahore"…
const BANGS = {
  g: ["Google", q => `https://www.google.com/search?q=${enc(q)}`],
  ddg: ["DuckDuckGo", q => `https://duckduckgo.com/?q=${enc(q)}`],
  yt: ["YouTube", q => `https://www.youtube.com/results?search_query=${enc(q)}`],
  gh: ["GitHub", q => `https://github.com/search?q=${enc(q)}`],
  w: ["Wikipedia", q => `https://en.wikipedia.org/w/index.php?search=${enc(q)}`],
  maps: ["Google Maps", q => `https://www.google.com/maps/search/${enc(q)}`],
  amz: ["Amazon", q => (ASIN.test(q) ? `https://www.amazon.com/dp/${q.toUpperCase()}` : `https://www.amazon.com/s?k=${enc(q)}`)],
  r: ["Reddit", q => `https://www.reddit.com/search/?q=${enc(q)}`],
  x: ["X", q => `https://x.com/search?q=${enc(q)}`],
  img: ["Google Images", q => `https://www.google.com/search?tbm=isch&q=${enc(q)}`],
  tr: ["Google Translate", q => `https://translate.google.com/?sl=auto&tl=en&text=${enc(q)}`],
};
const ASIN = /^B0[A-Z0-9]{8}$/i;

let appSettings = {}; // for the search engine (Settings › Search engine)
invoke("get_app_settings").then(s => {
  appSettings = s || {};
  if (appSettings.accent) setAccent(appSettings.accent);
  render();
}).catch(() => {});

function normalize(input) {
  const v = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (!/\s/.test(v) && /^[^\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(v)) return "https://" + v;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(v)) return "http://" + v;
  return searchUrl(appSettings, v);
}

// ---- data ----

const state = read("alcove-state-v1", { spaces: [], space: 0 });
const curSpace = state.spaces[state.space] || { tabs: [] };
const current = curSpace.tabs.find(t => t.id === curSpace.active) || null;
const tabs = state.spaces.flatMap(s => s.tabs.map(t => {
  const g = (s.groups || []).find(x => x.id === t.groupId);
  return { ...t, where: g ? `${s.name} › ${g.name}` : s.name };
}));
const bookmarks = read("alcove-bookmarks", []);
const closedTabs = read("alcove-closed", []);
const historyAll = read("alcove-history", []);

// Frecency: places visited often and recently rank higher (each visit decays with a 7-day half-life-ish curve).
const frecency = new Map();
for (const h of historyAll) {
  const days = (Date.now() - (h.ts || 0)) / 864e5;
  frecency.set(h.url, (frecency.get(h.url) || 0) + Math.exp(-days / 7));
}
const historyUnique = [];
{
  const seen = new Set();
  for (const h of historyAll) if (!seen.has(h.url)) { seen.add(h.url); historyUnique.push(h); }
}
let profiles = [];
invoke("get_profiles").then(p => { profiles = (p.profiles || []).filter(x => x.id !== p.active); render(); }).catch(() => {});

// ---- matching ----

// Every word must appear (substring) or, for words of 3+ letters, match its letters in order (typo-tolerant).
function matchScore(text, words) {
  const hay = text.toLowerCase();
  let total = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i >= 0) { total += i === 0 || /[\s/.\-_:›·]/.test(hay[i - 1]) ? 30 : 15; continue; }
    if (w.length < 3) return -1;
    let j = 0, gaps = 0;
    for (const ch of w) {
      const k = hay.indexOf(ch, j);
      if (k < 0) return -1;
      gaps += k - j;
      j = k + 1;
    }
    if (gaps > w.length * 3) return -1;
    total += 4;
  }
  return total;
}

// ---- tools: calculator, units, currency ----

// A tiny expression parser (no eval): + - * / % ^ and parentheses.
function calculate(expr) {
  const src = expr.replace(/,/g, "").replace(/×/g, "*").replace(/÷/g, "/");
  if (!/^[\d\s+\-*/%^().]+$/.test(src) || !/\d/.test(src) || !/[+\-*/%^]/.test(src.replace(/^\s*-/, ""))) return null;
  const toks = src.match(/\d*\.?\d+|[+\-*/%^()]/g);
  let pos = 0;
  const peek = () => toks[pos];
  const take = () => toks[pos++];
  const primary = () => {
    const t = take();
    if (t === "(") { const v = sum(); if (take() !== ")") throw 0; return v; }
    if (t === "-") return -primary();
    if (t === "+") return primary();
    const v = parseFloat(t);
    if (Number.isNaN(v)) throw 0;
    return v;
  };
  const power = () => { const b = primary(); return peek() === "^" ? (take(), b ** power()) : b; };
  const product = () => {
    let v = power();
    while (["*", "/", "%"].includes(peek())) {
      const op = take(), r = power();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  };
  const sum = () => {
    let v = product();
    while (["+", "-"].includes(peek())) { const op = take(), r = product(); v = op === "+" ? v + r : v - r; }
    return v;
  };
  try {
    const v = sum();
    return pos === toks.length && Number.isFinite(v) ? v : null;
  } catch { return null; }
}

const UNITS = {
  length: { base: "m", u: { mm: .001, cm: .01, m: 1, km: 1000, in: .0254, ft: .3048, yd: .9144, mi: 1609.344 } },
  mass: { base: "kg", u: { mg: 1e-6, g: .001, kg: 1, t: 1000, oz: .028349523125, lb: .45359237 } },
  volume: { base: "l", u: { ml: .001, l: 1, floz: .0295735295625, cup: .2365882365, pt: .473176473, qt: .946352946, gal: 3.785411784 } },
  data: { base: "b", u: { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 } },
};
const ALIAS = {
  millimeter: "mm", millimeters: "mm", centimeter: "cm", centimeters: "cm", meter: "m", meters: "m", metre: "m", metres: "m",
  kilometer: "km", kilometers: "km", inch: "in", inches: "in", foot: "ft", feet: "ft", yard: "yd", yards: "yd", mile: "mi", miles: "mi",
  gram: "g", grams: "g", kilogram: "kg", kilograms: "kg", kgs: "kg", ton: "t", tons: "t", ounce: "oz", ounces: "oz", pound: "lb", pounds: "lb", lbs: "lb",
  milliliter: "ml", milliliters: "ml", liter: "l", liters: "l", litre: "l", litres: "l", cups: "cup", pint: "pt", pints: "pt", quart: "qt", quarts: "qt",
  gallon: "gal", gallons: "gal", "fl-oz": "floz", byte: "b", bytes: "b",
  c: "c", "°c": "c", celsius: "c", f: "f", "°f": "f", fahrenheit: "f", k: "k", kelvin: "k",
};
const unitOf = s => { const k = s.toLowerCase(); return ALIAS[k] || k; };
const fmt = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 1 ? 6 : 4 });

function convertUnits(q) {
  const m = /^(-?[\d.,]+)\s*([a-z°-]+)\s+(?:to|in|=)\s+([a-z°-]+)$/i.exec(q.trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const from = unitOf(m[2]), to = unitOf(m[3]);
  const temp = { c: v => v, f: v => (v - 32) * 5 / 9, k: v => v - 273.15 };
  const fromC = { c: v => v, f: v => v * 9 / 5 + 32, k: v => v + 273.15 };
  if (temp[from] && fromC[to]) return { text: `${fmt(n)} °${from.toUpperCase()} = ${fmt(fromC[to](temp[from](n)))} °${to.toUpperCase()}`.replace("°K", "K"), value: fromC[to](temp[from](n)) };
  for (const kind of Object.values(UNITS)) {
    if (kind.u[from] && kind.u[to]) {
      const v = n * kind.u[from] / kind.u[to];
      return { text: `${fmt(n)} ${from} = ${fmt(v)} ${to}`, value: v };
    }
  }
  return null;
}

const CURRENCY = /^([\d.,]+)\s*([a-z]{3})\s+(?:to|in|=)\s+([a-z]{3})$/i;
let fx = null; // { key, text, sub, value } once rates arrive

// ---- results ----

let results = [];
let sel = 0;
let pageHits = { q: "", hits: [] };

const item = (o) => ({ score: 0, sub: "", kind: "", keys: "", ...o });
const openUrl = (url, label) => shift => ({ type: "url", url, newTab: shift, label });

function pageCommand(id) {
  if (!current) return null;
  const url = current.url;
  if (id === "translate") return () => ({ type: "url", url: `https://translate.google.com/translate?sl=auto&tl=en&u=${enc(url)}`, newTab: true });
  if (id === "wayback") return () => ({ type: "url", url: `https://web.archive.org/web/${url}`, newTab: true });
  if (id === "copy-link") return () => ({ type: "copy", text: url, label: "Link copied" });
  if (id === "copy-markdown") return () => ({ type: "copy", text: `[${(current.title || url).replace(/[[\]]/g, "")}](${url})`, label: "Markdown link copied" });
  if (id === "copy-title") return () => ({ type: "copy", text: current.title || url, label: "Title copied" });
  if (id === "qr") return () => ({ type: "qr", text: url });
  return null;
}

function compute() {
  const raw = $("q").value;
  const q = raw.trim();
  const ql = q.toLowerCase();
  const words = ql.split(/\s+/).filter(Boolean);
  const top = [];   // fixed order, shown first
  const rest = [];  // ranked by score

  if (q) {
    // Tools
    const calc = calculate(q.replace(/^=/, ""));
    if (calc !== null) top.push(item({ kind: "Calculator", title: `= ${fmt(calc)}`, sub: "Enter copies the result", act: () => ({ type: "copy", text: String(calc), label: `Copied ${fmt(calc)}` }) }));
    const unit = convertUnits(q);
    if (unit) top.push(item({ kind: "Convert", title: unit.text, sub: "Enter copies the result", act: () => ({ type: "copy", text: String(+unit.value.toFixed(6)), label: `Copied ${fmt(unit.value)}` }) }));
    else if (CURRENCY.test(q)) {
      if (fx && fx.key === ql) top.push(item({ kind: "Currency", title: fx.text, sub: fx.sub, act: () => ({ type: "copy", text: String(+fx.value.toFixed(2)), label: `Copied ${fmt(fx.value)}` }) }));
      else top.push(item({ kind: "Currency", title: "Converting…", sub: "Fetching today's exchange rate", act: () => null }));
    }
    // Amazon product from an ASIN
    if (ASIN.test(q)) top.push(item({ kind: "Amazon", title: `Open Amazon product ${q.toUpperCase()}`, sub: `amazon.com/dp/${q.toUpperCase()}`, act: openUrl(`https://www.amazon.com/dp/${q.toUpperCase()}`) }));
    // Site shortcuts
    const bm = /^!?(\S+)\s+(.+)$/.exec(q);
    if (bm && BANGS[bm[1].toLowerCase()]) {
      const [name, url] = BANGS[bm[1].toLowerCase()];
      top.push(item({ kind: "Shortcut", title: `Search ${name} for “${bm[2]}”`, sub: url(bm[2]), act: openUrl(url(bm[2])) }));
    } else if (BANGS[ql]) {
      top.push(item({ kind: "Shortcut", title: `${ql} ‹search› searches ${BANGS[ql][0]}`, sub: "Type a space, then what to search for", act: () => null }));
    }
    // "split gmail": pick a tab to show side by side with the current one
    const sm = /^split\s+(.+)$/i.exec(q);
    if (sm) {
      const sw = sm[1].toLowerCase().split(/\s+/);
      for (const t of tabs) {
        if (current && t.id === current.id) continue;
        const s = matchScore(`${t.title} ${t.url}`, sw);
        if (s >= 0) rest.push(item({ score: 500 + s, kind: "Split", title: `Split view with ${t.title || t.url}`, sub: t.where, act: () => ({ type: "split", id: t.id }) }));
      }
    }
  }
  const go = q ? item({ kind: "Go", title: normalize(raw), sub: "Open here · Shift+Enter for a new tab", act: shift => ({ type: "url", url: normalize(raw), newTab: shift }) }) : null;

  // Open tabs
  for (const t of tabs) {
    const s = q ? matchScore(`${t.title} ${t.url} ${t.where}`, words) : -1;
    if (s >= 0) rest.push(item({ score: 300 + s, kind: "Tab", title: t.title || t.url, sub: `${t.where} · ${t.url}`, act: () => ({ type: "tab", id: t.id }) }));
  }
  // Spaces and profiles by name
  state.spaces.forEach((s, i) => {
    if (i === state.space || !q) return;
    const sc = matchScore(`space ${s.name}`, words);
    if (sc >= 0) rest.push(item({ score: 260 + sc, kind: "Space", title: `${s.icon ? s.icon + " " : ""}${s.name}`, sub: `${s.tabs.length} tabs`, keys: i < 9 ? (MAC ? `Ctrl+${i + 1}` : `Alt+${i + 1}`) : "", act: () => ({ type: "space", index: i }) }));
    const mv = current ? matchScore(`move tab to ${s.name}`, words) : -1;
    if (mv >= 0 && words.length > 1) rest.push(item({ score: 240 + mv, kind: "Command", title: `Move Tab to ${s.name}`, act: () => ({ type: "move", index: i }) }));
  });
  for (const p of profiles) {
    const sc = q ? matchScore(`profile ${p.name}`, words) : -1;
    if (sc >= 0) rest.push(item({ score: 250 + sc, kind: "Profile", title: `Switch to profile “${p.name}”`, act: () => ({ type: "profile", id: p.id }) }));
  }
  // Commands (page commands only when there is a page)
  COMMANDS.forEach(([id, label, keys, extra], order) => {
    const local = pageCommand(id);
    if (["copy-link", "copy-markdown", "copy-title", "qr", "translate", "wayback"].includes(id) && !local) return;
    const s = q ? matchScore(`${label} ${extra || ""}`, words) : 0;
    if (s < 0) return;
    rest.push(item({ score: q ? 200 + s : 100 - order, kind: "Command", title: label, keys, act: local || (() => ({ type: "cmd", id })) }));
  });
  // Recently closed
  closedTabs.slice(0, q ? 10 : 3).forEach((c, i) => {
    const s = q ? matchScore(`${c.title} ${c.url}`, words) : 0;
    if (s >= 0) rest.push(item({ score: q ? 140 + s : 150 - i, kind: "Closed", title: c.title || c.url, sub: `Recently closed · ${c.url}`, act: () => ({ type: "reopen", url: c.url }) }));
  });
  if (q) {
    for (const b of bookmarks) {
      const s = matchScore(`${b.title} ${b.url}`, words);
      if (s >= 0) rest.push(item({ score: 150 + s + 5 * (frecency.get(b.url) || 0), kind: "Bookmark", title: b.title, sub: b.url, act: openUrl(b.url) }));
    }
    for (const h of historyUnique.slice(0, 1500)) {
      const s = matchScore(`${h.title} ${h.url}`, words);
      if (s >= 0) rest.push(item({ score: 100 + s + 10 * (frecency.get(h.url) || 0), kind: "History", title: h.title || h.url, sub: h.url, act: openUrl(h.url) }));
    }
    // Text found inside open pages (filled in asynchronously)
    if (pageHits.q === ql) {
      for (const h of pageHits.hits) {
        const t = tabs.find(x => x.id === h.id);
        if (t) rest.push(item({ score: 120, kind: "In page", title: t.title || t.url, sub: `“…${h.snippet}…”`, act: () => ({ type: "tab", id: t.id }) }));
      }
    }
  }
  rest.sort((a, b) => b.score - a.score);
  // "Open / search the web" comes first for addresses and plain searches, but after a strong match
  // (a tab, space, split target or a command whose words you typed).
  const isAddress = go && normalize(raw) !== searchUrl(appSettings, raw.trim());
  const strong = rest.length && rest[0].score >= 230 && !isAddress;
  // Keep the list readable: at most a few of each kind.
  const cap = { History: 6, Bookmark: 5, Tab: 8, Closed: q ? 4 : 3, "In page": 5, Command: q ? 8 : 40, Split: 8 };
  const count = {};
  const shown = rest.filter(r => (count[r.kind] = (count[r.kind] || 0) + 1) <= (cap[r.kind] ?? 6));
  const ordered = go ? (strong ? [shown[0], go, ...shown.slice(1)] : [go, ...shown]) : shown;
  return [...top, ...ordered].slice(0, 60);
}

function render() {
  results = compute();
  sel = Math.min(sel, Math.max(results.length - 1, 0));
  $("list").replaceChildren(...results.map((r, i) => {
    const el = document.createElement("div");
    el.className = "row" + (i === sel ? " sel" : "");
    el.id = `opt${i}`;
    el.setAttribute("role", "option");
    el.setAttribute("aria-selected", i === sel ? "true" : "false");
    const main = document.createElement("div");
    main.className = "main";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = r.title;
    main.append(t);
    if (r.sub) {
      const u = document.createElement("div");
      u.className = "u";
      u.textContent = r.sub;
      main.append(u);
    }
    el.append(main);
    if (r.keys) {
      const k = document.createElement("kbd");
      k.textContent = keyLabel(r.keys);
      el.append(k);
    }
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = r.kind;
    el.append(kind);
    el.addEventListener("click", () => run(i, false));
    return el;
  }));
  $("list").children[sel]?.scrollIntoView({ block: "nearest" });
  $("q").setAttribute("aria-activedescendant", results.length ? `opt${sel}` : ""); // the arrow keys move a highlight, not the focus
}

// ---- running a result ----

function showQr(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
  const cap = document.createElement("div");
  cap.className = "qr-cap";
  cap.textContent = text;
  $("qr").append(cap);
  $("qr").hidden = false;
  $("list").hidden = true;
  $("q").value = "";
  $("q").placeholder = "Scan with your phone's camera · Esc to close";
}

async function run(i, shift) {
  const r = results[i];
  if (!r) return;
  const a = r.act(shift);
  if (!a) return;
  if (a.type === "qr") return showQr(a.text);
  if (a.type === "copy") {
    await invoke("copy_text", { text: a.text }); // through the app, so it works even if the window isn't focused
    await emit("palette-action", { type: "toast", text: a.label });
  } else {
    await emit("palette-action", a);
  }
  invoke("hide_palette");
}

// Debounced lookups that need the app: text inside open pages, exchange rates.
let lookupTimer;
function lookups() {
  clearTimeout(lookupTimer);
  const raw = $("q").value.trim();
  const ql = raw.toLowerCase();
  lookupTimer = setTimeout(async () => {
    const cm = CURRENCY.exec(raw);
    if (cm && !convertUnits(raw)) {
      const [, amount, from, to] = cm;
      const data = await invoke("fx_rates", { base: from }).catch(() => null);
      const rate = data && data.rates && data.rates[to.toUpperCase()];
      if (rate && $("q").value.trim().toLowerCase() === ql) {
        const n = parseFloat(amount.replace(/,/g, ""));
        fx = { key: ql, value: n * rate, text: `${fmt(n)} ${from.toUpperCase()} = ${fmt(n * rate)} ${to.toUpperCase()}`, sub: `Rate ${fmt(rate)} · updated ${String(data.updated || "").replace(/ \+0000$/, "")}` };
        render();
      }
      return;
    }
    if (ql.length >= 3 && !/^split\s/.test(ql) && calculate(ql) === null) {
      const hits = await invoke("search_tabs", { q: ql }).catch(() => []);
      if ($("q").value.trim().toLowerCase() === ql) { pageHits = { q: ql, hits }; render(); }
    }
  }, 250);
}

$("q").addEventListener("input", () => { sel = 0; render(); lookups(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape") invoke("hide_palette");
  else if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(results.length, 1); render(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + results.length) % Math.max(results.length, 1); render(); }
  else if (e.key === "Enter" && $("qr").hidden) run(sel, e.shiftKey);
});

// Close when focus leaves; ignore the blur that can fire while the webview is still taking focus.
let ready = false;
window.addEventListener("focus", () => { ready = true; });
window.addEventListener("blur", () => { if (ready) invoke("hide_palette"); });
setTimeout(() => $("q").focus(), 50);

render();
