/* ============================================================
   Self-service free trial — started from the public /demo page.

     POST /api/trial/start   PUBLIC  create a trial company + its admin, sign in

   What one sign-up creates, in ONE transaction:
     • a company of its own (companies.is_trial = true, status 'trial',
       end_date = today + TRIAL_DAYS - 1, so today counts as day 1) on the kit system that fits the
       visitor's business (SECTOR_KIT below — meat never opens the Al Mawashi
       system, which carries that customer's own branches and headers);
     • one admin account in that company only (username = the phone digits);
     • a lead in demo_requests (status 'trial'), so the owner sees it in
       Platform Center → Demo requests and can call.
   The answer has the same shape as POST /api/auth/login, so the page signs
   the visitor straight in. The page then fills the company with demo records
   through the normal /api/reports routes, as that account.

   Locking needs nothing new: a company whose end_date has passed is refused
   at login and by the in-app lock (routes/admin.cjs, routes/billing.cjs).

   Nothing in a trial is kept. The visitor must tick that they understand
   (`accept`), the app shows it on every screen, and TRIAL_GRACE_DAYS after
   the end date the sweep below erases the company with everything in it
   (utils/deleteCompany.cjs). A customer who subscribes gets a NEW company
   from the Platform Center; the trial is never converted.

   Abuse limits: 5 attempts a day per IP, one trial per phone number (ever —
   checked against the leads table, which outlives the erased company), and
   at most TRIAL_DAILY_CAP trials a day platform-wide (env, default 40).
   A trial account cannot e-mail (mailbox = MAIL_COMPANY_IDS only) and cannot
   create accounts or touch its own dates (those routes are super-admin only).
============================================================ */
const { sendPlatformMail } = require("./mailer.cjs");
const { eraseCompany } = require("../utils/deleteCompany.cjs");

const TRIAL_DAYS = 3;
const TRIAL_GRACE_DAYS = 3;
const SWEEP_EVERY_MS = 6 * 60 * 60_000;

/* /demo sector → the kit system the trial runs (frontend: industries/catalog.js). */
const SECTOR_KIT = {
  restaurant: "restaurant",
  kitchen: "restaurant",
  retail: "retail",
  meat: "retail",
  distribution: "warehouse",
  factory: "factory",
  sweets: "factory",
};

module.exports = function registerTrialRoutes(app, deps = {}) {
  const { pool, genSalt, hashPw, signToken, makeLimiter, clientIp } = deps;

  const startLimiter = typeof makeLimiter === "function"
    ? makeLimiter({ max: 5, windowMs: 24 * 60 * 60_000, name: "trial-start" })
    : (_req, _res, next) => next();
  const dailyCap = Math.max(0, Number(process.env.TRIAL_DAILY_CAP) || 40);

  // eslint-disable-next-line no-control-regex
  const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);
  const isEmail = (s) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(s);
  const ipOf = (req) => (typeof clientIp === "function" ? clientIp(req) : req.ip || "");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  app.post("/api/trial/start", startLimiter, async (req, res) => {
    const b = req.body || {};
    const d = {
      companyName: clean(b.companyName, 120),
      contactName: clean(b.contactName, 120),
      phone: clean(b.phone, 40),
      email: clean(b.email, 160),
      sector: clean(b.sector, 30),
      lang: b.lang === "ar" ? "ar" : "en",
      source: clean(b.source, 50),
    };
    const password = String(b.password || "");
    const digits = d.phone.replace(/\D/g, "");

    if (!d.companyName || !d.contactName || !d.phone) return res.status(400).json({ ok: false, error: "required" });
    if (digits.length < 7 || digits.length > 15) return res.status(400).json({ ok: false, error: "bad_phone" });
    if (d.email && !isEmail(d.email)) return res.status(400).json({ ok: false, error: "bad_email" });
    if (password.length < 8 || password.length > 100) return res.status(400).json({ ok: false, error: "weak_password" });
    if (!SECTOR_KIT[d.sector]) return res.status(400).json({ ok: false, error: "bad_sector" });
    // The visitor ticked "I understand nothing in a trial is kept".
    if (b.accept !== true) return res.status(400).json({ ok: false, error: "not_accepted" });

    let client;
    try {
      const seen = await pool.query(
        `SELECT 1 FROM demo_requests
          WHERE source LIKE 'trial%' AND regexp_replace(phone, '\\D', '', 'g') = $1 LIMIT 1`,
        [digits]
      );
      if (seen.rowCount) return res.status(409).json({ ok: false, error: "trial_used" });

      if (dailyCap) {
        const today = await pool.query(
          `SELECT COUNT(*)::int AS n FROM companies WHERE is_trial AND created_at > now() - interval '1 day'`
        );
        if (today.rows[0].n >= dailyCap) return res.status(503).json({ ok: false, error: "trial_full" });
      }

      // Username = the phone digits; a clash with an existing account gets a suffix.
      let username = digits;
      for (let i = 2; i < 20; i += 1) {
        const taken = await pool.query(`SELECT 1 FROM app_users WHERE username = $1`, [username]);
        if (!taken.rowCount) break;
        username = `${digits}-${i}`;
      }

      const kit = SECTOR_KIT[d.sector];
      const salt = genSalt();
      const hash = hashPw(password, salt);

      client = await pool.connect();
      await client.query("BEGIN");
      const company = (await client.query(
        `INSERT INTO companies (name, contact_name, contact_email, contact_phone, status,
                                start_date, end_date, notes, industry, module, branches, is_trial)
         VALUES ($1, $2, $3, $4, 'trial', CURRENT_DATE, CURRENT_DATE + $5::int - 1, $6, $7, $7, 1, true)
         RETURNING id, name, status, industry, module,
                   to_char(start_date, 'YYYY-MM-DD') AS start_date,
                   to_char(end_date,   'YYYY-MM-DD') AS end_date`,
        [d.companyName, d.contactName, d.email, d.phone, TRIAL_DAYS,
         `Self-service ${TRIAL_DAYS}-day trial from /demo (business: ${d.sector}). Erased ${TRIAL_GRACE_DAYS} days after it ends.`, kit]
      )).rows[0];
      const user = (await client.query(
        `INSERT INTO app_users (username, display_name, password_hash, salt, permissions, crud_perms,
                                employees, allowed_branches, is_admin, company_id)
         VALUES ($1, $2, $3, $4, '["*"]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, true, $5)
         RETURNING id, username, display_name, permissions, crud_perms, employees, allowed_branches`,
        [username, d.contactName, hash, salt, company.id]
      )).rows[0];
      await client.query(
        `INSERT INTO demo_requests (status, company_name, activity, contact_name, phone, email, message, source, lang, ip)
         VALUES ('trial', $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [d.companyName, d.sector, d.contactName, d.phone, d.email,
         `Started a ${TRIAL_DAYS}-day free trial — company #${company.id}, ends ${company.end_date}.`,
         `trial${d.source ? `:${d.source}` : ""}`.slice(0, 60), d.lang, ipOf(req)]
      );
      await client.query("COMMIT");

      const token = typeof signToken === "function"
        ? signToken({ uid: user.id, username: user.username, isAdmin: true, isSuperAdmin: false, companyId: company.id })
        : "";
      res.json({
        ok: true,
        token,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          permissions: user.permissions,
          crudPerms: user.crud_perms,
          employees: user.employees,
          allowedBranches: user.allowed_branches || [],
          isAdmin: true,
          isSuperAdmin: false,
          lastLogin: null,
          companyId: company.id,
          company: {
            id: company.id,
            name: company.name,
            status: company.status,
            startDate: company.start_date,
            endDate: company.end_date,
            industry: company.industry,
            module: company.module,
            planName: null,
            isTrial: true,
          },
        },
      });
      notifyOwner(d, company);
    } catch (e) {
      if (client) { try { await client.query("ROLLBACK"); } catch { /* already gone */ } }
      console.error("POST /api/trial/start ERROR:", e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "server_error" });
    } finally {
      if (client) client.release();
    }
  });

  function notifyOwner(d, company) {
    const to = String(process.env.DEMO_NOTIFY_EMAIL || process.env.MAIL_USER || process.env.SMTP_USER || "").trim();
    if (!to) return;
    const lines = [
      ["Company", d.companyName], ["Business type", d.sector], ["Contact", d.contactName],
      ["Phone", d.phone], ["E-mail", d.email], ["Source", d.source],
      ["Trial", `company #${company.id}, ends ${company.end_date}`],
    ].filter(([, v]) => v);
    sendPlatformMail({
      to,
      subject: `New free trial: ${d.companyName}`,
      text: lines.map(([k, v]) => `${k}: ${v}`).join("\n"),
      html:
        `<h2 style="font-family:sans-serif;color:#0f766e">New free trial</h2>` +
        `<table style="font-family:sans-serif;border-collapse:collapse">` +
        lines.map(([k, v]) =>
          `<tr><td style="padding:4px 14px 4px 0;color:#64748b"><b>${esc(k)}</b></td><td style="padding:4px 0">${esc(v)}</td></tr>`).join("") +
        `</table>`,
    }).catch((e) => console.warn("[trial] owner mail:", e?.message || e));
  }

  /* ── The sweep: erase trials TRIAL_GRACE_DAYS after their end date ── */
  async function sweepExpiredTrials() {
    try {
      const due = await pool.query(
        `SELECT id, name FROM companies
          WHERE is_trial AND id > 1 AND end_date IS NOT NULL
            AND end_date < CURRENT_DATE - $1::int`,
        [TRIAL_GRACE_DAYS]
      );
      for (const row of due.rows) {
        try {
          const out = await eraseCompany(pool, Number(row.id));
          if (out) console.warn(`[trial] erased expired trial company ${row.id} "${row.name}":`, out.counts);
        } catch (e) {
          console.error(`[trial] could not erase trial company ${row.id}:`, e?.message || e);
        }
      }
    } catch (e) {
      console.error("[trial] sweep failed:", e?.message || e);
    }
  }
  setTimeout(sweepExpiredTrials, 90_000).unref?.();
  setInterval(sweepExpiredTrials, SWEEP_EVERY_MS).unref?.();
};

module.exports.SECTOR_KIT = SECTOR_KIT;
module.exports.TRIAL_DAYS = TRIAL_DAYS;
