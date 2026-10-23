/* ============================================================
   Meat industry (Al Mawashi) — its own /api/reports routes
   ------------------------------------------------------------
   Mounted by routes/reports.cjs through industries/index.cjs, at the
   point where the core wants them: BEFORE the generic
   PUT /api/reports/:type, which would otherwise swallow
   /api/reports/returns and /api/reports/qcs.

   `ctx` carries the core's own helpers (tenant scope, audit, refs),
   so these routes follow exactly the same company + audit rules as
   every core route — the industry only owns the business logic.
============================================================ */
const { onTemperatureReading } = require("../../utils/alertEngine.cjs");

/* Alert hook input for one phone reading — never fails the reading. */
const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));

module.exports = function registerMeatReportRoutes(app, ctx) {
  const {
    pool, isObj, auth, pingBypass, readLimiter,
    companyIdOf, companyIdForWrite, fetchOldByTypeDate,
    KEEP_REF, auditWrite, auditCreate, stampRef,
  } = ctx;

/** تاريخ عملية التقطيع — نفس أول ثلاث مفاتيح من BUSINESS_DATE. */
const BUTCHER_DATE = `
  COALESCE(
    NULLIF(payload->>'cutDate', ''),
    NULLIF(payload->>'date', ''),
    NULLIF(LEFT(payload->>'reportDate', 10), '')
  )`;

/* ============================================================
   GET /api/reports/butcher-stats?from=YYYY-MM-DD&to=YYYY-MM-DD

   سطر مجمَّع لكل جزار — لشاشة «أدائي» بكرت الجزار (ترتيب داخل ملحمته
   وعلى مستوى كل الملاحم).

   ليش مسار لحاله بدل ما الشاشة تحسب لحالها: القائمة بدها أرقام **كل**
   الجزارين. لو حسبناها بالمتصفّح، كل جزار بيفتح الصفحة بينزّل سجلات كل
   الملاحم بالـpayload كامل (١٫٥ كيلوبايت للعملية) — نفس السحب اللي شلناه
   من هالصفحة بالضبط. هون الحساب بالـSQL جوّا القاعدة، والجواب سطر لكل
   جزار: بضع كيلوبايتات مهما كبر التاريخ.

   الأرقام حقائق فقط — **النتيجة والترتيب بينحسبوا بالواجهة**، حتى تتعدّل
   الأوزان بلا نشرة سيرفر.

   بلا حصر ملاحم عن قصد (بعكس قراءة السجلات): المطلوب مقارنة مع كل
   الجزارين، والراجع مجاميع بلا أي تفصيل عملية.

   قواعد الحساب مطابقة لـnormalizeRecord بالواجهة:
     • الملغى (changeRequest.status = approved) برّا كل رقم.
     • النواتج = أسطر kind=product ، الهدر = الباقي + wasteBoneKg.
     • الأساس = وزن الخام، وإذا مش موجود فمجموع الداخل.
     • المطابقة = العملية اللي كل أسطرها المعيارية ضمن التسامح.
============================================================ */
app.get("/api/reports/butcher-stats", pingBypass, readLimiter, auth, async (req, res) => {
  try {
    const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const to = isDay(req.query?.to) ? req.query.to : new Date().toISOString().slice(0, 10);
    const from = isDay(req.query?.from)
      ? req.query.from
      : new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10);

    const D = BUTCHER_DATE;
    const N = (e) => `NULLIF(${e}, '')::numeric`;

    // null = بلا حصر شركة (سوبر أدمن بلا اختيار). غير هيك، أرقام كل شركة
    // منفصلة عن التانية — جزار شركة ما بيظهر بترتيب جزارين شركة تانية.
    const companyScope = companyIdOf(req);
    const statsParams = [from, to];
    let companyWhere = "";
    if (companyScope != null) { statsParams.push(companyScope); companyWhere = ` AND r.company_id = $${statsParams.length}`; }

    const sql = `
      WITH ops AS (
        SELECT
          r.id,
          NULLIF(TRIM(r.payload->>'employeeNo'), '')           AS emp,
          COALESCE(NULLIF(r.payload->>'butcherName', ''), '')  AS name,
          COALESCE(NULLIF(r.payload->>'branch', ''), '')       AS branch,
          ${D}                                                 AS day,
          COALESCE(${N("r.payload->>'carcassWeightKg'")}, 0)   AS raw,
          (r.payload->>'stdYieldOn' = 'true')                  AS std_on,
          COALESCE(ABS(${N("r.payload->>'stdTolPct'")}), 0)     AS tol,
          COALESCE(${N("r.payload->>'durationMin'")}, 0)        AS dur,
          r.payload->'cuts'                                    AS cuts
        FROM reports r
        WHERE r.type = 'butcher_cut_log'
          AND COALESCE(r.payload->'changeRequest'->>'status', '') <> 'approved'
          AND ${D} >= $1
          AND ${D} <= $2${companyWhere}
      ),
      sums AS (
        SELECT
          o.id,
          COALESCE(SUM(CASE WHEN COALESCE(c->>'kind', 'product') = 'product'
                            THEN COALESCE(${N("c->>'weightKg'")}, 0) ELSE 0 END), 0) AS products,
          COALESCE(SUM(CASE WHEN COALESCE(c->>'kind', 'product') <> 'product'
                            THEN COALESCE(${N("c->>'weightKg'")}, 0) ELSE 0 END), 0)
          + COALESCE(SUM(COALESCE(${N("c->>'wasteBoneKg'")}, 0)), 0)                 AS waste
        FROM ops o
        LEFT JOIN LATERAL jsonb_array_elements(o.cuts) c ON TRUE
        GROUP BY o.id
      ),
      calc AS (
        SELECT o.*, s.products, s.waste,
               CASE WHEN o.raw > 0 THEN o.raw ELSE s.products + s.waste END AS base
        FROM ops o JOIN sums s USING (id)
      ),
      std AS (
        SELECT
          k.id,
          COUNT(*) FILTER (
            WHERE COALESCE(${N("c->>'stdPct'")}, 0) > 0
              AND COALESCE(${N("c->>'weightKg'")}, 0) > 0
          ) AS lines_checked,
          COUNT(*) FILTER (
            WHERE COALESCE(${N("c->>'stdPct'")}, 0) > 0
              AND COALESCE(${N("c->>'weightKg'")}, 0) > 0
              AND k.base > 0
              AND ABS(COALESCE(${N("c->>'weightKg'")}, 0) / k.base * 100
                      - COALESCE(${N("c->>'stdPct'")}, 0)) > k.tol
          ) AS lines_off
        FROM calc k
        LEFT JOIN LATERAL jsonb_array_elements(k.cuts) c ON TRUE
        GROUP BY k.id
      ),
      per_op AS (
        SELECT k.*, st.lines_checked, st.lines_off,
               CASE WHEN k.base > 0 THEN k.products / k.base * 100 END AS yield_pct,
               (k.std_on AND st.lines_checked > 0)                      AS std_checked,
               (k.std_on AND st.lines_checked > 0 AND st.lines_off = 0) AS std_pass
        FROM calc k JOIN std st USING (id)
      )
      SELECT
        emp                                                        AS "empNo",
        (ARRAY_AGG(name ORDER BY day DESC, id DESC)
           FILTER (WHERE name <> ''))[1]                           AS "name",
        (ARRAY_AGG(branch ORDER BY day DESC, id DESC)
           FILTER (WHERE branch <> ''))[1]                         AS "branch",
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(branch, '')), NULL) AS "branches",
        COUNT(*)::int                                              AS "ops",
        ROUND(SUM(raw)::numeric, 3)::float8                        AS "rawKg",
        ROUND(SUM(products)::numeric, 3)::float8                   AS "productsKg",
        ROUND(SUM(waste)::numeric, 3)::float8                      AS "wasteKg",
        ROUND(SUM(base)::numeric, 3)::float8                       AS "baseKg",
        ROUND(AVG(yield_pct)::numeric, 2)::float8                  AS "avgYieldPct",
        ROUND(STDDEV_SAMP(yield_pct)::numeric, 2)::float8          AS "yieldSd",
        COUNT(*) FILTER (WHERE yield_pct IS NOT NULL)::int         AS "yieldOps",
        ROUND(SUM(dur)::numeric, 1)::float8                        AS "durMin",
        COUNT(*) FILTER (WHERE dur > 0)::int                       AS "durOps",
        ROUND(SUM(base) FILTER (WHERE dur > 0)::numeric, 3)::float8 AS "durBaseKg",
        COUNT(*) FILTER (WHERE std_checked)::int                   AS "stdOps",
        COUNT(*) FILTER (WHERE std_pass)::int                      AS "stdPassOps",
        MAX(day)                                                   AS "lastDay"
      FROM per_op
      WHERE emp IS NOT NULL
      GROUP BY emp
      ORDER BY "ops" DESC`;

    const { rows } = await pool.query(sql, statsParams);
    res.json({ ok: true, from, to, data: rows });
  } catch (e) {
    console.error("[butcher-stats]", e);
    res.status(500).json({ ok: false, error: "stats failed" });
  }
});

app.put("/api/reports/returns", auth, async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { items = [], _clientSavedAt } = req.body || {};

    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });

    const payload = {
      reportDate,
      items: Array.isArray(items) ? items : [],
      _clientSavedAt: _clientSavedAt || Date.now(),
    };

    const companyId = companyIdForWrite(req);
    const old = await fetchOldByTypeDate("returns", reportDate, companyId);

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE(reporter,'anonymous'),
              payload=${KEEP_REF("$1")},
              updated_at=now()
        WHERE type='returns' AND payload->>'reportDate'=$2 AND company_id=$3
        RETURNING *`,
      [payload, reportDate, companyId]
    );

    if (upd.rowCount > 0) {
      auditWrite(req, {
        action: "update",
        reportId: upd.rows[0].id,
        reportType: "returns",
        oldPayload: old?.payload ?? null,
        newPayload: upd.rows[0].payload,
      });
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload,company_id)
       VALUES ('anonymous','returns',$1::jsonb,$2)
       RETURNING *`,
      [await stampRef(pool, "returns", payload, companyId), companyId]
    );

    auditCreate(req, ins.rows[0]);
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/returns ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/qcs", auth, async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { details = {}, _clientSavedAt } = req.body || {};
    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });

    const payload = {
      reportDate,
      details: isObj(details) ? details : {},
      _clientSavedAt: _clientSavedAt || Date.now(),
    };

    const companyId = companyIdForWrite(req);
    const old = await fetchOldByTypeDate("qcs", reportDate, companyId);

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE(reporter,'anonymous'),
              payload=${KEEP_REF("$1")},
              updated_at=now()
        WHERE type='qcs' AND payload->>'reportDate'=$2 AND company_id=$3
        RETURNING *`,
      [payload, reportDate, companyId]
    );
    if (upd.rowCount > 0) {
      auditWrite(req, {
        action: "update",
        reportId: upd.rows[0].id,
        reportType: "qcs",
        oldPayload: old?.payload ?? null,
        newPayload: upd.rows[0].payload,
      });
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload,company_id)
       VALUES ('anonymous','qcs',$1::jsonb,$2)
       RETURNING *`,
      [await stampRef(pool, "qcs", payload, companyId), companyId]
    );
    auditCreate(req, ins.rows[0]);
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/qcs ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ============================================================
   POST /api/reports/qcs-coolers/reading

   قراءة حرارة وحدة من الموبايل (QR على البراد) — قراءة وحدة، مش الشيت كامل.

   ليش مسار لحاله: سجل الحرارة بـQCS سجل واحد لليوم (8 برادات × الأوقات).
   لو كل موبايل بعت الشيت كامل بـPUT، موظفين بيسجلوا برادين بنفس اللحظة
   بيمسح واحد قراءة التاني. هون القراءة بتندمج بالسجل جوّا transaction
   مع FOR UPDATE، فما بتضيع ولا قراءة.

   body: { reportDate, unit: "cooler-N" | "loading-area", slot: "10:00 AM",
           value, readingId, kind: "reading" | "recheck", at, by,
           correctiveAction?, remarkLine?, photoUrl?, recheckDue?,
           replace?, coolerDefs?, loadingDef? }

   • نفس readingId مرتين (outbox بعتها تاني) = ولا تغيير.
   • خانة الوقت معبّاية و replace مش true → 409 SLOT_FILLED.
   • recheck ما بيلمس الخانة؛ بينزل بالملاحظات وبالسجل بس.
============================================================ */
const COOLERS_TYPE = "qcs-coolers";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UNIT_RE = /^(cooler-(\d{1,2})|loading-area)$/;
const SLOT_RE = /^\d{1,2}:00 (AM|PM)$/;
const clip = (v, n) => String(v ?? "").trim().slice(0, n);

async function mergeCoolerReading(req, b) {
  const companyId = companyIdForWrite(req);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const cur = await db.query(
      `SELECT id, payload FROM reports
        WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1)
          AND type = $2 AND payload->>'reportDate' = $3
        ORDER BY id LIMIT 1
        FOR UPDATE`,
      [companyId, COOLERS_TYPE, b.reportDate]
    );
    const row = cur.rows[0] || null;
    const old = row?.payload || null;
    const p = old ? JSON.parse(JSON.stringify(old)) : { reportDate: b.reportDate };

    const log = Array.isArray(p.quickReadings) ? p.quickReadings : [];
    if (log.some((r) => r && r.id === b.readingId)) {
      await db.query("ROLLBACK");
      return { status: 200, json: { ok: true, duplicate: true, report: row } };
    }

    // The limits in force today travel with the record, as the sheet does.
    if (!p.coolerDefs && Array.isArray(b.coolerDefs)) p.coolerDefs = b.coolerDefs;
    if (!p.loadingDef && isObj(b.loadingDef)) p.loadingDef = b.loadingDef;

    let block;
    if (b.unit === "loading-area") {
      p.loadingArea = isObj(p.loadingArea) ? p.loadingArea : {};
      block = p.loadingArea;
    } else {
      const i = Number(b.unit.split("-")[1]);
      p.coolers = Array.isArray(p.coolers) ? p.coolers : [];
      while (p.coolers.length <= i) p.coolers.push({ temps: {}, remarks: "" });
      if (!isObj(p.coolers[i])) p.coolers[i] = { temps: {}, remarks: "" };
      block = p.coolers[i];
    }
    block.temps = isObj(block.temps) ? block.temps : {};
    if (typeof block.remarks !== "string") block.remarks = "";

    const valueStr = String(b.value);
    if (b.kind === "reading") {
      const prev = String(block.temps[b.slot] ?? "").trim();
      if (prev !== "" && !b.replace) {
        await db.query("ROLLBACK");
        return { status: 409, json: { ok: false, error: "SLOT_FILLED", value: prev } };
      }
      block.temps[b.slot] = valueStr;
    }
    if (b.remarkLine) {
      block.remarks = block.remarks ? `${block.remarks} | ${b.remarkLine}` : b.remarkLine;
    }

    log.push({
      id: b.readingId,
      unit: b.unit,
      slot: b.slot,
      value: b.value,
      kind: b.kind,
      at: b.at,
      savedAt: new Date().toISOString(),
      by: b.by,
      byName: b.byName,
      outOfRange: !!b.outOfRange,
      correctiveAction: b.correctiveAction || "",
      // The exact line added to the unit's remarks — the sheet re-adds it from here.
      remarkLine: b.remarkLine || "",
      photoUrl: b.photoUrl || "",
      recheckDue: b.recheckDue || "",
      replaced: b.kind === "reading" && !!b.replace,
    });
    p.quickReadings = log;

    let saved;
    if (row) {
      const upd = await db.query(
        `UPDATE reports SET payload=${KEEP_REF("$1")}, updated_at=now()
          WHERE id=$2 RETURNING *`,
        [JSON.stringify(p), row.id]
      );
      saved = upd.rows[0];
    } else {
      const stamped = await stampRef(db, COOLERS_TYPE, p, companyId);
      const ins = await db.query(
        `INSERT INTO reports (reporter, type, payload, company_id)
         VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
        ["QCS/COOLERS", COOLERS_TYPE, JSON.stringify(stamped), companyId]
      );
      saved = ins.rows[0];
    }
    await db.query("COMMIT");

    if (row) {
      auditWrite(req, {
        action: "update", reportId: saved.id, reportType: COOLERS_TYPE,
        oldPayload: old, newPayload: saved.payload,
      });
    } else {
      auditCreate(req, saved);
    }
    return { status: row ? 200 : 201, json: { ok: true, report: saved } };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

app.post("/api/reports/qcs-coolers/reading", auth, async (req, res) => {
  try {
    const x = req.body || {};
    const unit = String(x.unit || "");
    const um = unit.match(UNIT_RE);
    const value = Number(x.value);
    const b = {
      reportDate: String(x.reportDate || ""),
      unit,
      slot: String(x.slot || ""),
      value,
      kind: x.kind === "recheck" ? "recheck" : "reading",
      readingId: clip(x.readingId, 80),
      at: clip(x.at, 40) || new Date().toISOString(),
      by: clip(req.user?.username || x.by, 80),
      byName: clip(x.byName, 120),
      outOfRange: !!x.outOfRange,
      correctiveAction: clip(x.correctiveAction, 300),
      remarkLine: clip(x.remarkLine, 300),
      photoUrl: /^https:\/\//.test(String(x.photoUrl || "")) ? clip(x.photoUrl, 500) : "",
      recheckDue: clip(x.recheckDue, 40),
      replace: x.replace === true,
      coolerDefs: Array.isArray(x.coolerDefs) ? x.coolerDefs.slice(0, 20) : null,
      loadingDef: isObj(x.loadingDef) ? x.loadingDef : null,
    };
    if (!DATE_RE.test(b.reportDate)) return res.status(400).json({ ok: false, error: "reportDate YYYY-MM-DD required" });
    if (!um || (um[2] != null && Number(um[2]) > 19)) return res.status(400).json({ ok: false, error: "bad unit" });
    if (!SLOT_RE.test(b.slot)) return res.status(400).json({ ok: false, error: "bad slot" });
    if (!Number.isFinite(value) || value < -60 || value > 80) return res.status(400).json({ ok: false, error: "bad value" });
    if (!b.readingId) return res.status(400).json({ ok: false, error: "readingId required" });

    let out;
    try {
      out = await mergeCoolerReading(req, b);
    } catch (e) {
      // Two first readings of the day raced to INSERT: the loser merges into the winner.
      if (e && e.code === "23505") out = await mergeCoolerReading(req, b);
      else throw e;
    }
    if (out.status < 300 && !out.json?.duplicate) {
      // after the answer: the alert (and its e-mail) must not slow the phone down
      setImmediate(() => onTemperatureReading(pool, companyIdForWrite(req), {
        type: COOLERS_TYPE, branch: "QCS", reportDate: b.reportDate, unit: b.unit,
        unitLabel: clip(x.unitLabel, 80) || b.unit, slot: b.slot, value: b.value, kind: b.kind,
        outOfRange: b.outOfRange, correctiveAction: b.correctiveAction, byName: b.byName,
        min: num(x.min), max: num(x.max), link: `/monitor/qcs/coolers/quick/${b.unit}`,
      }));
    }
    return res.status(out.status).json(out.json);
  } catch (e) {
    console.error("POST /api/reports/qcs-coolers/reading ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ============================================================
   POST /api/reports/branch-temp/reading

   Same idea as the QCS cooler reading above, for the branch temperature
   sheets (QR sticker on each unit): one reading merged into that day's
   record inside a transaction, so phones never overwrite each other.

   Two record shapes exist today:
   • "grid"  (POS 10 / 11 / 15) — payload.coolers[{ name, temps: { "8:00 AM": "3" }, remarks }]
   • "pos19" (POS 19)           — payload.entries[{ equipment, unitType, am_time, am_temp, … }]
   A unit is matched by NAME (case-insensitive); an unknown name is added
   as a new row. Same readingId twice = no change. A filled slot answers
   409 SLOT_FILLED unless replace=true. A recheck only adds to the log
   and the remarks / corrective action.

   body: { type, reportDate, unit, unitType?, slot, timeHM?, value, readingId,
           kind, at, by, byName, outOfRange, correctiveAction,
           remarkLine, photoUrl, recheckDue, replace, units? }
   `units` (names, optional) seeds the rows when the day's record is created.
============================================================ */
const BRANCH_TEMP = {
  pos10_temperature: { shape: "grid", branch: "POS 10", reporter: "pos10",
    slots: ["8:00 AM", "11:00 AM", "2:00 PM", "5:00 PM", "8:00 PM", "10:00 PM"] },
  pos11_temperature: { shape: "grid", branch: "POS 11", reporter: "pos11",
    slots: ["8:00 AM", "12:00 PM", "4:00 PM", "8:00 PM"] },
  pos15_temperature: { shape: "grid", branch: "POS 15", reporter: "pos15",
    slots: ["8:00 AM", "11:00 AM", "2:00 PM", "5:00 PM", "8:00 PM", "10:00 PM"] },
  pos19_temperature_monitoring: { shape: "pos19", branch: "POS 19", reporter: "pos19",
    slots: ["am", "pm", "ev"] },
};
const POS19_TARGET = { chiller: "≤ 5°C", freezer: "≤ -18°C", ambient: "≤ 25°C" };
const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
const appendText = (prev, line) => (prev ? `${prev} | ${line}` : line);
const emptyPos19Row = (name, unitType) => {
  const ut = POS19_TARGET[unitType] ? unitType : "chiller";
  return { equipment: name, unitType: ut, targetTemp: POS19_TARGET[ut], correctiveAction: "", checkedBy: "",
    am_time: "", am_temp: "", pm_time: "", pm_temp: "", ev_time: "", ev_temp: "" };
};

async function mergeBranchReading(req, cfg, b) {
  const companyId = companyIdForWrite(req);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    /* POS 11 / POS 15 sheets saved only `date` (no reportDate) — match either,
       or the phone would open a second record for a day the sheet already filed. */
    const cur = await db.query(
      `SELECT id, payload FROM reports
        WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1)
          AND type = $2
          AND COALESCE(NULLIF(payload->>'reportDate', ''), LEFT(payload->>'date', 10)) = $3
        ORDER BY (payload->>'reportDate' = $3) DESC NULLS LAST, id
        LIMIT 1
        FOR UPDATE`,
      [companyId, b.type, b.reportDate]
    );
    const row = cur.rows[0] || null;
    const old = row?.payload || null;
    const day = old ? JSON.parse(JSON.stringify(old)) : { branch: cfg.branch, reportDate: b.reportDate, date: b.reportDate };
    if (!day.reportDate) day.reportDate = b.reportDate;

    const log = Array.isArray(day.quickReadings) ? day.quickReadings : [];
    if (log.some((r) => r && r.id === b.readingId)) {
      await db.query("ROLLBACK");
      return { status: 200, json: { ok: true, duplicate: true, report: row } };
    }

    const valueStr = String(b.value);
    const slotFilled = (prev) => ({ status: 409, json: { ok: false, error: "SLOT_FILLED", value: prev } });

    if (cfg.shape === "grid") {
      if (!old) {
        day.coolers = b.units.map((name) => ({ name, temps: {}, remarks: "" }));
        day.productVerifications = [];
        day.times = [...cfg.slots, "Corrective Action"];
        day.unique_key = `${b.type}_${b.reportDate}`;
        day.checkedBy = "";
        day.verifiedBy = "";
      }
      day.coolers = Array.isArray(day.coolers) ? day.coolers : [];
      let unit = day.coolers.find((c) => c && sameName(c.name, b.unit));
      if (!unit) { unit = { name: b.unit, temps: {}, remarks: "" }; day.coolers.push(unit); }
      unit.temps = isObj(unit.temps) ? unit.temps : {};
      if (b.kind === "reading") {
        const prev = String(unit.temps[b.slot] ?? "").trim();
        if (prev !== "" && !b.replace) { await db.query("ROLLBACK"); return slotFilled(prev); }
        unit.temps[b.slot] = valueStr;
      }
      if (b.remarkLine) {
        unit.remarks = appendText(String(unit.remarks || ""), b.remarkLine);
        unit.temps["Corrective Action"] = unit.remarks; // the sheet keeps both in step
      }
    } else {
      if (!old) {
        day.entries = b.units.map((name) => emptyPos19Row(name, "chiller"));
        day.classification = "Official";
        day.section = "";
        day.checkedBy = "";
        day.verifiedBy = "";
      }
      day.entries = Array.isArray(day.entries) ? day.entries : [];
      let unit = day.entries.find((e) => e && sameName(e.equipment, b.unit));
      if (!unit) { unit = emptyPos19Row(b.unit, b.unitType); day.entries.push(unit); }
      if (b.kind === "reading") {
        const prev = String(unit[`${b.slot}_temp`] ?? "").trim();
        if (prev !== "" && !b.replace) { await db.query("ROLLBACK"); return slotFilled(prev); }
        unit[`${b.slot}_temp`] = valueStr;
        unit[`${b.slot}_time`] = b.timeHM || "";
        if (!unit.checkedBy && b.byName) unit.checkedBy = b.byName;
      }
      if (b.remarkLine) unit.correctiveAction = appendText(String(unit.correctiveAction || ""), b.remarkLine);
    }

    log.push({
      id: b.readingId, unit: b.unit, slot: b.slot, value: b.value, kind: b.kind,
      at: b.at, savedAt: new Date().toISOString(), by: b.by, byName: b.byName,
      outOfRange: !!b.outOfRange, correctiveAction: b.correctiveAction || "",
      remarkLine: b.remarkLine || "", photoUrl: b.photoUrl || "", recheckDue: b.recheckDue || "",
      timeHM: b.timeHM || "", replaced: b.kind === "reading" && !!b.replace,
    });
    day.quickReadings = log;

    let saved;
    if (row) {
      const upd = await db.query(
        `UPDATE reports SET payload=${KEEP_REF("$1")}, updated_at=now() WHERE id=$2 RETURNING *`,
        [JSON.stringify(day), row.id]
      );
      saved = upd.rows[0];
    } else {
      const stamped = await stampRef(db, b.type, day, companyId);
      const ins = await db.query(
        `INSERT INTO reports (reporter, type, payload, company_id) VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
        [cfg.reporter, b.type, JSON.stringify(stamped), companyId]
      );
      saved = ins.rows[0];
    }
    await db.query("COMMIT");
    if (row) auditWrite(req, { action: "update", reportId: saved.id, reportType: b.type, oldPayload: old, newPayload: saved.payload });
    else auditCreate(req, saved);
    return { status: row ? 200 : 201, json: { ok: true, report: saved } };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

app.post("/api/reports/branch-temp/reading", auth, async (req, res) => {
  try {
    const x = req.body || {};
    const type = String(x.type || "");
    const cfg = BRANCH_TEMP[type];
    if (!cfg) return res.status(400).json({ ok: false, error: "bad type" });
    const value = Number(x.value);
    const b = {
      type,
      reportDate: String(x.reportDate || ""),
      unit: clip(x.unit, 80),
      unitType: clip(x.unitType, 20),
      slot: String(x.slot || ""),
      timeHM: /^\d{1,2}:\d{2}$/.test(String(x.timeHM || "")) ? String(x.timeHM) : "",
      value,
      kind: x.kind === "recheck" ? "recheck" : "reading",
      readingId: clip(x.readingId, 80),
      at: clip(x.at, 40) || new Date().toISOString(),
      by: clip(req.user?.username || x.by, 80),
      byName: clip(x.byName, 120),
      outOfRange: !!x.outOfRange,
      correctiveAction: clip(x.correctiveAction, 300),
      remarkLine: clip(x.remarkLine, 300),
      photoUrl: /^https:\/\//.test(String(x.photoUrl || "")) ? clip(x.photoUrl, 500) : "",
      recheckDue: clip(x.recheckDue, 40),
      replace: x.replace === true,
      units: Array.isArray(x.units) ? x.units.slice(0, 40).map((n) => clip(n, 80)).filter(Boolean) : [],
    };
    if (!DATE_RE.test(b.reportDate)) return res.status(400).json({ ok: false, error: "reportDate YYYY-MM-DD required" });
    if (!b.unit) return res.status(400).json({ ok: false, error: "unit required" });
    if (!cfg.slots.includes(b.slot)) return res.status(400).json({ ok: false, error: "bad slot" });
    if (!Number.isFinite(value) || value < -60 || value > 80) return res.status(400).json({ ok: false, error: "bad value" });
    if (!b.readingId) return res.status(400).json({ ok: false, error: "readingId required" });

    let out;
    try {
      out = await mergeBranchReading(req, cfg, b);
    } catch (e) {
      // Two first readings of the day raced to INSERT: the loser merges into the winner.
      if (e && e.code === "23505") out = await mergeBranchReading(req, cfg, b);
      else throw e;
    }
    if (out.status < 300 && !out.json?.duplicate) {
      setImmediate(() => onTemperatureReading(pool, companyIdForWrite(req), {
        type, branch: cfg.branch, reportDate: b.reportDate, unit: b.unit,
        unitLabel: clip(x.unitLabel, 80) || b.unit, slot: b.slot, value: b.value, kind: b.kind,
        outOfRange: b.outOfRange, correctiveAction: b.correctiveAction, byName: b.byName,
        min: num(x.min), max: num(x.max), link: "",
      }));
    }
    return res.status(out.status).json(out.json);
  } catch (e) {
    console.error("POST /api/reports/branch-temp/reading ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ============================================================
   POST /api/reports/cold-rooms-stock/move

   One product moved in or out of a cooler — from the QR page on the unit
   (front: pages/monitor/branches/_shared/QuickGoodsPanel.jsx).

   The stock of every room/unit lives in ONE record (type cold_rooms_stock,
   reportDate "stock", payload.rooms[key] = { items, moves, … }). If each
   phone read it and PUT it back whole, two storekeepers saving at the same
   moment would wipe each other's move. Here the move is applied inside a
   transaction with FOR UPDATE on that record, so none is lost.

   Every move is also appended, under the same lock, to that month's full
   log (type cold_rooms_moves, reportDate "YYYY-MM", UAE month) — the room
   itself keeps only its last 200 for the screens.

   body: { key, moveId, dir: "in"|"out", code, product, uom, qty, pcs?,
           supplier?, prodDate?, expDate?, keeper, destType?, destination?,
           at?, replay? }
   • A lot = same code (or product) + supplier + prodDate + expDate + batch
     (batch / gtin come from the carton barcode when it was scanned).
   • Same moveId twice (outbox replay) = no change.
   • Out of more than is inside → 409 TOO_MUCH; lot not inside → 409
     NOT_HERE. A REPLAY (queued offline, the goods already left) is
     recorded anyway: the lot is emptied and the move carries shortBy /
     notFound, so the books show what really happened.
============================================================ */
const STOCK_TYPE = "cold_rooms_stock";
const MOVES_TYPE = "cold_rooms_moves";
const MOVES_KEPT = 200;
const KEY_RE = /^(\d{1,2}|unit:.{1,200})$/;
const LOT_FIELDS = ["supplier", "prodDate", "expDate", "batch"];
// what one "piece" is: a box, a plate, a tray… (empty = a single piece)
const PCS_UNITS = ["piece", "box", "carton", "plate", "tray", "bag", "pack", "head"];
const pcsUnitOf = (v) => (PCS_UNITS.includes(v) ? v : "");
const toQty = (v) => {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
};
function stockItem(raw) {
  const it = {
    code: clip(raw?.code, 60), product: clip(raw?.product, 200), uom: clip(raw?.uom, 30), qty: toQty(raw?.qty),
  };
  LOT_FIELDS.forEach((k) => { const v = clip(raw?.[k], 120); if (v) it[k] = v; });
  if (toQty(raw?.pcs) > 0) {
    it.pcs = toQty(raw.pcs);
    if (pcsUnitOf(raw?.pcsUnit)) it.pcsUnit = raw.pcsUnit;
  }
  const gtin = String(raw?.gtin ?? "").replace(/\D/g, "");
  if (/^\d{14}$/.test(gtin)) it.gtin = gtin; // the carton barcode, information only
  return it;
}
const sameStockLot = (a, b) =>
  (a.code ? a.code === b.code : a.product === b.product) &&
  LOT_FIELDS.every((k) => String(a[k] || "") === String(b[k] || ""));
const uaeMonth = (iso) => {
  const t = new Date(iso).getTime();
  return new Date((Number.isFinite(t) ? t : Date.now()) + 4 * 3600000).toISOString().slice(0, 7);
};

async function lockRecord(db, companyId, type, key) {
  const cur = await db.query(
    `SELECT id, payload FROM reports
      WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1)
        AND type = $2 AND payload->>'reportDate' = $3
      ORDER BY id LIMIT 1
      FOR UPDATE`,
    [companyId, type, key]
  );
  return cur.rows[0] || null;
}
async function writeRecord(db, companyId, type, row, payload, reporter) {
  if (row) {
    const upd = await db.query(
      `UPDATE reports SET payload=${KEEP_REF("$1")}, updated_at=now() WHERE id=$2 RETURNING *`,
      [JSON.stringify(payload), row.id]
    );
    return upd.rows[0];
  }
  const stamped = await stampRef(db, type, payload, companyId);
  const ins = await db.query(
    `INSERT INTO reports (reporter, type, payload, company_id) VALUES ($1, $2, $3::jsonb, $4) RETURNING *`,
    [reporter, type, JSON.stringify(stamped), companyId]
  );
  return ins.rows[0];
}

async function applyStockMove(req, b) {
  const companyId = companyIdForWrite(req);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const row = await lockRecord(db, companyId, STOCK_TYPE, "stock");
    const old = row?.payload || null;
    const p = old ? JSON.parse(JSON.stringify(old)) : { reportDate: "stock", rooms: {} };
    p.rooms = isObj(p.rooms) ? p.rooms : {};
    const room = isObj(p.rooms[b.key]) ? p.rooms[b.key] : {};
    const moves = Array.isArray(room.moves) ? room.moves : [];
    if (moves.some((m) => m && m.id === b.moveId)) {
      await db.query("ROLLBACK");
      return { status: 200, json: { ok: true, duplicate: true, room } };
    }

    const items = (Array.isArray(room.items) ? room.items : []).map(stockItem).filter((it) => it.code || it.product);
    const lot = stockItem(b);
    const at = items.findIndex((it) => sameStockLot(it, lot));
    const move = {
      id: b.moveId, at: b.at, savedAt: new Date().toISOString(), by: b.by, dir: b.dir,
      code: lot.code, product: lot.product || items[at]?.product || "", uom: lot.uom || items[at]?.uom || "", qty: lot.qty,
      keeper: b.keeper,
    };
    LOT_FIELDS.forEach((k) => { if (lot[k]) move[k] = lot[k]; });
    if (lot.gtin) move.gtin = lot.gtin;
    if (b.pcs > 0) move.pcs = b.pcs;
    if (b.pcs > 0 && b.pcsUnit) move.pcsUnit = b.pcsUnit;

    if (b.dir === "out") {
      move.destType = b.destType;
      if (b.destination) move.destination = b.destination;
      if (at < 0) {
        if (!b.replay) { await db.query("ROLLBACK"); return { status: 409, json: { ok: false, error: "NOT_HERE" } }; }
        move.notFound = true;
      } else {
        const have = items[at].qty;
        if (lot.qty > have + 1e-9) {
          if (!b.replay) { await db.query("ROLLBACK"); return { status: 409, json: { ok: false, error: "TOO_MUCH", value: have } }; }
          move.shortBy = Math.round((lot.qty - have) * 1000) / 1000;
        }
        const left = Math.round((have - lot.qty) * 1000) / 1000;
        if (left <= 0) items.splice(at, 1);
        else {
          const r = { ...items[at], qty: left };
          if (r.pcs && b.pcs > 0) r.pcs = Math.max(0, r.pcs - b.pcs);
          if (!r.pcs) { delete r.pcs; delete r.pcsUnit; }
          items[at] = r;
        }
      }
    } else if (at >= 0) {
      const r = { ...items[at], qty: Math.round((items[at].qty + lot.qty) * 1000) / 1000 };
      if (b.pcs > 0) {
        if (b.pcsUnit && (!r.pcs || !r.pcsUnit)) r.pcsUnit = b.pcsUnit;
        r.pcs = (r.pcs || 0) + b.pcs;
      }
      items[at] = r;
    } else {
      items.unshift(lot);
    }

    p.rooms[b.key] = {
      ...room, items, moves: [...moves, move].slice(-MOVES_KEPT),
      updatedAt: move.savedAt, updatedBy: b.by || b.keeper || "",
    };
    const saved = await writeRecord(db, companyId, STOCK_TYPE, row, p, "cold-rooms-stock");

    // the month's full log
    const month = uaeMonth(move.at || move.savedAt);
    const logRow = await lockRecord(db, companyId, MOVES_TYPE, month);
    const lp = logRow?.payload ? JSON.parse(JSON.stringify(logRow.payload)) : { reportDate: month, moves: [] };
    lp.moves = Array.isArray(lp.moves) ? lp.moves : [];
    lp.moves.push({ ...move, key: b.key });
    await writeRecord(db, companyId, MOVES_TYPE, logRow, lp, "cold-rooms-stock");

    await db.query("COMMIT");
    if (row) {
      auditWrite(req, { action: "update", reportId: saved.id, reportType: STOCK_TYPE, oldPayload: old, newPayload: saved.payload });
    } else {
      auditCreate(req, saved);
    }
    return { status: 200, json: { ok: true, room: p.rooms[b.key], move } };
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

app.post("/api/reports/cold-rooms-stock/move", auth, async (req, res) => {
  try {
    const x = req.body || {};
    const b = {
      key: clip(x.key, 220),
      moveId: clip(x.moveId, 80),
      dir: x.dir === "out" ? "out" : x.dir === "in" ? "in" : "",
      code: x.code, product: x.product, uom: x.uom, qty: toQty(x.qty),
      supplier: x.supplier, prodDate: x.prodDate, expDate: x.expDate, batch: x.batch, gtin: x.gtin,
      pcs: toQty(x.pcs) > 0 ? toQty(x.pcs) : 0,
      pcsUnit: pcsUnitOf(x.pcsUnit),
      keeper: clip(x.keeper, 120),
      destType: x.destType === "customer" || x.destType === "branch" ? x.destType : "",
      destination: clip(x.destination, 80),
      at: clip(x.at, 40) || new Date().toISOString(),
      by: clip(req.user?.username || x.by, 80),
      replay: x.replay === true,
    };
    if (!KEY_RE.test(b.key)) return res.status(400).json({ ok: false, error: "bad key" });
    if (!b.moveId) return res.status(400).json({ ok: false, error: "moveId required" });
    if (!b.dir) return res.status(400).json({ ok: false, error: "dir in|out required" });
    if (!(b.qty > 0)) return res.status(400).json({ ok: false, error: "qty required" });
    if (!String(b.code || "").trim() && !String(b.product || "").trim()) return res.status(400).json({ ok: false, error: "product required" });
    if (!b.keeper) return res.status(400).json({ ok: false, error: "keeper required" });
    if (b.dir === "in") {
      if (!String(b.supplier || "").trim() || !DATE_RE.test(String(b.prodDate || "")) || !DATE_RE.test(String(b.expDate || ""))) {
        return res.status(400).json({ ok: false, error: "supplier, prodDate and expDate required" });
      }
      if (String(b.expDate) <= String(b.prodDate)) return res.status(400).json({ ok: false, error: "expDate must be after prodDate" });
    } else {
      if (!b.destType) return res.status(400).json({ ok: false, error: "destType required" });
      if (b.destType === "branch" && !b.destination) return res.status(400).json({ ok: false, error: "destination required" });
    }

    let out;
    try {
      out = await applyStockMove(req, b);
    } catch (e) {
      // first move ever / first of the month raced to INSERT: run again into the winner
      if (e && e.code === "23505") out = await applyStockMove(req, b);
      else throw e;
    }
    return res.status(out.status).json(out.json);
  } catch (e) {
    console.error("POST /api/reports/cold-rooms-stock/move ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
};
