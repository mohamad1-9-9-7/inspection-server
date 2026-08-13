const multer = require("multer");
const cloudinary = require("cloudinary").v2;

module.exports = function registerMediaRoutes(app, deps = {}) {
  const { pool, makeLimiter, requireAuthStrict } = deps;

  const noLimit = (_req, _res, next) => next();
  const mk = typeof makeLimiter === "function" ? makeLimiter : () => noLimit;
  const strict = typeof requireAuthStrict === "function" ? requireAuthStrict : noLimit;

  /* Uploads stay open — branch supervisors and trainees attach evidence
     photos from public token pages with no login. A cap keeps that from
     being turned into free Cloudinary storage: 30 files/minute is far
     above any real form and far below a script. */
  const uploadLimiter = mk({ max: 30, windowMs: 60_000, name: "upload" });

/* --------- Cloudinary config (robust) --------- */
(function configureCloudinary() {
  const hasSplit = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;

  if (hasSplit) {
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
  } else {
    console.log("🔐 Cloudinary ready → cloud_name:", cfg.cloud_name);
  }
})();

/* ============================================================
   Files helpers (Cloudinary redirect + Proxy)
============================================================ */

/** GET cloudinary url by publicId (works when you stored only public_id / filename) */
app.get("/api/files/cloudinary/:publicId", async (req, res) => {
  try {
    const cfg = cloudinary.config();
    const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);
    if (missing.length) return res.status(500).json({ ok: false, error: "CLOUDINARY_CONFIG_MISSING", missing });

    let publicId = String(req.params.publicId || "").trim();
    if (!publicId) return res.status(400).json({ ok: false, error: "publicId required" });

    // if user stored "xxxx.pdf" remove extension for api.resource
    publicId = publicId.replace(/\.(pdf|png|jpg|jpeg|webp|gif)$/i, "");

    // try raw first (PDF usually raw), then image
    let r = null;
    try {
      r = await cloudinary.api.resource(publicId, { resource_type: "raw" });
    } catch (e1) {
      r = await cloudinary.api.resource(publicId, { resource_type: "image" });
    }

    const url = r?.secure_url || r?.url;
    if (!url) return res.status(404).json({ ok: false, error: "NO_URL_FOUND" });

    // redirect so iframe can load it
    return res.redirect(302, url);
  } catch (e) {
    console.error("GET /api/files/cloudinary/:publicId ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* REMOVED: GET /api/files/proxy
   It fetched ANY url= the caller passed and streamed the body back, with no
   auth, no host allow-list and no size cap — an open relay (every proxied
   byte billed twice: inbound as Service-Initiated, outbound as an HTTP
   response) and an SSRF hole into anything the server can reach.
   Nothing in the app ever called it. Assets are served straight from
   Cloudinary's own CDN, which is what /api/files/cloudinary/:publicId
   redirects to. Do not reintroduce this without an explicit allow-list. */

/* --------- Health routes --------- */
/* Lightweight liveness check for uptime monitors — does NOT touch the DB,
   so it never wakes Neon out of autosuspend. Point UptimeRobot here. */
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.get("/health/db", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/health/cloud", (_req, res) => {
  const cfg = cloudinary.config();
  const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);
  if (missing.length) return res.status(500).json({ ok: false, error: "CLOUDINARY_CONFIG_MISSING", missing });
  return res.json({ ok: true, cloud_name: cfg.cloud_name });
});

/* --------- Images API (no sharp) --------- */
const uploadAny = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function uploadBufferToCloudinary(buffer, opts = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: process.env.CLOUDINARY_FOLDER || "qcs",
        resource_type: "auto",
        transformation: [{ width: 1280, height: 1280, crop: "limit", quality: "80" }],
        ...opts,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

app.post("/api/images", uploadLimiter, uploadAny.any(), async (req, res) => {
  try {
    const cfg = cloudinary.config();
    const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);
    if (missing.length) {
      return res.status(500).json({ ok: false, error: "CLOUDINARY_CONFIG_MISSING", missing });
    }

    const f = (req.files && req.files[0]) || req.file;
    const dataUrl = req.body?.data;

    let up;
    if (f?.buffer) {
      up = await uploadBufferToCloudinary(f.buffer, { resource_type: "auto" });
    } else if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      up = await cloudinary.uploader.upload(dataUrl, {
        folder: process.env.CLOUDINARY_FOLDER || "qcs",
        transformation: [{ width: 1280, height: 1280, crop: "limit", quality: "80" }],
      });
    } else {
      return res.status(400).json({ ok: false, error: "no file/data" });
    }

    res.json({
      ok: true,
      url: up.secure_url,
      optimized_url: up.secure_url,
      public_id: up.public_id,
      width: up.width || null,
      height: up.height || null,
      bytes: up.bytes || null,
      format: up.format || null,
      resource_type: up.resource_type || null,
    });
  } catch (e) {
    const errPayload = {
      ok: false,
      error: "cloudinary upload failed",
      reason: e?.message || String(e),
      http_code: e?.http_code || null,
      name: e?.name || null,
    };
    console.error("Cloudinary upload failed:", errPayload);
    res.status(500).json(errPayload);
  }
});

function parseCloudinaryUrl(u) {
  try {
    const { pathname } = new URL(u);
    const parts = pathname.split("/").filter(Boolean);
    const rIdx = parts.findIndex((p) => p === "image" || p === "video" || p === "raw");
    if (rIdx < 0 || !parts[rIdx + 1]) return null;
    const resource_type = parts[rIdx];
    const delivery_type = parts[rIdx + 1];

    let vIdx = rIdx + 2;
    while (vIdx < parts.length && !/^v\d+$/.test(parts[vIdx])) vIdx++;
    if (vIdx >= parts.length - 1) return null;

    const rest = parts.slice(vIdx + 1).join("/");
    const dot = rest.lastIndexOf(".");
    const public_id = dot > 0 ? rest.slice(0, dot) : rest;

    return { resource_type, delivery_type, public_id };
  } catch {
    return null;
  }
}

async function destroyOne({ public_id, resource_type = "image", delivery_type = "upload" }) {
  const out = await cloudinary.uploader.destroy(public_id, {
    resource_type,
    type: delivery_type,
    invalidate: true,
  });
  const ok = out?.result === "ok" || out?.result === "not found" || out?.result === "queued";
  if (!ok) {
    const err = new Error("CLOUDINARY_DESTROY_FAILED");
    err.details = out;
    throw err;
  }
  return out;
}

async function destroyOneByUrl(url) {
  const info = parseCloudinaryUrl(url);
  if (!info) throw new Error("BAD_CLOUDINARY_URL");
  return destroyOne({
    public_id: info.public_id,
    resource_type: info.resource_type,
    delivery_type: info.delivery_type,
  });
}

/* Destructive and reached only from the logged-in admin view
   (QCSRawMaterialView/viewUtils.js) — never from a public token page. */
app.delete("/api/images", strict, async (req, res) => {
  try {
    const cfg = cloudinary.config();
    const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);
    if (missing.length) return res.status(500).json({ ok: false, error: "CLOUDINARY_CONFIG_MISSING", missing });

    const qUrl = req.query?.url;
    const qPublicId = req.query?.publicId;
    const bUrl = req.body?.url;
    const bPublicId = req.body?.publicId;
    const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const publicIds = Array.isArray(req.body?.publicIds) ? req.body.publicIds : [];

    const overrideResource = req.body?.resourceType;
    const overrideDelivery = req.body?.deliveryType;

    const jobs = [];

    const allUrls = []
      .concat(qUrl ? [qUrl] : [])
      .concat(bUrl ? [bUrl] : [])
      .concat(urls)
      .filter(Boolean);

    for (const u of [...new Set(allUrls)]) {
      if (overrideResource || overrideDelivery) {
        const info = parseCloudinaryUrl(u);
        if (!info) jobs.push(Promise.reject(new Error("BAD_CLOUDINARY_URL")));
        else {
          jobs.push(
            destroyOne({
              public_id: info.public_id,
              resource_type: overrideResource || info.resource_type,
              delivery_type: overrideDelivery || info.delivery_type,
            })
          );
        }
      } else {
        jobs.push(destroyOneByUrl(u));
      }
    }

    const allPublicIds = []
      .concat(qPublicId ? [qPublicId] : [])
      .concat(bPublicId ? [bPublicId] : [])
      .concat(publicIds)
      .filter(Boolean);

    for (const pid of [...new Set(allPublicIds)]) {
      jobs.push(
        destroyOne({
          public_id: pid,
          resource_type: overrideResource || "image",
          delivery_type: overrideDelivery || "upload",
        })
      );
    }

    if (!jobs.length) return res.status(400).json({ ok: false, error: "url/publicId or arrays required" });

    const results = await Promise.allSettled(jobs);
    const deleted = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - deleted;

    res.json({
      ok: failed === 0,
      deleted,
      failed,
      results: results.map((r, i) =>
        r.status === "fulfilled"
          ? { i, status: "ok" }
          : { i, status: "error", reason: String(r.reason?.message || r.reason) }
      ),
    });
  } catch (e) {
    console.error("DELETE /api/images ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* REMOVED: GET /api/images/:id
   Served raw blobs out of an `images` table by sequential id, unauthenticated
   — trivially enumerable. The table no longer exists (the route answered 500
   in production) and no call site references it: every image has lived on
   Cloudinary since the base64 migration. */
};
