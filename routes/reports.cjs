module.exports = function registerReportsRoutes(app, deps = {}) {
  const { pool, clampInt, normText, isObj, requireAuth, requireAdmin } = deps;

/* Multi-tenant scoping: appends req.user.companyId to `params` and returns
   a bare "company_id = $N" condition to AND into a WHERE clause. Super-admins
   (companyId === null) get "" — unscoped, platform-wide visibility. */
function companyScope(req, params) {
  if (req.user?.isSuperAdmin && req.user.companyId == null) return "";
  params.push(req.user.companyId);
  return `company_id = $${params.length}`;
}

/* ============================================================
   Reports API
============================================================ */
app.get("/api/reports", requireAuth, async (req, res) => {
  try {
    const { type } = req.query;
    const lite = String(req.query?.lite || "").toLowerCase();
    const isLite = lite === "1" || lite === "true" || lite === "yes";
    const limit = clampInt(req.query?.limit, 200, 1, 5000);

    const params = [];
    const conds = [];
    if (type) { params.push(type); conds.push(`type = $${params.length}`); }
    const cs = companyScope(req, params);
    if (cs) conds.push(cs);
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    params.push(limit);
    const limitPh = `$${params.length}`;

    const q = isLite
      ? `
          SELECT
            id,
            reporter,
            type,
            created_at,
            updated_at,
            payload->>'reportDate' AS "reportDate",
            payload->>'invoiceNo'  AS "invoiceNo"
          FROM reports
          ${where}
          ORDER BY created_at DESC
          LIMIT ${limitPh}
        `
      : `SELECT * FROM reports ${where} ORDER BY created_at DESC LIMIT ${limitPh}`;

    const { rows } = await pool.query(q, params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db select failed" });
  }
});

app.post("/api/reports", requireAuth, async (req, res) => {
  try {
    const reporter = normText(req.body?.reporter || "anonymous");
    const type = normText(req.body?.type);
    const payload = req.body?.payload;

    if (!type) return res.status(400).json({ ok: false, error: "type required" });
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload, company_id)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING *`,
      [reporter, type, JSON.stringify(payload), req.user.companyId]
    );

    return res.status(201).json({ ok: true, report: ins.rows[0] });
  } catch (e) {
    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_REPORT_FOR_DATE",
        message: "Report already exists for this type and reportDate.",
      });
    }
    console.error("POST /api/reports ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports", requireAuth, async (req, res) => {
  try {
    const reporter = normText(req.body?.reporter || "anonymous");
    const type = normText(req.body?.type);
    const payload0 = req.body?.payload;

    if (!type) return res.status(400).json({ ok: false, error: "type required" });
    if (!payload0 || typeof payload0 !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const reportDate = normText(payload0?.reportDate || "");
    if (!reportDate) {
      return res.status(400).json({ ok: false, error: "payload.reportDate required" });
    }

    const payload = { ...payload0, reportDate };

    const updParams = [reporter || null, JSON.stringify(payload), type, reportDate];
    const cs = companyScope(req, updParams);
    const whereCompany = cs ? ` AND ${cs}` : "";

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE($1, reporter),
              payload=$2::jsonb,
              updated_at=now()
        WHERE type=$3 AND payload->>'reportDate'=$4${whereCompany}
        RETURNING *`,
      updParams
    );

    if (upd.rowCount > 0) {
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload, company_id)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING *`,
      [reporter, type, JSON.stringify(payload), req.user.companyId]
    );

    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_REPORT_FOR_DATE",
        message: "Report already exists for this type and reportDate.",
      });
    }
    console.error("PUT /api/reports ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/returns", requireAuth, async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { items = [], _clientSavedAt } = req.body || {};

    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });

    const payload = {
      reportDate,
      items: Array.isArray(items) ? items : [],
      _clientSavedAt: _clientSavedAt || Date.now(),
    };

    const updParams = [payload, reportDate];
    const cs = companyScope(req, updParams);
    const whereCompany = cs ? ` AND ${cs}` : "";

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE(reporter,'anonymous'),
              payload=$1::jsonb,
              updated_at=now()
        WHERE type='returns' AND payload->>'reportDate'=$2${whereCompany}
        RETURNING *`,
      updParams
    );

    if (upd.rowCount > 0) return res.json({ ok: true, report: upd.rows[0], method: "update" });

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload,company_id)
       VALUES ('anonymous','returns',$1::jsonb,$2)
       RETURNING *`,
      [payload, req.user.companyId]
    );

    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/returns ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/qcs", requireAuth, async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { details = {}, _clientSavedAt } = req.body || {};
    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });

    const payload = {
      reportDate,
      details: isObj(details) ? details : {},
      _clientSavedAt: _clientSavedAt || Date.now(),
    };

    const updParams = [payload, reportDate];
    const cs = companyScope(req, updParams);
    const whereCompany = cs ? ` AND ${cs}` : "";

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE(reporter,'anonymous'),
              payload=$1::jsonb,
              updated_at=now()
        WHERE type='qcs' AND payload->>'reportDate'=$2${whereCompany}
        RETURNING *`,
      updParams
    );
    if (upd.rowCount > 0) return res.json({ ok: true, report: upd.rows[0], method: "update" });

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload,company_id)
       VALUES ('anonymous','qcs',$1::jsonb,$2)
       RETURNING *`,
      [payload, req.user.companyId]
    );
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/qcs ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/:type([A-Za-z_][A-Za-z0-9_-]*)", requireAuth, async (req, res) => {
  try {
    const type = normText(req.params.type);
    if (!type) return res.status(400).json({ ok: false, error: "type param required" });

    let payload = req.body?.payload;
    if (!payload || typeof payload !== "object") {
      payload = { ...(req.body || {}) };
      delete payload.reporter;
      delete payload.type;
      delete payload.payload;
    }

    const reportDate = normText(payload?.reportDate || req.query?.reportDate || "");
    if (!reportDate) {
      return res.status(400).json({
        ok: false,
        error: "reportDate required (payload.reportDate or ?reportDate=)",
      });
    }

    payload.reportDate = reportDate;
    const reporter = normText(req.body?.reporter || "anonymous");

    const updParams = [reporter || null, JSON.stringify(payload), type, reportDate];
    const cs = companyScope(req, updParams);
    const whereCompany = cs ? ` AND ${cs}` : "";

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE($1, reporter),
              payload=$2::jsonb,
              updated_at=now()
        WHERE type=$3 AND payload->>'reportDate'=$4${whereCompany}
        RETURNING *`,
      updParams
    );

    if (upd.rowCount > 0) {
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload, company_id)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING *`,
      [reporter, type, JSON.stringify(payload), req.user.companyId]
    );

    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/:type ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/reports/:id(\\d+)", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "bad id" });
    }

    const params = [id];
    const cs = companyScope(req, params);
    const whereCompany = cs ? ` AND ${cs}` : "";

    const q = await pool.query(`SELECT * FROM reports WHERE id=$1${whereCompany}`, params);
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not found" });

    return res.json({ ok: true, report: q.rows[0] });
  } catch (e) {
    console.error("GET /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.patch("/api/reports/:id(\\d+)", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad id" });

    const payload = req.body?.payload;
    const reporter = req.body?.reporter;

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const updParams = [JSON.stringify(payload), reporter ? String(reporter) : null, id];
    const cs = companyScope(req, updParams);
    const whereCompany = cs ? ` AND ${cs}` : "";

    const upd = await pool.query(
      `UPDATE reports
          SET payload=$1::jsonb,
              reporter=COALESCE($2, reporter),
              updated_at=now()
        WHERE id=$3${whereCompany}
        RETURNING *`,
      updParams
    );

    if (!upd.rowCount) return res.status(404).json({ ok: false, error: "not found" });
    return res.json({ ok: true, report: upd.rows[0] });
  } catch (e) {
    console.error("PATCH /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/:id(\\d+)", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "bad id" });
    }

    const type = normText(req.body?.type);
    const payload = req.body?.payload;

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const updParams = [type || null, JSON.stringify(payload), id];
    const cs = companyScope(req, updParams);
    const whereCompany = cs ? ` AND ${cs}` : "";

    const upd = await pool.query(
      `UPDATE reports
          SET type = COALESCE(NULLIF($1,''), type),
              payload=$2::jsonb,
              updated_at=now()
        WHERE id=$3${whereCompany}
        RETURNING *`,
      updParams
    );

    if (!upd.rowCount) return res.status(404).json({ ok: false, error: "not found" });
    return res.json({ ok: true, report: upd.rows[0] });
  } catch (e) {
    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_REPORT_FOR_DATE",
        message: "Report already exists for this type and reportDate.",
      });
    }
    console.error("PUT /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/api/reports", requireAdmin, async (req, res) => {
  try {
    const { type, reportDate } = req.query;
    if (!type || !reportDate) return res.status(400).json({ ok: false, error: "type & reportDate required" });

    const params = [type, reportDate];
    const cs = companyScope(req, params);
    const whereCompany = cs ? ` AND ${cs}` : "";

    const { rowCount } = await pool.query(
      `DELETE FROM reports WHERE type=$1 AND payload->>'reportDate'=$2${whereCompany}`,
      params
    );
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/api/reports/:id(\\d+)", requireAdmin, async (req, res) => {
  try {
    const params = [Number(req.params.id)];
    const cs = companyScope(req, params);
    const whereCompany = cs ? ` AND ${cs}` : "";

    const { rowCount } = await pool.query(`DELETE FROM reports WHERE id=$1${whereCompany}`, params);
    if (!rowCount) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
};
