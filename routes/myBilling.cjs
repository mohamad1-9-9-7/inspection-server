/* ============================================================
   A company's own billing, inside the app (/my-billing) — and the owner's
   review of the payments it reports.

   Company admin (its own company only — the token's companyId; under
   TENANT_RLS the database confines it as well):
     GET    /api/my-billing                 subscription, invoices, proofs, bank details, rate-lock offer
     POST   /api/my-billing/proofs          "I paid": receipt image + amount (+ reference, date, browser OCR)
     DELETE /api/my-billing/proofs/:id      withdraw a proof still waiting for review
     POST   /api/my-billing/rate-lock       issue the yearly rate-lock invoice (or return the one already issued)

   Platform owner (super-admin):
     GET    /api/payment-proofs?status=     the review queue (pending by default)
     GET    /api/payment-proofs/count       { pending } for the badge
     POST   /api/payment-proofs/:id/accept  the invoice becomes paid (utils/billingPayments.cjs)
     POST   /api/payment-proofs/:id/reject  { reason }

   Why in-app and not e-mail: the customer opens the app every day; an
   invoice there cannot land in spam, and the receipt comes back the same way.

   RATE LOCK — the promo code discount lasts one year (companies.promo_until).
   In the last RATE_LOCK_WINDOW_DAYS before it ends the customer is offered a
   year paid up front at today's discounted rate. Accepting issues that
   invoice (kind 'promo_lock'); paying it moves promo_until to its period end.
============================================================ */
const { markInvoicePaid, inTransaction } = require("../utils/billingPayments.cjs");
const { runAsPlatform } = require("../utils/tenantContext.cjs");

const RATE_LOCK_WINDOW_DAYS = 60;
const MAX_PENDING_PER_INVOICE = 3;
const PROOF_URL = /^https:\/\/res\.cloudinary\.com\/[^\s]+$/i;

const todayIso = () => new Date().toISOString().slice(0, 10);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addMonthsIso(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  if (dt.getUTCDate() !== d) dt.setUTCDate(0); // 31 Jan + 1 month → 28/29 Feb
  return dt.toISOString().slice(0, 10);
}

module.exports = function registerMyBillingRoutes(app, deps = {}) {
  const { pool, requireAuthStrict, requireSuperAdmin, billing } = deps;
  const refuse = (_req, res) => res.status(403).json({ ok: false, error: "forbidden" });
  const strict = typeof requireAuthStrict === "function" ? requireAuthStrict : refuse;
  const superOnly = typeof requireSuperAdmin === "function" ? requireSuperAdmin : refuse;
  if (!billing || typeof billing.issueInvoice !== "function") {
    console.warn("[my-billing] billing helpers missing — routes not registered");
    return;
  }
  const { issueInvoice, INVOICE_SELECT, PLAN_PRICE_SQL, EFFECTIVE_STATUS_SQL, round2 } = billing;

  /* A company ADMIN of a real company. The super-admin has no company of its
     own here — it reviews from the Platform Center instead. */
  function companyAdmin(req, res, next) {
    const u = req.user || {};
    const id = Number(u.companyId);
    if (!(Number.isInteger(id) && id > 0)) return res.status(403).json({ ok: false, error: "company_account_required" });
    if (!u.isAdmin) return res.status(403).json({ ok: false, error: "admin_required" });
    req.companyId = id;
    return next();
  }
  const customer = [strict, companyAdmin];
  const owner = [strict, superOnly];

  const fail = (res, e, where) => {
    if (e?.status && e?.code) return res.status(e.status).json({ ok: false, error: e.code });
    console.error(`${where} ERROR:`, e?.message || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  };

  async function loadCompany(db, companyId) {
    const q = await db.query(
      `SELECT c.id, c.name, c.branches, c.is_trial, c.promo_code, c.promo_kind,
              c.promo_amount::float AS promo_amount,
              to_char(c.promo_until, 'YYYY-MM-DD') AS promo_until,
              ${EFFECTIVE_STATUS_SQL} AS status,
              to_char(c.start_date, 'YYYY-MM-DD') AS start_date,
              to_char(c.end_date,   'YYYY-MM-DD') AS end_date,
              COALESCE(c.price, ${PLAN_PRICE_SQL})::float AS price,
              COALESCE(NULLIF(c.currency,''), p.currency, 'AED') AS currency,
              p.name AS plan_name
         FROM companies c LEFT JOIN plans p ON p.id = c.plan_id
        WHERE c.id = $1`,
      [companyId]
    );
    return q.rows[0] || null;
  }

  /* What the promo takes off one month (same rule as the frontend's
     invoiceCore.promoMonthlyOff): % of the price, or AED per branch. */
  function monthlyOff(c) {
    const price = Number(c.price) || 0;
    const amount = Number(c.promo_amount) || 0;
    if (!(price > 0) || !(amount > 0)) return 0;
    const off = c.promo_kind === "aed" ? amount * Math.max(1, Number(c.branches) || 1) : (price * amount) / 100;
    return Math.min(price, round2(off));
  }

  /* The rate-lock offer as it stands today. `invoices` = the company's. */
  function rateLockOf(c, invoices, today = todayIso()) {
    const none = (reason) => ({ eligible: false, reason });
    if (!c || c.is_trial) return none("not_applicable");
    if (!c.promo_code || !c.promo_until || !(Number(c.promo_amount) > 0)) return none("no_promo");
    if (c.promo_until < today) return none("promo_ended");
    const daysLeft = daysBetween(today, c.promo_until);
    const existing = (invoices || []).find((i) => i.kind === "promo_lock" && i.status !== "void"
      && i.period_end && i.period_end > c.promo_until);
    if (existing) return { eligible: false, reason: "issued", invoiceId: existing.id, invoiceNumber: existing.invoice_number, status: existing.display_status || existing.status, daysLeft, promoUntil: c.promo_until };
    if (daysLeft > RATE_LOCK_WINDOW_DAYS) return { ...none("too_early"), opensOn: addDaysIso(c.promo_until, -RATE_LOCK_WINDOW_DAYS), promoUntil: c.promo_until };
    const off = monthlyOff(c);
    if (!(off > 0)) return none("no_discount");
    const price = Number(c.price) || 0;
    // The locked year follows what is already paid for.
    const periodStart = c.end_date && c.end_date >= today ? addDaysIso(c.end_date, 1) : today;
    const periodEnd = addDaysIso(addMonthsIso(periodStart, 12), -1);
    return {
      eligible: true, daysLeft, promoUntil: c.promo_until, code: c.promo_code, currency: c.currency,
      monthly: price, monthlyOff: off, monthlyNet: round2(price - off), months: 12,
      subtotal: round2((price - off) * 12), savings: round2(off * 12), periodStart, periodEnd,
    };
  }

  /* What the customer may see of an invoice: the printed document, not the
     owner's bookkeeping columns. */
  const PRIVATE_INVOICE_KEYS = ["prev_company_end", "prev_company_status", "prev_promo_until", "created_by", "max_users", "max_branches", "accounts_count"];
  const publicInvoice = (i) => {
    const out = { ...i };
    for (const k of PRIVATE_INVOICE_KEYS) delete out[k];
    return out;
  };

  async function companyInvoices(db, companyId) {
    const q = await db.query(
      `${INVOICE_SELECT} WHERE i.company_id = $1 AND i.status <> 'void' ORDER BY i.issue_date DESC, i.id DESC LIMIT 200`,
      [companyId]
    );
    return q.rows;
  }

  /* ---------------- customer ---------------- */

  app.get("/api/my-billing", ...customer, async (req, res) => {
    try {
      const company = await loadCompany(pool, req.companyId);
      if (!company) return res.status(404).json({ ok: false, error: "company_not_found" });
      const invoices = await companyInvoices(pool, req.companyId);
      const proofs = (await pool.query(
        `SELECT id, invoice_id, image_url, amount::float AS amount, reference,
                to_char(paid_on, 'YYYY-MM-DD') AS paid_on, note, status, reject_reason, submitted_by,
                reviewed_at, created_at
           FROM payment_proofs WHERE company_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [req.companyId]
      )).rows;
      const p = (await pool.query(`SELECT * FROM billing_profile ORDER BY id ASC LIMIT 1`)).rows[0] || {};
      const bank = {
        payee: p.legal_name || p.company_name || "INSPECT PRO", bank_name: p.bank_name || "", account_name: p.account_name || "",
        iban: p.iban || "", swift: p.swift || "", phone: p.contact_phone || "", email: p.contact_email || "",
      };
      res.set("Cache-Control", "no-store");
      res.json({
        ok: true, company, invoices: invoices.map(publicInvoice), proofs, bank,
        rateLock: rateLockOf(company, invoices),
      });
    } catch (e) {
      fail(res, e, "GET /api/my-billing");
    }
  });

  app.post("/api/my-billing/proofs", ...customer, async (req, res) => {
    try {
      const b = req.body || {};
      const invoiceId = Number(b.invoice_id);
      if (!(Number.isInteger(invoiceId) && invoiceId > 0)) return res.status(400).json({ ok: false, error: "invoice_required" });
      const imageUrl = String(b.image_url || "").trim();
      if (!PROOF_URL.test(imageUrl) || imageUrl.length > 600) return res.status(400).json({ ok: false, error: "image_required" });
      const amount = Math.round(Number(b.amount) * 100) / 100;
      if (!(amount > 0 && amount < 1e9)) return res.status(400).json({ ok: false, error: "amount_required" });
      const paidOn = isDate(b.paid_on) ? b.paid_on : null;
      if (paidOn && paidOn > addDaysIso(todayIso(), 1)) return res.status(400).json({ ok: false, error: "date_in_future" });
      const reference = String(b.reference || "").trim().slice(0, 120);
      const note = String(b.note || "").trim().slice(0, 500);
      // The browser's OCR reading, for the owner to compare — small, flat, never trusted.
      const o = b.ocr && typeof b.ocr === "object" ? b.ocr : {};
      const ocr = {
        amounts: Array.isArray(o.amounts) ? o.amounts.slice(0, 8).map(Number).filter(Number.isFinite) : [],
        references: Array.isArray(o.references) ? o.references.slice(0, 8).map((x) => String(x).slice(0, 60)) : [],
        dates: Array.isArray(o.dates) ? o.dates.slice(0, 4).map((x) => String(x).slice(0, 10)) : [],
        invoiceNumberSeen: !!o.invoiceNumberSeen,
        text: String(o.text || "").slice(0, 2000),
      };

      const inv = (await pool.query(
        `SELECT id, status, amount::float AS amount FROM invoices WHERE id = $1 AND company_id = $2`,
        [invoiceId, req.companyId]
      )).rows[0];
      if (!inv) return res.status(404).json({ ok: false, error: "invoice_not_found" });
      if (inv.status !== "unpaid") return res.status(409).json({ ok: false, error: "invoice_not_unpaid" });
      const pending = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM payment_proofs WHERE invoice_id = $1 AND status = 'pending'`, [invoiceId]
      )).rows[0].n;
      if (pending >= MAX_PENDING_PER_INVOICE) return res.status(409).json({ ok: false, error: "too_many_pending" });

      const q = await pool.query(
        `INSERT INTO payment_proofs (company_id, invoice_id, image_url, amount, reference, paid_on, note, ocr, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, invoice_id, image_url, amount::float AS amount, reference, to_char(paid_on, 'YYYY-MM-DD') AS paid_on,
                   note, status, reject_reason, submitted_by, created_at`,
        [req.companyId, invoiceId, imageUrl, amount, reference, paidOn, note, JSON.stringify(ocr), String(req.user?.username || "").slice(0, 120)]
      );
      res.status(201).json({ ok: true, proof: q.rows[0] });
    } catch (e) {
      fail(res, e, "POST /api/my-billing/proofs");
    }
  });

  app.delete("/api/my-billing/proofs/:id", ...customer, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ ok: false, error: "bad_id" });
      const q = await pool.query(
        `DELETE FROM payment_proofs WHERE id = $1 AND company_id = $2 AND status = 'pending' RETURNING image_url`,
        [id, req.companyId]
      );
      if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found_or_reviewed" });
      res.json({ ok: true, image_url: q.rows[0].image_url });
    } catch (e) {
      fail(res, e, "DELETE /api/my-billing/proofs");
    }
  });

  app.post("/api/my-billing/rate-lock", ...customer, async (req, res) => {
    try {
      const company = await loadCompany(pool, req.companyId);
      if (!company) return res.status(404).json({ ok: false, error: "company_not_found" });
      const invoices = await companyInvoices(pool, req.companyId);
      const offer = rateLockOf(company, invoices);
      if (offer.reason === "issued") {
        const inv = invoices.find((i) => i.id === offer.invoiceId);
        return res.json({ ok: true, invoice: publicInvoice(inv), already: true });
      }
      if (!offer.eligible) return res.status(409).json({ ok: false, error: `rate_lock_${offer.reason}` });

      const until = new Date(`${offer.periodEnd}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
      const what = company.promo_kind === "aed" ? `AED ${Number(company.promo_amount)} off per branch` : `${Number(company.promo_amount)}% off`;
      // Issued as the platform: the invoice number is unique across every company.
      const invoice = await runAsPlatform(() => issueInvoice({
        companyId: req.companyId,
        issueDate: todayIso(),
        periodStart: offer.periodStart,
        periodEnd: offer.periodEnd,
        lines: [
          { description: `Subscription — ${company.plan_name || "custom"} plan, 12 months (paid annually)`, qty: 12, unit_price: offer.monthly },
          { description: `Promo code ${company.promo_code} — ${what}, rate locked until ${until}`, qty: 12, unit_price: -offer.monthlyOff },
        ],
        notes: `Rate lock: the promo rate continues until ${until} once this invoice is paid.`,
        createdBy: `customer:${String(req.user?.username || "").slice(0, 80)}`,
        kind: "promo_lock",
      }));
      res.status(201).json({ ok: true, invoice: publicInvoice(invoice) });
    } catch (e) {
      fail(res, e, "POST /api/my-billing/rate-lock");
    }
  });

  /* ---------------- owner ---------------- */

  const PROOF_SELECT = `
    SELECT pp.id, pp.company_id, pp.invoice_id, pp.image_url, pp.amount::float AS amount, pp.reference,
           to_char(pp.paid_on, 'YYYY-MM-DD') AS paid_on, pp.note, pp.ocr, pp.status, pp.reject_reason,
           pp.submitted_by, pp.reviewed_by, pp.reviewed_at, pp.created_at,
           c.name AS company_name,
           i.invoice_number, i.amount::float AS invoice_amount, i.currency, i.status AS invoice_status,
           to_char(i.period_end, 'YYYY-MM-DD') AS period_end, i.kind AS invoice_kind
      FROM payment_proofs pp
      JOIN companies c ON c.id = pp.company_id
      JOIN invoices  i ON i.id = pp.invoice_id`;

  app.get("/api/payment-proofs", ...owner, async (req, res) => {
    try {
      const status = ["pending", "accepted", "rejected"].includes(req.query.status) ? req.query.status : req.query.status === "all" ? null : "pending";
      const q = await pool.query(
        `${PROOF_SELECT} ${status ? "WHERE pp.status = $1" : ""} ORDER BY pp.created_at DESC LIMIT 500`,
        status ? [status] : []
      );
      res.json({ ok: true, proofs: q.rows });
    } catch (e) {
      fail(res, e, "GET /api/payment-proofs");
    }
  });

  app.get("/api/payment-proofs/count", ...owner, async (_req, res) => {
    try {
      const q = await pool.query(`SELECT COUNT(*)::int AS n FROM payment_proofs WHERE status = 'pending'`);
      res.json({ ok: true, pending: q.rows[0].n });
    } catch (e) {
      fail(res, e, "GET /api/payment-proofs/count");
    }
  });

  app.post("/api/payment-proofs/:id/accept", ...owner, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ ok: false, error: "bad_id" });
      const b = req.body || {};
      const who = String(req.user?.username || "").slice(0, 120);
      const result = await inTransaction(pool, async (db) => {
        const pr = (await db.query(
          `SELECT id, invoice_id, reference, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, status
             FROM payment_proofs WHERE id = $1 FOR UPDATE`, [id]
        )).rows[0];
        if (!pr) throw Object.assign(new Error("not_found"), { status: 404, code: "not_found" });
        if (pr.status !== "pending") throw Object.assign(new Error("not_pending"), { status: 409, code: "not_pending" });
        const inv = (await db.query(`SELECT status FROM invoices WHERE id = $1`, [pr.invoice_id])).rows[0];
        if (!inv || inv.status === "void") throw Object.assign(new Error("invoice_void"), { status: 409, code: "invoice_void" });
        // Already marked paid by hand: the proof is simply filed against it.
        const extension = inv.status === "unpaid"
          ? await markInvoicePaid(db, pr.invoice_id, {
            paidAt: isDate(b.paid_at) ? b.paid_at : pr.paid_on,
            paymentRef: b.payment_ref != null ? b.payment_ref : pr.reference,
          })
          : null;
        await db.query(`UPDATE payment_proofs SET status='accepted', reviewed_by=$2, reviewed_at=now() WHERE id=$1`, [id, who]);
        await db.query(
          `UPDATE payment_proofs SET status='rejected', reject_reason='Another receipt was accepted for this invoice',
                  reviewed_by=$3, reviewed_at=now()
            WHERE invoice_id=$1 AND id<>$2 AND status='pending'`,
          [pr.invoice_id, id, who]
        );
        return { extension, invoiceId: pr.invoice_id };
      });
      const proof = (await pool.query(`${PROOF_SELECT} WHERE pp.id = $1`, [id])).rows[0];
      const invoice = (await pool.query(`${INVOICE_SELECT} WHERE i.id = $1`, [result.invoiceId])).rows[0];
      res.json({ ok: true, proof, invoice, company: result.extension });
    } catch (e) {
      fail(res, e, "POST /api/payment-proofs/accept");
    }
  });

  app.post("/api/payment-proofs/:id/reject", ...owner, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!(Number.isInteger(id) && id > 0)) return res.status(400).json({ ok: false, error: "bad_id" });
      const reason = String(req.body?.reason || "").trim().slice(0, 500);
      if (!reason) return res.status(400).json({ ok: false, error: "reason_required" });
      const q = await pool.query(
        `UPDATE payment_proofs SET status='rejected', reject_reason=$2, reviewed_by=$3, reviewed_at=now()
          WHERE id=$1 AND status='pending' RETURNING id`,
        [id, reason, String(req.user?.username || "").slice(0, 120)]
      );
      if (!q.rowCount) return res.status(409).json({ ok: false, error: "not_pending" });
      const proof = (await pool.query(`${PROOF_SELECT} WHERE pp.id = $1`, [id])).rows[0];
      res.json({ ok: true, proof });
    } catch (e) {
      fail(res, e, "POST /api/payment-proofs/reject");
    }
  });
};

module.exports.RATE_LOCK_WINDOW_DAYS = RATE_LOCK_WINDOW_DAYS;
