"use strict";
const crypto = require("node:crypto");
const https = require("node:https");

// Web Push with VAPID, using only Node's built-in crypto.
// Alerts are sent WITHOUT a payload on purpose: the service worker shows a generic
// "urgent check-in" notification, so no patient information ever travels through the
// browser vendor's push service.

const b64u = (buf) => Buffer.from(buf).toString("base64url");

// Create a VAPID key pair. Public key is the 65-byte uncompressed point, base64url.
function generateVapid() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

function privateKeyObject({ publicKey, privateKey }) {
  const pub = Buffer.from(publicKey, "base64url");
  return crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: privateKey },
    format: "jwk",
  });
}

// "Authorization" header proving this server is allowed to push to the endpoint.
function vapidHeader(endpoint, vapid, subject) {
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  }));
  const sig = crypto.sign("sha256", Buffer.from(`${head}.${claims}`),
    { key: privateKeyObject(vapid), dsaEncoding: "ieee-p1363" });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// Default transport: one HTTPS POST to the browser's push service. Resolves to the status code.
function httpsTransport(endpoint, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(endpoint);
    const req = https.request({ host: u.host, path: u.pathname + u.search, method: "POST", headers, timeout: 10_000 },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("timeout", () => req.destroy(new Error("Push service timed out")));
    req.on("error", reject);
    req.end();
  });
}

// Push endpoints must be https URLs of reasonable size.
function validEndpoint(e) {
  if (typeof e !== "string" || e.length > 600) return false;
  try { return new URL(e).protocol === "https:"; } catch { return false; }
}

function createPush({ vapid, subject, transport = httpsTransport }, log = console) {
  return {
    publicKey: vapid.publicKey,
    // Returns "sent", "gone" (subscription expired, remove it) or "failed".
    async send(endpoint) {
      try {
        const status = await transport(endpoint, {
          Authorization: vapidHeader(endpoint, vapid, subject),
          TTL: "3600", Urgency: "high", "Content-Length": "0",
        });
        if (status === 404 || status === 410) return "gone";
        return status >= 200 && status < 300 ? "sent" : "failed";
      } catch (e) {
        log.error("Push failed:", e.message);
        return "failed";
      }
    },
  };
}

module.exports = { generateVapid, vapidHeader, createPush, validEndpoint };
