// Run by `npm run check`. Catches the mistakes that only show up in a packaged app: a file the main process
// requires that electron-builder does not include (the app then dies at startup), and a page it loads that is missing.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const files = pkg.build.files;
const included = f => files.some(g => (g.endsWith("/**/*") ? f.startsWith(g.slice(0, -4)) : g === f));
const problems = [];

for (const src of ["main.js", "crx.js", "md-search.js", "preload.js", "yt-preload.js"]) {
  const text = fs.readFileSync(path.join(root, src), "utf8");
  for (const [, rel] of text.matchAll(/require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g)) {
    const target = path.relative(root, path.resolve(root, path.dirname(src), rel));
    const file = [target, `${target}.js`].find(f => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile());
    if (!file) problems.push(`${src} requires ${rel}, which does not exist`);
    else if (!included(file)) problems.push(`${src} requires ${rel}, but "build.files" in package.json does not include ${file}`);
  }
}
// Pages the main process loads by name live in ../ui (electron/ui is a copy made by sync-ui).
const main = fs.readFileSync(path.join(root, "main.js"), "utf8");
for (const [, name] of main.matchAll(/uiFile\(\s*["']([^"']+)["']\s*\)/g)) {
  if (!fs.existsSync(path.join(root, "..", "ui", name))) problems.push(`main.js loads ui/${name}, which does not exist`);
}

if (problems.length) { console.error(problems.map(p => `  ✗ ${p}`).join("\n")); process.exit(1); }
console.log(`package check ok (${files.length} file patterns)`);
