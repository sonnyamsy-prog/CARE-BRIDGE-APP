"use strict";
const fs = require("node:fs");
const path = require("node:path");

// Small JSON-file store, used when DATABASE_URL is not set. Fine for a pilot or a single clinic on a
// server with a real disk. For anything that must survive restarts on a host like Render, set
// DATABASE_URL and use lib/pgstore.js instead.
class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, "db.json");
    this.auditFile = path.join(dir, "audit.log");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { next: 1001, nextOrg: 1, staff: [], patients: [], orgs: [] };
    // Older data files have no organizations yet: add the empty collection.
    if (!Array.isArray(this.db.orgs)) this.db.orgs = [];
    if (!this.db.nextOrg) this.db.nextOrg = 1;
  }
  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.db), { mode: 0o600 });
    fs.renameSync(tmp, this.file); // atomic replace
  }
  // Same interface as the Postgres store: the file store writes immediately, so there is nothing to wait for.
  settled() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  audit(actor, action, detail) {
    const line = JSON.stringify({ ts: new Date().toISOString(), actor, action, ...detail });
    fs.appendFileSync(this.auditFile, line + "\n", { mode: 0o600 });
  }
}
module.exports = { Store };
