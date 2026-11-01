/* ============================================================
   Supplier evaluation dates — risk level, re-evaluation and Halal validity.

   KEEP IN SYNC with the frontend:
     src/pages/haccp and iso/Supplier Approval/supplierRisk.js
     src/pages/haccp and iso/Supplier Approval/halalDeclaration.js
   The results page shows these dates; this file raises the alerts for them.
============================================================ */
const RISK_LEVELS = ["low", "medium", "high"];
const RISK_INTERVAL_MONTHS = { high: 6, medium: 12, low: 24 };
const TYPE_BASE = { food: 2, cleaning_chemicals: 1, packaging: 1, services: 0, other: 0 };

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function supplierType(p) {
  return String(
    p?.public?.supplierType || p?.meta?.supplierType || p?.supplierType ||
    p?.fields?.supplier_type || p?.public?.submission?.fields?.supplier_type || ""
  ).toLowerCase();
}

function compliancePct(p) {
  const answers = isObj(p?.answers) ? p.answers : isObj(p?.public?.submission?.answers) ? p.public.submission.answers : {};
  const c = isObj(p?.meta?.counts) ? p.meta.counts : null;
  const y = c ? Number(c.yesCount) || 0 : Object.values(answers).filter((v) => v === true).length;
  const n = c ? Number(c.noCount) || 0 : Object.values(answers).filter((v) => v === false).length;
  return y + n ? Math.round((y * 100) / (y + n)) : null;
}

function riskLevel(p) {
  const o = isObj(p?.risk) ? p.risk : null;
  if (o && RISK_LEVELS.includes(o.level)) return o.level;
  const st = supplierType(p);
  const pct = compliancePct(p);
  let idx = st in TYPE_BASE ? TYPE_BASE[st] : 1;
  if (pct != null && pct < 60) idx += 1;
  else if (pct != null && pct >= 90) idx -= 1;
  return RISK_LEVELS[Math.min(2, Math.max(0, idx))];
}

const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;

function addMonths(isoDay, months) {
  const t = Date.parse(`${String(isoDay).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  d.setUTCMonth(d.getUTCMonth() + months);
  return ymd(d);
}

function submittedAt(p) {
  return p?.public?.submittedAt || p?.meta?.submittedAt || p?.public?.submission?.submittedAt || "";
}

/** The dates the alert engine watches for one evaluation. Days are YYYY-MM-DD. */
function supplierDates(p) {
  const out = [];
  const name = String(p?.fields?.company_name || p?.public?.submission?.fields?.company_name || "Supplier").trim();
  const sub = submittedAt(p);
  const level = riskLevel(p);
  if (sub) out.push({ kind: "reeval", name, due: addMonths(sub, RISK_INTERVAL_MONTHS[level]), level });

  const h = isObj(p?.halal) ? p.halal : {};
  if (h.hasCertificate === true && /^\d{4}-\d{2}-\d{2}/.test(String(h.certExpiry || ""))) {
    out.push({ kind: "halalCert", name, due: String(h.certExpiry).slice(0, 10) });
  }
  if (h.declarationFile?.url) {
    const start = String(h.signedOn || h.receivedAt || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      let due = addMonths(start, 12);
      const cert = h.hasCertificate === true ? String(h.certExpiry || "").slice(0, 10) : "";
      if (/^\d{4}-\d{2}-\d{2}$/.test(cert) && cert < due) due = cert;
      out.push({ kind: "halalDecl", name, due });
    }
  }
  return out;
}

module.exports = { RISK_INTERVAL_MONTHS, riskLevel, compliancePct, supplierDates };
