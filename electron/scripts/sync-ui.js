// The sidebar and palette live in ../ui and are shared with the Tauri build; copy them in.
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "..", "ui");
const dest = path.join(__dirname, "..", "ui");
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
