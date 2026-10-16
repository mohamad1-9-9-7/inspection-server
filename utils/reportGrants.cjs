/* ============================================================
   Per-report permissions — enforced on the server

   The frontend (src/utils/reportPerms.js) lets an admin give an account
   only some reports of a branch, input and view separately:
     app_users.allowed_branches.reports = ["QCS:coolers:input", "QCS:coolers:view", …]
   Hiding tabs in the browser is not protection, so this gate checks the
   same grants on every /api/reports request.

   ── Rule (same as the frontend) ────────────────────────────────────────
   • admin / super-admin / full access ("*")      → no check.
   • no grant for a branch ("QCS:…" absent)        → that branch is open.
   • grants for the branch                          → only those reports.
   • a type not listed below                        → not restricted here.

   ── What is checked ─────────────────────────────────────────────────────
   • WRITES (POST/PUT/PATCH/DELETE) need the report's INPUT grant.
   • READS need INPUT or VIEW — only for accounts whose sections are just
     the branch screens (daily / admin). Other sections (KPI, traceability,
     returns, inventory…) read across branches on purpose; refusing their
     reads would break those screens, so such accounts are not read-gated.
   • A read with no `type` (whole listing) is filtered row by row.

   Without a token (REQUIRE_AUTH not "on") nothing can be checked — the
   request goes on, as every other auth rule does today.
============================================================ */

const { verifyTokenRaw, tokenFromReq } = require("./token.cjs");

/* type slug → [branch, report id]. Report ids are the frontend's registry
   ids (BRANCH_REPORTS in src/utils/reportPerms.js). Keep both in step. */
const T = {};
const add = (branch, pairs) => pairs.forEach(([type, id]) => { T[type] = [branch, id]; });

add("QCS", [
  ["qcs_raw_material", "raw_material"], ["pos_al_qusais_fresh_chicken_receiving", "fresh"],
  ["qcs_rm_packaging", "rm_pack"], ["qcs_rm_ingredients", "rm_ing"],
  ["qcs-coolers", "coolers"], ["qcs_stock_rotation", "stock_rotation"],
  ["qcs-ph", "ph"], ["qcs-clean", "clean"],
  ["qcs_garbage_disposal", "garbage"], ["qcs_meat_waste_disposal", "meat_waste"],
  ["qcs_pest_control", "pest_control"], ["qcs_internal_audit", "internal_audit"],
  ["qcs_non_conformance", "nc_reports"], ["qcs_corrective_action", "car_reports"],
  ["qcs_product_rejection", "product_rejection"], ["qcs_visitor_checklist", "visitor"],
  ["qcs_staff_sickness", "staff_sickness"], ["qcs_employee_return_to_work", "return_to_work"],
  ["qcs_employee_warning", "employee_warning"],
  ["ftr1_preloading_inspection", "ftr1_preload"], ["ftr2_preloading_inspection", "ftr2_preload"],
]);
const posCommon = (p) => [
  [`${p}_temperature`, "temperature"], [`${p}_daily_cleanliness`, "cleanliness"],
  [`${p}_personal_hygiene`, "hygiene"], [`${p}_pest_control`, "pest"],
  [`${p}_receiving_log_butchery`, "receiving"], [`${p}_traceability_log`, "traceability"],
  [`${p}_sanitizer_concentration`, "sanitizer"],
];
add("POS 10", [...posCommon("pos10"), ["pos10_equipment_inspection", "equipment"]]);
add("POS 11", [...posCommon("pos11"), ["pos11_equipment_inspection", "equipment"]]);
add("POS 15", [...posCommon("pos15"), ["pos15_equipment_inspection", "equip_sanit"]]);
add("POS 6", [
  ["pos6_coolers_temperature", "coolers"], ["pos6_personal_hygiene", "hygiene"],
  ["pos6_cleaning_checklist", "cleaning"], ["pos6_equipment_inspection", "equipment"],
  ["pos6_receiving_log_butchery", "receiving"],
]);
const ftr = (p) => [
  [`${p}_temperature`, "temperature"], [`${p}_personal_hygiene`, "hygiene"],
  [`${p}_oil_calibration`, "oil"], [`${p}_daily_cleanliness`, "cleanliness"],
  [`${p}_cooking_temperature_log`, "cook"], [`${p}_receiving_log_butchery`, "receiving"],
];
add("FTR 1", ftr("ftr1"));
add("FTR 2", ftr("ftr2"));
add("POS 19", [
  ["pos19_temperature_monitoring", "temperatureMonitoring"], ["pos19_food_temperature_verification", "foodTempVerification"],
  ["pos19_cooking_temperature", "cookingTemperature"], ["pos19_cooling_log", "cooling"],
  ["pos19_reheating_log", "reheating"], ["pos19_hot_holding_temperature", "hotHoldingTemp"],
  ["pos19_blast_freezer_ccp", "blastFreezer"], ["pos19_veg_sanitation_ccp", "vegSanitation"],
  ["pos19_dry_store_temp_humidity", "dryStore"], ["pos19_defrosting_record", "defrosting"],
  ["pos19_cleaning_programme_schedule", "cleaningProgramme"], ["pos19_daily_cleaning", "dailyCleaningButchery"],
  ["pos19_personal_hygiene", "personalHygiene"], ["pos19_sanitizer_concentration", "sanitizerConcentration"],
  ["pos19_receiving_log_butchery", "receivingLog"], ["pos19_traceability_log", "traceability"],
  ["pos19_finished_product_monitoring", "finishedProduct"], ["pos19_equipment_inspection", "equipmentInspection"],
  ["pos19_calibration_log", "calibration"], ["pos19_glass_items_condition", "glassItemsCondition"],
  ["pos19_wooden_items_condition", "woodenItemsCondition"], ["pos19_oil_quality_monitoring", "oilQuality"],
  ["pos19_non_conformance", "nonConformance"], ["pos19_staff_sickness", "staffSickness"],
  ["pos19_employee_return_to_work", "employeeReturnToWork"],
]);
add("PRODUCTION", [
  ["prod_cleaning_checklist", "cleaning"], ["prod_personal_hygiene", "hygiene"],
  ["prod_defrosting_record", "defrost"], ["prd_traceability_log", "trace"],
  ["prod_online_cutting", "cutting"], ["prod_dried_meat", "dried"],
  ["prod_equipment_inspection", "equipment"], ["prod_sanitizer_concentration", "sanitizer"],
  ["prod_veg_sanitation_ccp", "vegSanitation"],
]);

const TYPE_REPORT = T;

/* ── The account's grants, cached briefly (one DB read per user a minute) ── */
const CACHE_MS = 60_000;
const cache = new Map(); // uid (UUID string) → { at, grants }

function forgetGrants(uid) {
  if (uid == null) cache.clear();
  else cache.delete(String(uid));
}

async function loadGrants(pool, uid) {
  const key = String(uid);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.grants;

  const q = await pool.query(
    `SELECT is_admin, is_super_admin, permissions, crud_perms, allowed_branches FROM app_users WHERE id = $1`,
    [key]
  );
  const u = q.rows[0];
  let grants = null;
  if (u) {
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    const full = !!u.is_admin || !!u.is_super_admin || perms.includes("*");
    const ab = u.allowed_branches && typeof u.allowed_branches === "object" && !Array.isArray(u.allowed_branches)
      ? u.allowed_branches : {};
    const list = Array.isArray(ab.reports) ? ab.reports.map(String) : [];
    const restricted = new Set(list.map((k) => k.split(":")[0]));
    const crud = u.crud_perms && typeof u.crud_perms === "object" ? u.crud_perms : {};
    const sections = Object.keys(crud).filter((s) => Array.isArray(crud[s]) && crud[s].length);
    // Only branch screens → its reads can be gated without breaking anything else.
    const branchOnly = sections.length > 0 && sections.every((s) => s === "daily" || s === "admin");
    grants = { full, set: new Set(list), restricted, branchOnly };
  }
  cache.set(key, { at: Date.now(), grants });
  return grants;
}

function allowed(grants, type, mode) {
  const hit = TYPE_REPORT[type];
  if (!hit) return true;
  const [branch, id] = hit;
  if (!grants.restricted.has(branch)) return true;
  if (grants.set.has(`${branch}:${id}:input`)) return true;
  return mode === "read" && grants.set.has(`${branch}:${id}:view`);
}

const refused = (res, type) =>
  res.status(403).json({ ok: false, error: "report_not_allowed", type });

/* Paths under /api/reports that are not one report type. */
const SPECIAL = new Set(["summary", "kpi-days", "butcher-stats", "backfill-refs", "migrate-base64", "public"]);

/**
 * Express middleware for app.use("/api/reports", …). `pool` reads the
 * account and, for /:id routes, the record's type.
 */
function reportGrantGate(pool) {
  const typeOfId = async (id) => {
    const r = await pool.query(`SELECT type FROM reports WHERE id = $1`, [Number(id)]);
    return r.rows[0]?.type || null;
  };

  return async function gate(req, res, next) {
    if (req.method === "OPTIONS") return next();
    let user = null;
    try {
      const raw = tokenFromReq(req);
      user = raw ? verifyTokenRaw(raw) : null;
    } catch { user = null; }
    if (!user || !user.uid || user.isAdmin || user.isSuperAdmin) return next();

    try {
      const grants = await loadGrants(pool, user.uid);
      if (!grants || grants.full || grants.restricted.size === 0) return next();

      const parts = String(req.path || "/").split("/").filter(Boolean);
      const first = parts[0] || "";
      if (SPECIAL.has(first)) return next();

      /* ── reads ── */
      if (req.method === "GET") {
        if (!grants.branchOnly) return next();
        if (/^\d+$/.test(first)) {
          const type = await typeOfId(first);
          return type && !allowed(grants, type, "read") ? refused(res, type) : next();
        }
        const type = String(req.query?.type || "");
        if (type) return allowed(grants, type, "read") ? next() : refused(res, type);
        // A listing without a type: drop the rows this account may not read.
        const json = res.json.bind(res);
        res.json = (body) => {
          if (body && Array.isArray(body.data)) {
            body = { ...body, data: body.data.filter((row) => allowed(grants, row?.type, "read")) };
          }
          return json(body);
        };
        return next();
      }

      /* ── writes ── */
      let type = "";
      if (/^\d+$/.test(first)) type = await typeOfId(first);
      else if (first === "qcs-coolers") type = "qcs-coolers";            // POST /qcs-coolers/reading
      else if (first === "branch-temp") type = String(req.body?.type || ""); // POST /branch-temp/reading
      else if (first) type = first;                                       // PUT /:type, /returns, /qcs
      else type = String(req.body?.type || req.query?.type || "");       // POST/PUT/DELETE /
      if (!type) return next();
      return allowed(grants, type, "write") ? next() : refused(res, type);
    } catch (e) {
      // The grants could not be read (DB hiccup): don't take the whole API down.
      console.warn("[report-grants] check skipped:", e?.message || e);
      return next();
    }
  };
}

module.exports = { reportGrantGate, forgetGrants, TYPE_REPORT };
