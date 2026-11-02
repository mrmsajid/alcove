// Shared by the sidebar (the Tools engine: timers, tracking, focus mode, see tools.js) and the Tools page
// (tools.html). Both live in the same storage, so the engine writes state and the page reads it.
const ToolsShared = (() => {
  const KEY = "alcove-tools-v1";
  const TIME_KEY = "alcove-time-v1";   // { days: { "2026-11-02": { sites: { host: seconds }, spaces: { name: seconds } } } }
  const NOTES_KEY = "alcove-notes-v1"; // { spaceId: text }, written by the Tools page
  const CTX_KEY = "alcove-tools-ctx";  // what the sidebar currently shows: space, active tab, auto-refreshing tabs
  const POMO = { work: 25, short: 5, long: 15 };
  const DEFAULT_ZONES = [["Asia/Karachi", "Islamabad"], ["Asia/Manila", "Manila"], ["America/Detroit", "Michigan"]];
  const DEFAULT_FOCUS = ["youtube.com", "facebook.com", "instagram.com", "x.com", "twitter.com", "tiktok.com", "reddit.com", "netflix.com"];

  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

  const loadState = () => Object.assign({
    sw: { start: 0, acc: 0 },                         // stopwatch: start = running since (ms), acc = banked ms
    timer: { end: 0, left: 0, total: 0 },             // end > 0 running; left > 0 paused
    pomo: { phase: "", end: 0, left: 0, total: 0 },   // phase "work" | "break" | "" (idle)
    pomoDone: { date: "", n: 0 },
    task: null,                                       // { name, start }
    log: {},                                          // { date: [{ name, sec }] }
    zones: DEFAULT_ZONES.map(z => [...z]),
    focusSites: [...DEFAULT_FOCUS],
    focusUntil: 0,
    trackPaused: false,
  }, read(KEY, {}));

  const pad = n => String(n).padStart(2, "0");
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const clock = ms => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    return (h ? h + ":" : "") + pad(Math.floor(s % 3600 / 60)) + ":" + pad(s % 60);
  };
  const human = sec => {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
    return h ? `${h}h ${m}m` : m ? `${m}m` : `${sec}s`;
  };

  // Timer values derived from the saved timestamps, so both views agree without talking to each other.
  const swMs = st => st.sw.acc + (st.sw.start ? Date.now() - st.sw.start : 0);
  const timerLeft = st => (st.timer.end ? st.timer.end - Date.now() : st.timer.left);
  const pomoLeft = st => (st.pomo.end ? st.pomo.end - Date.now() : st.pomo.left);

  // ---- world clock ----
  function offsetMin(tz, d = new Date()) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(d).map(x => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  }
  const validZone = tz => { try { new Intl.DateTimeFormat([], { timeZone: tz }); return true; } catch { return false; } };
  function zoneInfo(tz) {
    const d = new Date();
    const time = new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit", timeZone: tz }).format(d);
    const offset = offsetMin(tz, d);
    const local = -d.getTimezoneOffset();
    const diff = (offset - local) / 60;
    const shifted = new Date(d.getTime() + (offset - local) * 60000); // the zone's wall clock, read in local terms
    const dayDiff = Math.round((new Date(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
    const hour = shifted.getHours();
    return {
      time,
      day: dayDiff === 0 ? "Today" : dayDiff > 0 ? "Tomorrow" : "Yesterday",
      rel: diff === 0 ? "Same time" : `${diff > 0 ? "+" : "−"}${Math.abs(diff)}h`,
      open: hour >= 9 && hour < 18,
    };
  }

  // ---- page helpers ----
  // Amazon product pages: /dp/ASIN, /gp/product/ASIN, /product/ASIN
  const KEEPA = { com: 1, "co.uk": 2, de: 3, fr: 4, "co.jp": 5, ca: 6, it: 8, es: 9, in: 10, "com.mx": 11, "com.br": 12, "com.au": 13, nl: 14 };
  function amazonInfo(url) {
    try {
      const u = new URL(url);
      const m = u.hostname.match(/(?:^|\.)amazon\.([a-z.]+)$/);
      const a = u.pathname.match(/\/(?:dp|gp\/product|product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
      return m && a ? { tld: m[1], asin: a[1].toUpperCase() } : null;
    } catch { return null; }
  }
  const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_eid|mc_cid|igshid|yclid|_hsenc|_hsmi|ref_|ref|referrer|spm|si|pd_rd_[a-z]+|pf_rd_[a-z]+|tag|linkcode|th|psc)$/i;
  function cleanLink(url) {
    try {
      const u = new URL(url);
      for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
      return u.href.replace(/\?$/, "");
    } catch { return url; }
  }

  return {
    KEY, TIME_KEY, NOTES_KEY, CTX_KEY, POMO, read, loadState, pad, today, clock, human, swMs, timerLeft, pomoLeft,
    offsetMin, validZone, zoneInfo, KEEPA, amazonInfo, cleanLink,
  };
})();
