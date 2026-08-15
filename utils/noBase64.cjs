/* utils/noBase64.cjs
   ------------------------------------------------------------------
   Hard stop on base64 files being stored inside report payloads.

   Why this exists: a `data:image/jpeg;base64,…` string inside `payload`
   is carried by every single list read of that report type, forever.
   Measured on production (Aug 2026): one row of
   `ftr2_receiving_log_butchery` was 101,947 bytes of which 99.5% was one
   embedded photo, and opening that page once shipped 27.6 MB. Worse,
   base64-of-JPEG barely compresses — the edge got it down 1.54x, while
   ordinary report JSON compresses 22x — so these rows dominated the
   bandwidth bill out of all proportion to their number.

   Images belong on Cloudinary. `POST /api/images` returns a URL; the
   payload stores that URL (~90 bytes) instead of ~90 KB.

   This middleware is the choke point: it does not matter which screen
   forgets the rule, or which one gets written next year — a data: URI
   never reaches the reports table.

   Break-glass: ALLOW_BASE64_PAYLOAD=on disables the check. Meant for a
   single emergency deploy, not for normal operation.
=================================================================== */

// A data: URI big enough to matter. Small inline SVG icons and 1x1
// tracking pixels are not what blew up the bill, and rejecting them
// would break unrelated screens for no gain.
const MIN_BYTES = 2048;

const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,/i;

function isBase64Asset(s) {
  return typeof s === "string" && s.length >= MIN_BYTES && DATA_URI.test(s);
}

/* Depth-first walk that stops at the first offender — the caller only
   needs one example to produce an actionable error, and payloads that
   trip this are by definition large. */
function findBase64(value, path = "payload", depth = 0) {
  if (depth > 12) return null;

  if (isBase64Asset(value)) {
    const mime = (value.match(DATA_URI) || [])[1] || "unknown";
    return { path, bytes: value.length, mime };
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findBase64(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      const hit = findBase64(v, `${path}.${k}`, depth + 1);
      if (hit) return hit;
    }
  }

  return null;
}

const ENABLED = String(process.env.ALLOW_BASE64_PAYLOAD || "").toLowerCase() !== "on";

if (!ENABLED) {
  console.warn(
    "[no-base64] ALLOW_BASE64_PAYLOAD=on — base64 files may be written into " +
      "report payloads again. Unset it as soon as the emergency is over."
  );
}

/* Express middleware. Mount on the report write verbs only: e-mail
   routes legitimately carry base64 attachments in transit, and
   POST /api/images is multipart, not JSON. */
function rejectBase64(req, res, next) {
  if (!ENABLED) return next();
  if (!req.body || typeof req.body !== "object") return next();

  // Every write shape in use: {payload}, a bare payload (PUT /:type),
  // and {items} (PUT /api/reports/returns).
  const hit =
    findBase64(req.body.payload, "payload") ||
    findBase64(req.body.items, "items") ||
    findBase64(req.body.entries, "entries");

  if (!hit) return next();

  console.warn(
    `[no-base64] rejected ${req.method} ${req.originalUrl} — ` +
      `${hit.path} carried ${hit.bytes} bytes of ${hit.mime}`
  );

  return res.status(400).json({
    ok: false,
    error: "BASE64_NOT_ALLOWED",
    field: hit.path,
    bytes: hit.bytes,
    message:
      "Files may not be stored inside a report payload. Upload the file to " +
      "POST /api/images first and store the returned URL instead.",
  });
}

module.exports = { rejectBase64, findBase64, isBase64Asset };
