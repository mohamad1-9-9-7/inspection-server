// routes/audit.cjs
// Admin-only reader for the report_audit trail (who created/edited/deleted
// what, when, old payload → new payload). Writes happen in routes/reports.cjs.
//
// UNLIKE the reports routes, these endpoints ALWAYS require a valid token
// with isAdmin/isSuperAdmin — regardless of the REQUIRE_AUTH audit/enforce
// toggle — because the trail exposes full payload history across companies.

module.exports = function registerAuditRoutes(app, deps = {}) {
  const { pool, clampInt, normText, verifyToken, tokenFromReq } = deps;

  // All timestamps are stored UTC; auditors read them in local business time.
  const TZ = "Asia/Dubai";

  // Business hours used by the "off-hours" suspicion flag.
  const WORK_START = 6;   // 06:00 inclusive
  const WORK_END = 20;    // 20:00 exclusive

  // An edit/delete landing this many days after the record's own reportDate
  // is treated as a back-dated change — the single strongest audit red flag.
  const BACKDATE_DAYS = 7;

  // Same account making more than this many changes inside 5 minutes.
  const BULK_THRESHOLD = 10;

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

  /** Build the shared WHERE clause from query filters.
   *  Returns { sql, params } — params are positional starting at $1. */
  function buildWhere(query) {
    const action = normText(query.action || "");
    const type = normText(query.type || "");
    const username = normText(query.username || "");
    const from = normText(query.from || "");
    const to = normText(query.to || "");
    const q = normText(query.q || "");
    const reportId = Number(query.reportId);

    const where = [];
    const params = [];
    const add = (sql, val) => {
      params.push(val);
      where.push(sql.replace("?", `$${params.length}`));
    };

    if (["create", "update", "delete"].includes(action)) add(`action = ?`, action);
    if (type) add(`report_type = ?`, type);
    if (username) add(`username ILIKE ?`, `%${username}%`);
    if (from) add(`created_at >= ?::date`, from);
    if (to) add(`created_at < (?::date + INTERVAL '1 day')`, to);
    if (Number.isFinite(reportId) && reportId > 0) add(`report_id = ?`, reportId);

    // Free-text search across BOTH payload snapshots — "who changed a
    // temperature to 9.4?" is answered by searching the raw JSON text.
    if (q) {
      params.push(`%${q}%`);
      const p = `$${params.length}`;
      where.push(
        `(coalesce(old_payload::text,'') ILIKE ${p}
          OR coalesce(new_payload::text,'') ILIKE ${p}
          OR report_type ILIKE ${p}
          OR username ILIKE ${p})`
      );
    }

    return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  /* SQL expressions computing each suspicion flag. Kept in one place so the
     list endpoint and the stats endpoint can never disagree. */
  const FLAG_SQL = `
    (action = 'delete') AS f_delete,

    (
      COALESCE(new_payload->>'reportDate', old_payload->>'reportDate') ~ '^\\d{4}-\\d{2}-\\d{2}$'
      AND (created_at AT TIME ZONE '${TZ}')::date
          - (COALESCE(new_payload->>'reportDate', old_payload->>'reportDate'))::date
          > ${BACKDATE_DAYS}
    ) AS f_backdated,

    (
      EXTRACT(hour FROM created_at AT TIME ZONE '${TZ}') < ${WORK_START}
      OR EXTRACT(hour FROM created_at AT TIME ZONE '${TZ}') >= ${WORK_END}
      OR EXTRACT(dow  FROM created_at AT TIME ZONE '${TZ}') IN (0, 6)
    ) AS f_offhours,

    (
      COUNT(*) OVER (
        PARTITION BY username
        ORDER BY created_at
        RANGE BETWEEN INTERVAL '5 minutes' PRECEDING AND CURRENT ROW
      ) > ${BULK_THRESHOLD}
    ) AS f_bulk
  `;

  /* GET /api/audit
     Filters: action, type, username, from, to, reportId, q (value search),
              suspicious=1 (only flagged rows)
     Paging:  limit (max 500), offset
     Each row carries the four suspicion flags computed server-side, so the
     filter works across the WHOLE dataset, not just the loaded page. */
  app.get("/api/audit", requireAdmin, async (req, res) => {
    try {
      const { sql: whereSql, params } = buildWhere(req.query);
      const suspiciousOnly = String(req.query.suspicious || "") === "1";

      const limit = clampInt(req.query.limit, 100, 1, 500);
      const offset = clampInt(req.query.offset, 0, 0, 1_000_000);

      params.push(limit, offset);
      const pLimit = `$${params.length - 1}`;
      const pOffset = `$${params.length}`;

      const sql = `
        WITH base AS (
          SELECT id, report_id, report_type, action, username,
                 old_payload, new_payload, route, ip_addr, created_at,
                 ${FLAG_SQL}
            FROM report_audit
            ${whereSql}
        )
        SELECT *, COUNT(*) OVER() AS _total
          FROM base
         ${suspiciousOnly ? `WHERE (f_delete OR f_backdated OR f_offhours OR f_bulk)` : ``}
         ORDER BY created_at DESC, id DESC
         LIMIT ${pLimit} OFFSET ${pOffset}
      `;

      const q = await pool.query(sql, params);
      const total = q.rows.length ? Number(q.rows[0]._total) : 0;

      const rows = q.rows.map(({ _total, f_delete, f_backdated, f_offhours, f_bulk, ...r }) => ({
        ...r,
        flags: {
          deleted: !!f_delete,
          backdated: !!f_backdated,
          offHours: !!f_offhours,
          bulk: !!f_bulk,
        },
      }));

      return res.json({ ok: true, total, rows });
    } catch (e) {
      console.error("GET /api/audit ERROR =", e);
      return res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  /* GET /api/audit/stats — aggregates for the charts. Honours the same
     filters as the list, so the charts always describe what you're looking at.
     Computed over the FULL filtered set, not just the current page. */
  app.get("/api/audit/stats", requireAdmin, async (req, res) => {
    try {
      const { sql: whereSql, params } = buildWhere(req.query);
      const days = clampInt(req.query.days, 30, 7, 180);

      const base = `
        WITH base AS (
          SELECT id, report_type, action, username, created_at,
                 old_payload, new_payload,
                 ${FLAG_SQL}
            FROM report_audit
            ${whereSql}
        )
      `;

      const [daily, users, types, flags] = await Promise.all([
        pool.query(
          // to_char, not ::date — a bare date comes back as a JS Date and the
          // driver re-interprets it in the machine's timezone, shifting the
          // day by one. A text label cannot be shifted.
          `${base}
           SELECT to_char((created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day,
                  COUNT(*) FILTER (WHERE action='create')::int AS creates,
                  COUNT(*) FILTER (WHERE action='update')::int AS updates,
                  COUNT(*) FILTER (WHERE action='delete')::int AS deletes
             FROM base
            WHERE created_at > now() - INTERVAL '${days} days'
            GROUP BY 1 ORDER BY 1`,
          params
        ),
        pool.query(
          `${base}
           SELECT username,
                  COUNT(*)::int AS n,
                  COUNT(*) FILTER (WHERE action='delete')::int AS deletes
             FROM base GROUP BY 1 ORDER BY n DESC LIMIT 8`,
          params
        ),
        pool.query(
          `${base}
           SELECT report_type, COUNT(*)::int AS n
             FROM base GROUP BY 1 ORDER BY n DESC LIMIT 8`,
          params
        ),
        pool.query(
          `${base}
           SELECT COUNT(*) FILTER (WHERE f_delete)::int    AS deletes,
                  COUNT(*) FILTER (WHERE f_backdated)::int AS backdated,
                  COUNT(*) FILTER (WHERE f_offhours)::int  AS offhours,
                  COUNT(*) FILTER (WHERE f_bulk)::int      AS bulk,
                  COUNT(*) FILTER (WHERE f_delete OR f_backdated OR f_offhours OR f_bulk)::int AS any_flag,
                  COUNT(*)::int AS total
             FROM base`,
          params
        ),
      ]);

      return res.json({
        ok: true,
        days,
        daily: daily.rows,
        topUsers: users.rows,
        topTypes: types.rows,
        flags: flags.rows[0] || {},
      });
    } catch (e) {
      console.error("GET /api/audit/stats ERROR =", e);
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
