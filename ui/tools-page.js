// The Tools page: timers, time tracking, world clock, notes, Markdown files and page helpers.
// The sidebar runs the engine (tools.js). This page shows its saved state and sends it commands, so the
// timers keep going while this page is closed.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { KEY, TIME_KEY, NOTES_KEY, CTX_KEY, POMO, pomoMins, repeatKind, alarmDue, read, loadState, today, clock, clockMs, human, swMs, timerLeft, pomoLeft,
  validZone, zoneInfo, KEEPA, amazonInfo, cleanLink } = ToolsShared;

let st = loadState();
let ctx = read(CTX_KEY, { space: { id: "", name: "" }, tab: null, refreshers: [] });
const TAB_KEY = "alcove-tools-tab";
const TABS = [["timers", "Timers"], ["alarms", "Alarms"], ["track", "Track"], ["clocks", "Clocks"], ["notes", "Notes"], ["markdown", "Markdown"], ["page", "Page"]];
let view = (location.hash.slice(1) || read(TAB_KEY, "timers"));
if (!TABS.some(t => t[0] === view)) view = "timers";

const $ = id => document.getElementById(id);
const op = (name, ...args) => invoke("tools_op", { op: name, args }).catch(() => {});
const call = (cmd, args) => invoke(cmd, args).catch(() => null);

let toastTimer;
function toast(msg, ms = 2200, undo = null) { // undo: a function that takes the action back, offered as a button
  const t = $("toast");
  t.textContent = msg;
  if (undo) {
    const b = el("button", { type: "button", on: { click: () => { t.hidden = true; clearTimeout(toastTimer); undo(); } } }, "Undo");
    t.append(" ", b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const copy = (text, msg) => call("copy_text", { text }).then(() => toast(msg || "Copied"));

const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  e.append(...kids.flat().filter(k => k !== null && k !== undefined && k !== false));
  return e;
};
const btn = (label, fn, kind = "") => el("button", { class: `t-btn ${kind}`.trim(), on: { click: fn } }, label);
const card = (title, ...kids) => el("div", { class: "t-card" }, el("div", { class: "t-title" }, title), ...kids);
const note = text => el("div", { class: "t-note" }, text);

let fast = []; // numbers that refresh every frame (the stopwatch's milliseconds)
let live = []; // numbers that refresh every second without rebuilding the page
const liveText = (cls, fn) => {
  const e = el("div", { class: cls });
  const update = () => { e.textContent = fn(); };
  update();
  live.push(update);
  return e;
};
const minutesForm = (label, fn) => {
  const input = el("input", { type: "number", min: "1", max: "600", placeholder: "min", class: "t-min" });
  return el("form", { class: "t-row", on: { submit: e => { e.preventDefault(); const v = Number(input.value); if (v > 0 && v <= 600) fn(v); } } },
    input, el("button", { class: "t-btn", type: "submit" }, label));
};
const chips = (mins, fn) => el("div", { class: "t-chips" }, ...mins.map(m => el("button", { class: "t-chip", on: { click: () => fn(m) } }, `${m} min`)));

// ---- timers: a stopwatch dial, ring timers, alarms ----

const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};
const polar = (cx, cy, r, deg) => [cx + Math.sin(deg * Math.PI / 180) * r, cy - Math.cos(deg * Math.PI / 180) * r];

function stopwatchCard() {
  const running = !!st.sw.start, has = swMs(st) > 0, laps = st.sw.laps || [];
  // the face: a case with a crown and a side button, 60 ticks, a small 30-minute dial, a sweeping red hand
  const dial = svg("svg", { viewBox: "0 0 240 270", class: "dial" });
  dial.append(
    svg("rect", { x: 110, y: 2, width: 20, height: 14, rx: 3, class: "dial-btn" }),
    svg("rect", { x: 114, y: 14, width: 12, height: 12, class: "dial-btn" }),
    svg("rect", { x: 186, y: 40, width: 14, height: 22, rx: 3, class: "dial-btn", transform: "rotate(42 193 51)" }),
    svg("circle", { cx: 120, cy: 150, r: 112, class: "dial-case" }),
    svg("circle", { cx: 120, cy: 150, r: 102, class: "dial-face" }));
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0, [x1, y1] = polar(120, 150, 98, i * 6), [x2, y2] = polar(120, 150, major ? 86 : 92, i * 6);
    dial.append(svg("line", { x1, y1, x2, y2, class: major ? "tick major" : "tick" }));
    if (major) { const [tx, ty] = polar(120, 150, 73, i * 6); dial.append(svg("text", { x: tx, y: ty + 3.5, class: "dial-num" }, String(i || 60))); }
  }
  dial.append(svg("circle", { cx: 120, cy: 112, r: 22, class: "sub-ring" }));
  for (let i = 0; i < 30; i++) { const [x1, y1] = polar(120, 112, 21, i * 12), [x2, y2] = polar(120, 112, i % 5 === 0 ? 16 : 18.5, i * 12); dial.append(svg("line", { x1, y1, x2, y2, class: "tick" })); }
  const read = svg("text", { x: 120, y: 196, class: "dial-read" });
  const minHand = svg("g", {}, svg("line", { x1: 120, y1: 112, x2: 120, y2: 96, class: "hand-min" }));
  const secHand = svg("g", {}, svg("line", { x1: 120, y1: 166, x2: 120, y2: 60, class: "hand-sec" }), svg("circle", { cx: 120, cy: 150, r: 5.5, class: "hand-hub" }), svg("circle", { cx: 120, cy: 150, r: 2, class: "dial-face" }));
  dial.append(read, minHand, secHand, svg("circle", { cx: 120, cy: 112, r: 2, class: "hand-hub" }));
  const update = () => {
    const ms = swMs(st);
    secHand.setAttribute("transform", `rotate(${(ms % 60000) / 1000 * 6} 120 150)`);
    minHand.setAttribute("transform", `rotate(${(ms / 60000 % 30) * 12} 120 112)`);
    read.textContent = clockMs(ms);
  };
  update();
  fast.push(update);

  const splits = laps.map((t, i) => t - (i ? laps[i - 1] : 0));
  const best = splits.length > 2 ? Math.min(...splits) : -1, worst = splits.length > 2 ? Math.max(...splits) : -1;
  return el("div", { class: "t-card dialcard" }, el("div", { class: "t-title" }, "Stopwatch"), dial,
    el("div", { class: "t-btns" },
      running ? btn("Stop", () => op("sw-pause"), "primary") : btn(has ? "Resume" : "Start", () => op("sw-start"), "primary"),
      running ? btn("Lap", () => op("sw-lap")) : has ? btn("Reset", () => op("sw-reset")) : null),
    laps.length ? el("div", { class: "laps" }, ...laps.map((t, i) => [t, i]).reverse().map(([t, i]) =>
      el("div", { class: "lap" + (splits[i] === best ? " best" : splits[i] === worst ? " worst" : "") },
        el("span", {}, `Lap ${i + 1}`), el("span", {}, "+" + clockMs(splits[i])), el("span", { class: "d" }, clockMs(t))))) : null);
}

// A ring that empties as time runs out; the centre shows the time left
function ring(cls, fracFn, timeFn, subFn) {
  const C = 2 * Math.PI * 94;
  const prog = svg("circle", { cx: 110, cy: 110, r: 94, class: "ring-prog", transform: "rotate(-90 110 110)", "stroke-dasharray": C });
  const time = svg("text", { x: 110, y: 118, class: "ring-time" }), sub = svg("text", { x: 110, y: 146, class: "ring-sub" });
  const box = svg("svg", { viewBox: "0 0 220 220", class: "ring " + cls }, svg("circle", { cx: 110, cy: 110, r: 94, class: "ring-track" }), prog, time, sub);
  const update = () => {
    prog.setAttribute("stroke-dashoffset", C * (1 - Math.min(1, Math.max(0, fracFn()))));
    time.textContent = timeFn();
    sub.textContent = subFn();
  };
  update();
  fast.push(update);
  return box;
}

function timerCard() {
  const running = !!st.timer.end, paused = !running && st.timer.left > 0, active = running || paused;
  const total = st.timer.total;
  return el("div", { class: "t-card dialcard" }, el("div", { class: "t-title" }, "Timer"),
    ring("timer" + (active ? "" : " idle"), () => (active && total ? timerLeft(st) / total : 1), () => clock(active ? timerLeft(st) : 0), () => (active ? `of ${clock(total)}${paused ? " · paused" : ""}` : "Pick a time")),
    active
      ? el("div", { class: "t-btns" },
        running ? btn("Pause", () => op("timer-pause"), "primary") : btn("Resume", () => op("timer-resume"), "primary"),
        btn("+1 min", () => op("timer-add", 1)), btn("Cancel", () => op("timer-cancel")))
      : [chips([1, 5, 10, 15, 25, 45], m => op("timer-start", m)), minutesForm("Start", m => op("timer-start", m))]);
}

function pomodoroCard() {
  const p = st.pomo, running = !!p.end, paused = !running && p.left > 0, m = pomoMins(st);
  const done = st.pomoDone.date === today() ? st.pomoDone.n : 0, inCycle = done % 4;
  const phase = p.phase === "work" ? "focus" : p.phase === "break" ? "break" : "idle";
  const cfg = (key, label) => el("label", { class: "cfg" }, label, el("input", { type: "number", min: "1", max: "180", value: String(m[key]), on: { change: e => op("pomo-cfg", { ...m, [key]: Number(e.target.value) }) } }));
  return el("div", { class: "t-card dialcard" }, el("div", { class: "t-title" }, "Pomodoro"),
    ring("pomo " + phase, () => (p.phase && p.total ? pomoLeft(st) / p.total : 1), () => clock(p.phase ? pomoLeft(st) : m.work * 60000),
      () => (p.phase === "work" ? "Focus" : p.phase === "break" ? (done % 4 === 0 && done ? "Long break" : "Break") : "Ready") + (paused ? " · paused" : "")),
    el("div", { class: "pips", title: "Focus sessions in this round of four" },
      ...[0, 1, 2, 3].map(i => el("i", { class: "pip" + (i < inCycle ? " done" : i === inCycle && p.phase === "work" ? " now" : "") }))),
    el("div", { class: "t-btns" },
      !p.phase ? btn(`Start ${m.work} min`, () => op("pomo-start"), "primary")
        : [running ? btn("Pause", () => op("pomo-pause"), "primary") : btn("Resume", () => op("pomo-resume"), "primary"),
          btn("Skip", () => op("pomo-skip")), btn("Stop", () => op("pomo-stop"))]),
    note(`${done} focus ${done === 1 ? "session" : "sessions"} today`),
    el("div", { class: "cfgs" }, cfg("work", "Focus"), cfg("short", "Break"), cfg("long", "Long break")));
}

// Focus mode: the app refuses page loads for these sites until it ends.
function focusCard() {
  const on = st.focusUntil > Date.now();
  const sites = el("textarea", { rows: "3", spellcheck: "false", placeholder: "youtube.com, reddit.com, …", on: { change: e => {
    op("focus-sites", e.target.value.split(/[\s,]+/)
      .map(s => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, ""))
      .filter(Boolean));
  } } }, st.focusSites.join(", "));
  return card("Focus mode",
    on ? [liveText("t-big", () => clock(st.focusUntil - Date.now())),
      note(`Blocking ${st.focusSites.join(", ")}. Tabs that are already open stay as they are until they load a new page.`),
      el("div", { class: "t-btns" }, btn("End focus", () => op("focus-end")))]
      : [note("Blocks these sites for a while so you can concentrate."), sites,
        // the textarea saves on change; give it a beat so the list is saved before the engine reads it
        chips([25, 50, 90], m => { document.activeElement?.blur(); setTimeout(() => op("focus-start", m), 80); })]);
}

const timersView = () => [stopwatchCard(), timerCard(), pomodoroCard(), focusCard()];

// ---- alarms ----

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const byMonday = (x, y) => ((x + 6) % 7) - ((y + 6) % 7);
const ord = n => { const t = ["th", "st", "nd", "rd"], v = n % 100; return n + (t[(v - 20) % 10] || t[v] || t[0]); };
const fmtTime = t => { const [h, m] = t.split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
function weekdays(days) {
  const key = [...days].sort((x, y) => x - y).join();
  return key === "0,1,2,3,4,5,6" ? "every day" : key === "1,2,3,4,5" ? "weekdays" : key === "0,6" ? "weekends" : [...days].sort(byMonday).map(x => DAY_NAMES[x]).join(", ");
}
const domText = dom => (dom === "last" ? "the last day" : `the ${ord(Number(dom) || 1)}`);
function repeatText(a) {
  const k = repeatKind(a);
  if (k === "daily") return "Every day";
  if (k === "monthly") return `Monthly, on ${domText(a.dom)}`;
  if (k === "weekly") { const w = weekdays(a.days || []); return w === "every day" ? "Every day" : w === "weekdays" || w === "weekends" ? w[0].toUpperCase() + w.slice(1) : `Weekly on ${w}`; }
  return "Once";
}
// The next time this alarm rings after `from` (looks up to a year ahead, which a monthly alarm can need)
function nextOccurrence(a, from = new Date()) {
  const [h, m] = a.time.split(":").map(Number);
  for (let off = 0; off < 400; off++) {
    const d = new Date(from);
    d.setDate(d.getDate() + off);
    d.setHours(h, m, 0, 0);
    if (d > from && alarmDue(a, d)) return d;
  }
  return null;
}
const untilText = ms => { const m = Math.max(0, Math.round(ms / 60000)), h = Math.floor(m / 60); return h >= 48 ? `${Math.floor(h / 24)} days` : h ? `${h} h ${m % 60} min` : `${m} min`; };

function ringingCard() {
  const r = st.ringing;
  return el("div", { class: "t-card wide ringing" },
    el("div", { class: "t-title" }, "Alarm"),
    el("div", { class: "ring-name" }, r.label),
    el("div", { class: "t-sub" }, `It's ${fmtTime(r.time)}`),
    el("div", { class: "t-btns" }, btn("Dismiss", () => op("alarm-dismiss"), "primary"), btn("Snooze 5 min", () => op("alarm-snooze", 5)), btn("Snooze 10 min", () => op("alarm-snooze", 10))));
}

function alarmsView() {
  const alarms = [...st.alarms].sort((a, b) => a.time.localeCompare(b.time));
  const next = alarms.filter(a => a.on).map(a => [a, nextOccurrence(a)]).filter(x => x[1]).sort((a, b) => a[1] - b[1])[0];
  const list = alarms.length ? el("div", { class: "alarms" }, ...alarms.map(a => el("div", { class: "alarm" + (a.on ? "" : " off") },
    el("div", { class: "at" }, fmtTime(a.time)),
    el("div", { class: "al" }, el("div", {}, a.label || (a.snooze ? "Snoozed" : "Alarm")), el("div", { class: "t-sub" }, repeatText(a))),
    el("button", { class: "t-switch" + (a.on ? " on" : ""), role: "switch", "aria-checked": a.on ? "true" : "false", "aria-label": `Alarm ${a.time}${a.label ? " " + a.label : ""}`, title: a.on ? "Turn off" : "Turn on", on: { click: () => op("alarm-toggle", a.id) } }),
    el("button", { class: "icon sm", title: "Delete", on: { click: () => op("alarm-delete", a.id) } }, "×")))) : note("No alarms yet. Add one below.");

  // the new-alarm form: pick how it repeats, then the days that go with that
  const nowD = new Date();
  const time = el("input", { type: "time", value: `${String((nowD.getHours() + 1) % 24).padStart(2, "0")}:00`, class: "t-time", on: { input: () => sync() } });
  const label = el("input", { type: "text", placeholder: "Label (optional)", maxlength: "60" });
  let repeat = "once";
  const picked = new Set();
  const kinds = [["once", "Once"], ["daily", "Daily"], ["weekly", "Weekly"], ["monthly", "Monthly"]].map(([k, l]) =>
    el("button", { type: "button", class: "t-chip", on: { click: () => { repeat = k; if (k === "weekly" && !picked.size) picked.add(nowD.getDay()); sync(); } } }, l));
  const dayBtns = [1, 2, 3, 4, 5, 6, 0].map(d => {
    const b = el("button", { type: "button", class: "t-chip", title: DAY_NAMES[d], on: { click: () => { if (picked.has(d)) picked.delete(d); else picked.add(d); sync(); } } }, DAY_NAMES[d].slice(0, 2));
    b.dataset.d = d;
    return b;
  });
  const presets = el("div", { class: "t-chips" },
    el("button", { type: "button", class: "t-chip", on: { click: () => { picked.clear(); [1, 2, 3, 4, 5].forEach(d => picked.add(d)); sync(); } } }, "Weekdays"),
    el("button", { type: "button", class: "t-chip", on: { click: () => { picked.clear(); [0, 6].forEach(d => picked.add(d)); sync(); } } }, "Weekends"));
  const weekly = el("div", { class: "alarm-sec" }, el("div", { class: "t-chips" }, ...dayBtns), presets);
  const domSel = el("select", { class: "t-dom", on: { change: () => sync() } },
    ...Array.from({ length: 31 }, (_, i) => el("option", { value: String(i + 1) }, ord(i + 1))), el("option", { value: "last" }, "Last day"));
  domSel.value = String(nowD.getDate());
  const monthly = el("div", { class: "alarm-sec t-row" }, el("span", { class: "t-sub" }, "On the"), domSel, el("span", { class: "t-sub" }, "of each month"));
  const summary = el("div", { class: "t-note" });
  function sync() {
    kinds.forEach((b, i) => b.classList.toggle("on", ["once", "daily", "weekly", "monthly"][i] === repeat));
    for (const b of dayBtns) b.classList.toggle("on", picked.has(+b.dataset.d));
    weekly.hidden = repeat !== "weekly";
    monthly.hidden = repeat !== "monthly";
    const at = time.value ? fmtTime(time.value) : "…";
    summary.textContent = repeat === "once" ? `Rings once, the next time it's ${at}.`
      : repeat === "daily" ? `Rings every day at ${at}.`
      : repeat === "weekly" ? (picked.size ? `Rings ${(w => (w === "every day" || w === "weekdays" || w === "weekends" ? w : "every " + w))(weekdays(picked))} at ${at}.` : "Pick at least one day.")
      : `Rings on ${domText(domSel.value)} of every month at ${at}${domSel.value === "last" ? "" : Number(domSel.value) > 28 ? ". Shorter months use their last day" : ""}.`;
  }
  const form = el("form", { class: "alarm-form", on: { submit: e => {
    e.preventDefault();
    if (!time.value || (repeat === "weekly" && !picked.size)) return toast("Choose a time and at least one day");
    op("alarm-add", { time: time.value, label: label.value.trim(), repeat, days: [...picked], dom: domSel.value });
    label.value = "";
  } } },
    el("div", { class: "t-row" }, time, label),
    el("div", { class: "t-chips" }, ...kinds), weekly, monthly, summary,
    el("div", { class: "t-btns" }, el("button", { class: "t-btn primary", type: "submit" }, "Add alarm")));
  sync();

  return [
    card("Alarms",
      next ? liveText("t-sub", () => `Next: ${next[1].toDateString() === new Date().toDateString() ? "today" : next[1].toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })} ${fmtTime(next[0].time)} · in ${untilText(next[1] - Date.now())}`) : el("div", { class: "t-sub" }, "Nothing scheduled"),
      list,
      note("Alarms ring while Alcove is open: a chime, a notification, and this page opens.")),
    card("New alarm", form),
    card("Sound",
      el("div", { class: "t-row spaced" }, el("span", {}, "Chime when a timer, Pomodoro or alarm ends"), el("button", { class: "t-switch" + (st.sound ? " on" : ""), role: "switch", "aria-checked": st.sound ? "true" : "false", "aria-label": "Chime", title: st.sound ? "Turn off" : "Turn on", on: { click: () => op("sound-toggle") } })),
      el("div", { class: "t-btns" }, btn("Play test sound", () => op("sound-test")))),
  ];
}

// ---- time tracking ----

function bars(entries, empty) {
  if (!entries.length) return note(empty);
  const max = entries[0][1];
  return el("div", { class: "t-bars" }, ...entries.map(([name, sec]) => el("div", { class: "t-bar" },
    el("span", { class: "fill", style: `width:${Math.max(4, Math.round(100 * sec / max))}%` }),
    el("span", { class: "n" }, name),
    el("span", { class: "v" }, human(sec)))));
}

function trackView() {
  const day = read(TIME_KEY, { days: {} }).days[today()] || { sites: {}, spaces: {} };
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]);
  const total = Object.values(day.sites).reduce((a, b) => a + b, 0);
  const log = st.log[today()] || [];
  const logTotal = log.reduce((a, x) => a + x.sec, 0);

  const input = el("input", { type: "text", placeholder: "What are you working on?", maxlength: "80" });
  const form = el("form", { class: "t-row", on: { submit: e => {
    e.preventDefault();
    if (input.value.trim()) op("task-start", input.value.trim());
  } } }, input, el("button", { class: "t-btn primary", type: "submit" }, "Start"));

  return [
    card("Today in Alcove",
      el("div", { class: "t-big" }, human(total)),
      bars(top(day.sites).slice(0, 10), "Time on each site shows up here as you browse."),
      Object.keys(day.spaces).length > 1 ? [el("div", { class: "t-sub" }, "By space"), bars(top(day.spaces), "")] : null,
      note("Counted while Alcove is in front and you're active. Stored on this device only."),
      el("div", { class: "t-btns" },
        btn(st.trackPaused ? "Resume tracking" : "Pause tracking", () => op("track-toggle")),
        btn("Clear today", () => {
          const before = (read(TIME_KEY, { days: {} }).days || {})[today()];
          op("track-clear-today").then(() => render());
          if (before) toast("Today's tracked time cleared", 7000, () => op("track-restore-today", before).then(() => render()));
        }))),
    card("Task timer",
      st.task ? [el("div", { class: "t-sub" }, st.task.name), liveText("t-big", () => clock(Date.now() - st.task.start)),
        el("div", { class: "t-btns" }, btn("Stop", () => op("task-stop"), "primary"))]
        : form,
      log.length ? [el("div", { class: "t-sub" }, "Today"),
        el("div", { class: "t-bars" }, ...log.map(x => el("div", { class: "t-bar plain" }, el("span", { class: "n" }, x.name), el("span", { class: "v" }, human(x.sec))))),
        el("div", { class: "t-btns" },
          btn("Copy log", () => copy(log.map(x => `${x.name}: ${human(x.sec)}`).concat(`Total: ${human(logTotal)}`).join("\n"), "Task log copied")),
          btn("Clear", () => {
            const before = (st.log[today()] || []).map(x => ({ ...x }));
            op("task-clear-log");
            toast("Task log cleared", 7000, () => op("task-restore-log", before));
          }))] : null),
  ];
}

// ---- world clock ----

const CITY_ALIAS = {
  kolkata: "Asia/Calcutta", bengaluru: "Asia/Calcutta", bangalore: "Asia/Calcutta", mumbai: "Asia/Calcutta", delhi: "Asia/Calcutta",
  kathmandu: "Asia/Katmandu", kyiv: "Europe/Kiev", "ho chi minh": "Asia/Saigon", "ho chi minh city": "Asia/Saigon", yangon: "Asia/Rangoon",
  islamabad: "Asia/Karachi", lahore: "Asia/Karachi", michigan: "America/Detroit", "new york": "America/New_York", "los angeles": "America/Los_Angeles",
};

function clocksView() {
  const row = (tz, label, removable) => {
    const time = el("div", { class: "z-time" }), sub = el("div", { class: "z-sub" }), dot = el("i", { class: "z-dot" });
    const update = () => {
      const z = zoneInfo(tz);
      time.textContent = z.time;
      sub.textContent = `${z.day} · ${z.rel}`;
      dot.classList.toggle("open", z.open);
      dot.title = z.open ? "Working hours (9–6)" : "Outside working hours";
    };
    update();
    live.push(update);
    return el("div", { class: "z-row" }, dot, el("div", { class: "z-main" }, el("div", { class: "z-name" }, label), sub), time,
      removable ? el("button", { class: "icon sm", title: "Remove", on: { click: () => op("zones", st.zones.filter(z => z[0] !== tz)) } }, "×") : null);
  };
  const all = Intl.supportedValuesOf ? Intl.supportedValuesOf("timeZone") : [];
  const input = el("input", { type: "text", list: "tz-list", placeholder: "Add a city, e.g. London or New_York", spellcheck: "false" });
  const list = el("datalist", { id: "tz-list" }, ...all.map(z => el("option", { value: z })));
  const form = el("form", { class: "t-row", on: { submit: e => {
    e.preventDefault();
    const q = input.value.trim().replace(/ /g, "_");
    // Some cities are listed under an older name (Kolkata is Asia/Calcutta, Kyiv is Europe/Kiev) or aren't zones themselves.
    const named = CITY_ALIAS[q.replace(/_/g, " ").toLowerCase()];
    const tz = named || (validZone(q) ? q : all.find(z => z.toLowerCase().endsWith("/" + q.toLowerCase()) || z.toLowerCase() === q.toLowerCase()));
    if (!tz) return toast("Unknown place. Try a city like London or Karachi");
    if (st.zones.some(z => z[0] === tz)) return toast("Already added");
    if (st.zones.length >= 30) return toast("You can keep up to 30 places");
    const label = named ? q.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()) : tz.split("/").pop().replace(/_/g, " ");
    op("zones", [...st.zones, [tz, label]]);
  } } }, input, list, el("button", { class: "t-btn", type: "submit" }, "Add"));
  return [card("World clock",
    el("div", { class: "z-list" }, row(Intl.DateTimeFormat().resolvedOptions().timeZone, "You", false), ...st.zones.map(([tz, label]) => row(tz, label, true))),
    form, note("Green dot: it's 9am–6pm there."))];
}

// ---- to-do list (one per space) ----

const TODO_KEY = "alcove-todos-v1"; // { spaceId: [{ id, text, done, doneOn }] }, written by this page
const DONE_KEY = "alcove-done-v1";  // { "2026-11-02": { todos: n } }: to-dos ticked per day, for the start page's daily report
let refocusTodo = false;
const todosOf = space => read(TODO_KEY, {})[space] || [];
function setTodos(space, list) {
  const all = read(TODO_KEY, {});
  all[space] = list;
  try { localStorage.setItem(TODO_KEY, JSON.stringify(all)); } catch {}
  render();
}

// Ticking counts toward that day; unticking takes the count back off the day it was ticked. Clearing done items keeps it.
function tallyTodo(it, done) {
  const day = done ? today() : it.doneOn;
  if (!day) return;
  const all = read(DONE_KEY, {});
  const d = (all[day] ||= { todos: 0 });
  d.todos = Math.max(0, (d.todos || 0) + (done ? 1 : -1));
  for (const k of Object.keys(all).sort().slice(0, -35)) delete all[k];
  try { localStorage.setItem(DONE_KEY, JSON.stringify(all)); } catch {}
}

function todoCard() {
  const space = ctx.space.id || "default";
  const all = read(TODO_KEY, {});
  const items = all[space] || [];
  const commit = next => {
    all[space] = next;
    try { localStorage.setItem(TODO_KEY, JSON.stringify(all)); } catch {}
    render();
  };
  const input = el("input", { class: "todo-input", type: "text", placeholder: "Add a to-do and press Enter", maxlength: "200" });
  const form = el("form", { class: "t-row", on: { submit: e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    refocusTodo = true; // keep typing: the list redraws after each add
    commit([...items, { id: Math.random().toString(36).slice(2, 9), text, done: false }]);
  } } }, input, el("button", { class: "t-btn primary", type: "submit" }, "Add"));

  const row = it => {
    const text = el("span", { class: "todo-text", title: "Double-click to edit", on: { dblclick: () => {
      const edit = el("input", { type: "text", value: it.text, maxlength: "200", class: "todo-edit" });
      const finish = save => {
        const v = edit.value.trim();
        if (save && v && v !== it.text) commit(items.map(x => (x.id === it.id ? { ...x, text: v } : x)));
        else render();
      };
      edit.addEventListener("keydown", e => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") { e.stopPropagation(); finish(false); } });
      edit.addEventListener("blur", () => finish(true));
      text.replaceWith(edit);
      edit.focus();
      edit.select();
    } } }, it.text);
    return el("div", { class: "todo" + (it.done ? " done" : "") },
      el("input", { type: "checkbox", checked: it.done, on: { change: e => {
        const done = e.target.checked;
        tallyTodo(it, done);
        commit(items.map(x => (x.id === it.id ? { ...x, done, doneOn: done ? today() : undefined } : x)));
      } } }),
      text,
      el("button", { class: "icon sm", title: "Delete", on: { click: () => {
        const at = items.findIndex(x => x.id === it.id);
        commit(items.filter(x => x.id !== it.id));
        toast("To-do deleted", 7000, () => { const cur = todosOf(space); cur.splice(Math.min(at, cur.length), 0, it); setTodos(space, cur); });
      } } }, "×"));
  };
  const open = items.filter(x => !x.done), done = items.filter(x => x.done);
  return card(`To-do · ${ctx.space.name || "this space"}`, form,
    items.length ? el("div", { class: "todos" }, ...open.map(row), ...done.map(row)) : note("Nothing on the list. Add what you need to do in this space."),
    items.length ? el("div", { class: "t-btns" },
      el("span", { class: "t-sub", style: "flex:1;align-self:center" }, `${open.length} open · ${done.length} done`),
      done.length ? btn("Clear done", () => {
        commit(open);
        toast(`Cleared ${done.length} done`, 7000, () => setTodos(space, [...todosOf(space), ...done]));
      }) : null) : null);
}

// ---- notes (one scratchpad per space) ----

// Notes are saved a moment after the last keystroke, and straight away when the page closes or redraws, so closing the Tools
// page (or Escape) never loses the last words. A save that fails (the storage is full) says so instead of showing "Saved".
const NOTES_MAX = 200000;
let notesTimer = null, notesPending = null;
function flushNotes() {
  clearTimeout(notesTimer);
  const save = notesPending;
  notesPending = null;
  if (save) save();
}
function notesView() {
  const id = ctx.space.id || "default";
  const area = el("textarea", { class: "t-notes", spellcheck: "true", maxlength: String(NOTES_MAX), placeholder: `Notes for ${ctx.space.name || "this space"}…`, on: { input: e => {
    const text = e.target.value;
    notesPending = () => {
      try {
        const n = read(NOTES_KEY, {});
        if (text) n[id] = text.slice(0, NOTES_MAX); else delete n[id];
        localStorage.setItem(NOTES_KEY, JSON.stringify(n));
      } catch { toast("Couldn't save the notes: this device's storage is full", 5000); }
    };
    clearTimeout(notesTimer);
    notesTimer = setTimeout(flushNotes, 300);
  } } }, read(NOTES_KEY, {})[id] || "");
  return [todoCard(), card(`Notes · ${ctx.space.name || "this space"}`, area,
    el("div", { class: "t-btns" },
      btn("Copy", () => area.value && copy(area.value, "Notes copied")),
      btn("Clear", () => { if (!area.value || confirm("Clear the notes for this space?")) { area.value = ""; area.dispatchEvent(new Event("input")); } })),
    note("Each space has its own notes. Saved as you type, on this device."))];
}

// ---- Markdown files: opened in an editor tab (ui/markdown.html) ----

// what: "open" (file picker), "folder" (folder picker), "new", "dir:<path>" (a folder from the recent list)
// or the path of a file.
async function openMarkdown(what) {
  const url = await call("md_url");
  if (!url) return;
  op("new-tab", what === "open" ? `${url}#open` : what === "folder" ? `${url}#folder` : what === "new" ? url
    : what.startsWith("dir:") ? `${url}?folder=${encodeURIComponent(what.slice(4))}` : `${url}?file=${encodeURIComponent(what)}`);
}

function markdownCard(files, folders) {
  const recent = (title, list, what) => list && list.length ? [el("div", { class: "t-sub" }, title),
    el("div", { class: "md-recent" }, ...list.map(p => el("button", { class: "t-btn", title: p, on: { click: () => openMarkdown(what(p)) } },
      el("span", {}, p.split(/[\\/]/).pop()), el("span", { class: "d" }, p))))] : null;
  return card("Markdown",
    note("Read and edit .md files, or mount a folder (or several) like a vault: browse, search and graph all its notes, and unmount it any time. You can also drag a .md file onto any Alcove tab to read it."),
    el("div", { class: "t-btns wrap" }, btn("Mount folder…", () => openMarkdown("folder"), "primary"), btn("Open file…", () => openMarkdown("open")), btn("New document", () => openMarkdown("new"))),
    recent("Recent folders", folders, p => "dir:" + p),
    recent("Recent files", files, p => p));
}

function markdownView() {
  const out = [markdownCard([], [])];
  Promise.all([call("md_recent"), call("md_recent_folders")]).then(([files, folders]) => {
    if (view === "markdown" && ((files && files.length) || (folders && folders.length))) out[0].replaceWith(markdownCard(files, folders));
  });
  return out;
}

// ---- page helpers: act on the tab the sidebar is showing ----

const everyLabel = ms => (ms < 60000 ? `${ms / 1000}s` : `${ms / 60000} min`);

function pageView() {
  const tab = ctx.tab;
  if (!tab || !tab.opened || !/^https?:/.test(tab.url)) {
    return [card("This page", note("Open a web page, then come back here for its tools: auto-refresh, color picker, images, clean links and Amazon helpers."),
      el("div", { class: "t-sub" }, "On an empty page you can still work with Markdown files"),
      el("div", { class: "t-btns wrap" }, btn("Open Markdown file…", () => openMarkdown("open")), btn("New Markdown document", () => openMarkdown("new"))))];
  }
  const cur = (ctx.refreshers.find(r => r.id === tab.id) || {}).ms || 0;
  const others = ctx.refreshers.filter(r => r.id !== tab.id);
  const az = amazonInfo(tab.url);
  const host = (() => { try { return new URL(tab.url).hostname.replace(/^www\./, ""); } catch { return ""; } })();

  const refreshCard = card("Auto-refresh",
    el("div", { class: "t-chips" }, ...[[0, "Off"], [30000, "30s"], [60000, "1 min"], [300000, "5 min"], [900000, "15 min"], [1800000, "30 min"]].map(([ms, l]) =>
      el("button", { class: "t-chip" + (cur === ms ? " on" : ""), on: { click: () => op("refresh", tab.id, ms) } }, l))),
    cur ? note(`${host} reloads every ${everyLabel(cur)} while Alcove is open. Handy for dashboards.`) : note("Reload this tab on a timer."),
    others.length ? el("div", { class: "t-bars" }, ...others.map(r => el("div", { class: "t-bar plain" },
      el("span", { class: "n" }, r.title), el("span", { class: "v" }, everyLabel(r.ms)),
      el("button", { class: "icon sm", title: "Stop", on: { click: () => op("refresh", r.id, 0) } }, "×")))) : null);

  const toolsCard = card(`This page · ${host}`,
    el("div", { class: "t-btns wrap" },
      btn("Pick a color", () => call("eyedropper", { id: tab.id })), // the page closes so the picker can see the tab
      btn("Download all images", async () => {
        toast("Saving images…", 4000);
        const r = await call("save_images", { id: tab.id });
        toast(!r || !r.total ? "No large images found on this page" : `Saved ${r.saved} of ${r.total} images to Downloads/Alcove images`, 4500);
      }),
      btn("Copy link without tracking", () => copy(cleanLink(tab.url), "Clean link copied"))));

  const amazonCard = az ? card(`Amazon · ${az.asin}`,
    el("div", { class: "t-btns wrap" },
      btn("Copy ASIN", () => copy(az.asin, "ASIN copied"), "primary"),
      btn("Copy short link", () => copy(`https://www.amazon.${az.tld}/dp/${az.asin}`, "Short link copied")),
      KEEPA[az.tld] ? btn("Keepa", () => op("open-url", `https://keepa.com/#!product/${KEEPA[az.tld]}-${az.asin}`)) : null,
      btn("CamelCamelCamel", () => op("open-url", `https://camelcamelcamel.com/product/${az.asin}`)),
      btn("Seller Central", () => op("open-url", `https://sellercentral.amazon.${az.tld}`)))) : null;

  return [amazonCard, toolsCard, refreshCard];
}

// ---- shell ----

function render() {
  live = [];
  fast = [];
  $("nav").replaceChildren(...TABS.map(([id, label]) =>
    el("button", { class: id === view ? "on" : "", on: { click: () => { view = id; try { localStorage.setItem(TAB_KEY, JSON.stringify(id)); } catch {} render(); } } }, label)));
  const build = { timers: timersView, alarms: alarmsView, track: trackView, clocks: clocksView, notes: notesView, markdown: markdownView, page: pageView }[view];
  $("view").replaceChildren(...[st.ringing ? ringingCard() : null, ...build()].filter(Boolean));
  if (refocusTodo) { refocusTodo = false; document.querySelector(".todo-input")?.focus(); }
}

setInterval(() => { for (const f of live) f(); }, 1000);
(function frame() { for (const f of fast) f(); requestAnimationFrame(frame); })(); // pauses by itself while the page is hidden

// The engine writes the state; redraw when it changes. A redraw rebuilds the whole page, which would clear whatever is being
// typed (an alarm being set up, a to-do, a note, a place), so it waits while a field has the focus and happens when the focus
// leaves it. Time tracking is written every few seconds but only the Track tab shows it.
const typing = () => { const a = document.activeElement; return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName); };
let renderPending = false;
const renderSoon = () => { if (typing()) renderPending = true; else render(); };
document.addEventListener("focusout", () => setTimeout(() => { if (renderPending && !typing()) { renderPending = false; render(); } }, 60));
addEventListener("storage", e => {
  if (e.key === KEY) st = loadState();
  else if (e.key === CTX_KEY) ctx = read(CTX_KEY, ctx);
  else if (e.key === TIME_KEY) { if (view !== "track") return; }
  else return;
  renderSoon();
});

const closeTools = () => { flushNotes(); invoke("close_tools"); };
$("close").addEventListener("click", closeTools);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeTools(); });
window.addEventListener("pagehide", flushNotes);
window.addEventListener("focus", () => { st = loadState(); ctx = read(CTX_KEY, ctx); renderSoon(); });

invoke("get_app_settings").then(s => { if (s && s.accent) setAccent(s.accent); }).catch(() => {});
listen("settings-changed", ({ payload }) => { if (payload && payload.accent) setAccent(payload.accent); });
render();
