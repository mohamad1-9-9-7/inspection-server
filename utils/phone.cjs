/* ============================================================
   Mobile numbers for the self-service trial (routes/trial.cjs).

   One number, one canonical form: "0501234567", "+971 50 123 4567" and
   "00971501234567" are the SAME UAE mobile and all become "+971501234567",
   so the one-trial-per-number rule cannot be dodged by retyping it.
   Only real mobile shapes pass: the right digit count for the country and
   a mobile first digit. Mirror: src/pages/trial/phone.js in the frontend.
============================================================ */
const MOBILE_RULES = {
  AE: { code: "971", len: 9, first: /^5[024568]/ },
  SA: { code: "966", len: 9, first: /^5/ },
  QA: { code: "974", len: 8, first: /^[3567]/ },
  KW: { code: "965", len: 8, first: /^[569]/ },
  BH: { code: "973", len: 8, first: /^[36]/ },
  OM: { code: "968", len: 8, first: /^[79]/ },
};

/** → { e164: "+971501234567", digits: "971501234567" } or null when it is not a valid mobile. */
function normalizeMobile(country, input) {
  const rule = MOBILE_RULES[String(country || "AE").toUpperCase()];
  if (!rule) return null;
  let d = String(input || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith(rule.code) && d.length === rule.code.length + rule.len) d = d.slice(rule.code.length);
  else if (d.startsWith("0") && d.length === rule.len + 1) d = d.slice(1); // national trunk 0
  if (d.length !== rule.len || !rule.first.test(d)) return null;
  return { e164: `+${rule.code}${d}`, digits: `${rule.code}${d}` };
}

module.exports = { MOBILE_RULES, normalizeMobile };
