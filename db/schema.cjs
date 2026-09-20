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
      currency    VARCHAR(10)    NOT NULL DEFAULT 'USD',
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
      currency      VARCHAR(10)    NOT NULL DEFAULT 'USD',
      max_branches  INT            NOT NULL DEFAULT -1,
      max_users     INT            NOT NULL DEFAULT -1,
      description   TEXT           NOT NULL DEFAULT '',
      is_active     BOOLEAN        NOT NULL DEFAULT true,
      created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ    NOT NULL DEFAULT now()
    );
  `);
  /* Seed default plans */
  await pool.query(`
    INSERT INTO plans (name, price, currency, max_branches, max_users, description) VALUES
      ('Starter',    49,  'USD',  5,  3,  'Small operations up to 5 branches'),
      ('Growth',     99,  'USD', 15, 10,  'Growing businesses up to 15 branches'),
      ('Enterprise', 199, 'USD', -1, -1,  'Unlimited branches and users')
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
  await pool.query(`
    UPDATE reports
       SET company_id = (SELECT id FROM companies ORDER BY id ASC LIMIT 1)
     WHERE company_id IS NULL
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reports_company_id ON reports(company_id)`);

  /* Widen the one-report-per-(type,reportDate) rule to per-company, the same
     way it was earlier migrated from global to partial (see the block above
     product_catalog): detect the old two-column shape, drop it, rebuild with
     company_id leading. COALESCE(company_id,1) is a safety net only — every
     row is backfilled above, so it should never actually see a NULL. */
  await pool.query(`
    DO $$
    DECLARE
      def text;
      dup_types text;
    BEGIN
      SELECT indexdef INTO def FROM pg_indexes
        WHERE schemaname='public' AND indexname='ux_reports_type_reportdate';

      IF def IS NOT NULL AND position('company_id' IN def) = 0 THEN
        EXECUTE 'DROP INDEX ux_reports_type_reportdate';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname='public' AND indexname='ux_reports_type_reportdate'
      ) THEN
        -- أي نوع عنده أصلاً أكتر من سجل بنفس (الشركة، التاريخ) بيبقى مستثنى
        -- من القيد، تمامًا متل maintenance من زمان: القيد ما بيقدر يتفرض على
        -- بيانات مخالفة له أصلاً موجودة قبل ما ينضاف، وإلا كل إقلاع السيرفر
        -- بيفشل (هيك بالضبط صار مع prod_dried_meat). النوع المستثنى هون
        -- بيرجع يتحمي تلقائيًا بأول إقلاع بعد ما حدا ينضّف الازدواج يدويًا،
        -- أو ينضاف لقائمة "أكتر من سجل باليوم" الدائمة جنب maintenance لو
        -- تبيّن إنه متعمّد.
        SELECT string_agg(DISTINCT quote_literal(t), ',') INTO dup_types
          FROM (
            SELECT type AS t
              FROM reports
             WHERE type <> 'maintenance' AND payload->>'reportDate' IS NOT NULL
             GROUP BY type, COALESCE(company_id, 1), payload->>'reportDate'
            HAVING COUNT(*) > 1
          ) x;

        IF dup_types IS NOT NULL THEN
          RAISE WARNING 'ux_reports_type_reportdate: excluding types with pre-existing duplicate (company,type,reportDate) rows: %', dup_types;
        END IF;

        EXECUTE 'CREATE UNIQUE INDEX ux_reports_type_reportdate '
             || 'ON reports (COALESCE(company_id, 1), type, ((payload->>''reportDate''))) '
             || 'WHERE type <> ''maintenance'''
             || COALESCE(' AND type NOT IN (' || dup_types || ')', '');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'ux_reports_type_reportdate not created: %', SQLERRM;
    END $$;
  `);

  /* Same widening for the business-date range index (backs ?from=&to=). */
  await pool.query(`
    DO $$
    DECLARE
      def text;
    BEGIN
      SELECT indexdef INTO def FROM pg_indexes
        WHERE schemaname='public' AND indexname='idx_reports_business_date';
      IF def IS NOT NULL AND position('company_id' IN def) = 0 THEN
        EXECUTE 'DROP INDEX idx_reports_business_date';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'idx_reports_business_date drop skipped: %', SQLERRM;
    END $$;
  `);
  await pool.query(`
    DO $$
    BEGIN
      CREATE INDEX IF NOT EXISTS idx_reports_business_date ON reports (
        COALESCE(company_id, 1),
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
}
