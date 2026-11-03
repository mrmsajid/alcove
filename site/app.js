// Alcove's web page. Plain JavaScript, no libraries.
// The page is complete without this script: static framed window, every section readable, download buttons pointing at the
// latest-release page. The script adds the interactions, and its only network request is to GitHub (api.github.com), to find
// the latest release. Styles are only ever set through custom properties (the page's Content-Security-Policy forbids inline styles).
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const html = document.documentElement;
  html.classList.add("js");
  const raf = requestAnimationFrame;
  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const range = (v, a, b) => clamp01((v - a) / (b - a));
  const smooth = t => t * t * (3 - 2 * t);
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const fineMQ = matchMedia("(hover: hover) and (pointer: fine)");
  const nav = navigator, uaData = nav.userAgentData;
  const platform = (uaData && uaData.platform) || nav.platform || "";
  const isMac = /Mac/i.test(platform);
  const MOD = isMac ? "⌘" : "Ctrl+", SHIFT = isMac ? "⇧" : "Shift+", ALT = isMac ? "⌥" : "Alt+";
  const keyLabel = k => (k ? k.replace("Mod+", MOD).replace("Shift+", SHIFT).replace("Alt+", ALT) : "");
  const behavior = () => (reduceMQ.matches ? "auto" : "smooth");
  const go = sel => { const el = $(sel); if (el) el.scrollIntoView({ behavior: behavior(), block: "start" }); };

  // ---- toast and clipboard ----
  const toastEl = $("#toast");
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("on"), 2600);
  }
  async function copy(text) { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } }
  const setSwap = (el, text) => { if (!el) return; el.dataset.t = text; const i = $("i", el); if (i) i.textContent = text; };

  // ---- theme: follows the system until the visitor picks one (kept in localStorage, which may be unavailable) ----
  const THEME_KEY = "alcove-site-theme", themeBtn = $("#theme"), themeState = $("#theme-state"), systemDark = matchMedia("(prefers-color-scheme: dark)");
  const store = { get() { try { return localStorage.getItem(THEME_KEY); } catch { return null; } }, set(v) { try { localStorage.setItem(THEME_KEY, v); } catch {} } };
  let theme = store.get();
  if (theme !== "light" && theme !== "dark") theme = null;
  const isDark = () => (theme ? theme === "dark" : systemDark.matches);
  function applyTheme() {
    if (theme) html.dataset.theme = theme; else delete html.dataset.theme;
    // Every screenshot has a light and a dark version (<picture>): a chosen theme overrides the system query.
    for (const s of $$("picture > source")) s.media = theme ? (theme === "dark" ? "all" : "not all") : "(prefers-color-scheme: dark)";
    themeBtn.setAttribute("aria-pressed", String(isDark()));
    themeState.textContent = isDark() ? "on" : "off";
  }
  const toggleTheme = () => { theme = isDark() ? "light" : "dark"; store.set(theme); applyTheme(); };
  themeBtn.addEventListener("click", toggleTheme);
  if (systemDark.addEventListener) systemDark.addEventListener("change", applyTheme);
  applyTheme();

  // ---- the site menu: an alcove that opens from the left edge (fine pointers) or from the Menu button (everywhere) ----
  const menu = $("#menu"), menuBtn = $("#menu-btn"), menuClose = $("#menu-close"), edge = $("#edge"), scrim = $("#scrim");
  const behind = [$(".bar"), $("main"), $(".foot")];
  let menuOpen = false, menuBy = "", leaveTimer = 0, scrimTimer = 0;
  function openMenu(by) {
    if (menuOpen) return;
    menuOpen = true; menuBy = by;
    menu.inert = false;
    menu.classList.add("open");
    menuBtn.setAttribute("aria-expanded", "true");
    if (by === "button") { // a real dialog: dim the page, keep the keyboard inside, lock scrolling
      clearTimeout(scrimTimer);
      scrim.hidden = false;
      raf(() => scrim.classList.add("on"));
      for (const el of behind) el.inert = true;
      html.style.setProperty("overflow", "hidden");
      void menu.offsetWidth; // the menu is visible now, so it can take focus
      const first = $("nav a", menu);
      if (first) first.focus({ preventScroll: true });
    }
  }
  function closeMenu(returnFocus) {
    if (!menuOpen) return;
    const by = menuBy;
    menuOpen = false; menuBy = "";
    clearTimeout(leaveTimer);
    menu.classList.remove("open");
    menu.inert = true;
    menuBtn.setAttribute("aria-expanded", "false");
    scrim.classList.remove("on");
    scrimTimer = setTimeout(() => { scrim.hidden = true; }, 420);
    for (const el of behind) el.inert = false;
    html.style.removeProperty("overflow");
    if (by === "button" && returnFocus) menuBtn.focus({ preventScroll: true });
  }
  menuBtn.addEventListener("click", () => (menuOpen ? closeMenu(true) : openMenu("button")));
  menuClose.addEventListener("click", () => closeMenu(true));
  scrim.addEventListener("click", () => closeMenu(true));
  for (const a of $$("nav a", menu)) a.addEventListener("click", () => closeMenu(false));
  edge.addEventListener("pointerenter", () => { if (fineMQ.matches) openMenu("hover"); });
  menu.addEventListener("pointerenter", () => clearTimeout(leaveTimer));
  menu.addEventListener("pointerleave", () => { if (menuBy === "hover") { clearTimeout(leaveTimer); leaveTimer = setTimeout(() => closeMenu(false), 260); } });
  menu.addEventListener("keydown", e => { // a simple focus trap while the menu is a dialog
    if (e.key !== "Tab" || menuBy !== "button") return;
    const items = $$("a[href], button:not([disabled])", menu);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  // ---- scroll: ONE passive listener and ONE rAF drive the header, the section marker and the signature scene ----
  const bar = $(".bar");
  const spyLinks = $$("nav a", menu).map(a => ({ a, el: $(a.getAttribute("href")), top: 0 })).filter(s => s.el);
  const scene = $("#window"), pin = $(".pin", scene), win = $("#win");
  const edgeZone = $("#edge-zone"), tabsBtn = $("#tabs-btn"), tabsLabel = $("#tabs-label"), hint = $("#hint");
  const geo = { sceneTop: 0, range: 1, barH: 56, sEnd: 1 }; // layout is read here, on resize only, never while scrolling
  let scrub = false, sceneOn = false, sy = scrollY, vh = innerHeight;
  let cur = 0, ready = false, sbCur = 0, override = null, overrideAt = 0, lastHint = "", lastLabel = "";
  const painted = {};
  const setVar = (name, v) => { if (painted[name] !== v) { painted[name] = v; pin.style.setProperty(name, v); } };

  function measure() {
    vh = innerHeight;
    geo.barH = bar.offsetHeight;
    for (const s of spyLinks) s.top = s.el.getBoundingClientRect().top + scrollY;
    if (!scrub) return;
    const pinH = pin.offsetHeight, pinW = pin.clientWidth, ww = win.offsetWidth, wh = win.offsetHeight;
    geo.sceneTop = scene.getBoundingClientRect().top + scrollY;
    geo.range = Math.max(1, scene.offsetHeight - pinH);
    const availH = vh - geo.barH, fit = pinW / ww, cover = Math.max(fit, availH / wh);
    geo.sEnd = Math.min(pinW / availH > 1.15 ? cover : fit, 2.6); // landscape: fill the screen. Portrait: edge to edge, no blurry crop
    if (geo.sEnd < 1.02) geo.sEnd = 1.02;
  }

  function paintScene(p) {
    const e = smooth(range(p, 0, 0.55));
    const out = smooth(range(p, 0.3, 0.8));
    const cp = smooth(range(p, 0.7, 0.9));
    const hovered = override !== null && Math.abs(p - overrideAt) < 0.2;
    const sbTarget = hovered ? override : out;
    sbCur += (sbTarget - sbCur) * 0.22;
    if (Math.abs(sbTarget - sbCur) < 0.002) sbCur = sbTarget;
    setVar("--s", (1 + (geo.sEnd - 1) * e).toFixed(4));
    setVar("--rad", (20 * (1 - e)).toFixed(2) + "px");
    setVar("--sb", sbCur.toFixed(3));
    setVar("--xf", smooth(range(sbCur, 0.42, 0.62)).toFixed(3)); // the page re-centres in a short swap once the sidebar is mostly gone, so the two layouts never sit on top of each other for long
    setVar("--cp", cp.toFixed(3));
    setVar("--p", p.toFixed(4));
    const shown = sbCur < 0.5;
    const label = shown ? "Hide tabs" : "Show tabs";
    if (label !== lastLabel) { lastLabel = label; tabsLabel.textContent = label; tabsBtn.setAttribute("aria-pressed", String(shown)); }
    const h = p < 0.9 ? "Scroll to open the window." : fineMQ.matches ? "Now move to the left edge for the tabs." : "Tap Show tabs to bring them back.";
    if (h !== lastHint) { lastHint = h; hint.textContent = h; }
    return sbCur !== sbTarget;
  }

  let rafId = 0, lastTs = 0, scrolled = false, spyIdx = -1;
  function tick(ts) {
    rafId = 0;
    const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
    lastTs = ts;
    let more = false;
    const isScrolled = sy > 8;
    if (isScrolled !== scrolled) { scrolled = isScrolled; html.classList.toggle("scrolled", scrolled); }
    // which section is being read
    const y = sy + vh * 0.4;
    let idx = -1;
    for (let i = 0; i < spyLinks.length; i++) if (spyLinks[i].top <= y) idx = i;
    if (idx !== spyIdx) { spyIdx = idx; spyLinks.forEach((s, i) => { if (i === idx) s.a.setAttribute("aria-current", "true"); else s.a.removeAttribute("aria-current"); }); }
    // the signature scene: one number, 0 to 1, drives everything
    if (scrub && sceneOn) {
      const target = clamp01((sy - geo.sceneTop + geo.barH) / geo.range);
      if (!ready) { cur = target; ready = true; } // landing mid-scene (anchor, refresh): go straight to the right state
      else { cur += (target - cur) * (1 - Math.pow(0.0006, dt)); if (Math.abs(target - cur) < 0.0008) cur = target; else more = true; }
      if (paintScene(cur)) more = true;
    }
    if (more) rafId = raf(tick); else lastTs = 0;
  }
  const schedule = () => { if (!rafId) rafId = raf(tick); };
  addEventListener("scroll", () => { sy = scrollY; schedule(); }, { passive: true });
  let resizeTimer = 0;
  addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { setupScene(); }, 120); });

  // the scene is pinned only for visitors who have not asked for less motion, and on screens tall enough to hold it
  function setupScene() {
    const want = !reduceMQ.matches && innerHeight >= 460 && "IntersectionObserver" in window;
    if (want !== scrub) {
      scrub = want;
      html.classList.toggle("scrub", scrub);
      ready = false; sbCur = 0; override = null; lastLabel = ""; lastHint = "";
      for (const k of Object.keys(painted)) { delete painted[k]; pin.style.removeProperty(k); }
      win.removeAttribute("data-tabs");
      if (!scrub) { win.style.removeProperty("will-change"); tabsLabel.textContent = "Hide tabs"; tabsBtn.setAttribute("aria-pressed", "true"); }
    }
    measure();
    sy = scrollY;
    schedule();
  }
  if ("IntersectionObserver" in window) new IntersectionObserver(es => {
    sceneOn = es[0].isIntersecting;
    win.style.setProperty("will-change", sceneOn && scrub ? "transform" : "auto"); // a compositor layer only while the scene is on screen
    if (sceneOn) schedule();
  }, { rootMargin: "25% 0px" }).observe(scene);
  if (reduceMQ.addEventListener) reduceMQ.addEventListener("change", setupScene);

  // after the scene: the pointer at the window's left edge brings the sidebar back, as in the app. A button does the same for everyone else.
  if (edgeZone) {
    edgeZone.addEventListener("pointerenter", () => { if (scrub && fineMQ.matches && cur > 0.6) { override = 0; overrideAt = cur; schedule(); } });
    edgeZone.addEventListener("pointerleave", () => { if (override === 0) { override = null; schedule(); } });
  }
  tabsBtn.addEventListener("click", () => {
    if (scrub) { // flip what is on screen now, until the visitor scrolls on
      override = sbCur < 0.5 ? 1 : 0; overrideAt = cur; schedule();
    } else {
      const off = win.dataset.tabs !== "off";
      if (off) win.dataset.tabs = "off"; else win.removeAttribute("data-tabs");
      tabsLabel.textContent = off ? "Show tabs" : "Hide tabs";
      tabsBtn.setAttribute("aria-pressed", String(!off));
    }
  });
  setupScene();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measure(); schedule(); });
  addEventListener("load", () => { measure(); schedule(); });

  // ---- reveal: section heads, figures and lists only, once ----
  const io = "IntersectionObserver" in window ? new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }) : null;
  for (const el of $$(".rv")) { if (io) io.observe(el); else el.classList.add("in"); }

  // ---- the little tools Alcove has: calculator, unit converter, site shortcuts (the same logic as the command bar in the app) ----
  function calculate(expr) { // a tiny expression parser (no eval): + - * / % ^ and brackets
    const src = expr.replace(/,/g, "").replace(/×/g, "*").replace(/÷/g, "/");
    if (!/^[\d\s+\-*/%^().]+$/.test(src) || !/\d/.test(src) || !/[+\-*/%^]/.test(src.replace(/^\s*-/, ""))) return null;
    const toks = src.match(/\d*\.?\d+|[+\-*/%^()]/g);
    let pos = 0;
    const peek = () => toks[pos], take = () => toks[pos++];
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
      while (["*", "/", "%"].includes(peek())) { const op = take(), r = power(); v = op === "*" ? v * r : op === "/" ? v / r : v % r; }
      return v;
    };
    const sum = () => {
      let v = product();
      while (["+", "-"].includes(peek())) { const op = take(), r = product(); v = op === "+" ? v + r : v - r; }
      return v;
    };
    try { const v = sum(); return pos === toks.length && Number.isFinite(v) ? v : null; } catch { return null; }
  }
  const UNITS = {
    length: { mm: .001, cm: .01, m: 1, km: 1000, in: .0254, ft: .3048, yd: .9144, mi: 1609.344 },
    mass: { mg: 1e-6, g: .001, kg: 1, t: 1000, oz: .028349523125, lb: .45359237 },
    volume: { ml: .001, l: 1, floz: .0295735295625, cup: .2365882365, pt: .473176473, qt: .946352946, gal: 3.785411784 },
    data: { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 },
  };
  const ALIAS = { mile: "mi", miles: "mi", meter: "m", meters: "m", kilometer: "km", kilometers: "km", inch: "in", inches: "in", foot: "ft", feet: "ft", pound: "lb", pounds: "lb", lbs: "lb", gram: "g", grams: "g", kilogram: "kg", kilograms: "kg", ounce: "oz", ounces: "oz", liter: "l", liters: "l", litre: "l", litres: "l", gallon: "gal", gallons: "gal", celsius: "c", "°c": "c", fahrenheit: "f", "°f": "f", kelvin: "k" };
  const fmt = v => Number(v).toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) < 1 ? 6 : 4 });
  function convertUnits(q) {
    const m = /^(-?[\d.,]+)\s*([a-z°-]+)\s+(?:to|in|=)\s+([a-z°-]+)$/i.exec(q.trim());
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ""));
    const u = s => ALIAS[s.toLowerCase()] || s.toLowerCase();
    const from = u(m[2]), to = u(m[3]);
    const toC = { c: v => v, f: v => (v - 32) * 5 / 9, k: v => v - 273.15 }, fromC = { c: v => v, f: v => v * 9 / 5 + 32, k: v => v + 273.15 };
    if (toC[from] && fromC[to]) { const v = fromC[to](toC[from](n)); return { text: `${fmt(n)} °${from.toUpperCase()} = ${fmt(v)} °${to.toUpperCase()}`.replace("°K", "K"), value: v }; }
    for (const kind of Object.values(UNITS)) if (kind[from] && kind[to]) { const v = n * kind[from] / kind[to]; return { text: `${fmt(n)} ${from} = ${fmt(v)} ${to}`, value: v }; }
    return null;
  }
  const BANGS = { g: "Google", ddg: "DuckDuckGo", yt: "YouTube", gh: "GitHub", w: "Wikipedia", maps: "Google Maps", amz: "Amazon", r: "Reddit", x: "X", img: "Google Images", tr: "Google Translate" };

  // ---- a Pomodoro, started from the command bar ----
  const pomo = $("#pomo"), pomoTime = $("#pomo-time");
  let pomoLeft = 0, pomoTimer = 0;
  const paintPomo = () => { pomoTime.textContent = String(Math.floor(pomoLeft / 60)).padStart(2, "0") + ":" + String(pomoLeft % 60).padStart(2, "0"); };
  function stopPomo() { clearInterval(pomoTimer); pomo.hidden = true; }
  function startPomo() {
    clearInterval(pomoTimer);
    pomoLeft = 25 * 60; paintPomo(); pomo.hidden = false;
    pomoTimer = setInterval(() => { pomoLeft--; if (pomoLeft <= 0) { stopPomo(); toast("Focus session done. Take a break."); } else paintPomo(); }, 1000);
    toast("Pomodoro started. Click the timer to stop it.");
  }
  $("#pomo-stop").addEventListener("click", () => { stopPomo(); toast("Pomodoro stopped"); });

  // ---- the command bar ----
  const CMDS = [
    ["Go to Command Bar", "", "navigate section"], ["Go to Built In Tools", "", "navigate section"], ["Go to All Features", "", "navigate section list"],
    ["Go to Privacy", "", "navigate section"], ["Go to Download", "", "navigate section install"], ["Go to Support", "", "navigate section contact help"],
    ["Toggle Dark Mode", "", "night theme invert light"], ["Start Pomodoro (25 min)", "", "timer focus work"],
    ["New Tab", "Mod+T"], ["Reopen Closed Tab", "Mod+Shift+T", "undo restore"], ["Pin / Unpin Tab"], ["Tidy Tabs by Site", "", "organize group sort clean"], ["Close Duplicate Tabs", "", "dedupe clean"],
    ["Mute All Tabs", "", "sound audio silence"], ["Split View with Recent Tab", "", "side by side"], ["Picture in Picture", "Mod+Alt+P", "video float"], ["Copy Link Without Tracking", "", "utm clean url share"],
    ["Show QR Code for This Page", "", "phone share"], ["Translate Page", "", "language english"], ["Force Dark Mode on This Site", "", "night theme invert dark"], ["Bookmark This Page", "Mod+D", "favorite save"],
    ["Find in Page", "Mod+F", "search text"], ["Screenshot Selected Area", "Mod+Shift+4", "capture"], ["Screenshot Visible Area", "Mod+Shift+S", "capture"], ["Screenshot Full Page", "Mod+Alt+Shift+S", "capture"],
    ["Download YouTube Video", "Mod+Shift+D"], ["New Space"], ["Zoom In", "Mod+="], ["Show History", "Mod+Y"], ["Show Downloads", "Mod+Shift+J"], ["Browse Chrome Web Store Extensions"],
    ["Import from Browser (Chrome, Edge, Brave, Arc)"], ["Show Tools", "Mod+Shift+U", "timer stopwatch pomodoro clock notes focus time tracker"],
    ["Start Focus Mode (25 min)", "", "block distractions sites concentrate"], ["Show World Clock", "", "time zones clocks cities"], ["Open Markdown File…", "", "md edit view read document"],
    ["Pick a Color from the Page", "", "eyedropper hex"], ["Download All Images on This Page", "", "save pictures photos"], ["Check for Updates", "", "version release new download upgrade"], ["Settings", "Mod+,", "preferences options search engine downloads theme"],
  ];
  const OPEN_TABS = [["Product roadmap", "work.example"], ["Design review notes", "work.example"], ["Reading list", "home.example"], ["Inbox", "mail.example"], ["The case for quiet interfaces", "journal.example"]];
  const palQ = $("#pal-q"), palList = $("#pal-list"), palHint = $("#pal-hint");
  let palItems = [], palSel = 0;
  const match = (text, words) => { const t = text.toLowerCase(); return words.every(w => t.includes(w)) ? (t.startsWith(words[0]) ? 2 : 1) : 0; };
  function runCommand(title) { // a few commands act on this page; the rest say what they would do in the app
    if (/^Go to Command Bar/.test(title)) go("#bar-demo");
    else if (/^Go to Built In|^Show Tools|^Open Markdown|^Show World Clock|^Start Focus/.test(title)) { go("#built-in"); if (!/^Go to/.test(title)) toast("Tools and the Markdown editor are right here"); }
    else if (/^Go to All Features/.test(title)) go("#features");
    else if (/^Go to Privacy/.test(title)) go("#privacy");
    else if (/^Go to Download|^Check for Updates/.test(title)) { go("#download"); if (/^Check/.test(title)) toast("Alcove would check for a newer release"); }
    else if (/^Go to Support/.test(title)) go("#support");
    else if (/^Toggle Dark Mode|^Force Dark Mode/.test(title)) { toggleTheme(); toast(isDark() ? "Dark mode on" : "Dark mode off"); }
    else if (/^Start Pomodoro/.test(title)) startPomo();
    else toast(`In Alcove this would run “${title}”`);
  }
  function computePalette() {
    const q = palQ.value.trim(), words = q.toLowerCase().split(/\s+/).filter(Boolean), out = [];
    if (q) {
      const calc = calculate(q.replace(/^=/, ""));
      if (calc !== null) out.push({ kind: "Calculator", title: "= " + fmt(calc), sub: "Enter copies the result", big: true, run: async () => toast((await copy(String(calc))) ? `Copied ${fmt(calc)}` : `Result: ${fmt(calc)}`) });
      const unit = convertUnits(q);
      if (unit) out.push({ kind: "Convert", title: unit.text, sub: "Enter copies the result", big: true, run: async () => toast((await copy(String(+unit.value.toFixed(6)))) ? `Copied ${fmt(unit.value)}` : unit.text) });
      const bang = /^!?(\S+)\s+(.+)$/.exec(q);
      if (bang && BANGS[bang[1].toLowerCase()]) out.push({ kind: "Shortcut", title: `Search ${BANGS[bang[1].toLowerCase()]} for “${bang[2]}”`, sub: "Opens in a new tab in Alcove", run: () => toast(`In Alcove this would search ${BANGS[bang[1].toLowerCase()]} for “${bang[2]}”`) });
      const split = /^split\s+(.+)$/i.exec(q);
      if (split) for (const [title, host] of OPEN_TABS) if (match(title + " " + host, split[1].toLowerCase().split(/\s+/))) out.push({ kind: "Split", title: `Split view with ${title}`, sub: host, run: () => toast(`In Alcove ${title} would open beside this tab`) });
    }
    const web = q ? { kind: "Go", title: `Search the web for “${q}”`, sub: "Open here · Shift+Enter for a new tab", run: () => toast(`In Alcove this would search for “${q}”`) } : null;
    const rest = [];
    if (q) for (const [title, host] of OPEN_TABS) { const s = match(title + " " + host, words); if (s) rest.push({ s: 300 + s, kind: "Tab", title, sub: host, run: () => toast(`In Alcove this would switch to “${title}”`) }); }
    CMDS.forEach(([title, keys, extra], order) => {
      const s = q ? match(title + " " + (extra || ""), words) : 1;
      if (!s) return;
      const inTitle = q && words.every(w => title.toLowerCase().includes(w)); // a command whose own name you typed beats one that only has it as a hint word
      rest.push({ s: q ? (inTitle ? 260 : 200) + s - order / 100 : 100 - order, kind: "Command", title, keys: keyLabel(keys), run: () => runCommand(title) });
    });
    rest.sort((a, b) => b.s - a.s);
    const shown = rest.slice(0, q ? 8 : 7);
    // Like the app: the web search comes first, unless a tab or command clearly matches what you typed.
    return out.concat(web && shown.length && shown[0].s >= 260 ? [shown[0], web, ...shown.slice(1)] : web ? [web, ...shown] : shown);
  }
  function renderPalette() {
    palItems = computePalette();
    palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
    palList.textContent = "";
    palItems.forEach((it, i) => {
      const li = document.createElement("li");
      li.id = "pal-" + i; li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(i === palSel));
      if (it.big) li.className = "big";
      const wrap = document.createElement("div"), t = document.createElement("span");
      t.className = "t"; t.textContent = it.title; wrap.append(t);
      if (it.sub) { const s = document.createElement("span"); s.className = "s"; s.textContent = it.sub; wrap.append(s); }
      const key = document.createElement("span");
      if (it.keys) { const k = document.createElement("kbd"); k.textContent = it.keys; key.append(k); }
      const kind = document.createElement("span"); kind.className = "k"; kind.textContent = it.kind;
      li.append(wrap, key, kind);
      li.addEventListener("pointermove", () => { if (palSel !== i) { palSel = i; markSel(); } });
      li.addEventListener("click", () => { palSel = i; markSel(); runSel(); });
      palList.append(li);
    });
    palQ.setAttribute("aria-activedescendant", palItems.length ? "pal-" + palSel : "");
  }
  function markSel() {
    $$("li", palList).forEach((li, i) => li.setAttribute("aria-selected", String(i === palSel)));
    palQ.setAttribute("aria-activedescendant", "pal-" + palSel);
    const el = $("#pal-" + palSel); if (el) el.scrollIntoView({ block: "nearest" });
  }
  function runSel() { const it = palItems[palSel]; if (!it) return; palHint.textContent = `${it.kind}: ${it.title}`; it.run(); }
  palQ.addEventListener("input", () => { palSel = 0; renderPalette(); });
  palQ.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); markSel(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(0, palSel - 1); markSel(); }
    else if (e.key === "Enter") { e.preventDefault(); runSel(); }
    else if (e.key === "Escape") { palQ.value = ""; palSel = 0; renderPalette(); }
  });
  for (const b of $$(".tries button")) b.addEventListener("click", () => { palQ.value = b.dataset.q; palSel = 0; renderPalette(); palQ.focus({ preventScroll: true }); });
  renderPalette();
  $("#mod-k").textContent = isMac ? "⌘ K" : "Ctrl K";
  // Cmd or Ctrl + K, from anywhere on the page, takes you to the command bar
  addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (menuOpen) closeMenu(false);
      go("#bar-demo");
      palQ.focus({ preventScroll: true });
    } else if (e.key === "Escape" && menuOpen) closeMenu(true);
  });

  // ---- the feature index: groups and search ----
  const rows = $$("#fgrid .row"), cats = $$(".cat"), featQ = $("#feat-q"), result = $("#feat-result"), empty = $("#feat-empty");
  let cat = "all", query = "";
  function filter() {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const li of rows) {
      const ok = (cat === "all" || li.dataset.cat === cat) && words.every(w => (li.textContent + " " + li.dataset.cat).toLowerCase().includes(w));
      if (ok) {
        shown++;
        if (li.hidden) { li.hidden = false; li.classList.add("out"); raf(() => raf(() => li.classList.remove("out"))); } else li.classList.remove("out");
      } else if (!li.hidden) {
        li.classList.add("out");
        setTimeout(() => { if (li.classList.contains("out")) li.hidden = true; }, reduceMQ.matches ? 0 : 190);
      }
    }
    result.textContent = shown === rows.length ? `Showing all ${rows.length}` : `Showing ${shown} of ${rows.length}`;
    empty.hidden = shown !== 0;
  }
  for (const b of cats) b.addEventListener("click", () => {
    cat = b.dataset.cat;
    for (const c of cats) { const on = c === b; c.classList.toggle("on", on); c.setAttribute("aria-pressed", String(on)); }
    filter();
  });
  let typing = 0;
  featQ.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { query = featQ.value; filter(); }, 90); });

  // ---- accordions ----
  for (const b of $$(".acc button")) b.addEventListener("click", () => {
    const open = b.getAttribute("aria-expanded") !== "true";
    b.setAttribute("aria-expanded", String(open));
    b.closest(".acc").classList.toggle("open", open);
  });

  // ---- copy the support address ----
  const copyMail = $("#copy-mail");
  copyMail.addEventListener("click", async () => {
    const ok = await copy(copyMail.dataset.mail);
    toast(ok ? "Email address copied" : "Select the address and copy it");
    if (ok) { const s = $("span", copyMail); s.textContent = "Copied"; setTimeout(() => { s.textContent = "Copy address"; }, 1800); }
  });

  // ---- downloads: the visitor's system, and the latest release ----
  const REPO = "mrmx485-sudo/alcove";
  // The list endpoint answers 200 with an empty list while nothing is published, so a fresh repository leaves no error in the console
  // (releases/latest would answer 404). Drafts are never listed to visitors; pre-releases are skipped, as releases/latest does.
  const API = `https://api.github.com/repos/${REPO}/releases?per_page=5`;
  const PREFIX = `https://github.com/${REPO}/releases/`;
  const FILES = { win: /^Alcove-Setup-.+-x64\.exe$/, "mac-arm64": /-mac-arm64\.dmg$/, "mac-x64": /-mac-x64\.dmg$/ };
  const LABEL = { win: "Download for Windows", "mac-arm64": "Download for Apple silicon", "mac-x64": "Download for Intel" };
  const mobile = /Android|iPhone|iPad|iPod/i.test(nav.userAgent) || (isMac && nav.maxTouchPoints > 1); // an iPad reports "MacIntel"
  const os = mobile ? "mobile" : /Win/i.test(platform) ? "win" : isMac ? "mac" : "other";
  html.dataset.os = os;
  const heroBtn = $("#dl-hero"), heroSwap = $(".swap", heroBtn), dlRows = $$(".dl-row");
  let arch = "", release = null; // arch: "arm" or "x86" where the browser says (Chrome and Edge do; Safari and Firefox do not)

  function markDownloads() {
    for (const row of dlRows) {
      const f = row.dataset.file;
      const yes = (os === "win" && f === "win") || (os === "mac" && (arch === "arm" ? f === "mac-arm64" : arch === "x86" ? f === "mac-x64" : f.startsWith("mac")));
      row.classList.toggle("pick", yes);
      $(".rec", row).hidden = !yes;
    }
    const note = $("[data-mobile]");
    if (note) note.hidden = os !== "mobile";
  }
  const want = () => os === "win" ? "win" : os === "mac" && arch === "arm" ? "mac-arm64" : os === "mac" && arch === "x86" ? "mac-x64" : "";
  function paintHero() {
    const f = want(), asset = release && f && release.files[f];
    setSwap(heroSwap, asset ? LABEL[f] : os === "mac" ? "Download for Mac" : os === "win" ? "Download for Windows" : os === "mobile" ? "Get Alcove for your computer" : "Download");
    heroBtn.setAttribute("href", asset ? asset.url : "#download");
  }
  markDownloads(); paintHero();
  if (os === "mac" && uaData && uaData.getHighEntropyValues) {
    uaData.getHighEntropyValues(["architecture"]).then(v => { arch = v.architecture === "arm" ? "arm" : v.architecture === "x86" ? "x86" : ""; markDownloads(); paintHero(); }).catch(() => {});
  }
  const mb = n => (n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  async function latest() {
    try { const c = JSON.parse(sessionStorage.getItem("alcove-release") || "null"); if (c && Date.now() - c.at < 600000) return c.data; } catch {}
    const res = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return null;
    const list = await res.json();
    const j = Array.isArray(list) ? list.find(r => r && !r.draft && !r.prerelease) : null;
    if (!j) return null; // nothing published yet
    const data = { tag: String(j.tag_name || ""), page: String(j.html_url || ""), assets: (j.assets || []).map(a => ({ name: String(a.name || ""), url: String(a.browser_download_url || ""), size: Number(a.size) || 0 })) };
    try { sessionStorage.setItem("alcove-release", JSON.stringify({ at: Date.now(), data })); } catch {}
    return data;
  }
  latest().then(data => {
    if (!data || !/^v?\d[\w.+-]*$/.test(data.tag)) return;
    const files = {};
    for (const [key, re] of Object.entries(FILES)) {
      const a = data.assets.find(x => re.test(x.name) && x.url.startsWith(`${PREFIX}download/`)); // the answer is data from the network: only files of this repository
      if (a) files[key] = a;
    }
    release = { files };
    const version = data.tag.replace(/^v/, "");
    for (const row of dlRows) {
      const a = files[row.dataset.file];
      if (!a) continue;
      $("a.go", row).setAttribute("href", a.url);
      $("[data-meta]", row).textContent = `Version ${version} · ${mb(a.size)}`;
    }
    const line = $("[data-release-line]");
    if (line) line.textContent = `Version ${version} · Free · Open source · No account · No telemetry`;
    const line2 = $("[data-release-line-2]");
    if (line2 && data.page.startsWith(PREFIX)) {
      line2.textContent = "Free and open source under the MIT license. ";
      const a = document.createElement("a");
      a.href = data.page; a.textContent = `What's new in ${version}`;
      line2.append(a);
    }
    paintHero();
  }).catch(() => {}); // offline or rate-limited: the buttons keep pointing at the latest-release page
})();
