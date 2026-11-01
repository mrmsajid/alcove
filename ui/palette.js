const { invoke } = window.__TAURI__.core;
const { emit } = window.__TAURI__.event;

const $ = id => document.getElementById(id);
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

const COMMANDS = [
  ["new-tab", "New Tab"], ["reopen-tab", "Reopen Closed Tab"], ["close-tab", "Close Tab"],
  ["new-space", "New Space"], ["pin-tab", "Pin / Unpin Tab"], ["bookmark", "Bookmark This Page"],
  ["find", "Find in Page"], ["screenshot-region", "Screenshot Selected Area"], ["screenshot", "Screenshot Visible Area"], ["screenshot-full", "Screenshot Full Page"], ["extensions", "Show Extensions"], ["browse-extensions", "Browse Chrome Web Store Extensions"], ["reload", "Reload"], ["zoom-in", "Zoom In"], ["zoom-out", "Zoom Out"],
  ["zoom-reset", "Actual Size"], ["bookmarks", "Show Bookmarks"], ["history", "Show History"],
  ["downloads", "Show Downloads"],
];

function normalize(input) {
  const v = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (!/\s/.test(v) && /^[^\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(v)) return "https://" + v;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(v)) return "http://" + v;
  return "https://duckduckgo.com/?q=" + encodeURIComponent(v);
}

const state = read("alcove-state-v1", { spaces: [] });
const tabs = state.spaces.flatMap(s => s.tabs.map(t => ({ ...t, space: s.name })));
const bookmarks = read("alcove-bookmarks", []);
const history = read("alcove-history", []).slice(0, 300);

let results = [];
let sel = 0;

const hay = x => ((x.title || "") + " " + (x.url || "") + " " + (x.label || "")).toLowerCase();

function compute() {
  const q = $("q").value.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const hit = x => words.every(w => hay(x).includes(w));
  const out = [];
  if (q) {
    out.push({ kind: "Go", title: normalize($("q").value), sub: "Open in this tab · Shift+Enter for new tab",
      act: shift => ({ type: "url", url: normalize($("q").value), newTab: shift }) });
  }
  for (const t of tabs.filter(hit).slice(0, 8)) {
    out.push({ kind: "Tab", title: t.title || t.url, sub: t.space + " · " + t.url, act: () => ({ type: "tab", id: t.id }) });
  }
  for (const c of COMMANDS.map(([id, label]) => ({ id, label })).filter(hit).slice(0, q ? 6 : 14)) {
    out.push({ kind: "Command", title: c.label, sub: "", act: () => ({ type: "cmd", id: c.id }) });
  }
  if (q) {
    for (const b of bookmarks.filter(hit).slice(0, 5)) {
      out.push({ kind: "Bookmark", title: b.title, sub: b.url, act: s => ({ type: "url", url: b.url, newTab: s }) });
    }
    const seen = new Set();
    for (const h of history.filter(hit)) {
      if (seen.has(h.url) || seen.size >= 6) continue;
      seen.add(h.url);
      out.push({ kind: "History", title: h.title || h.url, sub: h.url, act: s => ({ type: "url", url: h.url, newTab: s }) });
    }
  }
  return out;
}

function render() {
  results = compute();
  sel = Math.min(sel, Math.max(results.length - 1, 0));
  $("list").replaceChildren(...results.map((r, i) => {
    const el = document.createElement("div");
    el.className = "row" + (i === sel ? " sel" : "");
    const main = document.createElement("div");
    main.className = "main";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = r.title;
    const u = document.createElement("div");
    u.className = "u";
    u.textContent = r.sub;
    main.append(t, u);
    const k = document.createElement("span");
    k.className = "kind";
    k.textContent = r.kind;
    el.append(main, k);
    el.addEventListener("click", () => run(i, false));
    return el;
  }));
  $("list").children[sel]?.scrollIntoView({ block: "nearest" });
}

async function run(i, shift) {
  const r = results[i];
  if (!r) return;
  await emit("palette-action", r.act(shift));
  invoke("hide_palette");
}

$("q").addEventListener("input", () => { sel = 0; render(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape") invoke("hide_palette");
  else if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(results.length, 1); render(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + results.length) % Math.max(results.length, 1); render(); }
  else if (e.key === "Enter") run(sel, e.shiftKey);
});

// Close when focus leaves; ignore the blur that can fire while the webview is still taking focus.
let ready = false;
window.addEventListener("focus", () => { ready = true; });
window.addEventListener("blur", () => { if (ready) invoke("hide_palette"); });
setTimeout(() => $("q").focus(), 50);

render();
