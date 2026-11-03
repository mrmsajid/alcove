// Alcove's web page. Plain JavaScript, no libraries. Everything here is progressive: without it the page is a normal static page
// whose download buttons point at the latest-release page. The only request the page makes is to GitHub, to find the latest release.
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const html = document.documentElement;
  html.classList.add("js");
  const raf = requestAnimationFrame;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(pointer: fine)");
  const nav = navigator, uaData = nav.userAgentData;
  const platform = (uaData && uaData.platform) || nav.platform || "";
  const isMac = /Mac/i.test(platform);
  const MOD = isMac ? "⌘" : "Ctrl+", SHIFT = isMac ? "⇧" : "Shift+", ALT = isMac ? "⌥" : "Alt+";
  const keyLabel = k => (k ? k.replace("Mod+", MOD).replace("Shift+", SHIFT).replace("Alt+", ALT) : "");

  // ---- toast ----
  const toastEl = $("#toast");
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("on"), 2600);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }

  // ---- theme: follows the system until the visitor picks one (kept in localStorage, which may be unavailable) ----
  const THEME_KEY = "alcove-site-theme", themeBtn = $("#theme"), dark = matchMedia("(prefers-color-scheme: dark)");
  const stored = { get() { try { return localStorage.getItem(THEME_KEY); } catch { return null; } }, set(v) { try { localStorage.setItem(THEME_KEY, v); } catch {} } };
  let theme = stored.get();
  if (theme !== "light" && theme !== "dark") theme = null;
  const isDark = () => (theme ? theme === "dark" : dark.matches);
  function applyTheme() {
    if (theme) html.dataset.theme = theme; else delete html.dataset.theme;
    // The screenshots come in a light and a dark version (<picture>): a chosen theme overrides the system query.
    for (const s of $$("picture > source")) s.media = theme ? (theme === "dark" ? "all" : "not all") : "(prefers-color-scheme: dark)";
    themeBtn.setAttribute("aria-pressed", String(isDark()));
  }
  themeBtn.addEventListener("click", () => { theme = isDark() ? "light" : "dark"; stored.set(theme); applyTheme(); });
  if (dark.addEventListener) dark.addEventListener("change", applyTheme);
  applyTheme();

  // ---- scroll progress, header shadow, and the section being read ----
  const progress = $(".progress i");
  const links = $$(".links a");
  const spy = links.map(a => $(a.getAttribute("href"))).filter(Boolean);
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    raf(() => {
      ticking = false;
      const h = html.scrollHeight - innerHeight;
      progress.style.setProperty("--p", h > 0 ? (scrollY / h).toFixed(4) : "0");
      html.classList.toggle("scrolled", scrollY > 8);
      const y = scrollY + innerHeight * 0.35;
      let cur = null;
      for (const s of spy) if (s.offsetTop <= y) cur = s;
      for (const a of links) a.classList.toggle("on", !!cur && a.getAttribute("href") === "#" + cur.id);
    });
  }
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll, { passive: true });
  onScroll();

  // ---- reveal on scroll, count-ups ----
  function countUp(el) {
    const to = Number(el.dataset.count) || 0;
    if (reduce.matches || to === 0) { el.textContent = String(to); return; }
    const t0 = performance.now(), D = 1300;
    const step = now => {
      const p = Math.min(1, (now - t0) / D);
      el.textContent = String(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf(step);
    };
    el.textContent = "0";
    raf(step);
  }
  const seen = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      if (e.target.matches("[data-count]")) countUp(e.target);
      $$("[data-count]", e.target).forEach(countUp);
      seen.unobserve(e.target);
    }
  }, { threshold: 0.14, rootMargin: "0px 0px -6% 0px" }) : null;
  for (const el of $$(".reveal, .fgrid, [data-count]")) { if (seen) seen.observe(el); else el.classList.add("in"); }

  // ---- a soft spotlight that follows the pointer on cards ----
  addEventListener("pointermove", e => {
    const t = e.target.closest && e.target.closest(".spot, .f");
    if (!t) return;
    const r = t.getBoundingClientRect();
    t.style.setProperty("--mx", (e.clientX - r.left).toFixed(0) + "px");
    t.style.setProperty("--my", (e.clientY - r.top).toFixed(0) + "px");
  }, { passive: true });

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

  // ---- hero: sidebar toggle, pointer tilt, live chips ----
  const win = $("#win"), seg = $$(".seg button");
  let touchedSidebar = false;
  function setSidebar(v, byUser) {
    if (byUser) touchedSidebar = true;
    win.dataset.sidebar = v;
    for (const b of seg) { const on = b.dataset.side === v; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); }
  }
  for (const b of seg) b.addEventListener("click", () => setSidebar(b.dataset.side, true));
  if (!reduce.matches) setTimeout(() => { // a one-time hint that the sidebar is a toggle: hide it, then bring it back
    if (touchedSidebar) return;
    setSidebar("off");
    setTimeout(() => { if (!touchedSidebar) setSidebar("on"); }, 2300);
  }, 3800);

  const stage = $("#stage"), tilt = $("#tilt");
  if (finePointer.matches && !reduce.matches) {
    let pending = 0;
    stage.addEventListener("pointermove", e => {
      if (pending) return;
      const r = stage.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      pending = raf(() => {
        pending = 0;
        tilt.style.setProperty("--ry", (x * 7).toFixed(2) + "deg");
        tilt.style.setProperty("--rx", (-y * 5).toFixed(2) + "deg");
        stage.style.setProperty("--px", x.toFixed(3));
        stage.style.setProperty("--py", y.toFixed(3));
      });
    });
    stage.addEventListener("pointerleave", () => {
      tilt.style.setProperty("--ry", "0deg"); tilt.style.setProperty("--rx", "0deg");
      stage.style.setProperty("--px", "0"); stage.style.setProperty("--py", "0");
    });
  }

  const modK = isMac ? "⌘ K" : "Ctrl K";
  $$(".chip .mod, #mod-k").forEach(k => { k.textContent = modK; });
  const chipRing = $("#chip-ring"), chipTime = $("#chip-time"), CHIP_C = 2 * Math.PI * 18;
  chipRing.style.setProperty("stroke-dasharray", CHIP_C.toFixed(2));
  let chipLeft = 24 * 60 + 58;
  function tickChip() {
    chipLeft = chipLeft <= 0 ? 25 * 60 : chipLeft - 1;
    chipTime.textContent = Math.floor(chipLeft / 60) + ":" + String(chipLeft % 60).padStart(2, "0");
    chipRing.style.setProperty("stroke-dashoffset", (CHIP_C * (1 - chipLeft / 1500)).toFixed(2));
  }
  tickChip();
  if (!reduce.matches) setInterval(() => { if (!document.hidden) tickChip(); }, 1000);

  const samples = ["12 × (3 + 4)", "5 mi to km", "72 f to c", "yt lofi", "2 gb to mb", "(18 + 6) / 4"];
  const chipQ = $("#chip-q"), chipA = $("#chip-a");
  const answerFor = q => {
    const c = calculate(q); if (c !== null) return "= " + fmt(c);
    const u = convertUnits(q); if (u) return u.text;
    const b = /^(\S+)\s+(.+)$/.exec(q); if (b && BANGS[b[1]]) return `Search ${BANGS[b[1]]} for “${b[2]}”`;
    return "";
  };
  let sample = 0;
  function nextSample() {
    const q = samples[sample++ % samples.length];
    chipQ.classList.add("swap"); chipA.classList.add("swap");
    setTimeout(() => { chipQ.textContent = q; chipA.textContent = answerFor(q); chipQ.classList.remove("swap"); chipA.classList.remove("swap"); }, 260);
  }
  if (!reduce.matches) setInterval(() => { if (!document.hidden) nextSample(); }, 3400);

  // ---- the tour: five screens, with an optional auto-advance ----
  const tabs = $$(".tab"), panels = $$(".panel"), tour = $(".tour");
  let cur = 0, auto = !reduce.matches, paused = false, visible = false, elapsed = 0, last = 0, loopId = 0;
  const DURATION = 7000;
  function show(i, byUser) {
    cur = i; elapsed = 0; last = 0;
    if (byUser) auto = false;
    tabs.forEach((t, k) => {
      const on = k === i;
      t.classList.toggle("on", on); t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1;
      $("u", t).style.setProperty("--prog", on && !auto ? "1" : "0");
    });
    panels.forEach((p, k) => { const on = k === i; p.classList.toggle("on", on); p.inert = !on; });
  }
  function loop(ts) {
    loopId = 0;
    if (!auto) return;
    if (paused || !visible || document.hidden) { last = 0; return; }
    if (!last) last = ts;
    elapsed += ts - last; last = ts;
    const p = Math.min(1, elapsed / DURATION);
    $("u", tabs[cur]).style.setProperty("--prog", p.toFixed(3));
    if (p >= 1) show((cur + 1) % tabs.length);
    loopId = raf(loop);
  }
  const kick = () => { if (auto && !loopId) loopId = raf(loop); };
  tabs.forEach((t, i) => t.addEventListener("click", () => show(i, true)));
  $(".tabs").addEventListener("keydown", e => {
    const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    let i = d ? (cur + d + tabs.length) % tabs.length : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (i < 0) return;
    e.preventDefault(); show(i, true); tabs[i].focus();
  });
  tour.addEventListener("pointerenter", () => { paused = true; });
  tour.addEventListener("pointerleave", () => { paused = false; kick(); });
  tour.addEventListener("focusin", () => { paused = true; });
  tour.addEventListener("focusout", () => { paused = false; kick(); });
  document.addEventListener("visibilitychange", kick);
  if ("IntersectionObserver" in window) new IntersectionObserver(es => { visible = es[0].isIntersecting; kick(); }, { threshold: 0.35 }).observe(tour);
  show(0);
  const goToTour = i => { show(i, true); $("#showcase").scrollIntoView({ behavior: reduce.matches ? "auto" : "smooth", block: "start" }); };

  // ---- demo: Pomodoro ----
  const pomo = $(".demo-pomo"), pomoTime = $("#pomo-time"), pomoRing = $("#pomo-ring"), pomoGo = $("#pomo-go"), pomoPhase = $("#pomo-phase"), pomoSess = $("#pomo-sessions");
  const POMO_C = 2 * Math.PI * 54, PHASES = { focus: [25 * 60, "Focus"], break: [5 * 60, "Break"] };
  let phase = "focus", left = PHASES.focus[0], running = false, pomoTimer = 0, sessions = 0;
  pomoRing.style.setProperty("stroke-dasharray", POMO_C.toFixed(3));
  function paintPomo() {
    pomoTime.textContent = String(Math.floor(left / 60)).padStart(2, "0") + ":" + String(left % 60).padStart(2, "0");
    pomoRing.style.setProperty("stroke-dashoffset", (POMO_C * (1 - left / PHASES[phase][0])).toFixed(3));
    pomoPhase.textContent = PHASES[phase][1];
    pomo.classList.toggle("is-break", phase === "break");
    pomo.classList.toggle("running", running);
    $("span", pomoGo).textContent = running ? "Pause" : left === PHASES[phase][0] ? "Start" : "Resume";
    $("use", pomoGo).setAttribute("href", running ? "#i-pause" : "#i-play");
    pomoSess.textContent = sessions + (sessions === 1 ? " session" : " sessions") + " today";
  }
  function endPhase() {
    if (phase === "focus") { sessions++; phase = "break"; toast("Focus session done. Time for a break."); } else { phase = "focus"; }
    left = PHASES[phase][0];
  }
  function setRunning(on) {
    running = on;
    clearInterval(pomoTimer);
    if (on) pomoTimer = setInterval(() => { left--; if (left <= 0) endPhase(); paintPomo(); }, 1000);
    paintPomo();
  }
  pomoGo.addEventListener("click", () => setRunning(!running));
  $("#pomo-reset").addEventListener("click", () => { phase = "focus"; left = PHASES.focus[0]; setRunning(false); });
  $("#pomo-skip").addEventListener("click", () => { endPhase(); paintPomo(); });
  paintPomo();
  function pulse(el) { el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse"); setTimeout(() => el.classList.remove("pulse"), 1400); }

  // ---- demo: your day ----
  const TODOS = [["Review the pricing copy", false], ["Send the beta invites", false], ["Draft the announcement", true], ["Record the walkthrough", true], ["Check the page on a phone", false]];
  const todoList = $("#todos"), repDone = $("#rep-done"), repOpen = $("#rep-open"), repPct = $("#rep-pct"), repBar = $("#rep-bar");
  function paintReport(bump) {
    const done = TODOS.filter(t => t[1]).length, open = TODOS.length - done;
    repDone.textContent = done; repOpen.textContent = open; repPct.textContent = Math.round(done / TODOS.length * 100) + "%";
    repBar.style.setProperty("--w", (done / TODOS.length * 100) + "%");
    if (bump) for (const b of [repDone, repOpen, repPct]) { b.classList.add("bump"); setTimeout(() => b.classList.remove("bump"), 260); }
  }
  TODOS.forEach((t, i) => {
    const li = document.createElement("li"), b = document.createElement("button");
    b.type = "button"; b.setAttribute("role", "checkbox"); b.setAttribute("aria-checked", String(t[1]));
    b.innerHTML = '<span class="box"><svg class="icon" aria-hidden="true"><use href="#i-check"/></svg></span><span class="lbl"></span>';
    $(".lbl", b).textContent = t[0];
    b.addEventListener("click", () => { t[1] = !t[1]; b.setAttribute("aria-checked", String(t[1])); paintReport(true); });
    li.append(b); todoList.append(li);
  });
  paintReport(false);
  $("#rep-copy").addEventListener("click", async () => {
    const done = TODOS.filter(t => t[1]).length;
    const text = `Today in Alcove\nTo-dos done: ${done} (${TODOS.length - done} open)\n` + TODOS.map(t => `${t[1] ? "[x]" : "[ ]"} ${t[0]}`).join("\n");
    toast((await copy(text)) ? "Report copied" : "Could not copy here");
  });

  // ---- demo: the command bar ----
  const CMDS = [
    ["New Tab", "Mod+T"], ["Reopen Closed Tab", "Mod+Shift+T", "undo restore"], ["Pin / Unpin Tab"], ["Tidy Tabs by Site", "", "organize group sort clean"], ["Close Duplicate Tabs", "", "dedupe clean"],
    ["Mute All Tabs", "", "sound audio silence"], ["Split View with Recent Tab", "", "side by side"], ["Picture in Picture", "Mod+Alt+P", "video float"], ["Copy Link Without Tracking", "", "utm clean url share"],
    ["Show QR Code for This Page", "", "phone share"], ["Translate Page", "", "language english"], ["Force Dark Mode on This Site", "", "night theme invert dark"], ["Bookmark This Page", "Mod+D", "favorite save"],
    ["Find in Page", "Mod+F", "search text"], ["Screenshot Selected Area", "Mod+Shift+4", "capture"], ["Screenshot Visible Area", "Mod+Shift+S", "capture"], ["Screenshot Full Page", "Mod+Alt+Shift+S", "capture"],
    ["Download YouTube Video", "Mod+Shift+D"], ["New Space"], ["Zoom In", "Mod+="], ["Show History", "Mod+Y"], ["Show Downloads", "Mod+Shift+J"], ["Browse Chrome Web Store Extensions"],
    ["Import from Browser (Chrome, Edge, Brave, Arc)"], ["Show Tools", "Mod+Shift+U", "timer stopwatch pomodoro clock notes focus time tracker"], ["Start Pomodoro (25 min)", "", "timer focus work"],
    ["Start Focus Mode (25 min)", "", "block distractions sites concentrate"], ["Show World Clock", "", "time zones clocks cities"], ["Open Markdown File…", "", "md edit view read document"],
    ["Pick a Color from the Page", "", "eyedropper hex"], ["Download All Images on This Page", "", "save pictures photos"], ["Check for Updates", "", "version release new download upgrade"], ["Settings", "Mod+,", "preferences options search engine downloads theme"],
  ];
  const OPEN_TABS = [["Product roadmap", "work.example"], ["Design review notes", "work.example"], ["Reading list", "home.example"], ["Inbox", "mail.example"], ["The case for quiet interfaces", "journal.example"]];
  const palQ = $("#pal-q"), palList = $("#pal-list"), palHint = $("#pal-hint");
  let palItems = [], palSel = 0;
  const match = (text, words) => { const t = text.toLowerCase(); return words.every(w => t.includes(w)) ? (t.startsWith(words[0]) ? 2 : 1) : 0; };
  function computePalette() {
    const raw = palQ.value, q = raw.trim(), words = q.toLowerCase().split(/\s+/).filter(Boolean), out = [];
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
    const go = q ? { kind: "Go", title: `Search the web for “${q}”`, sub: "Open here · Shift+Enter for a new tab", run: () => toast(`In Alcove this would search for “${q}”`) } : null;
    const rest = [];
    for (const [title, host] of OPEN_TABS) { const s = q ? match(title + " " + host, words) : 0; if (q && s) rest.push({ s: 300 + s, kind: "Tab", title, sub: host, run: () => toast(`In Alcove this would switch to “${title}”`) }); }
    CMDS.forEach(([title, keys, extra], order) => {
      const s = q ? match(title + " " + (extra || ""), words) : 1;
      if (!s) return;
      const inTitle = q && words.every(w => title.toLowerCase().includes(w)); // a command whose own name you typed beats one that only has it as a hint word
      rest.push({ s: q ? (inTitle ? 260 : 200) + s - order / 100 : 100 - order, kind: "Command", title, keys: keyLabel(keys), run: () => runCommand(title) });
    });
    rest.sort((a, b) => b.s - a.s);
    const shown = rest.slice(0, q ? 8 : 7);
    // Like the app: the web search comes first, unless a tab or command clearly matches what you typed.
    return out.concat(go && shown.length && shown[0].s >= 260 ? [shown[0], go, ...shown.slice(1)] : go ? [go, ...shown] : shown);
  }
  function runCommand(title) { // a few commands do something real on this page; the rest say what they would do
    if (/^Start Pomodoro/.test(title)) { pomo.scrollIntoView({ behavior: reduce.matches ? "auto" : "smooth", block: "center" }); if (!running) setRunning(true); pulse(pomo); toast("Pomodoro started"); }
    else if (/^Force Dark Mode/.test(title)) { theme = isDark() ? "light" : "dark"; stored.set(theme); applyTheme(); toast(isDark() ? "Dark mode on for this site" : "Dark mode off"); }
    else if (/^Show Tools/.test(title)) { goToTour(3); toast("Here are the built-in tools"); }
    else if (/^Check for Updates/.test(title)) { $("#download").scrollIntoView({ behavior: reduce.matches ? "auto" : "smooth" }); toast("Alcove would check for a newer release"); }
    else if (/^Show World Clock|^Start Focus/.test(title)) { goToTour(3); toast("Tools has a world clock and focus mode"); }
    else if (/^Open Markdown/.test(title)) { goToTour(4); toast("The Markdown editor is on this screen"); }
    else toast(`In Alcove this would run “${title}”`);
  }
  function renderPalette() {
    palItems = computePalette();
    palSel = Math.min(palSel, Math.max(0, palItems.length - 1));
    palList.textContent = "";
    palItems.forEach((it, i) => {
      const li = document.createElement("li");
      li.id = "pal-" + i; li.setAttribute("role", "option"); li.setAttribute("aria-selected", String(i === palSel));
      if (it.big) li.className = "big";
      const wrap = document.createElement("div"), t = document.createElement("span"), s = document.createElement("span");
      t.className = "t"; t.textContent = it.title; wrap.append(t);
      if (it.sub) { s.className = "s"; s.textContent = it.sub; wrap.append(s); }
      li.append(wrap);
      const key = document.createElement("span");
      if (it.keys) { const k = document.createElement("kbd"); k.textContent = it.keys; key.append(k); }
      const kind = document.createElement("span"); kind.className = "k"; kind.textContent = it.kind;
      li.append(key, kind);
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
  for (const b of $$(".try-chips button")) b.addEventListener("click", () => { palQ.value = b.dataset.q; palSel = 0; renderPalette(); palQ.focus({ preventScroll: true }); });
  renderPalette();

  // ---- the full feature list: search and categories ----
  const items = $$("#fgrid .f"), cats = $$(".cat"), featQ = $("#feat-q"), result = $("#feat-result"), empty = $("#feat-empty"), grid = $("#fgrid");
  let cat = "all", query = "";
  function filter() {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const li of items) {
      const ok = (cat === "all" || li.dataset.cat === cat) && words.every(w => (li.textContent + " " + li.dataset.cat).toLowerCase().includes(w));
      if (ok) {
        li.style.setProperty("--i", String(shown));
        if (li.hidden) { li.hidden = false; li.classList.add("out"); raf(() => raf(() => li.classList.remove("out"))); }
        else li.classList.remove("out");
        shown++;
      } else if (!li.hidden) {
        li.classList.add("out");
        setTimeout(() => { if (li.classList.contains("out")) li.hidden = true; }, reduce.matches ? 0 : 190);
      }
    }
    result.textContent = shown === items.length ? `Showing all ${items.length} features` : `Showing ${shown} of ${items.length} features`;
    empty.hidden = shown !== 0;
  }
  cats.forEach(b => b.addEventListener("click", () => {
    cat = b.dataset.cat;
    cats.forEach(c => { const on = c === b; c.classList.toggle("on", on); c.setAttribute("aria-pressed", String(on)); });
    filter();
  }));
  let typing = 0;
  featQ.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { query = featQ.value; filter(); }, 90); });
  grid.classList.toggle("in", !seen); // without IntersectionObserver the entrance runs at once

  // ---- accordions ----
  for (const b of $$(".acc > h3 > button")) b.addEventListener("click", () => {
    const open = b.getAttribute("aria-expanded") !== "true";
    b.setAttribute("aria-expanded", String(open));
    b.closest(".acc").classList.toggle("open", open);
  });

  // ---- copy the support address ----
  const copyMail = $("#copy-mail");
  copyMail.addEventListener("click", async () => {
    const ok = await copy(copyMail.dataset.mail);
    toast(ok ? "Email address copied" : "Select the address and copy it");
    if (ok) { const s = $("span", copyMail); s.textContent = "Copied"; setTimeout(() => { s.textContent = "Copy"; }, 1800); }
  });

  // ---- downloads: the visitor's system, and the latest release ----
  const REPO = "mrmx485-sudo/alcove";
  const API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const PREFIX = `https://github.com/${REPO}/releases/`;
  const FILES = { win: /^Alcove-Setup-.+-x64\.exe$/, "mac-arm64": /-mac-arm64\.dmg$/, "mac-x64": /-mac-x64\.dmg$/ };
  const LABEL = { win: "Download Alcove for Windows", "mac-arm64": "Download Alcove for Apple silicon", "mac-x64": "Download Alcove for Intel" };
  const mobile = /Android|iPhone|iPad|iPod/i.test(nav.userAgent) || (isMac && nav.maxTouchPoints > 1); // an iPad reports "MacIntel"
  const os = mobile ? "mobile" : /Win/i.test(platform) ? "win" : isMac ? "mac" : "other";
  html.dataset.os = os;
  const heroBtn = $("#dl-hero"), heroText = $("span", heroBtn);
  let arch = "", release = null; // arch: "arm" or "x86" where the browser says (Chrome and Edge do; Safari and Firefox do not)

  function markDownloads() {
    for (const card of $$(".dl-card")) {
      const f = card.dataset.file;
      const yes = (os === "win" && f === "win") || (os === "mac" && (arch === "arm" ? f === "mac-arm64" : arch === "x86" ? f === "mac-x64" : f.startsWith("mac")));
      card.classList.toggle("pick", yes);
      $(".badge", card).hidden = !yes;
    }
    const note = $("[data-mobile]");
    if (note) note.hidden = os !== "mobile";
  }
  const want = () => os === "win" ? "win" : os === "mac" && arch === "arm" ? "mac-arm64" : os === "mac" && arch === "x86" ? "mac-x64" : "";
  function paintHero() {
    const f = want(), asset = release && f && release.files[f];
    heroText.textContent = asset ? LABEL[f] : os === "mac" ? "Download for Mac" : os === "win" ? "Download for Windows" : os === "mobile" ? "Get Alcove for your computer" : "Download";
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
    if (!res.ok) return null; // 404: nothing published yet
    const j = await res.json();
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
    for (const card of $$(".dl-card")) {
      const a = files[card.dataset.file];
      if (!a) continue;
      $("a.btn", card).setAttribute("href", a.url);
      $("[data-meta]", card).textContent = `Version ${version} · ${mb(a.size)}`;
    }
    const line = $("[data-release-line]");
    if (line) line.textContent = `Version ${version}. Installers for Mac (Apple silicon and Intel) and Windows (64-bit).`;
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
