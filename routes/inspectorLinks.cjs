/* ============================================================
   Inspector links — a QR sticker an outside inspector (municipality,
   auditor) scans to see the LAST 7 DAYS of one report, with no account.

   POST /api/inspector-links              admin   mint a link  → { token } (shown ONCE)
   GET  /api/inspector-links?type=…       admin   the company's links (no tokens)
   POST /api/inspector-links/:id/revoke   admin   kill a link now
   GET  /api/public/inspector/:token      anyone  the read-only week

   Security
   • The token is 32 random bytes (base64url, 43 chars); only its SHA-256
     is stored, so a database leak or backup gives nobody a working link.
     The plain token exists once: in the mint response that prints the QR.
   • Every link has an expiry (1–365 days, default 180) and can be revoked.
   • Read-only and narrow: one whitelisted report type of the link's own
     company, today and the 6 days before (UAE), whatever the caller sends.
   • The answer is a fixed, sanitised shape — readings, remarks, product
     matches, the checker / verifier names. No employee numbers, account
     names, phone-reading log, photos, ids or anything else of the payload.
   • Unknown, revoked and expired links all answer the same 404, so the
     endpoint says nothing about which tokens exist; a malformed token is
     refused before touching the database. Rate-limited per IP.
   • no-store / noindex / no-referrer: nothing cached, indexed or leaked
     onward through the Referer header.
   • Minting / listing / revoking need an admin of the company (verified
     token); the link always belongs to the caller's company.
============================================================ */
const crypto = require("crypto");
const { companyOf, userOf } = require("../utils/tenant.cjs");

/* Report types a link may expose — the only ones, whatever the request says. */
const INSPECTOR_TYPES = {
  ftr1_temperature: {
    branch: "FTR 1",
    title: "Temperature Control Record (CCP) — FTR 1",
    shape: "grid",
  },
};

const DAYS = 7;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const isAdmin = (req) => {
  const u = userOf(req) || {};
  return !!(u.isAdmin || u.isSuperAdmin);
};
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const clip = (v, n) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, n);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function uaeDay(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Dubai" });
}

/* ---- the public shape (allow-list, never a copy of the payload) ---- */
const SLOT_RE = /^\d{1,2}:\d{2} (AM|PM)$/;
const num = (v) => {
  const s = String(v ?? "").trim();
  return /^[-+]?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
};

function publicGridDay(date, p) {
  const times = (Array.isArray(p.times) ? p.times : []).map((t) => clip(t, 12)).filter((t) => SLOT_RE.test(t)).slice(0, 24);
  const units = (Array.isArray(p.coolers) ? p.coolers : []).slice(0, 40).map((c) => {
    const temps = {};
    Object.entries(isObj(c?.temps) ? c.temps : {}).forEach(([k, v]) => {
      if (SLOT_RE.test(k)) {
        const n = num(v);
        if (n != null) temps[k] = n;
      }
    });
    return {
      name: clip(c?.name, 80),
      type: c?.type === "freezer" || c?.type === "chiller" ? c.type : "",
      temps,
      remarks: clip(c?.remarks, 400),
    };
  });
  const matches = (Array.isArray(p.productVerifications) ? p.productVerifications : []).slice(0, 100).map((r) => ({
    storageKey: /^unit-\d{1,2}$/.test(String(r?.storageKey || "")) ? r.storageKey : "",
    time: SLOT_RE.test(String(r?.time || "")) ? r.time : "",
    productName: clip(r?.productName, 160),
    productTemp: num(r?.productTemp),
    country: clip(r?.country, 60),
    remarks: clip(r?.remarks, 300),
  }));
  return {
    date,
    filed: !!p.savedAt,
    times,
    units,
    productVerifications: matches,
    checkedBy: clip(p.checkedBy, 120),
    verifiedBy: clip(p.verifiedBy || p.verifiedByQA, 120),
  };
}

module.exports = function registerInspectorLinkRoutes(app, deps = {}) {
  const { pool, requireAuthStrict, makeLimiter } = deps;
  const strict = typeof requireAuthStrict === "function" ? requireAuthStrict : (_q, _s, n) => n();
  const noGate = (_q, _s, n) => n();
  const publicLimiter = typeof makeLimiter === "function" ? makeLimiter({ max: 30, windowMs: 60_000, name: "inspector-link" }) : noGate;
  const adminLimiter = typeof makeLimiter === "function" ? makeLimiter({ max: 30, windowMs: 60_000, name: "inspector-admin" }) : noGate;

  const refuse = (res) => res.status(403).json({ ok: false, error: "admin_only" });

  /* ---------- mint ---------- */
  app.post("/api/inspector-links", adminLimiter, strict, async (req, res) => {
    try {
      if (!isAdmin(req)) return refuse(res);
      const type = String(req.body?.type || "");
      if (!INSPECTOR_TYPES[type]) return res.status(400).json({ ok: false, error: "bad_type" });
      const validDays = Math.min(365, Math.max(1, Math.round(Number(req.body?.validDays) || 180)));
      const label = clip(req.body?.label, 80);
      const token = crypto.randomBytes(32).toString("base64url");
      const u = userOf(req) || {};
      const ins = await pool.query(
        `INSERT INTO inspector_links (company_id, token_hash, report_type, label, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval)
         RETURNING id, report_type, label, created_by, created_at, expires_at`,
        [companyOf(req), sha256(token), type, label, clip(u.username || u.name, 80), String(validDays)]
      );
      return res.status(201).json({ ok: true, token, link: ins.rows[0] });
    } catch (e) {
      console.error("POST /api/inspector-links ERROR =", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ---------- list (never the token) ---------- */
  app.get("/api/inspector-links", adminLimiter, strict, async (req, res) => {
    try {
      if (!isAdmin(req)) return refuse(res);
      const type = String(req.query?.type || "");
      const r = await pool.query(
        `SELECT id, report_type, label, created_by, created_at, expires_at, revoked_at, revoked_by,
                last_opened_at, open_count
           FROM inspector_links
          WHERE company_id = $1 AND ($2 = '' OR report_type = $2)
          ORDER BY created_at DESC
          LIMIT 100`,
        [companyOf(req), type]
      );
      return res.json({ ok: true, links: r.rows });
    } catch (e) {
      console.error("GET /api/inspector-links ERROR =", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ---------- revoke ---------- */
  app.post("/api/inspector-links/:id/revoke", adminLimiter, strict, async (req, res) => {
    try {
      if (!isAdmin(req)) return refuse(res);
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });
      const u = userOf(req) || {};
      const r = await pool.query(
        `UPDATE inspector_links SET revoked_at = now(), revoked_by = $3
          WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL
          RETURNING id, revoked_at`,
        [id, companyOf(req), clip(u.username || u.name, 80)]
      );
      if (!r.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
      return res.json({ ok: true, link: r.rows[0] });
    } catch (e) {
      console.error("POST /api/inspector-links/:id/revoke ERROR =", e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ---------- the public week ---------- */
  app.get("/api/public/inspector/:token", publicLimiter, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Referrer-Policy", "no-referrer");
    const invalid = () => res.status(404).json({ ok: false, error: "LINK_INVALID" });
    try {
      const token = String(req.params.token || "");
      if (!TOKEN_RE.test(token)) return invalid();
      const hit = await pool.query(
        `SELECT id, company_id, report_type
           FROM inspector_links
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
          LIMIT 1`,
        [sha256(token)]
      );
      const link = hit.rows[0];
      const cfg = link && INSPECTOR_TYPES[link.report_type];
      if (!cfg) return invalid();

      const from = uaeDay(DAYS - 1);
      const to = uaeDay(0);
      // One row per business date (newest id wins if a day was ever filed twice).
      const rows = await pool.query(
        `SELECT DISTINCT ON (d) d, payload
           FROM (
             SELECT id, payload,
                    COALESCE(NULLIF(payload->>'reportDate', ''), LEFT(payload->>'date', 10)) AS d
               FROM reports
              WHERE COALESCE(company_id, 1) = $1 AND type = $2
           ) x
          WHERE d BETWEEN $3 AND $4
          ORDER BY d DESC, id DESC`,
        [Number(link.company_id) || 1, link.report_type, from, to]
      );
      const company = await pool.query(`SELECT name FROM companies WHERE id = $1`, [Number(link.company_id) || 1]).catch(() => ({ rows: [] }));

      pool.query(
        `UPDATE inspector_links SET last_opened_at = now(), open_count = open_count + 1 WHERE id = $1`,
        [link.id]
      ).catch(() => {});

      return res.json({
        ok: true,
        title: cfg.title,
        branch: cfg.branch,
        company: clip(company.rows[0]?.name, 120),
        from,
        to,
        generatedAt: new Date().toISOString(),
        days: rows.rows.map((r) => publicGridDay(r.d, isObj(r.payload) ? r.payload : {})),
      });
    } catch (e) {
      console.error("GET /api/public/inspector ERROR =", e?.message || e);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  });
};

module.exports.INSPECTOR_TYPES = INSPECTOR_TYPES;
