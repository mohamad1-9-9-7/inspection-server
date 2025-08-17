// index.cjs — Open-CRUD backend (Express + Postgres) with FULL public access
// تشغيل محلي: PORT=5000 node index.cjs
// متغيّرات البيئة: DATABASE_URL (Render Postgres)

const express = require("express");
const cors = require("cors");
const pg = require("pg");

const app = express();
const PORT = process.env.PORT || 5000;

/* =================== CORS مفتوح للجميع =================== */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
// هيدر إضافي تحسّبًا
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* =================== Body Parser =================== */
app.use(express.json({ limit: "2mb" }));

/* =================== PostgreSQL =================== */
const { Pool } = pg;
// ✅ تفعيل SSL دائمًا (ضروري عادةً مع Render Postgres)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* =================== تهيئة السكيمة =================== */
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id          BIGSERIAL PRIMARY KEY,
      reporter    TEXT,
      type        TEXT NOT NULL,
      payload     JSONB NOT NULL,         -- يحتوي reportDate و items
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(type);
    CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);

    -- (اختياري) فهرس فريد لدعم upsert لاحقًا. إذا عندك بيانات مكررة ممكن يفشل.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname  = 'ux_reports_type_reportdate'
      ) THEN
        BEGIN
          EXECUTE 'CREATE UNIQUE INDEX ux_reports_type_reportdate
                   ON reports (type, (payload->>''reportDate''))';
        EXCEPTION WHEN OTHERS THEN
          -- لا توقف التشغيل لو فشل إنشاء الفهرس (مثلاً لوجود مكررات)
          RAISE NOTICE 'Skipping unique index creation: %', SQLERRM;
        END;
      END IF;
    END $$;
  `);
  console.log("✅ DB schema ready");
}

/* =================== Health & Diag =================== */
app.get("/", (_req, res) => res.send("OK"));
app.get("/healthz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.get("/version", (_req, res) => res.json({ v: "open-crud-5" }));
app.get("/diag/ping", (_req, res) => res.json({ ok: true }));
app.get("/diag/db", async (_req, res) => {
  try {
    const r = await pool.query("SELECT NOW() AS now");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =================== Utilities =================== */
function isPlainObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}
function parseMaybeJSON(val) {
  if (val && typeof val === "string") {
    try { return JSON.parse(val); } catch { /* leave as-is */ }
  }
  return val;
}

/* =================== API =================== */
/** قراءة كل التقارير أو حسب النوع */
app.get("/api/reports", async (req, res) => {
  const { type } = req.query;
  try {
    const q = type
      ? `SELECT * FROM reports WHERE type = $1 ORDER BY created_at DESC`
      : `SELECT * FROM reports ORDER BY created_at DESC`;
    const { rows } = await pool.query(q, type ? [type] : []);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db select failed" });
  }
});

/** إضافة تقرير جديد (قد يُكرر لنفس اليوم إن لم تستخدم PUT/UPSERT) */
app.post("/api/reports", async (req, res) => {
  try {
    let { reporter, type, payload } = req.body || {};
    payload = parseMaybeJSON(payload);
    if (!type || !isPlainObject(payload)) {
      return res.status(400).json({ ok: false, error: "type & payload are required" });
    }
    const payloadJson = JSON.stringify(payload);
    const { rows } = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [reporter || "anonymous", type, payloadJson]
    );
    res.status(201).json({ ok: true, report: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** تعديل (UPSERT) حسب (type + reportDate) — خطوتين + تصريح jsonb */
app.put("/api/reports", async (req, res) => {
  try {
    let { reporter, type, payload } = req.body || {};
    payload = parseMaybeJSON(payload);
    const reportDate = payload?.reportDate;
    if (!type || !isPlainObject(payload) || !reportDate) {
      return res.status(400).json({ ok: false, error: "type & payload.reportDate required" });
    }

    console.log("PUT /api/reports BODY =", JSON.stringify({ reporter, type, payload }));

    const payloadJson = JSON.stringify(payload);

    // 1) UPDATE أولاً
    const upd = await pool.query(
      `UPDATE reports
         SET reporter = $1,
             payload  = $2::jsonb,
             updated_at = now()
       WHERE type = $3
         AND payload->>'reportDate' = $4
       RETURNING *`,
      [reporter || "anonymous", payloadJson, type, String(reportDate)]
    );

    if (upd.rowCount > 0) {
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    // 2) لو ما لقى سجل، INSERT
    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [reporter || "anonymous", type, payloadJson]
    );
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });

  } catch (e) {
    console.error("PUT /api/reports ERROR =", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** مسار مخصوص للمرتجعات لتحديث items فقط: PUT /api/reports/returns?reportDate=YYYY-MM-DD
 *  Body: { items: [...], _clientSavedAt?: number }
 *  - يحدث items لو موجود
 *  - إذا غير موجود ينشئ سجل جديد type='returns'
 */
app.put("/api/reports/returns", async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const body = parseMaybeJSON(req.body);
    const items = Array.isArray(body?.items) ? body.items : null;
    const clientTs = body?._clientSavedAt;

    if (!reportDate) {
      return res.status(400).json({ ok: false, error: "reportDate required" });
    }
    if (!Array.isArray(items)) {
      return res.status(400).json({ ok: false, error: "items array required" });
    }

    // حاول تحديث items فقط
    const itemsJson = JSON.stringify(items);
    const upd = await pool.query(
      `UPDATE reports
         SET payload = jsonb_set(payload, '{items}', $1::jsonb, true),
             updated_at = now()
       WHERE type = 'returns'
         AND payload->>'reportDate' = $2
       RETURNING *`,
      [itemsJson, reportDate]
    );
    if (upd.rowCount > 0) {
      return res.json({ ok: true, report: upd.rows[0], method: "update-items" });
    }

    // لم يوجد سجل: أنشئ جديد
    const newPayload = {
      reportDate,
      items,
      _clientSavedAt: clientTs ?? Date.now(),
    };
    const newPayloadJson = JSON.stringify(newPayload);
    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      ["anonymous", "returns", newPayloadJson]
    );
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert-items" });
  } catch (e) {
    console.error("PUT /api/reports/returns ERROR =", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** تعديل بحسب ID */
app.put("/api/reports/:id", async (req, res) => {
  try {
    const { id } = req.params;
    let { payload, reporter, type } = req.body || {};
    payload = parseMaybeJSON(payload);

    if (!isPlainObject(payload) && reporter === undefined && type === undefined) {
      return res.status(400).json({ ok: false, error: "nothing to update" });
    }

    const updates = [];
    const params = [];
    let p = 1;

    if (reporter !== undefined) { updates.push(`reporter = $${p++}`); params.push(reporter); }
    if (type     !== undefined) { updates.push(`type     = $${p++}`); params.push(type); }
    if (payload  !== undefined) { updates.push(`payload  = $${p++}::jsonb`); params.push(JSON.stringify(payload)); }

    updates.push(`updated_at = now()`);

    const { rows, rowCount } = await pool.query(
      `UPDATE reports SET ${updates.join(", ")}
       WHERE id = $${p}
       RETURNING *`,
      [...params, id]
    );
    if (!rowCount) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, report: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** حذف حسب النوع + التاريخ */
app.delete("/api/reports", async (req, res) => {
  try {
    const { type, reportDate } = req.query;
    if (!type || !reportDate) {
      return res.status(400).json({ ok: false, error: "type & reportDate required" });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM reports
       WHERE type = $1 AND payload->>'reportDate' = $2`,
      [type, reportDate]
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** حذف حسب ID */
app.delete("/api/reports/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { rowCount } = await pool.query(`DELETE FROM reports WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =================== Boot =================== */
ensureSchema()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`✅ API running on :${PORT} (FULL public access: read/write/delete enabled)`)
    );
  })
  .catch((err) => {
    console.error("❌ DB init failed:", err);
    process.exit(1);
  });
