"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server");
const { normalizePhone, createSms } = require("../sms-push/sms");
const { generateVapid, vapidHeader, createPush, validEndpoint } = require("../sms-push/push");

const quiet = { log() {}, error() {} };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("phone numbers are normalised to international format", () => {
  assert.strictEqual(normalizePhone("0712 345 678"), "+254712345678");
  assert.strictEqual(normalizePhone("+254 712-345-678"), "+254712345678");
  assert.strictEqual(normalizePhone("254712345678"), "+254712345678");
  assert.strictEqual(normalizePhone("0712345678", "255"), "+255712345678");
  assert.strictEqual(normalizePhone("12345"), null);
  assert.strictEqual(normalizePhone("call me"), null);
  assert.strictEqual(normalizePhone(""), null);
});

test("sms: disabled without credentials, sends and counts with a transport, never throws", async () => {
  const off = createSms({}, quiet);
  assert.strictEqual(off.enabled, false);
  assert.deepStrictEqual(await off.send(["0712345678"], "x"), { sent: 0, failed: 0 });
  const calls = [];
  const on = createSms({ transport: async (to, msg) => { calls.push({ to, msg }); return to.map((n) => ({ number: n, ok: true })); } }, quiet);
  const r = await on.send(["0712345678", "+254712345678", "bad"], "hello");
  assert.deepStrictEqual(r, { sent: 1, failed: 0 }); // duplicates and invalid numbers are dropped
  assert.deepStrictEqual(calls[0].to, ["+254712345678"]);
  const broken = createSms({ transport: async () => { throw new Error("down"); } }, quiet);
  assert.deepStrictEqual(await broken.send(["0712345678"], "x"), { sent: 0, failed: 1 });
});

test("push: VAPID key is valid and the signed header verifies", () => {
  const v = generateVapid();
  assert.strictEqual(Buffer.from(v.publicKey, "base64url").length, 65);
  const h = vapidHeader("https://fcm.googleapis.com/fcm/send/abc", v, "mailto:a@b.co");
  const [, t, k] = h.match(/^vapid t=(.+), k=(.+)$/);
  assert.strictEqual(k, v.publicKey);
  const [head, claims, sig] = t.split(".");
  const c = JSON.parse(Buffer.from(claims, "base64url"));
  assert.strictEqual(c.aud, "https://fcm.googleapis.com");
  assert.strictEqual(c.sub, "mailto:a@b.co");
  assert.ok(c.exp > Date.now() / 1000 && c.exp <= Date.now() / 1000 + 13 * 3600);
  const pub = Buffer.from(v.publicKey, "base64url");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256",
    x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
});

test("push: send reports sent, gone and failed; endpoints must be https", async () => {
  const v = generateVapid();
  for (const [status, want] of [[201, "sent"], [410, "gone"], [404, "gone"], [500, "failed"]]) {
    const p = createPush({ vapid: v, subject: "mailto:a@b.co", transport: async (_e, headers) => {
      assert.strictEqual(headers["Content-Length"], "0"); // no payload, so no patient data leaves the server
      return status;
    } }, quiet);
    assert.strictEqual(await p.send("https://push.example/x"), want);
  }
  assert.ok(validEndpoint("https://push.example/x"));
  assert.ok(!validEndpoint("http://push.example/x"));
  assert.ok(!validEndpoint("javascript:alert(1)"));
  assert.ok(!validEndpoint("https://" + "a".repeat(700)));
});

// ---------- end to end through the real server ----------
let base, close, dir, sent;
async function call(method, p, body, token) {
  const r = await fetch(base + "/api" + p, { method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}
const login = (role, id, pin) => call("POST", "/login", { role, id, pin });
const URGENT = { a: { meds: true, sw: false, br: true, fv: false }, note: "" };
const MILD = { a: { meds: true, sw: false, br: false, fv: false }, note: "" };

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "carebridge-notify-"));
  sent = { sms: [], push: [], gone: new Set() };
  const { server } = createApp({
    dataDir: dir, ownerId: "owner", ownerPin: "owner-pin-1",
    env: { ALERT_SMS_TO: "0700000000", VAPID_SUBJECT: "mailto:t@t.co" },
    transports: {
      sms: async (to, msg) => { sent.sms.push({ to, msg }); return to.map((n) => ({ number: n, ok: true })); },
      push: async (endpoint) => { sent.push.push(endpoint); return sent.gone.has(endpoint) ? 410 : 201; },
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  close = () => new Promise((r) => server.close(r));
});
test.after(async () => { await close(); fs.rmSync(dir, { recursive: true, force: true }); });

let owner, orgA, orgB, nurseA, patA, patLegacy;
const ep = (n) => `https://push.example/${n}`;

test("setup: owner, two organizations (one with an alert phone), a nurse and patients", async () => {
  owner = (await login("staff", "owner", "owner-pin-1")).json.token;
  assert.strictEqual((await call("POST", "/orgs", { name: "Bad Phone", phone: "12" }, owner)).status, 400);
  const a = await call("POST", "/orgs", { name: "Org A", phone: "0711 111 111" }, owner);
  const b = await call("POST", "/orgs", { name: "Org B" }, owner);
  assert.strictEqual(a.status, 200);
  orgA = { ...a.json.org, token: (await login("org", a.json.org.code, a.json.pin)).json.token };
  orgB = { ...b.json.org, token: (await login("org", b.json.org.code, b.json.pin)).json.token };
  assert.strictEqual((await call("GET", "/orgs", null, owner)).json.find((o) => o.id === orgA.id).alertPhone, "+254711111111");
  await call("POST", "/staff", { id: "amina", name: "Amina", pin: "amina-pin-1" }, orgA.token);
  nurseA = (await login("staff", "amina", "amina-pin-1")).json.token;
  const r = await call("POST", "/patients", { name: "Joy", dx: "Asthma" }, nurseA);
  patA = { code: r.json.patient.code, id: r.json.patient.id, pin: r.json.pin };
  patA.token = (await login("patient", patA.code, patA.pin)).json.token;
  const l = await call("POST", "/patients", { name: "Old", dx: "Flu" }, owner); // belongs to no organization
  patLegacy = { code: l.json.patient.code, pin: l.json.pin };
  patLegacy.token = (await login("patient", patLegacy.code, patLegacy.pin)).json.token;
});

test("push subscriptions: staff and organizations only, https only, listed key is public", async () => {
  assert.strictEqual((await call("GET", "/push/key")).status, 401);
  assert.strictEqual((await call("GET", "/push/key", null, patA.token)).status, 403);
  const key = await call("GET", "/push/key", null, owner);
  assert.strictEqual(Buffer.from(key.json.key, "base64url").length, 65);
  assert.ok(!JSON.stringify(key.json).includes("privateKey"));
  assert.strictEqual((await call("POST", "/push/subscribe", { endpoint: "http://x.test/a" }, owner)).status, 400);
  assert.strictEqual((await call("POST", "/push/subscribe", { endpoint: ep("owner") }, owner)).status, 200);
  assert.strictEqual((await call("POST", "/push/subscribe", { endpoint: ep("orgA") }, orgA.token)).status, 200);
  assert.strictEqual((await call("POST", "/push/subscribe", { endpoint: ep("orgB") }, orgB.token)).status, 200);
  assert.strictEqual((await call("POST", "/push/subscribe", { endpoint: ep("amina") }, nurseA)).status, 200);
  assert.strictEqual((await call("POST", "/push/subscribe", { endpoint: ep("pat") }, patA.token)).status, 403);
});

test("a mild check-in sends nothing", async () => {
  const before = { sms: sent.sms.length, push: sent.push.length };
  assert.strictEqual((await call("POST", `/patients/${patA.id}/checkins`, MILD, patA.token)).status, 200);
  await wait(100);
  assert.deepStrictEqual({ sms: sent.sms.length, push: sent.push.length }, before);
});

test("an urgent check-in alerts the owner, that organization and its nurses, and SMSes the org phone", async () => {
  sent.sms.length = 0; sent.push.length = 0;
  assert.strictEqual((await call("POST", `/patients/${patA.id}/checkins`, URGENT, patA.token)).status, 200);
  await wait(150);
  assert.deepStrictEqual([...sent.push].sort(), [ep("amina"), ep("orgA"), ep("owner")]); // not Org B
  assert.strictEqual(sent.sms.length, 1);
  assert.deepStrictEqual(sent.sms[0].to, ["+254711111111"]);
  assert.match(sent.sms[0].msg, new RegExp(patA.code));
  assert.ok(!sent.sms[0].msg.includes("Joy"), "SMS must not contain the patient's name");
});

test("repeat urgent check-ins do not spam SMS (30 minute gap)", async () => {
  sent.sms.length = 0;
  await call("POST", `/patients/${patA.id}/checkins`, URGENT, patA.token);
  await wait(150);
  assert.strictEqual(sent.sms.length, 0);
});

test("a patient with no organization alerts the owner and the fallback number, not organizations", async () => {
  sent.sms.length = 0; sent.push.length = 0;
  await call("POST", `/patients/${(await call("GET", "/patients", null, owner)).json.find((p) => p.code === patLegacy.code).id}/checkins`, URGENT, patLegacy.token);
  await wait(150);
  assert.deepStrictEqual(sent.push, [ep("owner")]);
  assert.deepStrictEqual(sent.sms[0].to, ["+254700000000"]);
});

test("expired subscriptions are removed; unsubscribe works; alerts never block the check-in", async () => {
  sent.gone.add(ep("amina"));
  const r = await call("POST", "/patients", { name: "Zed", dx: "Fever" }, nurseA);
  const z = { id: r.json.patient.id, token: (await login("patient", r.json.patient.code, r.json.pin)).json.token };
  assert.strictEqual((await call("POST", `/patients/${z.id}/checkins`, URGENT, z.token)).status, 200);
  await wait(150);
  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, "db.json"), "utf8"));
  assert.ok(!saved().push.some((x) => x.endpoint === ep("amina")), "410 removes the subscription");
  await call("POST", "/push/unsubscribe", { endpoint: ep("orgA") }, orgA.token);
  assert.ok(!saved().push.some((x) => x.endpoint === ep("orgA")));
  assert.ok(saved().vapid.publicKey, "VAPID keys are stored so they survive restarts");
});

test("daily reminders: only monitoring patients with a phone who have not checked in", async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "carebridge-rem-"));
  const outbox = [];
  const app = createApp({ dataDir: dir2, ownerId: "owner", ownerPin: "owner-pin-1",
    env: { REMINDER_HOUR: "0" },
    transports: { sms: async (to) => { outbox.push(...to); return to.map((n) => ({ number: n, ok: true })); }, push: async () => 201 } });
  const { db } = app.store;
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
  const mk = (id, phone, status, checkins) => db.patients.push({ id, code: "CB-" + id, name: "P" + id, phone, status, checkins, log: [], dx: "x" });
  mk(1, "0712000001", "monitoring", []);                    // gets a reminder
  mk(2, "0712000002", "monitoring", [{ d: day }]);          // already checked in today
  mk(3, "0712000003", "closed", []);                        // monitoring ended
  mk(4, "", "monitoring", []);                              // no phone number
  mk(5, "not a phone", "monitoring", []);                   // invalid number
  assert.strictEqual(await app.notify.sendReminders(), 1);
  assert.deepStrictEqual(outbox, ["+254712000001"]);
  assert.strictEqual(await app.notify.sendReminders(), 0);  // never twice in a day
  fs.rmSync(dir2, { recursive: true, force: true });
});
