"use strict";
// Alerts for CareBridge: SMS and web push. Plugged into server.js with createNotifier().
const { risk } = require("../lib/risk");
const { createSms } = require("./sms");
const { generateVapid, createPush, validEndpoint } = require("./push");

const URGENT_SMS_GAP_MS = 30 * 60e3; // at most one urgent SMS per patient every 30 minutes
const MAX_SUBS_PER_ACCOUNT = 10;

// env: process.env (or an object with the same names). t: optional test hooks { sms, push } transports.
function createNotifier({ db, store, env = {}, tz = "Africa/Nairobi", transports = {}, log = console }) {
  db.push = db.push || [];

  // --- SMS ---
  const sms = createSms({
    username: env.AT_USERNAME, apiKey: env.AT_API_KEY, sender: env.AT_SENDER_ID,
    sandbox: env.AT_SANDBOX === "1", countryCode: env.SMS_COUNTRY_CODE || "254",
    transport: transports.sms,
  }, log);
  const fallbackNumbers = String(env.ALERT_SMS_TO || "").split(",").map((x) => x.trim()).filter(Boolean);

  // --- Push: keys come from the environment, or are created once and kept in db.json ---
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    db.vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  } else if (!db.vapid) {
    db.vapid = generateVapid();
    store.save();
  }
  const push = createPush({ vapid: db.vapid, subject: env.VAPID_SUBJECT || "mailto:admin@example.com",
                            transport: transports.push }, log);

  // Who a subscription belongs to: "all" (owner), an organization id, or "none" (nurse with no organization).
  const scopeOf = (s) => (s.kind === "org" ? s.id : s.admin && !s.orgId ? "all" : s.orgId || "none");

  function subscribe(s, endpoint) {
    if (!validEndpoint(endpoint)) throw Object.assign(new Error("That alert subscription is not valid."), { status: 400 });
    const mine = db.push.filter((x) => x.kind === s.kind && x.id === s.id);
    if (!mine.some((x) => x.endpoint === endpoint) && mine.length >= MAX_SUBS_PER_ACCOUNT) {
      throw Object.assign(new Error("Too many devices have alerts on. Turn some off first."), { status: 400 });
    }
    db.push = db.push.filter((x) => x.endpoint !== endpoint); // a device belongs to one account at a time
    db.push.push({ endpoint, kind: s.kind, id: s.id, scope: scopeOf(s), added: new Date().toISOString() });
    store.save();
  }
  function unsubscribe(s, endpoint) {
    db.push = db.push.filter((x) => !(x.endpoint === endpoint && x.kind === s.kind && x.id === s.id));
    store.save();
  }

  // --- Urgent check-in: push to the right people, SMS to the organization's alert phone ---
  const lastSms = new Map();
  async function notifyUrgent(p) {
    const scope = p.orgId || "none";
    const subs = db.push.filter((x) => x.scope === "all" || x.scope === scope);
    const pushed = await Promise.all(subs.map(async (x) => ({ x, r: await push.send(x.endpoint) })));
    const gone = new Set(pushed.filter((o) => o.r === "gone").map((o) => o.x.endpoint));
    if (gone.size) { db.push = db.push.filter((x) => !gone.has(x.endpoint)); store.save(); }

    let smsResult = { sent: 0, failed: 0 };
    if (Date.now() - (lastSms.get(p.id) || 0) > URGENT_SMS_GAP_MS) {
      const org = p.orgId ? (db.orgs || []).find((o) => o.id === p.orgId) : null;
      const to = org && org.alertPhone ? [org.alertPhone] : fallbackNumbers;
      if (to.length) {
        lastSms.set(p.id, Date.now());
        // Patient code only: no name or health details in an SMS.
        smsResult = await sms.send(to, `CareBridge URGENT: check-in for ${p.code} needs a call now. Open the app.`);
      }
    }
    return { pushed: pushed.filter((o) => o.r === "sent").length, sms: smsResult.sent };
  }

  // Called by server.js right after a check-in is saved. Never throws, never delays the reply.
  function afterCheckin(p, checkin) {
    if (risk(checkin.a, checkin.em) !== "red") return;
    notifyUrgent(p).catch((e) => log.error("Alert failed:", e.message));
  }

  // --- Daily SMS reminder to patients who have not checked in yet (off unless REMINDER_HOUR is set) ---
  const hour = env.REMINDER_HOUR === undefined || env.REMINDER_HOUR === "" ? null : Number(env.REMINDER_HOUR);
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const hourNow = () => Number(new Date().toLocaleString("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }));
  async function sendReminders() {
    if (hour === null || !sms.enabled || hourNow() < hour) return 0;
    const d = today(); let n = 0;
    for (const p of db.patients) {
      const done = p.checkins.length && p.checkins[p.checkins.length - 1].d === d;
      if (p.status !== "monitoring" || done || p.reminded === d || !sms.normalize(p.phone)) continue;
      p.reminded = d; // mark first so a slow provider never causes a double send
      const r = await sms.send([p.phone], "CareBridge: please do today's check-in. Open the app and answer the 4 questions.");
      n += r.sent;
    }
    store.save();
    return n;
  }
  function startReminders() {
    if (hour === null || !sms.enabled) return null;
    const t = setInterval(() => sendReminders().catch((e) => log.error("Reminders failed:", e.message)), 10 * 60e3);
    t.unref();
    return t;
  }

  return { sms, push, publicKey: push.publicKey, subscribe, unsubscribe, notifyUrgent, afterCheckin,
           sendReminders, startReminders, validPhone: (n) => !!sms.normalize(n) };
}

module.exports = { createNotifier };
