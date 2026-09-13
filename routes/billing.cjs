/* ============================================================
   PACKAGES, COMPANIES, SUBSCRIPTION, BILLING PROFILE, INVOICES
   ------------------------------------------------------------
   The packages card was unreadable because this file handed the UI
   raw table rows and left it to work out what they meant. Plans now
   come back through utils/planView.cjs — explicit `unlimited` flags,
   Arabic and English labels, a headline price with its period, and
   the quota bars already filled in — and there is a single
   /api/packages/overview call that returns the whole card, usage and
   warnings included, instead of four fetches the screen had to join
   by hand.

   Raw columns are still on every plan object, so screens that read
   plan.max_users or plan.price keep working untouched.
============================================================ */

const {
  toPlanView,
  periodView,
  buildWarnings,
  normalizePeriod,
  money,
  PERIODS,
} = require("../utils/planView.cjs");

module.exports = function registerBillingRoutes(app, deps = {}) {
  const { pool, normText, clampInt, requireAuthStrict, requireAdmin } = deps;

  const noGate = (_req, _res, next) => next();
  const strict = typeof requireAuthStrict === "function" ? requireAuthStrict : noGate;
  const admin = typeof requireAdmin === "function" ? requireAdmin : strict;

  /* GET /api/plans and GET /api/subscription stay open on purpose: App.jsx
     caches the subscription on boot, before anyone has logged in, and plan
     tiers are just public pricing. Everything else in this file is either a
     write or real financial/tenant data, so it needs a token. */

  const PLAN_COLS = `id, code, name, name_ar, description, description_ar,
                     price, currency, billing_period, max_branches, max_users,
                     max_reports_per_month, max_storage_mb, features, trial_days,
                     is_active, is_popular, sort_order, color, created_at, updated_at`;

  /* Cards are ordered the way the pricing page reads: cheapest first,
     with sort_order overriding when an admin wants a specific run. */
  const PLAN_ORDER = `ORDER BY sort_order ASC, price ASC, id ASC`;

  const slug = (s) =>
    String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  /** -1 / null / "" all mean "no ceiling"; anything else must be a count. */
  function limitValue(v, fallback = -1) {
    if (v === null || v === undefined || v === "") return fallback;
    if (v === "unlimited" || v === true) return -1;
    const n = Number.parseInt(String(v), 10);
    if (!Number.isFinite(n)) return fallback;
    return n < 0 ? -1 : n;
  }

  /** Features are stored as JSONB; accept the short string form too. */
  function normalizeFeatures(input) {
    if (!Array.isArray(input)) return null;
    return input
      .map((f) => {
        if (typeof f === "string") {
          const t = f.trim();
          return t ? { key: null, label: { en: t, ar: t }, included: true } : null;
        }
        if (!f || typeof f !== "object") return null;
        const en = String(f.label?.en ?? f.en ?? "").trim();
        const ar = String(f.label?.ar ?? f.ar ?? "").trim();
        if (!en && !ar) return null;
        return {
          key: f.key ? String(f.key).trim() : null,
          label: { en: en || ar, ar: ar || en },
          included: f.included !== false,
        };
      })
      .filter(Boolean);
  }

  /* ============================================================
     Usage — what the company is actually consuming right now
     ------------------------------------------------------------
     Seats come from app_users, which is tenant-scoped. Branches and
     report volume are read out of the reports table, which carries no
     company column yet, so on a multi-company install those two are
     platform-wide totals. `scope` on the response says which, rather
     than letting the card imply a precision that isn't there.
  ============================================================ */
  async function usageFor(companyId) {
    const users = companyId
      ? await pool.query(
          `SELECT COUNT(*)::int AS c FROM app_users WHERE company_id = $1 AND is_active`,
          [companyId]
        )
      : await pool.query(`SELECT COUNT(*)::int AS c FROM app_users WHERE is_active`);

    const branches = await pool.query(
      `SELECT COUNT(DISTINCT NULLIF(payload->>'branch', ''))::int AS c FROM reports`
    );

    const reports = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM reports
        WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Dubai')`
    );

    return {
      users: users.rows[0]?.c ?? 0,
      branches: branches.rows[0]?.c ?? 0,
      reports: reports.rows[0]?.c ?? 0,
      scope: { users: companyId ? "company" : "platform", branches: "platform", reports: "platform" },
    };
  }

/* ============================================================
   PLANS (PACKAGES) — CRUD
============================================================ */

app.get("/api/plans", async (req, res) => {
  try {
    const onlyActive = ["1", "true", "yes"].includes(String(req.query.active || "").toLowerCase());
    const q = await pool.query(
      `SELECT ${PLAN_COLS} FROM plans ${onlyActive ? "WHERE is_active" : ""} ${PLAN_ORDER}`
    );
    res.json({ ok: true, plans: q.rows.map((r) => toPlanView(r)) });
  } catch (e) {
    console.error("GET /api/plans ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/plans/:id", async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });
    const q = await pool.query(`SELECT ${PLAN_COLS} FROM plans WHERE id=$1`, [id]);
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });

    /* How many companies this tier is carrying — an admin should see that
       before editing a price or deleting the row. */
    const used = await pool.query(`SELECT COUNT(*)::int AS c FROM companies WHERE plan_id=$1`, [id]);
    res.json({ ok: true, plan: toPlanView(q.rows[0]), companiesOnPlan: used.rows[0]?.c ?? 0 });
  } catch (e) {
    console.error("GET /api/plans/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/plans", admin, async (req, res) => {
  try {
    const name = normText(req.body?.name);
    if (!name) return res.status(400).json({ ok: false, error: "name_required" });

    const price = Number(req.body?.price ?? 0);
    if (!Number.isFinite(price) || price < 0)
      return res.status(400).json({ ok: false, error: "price_invalid" });

    const period = normalizePeriod(req.body?.billingPeriod ?? req.body?.billing_period);
    const features = normalizeFeatures(req.body?.features) ?? [];

    const q = await pool.query(
      `INSERT INTO plans (
         code, name, name_ar, description, description_ar,
         price, currency, billing_period,
         max_branches, max_users, max_reports_per_month, max_storage_mb,
         features, trial_days, is_active, is_popular, sort_order, color
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)
       RETURNING ${PLAN_COLS}`,
      [
        slug(req.body?.code || name) || null,
        name,
        normText(req.body?.nameAr ?? req.body?.name_ar),
        normText(req.body?.description),
        normText(req.body?.descriptionAr ?? req.body?.description_ar),
        price,
        (normText(req.body?.currency) || "USD").toUpperCase(),
        period,
        limitValue(req.body?.max_branches ?? req.body?.maxBranches),
        limitValue(req.body?.max_users ?? req.body?.maxUsers),
        limitValue(req.body?.maxReportsPerMonth ?? req.body?.max_reports_per_month),
        limitValue(req.body?.maxStorageMb ?? req.body?.max_storage_mb),
        JSON.stringify(features),
        clampInt(req.body?.trialDays ?? req.body?.trial_days, 0, 0, 365),
        req.body?.isActive !== false && req.body?.is_active !== false,
        !!(req.body?.isPopular ?? req.body?.is_popular),
        clampInt(req.body?.sortOrder ?? req.body?.sort_order, 0, 0, 9999),
        normText(req.body?.color) || null,
      ]
    );
    res.json({ ok: true, plan: toPlanView(q.rows[0]) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ ok: false, error: "name_taken" });
    console.error("POST /api/plans ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* PUT /api/plans/:id — PARTIAL update.
   The previous version wrote every column from the body, so a screen that
   sent only { price } silently blanked the name, the description and both
   limits — or failed the NOT NULL on name and returned a 500. Only fields
   actually present are touched now. */
app.put("/api/plans/:id", admin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });

    const b = req.body || {};
    const sets = [];
    const vals = [];
    const set = (sql, val) => { vals.push(val); sets.push(sql.replace("?", `$${vals.length}`)); };
    const has = (...keys) => keys.some((k) => b[k] !== undefined);
    const pick = (...keys) => keys.map((k) => b[k]).find((v) => v !== undefined);

    if (has("name")) {
      const name = normText(b.name);
      if (!name) return res.status(400).json({ ok: false, error: "name_required" });
      set(`name=?`, name);
    }
    if (has("code")) set(`code=?`, slug(b.code) || null);
    if (has("nameAr", "name_ar")) set(`name_ar=?`, normText(pick("nameAr", "name_ar")));
    if (has("description")) set(`description=?`, normText(b.description));
    if (has("descriptionAr", "description_ar")) set(`description_ar=?`, normText(pick("descriptionAr", "description_ar")));
    if (has("price")) {
      const price = Number(b.price);
      if (!Number.isFinite(price) || price < 0)
        return res.status(400).json({ ok: false, error: "price_invalid" });
      set(`price=?`, price);
    }
    if (has("currency")) set(`currency=?`, (normText(b.currency) || "USD").toUpperCase());
    if (has("billingPeriod", "billing_period")) set(`billing_period=?`, normalizePeriod(pick("billingPeriod", "billing_period")));
    if (has("max_branches", "maxBranches")) set(`max_branches=?`, limitValue(pick("max_branches", "maxBranches")));
    if (has("max_users", "maxUsers")) set(`max_users=?`, limitValue(pick("max_users", "maxUsers")));
    if (has("maxReportsPerMonth", "max_reports_per_month")) set(`max_reports_per_month=?`, limitValue(pick("maxReportsPerMonth", "max_reports_per_month")));
    if (has("maxStorageMb", "max_storage_mb")) set(`max_storage_mb=?`, limitValue(pick("maxStorageMb", "max_storage_mb")));
    if (has("features")) {
      const features = normalizeFeatures(b.features);
      if (!features) return res.status(400).json({ ok: false, error: "features_invalid" });
      set(`features=?::jsonb`, JSON.stringify(features));
    }
    if (has("trialDays", "trial_days")) set(`trial_days=?`, clampInt(pick("trialDays", "trial_days"), 0, 0, 365));
    if (has("isActive", "is_active")) set(`is_active=?`, pick("isActive", "is_active") !== false);
    if (has("isPopular", "is_popular")) set(`is_popular=?`, !!pick("isPopular", "is_popular"));
    if (has("sortOrder", "sort_order")) set(`sort_order=?`, clampInt(pick("sortOrder", "sort_order"), 0, 0, 9999));
    if (has("color")) set(`color=?`, normText(b.color) || null);

    if (!sets.length) return res.status(400).json({ ok: false, error: "nothing_to_update" });

    sets.push(`updated_at=now()`);
    vals.push(id);
    const q = await pool.query(
      `UPDATE plans SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING ${PLAN_COLS}`,
      vals
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, plan: toPlanView(q.rows[0]) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ ok: false, error: "name_taken" });
    console.error("PUT /api/plans/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* DELETE /api/plans/:id
   Deleting a tier used to quietly detach every company on it — their card
   then showed no package at all and login stopped checking any limit. A
   plan in use is refused; `?force=1` keeps the old behaviour for the rare
   case where it really is meant, and the response says what it detached. */
app.delete("/api/plans/:id", admin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });

    const inUse = await pool.query(
      `SELECT id, name FROM companies WHERE plan_id=$1 ORDER BY name`, [id]
    );
    const force = ["1", "true", "yes"].includes(String(req.query.force || "").toLowerCase());

    if (inUse.rowCount && !force) {
      return res.status(409).json({
        ok: false,
        error: "plan_in_use",
        companies: inUse.rows,
        message: {
          en: `${inUse.rowCount} company/companies are on this package. Move them first, or deactivate the package instead.`,
          ar: `${inUse.rowCount} شركة مرتبطة بهذه الباقة. انقلها أولاً أو عطّل الباقة بدل حذفها.`,
        },
      });
    }

    if (inUse.rowCount) await pool.query(`UPDATE companies SET plan_id=NULL WHERE plan_id=$1`, [id]);
    const del = await pool.query(`DELETE FROM plans WHERE id=$1 RETURNING name`, [id]);
    if (!del.rowCount) return res.status(404).json({ ok: false, error: "not_found" });

    res.json({ ok: true, deleted: del.rows[0].name, detachedCompanies: inUse.rows.map((r) => r.name) });
  } catch (e) {
    console.error("DELETE /api/plans/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   PACKAGES OVERVIEW — everything the card renders, in one call
   ------------------------------------------------------------
   GET /api/packages/overview?company_id=3
   (alias: /api/subscription/overview)

   Returns:
     card.company       who the subscription belongs to
     card.plan          the package, fully labelled, with quota bars
     card.period        start/end, days left, % elapsed, severity
     card.usage         users / branches / reports actually consumed
     card.warnings      ready-phrased banners (ar + en) with severity
     card.lastInvoice   the most recent invoice, if any
     plans              every active package, for the upgrade row
============================================================ */
async function packagesOverview(req, res) {
  try {
    const requested = req.query.company_id ? Number.parseInt(req.query.company_id, 10) : null;
    /* A company user always sees their own card, whatever they ask for. */
    const scoped = req.user && !req.user.isSuperAdmin ? req.user.companyId ?? null : null;
    const wanted = scoped ?? (Number.isFinite(requested) ? requested : null);

    const cq = await pool.query(
      `SELECT c.*, ${PLAN_COLS.split(",").map((c) => `p.${c.trim()} AS plan_${c.trim()}`).join(", ")}
         FROM companies c
         LEFT JOIN plans p ON p.id = c.plan_id
        ${wanted != null ? "WHERE c.id = $1" : ""}
        ORDER BY c.created_at ASC
        LIMIT 1`,
      wanted != null ? [wanted] : []
    );

    if (!cq.rowCount) {
      return res.json({
        ok: true,
        card: null,
        plans: (await pool.query(`SELECT ${PLAN_COLS} FROM plans WHERE is_active ${PLAN_ORDER}`))
          .rows.map((r) => toPlanView(r)),
        warnings: [{
          code: "no_company",
          severity: "critical",
          message: { en: "No company record exists yet.", ar: "لا يوجد سجل شركة بعد." },
        }],
      });
    }

    const row = cq.rows[0];
    /* Un-prefix the joined plan columns back into a plans row. */
    const planRow = row.plan_id
      ? Object.fromEntries(
          Object.entries(row)
            .filter(([k]) => k.startsWith("plan_"))
            .map(([k, v]) => [k.slice(5), v])
        )
      : null;

    const usage = await usageFor(row.id);
    const plan = planRow
      ? toPlanView(planRow, { users: usage.users, branches: usage.branches, reports: usage.reports })
      : null;

    const period = periodView(row.start_date, row.end_date, row.status);
    const warnings = buildWarnings(plan, period);

    const lastInvoice = await pool.query(
      `SELECT id, invoice_number, issue_date, amount, currency, plan_name
         FROM invoices ORDER BY id DESC LIMIT 1`
    );

    const allPlans = await pool.query(`SELECT ${PLAN_COLS} FROM plans WHERE is_active ${PLAN_ORDER}`);

    res.json({
      ok: true,
      card: {
        company: {
          id: row.id,
          name: row.name,
          contactName: row.contact_name,
          contactEmail: row.contact_email,
          contactPhone: row.contact_phone,
          status: row.status,
        },
        plan,
        period,
        usage,
        /* What the next renewal costs, so the card doesn't have to
           multiply a price by a period itself. */
        renewal: plan
          ? {
              amount: plan.price,
              currency: plan.currency,
              label: plan.headlinePrice,
              periodMonths: PERIODS[plan.billingPeriod].months,
              dueOn: period.endDate,
            }
          : null,
        lastInvoice: lastInvoice.rows[0] || null,
        warnings,
        severity: warnings.some((w) => w.severity === "critical")
          ? "critical"
          : warnings.some((w) => w.severity === "warning")
          ? "warning"
          : "ok",
      },
      plans: allPlans.rows.map((r) => toPlanView(r)),
    });
  } catch (e) {
    console.error("GET /api/packages/overview ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
}

app.get("/api/packages/overview", strict, packagesOverview);
app.get("/api/subscription/overview", strict, packagesOverview);

/* ============================================================
   COMPANIES — CRUD
============================================================ */

app.get("/api/companies", strict, async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT c.*,
             p.name AS plan_name, p.name_ar AS plan_name_ar,
             p.price AS plan_price, p.currency AS plan_currency,
             p.billing_period AS plan_billing_period,
             p.max_users AS plan_max_users, p.max_branches AS plan_max_branches,
             (SELECT COUNT(*)::int FROM app_users u WHERE u.company_id = c.id AND u.is_active) AS active_users
      FROM companies c
      LEFT JOIN plans p ON p.id = c.plan_id
      ORDER BY c.created_at ASC
    `);
    /* Each row carries the same period maths the card uses, so a list of
       companies can show "12 days left" without a second round trip. */
    res.json({
      ok: true,
      companies: q.rows.map((r) => ({
        ...r,
        period: periodView(r.start_date, r.end_date, r.status),
        seats: {
          used: r.active_users,
          max: r.plan_max_users == null ? -1 : Number(r.plan_max_users),
          unlimited: r.plan_max_users == null || Number(r.plan_max_users) < 0,
        },
      })),
    });
  } catch (e) {
    console.error("GET /api/companies ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/companies", admin, async (req, res) => {
  try {
    const { name, contact_name, contact_email, contact_phone, plan_id, status, start_date, end_date, notes } = req.body;
    if (!normText(name)) return res.status(400).json({ ok: false, error: "name_required" });
    const q = await pool.query(
      `INSERT INTO companies (name, contact_name, contact_email, contact_phone, plan_id, status, start_date, end_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [normText(name), contact_name||"", contact_email||"", contact_phone||"",
       plan_id||null, status||"active", start_date||null, end_date||null, notes||""]
    );
    res.json({ ok: true, company: q.rows[0] });
  } catch (e) {
    if (e.code === "23503") return res.status(400).json({ ok: false, error: "plan_not_found" });
    console.error("POST /api/companies ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* PUT /api/companies/:id — PARTIAL, for the same reason as plans: a screen
   that toggled the status used to blank the contact details. */
app.put("/api/companies/:id", admin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });

    const b = req.body || {};
    const sets = [];
    const vals = [];
    const set = (sql, val) => { vals.push(val); sets.push(sql.replace("?", `$${vals.length}`)); };

    if (b.name !== undefined) {
      if (!normText(b.name)) return res.status(400).json({ ok: false, error: "name_required" });
      set(`name=?`, normText(b.name));
    }
    if (b.contact_name !== undefined)  set(`contact_name=?`,  normText(b.contact_name));
    if (b.contact_email !== undefined) set(`contact_email=?`, normText(b.contact_email));
    if (b.contact_phone !== undefined) set(`contact_phone=?`, normText(b.contact_phone));
    if (b.plan_id !== undefined)       set(`plan_id=?`, b.plan_id || null);
    if (b.status !== undefined)        set(`status=?`, normText(b.status) || "active");
    if (b.start_date !== undefined)    set(`start_date=?`, b.start_date || null);
    if (b.end_date !== undefined)      set(`end_date=?`, b.end_date || null);
    if (b.notes !== undefined)         set(`notes=?`, normText(b.notes));

    if (!sets.length) return res.status(400).json({ ok: false, error: "nothing_to_update" });

    sets.push(`updated_at=now()`);
    vals.push(id);
    const q = await pool.query(
      `UPDATE companies SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, company: q.rows[0] });
  } catch (e) {
    if (e.code === "23503") return res.status(400).json({ ok: false, error: "plan_not_found" });
    console.error("PUT /api/companies/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* DELETE /api/companies/:id — refuses while accounts still belong to it,
   because app_users.company_id is ON DELETE SET NULL: deleting the company
   would quietly promote its staff to platform-level accounts. */
app.delete("/api/companies/:id", admin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "bad_id" });

    const users = await pool.query(
      `SELECT COUNT(*)::int AS c FROM app_users WHERE company_id=$1`, [id]
    );
    const force = ["1", "true", "yes"].includes(String(req.query.force || "").toLowerCase());
    if (users.rows[0].c && !force) {
      return res.status(409).json({
        ok: false,
        error: "company_has_users",
        users: users.rows[0].c,
        message: {
          en: `${users.rows[0].c} account(s) still belong to this company.`,
          ar: `ما زال ${users.rows[0].c} حساباً مرتبطاً بهذه الشركة.`,
        },
      });
    }

    const q = await pool.query(`DELETE FROM companies WHERE id=$1 RETURNING name`, [id]);
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, deleted: q.rows[0].name });
  } catch (e) {
    console.error("DELETE /api/companies/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   SUBSCRIPTION — Get / Update  (legacy single-row global record)
============================================================ */

/* GET /api/subscription */
app.get("/api/subscription", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM subscription ORDER BY id DESC LIMIT 1`);
    const row = q.rows[0] || null;
    res.json({
      ok: true,
      subscription: row
        ? { ...row, period: periodView(row.start_date, row.end_date, row.status) }
        : null,
    });
  } catch (e) {
    console.error("GET /api/subscription ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* PUT /api/subscription  { plan, status, start_date, end_date, price, currency, notes, updated_by } */
app.put("/api/subscription", admin, async (req, res) => {
  try {
    const { plan, status, start_date, end_date, price, currency, notes, updated_by } = req.body;
    /* Ensure a row exists */
    await pool.query(`
      INSERT INTO subscription (plan, status, start_date, end_date, notes, updated_by)
      SELECT 'enterprise','active', CURRENT_DATE, CURRENT_DATE + 365, '', 'system'
      WHERE NOT EXISTS (SELECT 1 FROM subscription LIMIT 1)
    `);
    const q = await pool.query(
      `UPDATE subscription SET
         plan=$1, status=$2, start_date=$3, end_date=$4,
         price=$5, currency=$6, notes=$7, updated_by=$8, updated_at=now()
       WHERE id=(SELECT id FROM subscription ORDER BY id DESC LIMIT 1)
       RETURNING *`,
      [plan || "enterprise", status || "active", start_date, end_date,
       price || null, currency || "USD", notes || "", updated_by || req.user?.username || "admin"]
    );
    res.json({ ok: true, subscription: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/subscription ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   BILLING PROFILE — single-row buyer info (Get / Update)
============================================================ */

app.get("/api/billing-profile", strict, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM billing_profile ORDER BY id ASC LIMIT 1`);
    res.json({ ok: true, profile: q.rows[0] || null });
  } catch (e) {
    console.error("GET /api/billing-profile ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.put("/api/billing-profile", strict, async (req, res) => {
  try {
    const { company_name, company_address, tax_id, contact_email, contact_phone, notes } = req.body;
    /* Ensure a row exists */
    await pool.query(`
      INSERT INTO billing_profile (company_name)
      SELECT '' WHERE NOT EXISTS (SELECT 1 FROM billing_profile LIMIT 1)
    `);
    const q = await pool.query(
      `UPDATE billing_profile SET
         company_name=$1, company_address=$2, tax_id=$3,
         contact_email=$4, contact_phone=$5, notes=$6, updated_at=now()
       WHERE id=(SELECT id FROM billing_profile ORDER BY id ASC LIMIT 1)
       RETURNING *`,
      [company_name || "", company_address || "", tax_id || "",
       contact_email || "", contact_phone || "", notes || ""]
    );
    res.json({ ok: true, profile: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/billing-profile ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   INVOICES — list / get / create (immutable snapshots)
============================================================ */

app.get("/api/invoices", strict, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM invoices ORDER BY id DESC LIMIT 500`);
    res.json({ ok: true, invoices: q.rows });
  } catch (e) {
    console.error("GET /api/invoices ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/invoices/:id", strict, async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM invoices WHERE id=$1`, [req.params.id]);
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, invoice: q.rows[0] });
  } catch (e) {
    console.error("GET /api/invoices/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* POST /api/invoices — counts default to what the platform is really using,
   so an invoice is no longer only as accurate as whatever the screen
   happened to post. */
app.post("/api/invoices", strict, async (req, res) => {
  try {
    const {
      issue_date, period_start, period_end,
      company_name, company_address, tax_id,
      plan_name, accounts_count, branches_count, max_branches, max_users,
      amount, currency, notes, created_by,
    } = req.body;

    /* Generate INV-YYYY-NNNN — sequence resets per year, padded to 4 digits */
    const year = new Date(issue_date || Date.now()).getFullYear();
    const seqQ = await pool.query(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(invoice_number FROM '\\d+$') AS INT)), 0) + 1 AS next_seq
         FROM invoices
        WHERE invoice_number LIKE $1`,
      [`INV-${year}-%`]
    );
    const seq = String(seqQ.rows[0].next_seq).padStart(4, "0");
    const invoice_number = `INV-${year}-${seq}`;

    const measured = accounts_count == null || branches_count == null ? await usageFor(null) : null;

    const q = await pool.query(
      `INSERT INTO invoices (
         invoice_number, issue_date, period_start, period_end,
         company_name, company_address, tax_id,
         plan_name, accounts_count, branches_count, max_branches, max_users,
         amount, currency, notes, created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
       ) RETURNING *`,
      [
        invoice_number,
        issue_date || new Date(),
        period_start || null,
        period_end || null,
        company_name || "",
        company_address || "",
        tax_id || "",
        plan_name || "",
        accounts_count ?? measured?.users ?? 0,
        branches_count ?? measured?.branches ?? 0,
        max_branches ?? null,
        max_users ?? null,
        amount || 0,
        currency || "USD",
        notes || "",
        created_by || req.user?.username || "admin",
      ]
    );
    res.json({ ok: true, invoice: q.rows[0], amountLabel: money(amount || 0, currency).formatted });
  } catch (e) {
    console.error("POST /api/invoices ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});
};
