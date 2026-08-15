/* drop-type-images.mjs
   ------------------------------------------------------------------
   Removes every photo from one report type — both the files still
   embedded as base64 and the ones this migration already pushed to
   Cloudinary (those get deleted from Cloudinary too, so they don't sit
   there orphaned once nothing points at them).

   Only URLs under the migration's own folder are touched, so a photo
   uploaded through the normal app flow is never collateral damage.

   Usage (from D:\inspection-server):
     node drop-type-images.mjs --type=ftr1_receiving_log_butchery --dry-run
     node drop-type-images.mjs --type=ftr1_receiving_log_butchery
=================================================================== */
import "dotenv/config";
import pg from "pg";
import { v2 as cloudinary } from "cloudinary";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const TYPE = (argv.find((a) => a.startsWith("--type=")) || "").split("=")[1] || "";

if (!TYPE) {
  console.error("--type=<report_type> is required");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
} else {
  cloudinary.config({ secure: true });
}

const FOLDER = `${process.env.CLOUDINARY_FOLDER || "qcs"}/migrated/${TYPE}`;
const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,/i;
const isBlob = (v) => typeof v === "string" && v.length >= 2048 && DATA_URI.test(v);
const isMine = (v) => typeof v === "string" && v.includes("res.cloudinary.com") && v.includes(`/${FOLDER}/`);
const fmt = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} KB`);

/* https://res.cloudinary.com/<cloud>/image/upload/v1234/<folder>/<name>.jpg
   → <folder>/<name>   (the id Cloudinary's destroy() expects) */
function publicIdOf(url) {
  const m = String(url).match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z0-9]+)?$/i);
  return m ? m[1] : null;
}

function clear(value, acc, depth = 0) {
  if (depth > 12) return value;
  if (isBlob(value)) { acc.blobs++; acc.bytes += value.length; return ""; }
  if (isMine(value)) { acc.urls.push(value); return ""; }
  if (Array.isArray(value)) return value.map((v) => clear(v, acc, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clear(v, acc, depth + 1);
    return out;
  }
  return value;
}

const { rows } = await pool.query(
  `SELECT id, payload FROM reports WHERE type = $1 ORDER BY id ASC`,
  [TYPE]
);

console.log(`${DRY ? "DRY RUN — " : ""}type=${TYPE}, rows in table: ${rows.length}`);
console.log(`cloudinary folder targeted: ${FOLDER}\n`);

let changedRows = 0, blobs = 0, bytes = 0;
const urls = [];

for (const row of rows) {
  const acc = { blobs: 0, bytes: 0, urls: [] };
  const cleaned = clear(row.payload, acc);
  if (!acc.blobs && !acc.urls.length) continue;

  changedRows++;
  blobs += acc.blobs;
  bytes += acc.bytes;
  urls.push(...acc.urls);

  if (!DRY) {
    await pool.query(
      `UPDATE reports SET payload = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(cleaned), row.id]
    );
  }
}

console.log(`rows ${DRY ? "that would change" : "changed"} : ${changedRows}`);
console.log(`embedded files removed  : ${blobs} (${fmt(bytes)})`);
console.log(`cloudinary links cleared: ${urls.length}`);

if (urls.length && !DRY) {
  console.log("\ndeleting those assets from Cloudinary…");
  let gone = 0, failed = 0;
  for (const u of urls) {
    const pid = publicIdOf(u);
    if (!pid) { failed++; continue; }
    try {
      const r = await cloudinary.uploader.destroy(pid, { resource_type: "image", invalidate: true });
      if (r.result === "ok" || r.result === "not found") gone++;
      else failed++;
    } catch {
      failed++;
    }
  }
  console.log(`cloudinary deleted: ${gone}, failed: ${failed}`);
}

await pool.end();
