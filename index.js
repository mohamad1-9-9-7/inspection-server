import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config(); // قراءة ملف .env

const app = express();
const PORT = process.env.PORT || 5000;

// إعداد الاتصال بقاعدة البيانات
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // ضروري لـ Neon
});

app.use(cors());
app.use(express.json());

// 🔍 مسار فحص الاتصال بقاعدة البيانات
app.get("/health/db", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// مسار تجريبي للتأكد أن السيرفر شغال
app.get("/", (req, res) => {
  res.send("🚀 API is running");
});

// مثال: جلب جميع التقارير
app.get("/api/reports", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM reports ORDER BY created_at DESC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

// مثال: إضافة تقرير جديد
app.post("/api/reports", async (req, res) => {
  try {
    const { reporter, type, payload } = req.body;
    const result = await pool.query(
      "INSERT INTO reports (reporter, type, payload) VALUES ($1, $2, $3) RETURNING *",
      [reporter, type, payload]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
