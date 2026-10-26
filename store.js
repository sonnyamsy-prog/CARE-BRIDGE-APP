"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Small JSON-file store. Fine for a pilot or a single clinic; move to a real
// database before running at larger scale.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "db.json");
    this.auditFile = path.join(dir, "audit.log");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { next: 1001, staff: [], patients: [] };
  }
  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.db), { mode: 0o600 });
    fs.renameSync(tmp, this.file); // atomic replace
  }
  audit(actor, action, detail) {
    const line = JSON.stringify({ ts: new Date().toISOString(), actor, action, ...detail });
    fs.appendFileSync(this.auditFile, line + "\n", { mode: 0o600 });
  }
}
module.exports = { Store };
