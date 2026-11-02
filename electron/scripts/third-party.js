// Writes ../THIRD_PARTY_NOTICES.md: the licence of every package that ships inside the app (production dependencies only,
// found through package.json), with each distinct licence text once, plus the code and tools that are not npm packages.
// Run after changing dependencies: `npm run notices`.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = path.join(__dirname, "..");
// The packages that ship: the app's own dependencies and, recursively, theirs (what `npm ls --omit=dev` shows), found by resolving
// each name in node_modules the way Node would. Development tools and Electron's own installer helpers are not in the app.
const own = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const seen = new Map();
function visit(name, fromDir) {
  let dir = fromDir;
  for (;;) { // nearest node_modules/<name> going up from the requiring package
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) { dir = candidate; break; }
    const up = path.dirname(dir);
    if (up === dir || !up.startsWith(root)) return;
    dir = up;
  }
  if (seen.has(dir)) return;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  seen.set(dir, meta);
  for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) visit(dep, dir);
}
for (const dep of Object.keys(own.dependencies || {})) visit(dep, root);
const pkgs = [];
for (const [dir, meta] of seen) {
  const file = fs.readdirSync(dir).find(f => /^(licen[sc]e|copying|unlicense)(\.|$)/i.test(f));
  const text = file ? fs.readFileSync(path.join(dir, file), "utf8").trim() : "";
  const repo = typeof meta.repository === "string" ? meta.repository : (meta.repository && meta.repository.url) || meta.homepage || "";
  pkgs.push({ name: meta.name, version: meta.version, license: typeof meta.license === "string" ? meta.license : (meta.license && meta.license.type) || "see below",
    repo: repo.replace(/^git\+/, "").replace(/^ssh:\/\/git@/, "https://").replace(/^git:\/\//, "https://").replace(/\.git$/, "").replace(/^(?!https?:)([\w.-]+\/[\w.-]+)$/, "https://github.com/$1"), text });
}
pkgs.sort((a, b) => a.name.localeCompare(b.name));

const groups = new Map(); // licence text -> packages
for (const p of pkgs) {
  const key = crypto.createHash("sha256").update(p.text.replace(/^.*(copyright|\(c\)).*$/gim, "")).digest("hex") + (p.text ? "" : p.name);
  if (!groups.has(key)) groups.set(key, { text: p.text, pkgs: [] });
  groups.get(key).pkgs.push(p);
}

let out = `# Third-party notices

Alcove is MIT licensed (see [LICENSE](LICENSE)). It contains the software below, each under its own licence. Electron and Chromium
ship their own notices inside every build (\`LICENSE.electron.txt\` and \`LICENSES.chromium.html\`).

## Packages inside the app

| Package | Version | Licence | Source |
| --- | --- | --- | --- |
${pkgs.map(p => `| ${p.name} | ${p.version} | ${p.license} | ${p.repo || ""} |`).join("\n")}

Packages under the Mozilla Public License 2.0 (the \`@ghostery/*\` and \`@remusao/*\` packages) are used unmodified; their source is
at the addresses above. The MPL-2.0 applies to those files only.

## Code in this repository that is not an npm package

- \`ui/vendor/qrcode.js\`: QR Code Generator for JavaScript, Copyright (c) 2009 Kazuhiko Arase, MIT licence (the licence is the MIT text
  below, and the file keeps its header).

## Tools downloaded on request (not part of Alcove)

When you set up video download, Alcove fetches these from their projects' releases into your own data folder and runs them. They are
separate programs with their own licences, and Alcove does not include or link them.

- yt-dlp (https://github.com/yt-dlp/yt-dlp): the Unlicense for the project; the packaged executables bundle GPLv3+ code, so treat them as GPLv3+.
- ffmpeg builds from https://github.com/eugeneware/ffmpeg-static (release b6.1.1): GPL-3.0.

## Licence texts

`;
for (const g of groups.values()) {
  out += `### ${g.pkgs.map(p => p.name).join(", ")}\n\n${g.text ? "```\n" + g.text + "\n```" : "(no licence file in the package; see its licence field above)"}\n\n`;
}
fs.writeFileSync(path.join(root, "..", "THIRD_PARTY_NOTICES.md"), out);
console.log(`THIRD_PARTY_NOTICES.md written: ${pkgs.length} packages, ${groups.size} distinct licence texts`);
