module.exports = function registerReportsRoutes(app, deps = {}) {
  const { pool, clampInt, normText, isObj, requireAuth, makeLimiter } = deps;

  // Fallback no-op if the middleware wasn't wired in (keeps routes working
  // on an older deps shape); real enforcement comes from utils/requireAuth.
  const auth = typeof requireAuth === "function" ? requireAuth : (_req, _res, next) => next();

  /* A single `?type=X&limit=5000` read can return several MB, so this is by
     far the most expensive route to leave unmetered — one scraper looping it
     is enough to blow through a month of bandwidth. The cap is per IP and
     generous enough that a whole branch office behind one NAT address never
     reaches it during normal use. Note this bounds the damage but does not
     close the hole: until REQUIRE_AUTH=on, these reads are still anonymous. */
  const readLimiter =
    typeof makeLimiter === "function"
      ? makeLimiter({ max: 120, windowMs: 60_000, name: "reports-read" })
      : (_req, _res, next) => next();

  // Liveness probes (server wake-up banner + ServerHealth tool) only care
  // whether the process responds — they must NOT query the DB (would wake
  // Neon out of autosuspend) AND must skip auth (they carry no token).
  const pingBypass = (req, res, next) => {
    const t = req.query?.type;
    if (t === "__ping__" || t === "__health_probe__") return res.json([]);
    next();
  };

/* ============================================================
   Reference numbers  (AM-CND-000142)
   ------------------------------------------------------------
   One continuous counter per report type, never reset, so a
   reference identifies a record for all time. The counter is
   bumped with a single atomic UPSERT, which means two concurrent
   saves can never be handed the same number.

   Add a type here and it starts getting references — nothing
   else in the app needs to change.
============================================================ */
const REF_PREFIX = {
  destruction_record: "CND",
  returns:            "RET",
  returns_customers:  "CRT",
};

const REF_PAD = 6;

function hasRef(payload) {
  return !!(payload && typeof payload.refNo === "string" && payload.refNo.trim());
}

/** Bump the counter for `type` and return the next reference, or null if the
 *  type isn't reference-tracked. `q` is a pool or a transaction client. */
async function allocRef(q, type) {
  const prefix = REF_PREFIX[type];
  if (!prefix) return null;

  const { rows } = await q.query(
    `INSERT INTO report_counters (type, last)
     VALUES ($1, 1)
     ON CONFLICT (type) DO UPDATE
       SET last = report_counters.last + 1, updated_at = now()
     RETURNING last`,
    [type]
  );

  return `AM-${prefix}-${String(rows[0].last).padStart(REF_PAD, "0")}`;
}

/** Stamp a reference onto a payload that is about to be INSERTed.
 *  Never overwrites one the caller already supplied (restore / import). */
async function stampRef(q, type, payload) {
  if (!REF_PREFIX[type] || hasRef(payload)) return payload;
  const refNo = await allocRef(q, type);
  return refNo ? { ...payload, refNo } : payload;
}

/* An UPDATE replaces the whole payload, and clients happily PUT payloads that
   predate references — so re-merge the stored refNo whenever the row has one.
   Used as the SET expression everywhere payload is overwritten; $N is the
   incoming payload parameter. */
const KEEP_REF = (p) => `
  CASE WHEN payload ? 'refNo'
       THEN ${p}::jsonb || jsonb_build_object('refNo', payload->'refNo')
       ELSE ${p}::jsonb
  END`;

/* ============================================================
   Audit trail (report_audit table)
   ------------------------------------------------------------
   Every UPDATE/DELETE on reports is recorded with full before/
   after payloads: who (token username, else reporter), when, and
   what changed. Fire-and-forget — an audit failure must never
   fail or slow down the save itself. No-op saves (identical
   payload) are skipped so autosaves don't flood the log.
============================================================ */

/** JSON.stringify with recursively sorted object keys, so two payloads
 *  compare equal regardless of key order (jsonb from PG is key-sorted,
 *  fresh client objects are not). */
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k]))
      .join(",") +
    "}"
  );
}

function samePayload(a, b) {
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    return false;
  }
}

function auditUser(req) {
  const u = req.user || {};
  const name = String(u.username || req.body?.reporter || "").trim();
  return name || "unknown";
}

function auditIp(req) {
  return (
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

/** Fire-and-forget audit insert. `action` is 'update' | 'delete'. */
function auditWrite(req, { action, reportId, reportType, oldPayload, newPayload }) {
  if (action === "update" && samePayload(oldPayload, newPayload)) return;
  pool
    .query(
      `INSERT INTO report_audit
         (report_id, report_type, action, username, old_payload, new_payload, route, ip_addr)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [
        reportId ?? null,
        String(reportType || ""),
        action,
        auditUser(req),
        oldPayload == null ? null : JSON.stringify(oldPayload),
        newPayload == null ? null : JSON.stringify(newPayload),
        `${req.method} ${req.originalUrl || req.url || ""}`.slice(0, 300),
        auditIp(req),
      ]
    )
    .catch((e) => console.warn("[audit] insert failed:", e?.message || e));
}

/* Types that are pure lookup/dictionary rows (vehicle numbers, driver names…)
   or internal probes: high volume, zero compliance value. Their CREATEs are
   not logged. Edits/deletes on them still are. */
const AUDIT_SKIP_CREATE = /(^__)|lookup/i;

/** Log a record creation.
 *  Metadata only — the created payload still lives in `reports`, so storing a
 *  second full copy would roughly double the database for no extra evidence.
 *  If the record is later edited or deleted, THOSE entries carry the full
 *  before-state, so nothing is lost. We keep just enough here (reportDate,
 *  refNo) to make the audit row readable on its own. */
function auditCreate(req, row) {
  if (!row || AUDIT_SKIP_CREATE.test(String(row.type || ""))) return;
  const p = row.payload || {};
  auditWrite(req, {
    action: "create",
    reportId: row.id,
    reportType: row.type,
    oldPayload: null,
    newPayload: { reportDate: p.reportDate ?? null, refNo: p.refNo ?? null },
  });
}

/** Fetch the current row for a (type, reportDate) pair — used to capture
 *  the "old" payload before an upsert-style UPDATE overwrites it. */
async function fetchOldByTypeDate(type, reportDate) {
  try {
    const q = await pool.query(
      `SELECT id, payload FROM reports WHERE type=$1 AND payload->>'reportDate'=$2 LIMIT 1`,
      [type, reportDate]
    );
    return q.rows[0] || null;
  } catch {
    return null;
  }
}

/** Same, by numeric id. */
async function fetchOldById(id) {
  try {
    const q = await pool.query(`SELECT id, type, payload FROM reports WHERE id=$1`, [id]);
    return q.rows[0] || null;
  } catch {
    return null;
  }
}

/* ============================================================
   Reports API  (all routes gated by `auth` — audit or enforce
   depending on REQUIRE_AUTH; ping probes bypass via pingBypass)
============================================================ */
app.get("/api/reports", pingBypass, readLimiter, auth, async (req, res) => {
  try {
    const { type } = req.query;

    const lite = String(req.query?.lite || "").toLowerCase();
    const isLite = lite === "1" || lite === "true" || lite === "yes";
    const limit = clampInt(req.query?.limit, 200, 1, 5000);

    const truthy = (v) => ["1", "true", "yes"].includes(String(v || "").toLowerCase());

    // `?type=X&dates=1` — the calendar of a report type: one { id, reportDate }
    // per record, no payload and no LIMIT. A few hundred date strings weigh
    // nothing, while `SELECT *` on the same rows drags every JSON payload across
    // the wire. Backs the Date Tree; the id lets the client then fetch exactly
    // the record the user clicked via GET /api/reports/:id.
    //
    // Callers send `&lite=1&limit=5000` alongside, so a server that predates
    // this branch still answers with the same { id, reportDate } shape.
    if (truthy(req.query?.dates) && type) {
      const { rows } = await pool.query(
        `SELECT id, payload->>'reportDate' AS "reportDate"
           FROM reports
          WHERE type = $1 AND payload->>'reportDate' IS NOT NULL
          ORDER BY payload->>'reportDate' DESC, created_at DESC`,
        [type]
      );
      return res.json({ ok: true, data: rows });
    }

    // `?type=X&reportDate=YYYY-MM-DD` — the one record the user opened.
    // Hits ux_reports_type_reportdate directly.
    const reportDate = normText(req.query?.reportDate || "");
    if (type && reportDate) {
      const { rows } = await pool.query(
        `SELECT * FROM reports
          WHERE type = $1 AND payload->>'reportDate' = $2
          ORDER BY created_at DESC
          LIMIT 1`,
        [type, reportDate]
      );
      return res.json({ ok: true, data: rows });
    }

    let q = "";
    let params = [];

    if (isLite) {
      if (type) {
        q = `
          SELECT
            id,
            reporter,
            type,
            created_at,
            updated_at,
            payload->>'reportDate' AS "reportDate",
            payload->>'invoiceNo'  AS "invoiceNo"
          FROM reports
          WHERE type = $1
          ORDER BY created_at DESC
          LIMIT $2
        `;
        params = [type, limit];
      } else {
        q = `
          SELECT
            id,
            reporter,
            type,
            created_at,
            updated_at,
            payload->>'reportDate' AS "reportDate",
            payload->>'invoiceNo'  AS "invoiceNo"
          FROM reports
          ORDER BY created_at DESC
          LIMIT $1
        `;
        params = [limit];
      }
    } else {
      if (type) {
        q = `SELECT * FROM reports WHERE type=$1 ORDER BY created_at DESC LIMIT $2`;
        params = [type, limit];
      } else {
        q = `SELECT * FROM reports ORDER BY created_at DESC LIMIT $1`;
        params = [limit];
      }
    }

    const { rows } = await pool.query(q, params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db select failed" });
  }
});

app.post("/api/reports", auth, async (req, res) => {
  try {
    const reporter = normText(req.body?.reporter || "anonymous");
    const type = normText(req.body?.type);
    const payload = req.body?.payload;

    if (!type) return res.status(400).json({ ok: false, error: "type required" });
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const stamped = await stampRef(pool, type, payload);

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [reporter, type, JSON.stringify(stamped)]
    );

    auditCreate(req, ins.rows[0]);
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

app.put("/api/reports", auth, async (req, res) => {
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

    const old = await fetchOldByTypeDate(type, reportDate);

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE($1, reporter),
              payload=${KEEP_REF("$2")},
              updated_at=now()
        WHERE type=$3 AND payload->>'reportDate'=$4
        RETURNING *`,
      [reporter || null, JSON.stringify(payload), type, reportDate]
    );

    if (upd.rowCount > 0) {
      auditWrite(req, {
        action: "update",
        reportId: upd.rows[0].id,
        reportType: type,
        oldPayload: old?.payload ?? null,
        newPayload: upd.rows[0].payload,
      });
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const stamped = await stampRef(pool, type, payload);

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [reporter, type, JSON.stringify(stamped)]
    );

    auditCreate(req, ins.rows[0]);
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

app.put("/api/reports/returns", auth, async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { items = [], _clientSavedAt } = req.body || {};

    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });

    const payload = {
      reportDate,
      items: Array.isArray(items) ? items : [],
      _clientSavedAt: _clientSavedAt || Date.now(),
    };

    const old = await fetchOldByTypeDate("returns", reportDate);

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE(reporter,'anonymous'),
              payload=${KEEP_REF("$1")},
              updated_at=now()
        WHERE type='returns' AND payload->>'reportDate'=$2
        RETURNING *`,
      [payload, reportDate]
    );

    if (upd.rowCount > 0) {
      auditWrite(req, {
        action: "update",
        reportId: upd.rows[0].id,
        reportType: "returns",
        oldPayload: old?.payload ?? null,
        newPayload: upd.rows[0].payload,
      });
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload)
       VALUES ('anonymous','returns',$1::jsonb)
       RETURNING *`,
      [await stampRef(pool, "returns", payload)]
    );

    auditCreate(req, ins.rows[0]);
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/returns ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/qcs", auth, async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { details = {}, _clientSavedAt } = req.body || {};
    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });

    const payload = {
      reportDate,
      details: isObj(details) ? details : {},
      _clientSavedAt: _clientSavedAt || Date.now(),
    };

    const old = await fetchOldByTypeDate("qcs", reportDate);

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE(reporter,'anonymous'),
              payload=${KEEP_REF("$1")},
              updated_at=now()
        WHERE type='qcs' AND payload->>'reportDate'=$2
        RETURNING *`,
      [payload, reportDate]
    );
    if (upd.rowCount > 0) {
      auditWrite(req, {
        action: "update",
        reportId: upd.rows[0].id,
        reportType: "qcs",
        oldPayload: old?.payload ?? null,
        newPayload: upd.rows[0].payload,
      });
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload)
       VALUES ('anonymous','qcs',$1::jsonb)
       RETURNING *`,
      [await stampRef(pool, "qcs", payload)]
    );
    auditCreate(req, ins.rows[0]);
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/qcs ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/:type([A-Za-z_][A-Za-z0-9_-]*)", auth, async (req, res) => {
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

    const old = await fetchOldByTypeDate(type, reportDate);

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE($1, reporter),
              payload=${KEEP_REF("$2")},
              updated_at=now()
        WHERE type=$3 AND payload->>'reportDate'=$4
        RETURNING *`,
      [reporter || null, JSON.stringify(payload), type, reportDate]
    );

    if (upd.rowCount > 0) {
      auditWrite(req, {
        action: "update",
        reportId: upd.rows[0].id,
        reportType: type,
        oldPayload: old?.payload ?? null,
        newPayload: upd.rows[0].payload,
      });
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const stamped = await stampRef(pool, type, payload);

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [reporter, type, JSON.stringify(stamped)]
    );

    auditCreate(req, ins.rows[0]);
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/:type ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ============================================================
   POST /api/reports/backfill-refs?type=returns[&dryRun=1]
   ------------------------------------------------------------
   Gives every pre-existing record of a type a reference number.
   Numbers are handed out in created_at order (oldest first), so
   the sequence matches the order records entered the system.

   Safe to re-run: records that already carry a refNo are skipped
   and do not consume a number. `dryRun=1` reports exactly what
   would be written without touching anything.
============================================================ */
app.post("/api/reports/backfill-refs", auth, async (req, res) => {
  const type = normText(req.query?.type || req.body?.type || "");
  const truthy = (v) => ["1", "true", "yes"].includes(String(v || "").toLowerCase());
  const dryRun = truthy(req.query?.dryRun ?? req.body?.dryRun);

  if (!type) return res.status(400).json({ ok: false, error: "type required" });
  if (!REF_PREFIX[type]) {
    return res.status(400).json({
      ok: false,
      error: "TYPE_NOT_REF_TRACKED",
      message: `'${type}' has no reference prefix. Known: ${Object.keys(REF_PREFIX).join(", ")}`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the counter row first so a concurrent save can't interleave.
    await client.query(
      `INSERT INTO report_counters (type, last) VALUES ($1, 0)
       ON CONFLICT (type) DO NOTHING`,
      [type]
    );
    await client.query(`SELECT last FROM report_counters WHERE type=$1 FOR UPDATE`, [type]);

    const { rows } = await client.query(
      `SELECT id,
              created_at,
              payload->>'reportDate' AS "reportDate",
              payload->>'refNo'      AS "refNo"
         FROM reports
        WHERE type = $1
        ORDER BY created_at ASC, id ASC`,
      [type]
    );

    const pending = rows.filter((r) => !r.refNo);
    const assigned = [];

    for (const row of pending) {
      const refNo = await allocRef(client, type);
      assigned.push({ id: row.id, reportDate: row.reportDate, refNo });

      if (!dryRun) {
        await client.query(
          `UPDATE reports
              SET payload = payload || jsonb_build_object('refNo', $1::text),
                  updated_at = now()
            WHERE id = $2`,
          [refNo, row.id]
        );
      }
    }

    if (dryRun) await client.query("ROLLBACK");
    else await client.query("COMMIT");

    return res.json({
      ok: true,
      type,
      dryRun,
      total: rows.length,
      alreadyHadRef: rows.length - pending.length,
      assigned: assigned.length,
      preview: assigned.slice(0, 200),
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /api/reports/backfill-refs ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

app.get("/api/reports/:id(\\d+)", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "bad id" });
    }

    const q = await pool.query(`SELECT * FROM reports WHERE id=$1`, [id]);
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not found" });

    return res.json({ ok: true, report: q.rows[0] });
  } catch (e) {
    console.error("GET /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.patch("/api/reports/:id(\\d+)", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad id" });

    const payload = req.body?.payload;
    const reporter = req.body?.reporter;

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const old = await fetchOldById(id);

    const upd = await pool.query(
      `UPDATE reports
          SET payload=${KEEP_REF("$1")},
              reporter=COALESCE($2, reporter),
              updated_at=now()
        WHERE id=$3
        RETURNING *`,
      [JSON.stringify(payload), reporter ? String(reporter) : null, id]
    );

    if (!upd.rowCount) return res.status(404).json({ ok: false, error: "not found" });
    auditWrite(req, {
      action: "update",
      reportId: id,
      reportType: upd.rows[0].type,
      oldPayload: old?.payload ?? null,
      newPayload: upd.rows[0].payload,
    });
    return res.json({ ok: true, report: upd.rows[0] });
  } catch (e) {
    console.error("PATCH /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/:id(\\d+)", auth, async (req, res) => {
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

    const old = await fetchOldById(id);

    const upd = await pool.query(
      `UPDATE reports
          SET type = COALESCE(NULLIF($1,''), type),
              payload=${KEEP_REF("$2")},
              updated_at=now()
        WHERE id=$3
        RETURNING *`,
      [type || null, JSON.stringify(payload), id]
    );

    if (!upd.rowCount) return res.status(404).json({ ok: false, error: "not found" });
    auditWrite(req, {
      action: "update",
      reportId: id,
      reportType: upd.rows[0].type,
      oldPayload: old?.payload ?? null,
      newPayload: upd.rows[0].payload,
    });
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

app.delete("/api/reports", auth, async (req, res) => {
  try {
    const { type, reportDate } = req.query;
    if (!type || !reportDate) return res.status(400).json({ ok: false, error: "type & reportDate required" });

    const del = await pool.query(
      `DELETE FROM reports WHERE type=$1 AND payload->>'reportDate'=$2 RETURNING id, type, payload`,
      [type, reportDate]
    );
    del.rows.forEach((row) =>
      auditWrite(req, {
        action: "delete",
        reportId: row.id,
        reportType: row.type,
        oldPayload: row.payload,
        newPayload: null,
      })
    );
    res.json({ ok: true, deleted: del.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/api/reports/:id(\\d+)", auth, async (req, res) => {
  try {
    const del = await pool.query(
      `DELETE FROM reports WHERE id=$1 RETURNING id, type, payload`,
      [Number(req.params.id)]
    );
    if (!del.rowCount) return res.status(404).json({ ok: false, error: "not found" });
    auditWrite(req, {
      action: "delete",
      reportId: del.rows[0].id,
      reportType: del.rows[0].type,
      oldPayload: del.rows[0].payload,
      newPayload: null,
    });
    res.json({ ok: true, deleted: del.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
};
