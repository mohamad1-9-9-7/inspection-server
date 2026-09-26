module.exports = function registerBillingRoutes(app, deps = {}) {
  const { pool, requireAuthStrict, requireSuperAdmin, verifyToken, tokenFromReq } = deps;

  const { markCompanyDisabled } = require("../utils/companyGate.cjs");
  const noGate = (_req, _res, next) => next();
  const strict = typeof requireAuthStrict === "function" ? requireAuthStrict : noGate;

  /* Which company a subscription read is about. GET /api/subscription is
     open (App.jsx may call it at any time), so the token is decoded by hand
     rather than relying on middleware to have set req.user:
       • an account pinned to a company → that company, never overridable;
       • the super-admin → the company it names in ?company_id, else none;
       • no token at all → none. It used to fall back to company 1, so the
         pre-login read cached AL MAWASHI's status for whoever logged in next,
         in any company. With no company there is nothing to lock. */
  function subCompanyOf(req) {
    let user = req.user || null;
    if (!user && typeof verifyToken === "function" && typeof tokenFromReq === "function") {
      const raw = tokenFromReq(req);
      user = raw ? verifyToken(raw) : null;
    }
    if (!user) return null;
    const own = Number(user.companyId);
    if (Number.isFinite(own) && own > 0) return own;
    if (user.isSuperAdmin) {
      const q = Number(req.query?.company_id);
      if (Number.isFinite(q) && q > 0) return q;
    }
    return null;
  }

  /* The platform owner only — see utils/requireAuth.cjs. Company CRUD used to
     be gated only client-side, so any branch admin's token could manage
     OTHER companies; everything financial here now goes through this. */
  // Fails CLOSED: if the gate was not wired in, refuse rather than open up.
  const superOnly = typeof requireSuperAdmin === "function"
    ? requireSuperAdmin
    : (_req, res) => res.status(403).json({ ok: false, error: "super_admin_required" });

  /* Who may touch what in this file:
       • GET /api/plans, GET /api/subscription — open: App.jsx caches the
         subscription on boot, before anyone has logged in, and plan tiers
         are just public pricing.
       • GET /api/companies — any session, but filtered to the caller's own
         company unless it is the super-admin (see the route).
       • everything else (plan/subscription edits, the seller profile,
         invoices) — the platform owner only (strict + superOnly). A company
         admin editing PUT /api/subscription could otherwise extend its own
         end date, and invoices are the owner's books, not the tenant's. */

/* ============================================================
   PLANS — CRUD
============================================================ */

app.get("/api/plans", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM plans ORDER BY price ASC`);
    res.json({ ok: true, plans: q.rows });
  } catch (e) {
    console.error("GET /api/plans ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/plans", strict, superOnly, async (req, res) => {
  try {
    /* A plan is a name and a price. The old branch/user limits were shown
       but never enforced anywhere, so they were removed (Sep 2026); the
       columns stay in the table at their "unlimited" default, unused. */
    const { name, price, currency, setup_fee, description } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    const q = await pool.query(
      `INSERT INTO plans (name, price, currency, setup_fee, description)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name, price || 0, currency || "AED", setup_fee || 0, description || ""]
    );
    res.json({ ok: true, plan: q.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ ok: false, error: "name_taken" });
    console.error("POST /api/plans ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.put("/api/plans/:id", strict, superOnly, async (req, res) => {
  try {
    const { name, price, currency, setup_fee, description, is_active } = req.body;
    const q = await pool.query(
      `UPDATE plans SET name=$1, price=$2, currency=$3, setup_fee=$4,
         description=$5, is_active=$6, updated_at=now()
       WHERE id=$7 RETURNING *`,
      [name, price, currency || "AED", setup_fee || 0,
       description || "", is_active !== false, req.params.id]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, plan: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/plans/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.delete("/api/plans/:id", strict, superOnly, async (req, res) => {
  try {
    await pool.query(`UPDATE companies SET plan_id=NULL WHERE plan_id=$1`, [req.params.id]);
    await pool.query(`DELETE FROM plans WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/plans/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   COMPANIES — CRUD
============================================================ */

/* The tenant list is the platform owner's customer book (names, contact
   e-mails, what each one pays). Only the super-admin sees all of it; any
   other account sees its own company row and nothing else — never another
   customer. Same no-AUTH_SECRET escape hatch as superOnly, for local dev. */
app.get("/api/companies", strict, async (req, res) => {
  try {
    const u = req.user || {};
    const seesAll = !!u.isSuperAdmin || !process.env.AUTH_SECRET;
    const ownId = Number(u.companyId);
    if (!seesAll && !(Number.isFinite(ownId) && ownId > 0)) {
      return res.json({ ok: true, companies: [] });
    }
    const q = await pool.query(
      `SELECT c.*, p.name AS plan_name, p.price AS plan_price, p.currency AS plan_currency,
              to_char(c.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(c.end_date,   'YYYY-MM-DD') AS end_date
         FROM companies c
         LEFT JOIN plans p ON p.id = c.plan_id
        ${seesAll ? "" : "WHERE c.id = $1"}
        ORDER BY c.created_at ASC`,
      seesAll ? [] : [ownId]
    );
    res.json({ ok: true, companies: q.rows });
  } catch (e) {
    console.error("GET /api/companies ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* The company row IS the subscription (see SUBSCRIPTION below), so what
   goes into it is checked here, once, for every screen that writes it. */
const COMPANY_STATUSES = new Set(["active", "trial", "expired", "suspended"]);
const CURRENCIES = new Set(["AED", "SAR", "USD", "EUR", "GBP"]);
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "").slice(0, 10)) ? String(v).slice(0, 10) : null);

function companyInput(body) {
  const b = body || {};
  const out = {
    name: String(b.name || "").trim(),
    contact_name: String(b.contact_name || "").trim(),
    contact_email: String(b.contact_email || "").trim(),
    contact_phone: String(b.contact_phone || "").trim(),
    plan_id: Number.isInteger(Number(b.plan_id)) && Number(b.plan_id) > 0 ? Number(b.plan_id) : null,
    status: String(b.status || "active"),
    start_date: isoDate(b.start_date),
    end_date: isoDate(b.end_date),
    notes: String(b.notes || ""),
    industry: b.industry ? String(b.industry) : null,
    // price: absent → keep what is stored; "" / null → use the plan's price.
    hasPrice: Object.prototype.hasOwnProperty.call(b, "price"),
    price: b.price === "" || b.price == null ? null : Number(b.price),
    hasCurrency: Object.prototype.hasOwnProperty.call(b, "currency"),
    currency: b.currency ? String(b.currency).toUpperCase() : null,
  };
  let error = null;
  if (!out.name) error = "name_required";
  else if (!COMPANY_STATUSES.has(out.status)) error = "status_invalid";
  else if (out.start_date && out.end_date && out.end_date < out.start_date) error = "end_before_start";
  else if (out.price !== null && !(Number.isFinite(out.price) && out.price >= 0)) error = "price_invalid";
  else if (out.currency && !CURRENCIES.has(out.currency)) error = "currency_invalid";
  return { input: out, error };
}

app.post("/api/companies", strict, superOnly, async (req, res) => {
  try {
    const { input: c, error } = companyInput(req.body);
    if (error) return res.status(400).json({ ok: false, error });
    const q = await pool.query(
      `INSERT INTO companies (name, contact_name, contact_email, contact_phone, plan_id, status,
                              start_date, end_date, notes, industry, price, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [c.name, c.contact_name, c.contact_email, c.contact_phone, c.plan_id, c.status,
       c.start_date, c.end_date, c.notes, c.industry || "meat", c.price, c.currency]
    );
    res.json({ ok: true, company: q.rows[0] });
  } catch (e) {
    if (e.code === "23503") return res.status(400).json({ ok: false, error: "plan_not_found" });
    console.error("POST /api/companies ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.put("/api/companies/:id", strict, superOnly, async (req, res) => {
  try {
    const { input: c, error } = companyInput(req.body);
    if (error) return res.status(400).json({ ok: false, error });
    /* industry / price / currency omitted from the body → keep the stored
       value, so an older client that doesn't know a field can't wipe it. */
    const q = await pool.query(
      `UPDATE companies SET name=$1, contact_name=$2, contact_email=$3, contact_phone=$4,
         plan_id=$5, status=$6, start_date=$7, end_date=$8, notes=$9,
         industry=COALESCE($10, industry),
         price    = CASE WHEN $12 THEN $11::numeric ELSE price END,
         currency = CASE WHEN $14 THEN $13 ELSE currency END,
         updated_at=now()
       WHERE id=$15 RETURNING *`,
      [c.name, c.contact_name, c.contact_email, c.contact_phone, c.plan_id, c.status,
       c.start_date, c.end_date, c.notes, c.industry,
       c.price, c.hasPrice, c.currency, c.hasCurrency, req.params.id]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, company: q.rows[0] });
  } catch (e) {
    if (e.code === "23503") return res.status(400).json({ ok: false, error: "plan_not_found" });
    console.error("PUT /api/companies/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* There is NO delete. A company is only DISABLED and RE-ENABLED.
   (A hard DELETE used to null company_id on every account and report it
   owned, and the boot backfill then filed all of it under the primary
   company — see db/schema.cjs.)

   Disabled = disabled_at set. Its accounts cannot log in (routes/admin.cjs)
   and any session already open is answered 401 on its next request
   (utils/companyGate.cjs), so it is signed out. Only the super-admin can
   still enter it. Stored status/dates are left as they were, so re-enabling
   brings the company back exactly as it stood. The primary company (id 1)
   cannot be disabled. */
app.post("/api/companies/:id/disable", strict, superOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ ok: false, error: "bad_id" });
    if (id === 1) return res.status(400).json({ ok: false, error: "primary_company" });
    const upd = await pool.query(
      `UPDATE companies SET disabled_at = COALESCE(disabled_at, now()), updated_at = now()
        WHERE id = $1 RETURNING id, disabled_at`,
      [id]
    );
    if (!upd.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    markCompanyDisabled(id, true);
    res.json({ ok: true, company: upd.rows[0] });
  } catch (e) {
    console.error("POST /api/companies/:id/disable ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/companies/:id/enable", strict, superOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ ok: false, error: "bad_id" });
    const upd = await pool.query(
      `UPDATE companies SET disabled_at = NULL, updated_at = now() WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!upd.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    markCompanyDisabled(id, false);
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/companies/:id/enable ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   SUBSCRIPTION — read-only view of the company row.

   The company row in `companies` is the ONE answer to "what plan, what
   price, until when, active or not". The login lock reads it, and so does
   this route (which the in-app lock polls). It is edited in one place only:
   PUT /api/companies/:id. The old `subscription` table is retired.
============================================================ */

/* A stored "active"/"trial" whose end date has passed is, in effect,
   expired — the same rule the login lock applies. */
const EFFECTIVE_STATUS_SQL = `
  CASE
    WHEN c.disabled_at IS NOT NULL THEN 'suspended'
    WHEN c.status IN ('expired','suspended') THEN c.status
    WHEN c.end_date IS NOT NULL AND c.end_date < CURRENT_DATE THEN 'expired'
    ELSE c.status
  END`;

app.get("/api/subscription", async (req, res) => {
  try {
    const companyId = subCompanyOf(req);
    if (!companyId) return res.json({ ok: true, subscription: null });
    const q = await pool.query(
      `SELECT c.id            AS company_id,
              c.name          AS company_name,
              p.id            AS plan_id,
              p.name          AS plan,
              ${EFFECTIVE_STATUS_SQL} AS status,
              c.status        AS stored_status,
              to_char(c.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(c.end_date,   'YYYY-MM-DD') AS end_date,
              COALESCE(c.price, p.price)                 AS price,
              COALESCE(NULLIF(c.currency,''), p.currency, 'AED') AS currency,
              c.price         AS custom_price,
              p.setup_fee,
              c.updated_at
         FROM companies c
         LEFT JOIN plans p ON p.id = c.plan_id
        WHERE c.id = $1`,
      [companyId]
    );
    res.json({ ok: true, subscription: q.rows[0] || null });
  } catch (e) {
    console.error("GET /api/subscription ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   BILLING PROFILE — the SELLER (INSPECT PRO, the platform owner).
   One row; printed at the top of every quotation and invoice.
============================================================ */

  /* Every field the seller row may carry, and how to clean it. A PUT only
     touches the keys it actually sends, so an older screen that knows six
     of these can never blank the rest. */
  const SELLER_FIELDS = {
    company_name:       (v) => String(v ?? "").trim().slice(0, 160),
    owner_name:         (v) => String(v ?? "").trim().slice(0, 160),
    company_address:    (v) => String(v ?? "").trim().slice(0, 400),
    contact_email:      (v) => String(v ?? "").trim().slice(0, 160),
    contact_phone:      (v) => String(v ?? "").trim().slice(0, 60),
    website:            (v) => String(v ?? "").trim().slice(0, 200),
    logo_url:           (v) => String(v ?? "").trim(),
    license_status:     (v) => (String(v) === "issued" ? "issued" : "pending"),
    license_no:         (v) => String(v ?? "").trim().slice(0, 80),
    license_authority:  (v) => String(v ?? "").trim().slice(0, 160),
    license_expiry:     (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null),
    vat_registered:     (v) => v === true || v === "true",
    tax_id:             (v) => String(v ?? "").replace(/\s+/g, ""),
    bank_name:          (v) => String(v ?? "").trim().slice(0, 160),
    account_name:       (v) => String(v ?? "").trim().slice(0, 160),
    iban:               (v) => String(v ?? "").replace(/\s+/g, "").toUpperCase(),
    swift:              (v) => String(v ?? "").replace(/\s+/g, "").toUpperCase(),
    payment_terms_days: (v) => Math.min(Math.max(parseInt(v, 10) || 0, 0), 365),
    notes:              (v) => String(v ?? "").slice(0, 2000),
  };

  /* Rules a document would otherwise print wrong. Checked against the row
     as it WILL be (stored values merged with the incoming ones), so a
     partial PUT is judged on its result, not on the fragment it sent. */
  function sellerProblem(p) {
    if (p.vat_registered && !/^\d{15}$/.test(p.tax_id || "")) return "trn_required_15_digits";
    if (p.logo_url && !/^https?:\/\//i.test(p.logo_url)) return "logo_must_be_hosted_url";
    if (p.iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(p.iban)) return "iban_invalid";
    if (p.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.contact_email)) return "email_invalid";
    return null;
  }

app.get("/api/billing-profile", strict, superOnly, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM billing_profile ORDER BY id ASC LIMIT 1`);
    res.json({ ok: true, profile: q.rows[0] || null });
  } catch (e) {
    console.error("GET /api/billing-profile ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.put("/api/billing-profile", strict, superOnly, async (req, res) => {
  try {
    const body = req.body || {};
    /* Ensure a row exists */
    await pool.query(`
      INSERT INTO billing_profile (company_name)
      SELECT 'INSPECT PRO' WHERE NOT EXISTS (SELECT 1 FROM billing_profile LIMIT 1)
    `);
    const cur = (await pool.query(`SELECT * FROM billing_profile ORDER BY id ASC LIMIT 1`)).rows[0] || {};

    const sets = [];
    const vals = [];
    const next = { ...cur };
    for (const [key, clean] of Object.entries(SELLER_FIELDS)) {
      if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
      const v = clean(body[key]);
      next[key] = v;
      vals.push(v);
      sets.push(`${key}=$${vals.length}`);
    }
    const problem = sellerProblem(next);
    if (problem) return res.status(400).json({ ok: false, error: problem });
    if (!sets.length) return res.json({ ok: true, profile: cur });

    vals.push(cur.id);
    const q = await pool.query(
      `UPDATE billing_profile SET ${sets.join(", ")}, updated_at=now()
        WHERE id=$${vals.length}
        RETURNING *`,
      vals
    );
    res.json({ ok: true, profile: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/billing-profile ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   INVOICES — issued BY INSPECT PRO (the seller profile) TO a company.

   Issued once, then never re-priced: an invoice is a legal record. What
   can change afterwards is its payment state only —
     unpaid → paid (date + reference) → back to unpaid (a mistake),
     unpaid → void (with a reason).
   A paid invoice is not voided; that would need a credit note.

   Everything the document prints is frozen at issue: the seller (as the
   profile was that day), the buyer, the lines, the VAT split. VAT is the
   server's call, not the browser's: not VAT-registered → 0 % and the
   title "Invoice"; registered → "Tax Invoice".
============================================================ */

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const INVOICE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v) => (INVOICE_DATE.test(String(v || "").slice(0, 10)) ? String(v).slice(0, 10) : null);
const addDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (Number(days) || 0));
  return d.toISOString().slice(0, 10);
};

/* unpaid past its due date reads "overdue" — computed, never stored. */
/* Dates leave as plain 'YYYY-MM-DD' text. node-pg turns a DATE into a JS
   Date at the SERVER's local midnight, so a server running east of UTC
   would print an invoice issued on the 25th as the 24th. A legal date
   must not depend on the host's time zone. (Later columns win in node-pg,
   so these override i.*.) */
const INVOICE_SELECT = `
  SELECT i.*,
         to_char(i.issue_date,   'YYYY-MM-DD') AS issue_date,
         to_char(i.due_date,     'YYYY-MM-DD') AS due_date,
         to_char(i.paid_at,      'YYYY-MM-DD') AS paid_at,
         to_char(i.period_start, 'YYYY-MM-DD') AS period_start,
         to_char(i.period_end,   'YYYY-MM-DD') AS period_end,
         CASE WHEN i.status = 'unpaid' AND i.due_date IS NOT NULL AND i.due_date < CURRENT_DATE
              THEN 'overdue' ELSE i.status END AS display_status
    FROM invoices i`;

function sellerSnapshot(p) {
  const s = p || {};
  const registered = s.vat_registered === true;
  return {
    name: s.company_name || "INSPECT PRO",
    owner_name: s.owner_name || "",
    address: s.company_address || "",
    email: s.contact_email || "",
    phone: s.contact_phone || "",
    website: s.website || "",
    logo_url: s.logo_url || "",
    license_status: s.license_status || "pending",
    license_no: s.license_status === "issued" ? s.license_no || "" : "",
    license_authority: s.license_status === "issued" ? s.license_authority || "" : "",
    vat_registered: registered,
    trn: registered ? s.tax_id || "" : "",
    bank_name: s.bank_name || "",
    account_name: s.account_name || "",
    iban: s.iban || "",
    swift: s.swift || "",
  };
}

/* Lines as sent, cleaned; null when any line is unusable. */
function cleanLines(raw) {
  if (!Array.isArray(raw)) return null;
  if (raw.length < 1 || raw.length > 50) return null;
  const out = [];
  for (const l of raw) {
    const description = String(l?.description || "").trim().slice(0, 300);
    const qty = Number(l?.qty);
    const unit_price = Number(l?.unit_price);
    if (!description || !(qty > 0) || !(unit_price >= 0)) return null;
    out.push({ description, qty: round2(qty), unit_price: round2(unit_price), total: round2(qty * unit_price) });
  }
  return out;
}

async function nextInvoiceNumber(db, issueDate) {
  const year = String(issueDate).slice(0, 4);
  const q = await db.query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM $1) AS INT)), 0) + 1 AS n
       FROM invoices
      WHERE invoice_number ~ $2`,
    [`^INV-${year}-(\\d+)$`, `^INV-${year}-\\d+$`]
  );
  return `INV-${year}-${String(q.rows[0].n).padStart(4, "0")}`;
}

app.get("/api/invoices", strict, superOnly, async (req, res) => {
  try {
    const cid = Number(req.query?.company_id);
    const byCompany = Number.isInteger(cid) && cid > 0;
    const q = await pool.query(
      `${INVOICE_SELECT} ${byCompany ? "WHERE i.company_id = $1" : ""} ORDER BY i.issue_date DESC, i.id DESC LIMIT 2000`,
      byCompany ? [cid] : []
    );
    res.json({ ok: true, invoices: q.rows });
  } catch (e) {
    console.error("GET /api/invoices ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/invoices/:id", strict, superOnly, async (req, res) => {
  try {
    const q = await pool.query(`${INVOICE_SELECT} WHERE i.id = $1`, [req.params.id]);
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, invoice: q.rows[0] });
  } catch (e) {
    console.error("GET /api/invoices/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* POST /api/invoices
   { company_id, issue_date?, period_start?, period_end?, lines?, vat_pct?, notes? }
   No lines → one line: the company's subscription at its effective price. */
app.post("/api/invoices", strict, superOnly, async (req, res) => {
  try {
    const b = req.body || {};
    const companyId = Number(b.company_id);
    if (!Number.isInteger(companyId) || companyId <= 0) return res.status(400).json({ ok: false, error: "company_required" });

    const cq = await pool.query(
      `SELECT c.*, p.name AS plan_name, p.price AS plan_price, p.currency AS plan_currency
         FROM companies c LEFT JOIN plans p ON p.id = c.plan_id
        WHERE c.id = $1`,
      [companyId]
    );
    const company = cq.rows[0];
    if (!company) return res.status(400).json({ ok: false, error: "company_not_found" });

    const issueDate = asDate(b.issue_date) || new Date().toISOString().slice(0, 10);
    const periodStart = asDate(b.period_start);
    const periodEnd = asDate(b.period_end);
    if (periodStart && periodEnd && periodEnd < periodStart) return res.status(400).json({ ok: false, error: "period_invalid" });

    const profile = (await pool.query(`SELECT * FROM billing_profile ORDER BY id ASC LIMIT 1`)).rows[0] || {};
    const seller = sellerSnapshot(profile);

    const price = company.price != null ? Number(company.price) : Number(company.plan_price || 0);
    const currency = company.currency || company.plan_currency || "AED";
    let lines;
    if (b.lines === undefined || b.lines === null) {
      // The period is printed in the header; the line just names what is billed.
      lines = [{
        description: `Subscription — ${company.plan_name || "custom"} plan`,
        qty: 1, unit_price: round2(price), total: round2(price),
      }];
    } else {
      lines = cleanLines(b.lines);
      if (!lines) return res.status(400).json({ ok: false, error: "lines_invalid" });
    }

    const vatPct = seller.vat_registered ? Math.min(Math.max(Number(b.vat_pct ?? 5) || 0, 0), 100) : 0;
    const subtotal = round2(lines.reduce((s, l) => s + l.total, 0));
    const vatAmount = round2((subtotal * vatPct) / 100);
    const total = round2(subtotal + vatAmount);
    const dueDate = addDays(issueDate, profile.payment_terms_days ?? 14);
    const accounts = (await pool.query(
      `SELECT COUNT(*)::int AS n FROM app_users WHERE company_id = $1 AND is_active = true`, [companyId]
    ).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;

    /* Numbering races: the loser takes the next free number. */
    let number = await nextInvoiceNumber(pool, issueDate);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const q = await pool.query(
          `INSERT INTO invoices (
             invoice_number, issue_date, period_start, period_end,
             company_name, company_address, tax_id,
             plan_name, accounts_count, branches_count, max_branches, max_users,
             amount, currency, notes, created_by,
             company_id, status, title, due_date, subtotal, vat_pct, vat_amount,
             lines, seller, buyer_contact, buyer_email
           ) VALUES (
             $1,$2,$3,$4,$5,'','', $6,$7,0,$8,$9, $10,$11,$12,$13,
             $14,'unpaid',$15,$16,$17,$18,$19,$20,$21,$22,$23
           ) RETURNING id`,
          [
            number, issueDate, periodStart, periodEnd, company.name,
            company.plan_name || "", accounts, null, null, // plan limits retired
            total, currency, String(b.notes || "").slice(0, 2000), String(req.user?.username || "admin"),
            companyId, seller.vat_registered ? "Tax Invoice" : "Invoice", dueDate, subtotal, vatPct, vatAmount,
            JSON.stringify(lines), JSON.stringify(seller), company.contact_name || "", company.contact_email || "",
          ]
        );
        const out = await pool.query(`${INVOICE_SELECT} WHERE i.id = $1`, [q.rows[0].id]);
        return res.json({ ok: true, invoice: out.rows[0] });
      } catch (e) {
        if (e.code !== "23505") throw e;
        number = await nextInvoiceNumber(pool, issueDate);
      }
    }
    return res.status(409).json({ ok: false, error: "number_taken" });
  } catch (e) {
    console.error("POST /api/invoices ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* PATCH /api/invoices/:id — payment state only.
   { action: "mark_paid", paid_at?, payment_ref? } | { action: "mark_unpaid" }
   | { action: "void", reason } */
app.patch("/api/invoices/:id", strict, superOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });
    const cur = (await pool.query(`SELECT status, issue_date FROM invoices WHERE id = $1`, [id])).rows[0];
    if (!cur) return res.status(404).json({ ok: false, error: "not_found" });
    const b = req.body || {};

    let sql;
    let params;
    if (b.action === "mark_paid") {
      if (cur.status !== "unpaid") return res.status(409).json({ ok: false, error: "not_unpaid" });
      const paidAt = asDate(b.paid_at) || new Date().toISOString().slice(0, 10);
      sql = `UPDATE invoices SET status='paid', paid_at=$2, payment_ref=$3 WHERE id=$1`;
      params = [id, paidAt, String(b.payment_ref || "").slice(0, 120)];
    } else if (b.action === "mark_unpaid") {
      if (cur.status !== "paid") return res.status(409).json({ ok: false, error: "not_paid" });
      sql = `UPDATE invoices SET status='unpaid', paid_at=NULL, payment_ref='' WHERE id=$1`;
      params = [id];
    } else if (b.action === "void") {
      if (cur.status !== "unpaid") return res.status(409).json({ ok: false, error: "only_unpaid_can_be_voided" });
      const reason = String(b.reason || "").trim().slice(0, 500);
      if (!reason) return res.status(400).json({ ok: false, error: "reason_required" });
      sql = `UPDATE invoices SET status='void', void_reason=$2 WHERE id=$1`;
      params = [id, reason];
    } else {
      return res.status(400).json({ ok: false, error: "unknown_action" });
    }
    await pool.query(sql, params);
    const out = await pool.query(`${INVOICE_SELECT} WHERE i.id = $1`, [id]);
    res.json({ ok: true, invoice: out.rows[0] });
  } catch (e) {
    console.error("PATCH /api/invoices/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});
};
