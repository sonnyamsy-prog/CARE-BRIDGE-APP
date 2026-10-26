"use strict";
// Risk rules. Keep identical to risk() in public/index.html (a test checks this).
// These rules only FLAG check-ins. Nurses make every clinical decision.

const EMERGENCY =
  /chest pain|faint|can.?t breathe|cannot breathe|unconscious|seizure|kifua|kuzimia|siwezi kupumua/i;

function isEmergency(note) {
  return EMERGENCY.test(String(note || ""));
}

// a = {meds: bool, sw: bool, br: bool, fv: bool}  (meds true = took medicine)
function risk(a, em) {
  const s = (a.meds === false ? 1 : 0) + (a.sw ? 2 : 0) + (a.br ? 3 : 0) + (a.fv ? 2 : 0);
  return em || a.br || s >= 4 ? "red" : s > 0 ? "amber" : "green";
}

module.exports = { risk, isEmergency, EMERGENCY };
