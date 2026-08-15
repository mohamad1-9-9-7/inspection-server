/* migrate-base64.mjs
   ------------------------------------------------------------------
   One-off maintenance job: moves every file embedded in a report
   payload as a `data:…;base64,…` string up to Cloudinary and leaves the
   URL in its place.

   Why it exists: measured Aug 2026, 977 files totalling 125.61 MB were
   stored inside 444 report rows — 72% of the whole reports table. Those
   bytes were re-sent on every list read of their type, and base64 of a
   JPEG barely compresses (1.54x at the edge, against 22x for ordinary
   report JSON), so they dominated the Render bandwidth bill.

   Safety properties:
     • A row is all-or-nothing. If any upload for a row fails, the row is
       left exactly as it was — never half-migrated.
     • Only strings that are actually base64 data URIs are touched.
       Everything else in the payload is copied through untouched, so
       refNo and every other field survive.
     • Resumable: it selects rows that still contain base64, so an
       interrupted run is continued simply by running it again.

   Usage (from D:\inspection-server):
     node migrate-base64.mjs --dry-run       # report only, change nothing
     node migrate-base64.mjs                 # migrate everything
     node migrate-base64.mjs --type=returns  # one report type
=================================================================== */
import "dotenv/config";
import pg from "pg";
import { v2 as cloudinary } from "cloudinary";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const TYPE = (argv.find((a) => a.startsWith("--type=")) || "").split("=")[1] || "";

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

const cfg = cloudinary.config();
const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);
if (missing.length) {
  console.error("❌ Cloudinary config missing:", missing.join(", "));
  process.exit(1);
}

const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,/i;
const isBlob = (v) => typeof v === "string" && v.length >= 2048 && DATA_URI.test(v);
const fmt = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} KB`);

async function transform(value, swap, depth = 0) {
  if (depth > 12) return value;
  if (isBlob(value)) return swap(value);
  if (Array.isArray(value)) {
    const out = [];
    for (const v of value) out.push(await transform(v, swap, depth + 1));
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = await transform(v, swap, depth + 1);
    return out;
  }
  return value;
}

const where = TYPE
  ? `type = $1 AND payload::text LIKE '%;base64,%'`
  : `payload::text LIKE '%;base64,%'`;
const params = TYPE ? [TYPE] : [];

const { rows } = await pool.query(
  `SELECT id, type, payload FROM reports WHERE ${where} ORDER BY id ASC`,
  params
);

console.log(`${DRY ? "DRY RUN — " : ""}rows to process: ${rows.length}${TYPE ? ` (type=${TYPE})` : ""}\n`);

let done = 0, blobs = 0, bytes = 0, failedRows = 0, skipped = 0;
const failures = [];
const startedAt = Date.now();

for (const row of rows) {
  let count = 0, size = 0, failed = null;

  const cleaned = await transform(row.payload, async (blob) => {
    if (failed) return blob;
    count++;
    size += blob.length;
    if (DRY) return blob;
    try {
      const up = await cloudinary.uploader.upload(blob, {
        folder: `${process.env.CLOUDINARY_FOLDER || "qcs"}/migrated/${row.type}`,
        transformation: [{ width: 1280, height: 1280, crop: "limit", quality: "80" }],
      });
      return up.secure_url;
    } catch (e) {
      failed = e?.message || String(e);
      return blob;
    }
  });

  if (failed) {
    failedRows++;
    failures.push({ id: row.id, type: row.type, error: failed });
    console.log(`  ✖ id=${row.id} ${row.type} — ${failed}`);
    continue;
  }

  if (!count) { skipped++; continue; }

  if (!DRY) {
    await pool.query(
      `UPDATE reports SET payload = $1::jsonb, updated_at = now() WHERE id = $2`,
      [JSON.stringify(cleaned), row.id]
    );
  }

  done++;
  blobs += count;
  bytes += size;

  if (done % 10 === 0 || done === rows.length) {
    const secs = Math.round((Date.now() - startedAt) / 1000);
    console.log(`  ${done}/${rows.length} rows · ${blobs} files · ${fmt(bytes)} freed · ${secs}s`);
  }
}

console.log(`\n${DRY ? "would migrate" : "migrated"}: ${done} rows, ${blobs} files, ${fmt(bytes)}`);
if (skipped) console.log(`skipped (no real blob): ${skipped}`);
if (failedRows) {
  console.log(`FAILED rows (left untouched): ${failedRows}`);
  for (const f of failures.slice(0, 20)) console.log(`   id=${f.id} ${f.type} — ${f.error}`);
}

await pool.end();
