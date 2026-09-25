module.exports = async function ensureSchema({ pool, genSalt, hashPw }) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      reporter TEXT,
      type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS images (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INT NOT NULL,
      width INT, height INT,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reports_type ON reports(type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);`);

  // Backs `GET /api/reports?type=&from=&to=` — the business-date window the
  // report screens ask for. The expression must stay identical to
  // BUSINESS_DATE in routes/reports.cjs, or the planner drops to a seq scan.
  //
  // Payload-only on purpose: an index expression has to be IMMUTABLE, and
  // created_at needs to_char/::date, both of which are only STABLE. Every
  // report type writes one of these three keys anyway.
  //
  // Wrapped like ux_reports_ref_no below: a failure here must not stop boot.
  await pool.query(`
    DO $$
    BEGIN
      CREATE INDEX IF NOT EXISTS idx_reports_business_date ON reports (
        type,
        (COALESCE(
          NULLIF(payload->>'cutDate', ''),
          NULLIF(payload->>'date', ''),
          NULLIF(LEFT(payload->>'reportDate', 10), '')
        ))
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'idx_reports_business_date not created: %', SQLERRM;
    END $$;
  `);

  // Human-readable reference numbers (AM-CND-000142). One continuous counter
  // per report type — never reset, so a reference is unique for all time.
  // Bumped atomically inside the INSERT transaction in routes/reports.cjs, so
  // two concurrent saves can never be handed the same number.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_counters (
      type TEXT PRIMARY KEY,
      last BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Lookups by reference (the "ref:" search token) and a guard against a
  // backfill or a bad import handing out the same number twice.
  // Wrapped: if legacy data already holds a duplicate refNo the index cannot be
  // built, and that must not take the whole server down on boot — log and move
  // on, then fix the duplicates with the backfill tool.
  await pool.query(`
    DO $$
    BEGIN
      CREATE UNIQUE INDEX IF NOT EXISTS ux_reports_ref_no
        ON reports ((payload->>'refNo'))
        WHERE payload->>'refNo' IS NOT NULL;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ux_reports_ref_no not created: %', SQLERRM;
    END $$;
  `);

  // One report per (type, reportDate) — EXCEPT 'maintenance', which has many
  // requests per day (each identified by its own requestNo). Migrate any old
  // non-partial index to the partial form. Idempotent / safe to run every boot.
  await pool.query(`
    DO $$
    DECLARE
      def text;
    BEGIN
      SELECT indexdef INTO def FROM pg_indexes
        WHERE schemaname='public' AND indexname='ux_reports_type_reportdate';

      IF def IS NOT NULL AND position('WHERE' IN upper(def)) = 0 THEN
        -- existing index is the old GLOBAL one → drop so we can make it partial
        EXECUTE 'DROP INDEX ux_reports_type_reportdate';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname='public' AND indexname='ux_reports_type_reportdate'
      ) THEN
        EXECUTE 'CREATE UNIQUE INDEX ux_reports_type_reportdate '
             || 'ON reports (type, ((payload->>''reportDate''))) '
             || 'WHERE type <> ''maintenance''';
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS product_catalog (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL DEFAULT 'default',
      code  TEXT NOT NULL,
      name  TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_product_catalog_scope_code') THEN
        EXECUTE 'CREATE UNIQUE INDEX ux_product_catalog_scope_code ON product_catalog (scope, code)';
      END IF;
    END $$;
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_product_catalog_scope ON product_catalog (scope);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_links (
      token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_id BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      participant_slno TEXT,
      participant_name TEXT,
      module TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_training_links_report_id ON training_links(report_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_training_links_used_at ON training_links(used_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_training_links_expires_at ON training_links(expires_at);`);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_reports_training_quiztoken
    ON reports ((payload->>'quizToken'))
    WHERE type='training_session';
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS supplier_links (
      token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_id BIGINT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      supplier_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_supplier_links_report_id ON supplier_links(report_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_supplier_links_used_at ON supplier_links(used_at);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_supplier_links_expires_at ON supplier_links(expires_at);`);

  /* ── App Users & Activity Log ── */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
      username     TEXT    NOT NULL UNIQUE,
      display_name TEXT    NOT NULL DEFAULT '',
      password_hash TEXT   NOT NULL,
      salt         TEXT    NOT NULL,
      permissions  JSONB   NOT NULL DEFAULT '[]'::jsonb,
      crud_perms   JSONB   NOT NULL DEFAULT '{}'::jsonb,
      employees    JSONB   NOT NULL DEFAULT '[]'::jsonb,
      is_active    BOOLEAN NOT NULL DEFAULT true,
      is_admin     BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login   TIMESTAMPTZ
    );
  `);
  /* migrate: add columns to existing tables if not present */
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS crud_perms        JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS employees          JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS allowed_branches   JSONB NOT NULL DEFAULT '[]'::jsonb`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id        BIGSERIAL PRIMARY KEY,
      user_id   UUID,
      username  TEXT NOT NULL,
      action    TEXT NOT NULL,
      detail    JSONB NOT NULL DEFAULT '{}'::jsonb,
      ip_addr   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_log_username ON activity_log(username);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);`);

  /* ── Report audit trail (ISO 22000 §7.5 / FDA 21 CFR Part 11) ──
     Every UPDATE/DELETE on the reports table is recorded here with the
     full before/after payloads, so an admin can always answer: who
     changed what, when, and what the old value was. Rows are written
     fire-and-forget from routes/reports.cjs — never blocks the save. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_audit (
      id          BIGSERIAL PRIMARY KEY,
      report_id   BIGINT,
      report_type TEXT NOT NULL,
      action      TEXT NOT NULL,              -- 'update' | 'delete'
      username    TEXT NOT NULL DEFAULT 'unknown',
      old_payload JSONB,
      new_payload JSONB,
      route       TEXT,
      ip_addr     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_audit_created_at ON report_audit(created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_audit_type ON report_audit(report_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_audit_username ON report_audit(username);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_audit_report_id ON report_audit(report_id);`);

  /* ── is_super_admin column ── */
  await pool.query(`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false`);

  /* ── Subscription table ── */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS subscription (
      id          SERIAL PRIMARY KEY,
      plan        VARCHAR(50)    NOT NULL DEFAULT 'enterprise',
      status      VARCHAR(20)    NOT NULL DEFAULT 'active',
      start_date  DATE           NOT NULL DEFAULT CURRENT_DATE,
      end_date    DATE           NOT NULL DEFAULT (CURRENT_DATE + INTERVAL '365 days'),
      price       NUMERIC(10,2),
      currency    VARCHAR(10)    NOT NULL DEFAULT 'AED',
      notes       TEXT           NOT NULL DEFAULT '',
      updated_by  TEXT           NOT NULL DEFAULT 'system',
      updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
    );
  `);
  /* Seed default subscription if empty */
  await pool.query(`
    INSERT INTO subscription (plan, status, start_date, end_date, notes, updated_by)
    SELECT 'enterprise', 'active', '2026-01-01', '2027-01-01', 'Initial subscription', 'system'
    WHERE NOT EXISTS (SELECT 1 FROM subscription LIMIT 1)
  `);

  /* ── Plans table ── */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id            SERIAL PRIMARY KEY,
      name          TEXT           NOT NULL UNIQUE,
      price         NUMERIC(10,2)  NOT NULL DEFAULT 0,
      currency      VARCHAR(10)    NOT NULL DEFAULT 'AED',
      setup_fee     NUMERIC(10,2)  NOT NULL DEFAULT 0,
      max_branches  INT            NOT NULL DEFAULT -1,
      max_users     INT            NOT NULL DEFAULT -1,
      description   TEXT           NOT NULL DEFAULT '',
      is_active     BOOLEAN        NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
    );
  `);
  /* Seed default plans — pricing is in AED (UAE dirham). Monthly fee is the
     recurring charge; setup_fee is a ONE-TIME onboarding cost. Lowest tier
     starts at AED 1500/month. Only seeds a brand-new empty install. */
  await pool.query(`
    INSERT INTO plans (name, price, currency, setup_fee, max_branches, max_users, description) VALUES
      ('Starter',    1500, 'AED', 2500,  5,  3,  'Small operations up to 5 branches'),
      ('Growth',     2500, 'AED', 4000, 15, 10,  'Growing businesses up to 15 branches'),
      ('Enterprise', 4000, 'AED', 6000, -1, -1,  'Unlimited branches and users')
    ON CONFLICT (name) DO NOTHING
  `);

  /* ── Companies table ── */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id            SERIAL PRIMARY KEY,
      name          TEXT           NOT NULL,
      contact_name  TEXT           NOT NULL DEFAULT '',
      contact_email TEXT           NOT NULL DEFAULT '',
      contact_phone TEXT           NOT NULL DEFAULT '',
      plan_id       INT            REFERENCES plans(id) ON DELETE SET NULL,
      status        VARCHAR(20)    NOT NULL DEFAULT 'active',
      start_date    DATE,
      end_date      DATE,
      notes         TEXT           NOT NULL DEFAULT '',
      created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
    );
  `);
  /* Seed current company if empty */
  await pool.query(`
    INSERT INTO companies (name, status, start_date, end_date, notes)
    SELECT 'Al Mawashi', 'active', '2026-01-01', '2027-01-01', 'Primary client'
    WHERE NOT EXISTS (SELECT 1 FROM companies LIMIT 1)
  `);

  /* ── Industry / business template per company ──
     Decides WHICH set of report templates a company runs. 'meat' = the full
     hardcoded Al Mawashi system (POS branches, QCS, HACCP, …) — the default,
     so every existing company and Al Mawashi itself keep working untouched.
     Any other value (e.g. 'sweets') routes the company to the generic,
     file-defined template engine instead. The report DATA is already isolated
     by company_id; this only chooses which forms/cards that company sees. */
  await pool.query(`
    ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS industry TEXT NOT NULL DEFAULT 'meat'
  `);

  /* ── Multi-tenant: link app_users → companies ──
     Added AFTER companies table+seed exist so the FK resolves.
     company_id NULL = platform-level account (super-admin: sees all companies). */
  await pool.query(`
    ALTER TABLE app_users
      ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_users_company_id ON app_users(company_id)`);
  /* Backfill: existing non-super-admin users with no company → primary (oldest) company.
     Super-admins stay NULL = platform owner. */
  await pool.query(`
    UPDATE app_users
       SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1)
     WHERE company_id IS NULL
       AND is_super_admin = false
  `);

  /* ── Multi-tenant: link reports → companies ──
     Unlike app_users, a report row is never "platform-level" — every report
     was filed inside some company's operation, so NULL never persists here.
     Existing rows (recorded before multi-tenant existed) backfill to the
     same primary company app_users used above: one rule for "no company on
     record yet", not a different one per table. New companies get their own
     real id from here on, and every report saved for them carries it. */
  await pool.query(`
    ALTER TABLE reports
      ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE SET NULL
  `);

  /* CRITICAL ORDERING: drop the unique index BEFORE the backfill UPDATE.
     The stack trace on the repeated boot crash pointed at the UPDATE line,
     not the CREATE INDEX line — because a PRIOR deploy had already built the
     widened unique index on (COALESCE(company_id,1), type, reportDate).
     With that index live, the moment this UPDATE flips two same-date rows
     of a genuinely-duplicated type (prod_dried_meat, 2026-07-02) from NULL
     to the same company id, they both map to the same key → 23505, and the
     whole boot dies before any later "exclude duplicates" logic can run.
     Dropping the index first means the backfill can never collide; the index
     is rebuilt (excluding still-duplicated types) further down. */
  await pool.query(`DROP INDEX IF EXISTS ux_reports_type_reportdate`).catch((e) =>
    console.warn("[schema] pre-backfill drop of ux_reports_type_reportdate skipped:", e?.message || e)
  );

  await pool.query(`
    UPDATE reports
       SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1)
     WHERE company_id IS NULL
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reports_company_id ON reports(company_id)`);

  /* Widen the one-report-per-(type,reportDate) rule to per-company.
     Done from plain JS, not a dynamic-SQL DO block: a first attempt at this
     used a plpgsql EXCEPTION handler around the same logic and it still took
     the whole server down twice on real duplicate data (prod_dried_meat had
     two rows for the same date — a real data bug, not a maintenance-style
     "many per day" type). Whatever the exact cause, a plpgsql-level safety
     net cannot be trusted here; a plain JS try/catch around the actual
     `await` cannot fail to catch it — Node has no equivalent ambiguity. */
  try {
    const { rows: idxRows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='ux_reports_type_reportdate'`
    );
    const currentDef = idxRows[0]?.indexdef || null;
    if (currentDef && !currentDef.includes("company_id")) {
      await pool.query(`DROP INDEX ux_reports_type_reportdate`);
    }

    const { rows: stillThere } = await pool.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_reports_type_reportdate'`
    );
    if (!stillThere.length) {
      // أي نوع عنده أصلاً أكتر من سجل بنفس (الشركة، التاريخ) بيستثنى من
      // القيد — تمامًا متل maintenance من زمان — بدل ما يوقف الإقلاع. لازم
      // حدا يراجع كل نوع بالقائمة يدويًا: إما ينضّف الازدواج (وبيرجع يتحمي
      // تلقائيًا بأول إقلاع بعدها)، أو يثبت إنه فعلاً نوع "أكتر من سجل
      // باليوم" وينضاف بشكل دائم جنب maintenance بالكود.
      const { rows: dupRows } = await pool.query(`
        SELECT type
          FROM reports
         WHERE type <> 'maintenance' AND payload->>'reportDate' IS NOT NULL
         GROUP BY type, COALESCE(company_id, 1), payload->>'reportDate'
        HAVING COUNT(*) > 1
      `);
      const dupTypes = [...new Set(dupRows.map((r) => r.type))];
      if (dupTypes.length) {
        console.warn(
          `[schema] ux_reports_type_reportdate: excluding types with pre-existing duplicate ` +
            `(company,type,reportDate) rows — review and clean up manually: ${dupTypes.join(", ")}`
        );
      }
      const exclude = dupTypes.length
        ? ` AND type NOT IN (${dupTypes.map((t) => `'${String(t).replace(/'/g, "''")}'`).join(",")})`
        : "";
      await pool.query(`
        CREATE UNIQUE INDEX ux_reports_type_reportdate
          ON reports (COALESCE(company_id, 1), type, ((payload->>'reportDate')))
         WHERE type <> 'maintenance'${exclude}
      `);
    }
  } catch (e) {
    console.warn("[schema] ux_reports_type_reportdate widen skipped:", e?.message || e);
  }

  /* Same widening for the business-date range index (backs ?from=&to=).
     Not a UNIQUE index, so it can't hit a duplicate-key error the way the
     one above did — kept as plain JS too, for the same easier-to-trust
     reasoning as above rather than mixing styles. */
  try {
    const { rows: idxRows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND indexname='idx_reports_business_date'`
    );
    const currentDef = idxRows[0]?.indexdef || null;
    if (currentDef && !currentDef.includes("company_id")) {
      await pool.query(`DROP INDEX idx_reports_business_date`);
    }
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_reports_business_date ON reports (
        COALESCE(company_id, 1),
        type,
        (COALESCE(
          NULLIF(payload->>'cutDate', ''),
          NULLIF(payload->>'date', ''),
          NULLIF(LEFT(payload->>'reportDate', 10), '')
        ))
      )
    `);
  } catch (e) {
    console.warn("[schema] idx_reports_business_date widen skipped:", e?.message || e);
  }

  /* ── Seed default admin if table is empty ── */
  const existsAdmin = await pool.query(`SELECT 1 FROM app_users WHERE username='admin' LIMIT 1`);
  if (!existsAdmin.rowCount) {
    const salt = genSalt();
    const hash = hashPw("Admin@2025", salt);
    await pool.query(
      `INSERT INTO app_users (username, display_name, password_hash, salt, permissions, is_admin, is_super_admin)
       VALUES ('admin', 'Administrator', $1, $2, '["*"]'::jsonb, true, true)`,
      [hash, salt]
    );
    console.log("✅ Default admin created (admin / Admin@2025)");
  }
  /* Promote existing admin to super admin if not yet */
  await pool.query(`UPDATE app_users SET is_super_admin=true WHERE username='admin' AND is_super_admin=false`);

  /* ── Presence / visitor analytics ── */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS presence (
      visitor_id TEXT PRIMARY KEY,
      last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON presence(last_seen);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_visits (
      day        DATE NOT NULL,
      visitor_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (day, visitor_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_visits_day ON daily_visits(day);`);

  /* ── Billing profile (single-row) — buyer info pre-fills every invoice ── */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS billing_profile (
      id              SERIAL PRIMARY KEY,
      company_name    TEXT          NOT NULL DEFAULT '',
      company_address TEXT          NOT NULL DEFAULT '',
      tax_id          TEXT          NOT NULL DEFAULT '',
      contact_email   TEXT          NOT NULL DEFAULT '',
      contact_phone   TEXT          NOT NULL DEFAULT '',
      notes           TEXT          NOT NULL DEFAULT '',
      updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
  `);
  /* Seed empty row so PUT-update pattern always finds a target */
  await pool.query(`
    INSERT INTO billing_profile (company_name)
    SELECT '' WHERE NOT EXISTS (SELECT 1 FROM billing_profile LIMIT 1)
  `);

  /* ── Invoices — snapshot of subscription state at issuance time ── */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id              SERIAL PRIMARY KEY,
      invoice_number  TEXT          NOT NULL,
      issue_date      DATE          NOT NULL DEFAULT CURRENT_DATE,
      period_start    DATE,
      period_end      DATE,
      company_name    TEXT          NOT NULL DEFAULT '',
      company_address TEXT          NOT NULL DEFAULT '',
      tax_id          TEXT          NOT NULL DEFAULT '',
      plan_name       TEXT          NOT NULL DEFAULT '',
      accounts_count  INT           NOT NULL DEFAULT 0,
      branches_count  INT           NOT NULL DEFAULT 0,
      max_branches    INT,
      max_users       INT,
      amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
      currency        VARCHAR(10)   NOT NULL DEFAULT 'USD',
      notes           TEXT          NOT NULL DEFAULT '',
      created_by      TEXT          NOT NULL DEFAULT 'admin',
      created_at      TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices(issue_date DESC);`);

  /* ════════════════════════════════════════════════════════════
     EMAIL HISTORY — audit log of every email sent from the app.
     METADATA ONLY (no body, no PDF binary) so the table stays small.
     Designed for ISO/BRCGS audit trail + Analytics dashboard.
  ═════════════════════════════════════════════════════════════ */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_history (
      id               SERIAL PRIMARY KEY,
      sent_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
      sent_by          TEXT          NOT NULL DEFAULT '',
      report_type      TEXT          NOT NULL DEFAULT '',
      report_title     TEXT          NOT NULL DEFAULT '',
      report_date      DATE,
      subject          TEXT          NOT NULL DEFAULT '',
      to_emails        JSONB         NOT NULL DEFAULT '[]'::jsonb,
      cc_emails        JSONB         NOT NULL DEFAULT '[]'::jsonb,
      bcc_emails       JSONB         NOT NULL DEFAULT '[]'::jsonb,
      recipient_count  INT           NOT NULL DEFAULT 0,
      classification   VARCHAR(20)   NOT NULL DEFAULT 'internal',
      priority         VARCHAR(10)   NOT NULL DEFAULT 'normal',
      method           VARCHAR(20)   NOT NULL DEFAULT 'outlook',
      attachment_count INT           NOT NULL DEFAULT 0,
      note             TEXT          NOT NULL DEFAULT '',
      template_id      TEXT,
      status           VARCHAR(20)   NOT NULL DEFAULT 'sent',
      created_at       TIMESTAMPTZ   NOT NULL DEFAULT now()
    );
  `);
  /* The reference of the exact record that was mailed ("AM-NCR-000042").
     report_date alone can no longer identify a report — several NCRs share a
     day, one per branch — so a per-report send history needs this. Added as an
     ALTER so existing installs pick it up on boot; old rows stay NULL. */
  await pool.query(`ALTER TABLE email_history ADD COLUMN IF NOT EXISTS report_ref TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_hist_report_ref  ON email_history(report_ref);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_hist_sent_at     ON email_history(sent_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_hist_report_type ON email_history(report_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_hist_sent_by     ON email_history(sent_by);`);

  /* ════════════════════════════════════════════════════════════
     MULTI-TENANT — company_id on the auxiliary tables.

     The `reports` table has carried company_id for a while, but the
     audit trail, the e-mail log and the subscription record had not —
     so one company could still read another company's change history,
     e-mail analytics or subscription state. These are additive ALTERs:
     every pre-existing row defaults to the primary company (id 1 =
     Al Mawashi), so nothing an existing company sees changes until a
     second company's own rows start to arrive. All wrapped so a single
     failed step can never take boot down (see the reports notes above).
  ═════════════════════════════════════════════════════════════ */

  /* report_audit → company_id. Backfill from the linked report's company
     (the truth); rows whose report was already deleted fall back to 1. */
  try {
    await pool.query(`ALTER TABLE report_audit ADD COLUMN IF NOT EXISTS company_id INT`);
    await pool.query(`
      UPDATE report_audit a
         SET company_id = COALESCE(
               (SELECT r.company_id FROM reports r WHERE r.id = a.report_id),
               1)
       WHERE a.company_id IS NULL
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_report_audit_company_id ON report_audit(company_id)`);
  } catch (e) {
    console.warn("[schema] report_audit company_id step skipped:", e?.message || e);
  }

  /* email_history → company_id. No per-row source to join, so every
     existing send belongs to the primary company. */
  try {
    await pool.query(`ALTER TABLE email_history ADD COLUMN IF NOT EXISTS company_id INT`);
    await pool.query(`UPDATE email_history SET company_id = 1 WHERE company_id IS NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_hist_company_id ON email_history(company_id)`);
  } catch (e) {
    console.warn("[schema] email_history company_id step skipped:", e?.message || e);
  }

  /* subscription → one row PER company. The old table held a single
     global row (the whole platform shared one subscription); it becomes
     company 1's. Historical duplicates are collapsed to the newest row
     per company before the unique index so the ON CONFLICT upsert in
     routes/billing.cjs has a stable target. */
  try {
    await pool.query(`ALTER TABLE subscription ADD COLUMN IF NOT EXISTS company_id INT`);
    await pool.query(`UPDATE subscription SET company_id = 1 WHERE company_id IS NULL`);
    await pool.query(`
      DELETE FROM subscription s
       WHERE s.id < (SELECT MAX(s2.id) FROM subscription s2 WHERE s2.company_id = s.company_id)
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_subscription_company ON subscription(company_id)`);
  } catch (e) {
    console.warn("[schema] subscription company_id step skipped:", e?.message || e);
  }

  /* plans → one-time setup_fee (recurring price stays in `price`). Additive:
     existing plans default to a 0 setup fee until an admin sets one. */
  try {
    await pool.query(`ALTER TABLE plans ADD COLUMN IF NOT EXISTS setup_fee NUMERIC(10,2) NOT NULL DEFAULT 0`);
  } catch (e) {
    console.warn("[schema] plans setup_fee step skipped:", e?.message || e);
  }

  /* Re-price the ORIGINAL seed plans from the old USD placeholders to the real
     AED pricing (lowest tier = AED 1500/mo + one-time setup fee). Guarded to
     the exact untouched seed rows (name + old price + USD), so a plan an admin
     has already edited is never overwritten. Idempotent: once converted the
     WHERE no longer matches. */
  try {
    await pool.query(`UPDATE plans SET price=1500, currency='AED', setup_fee=2500 WHERE name='Starter'    AND currency='USD' AND price=49`);
    await pool.query(`UPDATE plans SET price=2500, currency='AED', setup_fee=4000 WHERE name='Growth'     AND currency='USD' AND price=99`);
    await pool.query(`UPDATE plans SET price=4000, currency='AED', setup_fee=6000 WHERE name='Enterprise' AND currency='USD' AND price=199`);
  } catch (e) {
    console.warn("[schema] plans AED re-price step skipped:", e?.message || e);
  }

  /* billing_profile → the SELLER: INSPECT PRO, the platform owner, printed
     at the top of every quotation and invoice. It used to be one ambiguous
     row that quotations read as the issuer and invoices read as the buyer.
     Additive only; existing values stay. company_name keeps meaning the
     trade name and tax_id the TRN, so nothing that already reads them moves.
     vat_registered defaults to false: a freelancer without a TRN may not
     charge VAT, so documents stay "Invoice", never "Tax Invoice". */
  try {
    const cols = [
      "owner_name        TEXT    NOT NULL DEFAULT ''",
      "license_status    TEXT    NOT NULL DEFAULT 'pending'",
      "license_no        TEXT    NOT NULL DEFAULT ''",
      "license_authority TEXT    NOT NULL DEFAULT ''",
      "license_expiry    DATE",
      "vat_registered    BOOLEAN NOT NULL DEFAULT false",
      "website           TEXT    NOT NULL DEFAULT ''",
      "logo_url          TEXT    NOT NULL DEFAULT ''",
      "bank_name         TEXT    NOT NULL DEFAULT ''",
      "account_name      TEXT    NOT NULL DEFAULT ''",
      "iban              TEXT    NOT NULL DEFAULT ''",
      "swift             TEXT    NOT NULL DEFAULT ''",
      "payment_terms_days INT    NOT NULL DEFAULT 14",
    ];
    for (const c of cols) {
      await pool.query(`ALTER TABLE billing_profile ADD COLUMN IF NOT EXISTS ${c}`);
    }
    await pool.query(`UPDATE billing_profile SET company_name = 'INSPECT PRO' WHERE company_name = ''`);
  } catch (e) {
    console.warn("[schema] billing_profile seller step skipped:", e?.message || e);
  }

  /* INSPECT PRO's own sales documents. Quotations used to live in `reports`
     pinned to company_id = 1, i.e. inside Al Mawashi's data: its backups,
     its data inventory, its audit trail. They are the platform owner's, not
     a tenant's, so they get tables of their own that no company scope ever
     reaches. `payload` keeps the full quotation exactly as the editor
     built it; the columns beside it are just what lists sort and filter on. */
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_quotations (
        id                SERIAL PRIMARY KEY,
        number            TEXT          NOT NULL,
        status            TEXT          NOT NULL DEFAULT 'draft',
        client_company_id INT           REFERENCES companies(id) ON DELETE SET NULL,
        client_name       TEXT          NOT NULL DEFAULT '',
        issue_date        DATE,
        currency          TEXT          NOT NULL DEFAULT 'AED',
        contract_value    NUMERIC(14,2) NOT NULL DEFAULT 0,
        payload           JSONB         NOT NULL DEFAULT '{}'::jsonb,
        created_by        TEXT          NOT NULL DEFAULT '',
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
        updated_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_platform_quotations_number ON platform_quotations(number)`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key        TEXT        PRIMARY KEY,
        value      JSONB       NOT NULL DEFAULT '{}'::jsonb,
        updated_by TEXT        NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  } catch (e) {
    console.warn("[schema] platform_quotations tables step skipped:", e?.message || e);
  }

  /* invoices → issued BY INSPECT PRO TO a company. Each invoice now knows
     which company it bills (company_id), freezes the seller as it was on
     the day (seller JSONB — later profile edits never rewrite an issued
     invoice), carries its own lines and VAT split, and has a payment
     status. Additive; old rows keep their values and are matched to a
     company by name once, where the name is unambiguous. */
  try {
    const cols = [
      "company_id   INT REFERENCES companies(id) ON DELETE SET NULL",
      "status       TEXT          NOT NULL DEFAULT 'unpaid'",
      "title        TEXT          NOT NULL DEFAULT 'Invoice'",
      "due_date     DATE",
      "paid_at      DATE",
      "payment_ref  TEXT          NOT NULL DEFAULT ''",
      "void_reason  TEXT          NOT NULL DEFAULT ''",
      "subtotal     NUMERIC(14,2)",
      "vat_pct      NUMERIC(5,2)  NOT NULL DEFAULT 0",
      "vat_amount   NUMERIC(14,2) NOT NULL DEFAULT 0",
      "lines        JSONB         NOT NULL DEFAULT '[]'::jsonb",
      "seller       JSONB         NOT NULL DEFAULT '{}'::jsonb",
      "buyer_contact TEXT         NOT NULL DEFAULT ''",
      "buyer_email  TEXT          NOT NULL DEFAULT ''",
    ];
    for (const c of cols) await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ${c}`);
    await pool.query(`
      UPDATE invoices i SET company_id = c.id
        FROM companies c
       WHERE i.company_id IS NULL
         AND lower(trim(i.company_name)) = lower(trim(c.name))
         AND (SELECT COUNT(*) FROM companies c2 WHERE lower(trim(c2.name)) = lower(trim(c.name))) = 1
    `);
    await pool.query(`UPDATE invoices SET subtotal = amount WHERE subtotal IS NULL`);
  } catch (e) {
    console.warn("[schema] invoices per-company step skipped:", e?.message || e);
  }
  /* Invoice numbers are legal identifiers — never two alike. Separate step:
     if old data already holds a duplicate, the index is skipped (logged)
     and everything above still applies. */
  try {
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_number ON invoices(invoice_number)`);
  } catch (e) {
    console.warn("[schema] ux_invoices_number skipped (duplicate numbers in old data):", e?.message || e);
  }

  /* ONE source for "what does this company have and until when": its row in
     `companies`. The login lock (routes/admin.cjs) already reads only that
     row, while the in-app lock read the separate `subscription` table — two
     answers that could disagree. `subscription` is now retired (kept, never
     read): its custom price/currency and any plan/date the company row lacks
     are folded in once. The company's status is NOT overwritten — it is the
     one the server has been enforcing all along. */
  try {
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS price    NUMERIC(10,2)`);
    await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS currency TEXT`);
    const done = await pool.query(`SELECT 1 FROM platform_settings WHERE key = 'migrated_subscription_to_companies'`);
    if (!done.rowCount) {
      await pool.query(`
        UPDATE companies c SET
          price      = COALESCE(c.price, s.price),
          currency   = COALESCE(c.currency, NULLIF(s.currency, '')),
          plan_id    = COALESCE(c.plan_id, (SELECT p.id FROM plans p WHERE lower(p.name) = lower(s.plan) LIMIT 1)),
          start_date = COALESCE(c.start_date, s.start_date),
          end_date   = COALESCE(c.end_date, s.end_date)
        FROM subscription s
        WHERE s.company_id = c.id
          AND COALESCE(s.updated_by, '') <> 'system'  -- auto-seeded placeholders carry no real data
      `);
      await pool.query(
        `INSERT INTO platform_settings (key, value, updated_by) VALUES ('migrated_subscription_to_companies', '{"v":1}', 'migration')
         ON CONFLICT (key) DO NOTHING`
      );
    }
  } catch (e) {
    console.warn("[schema] subscription → companies step skipped:", e?.message || e);
  }

  /* One-time move of the existing quotations out of `reports`. All or
     nothing in one transaction: the rows are copied, then deleted from
     `reports`, so a quotation can never exist in both places or in neither.
     Runs only while the new table is still empty, so it never repeats.
     A duplicated number (the old store allowed it) keeps the first and
     suffixes the rest, rather than failing the whole move. */
  {
    const client = await pool.connect().catch((e) => {
      console.warn("[schema] quotation move: no DB client:", e?.message || e);
      return null;
    });
    if (client) {
      try {
        await client.query("BEGIN");
        const already = await client.query(`SELECT 1 FROM platform_quotations LIMIT 1`);
        const pending = await client.query(
          `SELECT 1 FROM reports WHERE type IN ('billing_quotation','billing_quotation_config') LIMIT 1`
        );
        if (!already.rowCount && pending.rowCount) {
          const moved = await client.query(`
            WITH src AS (
              SELECT r.*,
                     COALESCE(NULLIF(r.payload->>'number',''), 'Q-OLD-' || r.id) AS num,
                     ROW_NUMBER() OVER (
                       PARTITION BY COALESCE(NULLIF(r.payload->>'number',''), 'Q-OLD-' || r.id)
                       ORDER BY r.id
                     ) AS dup
                FROM reports r
               WHERE r.type = 'billing_quotation'
            )
            INSERT INTO platform_quotations
              (number, status, client_company_id, client_name, issue_date, currency,
               contract_value, payload, created_by, created_at, updated_at)
            SELECT CASE WHEN dup = 1 THEN num ELSE num || '-' || dup END,
                   COALESCE(NULLIF(payload->>'status',''), 'draft'),
                   CASE WHEN payload->>'companyId' ~ '^[0-9]+$'
                         AND EXISTS (SELECT 1 FROM companies c WHERE c.id = (payload->>'companyId')::int)
                        THEN (payload->>'companyId')::int END,
                   COALESCE(payload->>'clientName', ''),
                   CASE WHEN payload->>'issueDate' ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN (payload->>'issueDate')::date END,
                   COALESCE(NULLIF(payload->>'currency',''), 'AED'),
                   CASE WHEN payload#>>'{totals,contractValue}' ~ '^-?[0-9.]+$'
                        THEN (payload#>>'{totals,contractValue}')::numeric ELSE 0 END,
                   (payload - 'reportDate')
                     || jsonb_build_object('number', CASE WHEN dup = 1 THEN num ELSE num || '-' || dup END),
                   COALESCE(reporter, ''), created_at, updated_at
              FROM src
          `);
          /* The settings row: newest wins. A logo that was stored inline
             (base64) is dropped — the logo lives in the seller profile now. */
          await client.query(`
            INSERT INTO platform_settings (key, value, updated_by, updated_at)
            SELECT 'quotation_config',
                   CASE WHEN payload->>'logo' LIKE 'data:%' THEN payload - 'logo' ELSE payload END
                     - 'reportDate' - '_clientSavedAt',
                   'migration', updated_at
              FROM reports
             WHERE type = 'billing_quotation_config'
             ORDER BY updated_at DESC, id DESC
             LIMIT 1
            ON CONFLICT (key) DO NOTHING
          `);
          const gone = await client.query(
            `DELETE FROM reports WHERE type IN ('billing_quotation','billing_quotation_config')`
          );
          console.log(
            `[schema] moved ${moved.rowCount} quotation(s) to platform_quotations; ` +
              `removed ${gone.rowCount} row(s) from reports`
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        console.warn("[schema] quotation move skipped (rolled back, nothing lost):", e?.message || e);
      } finally {
        client.release();
      }
    }
  }
}
