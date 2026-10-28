"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server");

let base, close, dir;
async function call(method, p, body, token) {
  const r = await fetch(base + "/api" + p, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json(), headers: r.headers };
}
const login = (role, id, pin) => call("POST", "/login", { role, id, pin });

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "carebridge-"));
  const { server } = createApp({ dataDir: dir, ownerId: "owner", ownerPin: "owner-pin-1", maxFails: 3 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  close = () => new Promise((r) => server.close(r));
});
test.after(async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); });

let owner, nurse, patient, patient2, p1, p2;

test("api requires sign-in", async () => {
  assert.strictEqual((await call("GET", "/patients")).status, 401);
  assert.strictEqual((await call("GET", "/patients", null, "bad-token")).status, 401);
});

test("owner signs in; bad PIN is rejected", async () => {
  assert.strictEqual((await login("staff", "owner", "wrong")).status, 401);
  const r = await login("staff", "OWNER", "owner-pin-1");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.role, "nurse");
  assert.strictEqual(r.json.admin, true);
  owner = r.json.token;
});

test("only the owner can create nurses; PIN rules are enforced", async () => {
  assert.strictEqual((await call("POST", "/staff", { id: "grace", name: "Nurse Grace", pin: "123" }, owner)).status, 400);
  assert.strictEqual((await call("POST", "/staff", { id: "grace", name: "Nurse Grace", pin: "grace-pin-1" }, owner)).status, 200);
  assert.strictEqual((await call("POST", "/staff", { id: "grace", name: "Dup", pin: "grace-pin-1" }, owner)).status, 409);
  nurse = (await login("staff", "grace", "grace-pin-1")).json;
  assert.strictEqual(nurse.admin, false);
  assert.strictEqual((await call("POST", "/staff", { id: "x1234", name: "X", pin: "abcdef" }, nurse.token)).status, 403);
});

test("nurse registers patients and gets a one-time 6-digit PIN; hashes never leak", async () => {
  assert.strictEqual((await call("POST", "/patients", { name: "", dx: "" }, nurse.token)).status, 400);
  const a = await call("POST", "/patients", { name: "Amina Otieno", age: "54", dx: "Heart failure", ward: "A", meds: "Furosemide" }, nurse.token);
  assert.strictEqual(a.status, 200);
  assert.match(a.json.pin, /^\d{6}$/);
  assert.match(a.json.patient.code, /^CB-\d+$/);
  assert.ok(!("pin" in a.json.patient));
  const b = await call("POST", "/patients", { name: "Peter Odhiambo", dx: "Pneumonia" }, nurse.token);
  p1 = { ...a.json.patient, pin: a.json.pin }; p2 = { ...b.json.patient, pin: b.json.pin };
  const list = await call("GET", "/patients", null, nurse.token);
  assert.strictEqual(list.json.length, 2);
  assert.ok(!JSON.stringify(list.json).includes("scrypt$"));
});

test("patient signs in and sees only their own record", async () => {
  patient = (await login("patient", p1.code.toLowerCase(), p1.pin)).json;
  patient2 = (await login("patient", p2.code, p2.pin)).json;
  assert.strictEqual(patient.role, "patient");
  const mine = await call("GET", "/patients", null, patient.token);
  assert.strictEqual(mine.json.length, 1);
  assert.strictEqual(mine.json[0].id, p1.id);
  assert.strictEqual((await call("POST", `/patients/${p2.id}/log`, { text: "hi" }, patient.token)).status, 404);
  assert.strictEqual((await call("POST", `/patients/${p2.id}/checkins`, { a: { meds: true, sw: false, br: false, fv: false } }, patient.token)).status, 404);
});

test("patients cannot do staff actions", async () => {
  assert.strictEqual((await call("POST", "/patients", { name: "X", dx: "Y" }, patient.token)).status, 403);
  assert.strictEqual((await call("POST", `/patients/${p1.id}/resetpin`, null, patient.token)).status, 403);
  assert.strictEqual((await call("POST", `/patients/${p1.id}/status`, { status: "closed" }, patient.token)).status, 403);
  assert.strictEqual((await call("POST", `/patients/${p1.id}/checkins/0/ack`, null, patient.token)).status, 403);
});

test("check-in needs all four answers; emergency note is flagged", async () => {
  assert.strictEqual((await call("POST", `/patients/${p1.id}/checkins`, { a: { meds: true } }, patient.token)).status, 400);
  const r = await call("POST", `/patients/${p1.id}/checkins`,
    { a: { meds: true, sw: false, br: false, fv: false }, note: "I have chest pain" }, patient.token);
  assert.strictEqual(r.status, 200);
  const rec = (await call("GET", "/patients", null, patient.token)).json[0];
  assert.strictEqual(rec.checkins.length, 1);
  assert.strictEqual(rec.checkins[0].em, true);
  assert.strictEqual(rec.checkins[0].ack, false);
  assert.strictEqual(rec.log.at(-1).role, "patient");
});

test("nurse acknowledges the alert and replies", async () => {
  assert.strictEqual((await call("POST", `/patients/${p1.id}/checkins/9/ack`, null, nurse.token)).status, 404);
  assert.strictEqual((await call("POST", `/patients/${p1.id}/checkins/0/ack`, null, nurse.token)).status, 200);
  assert.strictEqual((await call("POST", `/patients/${p1.id}/log`, { text: "Please go to the clinic now." }, nurse.token)).status, 200);
  const rec = (await call("GET", "/patients", null, patient.token)).json[0];
  assert.strictEqual(rec.checkins[0].ack, true);
  assert.strictEqual(rec.log.at(-1).by, "Nurse Grace");
  assert.strictEqual(rec.log.at(-1).role, "nurse");
});

test("closing monitoring blocks patient check-ins and messages; reopening restores them", async () => {
  assert.strictEqual((await call("POST", `/patients/${p1.id}/status`, { status: "bogus" }, nurse.token)).status, 400);
  assert.strictEqual((await call("POST", `/patients/${p1.id}/status`, { status: "closed" }, nurse.token)).status, 200);
  const a = { meds: true, sw: false, br: false, fv: false };
  assert.strictEqual((await call("POST", `/patients/${p1.id}/checkins`, { a }, patient.token)).status, 409);
  assert.strictEqual((await call("POST", `/patients/${p1.id}/log`, { text: "hello" }, patient.token)).status, 409);
  assert.strictEqual((await call("POST", `/patients/${p1.id}/status`, { status: "monitoring" }, nurse.token)).status, 200);
  assert.strictEqual((await call("POST", `/patients/${p1.id}/checkins`, { a }, patient.token)).status, 200);
});

test("resetting a PIN invalidates the old PIN and old sessions", async () => {
  const r = await call("POST", `/patients/${p2.id}/resetpin`, null, nurse.token);
  assert.match(r.json.pin, /^\d{6}$/);
  assert.notStrictEqual(r.json.pin, p2.pin);
  assert.strictEqual((await call("GET", "/patients", null, patient2.token)).status, 401);
  assert.strictEqual((await login("patient", p2.code, p2.pin)).status, 401);
  assert.strictEqual((await login("patient", p2.code, r.json.pin)).status, 200);
});

test("repeated wrong PINs lock the account, even for the right PIN", async () => {
  for (let i = 0; i < 3; i++) assert.strictEqual((await login("staff", "grace", "nope" + i)).status, 401);
  assert.strictEqual((await login("staff", "grace", "grace-pin-1")).status, 429);
});

test("logout ends the session", async () => {
  assert.strictEqual((await call("POST", "/logout", null, owner)).status, 200);
  assert.strictEqual((await call("GET", "/patients", null, owner)).status, 401);
});

test("api responses are never cached; security headers are set", async () => {
  const r = await call("POST", "/login", { role: "staff", id: "x", pin: "y" });
  assert.strictEqual(r.headers.get("cache-control"), "no-store");
  assert.strictEqual(r.headers.get("x-content-type-options"), "nosniff");
  assert.ok(r.headers.get("content-security-policy").includes("default-src 'self'"));
});

test("static files are served; path traversal is blocked", async () => {
  const idx = await fetch(base + "/");
  assert.strictEqual(idx.status, 200);
  assert.match(await idx.text(), /CareBridge/);
  assert.strictEqual((await fetch(base + "/sw.js")).headers.get("cache-control"), "no-cache");
  assert.strictEqual((await fetch(base + "/manifest.webmanifest")).status, 200);
  assert.strictEqual((await fetch(base + "/..%2fserver%2fserver.js")).status, 404);
  assert.strictEqual((await fetch(base + "/..%2f..%2fetc%2fpasswd")).status, 404);
});

test("audit log records actions without PINs", () => {
  const log = fs.readFileSync(path.join(dir, "audit.log"), "utf8");
  assert.match(log, /patient_registered/);
  assert.match(log, /alert_acknowledged/);
  assert.match(log, /login_failed/);
  assert.ok(!log.includes("owner-pin-1") && !log.includes(p1.pin));
});

test("server refuses to start without an owner on first run", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "carebridge-"));
  assert.throws(() => createApp({ dataDir: d }), /OWNER_ID/);
  fs.rmSync(d, { recursive: true, force: true });
});

// ---------------- organizations ----------------
let orgA, orgB, nurseA;

test("only the owner can create organizations; code and one-time PIN are returned", async () => {
  owner = (await login("staff", "owner", "owner-pin-1")).json.token; // an earlier test signed the owner out
  assert.strictEqual((await call("POST", "/orgs", { name: "Nope" }, nurse.token)).status, 403);
  assert.strictEqual((await call("POST", "/orgs", { name: "" }, owner)).status, 400);
  const a = await call("POST", "/orgs", { name: "Kisumu County Hospital" }, owner);
  assert.strictEqual(a.status, 200);
  assert.match(a.json.org.code, /^ORG-[A-Z2-9]{6}$/);
  assert.match(a.json.pin, /^\d{6}$/);
  assert.ok(!JSON.stringify(a.json).includes("scrypt$"));
  const b = await call("POST", "/orgs", { name: "Lakeside Clinic" }, owner);
  assert.notStrictEqual(a.json.org.code, b.json.org.code);
  assert.strictEqual((await call("POST", "/orgs", { name: "kisumu county hospital" }, owner)).status, 409);
  orgA = { ...a.json.org, pin: a.json.pin }; orgB = { ...b.json.org, pin: b.json.pin };
});

test("organization signs in with its code and PIN; wrong PIN is rejected", async () => {
  assert.strictEqual((await login("org", orgA.code, "000000x")).status, 401);
  const r = await login("org", orgA.code.toLowerCase(), orgA.pin);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.role, "org");
  assert.strictEqual(r.json.user, "Kisumu County Hospital");
  orgA.token = r.json.token;
  orgB.token = (await login("org", orgB.code, orgB.pin)).json.token;
  // an organization code does not work as a staff ID, and vice versa
  assert.strictEqual((await login("staff", orgA.code, orgA.pin)).status, 401);
  assert.strictEqual((await login("org", "owner", "owner-pin-1")).status, 401);
});

test("organization adds its own nurses; they are linked to it", async () => {
  assert.strictEqual((await call("POST", "/staff", { id: "faith", name: "Nurse Faith", pin: "123" }, orgA.token)).status, 400);
  assert.strictEqual((await call("POST", "/staff", { id: "faith", name: "Nurse Faith", pin: "faith-pin-1" }, orgA.token)).status, 200);
  const mine = await call("GET", "/staff", null, orgA.token);
  assert.deepStrictEqual(mine.json.map((x) => x.id), ["faith"]);
  assert.strictEqual((await call("GET", "/staff", null, orgB.token)).json.length, 0);
  nurseA = (await login("staff", "faith", "faith-pin-1")).json;
});

test("patients stay inside their organization", async () => {
  const r = await call("POST", "/patients", { name: "Joy Achieng", dx: "Asthma" }, nurseA.token);
  assert.strictEqual(r.status, 200);
  const pid = r.json.patient.id;
  assert.strictEqual((await call("GET", "/patients", null, nurseA.token)).json.length, 1); // not the 2 org-less patients
  assert.strictEqual((await call("GET", "/patients", null, nurse.token)).json.length, 2);   // org-less nurse unchanged
  assert.strictEqual((await call("GET", "/patients", null, owner)).json.length, 3);          // owner sees everything
  assert.strictEqual((await call("GET", "/patients", null, orgA.token)).json.length, 1);
  assert.strictEqual((await call("GET", "/patients", null, orgB.token)).json.length, 0);
  assert.strictEqual((await call("POST", `/patients/${pid}/status`, { status: "closed" }, nurse.token)).status, 404);
});

test("an organization can read its patients but not act on them or see messages", async () => {
  const [p] = (await call("GET", "/patients", null, orgA.token)).json;
  assert.deepStrictEqual(p.log, []);
  assert.ok(p.checkins.length <= 1);
  assert.strictEqual((await call("POST", `/patients/${p.id}/log`, { text: "hi" }, orgA.token)).status, 403);
  assert.strictEqual((await call("POST", `/patients/${p.id}/status`, { status: "closed" }, orgA.token)).status, 403);
  assert.strictEqual((await call("POST", "/patients", { name: "X", dx: "Y" }, orgA.token)).status, 403);
  assert.strictEqual((await call("POST", "/orgs", { name: "Sneaky" }, orgA.token)).status, 403);
});

test("owner lists organizations and can reset an organization PIN", async () => {
  const list = await call("GET", "/orgs", null, owner);
  assert.strictEqual(list.status, 200);
  const a = list.json.find((o) => o.code === orgA.code);
  assert.strictEqual(a.patients, 1);
  assert.strictEqual(a.staff, 1);
  assert.ok(!JSON.stringify(list.json).includes("scrypt$"));
  assert.strictEqual((await call("GET", "/orgs", null, nurse.token)).status, 403);
  const reset = await call("POST", `/orgs/${orgA.id}/resetpin`, null, owner);
  assert.match(reset.json.pin, /^\d{6}$/);
  assert.strictEqual((await call("GET", "/patients", null, orgA.token)).status, 401); // old session ended
  assert.strictEqual((await login("org", orgA.code, orgA.pin)).status, 401);          // old PIN stops working
  assert.strictEqual((await login("org", orgA.code, reset.json.pin)).status, 200);
});

test("organizations are stored on disk and survive a restart; old data files are upgraded", () => {
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "db.json"), "utf8"));
  assert.strictEqual(saved.orgs.length, 2);
  assert.ok(saved.orgs.every((o) => o.pin.startsWith("scrypt$")));
  const old = fs.mkdtempSync(path.join(os.tmpdir(), "carebridge-"));
  fs.writeFileSync(path.join(old, "db.json"), JSON.stringify({ next: 1005, staff: [{ id: "owner", name: "Owner", pin: "x", admin: true }], patients: [] }));
  const { store } = createApp({ dataDir: old });
  assert.deepStrictEqual(store.db.orgs, []);
  fs.rmSync(old, { recursive: true, force: true });
  const audit = fs.readFileSync(path.join(dir, "audit.log"), "utf8");
  assert.match(audit, /org_created/);
  assert.ok(!audit.includes(orgA.pin));
});
