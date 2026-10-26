"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { isEmergency } = require("./lib/risk");
const { hashPin, verifyPin, randomPin, Sessions, Throttle } = require("./lib/auth");
const { Store } = require("./lib/store");

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json", ".png": "image/png",
  ".json": "application/json", ".css": "text/css; charset=utf-8", ".ico": "image/x-icon",
};

function createApp(opts = {}) {
  const cfg = {
    dataDir: opts.dataDir || process.env.DATA_DIR || path.join(__dirname, "data"),
    tz: opts.tz || process.env.TZ_NAME || "Africa/Nairobi",
    ownerId: (opts.ownerId || process.env.OWNER_ID || "").toLowerCase(),
    ownerPin: opts.ownerPin || process.env.OWNER_PIN || "",
    sessionHours: Number(opts.sessionHours || process.env.SESSION_HOURS || 12),
    trustProxy: (opts.trustProxy ?? process.env.TRUST_PROXY) === "1" || opts.trustProxy === true,
    maxFails: Number(opts.maxFails || 5),
    hsts: !!opts.hsts,
  };
  const store = new Store(cfg.dataDir);
  const db = store.db;
  const sessions = new Sessions(cfg.sessionHours);
  const throttle = new Throttle(cfg.maxFails);

  // First run: create the owner account from the environment.
  if (!db.staff.length) {
    if (!cfg.ownerId || cfg.ownerPin.length < 6) {
      throw new Error("First run: set OWNER_ID and OWNER_PIN (6+ characters) to create the owner account.");
    }
    db.staff.push({ id: cfg.ownerId, name: "Owner", pin: hashPin(cfg.ownerPin), admin: true });
    store.save();
    store.audit("system", "owner_created", { staff: cfg.ownerId });
  }

  // ---- helpers ----
  const now = () => {
    const d = new Date();
    return {
      d: d.toLocaleDateString("en-CA", { timeZone: cfg.tz }),
      t: d.toLocaleTimeString("en-GB", { timeZone: cfg.tz, hour: "2-digit", minute: "2-digit" }),
    };
  };
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const bad = (msg) => new HttpError(400, msg);
  const str = (v, max, field, required) => {
    const s = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
    if (required && !s) throw bad(`${field} is required.`);
    if (s.length > max) throw bad(`${field} is too long.`);
    return s;
  };
  const clientIp = (req) =>
    (cfg.trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) ||
    req.socket.remoteAddress || "?";
  const safe = (p) => { const { pin, ...rest } = p; return rest; }; // never send the PIN hash
  const findPatient = (id) => db.patients.find((p) => p.id === Number(id));

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > 100_000) { reject(new HttpError(413, "Request too large.")); req.destroy(); }
        else chunks.push(c);
      });
      req.on("end", () => {
        if (!chunks.length) return resolve({});
        try { const j = JSON.parse(Buffer.concat(chunks).toString("utf8")); resolve(j && typeof j === "object" ? j : {}); }
        catch { reject(bad("Invalid JSON.")); }
      });
      req.on("error", reject);
    });
  }

  function auth(req) {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    const s = sessions.get(token);
    if (!s) throw new HttpError(401, "Please sign in.");
    return { s, token };
  }
  const needStaff = (s) => { if (s.kind !== "staff") throw new HttpError(403, "Not allowed."); };
  function canSee(s, p) {
    if (!p) throw new HttpError(404, "Patient not found.");
    if (s.kind === "patient" && s.id !== p.id) throw new HttpError(404, "Patient not found.");
    return p;
  }
  const actorName = (s) => (s.kind === "staff" ? `staff:${s.id}` : `patient:${s.code}`);

  // ---- API ----
  async function api(req, res, url) {
    const m = req.method, parts = url.pathname.split("/").filter(Boolean).slice(1); // after "api"
    const route = parts[0];

    if (route === "login" && m === "POST") {
      const b = await readJson(req);
      const role = b.role === "patient" ? "patient" : "staff";
      const id = String(b.id || "").trim();
      const key = `${role}:${id.toLowerCase()}:${clientIp(req)}`;
      if (throttle.locked(key)) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
      const acct = role === "staff"
        ? db.staff.find((x) => x.id === id.toLowerCase())
        : db.patients.find((x) => x.code === id.toUpperCase());
      const ok = verifyPin(String(b.pin || ""), acct && acct.pin) && !!acct;
      if (!ok) {
        throttle.fail(key);
        store.audit("anonymous", "login_failed", { role, id: id.slice(0, 40) });
        throw new HttpError(401, "Wrong ID or PIN.");
      }
      throttle.ok(key);
      const data = role === "staff"
        ? { kind: "staff", id: acct.id, name: acct.name, admin: !!acct.admin }
        : { kind: "patient", id: acct.id, code: acct.code, name: acct.name };
      const token = sessions.create(data);
      store.audit(actorName(data), "login", {});
      return { token, role: role === "staff" ? "nurse" : "patient", user: acct.name,
               admin: !!acct.admin, pid: role === "patient" ? acct.id : null };
    }

    const { s, token } = auth(req);

    if (route === "logout" && m === "POST") { sessions.destroy(token); return { ok: true }; }

    if (route === "patients" && parts.length === 1) {
      if (m === "GET") {
        const list = s.kind === "staff" ? db.patients : db.patients.filter((p) => p.id === s.id);
        return list.map(safe);
      }
      if (m === "POST") {
        needStaff(s);
        const b = await readJson(req);
        const name = str(b.name, 100, "Name", true), dx = str(b.dx, 200, "Diagnosis", true);
        const dd = str(b.dd, 10, "Discharge date") || now().d;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dd) || Number.isNaN(Date.parse(dd))) throw bad("Discharge date is not valid.");
        const id = db.next++, pin = randomPin(6);
        const p = { id, code: "CB-" + id, pin: hashPin(pin), name, age: str(b.age, 3, "Age"),
          phone: str(b.phone, 30, "Phone"), dx, ward: str(b.ward, 100, "Ward"),
          meds: str(b.meds, 1000, "Medicines"), dd, status: "monitoring", checkins: [], log: [] };
        db.patients.push(p); store.save();
        store.audit(actorName(s), "patient_registered", { patient: id });
        return { pin, patient: safe(p) };
      }
    }

    if (route === "patients" && parts.length >= 3) {
      const p = canSee(s, findPatient(parts[1]));
      const action = parts[2];

      if (action === "checkins" && parts.length === 3 && m === "POST") {
        if (s.kind !== "patient") throw new HttpError(403, "Only the patient can send a check-in.");
        if (p.status === "closed") throw new HttpError(409, "Monitoring has ended.");
        const b = await readJson(req), a = b.a || {};
        for (const k of ["meds", "sw", "br", "fv"]) if (typeof a[k] !== "boolean") throw bad("Please answer all four questions.");
        const note = str(b.note, 1000, "Note");
        const t = now();
        p.checkins.push({ d: t.d, t: t.t, a: { meds: a.meds, sw: a.sw, br: a.br, fv: a.fv },
          note, em: isEmergency(note), ack: false });
        if (note) p.log.push({ by: p.name, role: "patient", text: note, ts: `${t.d} ${t.t}` });
        store.save();
        store.audit(actorName(s), "checkin", { patient: p.id });
        return { ok: true };
      }
      if (action === "checkins" && parts[4] === "ack" && m === "POST") {
        needStaff(s);
        const i = Number(parts[3]);
        if (!Number.isInteger(i) || !p.checkins[i]) throw new HttpError(404, "Check-in not found.");
        p.checkins[i].ack = true; store.save();
        store.audit(actorName(s), "alert_acknowledged", { patient: p.id, checkin: i });
        return { ok: true };
      }
      if (action === "log" && m === "POST") {
        if (s.kind === "patient" && p.status === "closed") throw new HttpError(409, "Monitoring has ended.");
        const text = str((await readJson(req)).text, 1000, "Message", true), t = now();
        p.log.push({ by: s.kind === "staff" ? s.name : p.name, role: s.kind === "staff" ? "nurse" : "patient",
          text, ts: `${t.d} ${t.t}` });
        store.save();
        store.audit(actorName(s), "message", { patient: p.id });
        return { ok: true };
      }
      if (action === "status" && m === "POST") {
        needStaff(s);
        const st = (await readJson(req)).status;
        if (st !== "monitoring" && st !== "closed") throw bad("Status must be monitoring or closed.");
        if (p.status !== st) {
          const t = now();
          p.status = st;
          p.log.push({ by: s.name, role: "nurse", ts: `${t.d} ${t.t}`,
            text: st === "closed" ? "Monitoring completed." : "Monitoring reopened for follow-up." });
          store.save();
          store.audit(actorName(s), "status_changed", { patient: p.id, status: st });
        }
        return { ok: true };
      }
      if (action === "resetpin" && m === "POST") {
        needStaff(s);
        const pin = randomPin(6);
        p.pin = hashPin(pin); store.save();
        sessions.destroyFor("patient", p.id); // old PIN's sessions end immediately
        store.audit(actorName(s), "pin_reset", { patient: p.id });
        return { pin };
      }
    }

    if (route === "staff" && parts.length === 1 && m === "POST") {
      needStaff(s);
      if (!s.admin) throw new HttpError(403, "Only the owner can add nurses.");
      const b = await readJson(req);
      const id = str(b.id, 32, "Staff ID", true).toLowerCase();
      if (!/^[a-z0-9._-]{3,32}$/.test(id)) throw bad("Staff ID: 3 to 32 letters, numbers, dot, dash or underscore.");
      const name = str(b.name, 100, "Full name", true), pin = String(b.pin || "");
      if (pin.length < 6) throw bad("PIN must be 6 or more characters.");
      if (pin.length > 100) throw bad("PIN is too long.");
      if (db.staff.some((x) => x.id === id)) throw new HttpError(409, "That Staff ID already exists.");
      db.staff.push({ id, name, pin: hashPin(pin), admin: false }); store.save();
      store.audit(actorName(s), "staff_created", { staff: id });
      return { ok: true };
    }

    throw new HttpError(404, "Not found.");
  }

  // ---- static files ----
  function serveStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed." });
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const file = path.resolve(PUBLIC_DIR, "." + rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: "Not found." });
    fs.readFile(file, (err, buf) => {
      if (err) return send(res, 404, { error: "Not found." });
      const h = { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" };
      h["Cache-Control"] = path.basename(file) === "sw.js" || path.basename(file) === "index.html" ? "no-cache" : "public, max-age=3600";
      if (path.basename(file) === "sw.js") h["Service-Worker-Allowed"] = "/";
      res.writeHead(200, h); res.end(req.method === "HEAD" ? undefined : buf);
    });
  }

  function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer(async (req, res) => {
    // Security headers on every response. Inline script/style are needed by index.html's single-file design.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (cfg.hsts) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
        return send(res, 200, await api(req, res, url));
      }
      serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error("Unexpected error:", e);
      send(res, 500, { error: "Something went wrong." });
    }
  });

  return { server, store, cfg };
}

module.exports = { createApp };

if (require.main === module) {
  const { server, cfg } = createApp({ hsts: process.env.HSTS === "1" });
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`CareBridge running on http://localhost:${port} (data: ${cfg.dataDir})`));
}
