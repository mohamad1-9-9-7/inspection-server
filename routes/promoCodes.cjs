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

   REFERRER PORTAL — each holder can get a private link (/ref/<token>):
     GET    /api/referrer/:token                PUBLIC  what the code brought + commission
     POST   /api/promo-codes/:id/portal          super-admin — new link (the old one stops working)
     DELETE /api/promo-codes/:id/portal          super-admin — switch the link off
     POST   /api/promo-codes/:id/payouts         super-admin — { amount, currency, paidOn, note }
     DELETE /api/promo-payouts/:id               super-admin
   Commission = commission_pct of the PAID invoices (before VAT) of the
   companies carrying the code, for their first commission_months (null =
   always). The holder sees counts and its customers' names — never a lead's
   contact details.
============================================================ */
const crypto = require("crypto");

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{2,29}$/;
const normCode = (v) => String(v || "").trim().toUpperCase().replace(/\s+/g, "");
const todayDubai = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

const SELECT_CODES = `
  SELECT p.id, p.code, p.kind, p.amount::float AS amount, p.holder, p.holder_phone, p.notes, p.active,
         to_char(p.expires_at, 'YYYY-MM-DD') AS expires_at, p.max_uses, p.created_by, p.created_at, p.updated_at,
         p.commission_pct::float AS commission_pct, p.commission_months, p.portal_token,
         (SELECT COUNT(*)::int FROM demo_requests d WHERE d.promo_code = p.code) AS uses,
         (SELECT COUNT(*)::int FROM companies c WHERE c.promo_code = p.code AND NOT c.is_trial) AS customers,
         (SELECT COALESCE(SUM(v.n), 0)::int FROM promo_code_visits v WHERE v.code = p.code) AS visits
    FROM promo_codes p`;

/* Commission base per currency: paid invoices (before VAT) of the code's
   companies, inside their first `months` (null = all). */
const EARNINGS_SQL = `
  SELECT i.currency, COALESCE(SUM(i.subtotal), 0)::float AS base, COUNT(*)::int AS invoices
    FROM invoices i
    JOIN companies c ON c.id = i.company_id
   WHERE c.promo_code = $1 AND i.status = 'paid'
     AND ($2::int IS NULL OR i.period_start IS NULL OR c.start_date IS NULL
          OR i.period_start < (c.start_date + make_interval(months => $2::int)))
   GROUP BY i.currency`;

async function earningsOf(db, p) {
  const rows = (await db.query(EARNINGS_SQL, [p.code, p.commission_months == null ? null : Number(p.commission_months)])).rows;
  const pct = Number(p.commission_pct) || 0;
  const paid = (await db.query(
    `SELECT currency, COALESCE(SUM(amount), 0)::float AS paid FROM promo_payouts WHERE promo_code_id = $1 GROUP BY currency`, [p.id]
  )).rows;
  const cur = new Set([...rows.map((r) => r.currency || "AED"), ...paid.map((r) => r.currency || "AED")]);
  return [...cur].map((c) => {
    const base = rows.find((r) => (r.currency || "AED") === c)?.base || 0;
    const earned = Math.round(base * pct) / 100;
    const out = paid.find((r) => (r.currency || "AED") === c)?.paid || 0;
    return { currency: c, base, earned, paid: out, balance: Math.round((earned - out) * 100) / 100 };
  });
}

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
  // The holder refreshes its page now and then; a token guesser does not get far.
  const portalLimiter = typeof makeLimiter === "function"
    ? makeLimiter({ max: 60, windowMs: 60 * 60_000, name: "referrer-portal" })
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
    if (!partial || has("commissionPct")) {
      const n = body.commissionPct === "" || body.commissionPct == null ? 0 : Math.round(Number(body.commissionPct) * 100) / 100;
      if (!(n >= 0 && n <= 50)) throw bad("bad_commission");
      out.commission_pct = n;
    }
    if (!partial || has("commissionMonths")) {
      const n = body.commissionMonths === "" || body.commissionMonths == null ? null : Math.round(Number(body.commissionMonths));
      if (n != null && !(n >= 1 && n <= 120)) throw bad("bad_commission_months");
      out.commission_months = n;
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
      // A landing from the holder's link (/demo?code=…), once per visit — a count, nothing else.
      if (req.query.visit === "1") {
        await pool.query(
          `INSERT INTO promo_code_visits (code, day, n) VALUES ($1, $2, 1)
           ON CONFLICT (code, day) DO UPDATE SET n = promo_code_visits.n + 1`,
          [p.code, todayDubai()]
        ).catch((e) => console.warn("promo visit count skipped:", e?.message || e));
      }
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
      for (const r of rows) r.earnings = await earningsOf(pool, r);
      const payouts = (await pool.query(
        `SELECT id, promo_code_id, amount::float AS amount, currency, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, note, created_by, created_at
           FROM promo_payouts ORDER BY paid_on DESC, id DESC LIMIT 2000`
      )).rows;
      // Every lead that carried a code — the owner sees who brought whom.
      const leads = (await pool.query(
        `SELECT id, promo_code, company_name, contact_name, phone, status, source, created_at
           FROM demo_requests WHERE promo_code <> '' ORDER BY created_at DESC LIMIT 5000`
      )).rows;
      res.json({ ok: true, codes: rows, leads, payouts });
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
          // …and the customers it brought, and its visit counts.
          await client.query(`UPDATE companies SET promo_code = $1 WHERE promo_code = $2`, [d.code, prev.rows[0].code]);
          await client.query(`UPDATE promo_code_visits SET code = $1 WHERE code = $2`, [d.code, prev.rows[0].code]);
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

  /* ---------- referrer portal: link + payouts (super-admin) ---------- */
  const idOf = (req, res) => {
    const id = Number(req.params.id);
    if (!(Number.isInteger(id) && id > 0)) { res.status(400).json({ ok: false, error: "bad_id" }); return null; }
    return id;
  };

  app.post("/api/promo-codes/:id/portal", ...gate, async (req, res) => {
    try {
      const id = idOf(req, res);
      if (!id) return;
      const token = crypto.randomBytes(18).toString("base64url");
      const q = await pool.query(`UPDATE promo_codes SET portal_token = $2, updated_at = now() WHERE id = $1 RETURNING id`, [id, token]);
      if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
      const fresh = await pool.query(`${SELECT_CODES} WHERE p.id = $1`, [id]);
      res.json({ ok: true, code: fresh.rows[0] });
    } catch (e) {
      fail(res, e, "POST /api/promo-codes/portal", "portal_failed");
    }
  });

  app.delete("/api/promo-codes/:id/portal", ...gate, async (req, res) => {
    try {
      const id = idOf(req, res);
      if (!id) return;
      await pool.query(`UPDATE promo_codes SET portal_token = NULL, updated_at = now() WHERE id = $1`, [id]);
      const fresh = await pool.query(`${SELECT_CODES} WHERE p.id = $1`, [id]);
      res.json({ ok: true, code: fresh.rows[0] || null });
    } catch (e) {
      fail(res, e, "DELETE /api/promo-codes/portal", "portal_failed");
    }
  });

  app.post("/api/promo-codes/:id/payouts", ...gate, async (req, res) => {
    try {
      const id = idOf(req, res);
      if (!id) return;
      const b = req.body || {};
      const amount = Math.round(Number(b.amount) * 100) / 100;
      if (!(amount > 0 && amount < 1e8)) return res.status(400).json({ ok: false, error: "bad_amount" });
      const currency = /^[A-Z]{3}$/.test(String(b.currency || "")) ? b.currency : "AED";
      const paidOn = isDate(b.paidOn) ? b.paidOn : todayDubai();
      const q = await pool.query(
        `INSERT INTO promo_payouts (promo_code_id, amount, currency, paid_on, note, created_by)
         SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM promo_codes WHERE id = $1)
         RETURNING id, promo_code_id, amount::float AS amount, currency, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, note, created_by, created_at`,
        [id, amount, currency, paidOn, clean(b.note, 300), String(req.user?.username || "").slice(0, 120)]
      );
      if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
      res.status(201).json({ ok: true, payout: q.rows[0] });
    } catch (e) {
      fail(res, e, "POST /api/promo-codes/payouts", "payout_failed");
    }
  });

  app.delete("/api/promo-payouts/:id", ...gate, async (req, res) => {
    try {
      const id = idOf(req, res);
      if (!id) return;
      const q = await pool.query(`DELETE FROM promo_payouts WHERE id = $1`, [id]);
      if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
      res.json({ ok: true });
    } catch (e) {
      fail(res, e, "DELETE /api/promo-payouts", "payout_failed");
    }
  });

  /* ---------- PUBLIC: the holder's own page ---------- */
  app.get("/api/referrer/:token", portalLimiter, async (req, res) => {
    try {
      const token = String(req.params.token || "");
      if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return res.status(404).json({ ok: false, error: "not_found" });
      const p = (await pool.query(`${SELECT_CODES} WHERE p.portal_token = $1`, [token])).rows[0];
      if (!p) return res.status(404).json({ ok: false, error: "not_found" });

      const visits30 = (await pool.query(
        `SELECT COALESCE(SUM(n), 0)::int AS n FROM promo_code_visits WHERE code = $1 AND day > ($2::date - 30)`, [p.code, todayDubai()]
      )).rows[0].n;
      const leads = (await pool.query(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS day, CASE WHEN source LIKE 'trial%' THEN 'trial' ELSE 'demo' END AS kind
           FROM demo_requests WHERE promo_code = $1 ORDER BY created_at DESC LIMIT 200`, [p.code]
      )).rows;
      const customers = (await pool.query(
        `SELECT c.name, to_char(c.start_date, 'YYYY-MM-DD') AS since,
                CASE WHEN c.disabled_at IS NOT NULL OR c.status IN ('expired','suspended')
                       OR (c.end_date IS NOT NULL AND c.end_date < CURRENT_DATE) THEN 'inactive' ELSE 'active' END AS status,
                (SELECT COUNT(*)::int FROM invoices i WHERE i.company_id = c.id AND i.status = 'paid') AS paid_invoices
           FROM companies c WHERE c.promo_code = $1 AND NOT c.is_trial ORDER BY c.start_date DESC NULLS LAST, c.id DESC`, [p.code]
      )).rows;
      const payouts = (await pool.query(
        `SELECT amount::float AS amount, currency, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, note
           FROM promo_payouts WHERE promo_code_id = $1 ORDER BY paid_on DESC, id DESC LIMIT 100`, [p.id]
      )).rows;

      res.set("Cache-Control", "no-store");
      res.json({
        ok: true,
        referrer: {
          code: p.code, holder: p.holder, kind: p.kind, amount: Number(p.amount), active: !!p.active,
          expiresAt: p.expires_at || "", usable: !!(await findUsablePromo(pool, p.code)),
          commissionPct: Number(p.commission_pct) || 0, commissionMonths: p.commission_months,
        },
        funnel: {
          visits: p.visits, visits30, leads: leads.length,
          demos: leads.filter((l) => l.kind === "demo").length, trials: leads.filter((l) => l.kind === "trial").length,
          customers: customers.length, activeCustomers: customers.filter((c) => c.status === "active").length,
        },
        leads: leads.slice(0, 50),
        customers,
        earnings: await earningsOf(pool, p),
        payouts,
      });
    } catch (e) {
      console.error("GET /api/referrer ERROR:", e?.message || e);
      res.status(500).json({ ok: false, error: "load_failed" });
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
