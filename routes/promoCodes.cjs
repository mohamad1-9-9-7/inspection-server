/* ============================================================
   Promo codes — one code per person who brings customers.

     GET    /api/promo-codes/check?code=   PUBLIC  is it usable? → { code, kind, amount, expiresAt }
     GET    /api/promo-codes               super-admin — every code + its leads
     POST   /api/promo-codes               super-admin — { code, kind, amount, holder, holderPhone, notes, expiresAt, maxUses, active }
     PATCH  /api/promo-codes/:id           super-admin — any of the same fields
     DELETE /api/promo-codes/:id           super-admin

   The owner makes a different code for each person (a consultant, a friend,
   a partner) and sends it, usually as a link: /demo?code=TAWFIQ. The /demo
   page shows the discounted prices, and the code is saved on the lead
   (demo_requests.promo_code) whether the visitor asks for a demo or starts
   a free trial — that is how the owner knows who brought which customers.

   kind 'pct' = percent off the per-branch monthly price (1-90);
   kind 'aed' = AED off the per-branch monthly price (1-1000).
   A code is usable while active, not past expires_at (Dubai date, the day
   itself counts) and, when max_uses is set, used by fewer leads than that.
   Deleting a code keeps the leads; they just keep the text of the code.

   Platform-owned like demo_requests: no company scope, super-admin only.
============================================================ */

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,29}$/;
const normCode = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "");
const todayDubai = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

const SELECT_CODES = `
  SELECT p.id, p.code, p.kind, p.amount::float AS amount, p.holder, p.holder_phone, p.notes, p.active,
         to_char(p.expires_at, 'YYYY-MM-DD') AS expires_at, p.max_uses, p.created_by, p.created_at, p.updated_at,
         (SELECT COUNT(*)::int FROM demo_requests d WHERE d.promo_code = p.code) AS uses
    FROM promo_codes p`;

/* The row behind a code if a visitor may use it right now, else null. */
async function findUsablePromo(pool, raw) {
  const code = normCode(raw);
  if (!CODE_RE.test(code)) return null;
  const { rows } = await pool.query(`${SELECT_CODES} WHERE p.code = $1`, [code]);
  const p = rows[0];
  if (!p || !p.active) return null;
  if (p.expires_at && p.expires_at < todayDubai()) return null;
  if (p.max_uses != null && p.uses >= p.max_uses) return null;
  return p;
}

const publicShape = (p) => ({ code: p.code, kind: p.kind, amount: Number(p.amount), expiresAt: p.expires_at || "" });

module.exports = function registerPromoCodeRoutes(app, deps = {}) {
  const { pool, requireAuthStrict, requireSuperAdmin, makeLimiter } = deps;

  const refuse = (_req, res) => res.status(403).json({ ok: false, error: "super_admin_required" });
  const strict = typeof requireAuthStrict === "function" ? requireAuthStrict : refuse;
  const superOnly = typeof requireSuperAdmin === "function" ? requireSuperAdmin : refuse;
  const gate = [strict, superOnly];

  // A visitor tries a code or two; a script guessing codes hits this fast.
  const checkLimiter = typeof makeLimiter === "function"
    ? makeLimiter({ max: 20, windowMs: 60 * 60_000, name: "promo-check" })
    : (_req, _res, next) => next();

  // eslint-disable-next-line no-control-regex
  const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);

  /* Body → columns. `partial` = PATCH (only what was sent). Throws { status, message }. */
  function parse(body = {}, partial = false) {
    const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
    const has = (k) => body[k] !== undefined;
    const out = {};
    if (!partial || has("code")) {
      const code = normCode(body.code);
      if (!CODE_RE.test(code)) throw bad("bad_code");
      out.code = code;
    }
    if (!partial || has("kind") || has("amount")) {
      const kind = body.kind === "aed" ? "aed" : "pct";
      const amount = Math.round(Number(body.amount) * 100) / 100;
      const max = kind === "pct" ? 90 : 1000;
      if (!(amount > 0 && amount <= max)) throw bad("bad_amount");
      out.kind = kind;
      out.amount = amount;
    }
    if (!partial || has("holder")) out.holder = clean(body.holder, 120);
    if (!partial || has("holderPhone")) out.holder_phone = clean(body.holderPhone, 40);
    if (!partial || has("notes")) out.notes = clean(body.notes, 2000);
    if (!partial || has("active")) out.active = body.active === undefined ? true : !!body.active;
    if (!partial || has("expiresAt")) {
      if (body.expiresAt && !isDate(body.expiresAt)) throw bad("bad_date");
      out.expires_at = body.expiresAt || null;
    }
    if (!partial || has("maxUses")) {
      const n = body.maxUses === "" || body.maxUses == null ? null : Math.round(Number(body.maxUses));
      if (n != null && !(n >= 1 && n <= 100000)) throw bad("bad_max_uses");
      out.max_uses = n;
    }
    return out;
  }

  const fail = (res, e, where, fallback) => {
    if (e?.status === 400) return res.status(400).json({ ok: false, error: e.message });
    if (e?.code === "23505") return res.status(409).json({ ok: false, error: "code_taken" });
    console.error(`${where} ERROR:`, e?.message || e);
    return res.status(500).json({ ok: false, error: fallback });
  };

  /* ---------- PUBLIC ---------- */
  app.get("/api/promo-codes/check", checkLimiter, async (req, res) => {
    try {
      const p = await findUsablePromo(pool, req.query.code);
      if (!p) return res.status(404).json({ ok: false, error: "invalid_code" });
      res.json({ ok: true, promo: publicShape(p) });
    } catch (e) {
      console.error("GET /api/promo-codes/check ERROR:", e?.message || e);
      res.status(500).json({ ok: false, error: "check_failed" });
    }
  });

  /* ---------- super-admin ---------- */
  app.get("/api/promo-codes", ...gate, async (_req, res) => {
    try {
      const { rows } = await pool.query(`${SELECT_CODES} ORDER BY p.created_at DESC`);
      // Every lead that carried a code — the owner sees who brought whom.
      const leads = (await pool.query(
        `SELECT id, promo_code, company_name, contact_name, phone, status, source, created_at
           FROM demo_requests WHERE promo_code <> '' ORDER BY created_at DESC LIMIT 5000`
      )).rows;
      res.json({ ok: true, codes: rows, leads });
    } catch (e) {
      console.error("GET /api/promo-codes ERROR:", e?.message || e);
      res.status(500).json({ ok: false, error: "load_failed" });
    }
  });

  app.post("/api/promo-codes", ...gate, async (req, res) => {
    try {
      const d = parse(req.body || {});
      d.created_by = String(req.user?.username || "").slice(0, 120);
      const cols = Object.keys(d);
      const { rows } = await pool.query(
        `INSERT INTO promo_codes (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
        cols.map((k) => d[k])
      );
      const fresh = await pool.query(`${SELECT_CODES} WHERE p.id = $1`, [rows[0].id]);
      res.status(201).json({ ok: true, code: fresh.rows[0] });
    } catch (e) {
      fail(res, e, "POST /api/promo-codes", "save_failed");
    }
  });

  app.patch("/api/promo-codes/:id", ...gate, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });
      const d = parse(req.body || {}, true);
      const cols = Object.keys(d);
      if (!cols.length) return res.status(400).json({ ok: false, error: "nothing_to_update" });

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const prev = await client.query(`SELECT code FROM promo_codes WHERE id = $1 FOR UPDATE`, [id]);
        if (!prev.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ ok: false, error: "not_found" }); }
        await client.query(
          `UPDATE promo_codes SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_at = now() WHERE id = $${cols.length + 1}`,
          [...cols.map((k) => d[k]), id]
        );
        // A renamed code keeps the leads it already brought.
        if (d.code && d.code !== prev.rows[0].code) {
          await client.query(`UPDATE demo_requests SET promo_code = $1 WHERE promo_code = $2`, [d.code, prev.rows[0].code]);
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      const fresh = await pool.query(`${SELECT_CODES} WHERE p.id = $1`, [id]);
      res.json({ ok: true, code: fresh.rows[0] });
    } catch (e) {
      fail(res, e, "PATCH /api/promo-codes", "update_failed");
    }
  });

  app.delete("/api/promo-codes/:id", ...gate, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });
      const { rowCount } = await pool.query(`DELETE FROM promo_codes WHERE id = $1`, [id]);
      if (!rowCount) return res.status(404).json({ ok: false, error: "not_found" });
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, "DELETE /api/promo-codes", "delete_failed");
    }
  });
};

module.exports.findUsablePromo = findUsablePromo;
