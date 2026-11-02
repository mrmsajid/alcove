// Reading Markdown notes in a folder: the files, what links to what, and search. Plain Node (fs and path only) so the same code
// runs in the main process and, for a regular expression typed by the user, in a worker thread that can be stopped if the pattern
// takes too long (a pattern like (a+)+$ can run for minutes and would freeze every window if it ran in the main process).
const fs = require("fs");
const path = require("path");
const { isMainThread, parentPort, workerData } = require("worker_threads");

const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i;
const MD_SKIP = /^(\.|node_modules$|__pycache__$)/;
const MD_GRAPH_MAX_FILES = 3000;

// Graph view: every note in the folder, which notes link to which ([[wiki links]] and relative .md links),
// and the tags in each. Reads each file once; very large files and huge folders are capped.
function mdScan(text) {
  let body = text, tags = [];
  const fm = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (fm) {
    body = text.slice(fm[0].length);
    const lines = fm[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^tags\s*:\s*(.*)$/i);
      if (!m) continue;
      const v = m[1].trim();
      if (v.startsWith("[")) tags.push(...v.replace(/^\[|\]\s*$/g, "").split(","));
      else if (v) tags.push(...v.split(/[,\s]+/));
      else for (let j = i + 1; j < lines.length && /^\s*-\s+/.test(lines[j]); j++) tags.push(lines[j].replace(/^\s*-\s+/, ""));
    }
  }
  const clean = body.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "").replace(/`[^`\n]*`/g, ""); // links and tags in code don't count
  const wiki = [...clean.matchAll(/\[\[([^\]|#\n]+?)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)].map(m => m[1].trim()).filter(Boolean);
  const rel = [...clean.matchAll(/(?<!!)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]).filter(h => !/^[a-z][a-z0-9+.-]*:/i.test(h) && !h.startsWith("#"));
  for (const m of clean.matchAll(/(^|[\s(])#([A-Za-z][\w/-]{0,39})(?![\w/-])/g)) tags.push(m[2]);
  tags = [...new Set(tags.map(t => t.trim().replace(/^["']|["']$/g, "").replace(/^#+/, "")).filter(Boolean))];
  return { tags, wiki, rel, words: (body.match(/\S+/g) || []).length };
}

// Every file of the given kind under a folder (hidden folders, node_modules and links are skipped).
async function mdFiles(rootDir, kind = MD_EXT) {
  const files = [];
  const walk = async (dir, depth) => {
    if (depth > 12) return;
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (files.length >= MD_GRAPH_MAX_FILES) return;
      if (MD_SKIP.test(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) await walk(full, depth + 1);
      else if (d.isFile() && kind.test(d.name)) files.push(full);
    }
  };
  await walk(rootDir, 0);
  return files;
}

// Search across the loaded folders (roots are already checked by the caller): text in notes (and their names), or #tags. With
// no query it returns the tags in use instead, so the panel can offer them. Reads each file once; results are capped.
async function searchNotes(o, roots) {
  const q = String((o && o.q) || "").trim().slice(0, 200);
  const tagMode = q.length > 1 && q.startsWith("#");
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let re = null;
  if (q && !tagMode) {
    try { re = new RegExp(o.regex ? q : esc(q), o.matchCase ? "g" : "gi"); } catch { return { error: "That isn't a valid pattern." }; }
  }
  const want = tagMode ? q.slice(1).toLowerCase() : "";
  const found = [];
  for (const r of roots) for (const f of await mdFiles(r)) found.push({ root: r, path: f });
  const rows = new Array(found.length), tagCount = new Map();
  let next = 0;
  const worker = async () => {
    while (next < found.length) {
      const i = next++, { root: r, path: f } = found[i];
      let text = "";
      try { const st = await fs.promises.stat(f); if (st.size <= 1024 * 1024) text = await fs.promises.readFile(f, "utf8"); } catch {}
      const name = path.basename(f);
      const row = { path: f, name, root: r, rel: path.relative(r, f).split(path.sep).join("/"), tags: [], matches: [], nameMatch: false };
      if (!q || tagMode) {
        const tags = mdScan(text).tags;
        if (!q) for (const t of tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
        const hit = tags.filter(t => t.toLowerCase().startsWith(want));
        if (tagMode && hit.length) {
          row.tags = hit;
          const inline = new RegExp(`(^|[\\s(])#(?:${hit.map(esc).join("|")})(?![\\w/-])`, "i");
          const lines = text.split("\n");
          let fenced = false;
          lines.forEach((line, ln) => {
            if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return; }
            if (fenced || row.matches.length >= 30) return;
            const mm = inline.exec(line);
            if (mm) { const col = mm.index + mm[1].length; row.matches.push({ line: ln + 1, col, len: line.slice(col).match(/^#[\w/-]+/)[0].length, text: line.slice(Math.max(0, col - 60), col + 120), at: Math.min(col, 60), nth: 0 }); }
            else if (ln < 40 && /^tags\s*:/i.test(line)) row.matches.push({ line: ln + 1, col: 0, len: line.length, text: line.slice(0, 160), at: 0, nth: 0, front: true });
          });
          rows[i] = row;
        }
        continue;
      }
      row.nameMatch = (() => { re.lastIndex = 0; return re.test(name); })();
      const seen = new Map();
      const lines = text.split("\n");
      for (let ln = 0; ln < lines.length && row.matches.length < 30; ln++) {
        const line = lines[ln].replace(/\r$/, "");
        if (line.length > 4000) continue;
        re.lastIndex = 0;
        let mm;
        while ((mm = re.exec(line)) && row.matches.length < 30) {
          if (!mm[0]) { re.lastIndex++; continue; }
          const key = o.matchCase ? mm[0] : mm[0].toLowerCase(), nth = seen.get(key) || 0;
          seen.set(key, nth + 1);
          const from = Math.max(0, mm.index - 60);
          row.matches.push({ line: ln + 1, col: mm.index, len: mm[0].length, text: line.slice(from, mm.index + mm[0].length + 120), at: mm.index - from, nth, found: mm[0] });
        }
      }
      if (row.matches.length || row.nameMatch) rows[i] = row;
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  if (!q) return { tags: [...tagCount].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, 300), files: found.length };
  const results = rows.filter(Boolean).sort((x, y) => (y.matches.length - x.matches.length) || x.name.localeCompare(y.name));
  return {
    q, tagMode, files: found.length,
    total: results.reduce((n, r) => n + r.matches.length, 0),
    results: results.slice(0, 150),
    truncated: results.length > 150 || found.length >= MD_GRAPH_MAX_FILES,
  };
}

module.exports = { MD_EXT, MD_SKIP, MD_GRAPH_MAX_FILES, mdScan, mdFiles, searchNotes };

// Worker entry: main.js starts this file with the request as workerData.
if (!isMainThread && workerData && workerData.mdSearch) {
  searchNotes(workerData.o, workerData.roots).then(r => parentPort.postMessage(r), e => parentPort.postMessage({ error: "The search failed." }));
}
