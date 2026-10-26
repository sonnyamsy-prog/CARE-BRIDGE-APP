"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { risk, isEmergency } = require("../lib/risk");

const ok = { meds: true, sw: false, br: false, fv: false };

test("no warning signs is green", () => assert.strictEqual(risk(ok, false), "green"));
test("missed medicine alone is amber", () => assert.strictEqual(risk({ ...ok, meds: false }, false), "amber"));
test("swelling alone is amber", () => assert.strictEqual(risk({ ...ok, sw: true }, false), "amber"));
test("fever alone is amber", () => assert.strictEqual(risk({ ...ok, fv: true }, false), "amber"));
test("shortness of breath alone is red", () => assert.strictEqual(risk({ ...ok, br: true }, false), "red"));
test("swelling + fever (score 4) is red", () => assert.strictEqual(risk({ ...ok, sw: true, fv: true }, false), "red"));
test("missed medicine + swelling (score 3) is amber", () => assert.strictEqual(risk({ ...ok, meds: false, sw: true }, false), "amber"));
test("missed medicine + swelling + fever is red", () => assert.strictEqual(risk({ meds: false, sw: true, br: false, fv: true }, false), "red"));
test("emergency note is red even when all answers are fine", () => assert.strictEqual(risk(ok, true), "red"));

test("emergency phrases are detected (English and Swahili)", () => {
  for (const n of ["I have chest pain", "I feel like I will FAINT", "I can't breathe", "cant breathe", "cannot breathe",
    "he is unconscious", "had a seizure", "nina maumivu ya kifua", "nilipata kuzimia", "siwezi kupumua"]) {
    assert.ok(isEmergency(n), n);
  }
});
test("ordinary notes are not emergencies", () => {
  for (const n of ["", "I feel better today", "a little tired", null, undefined]) assert.ok(!isEmergency(n), String(n));
});

test("risk() in public/index.html matches server/lib/risk.js for every answer combination", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "public", "index.html"), "utf8");
  const m = html.match(/function risk\(a,em\)\{[^\n]*?\}(?=\nvar S=)/);
  assert.ok(m, "could not find risk() in index.html");
  const front = new Function(m[0] + "; return risk;")();
  for (const meds of [true, false]) for (const sw of [true, false]) for (const br of [true, false])
    for (const fv of [true, false]) for (const em of [true, false]) {
      const a = { meds, sw, br, fv };
      assert.strictEqual(front(a, em), risk(a, em), JSON.stringify({ a, em }));
    }
});
