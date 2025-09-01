// index.cjs — Open-CRUD backend (Express + Postgres) + Cloudinary upload
require("dotenv").config(); // يحمل DATABASE_URL و CLOUDINARY_URL

const express   = require("express");
const cors      = require("cors");
const pg        = require("pg");
const multer    = require("multer");
const sharp     = require("sharp");
const cloudinary= require("cloudinary").v2; // يستخدم CLOUDINARY_URL من .env تلقائياً

cloudinary.config({ secure: true });

const app  = express();
const PORT = process.env.PORT || 5000;

/* =================== CORS مفتوح للجميع =================== */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* =================== Body Parser =================== */
app.use(express.json({ limit: "20mb" }));

/* =================== PostgreSQL =================== */
const { Pool } = pg;

// ⬅️ نفرض SSL على اتصال Render بإضافة sslmode=require إلى DATABASE_URL
function withSSL(url) {
  if (!url) {
    console.error("❌ Missing DATABASE_URL");
    process.exit(1);
  }
  return url.includes("?") ? `${url}&sslmode=require` : `${url}?sslmode=require`;
}

const pool = new Pool({
  connectionString: withSSL(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
});

/* =================== تهيئة/ترقية السكيمة =================== */
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id          BIGSERIAL PRIMARY KEY,
      reporter    TEXT,
      type        TEXT NOT NULL,
      payload     JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // (جدول images سيبقى اختياري/قديم — لم نعد نستخدمه بعد التحويل إلى Cloudinary)
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS images (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INT NOT NULL,
      width INT,
      height INT,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);`);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname='public' AND indexname='ux_reports_type_reportdate'
      ) THEN
        EXECUTE 'CREATE UNIQUE INDEX ux_reports_type_reportdate
                 ON reports (type, ((payload->>''reportDate'')))';
      END IF;
    END $$;
  `);
}

/* =================== Utils =================== */
function isPlainObject(x) { return x && typeof x === "object" && !Array.isArray(x); }
function parseMaybeJSON(x) {
  if (isPlainObject(x)) return x;
  if (typeof x === "string") { try { return JSON.parse(x); } catch { return x; } }
  return x;
}

/* =================== API: التقارير العام =================== */
app.get("/api/reports", async (req, res) => {
  try {
    const { type } = req.query;
    const q = type
      ? `SELECT * FROM reports WHERE type=$1 ORDER BY created_at DESC LIMIT 200`
      : `SELECT * FROM reports ORDER BY created_at DESC LIMIT 200`;
    const { rows } = await pool.query(q, type ? [type] : []);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db select failed" });
  }
});

app.post("/api/reports", async (req, res) => {
  try {
    let { reporter, type, payload } = req.body || {};
    payload = parseMaybeJSON(payload);
    if (!type || !isPlainObject(payload)) {
      return res.status(400).json({ ok: false, error: "type & payload are required" });
    }
    const { rows } = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [reporter || "anonymous", type, payload]
    );
    res.status(201).json({ ok: true, report: rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports", async (req, res) => {
  try {
    const { reporter, type } = req.body || {};
    let payload = parseMaybeJSON(req.body?.payload);
    const reportDate = payload?.reportDate || req.query?.reportDate || "";
    if (!type || !isPlainObject(payload) || !reportDate) {
      return res.status(400).json({ ok: false, error: "type + payload.reportDate required" });
    }
    const upd = await pool.query(
      `UPDATE reports
         SET reporter = COALESCE($1, reporter),
             payload  = $2::jsonb,
             updated_at = now()
       WHERE type = $3 AND payload->>'reportDate' = $4
       RETURNING *`,
      [reporter || "anonymous", payload, type, reportDate]
    );
    if (upd.rowCount > 0) return res.json({ ok: true, report: upd.rows[0], method: "update" });
    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [reporter || "anonymous", type, payload]
    );
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports ERROR =", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/returns", async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { items = [], _clientSavedAt } = req.body || {};
    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });
    const payload = { reportDate, items: Array.isArray(items) ? items : [], _clientSavedAt: _clientSavedAt || Date.now() };
    const upd = await pool.query(
      `UPDATE reports
         SET reporter = COALESCE(reporter, 'anonymous'),
             payload  = $1::jsonb,
             updated_at = now()
       WHERE type = 'returns'
         AND payload->>'reportDate' = $2
       RETURNING *`,
      [payload, reportDate]
    );
    if (upd.rowCount > 0) return res.json({ ok: true, report: upd.rows[0], method: "update" });
    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, 'returns', $2::jsonb)
       RETURNING *`,
      ["anonymous", payload]
    );
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/returns ERROR =", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/qcs", async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { details = {}, _clientSavedAt } = req.body || {};
    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });
    const payload = { reportDate, details: isPlainObject(details) ? details : {}, _clientSavedAt: _clientSavedAt || Date.now() };
    const upd = await pool.query(
      `UPDATE reports
         SET reporter = COALESCE(reporter, 'anonymous'),
             payload  = $1::jsonb,
             updated_at = now()
       WHERE type = 'qcs'
         AND payload->>'reportDate' = $2
       RETURNING *`,
      [payload, reportDate]
    );
    if (upd.rowCount > 0) return res.json({ ok: true, report: upd.rows[0], method: "update" });
    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, 'qcs', $2::jsonb)
       RETURNING *`,
      ["anonymous", payload]
    );
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/qcs ERROR =", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/api/reports", async (req, res) => {
  try {
    const { type, reportDate } = req.query;
    if (!type || !reportDate) return res.status(400).json({ ok: false, error: "type & reportDate required" });
    const { rowCount } = await pool.query(
      `DELETE FROM reports
       WHERE type = $1
         AND payload->>'reportDate' = $2`,
      [type, reportDate]
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

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

/* =================== Health =================== */
app.get("/health/db", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* =================== Images API → Cloudinary =================== */
// نسمح بأي اسم حقل: file / image / images[] (بنأخذ أول ملف)
const uploadAny = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

function uploadBufferToCloudinary(buffer, opts = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder: "qcs", resource_type: "auto", ...opts },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

const MAX_DIM = 1280;
const JPEG_QUALITY = 80;

app.post("/api/images", uploadAny.any(), async (req, res) => {
  try {
    const f = (req.files && req.files[0]) || req.file;
    if (!f) return res.status(400).json({ ok: false, error: "no file" });

    const isImage = (f.mimetype || "").startsWith("image/");

    let bufferToUpload = f.buffer;
    if (isImage) {
      // ضغط/تصغير للصور فقط
      let p = sharp(f.buffer, { failOnError: false });
      const meta = await p.metadata();
      if ((meta.width || 0) > MAX_DIM || (meta.height || 0) > MAX_DIM) {
        p = p.resize({ width: MAX_DIM, height: MAX_DIM, fit: "inside", withoutEnlargement: true });
      }
      bufferToUpload = await p.jpeg({ quality: JPEG_QUALITY }).toBuffer();
    }

    const up = await uploadBufferToCloudinary(bufferToUpload, {
      public_id: undefined, // دع Cloudinary يحدد الاسم
      folder: "qcs",
      resource_type: "auto", // يقبل صور/PDF/ملفات
    });

    return res.json({
      ok: true,
      url: up.secure_url,
      public_id: up.public_id,
      width: up.width || null,
      height: up.height || null,
      bytes: up.bytes || null,
      format: up.format || null,
      resource_type: up.resource_type || null,
    });
  } catch (e) {
    console.error("Cloudinary upload failed:", e);
    res.status(500).json({ ok: false, error: "cloudinary upload failed" });
  }
});

// (Route قديم لعرض الصور من DB — يُترك كما هو للتوافق مع القديم)
app.get("/api/images/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT filename,mimetype,data FROM images WHERE id=$1", [req.params.id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: "not found" });
    res.setHeader("Content-Type", row.mimetype || "image/jpeg");
    res.setHeader("Content-Disposition", `inline; filename="${row.filename || "image.jpg"}"`);
    res.send(row.data);
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
