module.exports = function registerEmailHistoryRoutes(app, deps = {}) {
  const { pool, requireAuth, requireAdmin } = deps;

/* ════════════════════════════════════════════════════════════
   EMAIL HISTORY — log + list + stats + cleanup
═════════════════════════════════════════════════════════════ */

/* Log a single email send. Called by the frontend after each successful send. */
app.post("/api/email-history", requireAuth, async (req, res) => {
  try {
    const f = req.body || {};
    const toEmails  = Array.isArray(f.to_emails)  ? f.to_emails  : [];
    const ccEmails  = Array.isArray(f.cc_emails)  ? f.cc_emails  : [];
    const bccEmails = Array.isArray(f.bcc_emails) ? f.bcc_emails : [];
    const recipient_count = toEmails.length + ccEmails.length + bccEmails.length;
    const q = await pool.query(
      `INSERT INTO email_history (
         sent_by, report_type, report_title, report_date,
         subject, to_emails, cc_emails, bcc_emails, recipient_count,
         classification, priority, method, attachment_count, note,
         template_id, status
       ) VALUES (
         $1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16
       ) RETURNING id, sent_at`,
      [
        String(f.sent_by || "").slice(0, 100),
        String(f.report_type || "").slice(0, 100),
        String(f.report_title || "").slice(0, 200),
        f.report_date || null,
        String(f.subject || "").slice(0, 500),
        JSON.stringify(toEmails),
        JSON.stringify(ccEmails),
        JSON.stringify(bccEmails),
        recipient_count,
        String(f.classification || "internal").slice(0, 20),
        String(f.priority || "normal").slice(0, 10),
        String(f.method || "outlook").slice(0, 20),
        Number(f.attachment_count) || 0,
        String(f.note || "").slice(0, 2000),
        f.template_id ? String(f.template_id).slice(0, 100) : null,
        String(f.status || "sent").slice(0, 20),
      ]
    );
    res.json({ ok: true, id: q.rows[0].id, sent_at: q.rows[0].sent_at });
  } catch (e) {
    console.error("POST /api/email-history ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* List with filters. All filters optional. Pagination via limit + before_id cursor. */
app.get("/api/email-history", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
    const where = [];
    const params = [];
    if (req.query.report_type) {
      params.push(req.query.report_type);
      where.push(`report_type = $${params.length}`);
    }
    if (req.query.sent_by) {
      params.push(req.query.sent_by);
      where.push(`sent_by = $${params.length}`);
    }
    if (req.query.classification) {
      params.push(req.query.classification);
      where.push(`classification = $${params.length}`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      where.push(`sent_at >= $${params.length}::timestamptz`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      where.push(`sent_at <= $${params.length}::timestamptz`);
    }
    if (req.query.search) {
      params.push("%" + String(req.query.search).toLowerCase() + "%");
      where.push(`(LOWER(subject) LIKE $${params.length} OR LOWER(to_emails::text) LIKE $${params.length} OR LOWER(cc_emails::text) LIKE $${params.length})`);
    }
    if (req.query.before_id) {
      params.push(parseInt(req.query.before_id) || 0);
      where.push(`id < $${params.length}`);
    }
    const sql = `SELECT * FROM email_history ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`;
    const q = await pool.query(sql, params);
    res.json({ ok: true, logs: q.rows, hasMore: q.rows.length === limit });
  } catch (e) {
    console.error("GET /api/email-history ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* Aggregated stats for the Analytics dashboard. Returns last `days` (default 30). */
app.get("/api/email-history/stats", requireAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

    const [summary, byType, byClass, dailyTrend, topRecipients, topSenders] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)                                              AS total,
          COUNT(*) FILTER (WHERE sent_at >= now() - INTERVAL '${days} days') AS recent,
          COUNT(*) FILTER (WHERE sent_at >= now() - INTERVAL '1 day')        AS today,
          COUNT(DISTINCT sent_by)                               AS unique_senders,
          SUM(recipient_count) FILTER (WHERE sent_at >= now() - INTERVAL '${days} days') AS total_recipients_recent,
          SUM(attachment_count) FILTER (WHERE sent_at >= now() - INTERVAL '${days} days') AS total_attachments_recent,
          COUNT(*) FILTER (WHERE method='outlook'  AND sent_at >= now() - INTERVAL '${days} days') AS method_outlook,
          COUNT(*) FILTER (WHERE method='whatsapp' AND sent_at >= now() - INTERVAL '${days} days') AS method_whatsapp,
          COUNT(*) FILTER (WHERE method='copy'     AND sent_at >= now() - INTERVAL '${days} days') AS method_copy
        FROM email_history
      `),
      pool.query(`
        SELECT report_type, COUNT(*)::int AS count
        FROM email_history
        WHERE sent_at >= now() - INTERVAL '${days} days'
        GROUP BY report_type
        ORDER BY count DESC
        LIMIT 20
      `),
      pool.query(`
        SELECT classification, COUNT(*)::int AS count
        FROM email_history
        WHERE sent_at >= now() - INTERVAL '${days} days'
        GROUP BY classification
        ORDER BY count DESC
      `),
      pool.query(`
        SELECT DATE(sent_at)::text AS day, COUNT(*)::int AS count
        FROM email_history
        WHERE sent_at >= now() - INTERVAL '${days} days'
        GROUP BY day
        ORDER BY day ASC
      `),
      pool.query(`
        SELECT email, COUNT(*)::int AS count
        FROM (
          SELECT jsonb_array_elements_text(to_emails) AS email FROM email_history
          WHERE sent_at >= now() - INTERVAL '${days} days'
          UNION ALL
          SELECT jsonb_array_elements_text(cc_emails) FROM email_history
          WHERE sent_at >= now() - INTERVAL '${days} days'
        ) AS r
        WHERE email IS NOT NULL AND email <> ''
        GROUP BY email
        ORDER BY count DESC
        LIMIT 10
      `),
      pool.query(`
        SELECT sent_by, COUNT(*)::int AS count
        FROM email_history
        WHERE sent_at >= now() - INTERVAL '${days} days' AND sent_by <> ''
        GROUP BY sent_by
        ORDER BY count DESC
        LIMIT 10
      `),
    ]);

    res.json({
      ok: true,
      days,
      summary: summary.rows[0],
      byType: byType.rows,
      byClass: byClass.rows,
      dailyTrend: dailyTrend.rows,
      topRecipients: topRecipients.rows,
      topSenders: topSenders.rows,
    });
  } catch (e) {
    console.error("GET /api/email-history/stats ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* Delete a single log entry (admin housekeeping). */
app.delete("/api/email-history/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM email_history WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/email-history/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* Bulk cleanup: delete entries older than `before` (YYYY-MM-DD). Manual only. */
app.delete("/api/email-history", requireAdmin, async (req, res) => {
  try {
    const before = req.query.before;
    if (!before) return res.status(400).json({ ok: false, error: "before_required" });
    const q = await pool.query(`DELETE FROM email_history WHERE sent_at < $1::timestamptz`, [before]);
    res.json({ ok: true, deleted: q.rowCount });
  } catch (e) {
    console.error("DELETE /api/email-history ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});
};
