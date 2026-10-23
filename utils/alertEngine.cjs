/* ============================================================
   alertEngine — the system notices problems and tells someone.

   Before this, every warning lived in the browser (src/utils/notifications.js
   on the frontend): it fired only while the app was open on that device, and
   only for the person typing. Here the server finds the problem itself and
   files it as an ALERT (table `alerts`), which the app's bell shows to the
   company and which is e-mailed to the people the company named.

   Two ways an alert is born:
     • EVENT — a phone temperature reading saved out of range
       (industries/meat/reportRoutes.cjs calls onTemperatureReading). A
       recheck back inside the range closes it again by itself.
     • SCHEDULE — fixed UAE times (ALERT_TIMES, default "08:00,13:00"):
         first slot  → yesterday's daily logs not filed, expiries
                       (calibration, certificates, licences, mock recall)
                       and overdue CAPA / NCR;
         later slots → temperature logs with no reading at all yet today.
       The database is touched only at those slots — polling every few
       minutes would keep Neon awake all day (see the Aug 2026 cost spike).

   Every alert carries a dedupe_key ("temp:pos10_temperature:2026-10-23:
   Chiller 1:8:00 AM"), unique per company, so any check can run again and
   only NEW problems are raised and mailed.

   Rules per company: report type `alert_rules_config`, reportDate "config"
   (edited on the frontend's Alerts page). Defaults below: everything on for
   the bell, nobody e-mailed until addresses are entered.

   Scheduled work runs with no request, i.e. as the platform owner — every
   query here filters by company_id itself.
============================================================ */
const { sendPlatformMail } = require("../routes/mailer.cjs");

const RULES_TYPE = "alert_rules_config";

/* Daily logs checked by default; a type is only checked for a company that
   filed it at least once in the last 30 days, so a company that never uses
   it is never nagged. The Alerts page can change this list. */
const DEFAULT_DAILY = [
  { type: "qcs-coolers", branch: "QCS", label: "QCS Coolers temperature" },
  { type: "pos10_temperature", branch: "POS 10", label: "POS 10 temperature" },
  { type: "pos11_temperature", branch: "POS 11", label: "POS 11 temperature" },
  { type: "pos15_temperature", branch: "POS 15", label: "POS 15 temperature" },
  { type: "pos19_temperature_monitoring", branch: "POS 19", label: "POS 19 temperature" },
];
const TEMP_TYPES = new Set(["qcs-coolers", "pos10_temperature", "pos11_temperature", "pos15_temperature", "pos19_temperature_monitoring"]);
/* A phone (QR) reading creates the day; the day is FILED once the sheet is
   saved (payload.savedAt) — same rule as /api/reports/kpi-days. */
const PHONE_DAY_TYPES = ["pos10_temperature", "pos11_temperature", "pos15_temperature", "pos19_temperature_monitoring"];

const DEFAULT_RULES = {
  temperature: { enabled: true, emails: [] },
  missedReports: { enabled: true, emails: [], checks: DEFAULT_DAILY },
  noReadingToday: { enabled: true, emails: [] },
  expiries: { enabled: true, emails: [], days: 30 },
  capa: { enabled: true, emails: [], openDays: 30 },
};

const DAY_SQL = `LEFT(COALESCE(
    NULLIF(payload->>'cutDate', ''),
    NULLIF(payload->>'date', ''),
    NULLIF(payload->>'reportDate', ''),
    NULLIF(payload#>>'{header,reportDate}', ''),
    NULLIF(payload#>>'{header,date}', '')
  ), 10)`;

/* ───────── time (UAE = UTC+4, no daylight saving) ───────── */
const uaeNow = () => new Date(Date.now() + 4 * 3600_000);
const ymd = (d) => d.toISOString().slice(0, 10);
const uaeToday = () => ymd(uaeNow());
const uaeHM = () => uaeNow().toISOString().slice(11, 16);
const addDays = (day, n) => ymd(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const dmy = (day) => (isDay(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : "");
/* dates typed as DD/MM/YYYY or ISO → YYYY-MM-DD ("" when unreadable) */
function toDay(v) {
  const s = String(v || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

const clean = (v, n = 300) => String(v ?? "").trim().slice(0, n);
const cleanEmails = (list) =>
  (Array.isArray(list) ? list : String(list || "").split(/[,;\s]+/))
    .map((e) => String(e || "").trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))
    .slice(0, 20);

/* ───────── rules ───────── */
function mergeRules(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  const out = {};
  for (const [k, def] of Object.entries(DEFAULT_RULES)) {
    const r = s[k] && typeof s[k] === "object" ? s[k] : {};
    out[k] = { ...def, ...r, enabled: r.enabled !== false, emails: cleanEmails(r.emails ?? def.emails) };
  }
  if (!Array.isArray(out.missedReports.checks)) out.missedReports.checks = DEFAULT_DAILY;
  out.expiries.days = Math.min(180, Math.max(1, Number(out.expiries.days) || 30));
  out.capa.openDays = Math.min(365, Math.max(1, Number(out.capa.openDays) || 30));
  return out;
}

async function loadRules(pool, companyId) {
  const { rows } = await pool.query(
    `SELECT payload FROM reports
      WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND type = $2 AND payload->>'reportDate' = 'config'
      ORDER BY id DESC LIMIT 1`,
    [companyId, RULES_TYPE]
  );
  return mergeRules(rows[0]?.payload?.rules);
}

/* Al Mawashi's mailbox sends for the companies that own it (MAIL_COMPANY_IDS,
   same rule as routes/mailer.cjs); the others get the bell only until they
   have a mailbox of their own. */
function companyMayMail(companyId) {
  const raw = String(process.env.MAIL_COMPANY_IDS || "1");
  const ids = new Set(raw.split(",").map((x) => Number(x.trim())).filter((n) => n > 0));
  return ids.has(Number(companyId || 1));
}

const APP_ORIGIN = () => String(process.env.APP_ORIGIN || "https://inspectpro-ae.netlify.app").replace(/\/$/, "");

/* ───────── raise / resolve ───────── */

/** Files one alert; returns the new row, or null when the same problem is already filed. */
async function raiseAlert(pool, a) {
  const { rows } = await pool.query(
    `INSERT INTO alerts (company_id, rule, severity, branch, title, body, link, dedupe_key, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (COALESCE(company_id, 1), dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      a.companyId ?? null, clean(a.rule, 40), ["critical", "warning", "info"].includes(a.severity) ? a.severity : "warning",
      clean(a.branch, 80), clean(a.title, 200), clean(a.body, 2000), clean(a.link, 300),
      a.dedupeKey ? clean(a.dedupeKey, 300) : null, JSON.stringify(a.data || {}),
    ]
  );
  return rows[0] || null;
}

/** Closes the open alerts whose key starts with `prefix` (a problem that went away). */
async function resolveAlerts(pool, companyId, prefix, note = "") {
  const { rowCount } = await pool.query(
    `UPDATE alerts SET status = 'resolved', resolved_at = now(),
            data = data || jsonb_build_object('resolvedNote', $3::text)
      WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND status <> 'resolved'
        AND dedupe_key LIKE $2`,
    [companyId, `${prefix.replace(/[%_\\]/g, "\\$&")}%`, clean(note, 300)]
  );
  return rowCount;
}

/* ───────── e-mail ───────── */
function alertsHtml(list) {
  const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const color = { critical: "#b91c1c", warning: "#b45309", info: "#1d4ed8" };
  const items = list.map((a) => `
    <tr><td style="padding:10px 12px;border-bottom:1px solid #e5e7eb">
      <div style="font-weight:700;color:${color[a.severity] || "#0f172a"}">${esc(a.title)}</div>
      ${a.branch ? `<div style="color:#64748b;font-size:13px">${esc(a.branch)}</div>` : ""}
      ${a.body ? `<div style="color:#334155;font-size:14px;margin-top:4px;white-space:pre-line">${esc(a.body)}</div>` : ""}
      ${a.link ? `<div style="margin-top:6px"><a href="${esc(APP_ORIGIN() + a.link)}" style="color:#2563eb">Open in the system</a></div>` : ""}
    </td></tr>`).join("");
  return `<div style="font-family:Arial,sans-serif;max-width:640px">
    <table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px">${items}</table>
    <div style="color:#94a3b8;font-size:12px;margin-top:10px">INSPECT PRO — automatic alert. All alerts: ${esc(APP_ORIGIN())}/alerts</div>
  </div>`;
}
const alertsText = (list) =>
  list.map((a) => [`• ${a.title}`, a.branch && `  ${a.branch}`, a.body && `  ${a.body}`, a.link && `  ${APP_ORIGIN()}${a.link}`].filter(Boolean).join("\n")).join("\n\n");

/** Mails a set of NEW alerts to the rule's recipients; marks them emailed. Best-effort. */
async function mailAlerts(pool, companyId, emails, list, subject) {
  const to = cleanEmails(emails);
  if (!to.length || !list.length || !companyMayMail(companyId)) return false;
  try {
    const sent = await sendPlatformMail({ to, subject, text: alertsText(list), html: alertsHtml(list) });
    if (sent) {
      await pool.query(`UPDATE alerts SET emailed_at = now() WHERE id = ANY($1::bigint[])`, [list.map((a) => a.id)]);
    }
    return sent;
  } catch (e) {
    console.warn("[alerts] e-mail failed:", e?.message || e);
    return false;
  }
}

/* ───────── EVENT: a phone temperature reading ───────── */

/**
 * Called after a phone (QR) reading was committed.
 * r: { type, branch, reportDate, unit, unitLabel, slot, value, kind, outOfRange,
 *      correctiveAction, byName, min, max }
 * Never throws — an alert problem must not fail the reading the user just saved.
 */
async function onTemperatureReading(pool, companyId, r) {
  try {
    const rules = await loadRules(pool, companyId);
    if (!rules.temperature.enabled) return;
    const unitKey = clean(r.unit, 80);
    const prefix = `temp:${r.type}:${r.reportDate}:${unitKey}:`;
    if (!r.outOfRange) {
      // back in range on a recheck → the problem is over
      if (r.kind === "recheck") await resolveAlerts(pool, companyId, prefix, `Recheck ${r.value}°C by ${r.byName || "—"}`);
      return;
    }
    const range = Number.isFinite(Number(r.min)) || Number.isFinite(Number(r.max))
      ? ` (limit ${Number.isFinite(Number(r.min)) ? r.min : "…"} to ${Number.isFinite(Number(r.max)) ? r.max : "…"} °C)`
      : "";
    const label = clean(r.unitLabel || r.unit, 80);
    const alert = await raiseAlert(pool, {
      companyId,
      rule: "temperature",
      severity: "critical",
      branch: r.branch,
      title: `${r.branch} — ${label}: ${r.value}°C out of range`,
      body: [
        `Reading ${r.value}°C at ${r.slot} on ${dmy(r.reportDate)}${range}${r.kind === "recheck" ? " — still out on the recheck" : ""}.`,
        r.correctiveAction && `Corrective action: ${r.correctiveAction}`,
        r.byName && `By: ${r.byName}`,
      ].filter(Boolean).join("\n"),
      link: r.link || "",
      dedupeKey: `${prefix}${r.kind === "recheck" ? "recheck:" : ""}${r.slot}`,
      data: { type: r.type, unit: r.unit, slot: r.slot, value: r.value, min: r.min, max: r.max, kind: r.kind },
    });
    if (alert) await mailAlerts(pool, companyId, rules.temperature.emails, [alert], `🌡️ ${alert.title}`);
  } catch (e) {
    console.warn("[alerts] temperature hook failed:", e?.message || e);
  }
}

/* ───────── EVENT: a temperature SHEET saved from the computer ─────────
   The sheet is saved whole (generic /api/reports writes), so the new
   readings are found by comparing it with what was stored before. The
   limits are the phone page's own, so a value alarms the same way whether
   it was typed on the sheet or on the phone — and the alert key is the
   same, so one reading never alarms twice. */

const SHEET_BRANCH = {
  "qcs-coolers": "QCS",
  pos10_temperature: "POS 10",
  pos11_temperature: "POS 11",
  pos15_temperature: "POS 15",
  pos19_temperature_monitoring: "POS 19",
};
const TIME_SLOT = /^\d{1,2}:\d{2} (AM|PM)$/;
const NO_MIN = -60;

/* QCS: the limits frozen into the record (coolerDefs / loadingDef), else the
   sheet's legacy defaults — pages/monitor/branches/qcs/coolerDefs.js. */
const QCS_TYPES = { chilled: [0, 5], frozen: [-19, -14], production: [8, 12], dry: [15, 25], ambient: [0, 16] };
function qcsDef(raw, index) {
  const base = index === "loading" ? { type: "ambient", label: "Loading Area", min: 0, max: 16 }
    : index === 7 ? { type: "frozen", label: "FREEZER", min: -19, max: -14 }
      : index === 2 || index === 3 ? { type: "production", label: "Production Room", min: 8, max: 12 }
        : { type: "chilled", label: `Cooler ${index + 1}`, min: 0, max: 5 };
  const type = QCS_TYPES[raw?.type] ? raw.type : base.type;
  const n = (v, f) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : f);
  const min = n(raw?.min, n(base.min, QCS_TYPES[type][0]));
  const max = n(raw?.max, n(base.max, QCS_TYPES[type][1]));
  return { label: String(raw?.label ?? base.label).trim() || base.label, min: Math.min(min, max), max: Math.max(min, max) };
}
/* Branches: by the unit's name / POS 19 unit type — BranchTempQuick.jsx gridDef / pos19Def. */
function gridDef(name) {
  const n = String(name || "").toLowerCase();
  if (/freez/.test(n)) return { min: -25, max: -12 };
  if (/production|prep/.test(n)) return { min: NO_MIN, max: 10 };
  if (/loading/.test(n)) return { min: NO_MIN, max: 16 };
  return { min: NO_MIN, max: 5 };
}
function pos19Def(unitType) {
  if (unitType === "freezer") return { min: NO_MIN, max: -18 };
  if (unitType === "ambient") return { min: NO_MIN, max: 25 };
  return { min: NO_MIN, max: 5 };
}

const reading = (v) => {
  const s = String(v ?? "").trim();
  if (!s || !/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
};

/** Every numeric reading of a sheet: Map "unit|slot" → { unit, label, slot, value, min, max }. */
function sheetReadings(type, payload) {
  const out = new Map();
  const p = payload && typeof payload === "object" ? payload : {};
  const put = (unit, label, slot, raw, lim) => {
    const value = reading(raw);
    if (value == null) return;
    out.set(`${unit}|${slot}`, { unit: clean(unit, 80), label, slot, value, min: lim.min, max: lim.max });
  };
  const temps = (obj, fn) => Object.entries(obj && typeof obj === "object" ? obj : {}).forEach(([slot, v]) => { if (TIME_SLOT.test(slot)) fn(slot, v); });

  if (type === "qcs-coolers") {
    const defs = Array.isArray(p.coolerDefs) ? p.coolerDefs : [];
    (Array.isArray(p.coolers) ? p.coolers : []).forEach((c, i) => {
      const d = qcsDef(defs[i], i);
      temps(c?.temps, (slot, v) => put(`cooler-${i}`, d.label, slot, v, d));
    });
    const ld = qcsDef(p.loadingDef, "loading");
    temps(p.loadingArea?.temps, (slot, v) => put("loading-area", ld.label, slot, v, ld));
  } else if (type === "pos19_temperature_monitoring") {
    (Array.isArray(p.entries) ? p.entries : []).forEach((e) => {
      const name = String(e?.equipment || "").trim();
      if (!name) return;
      const lim = pos19Def(e?.unitType);
      ["am", "pm", "ev"].forEach((slot) => put(name, name, slot, e?.[`${slot}_temp`], lim));
    });
  } else {
    (Array.isArray(p.coolers) ? p.coolers : []).forEach((c) => {
      const name = String(c?.name || "").trim();
      if (!name) return;
      const lim = gridDef(name);
      temps(c?.temps, (slot, v) => put(name, name, slot, v, lim));
    });
  }
  return out;
}

const outside = (r) => r && (r.value < r.min || r.value > r.max);
const limitText = (r) => (r.min <= NO_MIN ? `≤ ${r.max} °C` : `${r.min} to ${r.max} °C`);

/** Is this one of the sheets the hook watches? (cheap check before any work) */
const isTempSheet = (type) => Object.prototype.hasOwnProperty.call(SHEET_BRANCH, type);

/**
 * Called after a temperature sheet was written (create or update).
 * New or changed readings out of range → critical alert (one e-mail for the
 * lot); a reading corrected back into range closes its alert. Only today's
 * and yesterday's sheets: typing up an old sheet must not page anyone.
 * Never throws.
 */
async function onTemperatureSheetSave(pool, companyId, type, oldPayload, newPayload, byName = "") {
  try {
    if (!isTempSheet(type)) return [];
    const day = String(newPayload?.reportDate || newPayload?.date || "").slice(0, 10);
    if (!isDay(day) || day < addDays(uaeToday(), -1)) return [];
    const rules = await loadRules(pool, companyId);
    if (!rules.temperature.enabled) return [];

    const before = sheetReadings(type, oldPayload);
    const after = sheetReadings(type, newPayload);
    const branch = SHEET_BRANCH[type];
    const created = [];

    for (const [k, r] of after) {
      const old = before.get(k);
      if (old && old.value === r.value) continue; // not touched by this save
      const prefix = `temp:${type}:${day}:${r.unit}:`;
      if (!outside(r)) {
        if (outside(old)) await resolveAlerts(pool, companyId, `${prefix}${r.slot}`, `Corrected on the sheet to ${r.value}°C${byName ? ` by ${byName}` : ""}`);
        continue;
      }
      const a = await raiseAlert(pool, {
        companyId,
        rule: "temperature",
        severity: "critical",
        branch,
        title: `${branch} — ${r.label}: ${r.value}°C out of range`,
        body: [
          `Entered on the sheet: ${r.value}°C at ${r.slot} on ${dmy(day)} (limit ${limitText(r)}).`,
          byName && `By: ${byName}`,
        ].filter(Boolean).join("\n"),
        link: "",
        dedupeKey: `${prefix}${r.slot}`,
        data: { type, unit: r.unit, slot: r.slot, value: r.value, min: r.min, max: r.max, kind: "sheet" },
      });
      if (a) created.push(a);
    }
    // a value removed from the sheet (cleared by mistake) closes its alert too
    for (const [k, old] of before) {
      if (!after.has(k) && outside(old)) {
        await resolveAlerts(pool, companyId, `temp:${type}:${day}:${old.unit}:${old.slot}`, "Cleared on the sheet");
      }
    }
    if (created.length) {
      await mailAlerts(pool, companyId, rules.temperature.emails, created,
        created.length === 1 ? `🌡️ ${created[0].title}` : `🌡️ ${branch}: ${created.length} temperatures out of range`);
    }
    return created;
  } catch (e) {
    console.warn("[alerts] sheet hook failed:", e?.message || e);
    return [];
  }
}

/* ───────── SCHEDULE: the checks ───────── */

/** Daily logs: `mode` "filed" (yesterday's sheet saved) or "any" (any record today). */
async function checkDaily(pool, companyId, checks, day, mode) {
  const types = checks.map((c) => c.type).filter(Boolean);
  if (!types.length) return [];
  // only types this company actually uses
  const used = await pool.query(
    `SELECT DISTINCT type FROM reports
      WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND type = ANY($2) AND created_at > now() - interval '30 days'`,
    [companyId, types]
  );
  const live = new Set(used.rows.map((r) => r.type));
  if (!live.size) return [];
  const filedOnly = mode === "filed"
    ? `AND NOT (type = ANY($4) AND payload ? 'quickReadings' AND COALESCE(payload->>'savedAt', '') = '')`
    : "";
  const params = [companyId, [...live], day];
  if (mode === "filed") params.push(PHONE_DAY_TYPES);
  const have = await pool.query(
    `SELECT DISTINCT type FROM reports
      WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND type = ANY($2) AND ${DAY_SQL} = $3 ${filedOnly}`,
    params
  );
  const filed = new Set(have.rows.map((r) => r.type));
  return checks.filter((c) => live.has(c.type) && !filed.has(c.type));
}

/* Expiring things: [{ key, name, branch, due, link }] per report family. */
const EXPIRY_SOURCES = [
  {
    types: ["calibration_record"],
    link: "/haccp-iso/calibration/view",
    items: (row) => {
      const p = row.payload || {};
      return [{ key: `cal:${row.id}`, name: `Calibration — ${p.equipmentName || "equipment"}`, branch: p.branch || "", due: toDay(p.nextDueDate), failed: p.result === "FAIL" }];
    },
  },
  {
    types: ["pos10_calibration_log", "pos11_calibration_log", "pos15_calibration_log", "ftr1_calibration_log", "ftr2_calibration_log", "ftr1_oil_calibration", "ftr2_oil_calibration"],
    link: "",
    items: (row) => {
      const p = row.payload || {};
      return (Array.isArray(p.entries) ? p.entries : []).map((e, i) => ({
        key: `cal:${row.id}:${i}`, name: `Calibration — ${e?.equipmentName || e?.fryerName || `item ${i + 1}`}`,
        branch: p.branch || row.type.split("_")[0].toUpperCase(), due: toDay(e?.nextDueDate),
      }));
    },
  },
  {
    types: ["training_certificate"],
    link: "/training-certificates/view",
    items: (row) => {
      const p = row.payload || {};
      return [{ key: `cert:${row.id}`, name: `Training certificate — ${p.fullName || p.name || p.employeeName || "—"} (${p.courseType || p.courseName || "course"})`, branch: p.branch || "", due: toDay(p.expiryDate) }];
    },
  },
  {
    types: ["ohc_certificate"],
    link: "/ohc/view",
    items: (row) => {
      const p = row.payload || {};
      return [{ key: `ohc:${row.id}`, name: `Health certificate (OHC) — ${p.fullName || p.name || p.employeeName || "—"}`, branch: p.branch || "", due: toDay(p.expiryDate) }];
    },
  },
  {
    types: ["licenses_contracts"],
    link: "/haccp-iso/licenses-contracts/view",
    items: (row) => {
      const p = row.payload || {};
      const lic = (Array.isArray(p.licenses) ? p.licenses : []).map((l, i) => ({ key: `lic:${row.id}:${i}`, name: `Licence — ${l?.name || `#${i + 1}`}`, branch: p.branch || "", due: toDay(l?.expiryDate) }));
      const ct = (Array.isArray(p.contracts) ? p.contracts : []).map((c, i) => ({ key: `ct:${row.id}:${i}`, name: `Contract — ${[c?.contractType, c?.companyName].filter(Boolean).join(" · ") || `#${i + 1}`}`, branch: p.branch || "", due: toDay(c?.expiryDate) }));
      return [...lic, ...ct];
    },
  },
];

async function checkExpiries(pool, companyId, days, today) {
  const types = EXPIRY_SOURCES.flatMap((s) => s.types);
  const { rows } = await pool.query(
    `SELECT id, type, payload FROM reports
      WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND type = ANY($2)
      ORDER BY id DESC LIMIT 5000`,
    [companyId, types]
  );
  const all = [];
  rows.forEach((row) => {
    const src = EXPIRY_SOURCES.find((s) => s.types.includes(row.type));
    src.items(row).forEach((it) => { if (isDay(it.due)) all.push({ ...it, link: src.link }); });
  });

  /* calibration_record keeps the HISTORY of a device (one record per
     calibration): only the newest due date of each device (branch + name)
     counts — over ALL its records, so a device calibrated again never
     alarms from its old record. */
  const isRecordCal = (x) => /^cal:\d+$/.test(x.key);
  const devKey = (x) => `${x.branch}|${x.name}`.toLowerCase();
  const newest = new Map();
  all.filter(isRecordCal).forEach((x) => {
    if (!newest.has(devKey(x)) || x.due > newest.get(devKey(x)).due) newest.set(devKey(x), x);
  });

  const out = [];
  all.forEach((x) => {
    if (isRecordCal(x) && newest.get(devKey(x)) !== x) return;
    const left = daysBetween(today, x.due);
    if (left > days) return;
    out.push({ ...x, left, stage: left < 0 ? "expired" : "soon" });
  });

  // ISO 22000: a mock recall drill at least every 90 days
  const drill = await pool.query(
    `SELECT MAX(LEFT(payload->>'drillDate', 10)) AS last FROM reports
      WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND type = 'mock_recall_drill'`,
    [companyId]
  );
  const last = drill.rows[0]?.last;
  if (isDay(last)) {
    const due = addDays(last, 90);
    const left = daysBetween(today, due);
    if (left <= Math.min(days, 14)) {
      out.push({ key: `drill:${last}`, name: `Mock recall drill (last one ${dmy(last)})`, branch: "", due, left, stage: left < 0 ? "expired" : "soon", link: "/haccp-iso/mock-recall" });
    }
  }
  return out;
}

async function checkCapa(pool, companyId, openDays, today) {
  const { rows } = await pool.query(
    `SELECT id, type, payload FROM reports
      WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1)
        AND type IN ('qcs_corrective_action', 'qcs_non_conformance')
        AND created_at > now() - interval '400 days'
      ORDER BY id DESC LIMIT 2000`,
    [companyId]
  );
  const out = [];
  rows.forEach((row) => {
    const p = row.payload || {};
    const ref = p.refNo ? ` ${p.refNo}` : "";
    if (row.type === "qcs_corrective_action") {
      if (toDay(p.footer?.dateClosedOut)) return;
      const opened = toDay(p.header?.dateIssued) || toDay(p.reportDate);
      const target = toDay(p.header?.carCompletedDate);
      const late = target ? daysBetween(target, today) : opened ? daysBetween(opened, today) - openDays : -1;
      if (late <= 0) return;
      out.push({
        key: `capa:${row.id}`, branch: p.branch || "QCS", link: "/admin/qcs",
        title: `CAPA${ref} not closed — ${target ? `${late} day(s) past its target date` : `open for ${late + openDays} days`}`,
        body: String(p.body?.detailsOfNC || "").slice(0, 300),
      });
    } else {
      const ex = p.correctiveActionExtras || {};
      if (String(ex.status || "").toLowerCase() === "closed") return;
      const opened = toDay(p.headRow?.reportDate) || toDay(p.reportDate);
      const target = toDay(ex.targetCompletionDateISO);
      const late = target ? daysBetween(target, today) : opened ? daysBetween(opened, today) - openDays : -1;
      if (late <= 0) return;
      out.push({
        key: `ncr:${row.id}`, branch: p.branch || p.location || "", link: "/admin/qcs",
        title: `NCR${ref} not closed — ${target ? `${late} day(s) past its target date` : `open for ${late + openDays} days`}`,
        body: String(p.detailsBlock?.description || p.detailsBlock || "").slice(0, 300),
      });
    }
  });
  return out;
}

/**
 * One company, one slot. `first` = the morning slot (yesterday + expiries + CAPA);
 * otherwise only "no temperature reading yet today".
 * Returns the NEW alerts it filed.
 */
async function runCompanyChecks(pool, companyId, { first = true, today = uaeToday() } = {}) {
  const rules = await loadRules(pool, companyId);
  const created = { missedReports: [], noReadingToday: [], expiries: [], capa: [] };
  const push = (k, a) => { if (a) created[k].push(a); };

  if (first && rules.missedReports.enabled) {
    const day = addDays(today, -1);
    for (const c of await checkDaily(pool, companyId, rules.missedReports.checks, day, "filed")) {
      push("missedReports", await raiseAlert(pool, {
        companyId, rule: "missedReports", severity: "warning", branch: c.branch,
        title: `${c.label || c.type} — not filed for ${dmy(day)}`,
        body: TEMP_TYPES.has(c.type) ? "Phone readings alone do not file the day: the sheet has to be saved." : "",
        dedupeKey: `miss:${c.type}:${day}`, data: { type: c.type, day },
      }));
    }
  }
  if (!first && rules.noReadingToday.enabled) {
    const temps = rules.missedReports.checks.filter((c) => TEMP_TYPES.has(c.type));
    for (const c of await checkDaily(pool, companyId, temps, today, "any")) {
      push("noReadingToday", await raiseAlert(pool, {
        companyId, rule: "noReadingToday", severity: "warning", branch: c.branch,
        title: `${c.label || c.type} — no reading yet today (${uaeHM()})`,
        dedupeKey: `noread:${c.type}:${today}`, data: { type: c.type, day: today },
      }));
    }
  }
  if (first && rules.expiries.enabled) {
    for (const x of await checkExpiries(pool, companyId, rules.expiries.days, today)) {
      push("expiries", await raiseAlert(pool, {
        companyId, rule: "expiries", severity: x.stage === "expired" || x.failed ? "critical" : "warning", branch: x.branch,
        title: x.key.startsWith("drill:")
          ? (x.stage === "expired" ? `${x.name} — OVERDUE since ${dmy(x.due)}` : `${x.name} — due ${dmy(x.due)} (${x.left} day(s))`)
          : x.stage === "expired" ? `${x.name} — EXPIRED on ${dmy(x.due)}` : `${x.name} — expires ${dmy(x.due)} (${x.left} day(s))`,
        link: x.link, dedupeKey: `exp:${x.key}:${x.due}:${x.stage}`, data: { due: x.due, stage: x.stage },
      }));
    }
  }
  if (first && rules.capa.enabled) {
    for (const x of await checkCapa(pool, companyId, rules.capa.openDays, today)) {
      // one alert per record per week while it stays open — a reminder, not a flood
      const week = Math.floor(daysBetween("2026-01-05", today) / 7);
      push("capa", await raiseAlert(pool, {
        companyId, rule: "capa", severity: "warning", branch: x.branch, title: x.title, body: x.body,
        link: x.link, dedupeKey: `${x.key}:w${week}`,
      }));
    }
  }

  const subjects = {
    missedReports: "📋 Daily logs not filed",
    noReadingToday: "🌡️ No temperature reading yet today",
    expiries: "⏳ Expiring soon / expired",
    capa: "🛠️ CAPA / NCR overdue",
  };
  for (const [k, list] of Object.entries(created)) {
    if (list.length) await mailAlerts(pool, companyId, rules[k].emails, list, `${subjects[k]} — ${list.length}`);
  }
  return Object.values(created).flat();
}

async function activeCompanies(pool) {
  const { rows } = await pool.query(`SELECT id FROM companies WHERE disabled_at IS NULL ORDER BY id`).catch(() => ({ rows: [{ id: 1 }] }));
  return rows.length ? rows.map((r) => Number(r.id)) : [1];
}

/* ───────── the scheduler ───────── */
const slots = () =>
  String(process.env.ALERT_TIMES || "08:00,13:00").split(",").map((s) => s.trim()).filter((s) => /^\d{2}:\d{2}$/.test(s)).sort();
const ranToday = new Map(); // slot → day, so the DB is asked once per slot per process

async function tick(pool) {
  const day = uaeToday();
  const hm = uaeHM();
  const all = slots();
  for (const slot of all) {
    if (hm < slot || ranToday.get(slot) === day) continue;
    ranToday.set(slot, day);
    // claim the run — another instance / an earlier boot today may own it already
    const claim = await pool.query(
      `INSERT INTO alert_job_runs (job, day) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING job`,
      [`checks@${slot}`, day]
    );
    if (!claim.rowCount) continue;
    const first = slot === all[0];
    let n = 0;
    for (const companyId of await activeCompanies(pool)) {
      try {
        n += (await runCompanyChecks(pool, companyId, { first, today: day })).length;
      } catch (e) {
        console.warn(`[alerts] checks failed for company ${companyId}:`, e?.message || e);
      }
    }
    console.log(`[alerts] ${slot} checks done — ${n} new alert(s)`);
  }
}

let timer = null;
function startAlertScheduler(pool) {
  if (timer || String(process.env.ALERTS || "on").toLowerCase() === "off") return;
  const run = () => tick(pool).catch((e) => console.warn("[alerts] tick failed:", e?.message || e));
  timer = setInterval(run, 5 * 60_000); // no DB access unless a slot is due
  timer.unref();
  setTimeout(run, 30_000).unref(); // after boot: catch a slot passed while the server was down
  console.log(`[alerts] scheduler on — UAE slots ${slots().join(", ")}`);
}

module.exports = {
  RULES_TYPE,
  DEFAULT_RULES,
  mergeRules,
  loadRules,
  raiseAlert,
  resolveAlerts,
  onTemperatureReading,
  onTemperatureSheetSave,
  isTempSheet,
  runCompanyChecks,
  startAlertScheduler,
  mailAlerts,
  _companyMayMail: companyMayMail,
  // for tests
  _internal: { toDay, checkCapa, checkExpiries, addDays, daysBetween, cleanEmails, sheetReadings },
};
