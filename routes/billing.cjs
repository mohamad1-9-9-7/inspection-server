module.exports = function registerBillingRoutes(app, deps = {}) {
  const { pool, requireAuth, requireAdmin } = deps;

/* ============================================================
   PLANS — CRUD
============================================================ */

app.get("/api/plans", requireAuth, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM plans ORDER BY price ASC`);
    res.json({ ok: true, plans: q.rows });
  } catch (e) {
    console.error("GET /api/plans ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/plans", requireAdmin, async (req, res) => {
  try {
    const { name, price, currency, max_branches, max_users, description } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    const q = await pool.query(
      `INSERT INTO plans (name, price, currency, max_branches, max_users, description)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, price || 0, currency || "USD", max_branches ?? -1, max_users ?? -1, description || ""]
    );
    res.json({ ok: true, plan: q.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ ok: false, error: "name_taken" });
    console.error("POST /api/plans ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.put("/api/plans/:id", requireAdmin, async (req, res) => {
  try {
    const { name, price, currency, max_branches, max_users, description, is_active } = req.body;
    const q = await pool.query(
      `UPDATE plans SET name=$1, price=$2, currency=$3, max_branches=$4, max_users=$5,
         description=$6, is_active=$7, updated_at=now()
       WHERE id=$8 RETURNING *`,
      [name, price, currency || "USD", max_branches ?? -1, max_users ?? -1,
       description || "", is_active !== false, req.params.id]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, plan: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/plans/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.delete("/api/plans/:id", requireAdmin, async (req, res) => {
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

app.get("/api/companies", requireAuth, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT c.*, p.name AS plan_name, p.price AS plan_price, p.currency AS plan_currency
      FROM companies c
      LEFT JOIN plans p ON p.id = c.plan_id
      ORDER BY c.created_at ASC
    `);
    res.json({ ok: true, companies: q.rows });
  } catch (e) {
    console.error("GET /api/companies ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/companies", requireAdmin, async (req, res) => {
  try {
    const { name, contact_name, contact_email, contact_phone, plan_id, status, start_date, end_date, notes } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    const q = await pool.query(
      `INSERT INTO companies (name, contact_name, contact_email, contact_phone, plan_id, status, start_date, end_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, contact_name||"", contact_email||"", contact_phone||"",
       plan_id||null, status||"active", start_date||null, end_date||null, notes||""]
    );
    res.json({ ok: true, company: q.rows[0] });
  } catch (e) {
    console.error("POST /api/companies ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.put("/api/companies/:id", requireAdmin, async (req, res) => {
  try {
    const { name, contact_name, contact_email, contact_phone, plan_id, status, start_date, end_date, notes } = req.body;
    const q = await pool.query(
      `UPDATE companies SET name=$1, contact_name=$2, contact_email=$3, contact_phone=$4,
         plan_id=$5, status=$6, start_date=$7, end_date=$8, notes=$9, updated_at=now()
       WHERE id=$10 RETURNING *`,
      [name, contact_name||"", contact_email||"", contact_phone||"",
       plan_id||null, status||"active", start_date||null, end_date||null, notes||"", req.params.id]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, company: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/companies/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.delete("/api/companies/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM companies WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/companies/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   SUBSCRIPTION — Get / Update
============================================================ */

/* GET /api/subscription */
app.get("/api/subscription", requireAuth, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM subscription ORDER BY id DESC LIMIT 1`);
    res.json({ ok: true, subscription: q.rows[0] || null });
  } catch (e) {
    console.error("GET /api/subscription ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* PUT /api/subscription  { plan, status, start_date, end_date, price, currency, notes, updated_by } */
app.put("/api/subscription", requireAdmin, async (req, res) => {
  try {
    const { plan, status, start_date, end_date, price, currency, notes, updated_by } = req.body;
    /* Ensure a row exists */
    await pool.query(`
      INSERT INTO subscription (plan, status, start_date, end_date, notes, updated_by)
      SELECT 'enterprise','active', CURRENT_DATE, CURRENT_DATE + 365, '', 'system'
      WHERE NOT EXISTS (SELECT 1 FROM subscription LIMIT 1)
    `);
    const q = await pool.query(
      `UPDATE subscription SET
         plan=$1, status=$2, start_date=$3, end_date=$4,
         price=$5, currency=$6, notes=$7, updated_by=$8, updated_at=now()
       WHERE id=(SELECT id FROM subscription ORDER BY id DESC LIMIT 1)
       RETURNING *`,
      [plan || "enterprise", status || "active", start_date, end_date,
       price || null, currency || "USD", notes || "", updated_by || "admin"]
    );
    res.json({ ok: true, subscription: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/subscription ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   BILLING PROFILE — single-row buyer info (Get / Update)
============================================================ */

app.get("/api/billing-profile", requireAuth, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM billing_profile ORDER BY id ASC LIMIT 1`);
    res.json({ ok: true, profile: q.rows[0] || null });
  } catch (e) {
    console.error("GET /api/billing-profile ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.put("/api/billing-profile", requireAdmin, async (req, res) => {
  try {
    const { company_name, company_address, tax_id, contact_email, contact_phone, notes } = req.body;
    /* Ensure a row exists */
    await pool.query(`
      INSERT INTO billing_profile (company_name)
      SELECT '' WHERE NOT EXISTS (SELECT 1 FROM billing_profile LIMIT 1)
    `);
    const q = await pool.query(
      `UPDATE billing_profile SET
         company_name=$1, company_address=$2, tax_id=$3,
         contact_email=$4, contact_phone=$5, notes=$6, updated_at=now()
       WHERE id=(SELECT id FROM billing_profile ORDER BY id ASC LIMIT 1)
       RETURNING *`,
      [company_name || "", company_address || "", tax_id || "",
       contact_email || "", contact_phone || "", notes || ""]
    );
    res.json({ ok: true, profile: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/billing-profile ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   INVOICES — list / get / create (immutable snapshots)
============================================================ */

app.get("/api/invoices", requireAuth, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM invoices ORDER BY id DESC LIMIT 500`);
    res.json({ ok: true, invoices: q.rows });
  } catch (e) {
    console.error("GET /api/invoices ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/invoices/:id", requireAuth, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM invoices WHERE id=$1`, [req.params.id]);
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, invoice: q.rows[0] });
  } catch (e) {
    console.error("GET /api/invoices/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/invoices", requireAdmin, async (req, res) => {
  try {
    const {
      issue_date, period_start, period_end,
      company_name, company_address, tax_id,
      plan_name, accounts_count, branches_count, max_branches, max_users,
      amount, currency, notes, created_by,
    } = req.body;

    /* Generate INV-YYYY-NNNN — sequence resets per year, padded to 4 digits */
    const year = new Date(issue_date || Date.now()).getFullYear();
    const seqQ = await pool.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '\\d+$') AS INT)), 0) + 1 AS next_seq
         FROM invoices
        WHERE invoice_number LIKE $1`,
      [`INV-${year}-%`]
    );
    const seq = String(seqQ.rows[0].next_seq).padStart(4, "0");
    const invoice_number = `INV-${year}-${seq}`;

    const q = await pool.query(
      `INSERT INTO invoices (
         invoice_number, issue_date, period_start, period_end,
         company_name, company_address, tax_id,
         plan_name, accounts_count, branches_count, max_branches, max_users,
         amount, currency, notes, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       ) RETURNING *`,
      [
        invoice_number,
        issue_date || new Date(),
        period_start || null,
        period_end || null,
        company_name || "",
        company_address || "",
        tax_id || "",
        plan_name || "",
        accounts_count || 0,
        branches_count || 0,
        max_branches ?? null,
        max_users ?? null,
        amount || 0,
        currency || "USD",
        notes || "",
        created_by || "admin",
      ]
    );
    res.json({ ok: true, invoice: q.rows[0] });
  } catch (e) {
    console.error("POST /api/invoices ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});
};
