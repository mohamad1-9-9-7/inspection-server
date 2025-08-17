// تحميل متغيرات البيئة من .env
import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

// عرض الـ DATABASE_URL للتأكد أنها مقروءة
console.log("📌 DATABASE_URL =", process.env.DATABASE_URL);

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL غير موجود. تأكد من ملف .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // ضروري مع Neon
});

try {
  // اختبار الاتصال
  const res = await pool.query('SELECT NOW() AS now');
  console.log(`✅ متصل بقاعدة البيانات. الوقت: ${res.rows[0].now}`);

  // إنشاء الجدول إذا لم يكن موجود
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      reporter TEXT NOT NULL,
      type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✅ جدول "reports" تم إنشاؤه أو موجود مسبقاً');
} catch (err) {
  console.error("❌ خطأ في الاتصال أو إنشاء الجدول:", err.message);
} finally {
  await pool.end();
}
