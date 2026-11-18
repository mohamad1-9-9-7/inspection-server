/* ============================================================
   /api/alerts — the app's bell and the Alerts page.

   GET  /api/alerts?status=open|ack|resolved|all&limit=100   the list
   GET  /api/alerts/count                                     { open, critical } (the bell badge)
   POST /api/alerts/:id/ack                                   "seen, I'm on it"
   POST /api/alerts/ack-all                                   every open one of the company
   GET  /api/alerts/rules                                     the company rules (defaults filled in)
   PUT  /api/alerts/rules                    admin            save them
   POST /api/alerts/run                      admin            run the scheduled checks now
   POST /api/alerts/test-mail                admin            one test e-mail
   POST /api/alerts/send-now                 admin            the real reminders, now (all, body.branch or body.email)
   GET  /api/alerts/log                                       the send log (email_history, alerts:*)

   Always the caller's own company (utils/tenant.cjs companyOf). The engine
   itself is utils/alertEngine.cjs.
============================================================ */
const { companyOf, userOf } = require("../utils/tenant.cjs");
const engine = require("../utils/alertEngine.cjs");
const { canonBranch } = require("../utils/branchCanon.cjs");

const isAdmin = (req) => {
  const u = userOf(req) || {};
  return !!(u.isAdmin || u.isSuperAdmin);
};

module.exports = function registerAlertRoutes(app, deps = {}) {
  const { pool, requireAuthStrict } = deps;
  const strict = typeof requireAuthStrict === "function" ? requireAuthStrict : (req, res, next) => next();

  app.get("/api/alerts", strict, async (req, res) => {
    const companyId = companyOf(req);
    const status = String(req.query?.status || "open");
    const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 100));
    const params = [companyId, limit];
    let where = "COALESCE(company_id, 1) = COALESCE($1::int, 1)";
    if (status === "open") where += " AND status = 'open'";
    else if (status === "ack") where += " AND status = 'ack'";
    else if (status === "resolved") where += " AND status = 'resolved'";
    else if (status === "active") where += " AND status <> 'resolved'";
    const { rows } = await pool.query(
      `SELECT id, rule, severity, branch, title, body, link, status, data, created_at, ack_at, ack_by, resolved_at, emailed_at
         FROM alerts WHERE ${where}
        ORDER BY (status = 'open') DESC, (severity = 'critical') DESC, created_at DESC
        LIMIT $2`,
      params
    );
    res.json({ ok: true, data: rows });
  });

  app.get("/api/alerts/count", strict, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS open, COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical
         FROM alerts WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND status = 'open'`,
      [companyOf(req)]
    );
    res.json({ ok: true, ...rows[0] });
  });

  app.post("/api/alerts/:id/ack", strict, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });
    const who = String(userOf(req)?.username || req.body?.by || "").slice(0, 80);
    const { rows } = await pool.query(
      `UPDATE alerts SET status = 'ack', ack_at = now(), ack_by = $3,
              data = data || jsonb_build_object('ackNote', $4::text)
        WHERE id = $1 AND COALESCE(company_id, 1) = COALESCE($2::int, 1) AND status = 'open'
        RETURNING id, status, ack_at, ack_by`,
      [id, companyOf(req), who, String(req.body?.note || "").slice(0, 500)]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: "not_open" });
    res.json({ ok: true, alert: rows[0] });
  });

  app.post("/api/alerts/ack-all", strict, async (req, res) => {
    const who = String(userOf(req)?.username || "").slice(0, 80);
    const { rowCount } = await pool.query(
      `UPDATE alerts SET status = 'ack', ack_at = now(), ack_by = $2
        WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND status = 'open'`,
      [companyOf(req), who]
    );
    res.json({ ok: true, count: rowCount });
  });

  app.get("/api/alerts/rules", strict, async (req, res) => {
    const companyId = companyOf(req);
    const rules = await engine.loadRules(pool, companyId);
    /* The branch names alerts really carry (alerts of the last year + the
       licences register), so a recipient is routed by the exact same text. */
    const { rows } = await pool.query(
      `SELECT DISTINCT b FROM (
         SELECT NULLIF(TRIM(branch), '') AS b FROM alerts
          WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND created_at > now() - interval '365 days'
         UNION
         SELECT NULLIF(TRIM(payload->>'branch'), '') FROM reports
          WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND type = 'licenses_contracts'
       ) x WHERE b IS NOT NULL ORDER BY b LIMIT 200`,
      [companyId]
    ).catch(() => ({ rows: [] }));
    /* The same shop is typed many ways ("POS 15", "AL BARSHA BUTCHERY (POS15)",
       "Al Barsha Butchery"): one entry per canonical branch, its spellings kept. */
    const groups = new Map();
    for (const { b } of rows) {
      const key = canonBranch(b);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key).add(b);
    }
    const branchGroups = [...groups].map(([key, names]) => ({ key, names: [...names].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    res.json({ ok: true, rules, branches: branchGroups.map((g) => g.key), branchGroups, mailbox: engine._companyMayMail(companyId) });
  });

  /* A test e-mail to one address — checks the recipient before relying on it. */
  app.post("/api/alerts/test-mail", strict, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "admin_required" });
    const companyId = companyOf(req);
    const to = String(req.body?.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ ok: false, error: "bad_email" });
    if (!engine._companyMayMail(companyId)) return res.status(409).json({ ok: false, error: "no_mailbox" });
    const sent = await engine.sendTestMail(to, {
      name: String(req.body?.name || "").slice(0, 80),
      branches: Array.isArray(req.body?.branches) ? req.body.branches.slice(0, 60).map((b) => String(b).slice(0, 80)) : [],
    }, { pool, companyId, sentBy: String(userOf(req)?.username || "") }).catch(() => false);
    if (!sent) return res.status(502).json({ ok: false, error: "send_failed" });
    res.json({ ok: true });
  });

  /* Send the reminders NOW — the real ones (everything expiring / expired
     today, details + documents), to every recipient or to one (body.email).
     Uses the SAVED rules: save the page first. */
  app.post("/api/alerts/send-now", strict, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "admin_required" });
    const companyId = companyOf(req);
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ ok: false, error: "bad_email" });
    try {
      const branch = String(req.body?.branch || "").slice(0, 120);
      const r = await engine.sendRemindersNow(pool, companyId, { email, branch, sentBy: String(userOf(req)?.username || "") });
      if (!r.ok) return res.status(409).json(r);
      res.json(r);
    } catch (e) {
      console.warn("[alerts] send-now failed:", e?.message || e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* The send log of the alerts: the E-mail Center's email_history rows whose
     report_type starts with "alerts:" (scheduled, manual and test mails). */
  app.get("/api/alerts/log", strict, async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query?.limit) || 200));
    const { rows } = await pool.query(
      `SELECT id, sent_at, sent_by, report_type, subject, to_emails, cc_emails, bcc_emails, method, attachment_count, note, status
         FROM email_history
        WHERE company_id = COALESCE($1::int, 1) AND report_type LIKE 'alerts:%'
        ORDER BY id DESC LIMIT $2`,
      [companyOf(req), limit]
    ).catch(() => ({ rows: [] }));
    res.json({ ok: true, data: rows });
  });

  app.put("/api/alerts/rules", strict, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "admin_required" });
    const companyId = companyOf(req);
    const rules = engine.mergeRules(req.body?.rules);
    const payload = { reportDate: "config", rules, updatedBy: String(userOf(req)?.username || ""), updatedAt: new Date().toISOString() };
    const cur = await pool.query(
      `SELECT id FROM reports WHERE COALESCE(company_id, 1) = COALESCE($1::int, 1) AND type = $2 AND payload->>'reportDate' = 'config' ORDER BY id DESC LIMIT 1`,
      [companyId, engine.RULES_TYPE]
    );
    if (cur.rows.length) {
      await pool.query(`UPDATE reports SET payload = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(payload), cur.rows[0].id]);
    } else {
      await pool.query(
        `INSERT INTO reports (reporter, type, payload, company_id) VALUES ($1, $2, $3::jsonb, $4)`,
        [payload.updatedBy || "alerts", engine.RULES_TYPE, JSON.stringify(payload), companyId]
      );
    }
    res.json({ ok: true, rules });
  });

  /* Run the scheduled checks now (an admin testing the rules). `first`
     false = only the "no reading yet today" check, like the midday slot. */
  app.post("/api/alerts/run", strict, async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "admin_required" });
    const created = await engine.runCompanyChecks(pool, companyOf(req), { first: req.body?.first !== false });
    res.json({ ok: true, created: created.length, data: created });
  });
};
