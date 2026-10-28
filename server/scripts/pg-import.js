"use strict";
// Move your old data (db.json and audit.log) into an EMPTY Postgres database.
// Usage:  DATABASE_URL=postgres://... node scripts/pg-import.js [folder-with-db.json]
const path = require("node:path");
const { PgStore, importLegacy } = require("../lib/pgstore");
(async () => {
  const dir = path.resolve(process.argv[2] || process.env.DATA_DIR || path.join(__dirname, "..", "data"));
  const store = await PgStore.connect(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL });
  try {
    const r = await importLegacy(store, dir);
    console.log(`Imported ${r.patients} patients, ${r.staff} staff, ${r.orgs} organizations and ${r.audits} audit entries from ${dir}`);
  } finally { await store.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
