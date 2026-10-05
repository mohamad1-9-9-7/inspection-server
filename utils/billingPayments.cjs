/* ============================================================
   Invoice payment state — ONE implementation for every way an invoice
   becomes paid: the owner's "Mark as paid" (PATCH /api/invoices/:id) and
   accepting a customer's payment proof (routes/myBilling.cjs).

   Paying an invoice keeps the company's subscription running to the end of
   the period it paid for:
     • companies.end_date moves to the invoice's period_end when that is
       later (never backwards), and a company on trial / expired becomes
       active;
     • a "rate lock" invoice (kind = 'promo_lock', see myBilling.cjs) also
       carries the company's promo discount on to its period_end.
   What changed is written on the invoice, so "it was not paid" can put the
   company back exactly — unless something has moved it again since (a
   later payment, or the owner by hand), in which case it is left alone.

   Every function takes a client INSIDE an open transaction.
============================================================ */

const isoToday = () => new Date().toISOString().slice(0, 10);
const asDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "").slice(0, 10)) ? String(v).slice(0, 10) : null);

/* The invoice fields the payment logic needs, dates as plain text. */
async function loadForPayment(db, id) {
  const q = await db.query(
    `SELECT id, status, company_id, kind,
            to_char(period_end, 'YYYY-MM-DD')       AS period_end,
            to_char(extended_to, 'YYYY-MM-DD')      AS extended_to,
            to_char(prev_company_end, 'YYYY-MM-DD') AS prev_company_end,
            prev_company_status,
            to_char(promo_extended_to, 'YYYY-MM-DD') AS promo_extended_to,
            to_char(prev_promo_until, 'YYYY-MM-DD')  AS prev_promo_until
       FROM invoices WHERE id = $1 FOR UPDATE`,
    [id]
  );
  return q.rows[0] || null;
}

async function extendForPayment(db, inv) {
  if (!inv.company_id || !inv.period_end) return null;
  const c = (await db.query(
    `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date, status, promo_code,
            to_char(promo_until, 'YYYY-MM-DD') AS promo_until
       FROM companies WHERE id = $1 FOR UPDATE`,
    [inv.company_id]
  )).rows[0];
  if (!c) return null;
  let out = null;

  if (!c.end_date || c.end_date < inv.period_end) {
    const status = ["trial", "expired"].includes(c.status) ? "active" : c.status;
    await db.query(`UPDATE companies SET end_date=$2, status=$3, updated_at=now() WHERE id=$1`,
      [inv.company_id, inv.period_end, status]);
    await db.query(
      `UPDATE invoices SET extended_to=$2, prev_company_end=$3, prev_company_status=$4 WHERE id=$1`,
      [inv.id, inv.period_end, c.end_date || null, c.status]
    );
    out = { from: c.end_date || null, to: inv.period_end, status };
  }

  // A paid rate lock keeps the promo discount for the year it paid for.
  if (inv.kind === "promo_lock" && c.promo_code && (!c.promo_until || c.promo_until < inv.period_end)) {
    await db.query(`UPDATE companies SET promo_until=$2, updated_at=now() WHERE id=$1`, [inv.company_id, inv.period_end]);
    await db.query(`UPDATE invoices SET promo_extended_to=$2, prev_promo_until=$3 WHERE id=$1`,
      [inv.id, inv.period_end, c.promo_until || null]);
    out = { ...(out || { from: c.end_date || null, to: c.end_date || null, status: c.status }), promoUntil: inv.period_end };
  }
  return out;
}

async function undoPaymentExtension(db, inv) {
  if (!inv.company_id || (!inv.extended_to && !inv.promo_extended_to)) return null;
  await db.query(
    `UPDATE invoices SET extended_to=NULL, prev_company_end=NULL, prev_company_status=NULL,
                         promo_extended_to=NULL, prev_promo_until=NULL
      WHERE id=$1`,
    [inv.id]
  );
  const c = (await db.query(
    `SELECT to_char(end_date, 'YYYY-MM-DD') AS end_date, status,
            to_char(promo_until, 'YYYY-MM-DD') AS promo_until
       FROM companies WHERE id = $1 FOR UPDATE`,
    [inv.company_id]
  )).rows[0];
  if (!c) return null;
  let out = null;
  if (inv.extended_to && c.end_date === inv.extended_to) {
    const status = inv.prev_company_status || c.status;
    await db.query(`UPDATE companies SET end_date=$2, status=$3, updated_at=now() WHERE id=$1`,
      [inv.company_id, inv.prev_company_end || null, status]);
    out = { from: inv.extended_to, to: inv.prev_company_end || null, status };
  }
  if (inv.promo_extended_to && c.promo_until === inv.promo_extended_to) {
    await db.query(`UPDATE companies SET promo_until=$2, updated_at=now() WHERE id=$1`,
      [inv.company_id, inv.prev_promo_until || null]);
    out = { ...(out || {}), promoUntil: inv.prev_promo_until || null };
  }
  return out;
}

/* unpaid → paid. Throws { code: 'not_found' | 'not_unpaid' }. */
async function markInvoicePaid(db, id, { paidAt, paymentRef } = {}) {
  const inv = await loadForPayment(db, id);
  if (!inv) throw Object.assign(new Error("not_found"), { code: "not_found", status: 404 });
  if (inv.status !== "unpaid") throw Object.assign(new Error("not_unpaid"), { code: "not_unpaid", status: 409 });
  await db.query(`UPDATE invoices SET status='paid', paid_at=$2, payment_ref=$3 WHERE id=$1`,
    [id, asDate(paidAt) || isoToday(), String(paymentRef || "").slice(0, 120)]);
  return extendForPayment(db, inv);
}

/* paid → unpaid ("it was not paid"). Throws { code: 'not_found' | 'not_paid' }. */
async function markInvoiceUnpaid(db, id) {
  const inv = await loadForPayment(db, id);
  if (!inv) throw Object.assign(new Error("not_found"), { code: "not_found", status: 404 });
  if (inv.status !== "paid") throw Object.assign(new Error("not_paid"), { code: "not_paid", status: 409 });
  await db.query(`UPDATE invoices SET status='unpaid', paid_at=NULL, payment_ref='' WHERE id=$1`, [id]);
  // A proof that was accepted for this payment is no longer the reason it is paid.
  await db.query(
    `UPDATE payment_proofs SET status='pending', reviewed_by='', reviewed_at=NULL WHERE invoice_id=$1 AND status='accepted'`,
    [id]
  );
  return undoPaymentExtension(db, inv);
}

/* Run fn(client) in one transaction on a fresh pool client. */
async function inTransaction(pool, fn) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const out = await fn(db);
    await db.query("COMMIT");
    return out;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}

module.exports = { markInvoicePaid, markInvoiceUnpaid, inTransaction };
