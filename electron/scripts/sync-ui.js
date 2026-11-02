// The pages Alcove draws live in ../ui; copy them in so the app (and the packaged build) can load them.
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "..", "ui");
const dest = path.join(__dirname, "..", "ui");
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
