// seed-reports.mjs
import 'dotenv/config'; // لقراءة متغيرات البيئة من ملف .env
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

try {
  const result = await pool.query(
    `INSERT INTO reports (reporter, type, payload) 
     VALUES ($1, $2, $3) RETURNING *`,
    ['Test User', 'test', { message: 'Hello from seed script' }]
  );

  console.log('✅ Data inserted:', result.rows[0]);
} catch (err) {
  console.error('❌ Error inserting data:', err);
} finally {
  await pool.end();
}
