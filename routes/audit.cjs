// routes/audit.cjs
// Admin-only reader for the report_audit trail (who edited/deleted what,
// when, old payload → new payload). Writes happen in routes/reports.cjs.
//
// UNLIKE the reports routes, this endpoint ALWAYS requires a valid token
// with isAdmin/isSuperAdmin — regardless of the REQUIRE_AUTH audit/enforce
// toggle — because the trail exposes full payload history across companies.

module.exports = function registerAuditRoutes(app, deps = {}) {
  const { pool, clampInt, normText, verifyToken, tokenFromReq } = deps;

  function requireAdmin(req, res, next) {
    const raw = typeof tokenFromReq === "function" ? tokenFromReq(req) : null;
    const payload = raw && typeof verifyToken === "function" ? verifyToken(raw) : null;

    if (!payload) return res.status(401).json({ ok: false, error: "auth_required" });
    if (!payload.isAdmin && !payload.isSuperAdmin) {
      return res.status(403).json({ ok: false, error: "admin_only" });
    }

    req.user = payload;
    next();
  }

  /* GET /api/audit
     ?action=update|delete  ?type=<report_type>  ?username=<name>
     ?from=YYYY-MM-DD  ?to=YYYY-MM-DD  ?reportId=<id>
     ?limit=100 (max 500)  ?offset=0
     Rows newest-first; `total` is the filtered count for pagination. */
  app.get("/api/audit", requireAdmin, async (req, res) => {
    try {
      const action = normText(req.query.action || "");
      const type = normText(req.query.type || "");
      const username = normText(req.query.username || "");
      const from = normText(req.query.from || "");
      const to = normText(req.query.to || "");
      const reportId = Number(req.query.reportId);

      const limit = clampInt(req.query.limit, 100, 1, 500);
      const offset = clampInt(req.query.offset, 0, 0, 1_000_000);

      const where = [];
      const params = [];
      const add = (sql, val) => {
        params.push(val);
        where.push(sql.replace("?", `$${params.length}`));
      };

      if (action === "update" || action === "delete") add(`action = ?`, action);
      if (type) add(`report_type = ?`, type);
      if (username) add(`username ILIKE ?`, `%${username}%`);
      if (from) add(`created_at >= ?::date`, from);
      if (to) add(`created_at < (?::date + INTERVAL '1 day')`, to);
      if (Number.isFinite(reportId) && reportId > 0) add(`report_id = ?`, reportId);

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      params.push(limit, offset);
      const q = await pool.query(
        `SELECT id, report_id, report_type, action, username,
                old_payload, new_payload, route, ip_addr, created_at,
                COUNT(*) OVER() AS _total
           FROM report_audit
           ${whereSql}
          ORDER BY created_at DESC, id DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      );

      const total = q.rows.length ? Number(q.rows[0]._total) : 0;
      const rows = q.rows.map(({ _total, ...r }) => r);

      return res.json({ ok: true, total, rows });
    } catch (e) {
      console.error("GET /api/audit ERROR =", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /* GET /api/audit/types — distinct report types present in the trail,
     for the filter dropdown. */
  app.get("/api/audit/types", requireAdmin, async (_req, res) => {
    try {
      const q = await pool.query(
        `SELECT report_type, COUNT(*)::int AS n
           FROM report_audit
          GROUP BY report_type
          ORDER BY n DESC, report_type`
      );
      return res.json({ ok: true, types: q.rows });
    } catch (e) {
      console.error("GET /api/audit/types ERROR =", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
};
