// Wipe the trial cold-room / cooler products (Al Mawashi = company 1).
//   node wipe-cold-rooms-stock.mjs          → dry run: shows what is there, changes nothing
//   node wipe-cold-rooms-stock.mjs --apply  → backs everything up to a JSON file, then wipes
// Wipes: cold_rooms_stock (rooms → {}, the record itself is kept) + every cold_rooms_moves record.
import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();

const APPLY = process.argv.includes("--apply");
const COMPANY = 1;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const db = await pool.connect();
try {
  const { rows } = await db.query(
    `SELECT id, type, payload FROM reports
      WHERE COALESCE(company_id, 1) = $1 AND type IN ('cold_rooms_stock', 'cold_rooms_moves')
      ORDER BY type, id`,
    [COMPANY]
  );
  for (const r of rows) {
    if (r.type === "cold_rooms_stock") {
      const rooms = r.payload?.rooms || {};
      console.log(`stock #${r.id}: ${Object.keys(rooms).length} rooms/units`);
      for (const [k, v] of Object.entries(rooms)) {
        console.log(`   ${k.padEnd(40)} items=${(v?.items || []).length}  moves=${(v?.moves || []).length}`);
      }
    } else {
      console.log(`moves #${r.id} (${r.payload?.reportDate}): ${(r.payload?.moves || []).length} moves`);
    }
  }
  if (!rows.length) { console.log("Nothing to wipe."); process.exit(0); }
  if (!APPLY) { console.log("\nDry run — nothing changed. Add --apply to wipe."); process.exit(0); }

  const file = `backup-cold-rooms-stock-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  console.log(`\nBackup written: ${file}`);

  await db.query("BEGIN");
  for (const r of rows) {
    if (r.type === "cold_rooms_stock") {
      const p = { ...r.payload, rooms: {} };
      await db.query(`UPDATE reports SET payload = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(p), r.id]);
    } else {
      await db.query(`DELETE FROM reports WHERE id = $1`, [r.id]);
    }
  }
  await db.query("COMMIT");
  console.log("✅ Done — all cold rooms and coolers are empty.");
} catch (e) {
  await db.query("ROLLBACK").catch(() => {});
  console.error("❌ Failed, nothing changed:", e.message);
} finally {
  db.release();
  await pool.end();
}
