import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  const r = await pool.query("SELECT NOW() AS now");
  console.log("✅ Connected. DB time:", r.rows[0].now);
} catch (e) {
  console.error("❌ DB connection failed:\n", e); // نطبع الخطأ كامل
} finally {
  await pool.end();
}
