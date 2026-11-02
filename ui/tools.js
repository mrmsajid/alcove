// Tools engine. The Tools page (tools.html) is where people use these tools; this part has to live in the
// sidebar because it is always running: it keeps the timers ticking, tracks time on sites, enforces auto
// refresh and focus mode, and owns the saved state. The page sends it commands ("tools-op") and reads the
// saved state back, so there is a single writer. Everything stays on this device.
// Runs after app.js and uses its helpers ($, read, write, call, toast, space, activeTab, findTab, hostOf, …).
(() => {
  const { KEY, TIME_KEY, CTX_KEY, POMO, loadState, today, clock, swMs, timerLeft, pomoLeft, amazonInfo, cleanLink } = ToolsShared;

  const st = loadState();
  const save = () => write(KEY, st);
  const now = () => Date.now();

  const notify = (title, body) => {
    call("notify", { title, body });
    toast(body ? `${title}: ${body}` : title, 6000);
  };

  // ---- timers ----

  function startPomo(phase, min) {
    st.pomo = { phase, end: now() + min * 60000, left: 0, total: min * 60000 };
    save();
  }
  function pomoFinished() {
    if (st.pomo.phase === "work") {
      if (st.pomoDone.date !== today()) st.pomoDone = { date: today(), n: 0 };
      st.pomoDone.n++;
      const long = st.pomoDone.n % 4 === 0;
      notify("Focus session done", `Take a ${long ? POMO.long : POMO.short} minute break`);
      startPomo("break", long ? POMO.long : POMO.short);
    } else {
      notify("Break over", "Ready for the next session?");
      st.pomo = { phase: "", end: 0, left: 0, total: 0 };
      save();
    }
  }

  function chipText() {
    if (st.pomo.phase && st.pomo.end) return clock(pomoLeft(st));
    if (st.timer.end) return clock(timerLeft(st));
    if (st.sw.start) return clock(swMs(st));
    if (st.task) return clock(now() - st.task.start);
    if (st.focusUntil) return clock(st.focusUntil - now());
    return "";
  }
  function updateChip() {
    const t = chipText();
    $("open-tools").classList.toggle("running", !!t);
    $("tools-chip").textContent = t;
  }

  function tick() {
    const t = now();
    if (st.timer.end && t >= st.timer.end) {
      st.timer = { end: 0, left: 0, total: 0 };
      save();
      notify("Timer finished");
    }
    if (st.pomo.end && t >= st.pomo.end) pomoFinished();
    if (st.focusUntil && t >= st.focusUntil) {
      st.focusUntil = 0;
      save();
      notify("Focus mode ended", "Blocked sites are open again");
    }
    updateChip();
    publishCtx();
  }
  setInterval(tick, 1000);

  // ---- context for the Tools page: which space and tab the sidebar is on ----

  let lastCtx = "";
  function publishCtx() {
    const tab = activeTab();
    const ctx = {
      space: { id: space().id, name: space().name },
      tab: tab ? { id: tab.id, url: tab.url, title: tab.title, opened: opened.has(tab.id) } : null,
      refreshers: [...refreshers].filter(([id]) => findTab(id)).map(([id, r]) => ({ id, ms: r.ms, title: findTab(id).title || hostOf(findTab(id).url) })),
    };
    const s = JSON.stringify(ctx);
    if (s !== lastCtx) { lastCtx = s; try { localStorage.setItem(CTX_KEY, s); } catch {} }
  }

  // ---- time tracking ----

  const loadTime = () => read(TIME_KEY, { days: {} });
  let lastTrack = now();
  // Every few seconds, credit the time to the active site and space, but only while Alcove is the focused
  // window and the machine isn't idle. Data never leaves this device.
  async function trackTick() {
    const t = now();
    const dt = Math.min((t - lastTrack) / 1000, 15);
    lastTrack = t;
    if (st.trackPaused) return;
    const a = await call("activity");
    if (!a || !a.focused || a.idle > 120) return;
    const tab = activeTab();
    if (!tab || !/^https?:/.test(tab.url)) return;
    const data = loadTime();
    const day = (data.days[today()] ||= { sites: {}, spaces: {} });
    const host = hostOf(tab.url);
    day.sites[host] = (day.sites[host] || 0) + dt;
    day.spaces[space().name] = (day.spaces[space().name] || 0) + dt;
    for (const k of Object.keys(data.days).sort().slice(0, -35)) delete data.days[k];
    write(TIME_KEY, data);
  }
  setInterval(trackTick, 5000);

  // ---- auto-refresh ----

  const refreshers = new Map(); // tab id -> { ms, timer }
  function setRefresh(id, ms) {
    clearInterval(refreshers.get(id)?.timer);
    refreshers.delete(id);
    if (ms) {
      const timer = setInterval(() => {
        if (!findTab(id)) { clearInterval(timer); refreshers.delete(id); }
        else if (opened.has(id)) invoke("nav_action", { id, action: "reload" }).catch(() => {});
      }, ms);
      refreshers.set(id, { ms, timer });
    }
    publishCtx();
  }

  // ---- commands from the Tools page ----

  function stopTask() {
    if (!st.task) return;
    const sec = Math.round((now() - st.task.start) / 1000);
    const log = (st.log[today()] ||= []);
    const same = log.find(x => x.name === st.task.name);
    if (same) same.sec += sec; else log.push({ name: st.task.name, sec });
    st.task = null;
    for (const k of Object.keys(st.log).sort().slice(0, -35)) delete st.log[k];
  }
  const startFocus = m => call("focus_mode", { minutes: m, sites: st.focusSites }).then(r => {
    if (!r) return toast("Couldn't start focus mode");
    st.focusUntil = r.until;
    save();
    updateChip();
    return r;
  });
  const endFocus = () => { call("focus_mode", { minutes: 0 }); st.focusUntil = 0; save(); updateChip(); };

  const ops = {
    "sw-start": () => { st.sw = { start: now(), acc: st.sw.acc }; },
    "sw-pause": () => { st.sw = { start: 0, acc: swMs(st) }; },
    "sw-reset": () => { st.sw = { start: 0, acc: 0 }; },
    "timer-start": m => { st.timer = { end: now() + m * 60000, left: 0, total: m * 60000 }; },
    "timer-pause": () => { st.timer = { end: 0, left: timerLeft(st), total: st.timer.total }; },
    "timer-resume": () => { st.timer = { end: now() + st.timer.left, left: 0, total: st.timer.total }; },
    "timer-cancel": () => { st.timer = { end: 0, left: 0, total: 0 }; },
    "pomo-start": () => { if (!st.pomo.phase) startPomo("work", POMO.work); },
    "pomo-pause": () => { st.pomo = { ...st.pomo, end: 0, left: pomoLeft(st) }; },
    "pomo-resume": () => { st.pomo = { ...st.pomo, end: now() + st.pomo.left, left: 0 }; },
    "pomo-skip": () => {
      if (st.pomo.phase === "work") startPomo("break", POMO.short); // skipping doesn't count as a finished session
      else st.pomo = { phase: "", end: 0, left: 0, total: 0 };
    },
    "pomo-stop": () => { st.pomo = { phase: "", end: 0, left: 0, total: 0 }; },
    "focus-start": m => startFocus(m),
    "focus-end": () => endFocus(),
    "focus-sites": list => { st.focusSites = (Array.isArray(list) ? list : []).map(String).slice(0, 100); },
    "track-toggle": () => { st.trackPaused = !st.trackPaused; lastTrack = now(); },
    "track-clear-today": () => { const d = loadTime(); delete d.days[today()]; write(TIME_KEY, d); },
    "task-start": name => { stopTask(); st.task = { name: String(name).slice(0, 80), start: now() }; },
    "task-stop": () => stopTask(),
    "task-clear-log": () => { st.log[today()] = []; },
    zones: list => { st.zones = (Array.isArray(list) ? list : []).filter(z => Array.isArray(z) && z.length === 2).slice(0, 30); },
    refresh: (id, ms) => setRefresh(String(id), Number(ms) || 0),
    "open-url": url => { if (/^https?:\/\//i.test(String(url))) openUrl(String(url), true); },
    "new-tab": url => { if (/^(https?:|file:)/i.test(String(url))) newTab(String(url)); },
  };
  listen("tools-op", ({ payload }) => {
    const fn = ops[payload.op];
    if (!fn) return;
    fn(...(payload.args || []));
    save();
    updateChip();
    publishCtx();
  });

  $("open-tools").addEventListener("click", () => call("toggle_tools"));
  call("focus_state").then(f => { // the main process is the source of truth for focus mode
    st.focusUntil = f ? f.until : 0;
    save();
    updateChip();
  });
  updateChip();
  publishCtx();

  // Commands from ⌘K and the menu
  window.Tools = {
    pomodoro: () => { if (!st.pomo.phase) { startPomo("work", POMO.work); updateChip(); toast(`Pomodoro started: ${POMO.work} min`); } else toast("A Pomodoro is already running"); },
    focus: (m = 25) => startFocus(m).then(r => { if (r) toast(`Focus mode on for ${m} min`); }),
    stopFocus: () => { endFocus(); toast("Focus mode ended"); },
    colorPicker: () => { const t = activeTab(); if (!t || !opened.has(t.id)) return toast("Open a page first"); call("eyedropper", { id: t.id }); }, // the app shows the toasts
    images: async () => { const t = activeTab(); if (!t || !opened.has(t.id)) return toast("Open a page first"); toast("Saving images…", 4000); const r = await call("save_images", { id: t.id }); toast(!r || !r.total ? "No large images found on this page" : `Saved ${r.saved} of ${r.total} images to Downloads/Alcove images`, 4000); },
    asin: () => { const t = activeTab(); const a = t && amazonInfo(t.url); if (a) call("copy_text", { text: a.asin }).then(() => toast(`ASIN ${a.asin} copied`)); else toast("This isn't an Amazon product page"); },
    cleanLink: () => { const t = activeTab(); if (t) call("copy_text", { text: cleanLink(t.url) }).then(() => toast("Clean link copied")); },
    markdown: async (what = "new") => {
      const url = await call("md_url");
      if (url) newTab(what === "open" ? `${url}#open` : what === "folder" ? `${url}#folder` : url);
    },
  };
})();
