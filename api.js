// index.js
import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000; // 🟢 الافتراضي 5000 للسيرفر

// اتصال PostgreSQL
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // مطلوب مع Neon
});

app.use(express.json());

// تفعيل CORS (Netlify + Localhost)
app.use(
  cors({
    origin: [
      "https://cheerful-melba-898d30.netlify.app", // 🟢 موقعك على Netlify
      /^http:\/\/localhost:\d+$/, // 🟢 أي localhost
    ],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Idempotency-Key"],
  })
);
app.options("*", cors());

/* ======================== DB Schema ======================== */
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      reporter TEXT,
      type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(type);
    CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);
    CREATE INDEX IF NOT EXISTS idx_reports_type_reportdate
      ON reports (type, ((payload->>'reportDate')));
  `);
  console.log("✅ DB schema ready");
}

/* ======================== Health ======================== */
app.get("/health/db", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/", (_req, res) => res.send("🚀 API is running"));

/* ======================== Reports API ======================== */
// إضافة تقرير جديد
app.post("/api/reports", async (req, res) => {
  try {
    const { reporter, type, payload } = req.body || {};

    if (!type || !payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "invalid payload" });
    }

    const q = `
      INSERT INTO reports (reporter, type, payload)
      VALUES ($1, $2, $3)
      RETURNING *`;
    const r = await pool.query(q, [reporter || "anonymous", type, payload]);

    res.status(201).json({ ok: true, report: r.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db insert failed" });
  }
});

// قراءة التقارير (مع ?type=returns يفلتر النوع)
app.get("/api/reports", async (req, res) => {
  try {
    const { type } = req.query;
    const q = type
      ? "SELECT * FROM reports WHERE type=$1 ORDER BY created_at DESC LIMIT 50"
      : "SELECT * FROM reports ORDER BY created_at DESC LIMIT 50";
    const r = await pool.query(q, type ? [type] : []);
    res.json({ ok: true, data: r.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db select failed" });
  }
});

// حذف تقارير حسب النوع والتاريخ
app.delete("/api/reports", async (req, res) => {
  try {
    const { type, reportDate } = req.query;
    if (!type || !reportDate) {
      return res.status(400).json({ ok: false, error: "bad request" });
    }

    const delQuery = `
      DELETE FROM reports
      WHERE type = $1
        AND payload->>'reportDate' = $2
    `;
    const r = await pool.query(delQuery, [type, reportDate]);

    return res.json({ ok: true, deleted: r.rowCount });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "db delete failed" });
  }
});

/* ======================== Boot ======================== */
ensureSchema()
  .then(() => {
    app.listen(PORT, () =>
      console.log(`✅ Server running on port ${PORT}`)
    );
  })
  .catch((err) => {
    console.error("❌ DB init failed:", err);
    process.exit(1);
  });
