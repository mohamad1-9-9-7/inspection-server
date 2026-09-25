/* ============================================================
   INSPECT PRO quotations — the platform owner's sales documents.

   Deliberately NOT in /api/reports: those rows belong to a tenant company
   (scoped, backed up and audited per company). A quotation is INSPECT PRO
   selling to a company, so it lives in platform_quotations, readable and
   writable by the super-admin only.

   Response shape mirrors a report row ({ id, payload, created_at,
   updated_at }) so the client's quoteFromRecord() reads both unchanged.
============================================================ */
module.exports = function registerQuotationRoutes(app, deps = {}) {
  const { pool, requireAuthStrict, requireSuperAdmin } = deps;

  const refuse = (_req, res) => res.status(403).json({ ok: false, error: "super_admin_required" });
  // Both gates fail CLOSED if not wired in.
  const strict = typeof requireAuthStrict === "function" ? requireAuthStrict : refuse;
  const superOnly = typeof requireSuperAdmin === "function" ? requireSuperAdmin : refuse;
  const gate = [strict, superOnly];

  const NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,39}$/;
  const STATUSES = new Set(["draft", "sent", "accepted", "rejected", "expired"]);
  const SETTINGS_KEYS = new Set(["quotation_config"]);

  const actor = (req) => String(req.user?.username || "").slice(0, 80);

  /* The sortable columns, lifted out of the payload the editor sends.
     Anything malformed falls back to a neutral value rather than failing
     the save: the payload itself is what the editor re-opens. */
  function columnsOf(p) {
    const status = STATUSES.has(p.status) ? p.status : "draft";
    const cid = Number(p.companyId);
    const issue = /^\d{4}-\d{2}-\d{2}$/.test(String(p.issueDate || "")) ? p.issueDate : null;
    const value = Number(p?.totals?.contractValue);
    return {
      status,
      clientCompanyId: Number.isInteger(cid) && cid > 0 ? cid : null,
      clientName: String(p.clientName || "").slice(0, 200),
      issueDate: issue,
      currency: String(p.currency || "AED").slice(0, 8),
      contractValue: Number.isFinite(value) ? value : 0,
    };
  }

  /* Next free Q-YYYY-NNN for the year of `issueDate`. */
  async function nextNumber(db, issueDate) {
    const y = String(issueDate || "").slice(0, 4);
    const year = /^\d{4}$/.test(y) ? y : String(new Date().getFullYear());
    const q = await db.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(number FROM $1) AS INT)), 0) + 1 AS n
         FROM platform_quotations
        WHERE number ~ $2`,
      [`^Q-${year}-(\\d+)$`, `^Q-${year}-\\d+$`]
    );
    return `Q-${year}-${String(q.rows[0].n).padStart(3, "0")}`;
  }

  /* A client company that has since been deleted must not fail the FK. */
  async function liveCompanyId(db, id) {
    if (!id) return null;
    const q = await db.query(`SELECT 1 FROM companies WHERE id = $1`, [id]);
    return q.rowCount ? id : null;
  }

  const rowOut = (r) => ({ id: r.id, payload: r.payload, created_at: r.created_at, updated_at: r.updated_at });

  function payloadOf(req, res) {
    const p = req.body?.payload;
    if (!p || typeof p !== "object" || Array.isArray(p)) {
      res.status(400).json({ ok: false, error: "payload_required" });
      return null;
    }
    const clean = { ...p };
    delete clean.id;
    delete clean.reportDate; // a leftover of the old reports-table storage
    return clean;
  }

  app.get("/api/quotations", ...gate, async (_req, res) => {
    try {
      const q = await pool.query(
        `SELECT id, payload, created_at, updated_at
           FROM platform_quotations
          ORDER BY issue_date DESC NULLS LAST, id DESC
          LIMIT 5000`
      );
      res.json({ ok: true, quotations: q.rows.map(rowOut) });
    } catch (e) {
      console.error("GET /api/quotations ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  app.post("/api/quotations", ...gate, async (req, res) => {
    const p = payloadOf(req, res);
    if (!p) return;
    try {
      const c = columnsOf(p);
      let number = NUMBER_RE.test(String(p.number || "")) ? String(p.number) : await nextNumber(pool, c.issueDate);
      const companyId = await liveCompanyId(pool, c.clientCompanyId);
      /* Two saves racing for the same number: the loser takes the next free
         one instead of failing. Bounded, so a real fault still surfaces. */
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          const q = await pool.query(
            `INSERT INTO platform_quotations
               (number, status, client_company_id, client_name, issue_date, currency,
                contract_value, payload, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             RETURNING id, payload, created_at, updated_at`,
            [number, c.status, companyId, c.clientName, c.issueDate, c.currency,
             c.contractValue, { ...p, number }, actor(req)]
          );
          return res.json({ ok: true, quotation: rowOut(q.rows[0]), renumbered: number !== p.number });
        } catch (e) {
          if (e.code !== "23505") throw e;
          number = await nextNumber(pool, c.issueDate);
        }
      }
      return res.status(409).json({ ok: false, error: "number_taken" });
    } catch (e) {
      console.error("POST /api/quotations ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  app.put("/api/quotations/:id", ...gate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });
    const p = payloadOf(req, res);
    if (!p) return;
    try {
      const c = columnsOf(p);
      const cur = await pool.query(`SELECT number FROM platform_quotations WHERE id = $1`, [id]);
      if (!cur.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
      // The number is the document's identity once issued — an edit keeps it.
      const number = cur.rows[0].number;
      const companyId = await liveCompanyId(pool, c.clientCompanyId);
      const q = await pool.query(
        `UPDATE platform_quotations
            SET status=$1, client_company_id=$2, client_name=$3, issue_date=$4, currency=$5,
                contract_value=$6, payload=$7, updated_at=now()
          WHERE id=$8
          RETURNING id, payload, created_at, updated_at`,
        [c.status, companyId, c.clientName, c.issueDate, c.currency, c.contractValue, { ...p, number }, id]
      );
      res.json({ ok: true, quotation: rowOut(q.rows[0]) });
    } catch (e) {
      console.error("PUT /api/quotations/:id ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  app.delete("/api/quotations/:id", ...gate, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });
    try {
      const q = await pool.query(`DELETE FROM platform_quotations WHERE id = $1 RETURNING id`, [id]);
      if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
      res.json({ ok: true });
    } catch (e) {
      console.error("DELETE /api/quotations/:id ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ── Platform settings: small named JSON blobs (quotation price book,
        defaults, default terms). Whitelisted keys only. ── */

  app.get("/api/platform-settings/:key", ...gate, async (req, res) => {
    const key = String(req.params.key);
    if (!SETTINGS_KEYS.has(key)) return res.status(404).json({ ok: false, error: "unknown_key" });
    try {
      const q = await pool.query(`SELECT value, updated_at FROM platform_settings WHERE key = $1`, [key]);
      res.json({ ok: true, value: q.rows[0]?.value || null, updated_at: q.rows[0]?.updated_at || null });
    } catch (e) {
      console.error("GET /api/platform-settings ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  app.put("/api/platform-settings/:key", ...gate, async (req, res) => {
    const key = String(req.params.key);
    if (!SETTINGS_KEYS.has(key)) return res.status(404).json({ ok: false, error: "unknown_key" });
    const value = req.body?.payload;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return res.status(400).json({ ok: false, error: "payload_required" });
    }
    try {
      const q = await pool.query(
        `INSERT INTO platform_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING value, updated_at`,
        [key, value, actor(req)]
      );
      res.json({ ok: true, value: q.rows[0].value, updated_at: q.rows[0].updated_at });
    } catch (e) {
      console.error("PUT /api/platform-settings ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });
};
