"use strict";
// Back up the Postgres data to db.json and audit.log files (the same format the file store uses).
// Usage:  DATABASE_URL=postgres://... node scripts/pg-export.js [target-folder]
// Backups hold patient data: encrypt them and keep them off this machine.
const path = require("node:path");
const { PgStore, exportTo } = require("../lib/pgstore");
(async () => {
  const target = process.argv[2] || path.join(process.env.DATA_DIR || path.join(__dirname, "..", "data"), "backups");
  const store = await PgStore.connect(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL });
  try {
    const r = await exportTo(store, target);
    console.log(`Exported ${r.patients} patients and ${r.audits} audit entries to ${r.dest}\nBackups hold patient data: encrypt them and store them off this machine.`);
  } finally { await store.close(); }
})().catch((e) => { console.error(e.message); process.exit(1); });
