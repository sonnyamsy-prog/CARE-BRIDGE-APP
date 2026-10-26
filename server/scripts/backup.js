"use strict";
// Copies the data files to a timestamped folder. Usage: npm run backup [target-dir]
const fs = require("node:fs");
const path = require("node:path");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const target = path.resolve(process.argv[2] || path.join(dataDir, "backups"));
const dest = path.join(target, new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
let n = 0;
for (const f of ["db.json", "audit.log"]) {
  const src = path.join(dataDir, f);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(dest, f)); fs.chmodSync(path.join(dest, f), 0o600); n++; }
}
console.log(n ? `Backed up ${n} file(s) to ${dest}\nBackups hold patient data: encrypt them and store them off this machine.` : "Nothing to back up yet.");
