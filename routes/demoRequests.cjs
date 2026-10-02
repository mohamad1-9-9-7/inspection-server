/* ============================================================
   Demo requests — leads from the public "Request a demo" page (/demo).

     POST   /api/demo-requests        PUBLIC  save a lead + e-mail the owner
     GET    /api/demo-requests        super-admin — every lead, newest first
     PATCH  /api/demo-requests/:id    super-admin — { status?, notes? }
     DELETE /api/demo-requests/:id    super-admin — spam / duplicates

     GET    /api/demo-config          PUBLIC  { whatsapp, offer, referral, story, testimonials } for /demo + /readiness
     PUT    /api/demo-config          super-admin — any of { whatsapp, offer, referral, story, testimonials }

   The public GET only returns what is switched on: an offer past its end
   date, or a story with no text, is simply absent, so the pages never show
   an expired deadline.
     POST   /api/demo-requests/wa-click  PUBLIC  count a WhatsApp tap per ?src=
     POST   /api/demo-requests/quiz-event PUBLIC { event: start|done, source }

   Readiness check (/readiness): a finished check that asks for its full
   report POSTs to /api/demo-requests like any lead, plus quizScore (0-100)
   and quizAnswers ({ questionId: optionIndex }). Starts and finishes are
   counted per ?src= under 'demo_quiz_stats' ("start:<src>", "done:<src>"),
   so the owner sees the funnel: opened → finished → left their number.

   The WhatsApp number and the tap counts live in platform_settings
   (keys 'demo_page' and 'demo_wa_clicks'); the counts come back with GET
   /api/demo-requests as `waClicks` so the owner sees which link gets chats.

   Platform-owned like quotations: the table (db/schema.cjs) has no company
   scope, and only the platform owner can read it.

   Owner e-mail goes to DEMO_NOTIFY_EMAIL (falls back to the MAIL_USER
   mailbox) through routes/mailer.cjs. Mail is best-effort and sent after
   the row is saved, so a mail problem never loses a lead.
============================================================ */
const { sendPlatformMail } = require("./mailer.cjs");

module.exports = function registerDemoRequestRoutes(app, deps = {}) {
  const { pool, requireAuthStrict, requireSuperAdmin, makeLimiter, clientIp } = deps;

  const refuse = (_req, res) => res.status(403).json({ ok: false, error: "super_admin_required" });
  // Both gates fail CLOSED if not wired in.
  const strict = typeof requireAuthStrict === "function" ? requireAuthStrict : refuse;
  const superOnly = typeof requireSuperAdmin === "function" ? requireSuperAdmin : refuse;
  const gate = [strict, superOnly];

  // A person sends one or two; anything past 5 an hour from one IP is a script.
  const createLimiter = typeof makeLimiter === "function"
    ? makeLimiter({ max: 5, windowMs: 60 * 60_000, name: "demo-requests" })
    : (_req, _res, next) => next();

  // A tap is cheap to fake; this only keeps a script from inflating the counts.
  const clickLimiter = typeof makeLimiter === "function"
    ? makeLimiter({ max: 30, windowMs: 60 * 60_000, name: "demo-wa-click" })
    : (_req, _res, next) => next();

  const STATUSES = new Set(["new", "contacted", "demo_done", "trial", "won", "lost"]);
  const CONFIG_KEY = "demo_page";
  const CLICKS_KEY = "demo_wa_clicks";
  const QUIZ_KEY = "demo_quiz_stats";
  const QUIZ_EVENTS = new Set(["start", "done"]);
  const srcSlug = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "direct";

  async function readSetting(key) {
    const { rows } = await pool.query(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
    return rows[0]?.value || {};
  }

  const todayDubai = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

  /* Stored config → what visitors may see. */
  function publicConfig(v = {}) {
    const out = { whatsapp: String(v.whatsapp || "") };
    const o = v.offer || {};
    if (o.on && isDate(o.endsAt) && o.endsAt >= todayDubai()) out.offer = { endsAt: o.endsAt };
    const r = v.referral || {};
    if (r.on && Number(r.pct) > 0) out.referral = { pct: Number(r.pct), months: Number(r.months) || 12 };
    const st = v.story || {};
    if (st.on && (st.ar || st.en)) out.story = { ar: String(st.ar || ""), en: String(st.en || "") };
    const tm = (Array.isArray(v.testimonials) ? v.testimonials : []).filter((x) => x && x.on && x.name && (x.ar || x.en));
    if (tm.length) out.testimonials = tm.map(({ on, ...x }) => x);
    return out;
  }

  /* PUT body → the parts to change; a missing part is left as it is. */
  function parseConfig(body = {}) {
    const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
    const next = {};
    if (body.whatsapp !== undefined) {
      let d = String(body.whatsapp || "").replace(/\D/g, "");
      if (d.startsWith("00")) d = d.slice(2);
      else if (d.startsWith("0")) d = "971" + d.slice(1); // local UAE number
      if (d && (d.length < 8 || d.length > 15)) throw bad("invalid_whatsapp");
      next.whatsapp = d;
    }
    if (body.offer !== undefined) {
      const o = body.offer || {};
      if (o.on && !isDate(o.endsAt)) throw bad("invalid_offer_date");
      next.offer = { on: !!o.on, endsAt: isDate(o.endsAt) ? o.endsAt : "" };
    }
    if (body.referral !== undefined) {
      const r = body.referral || {};
      const pct = Math.round(Number(r.pct));
      const months = Math.round(Number(r.months));
      if (r.on && !(pct >= 1 && pct <= 100)) throw bad("invalid_referral_pct");
      next.referral = { on: !!r.on, pct: pct >= 1 && pct <= 100 ? pct : 20, months: months >= 1 && months <= 60 ? months : 12 };
    }
    if (body.story !== undefined) {
      const st = body.story || {};
      next.story = { on: !!st.on, ar: clean(st.ar, 600), en: clean(st.en, 600) };
    }
    if (body.testimonials !== undefined) {
      // Real customer quotes only (the owner adds them with permission). Max 6.
      const list = Array.isArray(body.testimonials) ? body.testimonials.slice(0, 6) : [];
      next.testimonials = list.map((x = {}) => {
        const stars = Math.round(Number(x.stars));
        return {
          on: !!x.on,
          name: clean(x.name, 80),
          role: clean(x.role, 80),
          company: clean(x.company, 100),
          ar: clean(x.ar, 400),
          en: clean(x.en, 400),
          stars: stars >= 1 && stars <= 5 ? stars : 5,
        };
      });
    }
    return next;
  }

  // +1 on one field of a counter record. One statement, so two hits at once both count.
  function bump(key, field) {
    return pool.query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ($1, jsonb_build_object($2::text, 1), 'public', now())
       ON CONFLICT (key) DO UPDATE
         SET value = platform_settings.value
                     || jsonb_build_object($2::text, COALESCE((platform_settings.value->>$2)::int, 0) + 1),
             updated_at = now()`,
      [key, field]
    );
  }

  /* { q1: 2, q7: 0 } → same shape, ids and indexes only. Anything else is dropped. */
  function cleanAnswers(v) {
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const out = {};
    for (const [k, i] of Object.entries(v).slice(0, 30)) {
      if (/^[a-z0-9_]{1,20}$/i.test(k) && Number.isInteger(i) && i >= 0 && i < 10) out[k] = i;
    }
    return Object.keys(out).length ? out : null;
  }

  // body field -> [column, max length]
  const FIELDS = {
    companyName: ["company_name", 150],
    activity: ["activity", 40],
    branches: ["branches", 20],
    contactName: ["contact_name", 120],
    jobTitle: ["job_title", 120],
    phone: ["phone", 40],
    email: ["email", 160],
    emirate: ["emirate", 40],
    message: ["message", 2000],
    source: ["source", 60],
    referredBy: ["referred_by", 150],
    referrer: ["referrer", 300],
    lang: ["lang", 5],
  };

  // eslint-disable-next-line no-control-regex
  const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
  const isEmail = (s) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ipOf = (req) => (typeof clientIp === "function" ? clientIp(req) : req.ip || "");

  function notifyOwner(d) {
    const to = String(process.env.DEMO_NOTIFY_EMAIL || process.env.MAIL_USER || process.env.SMTP_USER || "").trim();
    if (!to) return;
    const lines = [
      ["Company", d.companyName], ["Business type", d.activity], ["Branches", d.branches],
      ["Emirate", d.emirate], ["Contact", d.contactName + (d.jobTitle ? ` — ${d.jobTitle}` : "")],
      ["Phone", d.phone], ["E-mail", d.email], ["Source", d.source], ["Referred by", d.referredBy],
      ["Readiness score", d.quizScore == null ? "" : `${d.quizScore} / 100`], ["Message", d.message],
    ].filter(([, v]) => v);
    const appUrl = String(process.env.APP_PUBLIC_URL || "").trim().replace(/\/$/, "");
    const link = appUrl ? `${appUrl}/select-company?tab=leads` : "";
    sendPlatformMail({
      to,
      subject: d.quizScore == null
        ? `New demo request: ${d.companyName}${d.branches ? ` (${d.branches} branches)` : ""}`
        : `New readiness lead: ${d.companyName} scored ${d.quizScore}/100`,
      text: lines.map(([k, v]) => `${k}: ${v}`).join("\n") + (link ? `\n\nOpen: ${link}` : ""),
      html:
        `<h2 style="font-family:sans-serif;color:#0f766e">New demo request</h2>` +
        `<table style="font-family:sans-serif;border-collapse:collapse">` +
        lines.map(([k, v]) =>
          `<tr><td style="padding:4px 14px 4px 0;color:#64748b;vertical-align:top"><b>${esc(k)}</b></td>` +
          `<td style="padding:4px 0">${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("") +
        `</table>` +
        (link ? `<p style="font-family:sans-serif"><a href="${esc(link)}">Open Demo Requests</a></p>` : ""),
    })
      .then((sent) => { if (!sent) console.warn("[demo-requests] notify mail skipped (SMTP not configured)"); })
      .catch((e) => console.error("[demo-requests] notify mail failed:", e?.message || e));
  }

  /* ---------- PUBLIC: create ---------- */
  app.post("/api/demo-requests", createLimiter, async (req, res) => {
    try {
      const body = req.body || {};
      // Honeypot: people never see "website", bots fill it. Answer like success.
      if (String(body.website || "").trim()) return res.status(201).json({ ok: true });

      const d = {};
      for (const [k, [, max]] of Object.entries(FIELDS)) d[k] = clean(body[k], max);
      if (!d.companyName || !d.contactName || !d.phone) {
        return res.status(400).json({ ok: false, error: "company_contact_phone_required" });
      }
      if (d.phone.replace(/\D/g, "").length < 7) return res.status(400).json({ ok: false, error: "invalid_phone" });
      if (d.email && !isEmail(d.email)) return res.status(400).json({ ok: false, error: "invalid_email" });

      const score = Number(body.quizScore);
      d.quizScore = Number.isInteger(score) && score >= 0 && score <= 100 ? score : null;
      const answers = d.quizScore == null ? null : cleanAnswers(body.quizAnswers);

      const keys = Object.keys(FIELDS);
      const cols = [...keys.map((k) => FIELDS[k][0]), "ip", "quiz_score", "quiz_answers"];
      const vals = [...keys.map((k) => d[k]), clean(ipOf(req), 64), d.quizScore, answers ? JSON.stringify(answers) : null];
      const { rows } = await pool.query(
        `INSERT INTO demo_requests (${cols.join(", ")})
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
         RETURNING id`,
        vals
      );
      res.status(201).json({ ok: true, id: rows[0].id });
      notifyOwner(d);
    } catch (e) {
      console.error("POST /api/demo-requests ERROR:", e?.message || e);
      if (!res.headersSent) res.status(500).json({ ok: false, error: "save_failed" });
    }
  });

  /* ---------- PUBLIC: WhatsApp button ---------- */
  app.get("/api/demo-config", async (_req, res) => {
    try {
      res.json({ ok: true, ...publicConfig(await readSetting(CONFIG_KEY)) });
    } catch (e) {
      // No button is better than a broken page.
      console.error("GET /api/demo-config ERROR:", e?.message || e);
      res.json({ ok: true, whatsapp: "" });
    }
  });

  app.post("/api/demo-requests/wa-click", clickLimiter, async (req, res) => {
    try {
      await bump(CLICKS_KEY, srcSlug(req.body?.source));
      res.json({ ok: true });
    } catch (e) {
      console.error("POST /api/demo-requests/wa-click ERROR:", e?.message || e);
      res.json({ ok: false });
    }
  });

  app.post("/api/demo-requests/quiz-event", clickLimiter, async (req, res) => {
    try {
      const ev = String(req.body?.event || "");
      if (!QUIZ_EVENTS.has(ev)) return res.status(400).json({ ok: false, error: "bad_event" });
      await bump(QUIZ_KEY, `${ev}:${srcSlug(req.body?.source)}`);
      res.json({ ok: true });
    } catch (e) {
      console.error("POST /api/demo-requests/quiz-event ERROR:", e?.message || e);
      res.json({ ok: false });
    }
  });

  /* ---------- super-admin ---------- */
  app.put("/api/demo-config", ...gate, async (req, res) => {
    try {
      let next;
      try { next = parseConfig(req.body || {}); }
      catch (err) { return res.status(err.status || 400).json({ ok: false, error: err.message }); }
      const prev = await readSetting(CONFIG_KEY);
      const merged = { ...prev, ...next };
      const who = String(req.user?.username || "").slice(0, 120);
      await pool.query(
        `INSERT INTO platform_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [CONFIG_KEY, JSON.stringify(merged), who]
      );
      res.json({ ok: true, config: merged, whatsapp: String(merged.whatsapp || "") });
    } catch (e) {
      console.error("PUT /api/demo-config ERROR:", e?.message || e);
      res.status(500).json({ ok: false, error: "save_failed" });
    }
  });

  app.get("/api/demo-requests", ...gate, async (_req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM demo_requests ORDER BY created_at DESC LIMIT 2000`
      );
      const waClicks = await readSetting(CLICKS_KEY).catch(() => ({}));
      const config = await readSetting(CONFIG_KEY).catch(() => ({}));
      const quizStats = await readSetting(QUIZ_KEY).catch(() => ({}));
      res.json({ ok: true, requests: rows, waClicks, quizStats, config, whatsapp: String(config.whatsapp || "") });
    } catch (e) {
      console.error("GET /api/demo-requests ERROR:", e?.message || e);
      res.status(500).json({ ok: false, error: "load_failed" });
    }
  });

  app.patch("/api/demo-requests/:id", ...gate, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });
      const sets = [];
      const vals = [];
      if (req.body?.status !== undefined) {
        if (!STATUSES.has(req.body.status)) return res.status(400).json({ ok: false, error: "bad_status" });
        vals.push(req.body.status);
        sets.push(`status = $${vals.length}`);
      }
      if (req.body?.notes !== undefined) {
        vals.push(clean(req.body.notes, 5000));
        sets.push(`notes = $${vals.length}`);
      }
      if (!sets.length) return res.status(400).json({ ok: false, error: "nothing_to_update" });
      vals.push(id);
      const { rows } = await pool.query(
        `UPDATE demo_requests SET ${sets.join(", ")}, updated_at = now()
          WHERE id = $${vals.length} RETURNING *`,
        vals
      );
      if (!rows.length) return res.status(404).json({ ok: false, error: "not_found" });
      res.json({ ok: true, request: rows[0] });
    } catch (e) {
      console.error("PATCH /api/demo-requests ERROR:", e?.message || e);
      res.status(500).json({ ok: false, error: "update_failed" });
    }
  });

  app.delete("/api/demo-requests/:id", ...gate, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad_id" });
      const { rowCount } = await pool.query(`DELETE FROM demo_requests WHERE id = $1`, [id]);
      if (!rowCount) return res.status(404).json({ ok: false, error: "not_found" });
      res.json({ ok: true });
    } catch (e) {
      console.error("DELETE /api/demo-requests ERROR:", e?.message || e);
      res.status(500).json({ ok: false, error: "delete_failed" });
    }
  });
};
