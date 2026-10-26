"use strict";
const crypto = require("node:crypto");

// ---- PIN hashing (scrypt, per-PIN random salt) ----
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}
const DUMMY = hashPin("dummy-pin-for-timing");
function verifyPin(pin, stored) {
  const [, saltHex, hashHex] = String(stored || DUMMY).split("$");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(actual, expected) && stored !== undefined && stored !== null;
}
// Random numeric PIN, uniform (no modulo bias)
function randomPin(digits = 6) {
  return String(crypto.randomInt(0, 10 ** digits)).padStart(digits, "0");
}

// ---- Sessions (in memory; a restart signs everyone out) ----
class Sessions {
  constructor(hours) { this.ttl = hours * 3600e3; this.map = new Map(); }
  static key(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
  create(data) {
    const token = crypto.randomBytes(32).toString("hex");
    this.map.set(Sessions.key(token), { ...data, exp: Date.now() + this.ttl });
    return token;
  }
  get(token) {
    if (!token) return null;
    const k = Sessions.key(token), s = this.map.get(k);
    if (!s) return null;
    if (s.exp < Date.now()) { this.map.delete(k); return null; }
    return s;
  }
  destroy(token) { if (token) this.map.delete(Sessions.key(token)); }
  destroyFor(kind, id) {
    for (const [k, s] of this.map) if (s.kind === kind && s.id === id) this.map.delete(k);
  }
}

// ---- Login throttling: lock a (account + client) pair after repeated failures ----
class Throttle {
  constructor(max = 5, lockMs = 15 * 60e3) { this.max = max; this.lockMs = lockMs; this.map = new Map(); }
  locked(key) {
    const e = this.map.get(key);
    return !!e && e.until > Date.now();
  }
  fail(key) {
    const e = this.map.get(key) || { n: 0, until: 0 };
    if (e.until && e.until <= Date.now()) { e.n = 0; e.until = 0; }
    e.n += 1;
    if (e.n >= this.max) e.until = Date.now() + this.lockMs;
    this.map.set(key, e);
  }
  ok(key) { this.map.delete(key); }
}

module.exports = { hashPin, verifyPin, randomPin, Sessions, Throttle };
