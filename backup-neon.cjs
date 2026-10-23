// backup-neon.cjs — full Neon backup to a local .sql.gz file (read-only).
//   node backup-neon.cjs [outDir]      (default D:\neon-backups)
// Restore into an EMPTY database:  gunzip, then  psql "<db url>" -f <file>.sql
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Pool } = require("pg");
const { dumpDatabase } = require("./utils/dbDump.cjs");

(async () => {
  const outDir = process.argv[2] || "D:\\neon-backups";
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const file = path.join(outDir, `neon-full-${stamp}.sql.gz`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
  const gz = zlib.createGzip({ level: 9 });
  const done = new Promise((ok, bad) => gz.pipe(fs.createWriteStream(file)).on("finish", ok).on("error", bad));
  const write = (s) => (gz.write(s) ? null : new Promise((r) => gz.once("drain", r)));

  const summary = await dumpDatabase(pool, write);
  gz.end();
  await done;
  await pool.end();

  for (const t of summary.tables) console.log(`${t.table.padEnd(24)} ${t.rows}`);
  console.log(`\n${summary.tables.length} tables, ${summary.totalRows} rows`);
  console.log(`${file}  (${(fs.statSync(file).size / 1048576).toFixed(2)} MB)`);
})().catch((e) => { console.error("BACKUP FAILED:", e.message); process.exit(1); });
