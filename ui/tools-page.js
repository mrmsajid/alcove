// The Tools page: timers, time tracking, world clock, notes, Markdown files and page helpers.
// The sidebar runs the engine (tools.js). This page shows its saved state and sends it commands, so the
// timers keep going while this page is closed.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { KEY, TIME_KEY, NOTES_KEY, CTX_KEY, POMO, read, loadState, today, clock, human, swMs, timerLeft, pomoLeft,
  validZone, zoneInfo, KEEPA, amazonInfo, cleanLink } = ToolsShared;

let st = loadState();
let ctx = read(CTX_KEY, { space: { id: "", name: "" }, tab: null, refreshers: [] });
const TAB_KEY = "alcove-tools-tab";
const TABS = [["timers", "Timers"], ["track", "Track"], ["clocks", "Clocks"], ["notes", "Notes"], ["markdown", "Markdown"], ["page", "Page"]];
let view = (location.hash.slice(1) || read(TAB_KEY, "timers"));
if (!TABS.some(t => t[0] === view)) view = "timers";

const $ = id => document.getElementById(id);
const op = (name, ...args) => invoke("tools_op", { op: name, args }).catch(() => {});
const call = (cmd, args) => invoke(cmd, args).catch(() => null);

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
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

// ---- timers ----

function stopwatchCard() {
  const running = !!st.sw.start, has = swMs(st) > 0;
  return card("Stopwatch", liveText("t-big", () => clock(swMs(st))),
    el("div", { class: "t-btns" },
      running ? btn("Pause", () => op("sw-pause")) : btn(has ? "Resume" : "Start", () => op("sw-start"), "primary"),
      has ? btn("Reset", () => op("sw-reset")) : null));
}

function timerCard() {
  const running = !!st.timer.end, paused = !running && st.timer.left > 0;
  return card("Timer", liveText("t-big", () => clock(running || paused ? timerLeft(st) : 0)),
    running || paused
      ? el("div", { class: "t-btns" },
        running ? btn("Pause", () => op("timer-pause")) : btn("Resume", () => op("timer-resume"), "primary"),
        btn("Cancel", () => op("timer-cancel")))
      : [chips([5, 10, 15, 25, 45], m => op("timer-start", m)), minutesForm("Start", m => op("timer-start", m))]);
}

function pomodoroCard() {
  const p = st.pomo, running = !!p.end, paused = !running && p.left > 0;
  const done = st.pomoDone.date === today() ? st.pomoDone.n : 0;
  return card("Pomodoro",
    el("div", { class: "t-sub" }, p.phase === "work" ? "Focus" : p.phase === "break" ? "Break" : "Ready", paused ? " · paused" : ""),
    liveText("t-big", () => clock(p.phase ? pomoLeft(st) : POMO.work * 60000)),
    el("div", { class: "t-btns" },
      !p.phase ? btn(`Start ${POMO.work} min`, () => op("pomo-start"), "primary")
        : [running ? btn("Pause", () => op("pomo-pause")) : btn("Resume", () => op("pomo-resume"), "primary"),
          btn("Skip", () => op("pomo-skip")), btn("Stop", () => op("pomo-stop"))]),
    note(`${done} focus ${done === 1 ? "session" : "sessions"} today · ${POMO.work} min focus, ${POMO.short} min break, ${POMO.long} min every 4th`));
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

const timersView = () => [pomodoroCard(), timerCard(), stopwatchCard(), focusCard()];

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
        btn("Clear today", () => op("track-clear-today").then(() => render())))),
    card("Task timer",
      st.task ? [el("div", { class: "t-sub" }, st.task.name), liveText("t-big", () => clock(Date.now() - st.task.start)),
        el("div", { class: "t-btns" }, btn("Stop", () => op("task-stop"), "primary"))]
        : form,
      log.length ? [el("div", { class: "t-sub" }, "Today"),
        el("div", { class: "t-bars" }, ...log.map(x => el("div", { class: "t-bar plain" }, el("span", { class: "n" }, x.name), el("span", { class: "v" }, human(x.sec))))),
        el("div", { class: "t-btns" },
          btn("Copy log", () => copy(log.map(x => `${x.name}: ${human(x.sec)}`).concat(`Total: ${human(logTotal)}`).join("\n"), "Task log copied")),
          btn("Clear", () => op("task-clear-log")))] : null),
  ];
}

// ---- world clock ----

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
    const tz = validZone(q) ? q : all.find(z => z.toLowerCase().endsWith("/" + q.toLowerCase()) || z.toLowerCase() === q.toLowerCase());
    if (!tz) return toast("Unknown place. Try a city like London or Karachi");
    if (st.zones.some(z => z[0] === tz)) return toast("Already added");
    op("zones", [...st.zones, [tz, tz.split("/").pop().replace(/_/g, " ")]]);
  } } }, input, list, el("button", { class: "t-btn", type: "submit" }, "Add"));
  return [card("World clock",
    el("div", { class: "z-list" }, row(Intl.DateTimeFormat().resolvedOptions().timeZone, "You", false), ...st.zones.map(([tz, label]) => row(tz, label, true))),
    form, note("Green dot: it's 9am–6pm there."))];
}

// ---- to-do list (one per space) ----

const TODO_KEY = "alcove-todos-v1"; // { spaceId: [{ id, text, done }] }, written by this page
let refocusTodo = false;

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
      el("input", { type: "checkbox", checked: it.done, on: { change: e => commit(items.map(x => (x.id === it.id ? { ...x, done: e.target.checked } : x))) } }),
      text,
      el("button", { class: "icon sm", title: "Delete", on: { click: () => commit(items.filter(x => x.id !== it.id)) } }, "×"));
  };
  const open = items.filter(x => !x.done), done = items.filter(x => x.done);
  return card(`To-do · ${ctx.space.name || "this space"}`, form,
    items.length ? el("div", { class: "todos" }, ...open.map(row), ...done.map(row)) : note("Nothing on the list. Add what you need to do in this space."),
    items.length ? el("div", { class: "t-btns" },
      el("span", { class: "t-sub", style: "flex:1;align-self:center" }, `${open.length} open · ${done.length} done`),
      done.length ? btn("Clear done", () => commit(open)) : null) : null);
}

// ---- notes (one scratchpad per space) ----

function notesView() {
  const id = ctx.space.id || "default";
  let timer;
  const area = el("textarea", { class: "t-notes", spellcheck: "true", placeholder: `Notes for ${ctx.space.name || "this space"}…`, on: { input: e => {
    clearTimeout(timer);
    timer = setTimeout(() => { const n = read(NOTES_KEY, {}); if (e.target.value) n[id] = e.target.value; else delete n[id]; localStorage.setItem(NOTES_KEY, JSON.stringify(n)); }, 300);
  } } }, read(NOTES_KEY, {})[id] || "");
  return [todoCard(), card(`Notes · ${ctx.space.name || "this space"}`, area,
    el("div", { class: "t-btns" },
      btn("Copy", () => area.value && copy(area.value, "Notes copied")),
      btn("Clear", () => { if (!area.value || confirm("Clear the notes for this space?")) { area.value = ""; area.dispatchEvent(new Event("input")); } })),
    note("Each space has its own notes. Saved as you type, on this device."))];
}

// ---- Markdown files: opened in an editor tab (ui/markdown.html) ----

async function openMarkdown(what) {
  const url = await call("md_url");
  if (!url) return;
  op("new-tab", what === "open" ? `${url}#open` : what === "new" ? url : `${url}?file=${encodeURIComponent(what)}`);
}

function markdownCard(recent) {
  return card("Markdown",
    note("Read and edit .md files. Open one from your computer, or start a new document. You can also drag a .md file onto any Alcove tab to read it."),
    el("div", { class: "t-btns wrap" }, btn("Open file…", () => openMarkdown("open"), "primary"), btn("New document", () => openMarkdown("new"))),
    recent && recent.length ? [el("div", { class: "t-sub" }, "Recent"),
      el("div", { class: "md-recent" }, ...recent.map(p => el("button", { class: "t-btn", title: p, on: { click: () => openMarkdown(p) } },
        el("span", {}, p.split(/[\\/]/).pop()), el("span", { class: "d" }, p))))] : null);
}

function markdownView() {
  const out = [markdownCard([])];
  call("md_recent").then(list => {
    if (view === "markdown" && list && list.length) { out[0].replaceWith(markdownCard(list)); }
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
  $("nav").replaceChildren(...TABS.map(([id, label]) =>
    el("button", { class: id === view ? "on" : "", on: { click: () => { view = id; try { localStorage.setItem(TAB_KEY, JSON.stringify(id)); } catch {} render(); } } }, label)));
  const build = { timers: timersView, track: trackView, clocks: clocksView, notes: notesView, markdown: markdownView, page: pageView }[view];
  $("view").replaceChildren(...build().filter(Boolean));
  if (refocusTodo) { refocusTodo = false; document.querySelector(".todo-input")?.focus(); }
}

setInterval(() => { for (const f of live) f(); }, 1000);

// The engine writes the state; redraw when it changes (but never under someone typing a note).
addEventListener("storage", e => {
  if (e.key === KEY) st = loadState();
  else if (e.key === CTX_KEY) ctx = read(CTX_KEY, ctx);
  else if (e.key !== TIME_KEY) return;
  const a = document.activeElement;
  if (a && a.tagName === "TEXTAREA" && view === "notes") return;
  if (e.key === CTX_KEY && a && a.tagName === "INPUT" && a.value) return; // a half-typed entry
  render();
});

$("close").addEventListener("click", () => invoke("close_tools"));
document.addEventListener("keydown", e => { if (e.key === "Escape") invoke("close_tools"); });
window.addEventListener("focus", () => { st = loadState(); ctx = read(CTX_KEY, ctx); render(); });

invoke("get_app_settings").then(s => { if (s && s.accent) document.documentElement.style.setProperty("--accent", s.accent); }).catch(() => {});
listen("settings-changed", ({ payload }) => { if (payload && payload.accent) document.documentElement.style.setProperty("--accent", payload.accent); });
render();
