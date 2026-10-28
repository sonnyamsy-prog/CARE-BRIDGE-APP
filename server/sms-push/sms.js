"use strict";
const https = require("node:https");

// Turn a typed phone number into international format, e.g. 0712 345 678 -> +254712345678.
// Returns null when it does not look like a real number.
function normalizePhone(raw, countryCode = "254") {
  let s = String(raw || "").replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = "+" + s.slice(2);
  if (s.startsWith("0")) s = "+" + countryCode + s.slice(1);
  else if (/^\d+$/.test(s)) s = "+" + s;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

const mask = (n) => String(n).slice(0, -4).replace(/\d/g, "*") + String(n).slice(-4);

// Default transport: Africa's Talking bulk SMS API (https://developers.africastalking.com).
function africasTalking({ username, apiKey, sender, sandbox }) {
  const host = sandbox ? "api.sandbox.africastalking.com" : "api.africastalking.com";
  return function transport(numbers, message) {
    const form = new URLSearchParams({ username, to: numbers.join(","), message });
    if (sender) form.set("from", sender);
    const body = form.toString();
    return new Promise((resolve, reject) => {
      const req = https.request(
        { host, path: "/version1/messaging", method: "POST", timeout: 10_000,
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded",
                     "Content-Length": Buffer.byteLength(body), apiKey } },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (res.statusCode >= 300) return reject(new Error(`SMS provider returned ${res.statusCode}`));
            try {
              const rec = JSON.parse(data).SMSMessageData.Recipients || [];
              resolve(rec.map((r) => ({ number: r.number, ok: [100, 101, 102].includes(r.statusCode), status: r.status })));
            } catch { reject(new Error("SMS provider sent an unreadable reply")); }
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error("SMS provider timed out")));
      req.on("error", reject);
      req.end(body);
    });
  };
}

// cfg: { username, apiKey, sender, sandbox, countryCode, transport }  (transport is injectable for tests)
function createSms(cfg = {}, log = console) {
  const transport = cfg.transport || (cfg.username && cfg.apiKey ? africasTalking(cfg) : null);
  return {
    enabled: !!transport,
    normalize: (n) => normalizePhone(n, cfg.countryCode || "254"),
    // Never throws. Returns { sent, failed }.
    async send(numbers, message) {
      const to = [...new Set((numbers || []).map((n) => normalizePhone(n, cfg.countryCode || "254")).filter(Boolean))];
      if (!to.length) return { sent: 0, failed: 0 };
      if (!transport) { log.log(`[sms disabled] would send to ${to.map(mask).join(", ")}`); return { sent: 0, failed: 0 }; }
      try {
        const results = await transport(to, String(message).slice(0, 320));
        const sent = results.filter((r) => r.ok).length;
        return { sent, failed: results.length - sent };
      } catch (e) {
        log.error("SMS failed:", e.message);
        return { sent: 0, failed: to.length };
      }
    },
  };
}

module.exports = { createSms, normalizePhone, mask };
