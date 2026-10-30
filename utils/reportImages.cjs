// utils/reportImages.cjs
// When a report is deleted, its photos go from Cloudinary too.
//
// A report payload only holds the URLs (see the frontend's utils/imageUpload.js),
// so deleting the row used to leave every photo it carried on Cloudinary for
// good. The owner asked for them to go at once with the report.
//
// A file is destroyed only when NOTHING else still points at it: another report
// (a copied form, a catalogue photo picked into a sheet), the product catalogue,
// a company logo, the billing signature / stamp, a payment proof… Those tables
// are searched for the file's public_id before it is removed. The audit trail
// (report_audit) is deliberately NOT a reason to keep a file — a report
// restored from it afterwards comes back without its photos; the owner chose that.
//
// Runs after the delete has answered: Cloudinary being slow or down never fails
// or delays a delete, it is only logged.

const cloudinary = require("cloudinary").v2;

// Tables (besides `reports`) whose rows may hold a hosted file URL.
const OTHER_TABLES = [
  "images", "product_catalog", "companies", "billing_profile", "payment_proofs",
  "platform_settings", "supplier_links", "training_links",
];

const MAX_FILES_PER_DELETE = 300;

/** Cloudinary URL → { resource_type, delivery_type, public_id } (same rules as routes/media.cjs). */
function parseCloudinaryUrl(u) {
  try {
    const { hostname, pathname } = new URL(u);
    if (!/(^|\.)cloudinary\.com$/i.test(hostname)) return null;
    const parts = pathname.split("/").filter(Boolean);
    const rIdx = parts.findIndex((p) => p === "image" || p === "video" || p === "raw");
    if (rIdx < 0 || !parts[rIdx + 1]) return null;
    const resource_type = parts[rIdx];
    const delivery_type = parts[rIdx + 1];

    let vIdx = rIdx + 2;
    while (vIdx < parts.length && !/^v\d+$/.test(parts[vIdx])) vIdx++;
    if (vIdx >= parts.length - 1) return null;

    const rest = decodeURIComponent(parts.slice(vIdx + 1).join("/"));
    const dot = rest.lastIndexOf(".");
    // raw files keep their extension inside the public_id
    const public_id = resource_type === "raw" || dot <= 0 ? rest : rest.slice(0, dot);
    return public_id ? { resource_type, delivery_type, public_id } : null;
  } catch {
    return null;
  }
}

/** Every Cloudinary file of OUR account referenced anywhere inside a payload. */
function collectCloudinaryFiles(value, out = new Map()) {
  const ownCloud = String(cloudinary.config().cloud_name || "");
  const visit = (v) => {
    if (out.size >= MAX_FILES_PER_DELETE) return;
    if (typeof v === "string") {
      // a string may carry more than one URL (notes, joined lists)
      // commas are legal inside (transformations: c_limit,w_1280); only
      // punctuation at the very end belongs to the surrounding sentence
      const urls = (v.match(/https?:\/\/res\.cloudinary\.com\/[^\s"'<>)]+/gi) || []).map((u) => u.replace(/[.,;:!?]+$/, ""));
      urls.forEach((u) => {
        const cloud = u.split("/")[3] || "";
        if (ownCloud && cloud !== ownCloud) return; // never touch another account's files
        const info = parseCloudinaryUrl(u);
        if (info) out.set(`${info.resource_type}|${info.delivery_type}|${info.public_id}`, info);
      });
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(visit);
    }
  };
  visit(value);
  return out;
}

const likeArg = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** True when any remaining row still references this public_id. */
async function stillUsed(pool, publicId) {
  // other rows hold the URL, where a name with spaces etc. is percent-encoded
  const enc = encodeURI(publicId);
  const a = likeArg(publicId), b = likeArg(enc);
  const r = await pool.query(`SELECT 1 FROM reports WHERE payload::text LIKE $1 OR payload::text LIKE $2 LIMIT 1`, [a, b]);
  if (r.rowCount) return true;
  for (const table of OTHER_TABLES) {
    try {
      const q = await pool.query(
        `SELECT 1 FROM ${table} t WHERE row_to_json(t)::text LIKE $1 OR row_to_json(t)::text LIKE $2 LIMIT 1`,
        [a, b]
      );
      if (q.rowCount) return true;
    } catch (e) {
      // a table this database does not have — nothing in it can hold the file
      if (e?.code !== "42P01") throw e;
    }
  }
  return false;
}

/**
 * Destroys the Cloudinary files of deleted report payloads that nothing else
 * uses any more. Call it AFTER the rows are deleted (so they no longer count
 * as users) and do not await it on the request path.
 */
async function purgeDeletedReportImages(pool, payloads, label = "") {
  const cfg = cloudinary.config();
  if (!cfg.cloud_name || !cfg.api_key || !cfg.api_secret) return { destroyed: 0, kept: 0, failed: 0 };

  const files = new Map();
  (payloads || []).forEach((p) => collectCloudinaryFiles(p, files));
  let destroyed = 0, kept = 0, failed = 0;

  for (const info of files.values()) {
    try {
      if (await stillUsed(pool, info.public_id)) { kept++; continue; }
      const out = await cloudinary.uploader.destroy(info.public_id, {
        resource_type: info.resource_type,
        type: info.delivery_type,
        invalidate: true,
      });
      if (out?.result === "ok" || out?.result === "not found") destroyed++;
      else { failed++; console.warn("[reportImages] destroy answered", info.public_id, out?.result); }
    } catch (e) {
      failed++;
      console.warn("[reportImages] destroy failed", info.public_id, e?.message || e);
    }
  }
  if (files.size) {
    console.log(`[reportImages] ${label} files=${files.size} destroyed=${destroyed} kept=${kept} failed=${failed}`);
  }
  return { destroyed, kept, failed };
}

module.exports = { purgeDeletedReportImages, collectCloudinaryFiles, parseCloudinaryUrl };
