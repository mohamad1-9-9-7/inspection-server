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
    return res.status(out.status).json(out.json);
  } catch (e) {
    console.error("POST /api/reports/qcs-coolers/reading ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
};
