// Tools engine. The Tools page (tools.html) is where people use these tools; this part has to live in the
// sidebar because it is always running: it keeps the timers ticking, tracks time on sites, enforces auto
// refresh and focus mode, and owns the saved state. The page sends it commands ("tools-op") and reads the
// saved state back, so there is a single writer. Everything stays on this device.
// Runs after app.js and uses its helpers ($, read, write, call, toast, space, activeTab, findTab, hostOf, …).
(() => {
  const { KEY, TIME_KEY, CTX_KEY, pomoMins, repeatKind, alarmDue, loadState, today, pad, clock, swMs, timerLeft, pomoLeft, amazonInfo, cleanLink } = ToolsShared;

  const st = loadState();
  const save = () => write(KEY, st);
  const now = () => Date.now();

  // ---- sound: short synthesized chimes, nothing to download ----

  let audioCtx = null, ringTimer = 0, ringStop = 0;
  function tone(freq, t0, dur, vol) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
  function chime(kind) {
    if (!st.sound) return;
    try {
      audioCtx ||= new AudioContext();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t = audioCtx.currentTime + 0.02;
      const seq = kind === "alarm" ? [[880, 0], [1175, .16], [1480, .32], [1175, .48], [880, .64], [1175, .8]]
        : kind === "pomo" ? [[660, 0], [880, .22], [1100, .44]] : [[988, 0], [988, .24], [988, .48]];
      for (const [f, d] of seq) tone(f, t + d, kind === "alarm" ? 0.22 : 0.3, kind === "alarm" ? 0.35 : 0.28);
    } catch {}
  }
  const stopRinging = () => { clearInterval(ringTimer); clearTimeout(ringStop); };
  function startRinging() {
    stopRinging();
    chime("alarm");
    ringTimer = setInterval(() => chime("alarm"), 1800);
    ringStop = setTimeout(stopRinging, 60000); // an alarm nobody answers goes quiet after a minute
  }

  const notify = (title, body, kind = "timer") => {
    call("notify", { title, body });
    toast(body ? `${title}: ${body}` : title, 6000);
    chime(kind);
  };

  // ---- alarms ----

  // An alarm rings when its time comes, and if the machine was asleep or the app busy at that moment it still rings when it can,
  // up to ten minutes late (today's and yesterday's time are both looked at, for one that came due just before midnight). One that
  // was set after its time today, or switched back on, doesn't ring for a moment that had already passed.
  const CATCH_UP_MS = 10 * 60000;
  const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function checkAlarms() {
    const t = now(), d = new Date(t);
    for (const a of st.alarms) {
      if (!a.on) continue;
      const [h, m] = String(a.time).split(":").map(Number);
      let hit = null;
      for (const off of [0, -1]) {
        const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + off);
        const due = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime(); // a time that doesn't exist (spring forward) lands an hour later
        const stamp = `${dayKey(day)} ${a.time}`;
        if (t < due || t - due > CATCH_UP_MS || a.last === stamp || due < (a.made || 0) || !alarmDue(a, day)) continue;
        hit = stamp;
        break;
      }
      if (!hit) continue;
      a.last = hit;
      if (repeatKind(a) === "once") a.on = false; // a one-off alarm switches itself off
      st.ringing = { id: a.id, label: a.label || "Alarm", time: a.time, at: now() };
      if (a.snooze) st.alarms = st.alarms.filter(x => x !== a);
      save();
      call("notify", { title: a.label || "Alarm", body: `It's ${a.time}` });
      startRinging();
      call("open_tools", { tab: "alarms" }); // an alarm should be hard to miss
      break;
    }
  }
  const newId = () => Math.random().toString(36).slice(2, 9);
  const cleanTime = t => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(t)) ? String(t) : null);

  // ---- timers ----

  function startPomo(phase, min) {
    st.pomo = { phase, end: now() + min * 60000, left: 0, total: min * 60000 };
    save();
  }
  function pomoFinished() {
    const m = pomoMins(st);
    if (st.pomo.phase === "work") {
      if (st.pomoDone.date !== today()) st.pomoDone = { date: today(), n: 0 };
      st.pomoDone.n++;
      const long = st.pomoDone.n % 4 === 0;
      notify("Focus session done", `Take a ${long ? m.long : m.short} minute break`, "pomo");
      startPomo("break", long ? m.long : m.short);
    } else {
      notify("Break over", "Ready for the next session?", "pomo");
      st.pomo = { phase: "", end: 0, left: 0, total: 0 };
      save();
    }
  }

  function chipText() {
    if (st.ringing) return "Alarm";
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
    $("open-tools").classList.toggle("ringing", !!st.ringing);
    $("tools-chip").textContent = t;
  }

  function tick() {
    const t = now();
    if (st.timer.end && t >= st.timer.end) {
      st.timer = { end: 0, left: 0, total: 0 };
      save();
      notify("Timer finished");
    }
    if (st.pomo.end && t >= st.pomo.end) {
      if (t - st.pomo.end > 2 * 60000) { // it ended long ago (the machine was asleep): not counted, no break started from now
        st.pomo = { phase: "", end: 0, left: 0, total: 0 };
        save();
        notify("Pomodoro ended", "It finished while the computer was asleep");
      } else pomoFinished();
    }
    if (st.focusUntil && t >= st.focusUntil) {
      st.focusUntil = 0;
      save();
      notify("Focus mode ended", "Blocked sites are open again", "pomo");
    }
    checkAlarms();
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
    // Each calendar day gets its own share of a task that ran across midnight.
    for (let from = st.task.start, to = now(); from < to;) {
      const d = new Date(from), end = Math.min(to, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
      const log = (st.log[dayKey(d)] ||= []);
      const same = log.find(x => x.name === st.task.name), sec = Math.round((end - from) / 1000);
      if (same) same.sec += sec; else log.push({ name: st.task.name, sec });
      from = end;
    }
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
    "sw-start": () => { st.sw = { ...st.sw, start: now() }; },
    "sw-pause": () => { st.sw = { ...st.sw, start: 0, acc: swMs(st) }; },
    "sw-reset": () => { st.sw = { start: 0, acc: 0, laps: [] }; },
    "sw-lap": () => { if (st.sw.start) st.sw = { ...st.sw, laps: [...(st.sw.laps || []), swMs(st)].slice(-200) }; },
    "timer-start": m => { st.timer = { end: now() + m * 60000, left: 0, total: m * 60000 }; },
    "timer-add": m => {
      const ms = Math.max(1, Math.min(600, Number(m) || 1)) * 60000;
      if (st.timer.end) st.timer = { ...st.timer, end: st.timer.end + ms, total: st.timer.total + ms };
      else if (st.timer.left) st.timer = { ...st.timer, left: st.timer.left + ms, total: st.timer.total + ms };
    },
    "timer-pause": () => { st.timer = { end: 0, left: timerLeft(st), total: st.timer.total }; },
    "timer-resume": () => { st.timer = { end: now() + st.timer.left, left: 0, total: st.timer.total }; },
    "timer-cancel": () => { st.timer = { end: 0, left: 0, total: 0 }; },
    "pomo-start": () => { if (!st.pomo.phase) startPomo("work", pomoMins(st).work); },
    "pomo-cfg": c => {
      const n = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || d));
      st.pomoCfg = { work: n(c && c.work, 1, 180, 25), short: n(c && c.short, 1, 60, 5), long: n(c && c.long, 1, 90, 15) };
    },
    "alarm-add": a => {
      const time = cleanTime(a && a.time);
      if (!time) return;
      const repeat = ["once", "daily", "weekly", "monthly"].includes(a.repeat) ? a.repeat : "once";
      let days = [...new Set((Array.isArray(a.days) ? a.days : []).map(Number).filter(d => d >= 0 && d <= 6))];
      if (repeat !== "weekly") days = [];
      else if (!days.length) days = [new Date().getDay()];
      const dom = repeat === "monthly" ? (a.dom === "last" ? "last" : Math.min(31, Math.max(1, Math.round(Number(a.dom)) || new Date().getDate()))) : null;
      if (st.alarms.length >= 50) st.alarms = st.alarms.filter(x => x.on || repeatKind(x) !== "once"); // one-offs that already rang make room
      if (st.alarms.length >= 50) return toast("You have 50 alarms: delete one to add another");
      st.alarms = [...st.alarms, { id: newId(), time, label: String((a && a.label) || "").slice(0, 60), repeat, days, dom, on: true, last: "", made: now() }];
    },
    "alarm-toggle": id => { const a = st.alarms.find(x => x.id === id); if (a) { a.on = !a.on; a.last = ""; if (a.on) a.made = now(); } },
    "alarm-delete": id => { st.alarms = st.alarms.filter(x => x.id !== id); },
    "alarm-dismiss": () => { st.ringing = null; stopRinging(); },
    "alarm-snooze": m => {
      const r = st.ringing;
      st.ringing = null;
      stopRinging();
      if (!r) return;
      const d = new Date(now() + (Number(m) || 5) * 60000);
      st.alarms = [...st.alarms, { id: newId(), time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, label: r.label, repeat: "once", days: [], on: true, last: "", snooze: true, made: now() }];
    },
    "sound-toggle": () => { st.sound = !st.sound; },
    "sound-test": () => chime("alarm"),
    "pomo-pause": () => { st.pomo = { ...st.pomo, end: 0, left: pomoLeft(st) }; },
    "pomo-resume": () => { st.pomo = { ...st.pomo, end: now() + st.pomo.left, left: 0 }; },
    "pomo-skip": () => {
      if (st.pomo.phase === "work") startPomo("break", pomoMins(st).short); // skipping doesn't count as a finished session
      else st.pomo = { phase: "", end: 0, left: 0, total: 0 };
    },
    "pomo-stop": () => { st.pomo = { phase: "", end: 0, left: 0, total: 0 }; },
    "focus-start": m => startFocus(m),
    "focus-end": () => endFocus(),
    "focus-sites": list => { st.focusSites = (Array.isArray(list) ? list : []).map(String).slice(0, 100); },
    "track-toggle": () => { st.trackPaused = !st.trackPaused; lastTrack = now(); },
    "track-clear-today": () => { const d = loadTime(); delete d.days[today()]; write(TIME_KEY, d); },
    "track-restore-today": day => { // takes "Clear today" back
      if (!day || typeof day !== "object") return;
      const clean = o => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).slice(0, 500).map(([k, v]) => [String(k).slice(0, 200), Math.max(0, Number(v) || 0)]));
      const d = loadTime(), cur = d.days[today()] || { sites: {}, spaces: {} };
      for (const key of ["sites", "spaces"]) { // time tracked since the clear stays; what was cleared is added back
        const back = clean(day[key]);
        for (const [k, v] of Object.entries(cur[key] || {})) back[k] = (back[k] || 0) + v;
        cur[key] = back;
      }
      d.days[today()] = cur;
      write(TIME_KEY, d);
    },
    "task-start": name => { stopTask(); st.task = { name: String(name).slice(0, 80), start: now() }; },
    "task-stop": () => stopTask(),
    "task-clear-log": () => { st.log[today()] = []; },
    "task-restore-log": list => { // takes "Clear" back; tasks logged since stay
      const back = (Array.isArray(list) ? list : []).slice(0, 200).map(x => ({ name: String(x && x.name).slice(0, 80), sec: Math.max(0, Number(x && x.sec) || 0) }));
      const cur = st.log[today()] || [];
      for (const c of cur) { const same = back.find(x => x.name === c.name); if (same) same.sec += c.sec; else back.push(c); }
      st.log[today()] = back;
    },
    zones: list => {
      const ok = (Array.isArray(list) ? list : []).filter(z => Array.isArray(z) && z.length === 2);
      if (ok.length > 30) toast("You can keep up to 30 places");
      st.zones = ok.slice(0, 30);
    },
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
    pomodoro: () => { if (!st.pomo.phase) { const w = pomoMins(st).work; startPomo("work", w); updateChip(); toast(`Pomodoro started: ${w} min`); } else toast("A Pomodoro is already running"); },
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
