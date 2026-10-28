"use strict";
const fs = require("node:fs");
const path = require("node:path");

// PostgreSQL storage for CareBridge.
//
// How it works: the app keeps its working data in memory, exactly like the JSON-file store, so
// every route stays unchanged. Each record is also stored as one row in Postgres (a JSONB column
// per record), and every save() writes only the rows that changed, inside one transaction.
// The server waits for that commit before it tells the user "saved" (see settled()).
//
// Run ONE copy of the server. Two copies would each hold their own in-memory data.

// Collections of records, and the field that identifies each record.
const COLLECTIONS = {
  staff: { table: "cb_staff", key: "id" },
  orgs: { table: "cb_orgs", key: "id" },
  patients: { table: "cb_patients", key: "id" },
  push: { table: "cb_push", key: "endpoint" },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cb_meta (key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS cb_staff (id text PRIMARY KEY, seq bigserial, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS cb_orgs (id text PRIMARY KEY, seq bigserial, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS cb_patients (id text PRIMARY KEY, seq bigserial, org_id integer, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS cb_push (endpoint text PRIMARY KEY, seq bigserial, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS cb_audit (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), actor text, action text, detail jsonb NOT NULL DEFAULT '{}');
CREATE INDEX IF NOT EXISTS cb_patients_org ON cb_patients (org_id);
CREATE INDEX IF NOT EXISTS cb_audit_ts ON cb_audit (ts);
`;

const defaults = () => ({ next: 1001, nextOrg: 1, staff: [], patients: [], orgs: [], push: [] });

// Work out the connection settings. The connection string's own sslmode is removed because the pg
// driver would let it override our choice. `setting` is DATABASE_SSL: "0" off, "1" on (encrypted,
// certificate not checked), "verify" on with full certificate checking.
function connectionConfig(url, setting) {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  u.searchParams.delete("sslmode");
  const host = u.hostname;
  const privateHost = !host || host === "localhost" || host === "127.0.0.1" || host === "::1" || !host.includes(".");
  let ssl;
  if (setting === "0" || mode === "disable") ssl = false;
  else if (setting === "verify" || mode === "verify-full") ssl = { rejectUnauthorized: true };
  else if (setting === "1" || mode) ssl = { rejectUnauthorized: false };
  else ssl = privateHost ? false : { rejectUnauthorized: false };
  return { connectionString: u.toString(), ssl };
}

class PgStore {
  // Open the database, create the tables if needed, and load everything into memory.
  // opts: { ssl: DATABASE_SSL, Pool: (for tests) }
  static async connect(url, opts = {}) {
    if (!url) throw new Error("DATABASE_URL is not set.");
    let Pool = opts.Pool;
    if (!Pool) {
      try { ({ Pool } = require("pg")); }
      catch { throw new Error("DATABASE_URL is set but the 'pg' package is missing. Run: npm install (in the server folder)."); }
    }
    const pool = new Pool({ ...connectionConfig(url, opts.ssl), max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
    pool.on("error", (e) => console.error("Database connection problem:", e.message)); // e.g. database restarted
    const store = new PgStore(pool);
    try { await store._load(); } catch (e) { await pool.end().catch(() => {}); throw e; }
    return store;
  }

  constructor(pool) {
    this.pool = pool;
    this.db = defaults();
    this.snap = { meta: new Map(), ...Object.fromEntries(Object.keys(COLLECTIONS).map((c) => [c, new Map()])) };
    this.queued = false;
    this.pending = Promise.resolve();
    this.chain = Promise.resolve();
    this.auditPending = Promise.resolve();
    this.auditChain = Promise.resolve();
    this.lastFlush = { upserts: 0, deletes: 0 };
    this.closed = false;
  }

  async _load() {
    await this.pool.query(SCHEMA);
    const db = defaults();
    for (const r of (await this.pool.query("SELECT key, value FROM cb_meta")).rows) db[r.key] = r.value;
    for (const [name, c] of Object.entries(COLLECTIONS)) {
      db[name] = (await this.pool.query(`SELECT data FROM ${c.table} ORDER BY seq`)).rows.map((r) => r.data);
    }
    this.db = db;
    this._remember();
  }

  // Remember exactly what the database holds, so the next save writes only what changed.
  _remember() {
    const d = this._diff();
    d.commit();
  }

  // Compare memory with what is stored. Synchronous, so it sees a consistent picture.
  _diff() {
    const ops = [], next = {};
    const meta = new Map();
    for (const [k, v] of Object.entries(this.db)) if (!COLLECTIONS[k] && v !== undefined) meta.set(k, JSON.stringify(v));
    next.meta = meta;
    for (const [k, json] of meta) if (this.snap.meta.get(k) !== json) ops.push({ t: "meta", k, json });
    for (const k of this.snap.meta.keys()) if (!meta.has(k)) ops.push({ t: "meta-del", k });
    for (const [name, c] of Object.entries(COLLECTIONS)) {
      const cur = new Map();
      for (const rec of this.db[name] || []) cur.set(String(rec[c.key]), { json: JSON.stringify(rec), rec });
      next[name] = new Map([...cur].map(([k, v]) => [k, v.json]));
      for (const [k, v] of cur) if (this.snap[name].get(k) !== v.json) ops.push({ t: "row", name, k, json: v.json, rec: v.rec });
      const gone = [...this.snap[name].keys()].filter((k) => !cur.has(k));
      if (gone.length) ops.push({ t: "del", name, keys: gone });
    }
    return { ops, commit: () => { for (const k of Object.keys(next)) this.snap[k] = next[k]; } };
  }

  // Called by the server after it changes this.db. Writes happen in the background, one at a time.
  save() {
    if (this.queued) return; // a write is already waiting and will pick up this change too
    this.queued = true;
    const run = this.chain.then(() => { this.queued = false; return this._flush(); });
    this.pending = run;
    this.chain = run.catch(() => {});
  }

  async _flush() {
    const { ops, commit } = this._diff();
    this.lastFlush = { upserts: ops.filter((o) => o.t === "meta" || o.t === "row").length, deletes: ops.filter((o) => o.t.endsWith("del")).length };
    if (!ops.length) return;
    let client;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN");
      for (const o of ops) {
        if (o.t === "meta") await client.query("INSERT INTO cb_meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [o.k, o.json]);
        else if (o.t === "meta-del") await client.query("DELETE FROM cb_meta WHERE key = $1", [o.k]);
        else if (o.t === "del") await client.query(`DELETE FROM ${COLLECTIONS[o.name].table} WHERE ${COLLECTIONS[o.name].key} = ANY($1::text[])`, [o.keys]);
        else if (o.name === "patients") await client.query("INSERT INTO cb_patients (id, org_id, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO UPDATE SET org_id = EXCLUDED.org_id, data = EXCLUDED.data", [o.k, Number.isInteger(o.rec.orgId) ? o.rec.orgId : null, o.json]);
        else {
          const c = COLLECTIONS[o.name];
          await client.query(`INSERT INTO ${c.table} (${c.key}, data) VALUES ($1, $2::jsonb) ON CONFLICT (${c.key}) DO UPDATE SET data = EXCLUDED.data`, [o.k, o.json]);
        }
      }
      await client.query("COMMIT");
      commit(); // only now do we treat these rows as stored
    } catch (e) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      console.error("Database save failed, will retry:", e.message);
      if (!this.closed) setTimeout(() => { if (!this.closed) this.save(); }, 5000).unref(); // nothing is lost: the data is still in memory
      throw e;
    } finally {
      if (client) client.release();
    }
  }

  // Audit entries go to the cb_audit table, in order.
  audit(actor, action, detail) {
    const ts = new Date().toISOString();
    const run = this.auditChain.then(() =>
      this.pool.query("INSERT INTO cb_audit (ts, actor, action, detail) VALUES ($1, $2, $3, $4::jsonb)", [ts, actor, action, JSON.stringify(detail || {})]));
    this.auditPending = run;
    this.auditChain = run.catch((e) => { console.error("Audit write failed:", e.message); });
  }

  // Resolves when everything saved so far is committed. Rejects if a write failed.
  async settled() {
    await this.pending;
    await this.auditPending;
  }

  async close() {
    this.closed = true;
    try { await this.settled(); } catch { /* already logged */ }
    await this.pool.end();
  }
}

// Move data from the old db.json (and audit.log) into an empty database.
async function importLegacy(store, dir) {
  if (store.db.staff.length || store.db.patients.length || store.db.orgs.length) {
    throw new Error("The database already has data. Import only into an empty database.");
  }
  const file = path.join(dir, "db.json");
  if (!fs.existsSync(file)) throw new Error(`No db.json found in ${dir}`);
  const old = JSON.parse(fs.readFileSync(file, "utf8"));
  Object.assign(store.db, defaults(), old);
  store.save();
  await store.settled();
  let audits = 0;
  const af = path.join(dir, "audit.log");
  if (fs.existsSync(af)) {
    const rows = fs.readFileSync(af, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    for (const r of rows) {
      const { ts, actor, action, ...detail } = r;
      await store.pool.query("INSERT INTO cb_audit (ts, actor, action, detail) VALUES ($1, $2, $3, $4::jsonb)", [ts || new Date().toISOString(), actor || "", action || "", JSON.stringify(detail)]);
      audits++;
    }
  }
  return { staff: store.db.staff.length, patients: store.db.patients.length, orgs: store.db.orgs.length, audits };
}

// Write db.json and audit.log (same format as the file store) into a new folder. Used for backups,
// and lets you move back to file storage.
async function exportTo(store, targetDir) {
  const dest = path.join(path.resolve(targetDir), new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dest, "db.json"), JSON.stringify(store.db), { mode: 0o600 });
  const rows = (await store.pool.query("SELECT ts, actor, action, detail FROM cb_audit ORDER BY id")).rows;
  fs.writeFileSync(path.join(dest, "audit.log"),
    rows.map((r) => JSON.stringify({ ts: r.ts.toISOString(), actor: r.actor, action: r.action, ...r.detail })).join("\n") + (rows.length ? "\n" : ""),
    { mode: 0o600 });
  return { dest, patients: store.db.patients.length, audits: rows.length };
}

module.exports = { PgStore, importLegacy, exportTo, connectionConfig, COLLECTIONS };
