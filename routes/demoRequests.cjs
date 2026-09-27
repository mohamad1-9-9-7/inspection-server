/* ============================================================
   Demo requests — leads from the public "Request a demo" page (/demo).

     POST   /api/demo-requests        PUBLIC  save a lead + e-mail the owner
     GET    /api/demo-requests        super-admin — every lead, newest first
     PATCH  /api/demo-requests/:id    super-admin — { status?, notes? }
     DELETE /api/demo-requests/:id    super-admin — spam / duplicates

     GET    /api/demo-config          PUBLIC  { whatsapp } for the /demo page
     PUT    /api/demo-config          super-admin — { whatsapp } ("" hides it)
     POST   /api/demo-requests/wa-click  PUBLIC  count a WhatsApp tap per ?src=

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
  const srcSlug = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "direct";

  async function readSetting(key) {
    const { rows } = await pool.query(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
    return rows[0]?.value || {};
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
      ["Phone", d.phone], ["E-mail", d.email], ["Source", d.source], ["Message", d.message],
    ].filter(([, v]) => v);
    const appUrl = String(process.env.APP_PUBLIC_URL || "").trim().replace(/\/$/, "");
    const link = appUrl ? `${appUrl}/select-company?tab=leads` : "";
    sendPlatformMail({
      to,
      subject: `New demo request: ${d.companyName}${d.branches ? ` (${d.branches} branches)` : ""}`,
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

      const keys = Object.keys(FIELDS);
      const cols = [...keys.map((k) => FIELDS[k][0]), "ip"];
      const vals = [...keys.map((k) => d[k]), clean(ipOf(req), 64)];
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
      const v = await readSetting(CONFIG_KEY);
      res.json({ ok: true, whatsapp: String(v.whatsapp || "") });
    } catch (e) {
      // No button is better than a broken page.
      console.error("GET /api/demo-config ERROR:", e?.message || e);
      res.json({ ok: true, whatsapp: "" });
    }
  });

  app.post("/api/demo-requests/wa-click", clickLimiter, async (req, res) => {
    try {
      const src = srcSlug(req.body?.source);
      // One statement, so two taps at once both count.
      await pool.query(
        `INSERT INTO platform_settings (key, value, updated_by, updated_at)
         VALUES ($1, jsonb_build_object($2::text, 1), 'public', now())
         ON CONFLICT (key) DO UPDATE
           SET value = platform_settings.value
                       || jsonb_build_object($2::text, COALESCE((platform_settings.value->>$2)::int, 0) + 1),
               updated_at = now()`,
        [CLICKS_KEY, src]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error("POST /api/demo-requests/wa-click ERROR:", e?.message || e);
      res.json({ ok: false });
    }
  });

  /* ---------- super-admin ---------- */
  app.put("/api/demo-config", ...gate, async (req, res) => {
    try {
      let d = String(req.body?.whatsapp || "").replace(/\D/g, "");
      if (d.startsWith("00")) d = d.slice(2);
      else if (d.startsWith("0")) d = "971" + d.slice(1); // local UAE number
      if (d && (d.length < 8 || d.length > 15)) return res.status(400).json({ ok: false, error: "invalid_whatsapp" });
      const prev = await readSetting(CONFIG_KEY);
      const who = String(req.user?.username || "").slice(0, 120);
      await pool.query(
        `INSERT INTO platform_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [CONFIG_KEY, JSON.stringify({ ...prev, whatsapp: d }), who]
      );
      res.json({ ok: true, whatsapp: d });
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
      res.json({ ok: true, requests: rows, waClicks, whatsapp: String(config.whatsapp || "") });
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
