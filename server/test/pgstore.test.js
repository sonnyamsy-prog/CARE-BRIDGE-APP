"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server");
const { PgStore, importLegacy, exportTo, connectionConfig } = require("../lib/pgstore");

// ---- always run: connection settings ----
test("connection settings: SSL is chosen safely and sslmode in the URL cannot override it", () => {
  const c = (url, s) => connectionConfig(url, s);
  assert.strictEqual(c("postgres://u:p@localhost/db").ssl, false);
  assert.strictEqual(c("postgres://u:p@dpg-abc123-a/db").ssl, false);                        // Render internal address
  assert.deepStrictEqual(c("postgres://u:p@dpg-abc.oregon-postgres.render.com/db").ssl, { rejectUnauthorized: false });
  assert.deepStrictEqual(c("postgres://u:p@db.example.com/db", "verify").ssl, { rejectUnauthorized: true });
  assert.strictEqual(c("postgres://u:p@db.example.com/db", "0").ssl, false);
  assert.deepStrictEqual(c("postgres://u:p@localhost/db", "1").ssl, { rejectUnauthorized: false });
  assert.strictEqual(c("postgres://u:p@db.example.com/db?sslmode=disable").ssl, false);
  assert.deepStrictEqual(c("postgres://u:p@db.example.com/db?sslmode=verify-full").ssl, { rejectUnauthorized: true });
  assert.ok(!c("postgres://u:p@db.example.com/db?sslmode=require").connectionString.includes("sslmode"));
});

test("PgStore.connect explains a missing URL", async () => {
  await assert.rejects(PgStore.connect(""), /DATABASE_URL is not set/);
});

// ---- need a real database: set TEST_DATABASE_URL=postgres://user:pass@127.0.0.1/dbname ----
const URL_ = process.env.TEST_DATABASE_URL;
const needPg = { skip: URL_ ? false : "set TEST_DATABASE_URL to run the Postgres tests" };
async function wipe() {
  const { Pool } = require("pg");
  const p = new Pool({ connectionString: URL_ });
  await p.query("DROP TABLE IF EXISTS cb_meta, cb_staff, cb_orgs, cb_patients, cb_push, cb_audit");
  await p.end();
}
const open = () => PgStore.connect(URL_);
// Make every database connection fail, the way a real outage does. Returns a function that repairs it.
function breakDb(store) {
  const real = store.pool.connect;
  store.pool.connect = function (cb) {
    const err = new Error("database is down");
    if (typeof cb === "function") { cb(err); return undefined; } // the driver's own query() path
    return Promise.reject(err);
  };
  return () => { store.pool.connect = real; };
}
const patient = (id, extra = {}) => ({ id, code: "CB-" + id, name: "P" + id, dx: "x", status: "monitoring", checkins: [], log: [], ...extra });

test("a new database starts empty with the right defaults", needPg, async () => {
  await wipe();
  const s = await open();
  assert.deepStrictEqual(s.db, { next: 1001, nextOrg: 1, staff: [], patients: [], orgs: [], push: [] });
  await s.close();
});

test("saved data survives closing and reopening (a restart)", needPg, async () => {
  await wipe();
  const a = await open();
  a.db.staff.push({ id: "owner", name: "Owner", pin: "scrypt$x", admin: true }, { id: "amina", name: "Amina", pin: "scrypt$y", admin: false, orgId: 1 });
  a.db.orgs.push({ id: 1, code: "ORG-ABC234", name: "Org A", pin: "scrypt$z", createdAt: "2026-10-28", alertPhone: "+254711111111" });
  a.db.patients.push(patient(1001, { orgId: 1, checkins: [{ d: "2026-10-28", a: { br: true }, note: "tight chest", em: false, ack: false }], log: [{ by: "P", text: "hi" }] }), patient(1002));
  a.db.push.push({ endpoint: "https://push.example/1", kind: "org", id: 1, scope: 1 });
  a.db.vapid = { publicKey: "pub", privateKey: "priv" };
  a.db.next = 1003; a.db.nextOrg = 2;
  const expected = JSON.parse(JSON.stringify(a.db));
  a.save(); await a.settled(); await a.close();
  const b = await open();
  assert.deepStrictEqual(b.db, expected);
  const { rows } = await b.pool.query("SELECT id, org_id FROM cb_patients ORDER BY seq");
  assert.deepStrictEqual(rows.map((r) => r.org_id), [1, null]); // indexed column kept in step with the record
  await b.close();
});

test("a save writes only the records that changed, and removals are deleted", needPg, async () => {
  const s = await open();
  s.db.patients.find((p) => p.id === 1002).status = "closed";
  s.save(); await s.settled();
  assert.deepStrictEqual(s.lastFlush, { upserts: 1, deletes: 0 });
  s.save(); await s.settled();
  assert.deepStrictEqual(s.lastFlush, { upserts: 0, deletes: 0 });
  s.db.push.length = 0;
  s.save(); await s.settled();
  assert.deepStrictEqual(s.lastFlush, { upserts: 0, deletes: 1 });
  assert.strictEqual((await s.pool.query("SELECT count(*)::int AS n FROM cb_push")).rows[0].n, 0);
  await s.close();
  const t = await open();
  assert.strictEqual(t.db.patients.find((p) => p.id === 1002).status, "closed");
  assert.deepStrictEqual(t.db.push, []);
  await t.close();
});

test("many saves in one moment collapse into few writes and nothing is lost", needPg, async () => {
  const s = await open();
  for (let i = 0; i < 50; i++) { s.db.patients.push(patient(2000 + i)); s.save(); }
  await s.settled();
  assert.strictEqual((await s.pool.query("SELECT count(*)::int AS n FROM cb_patients")).rows[0].n, 52);
  await s.close();
});

test("a failed save keeps the data in memory and the next save writes everything", needPg, async () => {
  const s = await open();
  const repair = breakDb(s);
  const quiet = console.error; console.error = () => {};
  s.db.patients.push(patient(3001));
  s.save();
  await assert.rejects(s.settled(), /database is down/);
  console.error = quiet;
  repair();
  s.save(); await s.settled();                      // retry succeeds and includes the earlier change
  await s.close();
  const t = await open();
  assert.ok(t.db.patients.some((p) => p.id === 3001));
  await t.close();
});

test("audit entries are stored in order", needPg, async () => {
  const s = await open();
  s.audit("staff:owner", "login", {});
  s.audit("staff:owner", "org_created", { org: "ORG-ABC234" });
  s.audit("anonymous", "login_failed", { role: "staff", id: "x" });
  await s.settled();
  const { rows } = await s.pool.query("SELECT actor, action, detail FROM cb_audit ORDER BY id");
  assert.deepStrictEqual(rows.map((r) => r.action), ["login", "org_created", "login_failed"]);
  assert.strictEqual(rows[1].detail.org, "ORG-ABC234");
  await s.close();
});

test("the whole app keeps working across a restart on Postgres", needPg, async () => {
  await wipe();
  const call = (base) => async (method, p, body, token) => {
    const r = await fetch(base + "/api" + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  async function boot(env) {
    const store = await open();
    const app = createApp({ store, env: {}, ownerId: env.ownerId, ownerPin: env.ownerPin, transports: { push: async () => 201 } });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    return { call: call(base), stop: async () => { await new Promise((r) => app.server.close(r)); await store.close(); } };
  }

  // first run: owner is created from the environment
  let a = await boot({ ownerId: "owner", ownerPin: "owner-pin-1" });
  const login = (x, role, id, pin) => x.call("POST", "/login", { role, id, pin });
  const owner = (await login(a, "staff", "owner", "owner-pin-1")).json.token;
  const org = (await a.call("POST", "/orgs", { name: "Kisumu County Hospital", phone: "0711 222 333" }, owner)).json;
  const orgTok = (await login(a, "org", org.org.code, org.pin)).json.token;
  assert.strictEqual((await a.call("POST", "/staff", { id: "faith", name: "Faith", pin: "faith-pin-1" }, orgTok)).status, 200);
  const nurse = (await login(a, "staff", "faith", "faith-pin-1")).json.token;
  const reg = (await a.call("POST", "/patients", { name: "Joy Achieng", dx: "Asthma", phone: "0712345678" }, nurse)).json;
  const pat = (await login(a, "patient", reg.patient.code, reg.pin)).json.token;
  assert.strictEqual((await a.call("POST", `/patients/${reg.patient.id}/checkins`, { a: { meds: true, sw: false, br: true, fv: false }, note: "short of breath" }, pat)).status, 200);
  await a.stop();

  // restart: no owner variables needed, everything is still there
  const b = await boot({});
  assert.strictEqual((await login(b, "staff", "owner", "owner-pin-1")).status, 200);       // same PIN still works
  assert.strictEqual((await login(b, "org", org.org.code, org.pin)).status, 200);
  const nurse2 = (await login(b, "staff", "faith", "faith-pin-1")).json.token;
  const list = (await b.call("GET", "/patients", null, nurse2)).json;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].name, "Joy Achieng");
  assert.strictEqual(list[0].checkins.length, 1);
  assert.strictEqual(list[0].checkins[0].note, "short of breath");
  const orgs = (await b.call("GET", "/orgs", null, (await login(b, "staff", "owner", "owner-pin-1")).json.token)).json;
  assert.strictEqual(orgs[0].alertPhone, "+254711222333");
  assert.strictEqual(orgs[0].patients, 1);
  const store = await open();
  const actions = (await store.pool.query("SELECT action FROM cb_audit")).rows.map((r) => r.action);
  for (const want of ["owner_created", "org_created", "staff_created", "patient_registered", "checkin"]) assert.ok(actions.includes(want), want);
  const raw = JSON.stringify((await store.pool.query("SELECT data FROM cb_staff")).rows);
  assert.ok(!raw.includes("faith-pin-1") && raw.includes("scrypt$"), "PINs are stored hashed");
  await store.close();
  await b.stop();
});

test("a failed database write is reported to the user, not hidden", needPg, async () => {
  await wipe();
  const store = await open();
  const app = createApp({ store, env: {}, ownerId: "owner", ownerPin: "owner-pin-1" });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (p, body, token) => fetch(base + "/api" + p, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, body: JSON.stringify(body) });
  await store.settled();
  const token = (await (await post("/login", { role: "staff", id: "owner", pin: "owner-pin-1" })).json()).token;
  const repair = breakDb(store);
  const quiet = console.error; console.error = () => {};
  const r = await post("/orgs", { name: "Will Not Save" }, token);
  console.error = quiet;
  assert.strictEqual(r.status, 503);
  assert.match((await r.json()).error, /Could not save/);
  repair();
  await new Promise((r2) => app.server.close(r2));
  await store.close();
});

test("import moves the old db.json and audit.log in, export writes them back out", needPg, async () => {
  await wipe();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carebridge-legacy-"));
  const old = { next: 1005, nextOrg: 2, staff: [{ id: "owner", name: "Owner", pin: "scrypt$a", admin: true }], patients: [patient(1004, { orgId: 1 })], orgs: [{ id: 1, code: "ORG-ZZZ222", name: "Old Org", pin: "scrypt$b", createdAt: "2026-10-01" }] };
  fs.writeFileSync(path.join(dir, "db.json"), JSON.stringify(old));
  fs.writeFileSync(path.join(dir, "audit.log"), [{ ts: "2026-10-01T08:00:00.000Z", actor: "system", action: "owner_created", staff: "owner" }, { ts: "2026-10-01T08:05:00.000Z", actor: "staff:owner", action: "login" }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const s = await open();
  assert.deepStrictEqual(await importLegacy(s, dir), { staff: 1, patients: 1, orgs: 1, audits: 2 });
  await assert.rejects(importLegacy(s, dir), /already has data/);   // never overwrites existing data
  await s.close();

  const t = await open();
  assert.strictEqual(t.db.next, 1005);
  assert.strictEqual(t.db.patients[0].orgId, 1);
  const out = await exportTo(t, path.join(dir, "backups"));
  assert.strictEqual(out.audits, 2);
  const again = JSON.parse(fs.readFileSync(path.join(out.dest, "db.json"), "utf8"));
  assert.deepStrictEqual(again.staff, old.staff);
  assert.deepStrictEqual(again.patients, old.patients);
  assert.deepStrictEqual(again.orgs, old.orgs);
  const audit = fs.readFileSync(path.join(out.dest, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.strictEqual(audit[0].action, "owner_created");
  assert.strictEqual(audit[0].staff, "owner");
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
