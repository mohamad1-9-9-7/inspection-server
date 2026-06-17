// index.cjs — Open-CRUD backend (Express + Postgres) + Cloudinary upload (no sharp)
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const pg = require("pg");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 5000;

/* ========= DEPLOY FINGERPRINT ========= */
console.log("🔥 DEPLOY VERSION:", new Date().toISOString());
console.log("🔥 NODE_ENV:", process.env.NODE_ENV || "undefined");

/* --------- CORS --------- */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Authorization"],
  })
);

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* --------- Body Parser --------- */
app.use(express.json({ limit: "20mb" }));

/* --------- Postgres --------- */
const { Pool } = pg;

function withSSL(url) {
  if (!url) {
    console.error("❌ Missing DATABASE_URL");
    process.exit(1);
  }
  return url.includes("?") ? `${url}&sslmode=require` : `${url}?sslmode=require`;
}

const pool = new Pool({
  connectionString: withSSL(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  max: 5,
  idleTimeoutMillis: 10000,      // أغلق الاتصالات الخاملة بعد 10 ثوانٍ
  connectionTimeoutMillis: 5000, // لا تنتظر أكثر من 5 ثوانٍ للاتصال
});

// منع الكراش عند انقطاع اتصال Neon المفاجئ
pool.on("error", (err) => {
  console.error("⚠️ Pool connection error (auto-recovered):", err.message);
});

/* --------- Helpers --------- */
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

const parseMaybeJSON = (x) =>
  isObj(x)
    ? x
    : typeof x === "string"
    ? (() => {
        try {
          return JSON.parse(x);
        } catch {
          return x;
        }
      })()
    : x;

function clampInt(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  const x = Number.isFinite(n) ? n : def;
  return Math.max(min, Math.min(max, x));
}

function normText(v) {
  return String(v ?? "").trim();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function safeObj(x) {
  return isObj(x) ? x : {};
}

function normKey(s) {
  return String(s ?? "").trim().toLowerCase();
}

/* ─── Password helpers — scrypt (built-in, bcrypt-class security) ─── */
// New salts  : "scrypt:" + 64 hex chars  (N=16384 ~100ms per hash)
// Legacy salts: raw 32-char hex           (HMAC-SHA256, auto-upgraded on next login)
const SCRYPT_PFX    = "scrypt:";
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

function genSalt() {
  return SCRYPT_PFX + crypto.randomBytes(32).toString("hex");
}
function hashPw(password, salt) {
  if (salt.startsWith(SCRYPT_PFX)) {
    const rawSalt = Buffer.from(salt.slice(SCRYPT_PFX.length), "hex");
    return crypto.scryptSync(String(password), rawSalt, 64, SCRYPT_PARAMS).toString("hex");
  }
  // Legacy HMAC-SHA256 — only used during migration verification
  return crypto.createHmac("sha256", salt).update(String(password)).digest("hex");
}
function verifyPw(password, salt, hash) {
  return hashPw(password, salt) === hash;
}

/* ─── Rate Limiting — login endpoint ─── */
// Max 10 attempts per IP per 60 seconds; blocks brute-force attacks
const _loginAttempts = new Map(); // ip → { count, resetAt }
const RATE_MAX    = 10;
const RATE_WIN_MS = 60_000;

function rlCheck(ip) {
  const now = Date.now();
  let rec   = _loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + RATE_WIN_MS };
    _loginAttempts.set(ip, rec);
  }
  rec.count++;
  return rec.count <= RATE_MAX; // true = allowed
}
function rlReset(ip) { _loginAttempts.delete(ip); }

// Clean stale entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _loginAttempts)
    if (now > rec.resetAt) _loginAttempts.delete(ip);
}, 5 * 60_000);

/* --------- DB Schema --------- */
async function ensureSchema() {
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
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_hist_sent_at     ON email_history(sent_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_hist_report_type ON email_history(report_type);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_hist_sent_by     ON email_history(sent_by);`);
}

/* ============================================================
   Reports API
============================================================ */
app.get("/api/reports", async (req, res) => {
  try {
    const { type } = req.query;
    const lite = String(req.query?.lite || "").toLowerCase();
    const isLite = lite === "1" || lite === "true" || lite === "yes";
    const limit = clampInt(req.query?.limit, 200, 1, 5000);

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

app.post("/api/reports", async (req, res) => {
  try {
    const reporter = normText(req.body?.reporter || "anonymous");
    const type = normText(req.body?.type);
    const payload = req.body?.payload;

    if (!type) return res.status(400).json({ ok: false, error: "type required" });
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [reporter, type, JSON.stringify(payload)]
    );

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

app.put("/api/reports", async (req, res) => {
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

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE($1, reporter),
              payload=$2::jsonb,
              updated_at=now()
        WHERE type=$3 AND payload->>'reportDate'=$4
        RETURNING *`,
      [reporter || null, JSON.stringify(payload), type, reportDate]
    );

    if (upd.rowCount > 0) {
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [reporter, type, JSON.stringify(payload)]
    );

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

app.put("/api/reports/returns", async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { items = [], _clientSavedAt } = req.body || {};

    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });

    const payload = {
      reportDate,
      items: Array.isArray(items) ? items : [],
      _clientSavedAt: _clientSavedAt || Date.now(),
    };

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE(reporter,'anonymous'),
              payload=$1::jsonb,
              updated_at=now()
        WHERE type='returns' AND payload->>'reportDate'=$2
        RETURNING *`,
      [payload, reportDate]
    );

    if (upd.rowCount > 0) return res.json({ ok: true, report: upd.rows[0], method: "update" });

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload)
       VALUES ('anonymous','returns',$1::jsonb)
       RETURNING *`,
      [payload]
    );

    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/returns ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/qcs", async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { details = {}, _clientSavedAt } = req.body || {};
    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });

    const payload = {
      reportDate,
      details: isObj(details) ? details : {},
      _clientSavedAt: _clientSavedAt || Date.now(),
    };

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE(reporter,'anonymous'),
              payload=$1::jsonb,
              updated_at=now()
        WHERE type='qcs' AND payload->>'reportDate'=$2
        RETURNING *`,
      [payload, reportDate]
    );
    if (upd.rowCount > 0) return res.json({ ok: true, report: upd.rows[0], method: "update" });

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload)
       VALUES ('anonymous','qcs',$1::jsonb)
       RETURNING *`,
      [payload]
    );
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/qcs ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/:type([A-Za-z_][A-Za-z0-9_-]*)", async (req, res) => {
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

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE($1, reporter),
              payload=$2::jsonb,
              updated_at=now()
        WHERE type=$3 AND payload->>'reportDate'=$4
        RETURNING *`,
      [reporter || null, JSON.stringify(payload), type, reportDate]
    );

    if (upd.rowCount > 0) {
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      [reporter, type, JSON.stringify(payload)]
    );

    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/:type ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/reports/:id(\\d+)", async (req, res) => {
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

app.patch("/api/reports/:id(\\d+)", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad id" });

    const payload = req.body?.payload;
    const reporter = req.body?.reporter;

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const upd = await pool.query(
      `UPDATE reports
          SET payload=$1::jsonb,
              reporter=COALESCE($2, reporter),
              updated_at=now()
        WHERE id=$3
        RETURNING *`,
      [JSON.stringify(payload), reporter ? String(reporter) : null, id]
    );

    if (!upd.rowCount) return res.status(404).json({ ok: false, error: "not found" });
    return res.json({ ok: true, report: upd.rows[0] });
  } catch (e) {
    console.error("PATCH /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/:id(\\d+)", async (req, res) => {
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

    const upd = await pool.query(
      `UPDATE reports
          SET type = COALESCE(NULLIF($1,''), type),
              payload=$2::jsonb,
              updated_at=now()
        WHERE id=$3
        RETURNING *`,
      [type || null, JSON.stringify(payload), id]
    );

    if (!upd.rowCount) return res.status(404).json({ ok: false, error: "not found" });
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

app.delete("/api/reports", async (req, res) => {
  try {
    const { type, reportDate } = req.query;
    if (!type || !reportDate) return res.status(400).json({ ok: false, error: "type & reportDate required" });

    const { rowCount } = await pool.query(`DELETE FROM reports WHERE type=$1 AND payload->>'reportDate'=$2`, [
      type,
      reportDate,
    ]);
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/api/reports/:id(\\d+)", async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM reports WHERE id=$1`, [Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ======================================================================
   Supplier Links API (UUID token system)
====================================================================== */
const SUPPLIER_TYPE = "supplier_self_assessment_form";

app.post("/api/supplier-links", async (req, res) => {
  try {
    const reportId = Number(req.body?.reportId);
    const expiresInDays = clampInt(req.body?.expiresInDays, 14, 1, 120);

    if (!Number.isFinite(reportId) || reportId <= 0) {
      return res.status(400).json({ ok: false, error: "reportId required" });
    }

    const r = await pool.query(`SELECT id, type, payload FROM reports WHERE id=$1`, [reportId]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "report not found" });

    const report = r.rows[0];
    if (String(report.type) !== SUPPLIER_TYPE) {
      return res.status(400).json({ ok: false, error: "WRONG_REPORT_TYPE", expected: SUPPLIER_TYPE, got: report.type });
    }

    const payload = report.payload || {};
    const supplier_name =
      normText(req.body?.supplierName) || normText(payload?.fields?.company_name) || normText(payload?.company_name) || "";

    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const ins = await pool.query(
      `INSERT INTO supplier_links (report_id, supplier_name, expires_at, meta)
       VALUES ($1,$2,$3,$4::jsonb)
       RETURNING token, report_id, supplier_name, created_at, expires_at, used_at, meta`,
      [reportId, supplier_name || null, expiresAt, JSON.stringify({ createdBy: "admin" })]
    );

    return res.status(201).json({ ok: true, link: ins.rows[0] });
  } catch (e) {
    console.error("POST /api/supplier-links ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/supplier-links/:token", async (req, res) => {
  try {
    const token = normText(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const q = await pool.query(
      `SELECT token, report_id, supplier_name, created_at, expires_at, used_at, meta
         FROM supplier_links
        WHERE token = $1::uuid`,
      [token]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "invalid token" });

    const link = q.rows[0];
    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ ok: false, error: "TOKEN_EXPIRED" });
    }

    const r = await pool.query(`SELECT id, type, payload, created_at, updated_at FROM reports WHERE id=$1`, [link.report_id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "report not found" });

    const report = r.rows[0];
    if (String(report.type) !== SUPPLIER_TYPE) {
      return res.status(400).json({ ok: false, error: "WRONG_REPORT_TYPE", expected: SUPPLIER_TYPE, got: report.type });
    }

    const payload = report.payload || {};
    const alreadySubmitted = payload?.meta?.submitted === true || !!payload?.meta?.submittedAt || !!link.used_at;

    return res.json({
      ok: true,
      link: {
        token: link.token,
        reportId: link.report_id,
        supplierName: link.supplier_name || "",
        createdAt: link.created_at,
        expiresAt: link.expires_at,
        usedAt: link.used_at,
      },
      report: {
        id: report.id,
        type: report.type,
        created_at: report.created_at,
        updated_at: report.updated_at,
        title: normText(payload?.title || ""),
        recordDate: normText(payload?.recordDate || ""),
        uniqueKey: normText(payload?.uniqueKey || ""),
      },
      form: {
        fields: isObj(payload?.fields) ? payload.fields : {},
        answers: isObj(payload?.answers) ? payload.answers : {},
        notes: normText(payload?.notes || ""),
        attachments: Array.isArray(payload?.attachments) ? payload.attachments : [],
        fieldAttachments: isObj(payload?.fieldAttachments) ? payload.fieldAttachments : {},
      },
      alreadySubmitted: !!alreadySubmitted,
      lastSubmittedAt: payload?.meta?.submittedAt || null,
    });
  } catch (e) {
    console.error("GET /api/supplier-links/:token ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ✅ UPDATED: supports recordDate + fieldAttachments */
app.post("/api/supplier-links/:token/submit", async (req, res) => {
  const client = await pool.connect();
  try {
    const token = normText(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const body = isObj(req.body) ? req.body : {};
    const recordDate = normText(body.recordDate || "");
    const fields = isObj(body.fields) ? body.fields : {};
    const answers = isObj(body.answers) ? body.answers : {};
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const fieldAttachments =
      isObj(body.fieldAttachments) && !Array.isArray(body.fieldAttachments) ? body.fieldAttachments : {};

    await client.query("BEGIN");

    const q1 = await client.query(
      `SELECT token, report_id, supplier_name, expires_at, used_at, meta
         FROM supplier_links
        WHERE token = $1::uuid
        FOR UPDATE`,
      [token]
    );

    if (!q1.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "invalid token" });
    }

    const link = q1.rows[0];

    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      await client.query("ROLLBACK");
      return res.status(410).json({ ok: false, error: "TOKEN_EXPIRED" });
    }

    if (link.used_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "ALREADY_SUBMITTED" });
    }

    const q2 = await client.query(`SELECT id, type, payload FROM reports WHERE id=$1 FOR UPDATE`, [link.report_id]);
    if (!q2.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "report not found" });
    }

    const report = q2.rows[0];
    if (String(report.type) !== SUPPLIER_TYPE) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "WRONG_REPORT_TYPE", expected: SUPPLIER_TYPE, got: report.type });
    }

    const payload = report.payload || {};
    const alreadySubmitted = payload?.meta?.submitted === true || !!payload?.meta?.submittedAt;
    if (alreadySubmitted) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "ALREADY_SUBMITTED" });
    }

    const submittedAt = new Date().toISOString();

    const mergedFields = { ...(isObj(payload.fields) ? payload.fields : {}), ...(fields || {}) };
    const mergedAnswers = { ...(isObj(payload.answers) ? payload.answers : {}), ...(answers || {}) };

    const existingFieldAtt = isObj(payload.fieldAttachments) ? payload.fieldAttachments : {};
    const mergedFieldAtt = { ...existingFieldAtt, ...safeObj(fieldAttachments) };

    const newPayload = {
      ...payload,
      recordDate: recordDate || normText(payload.recordDate) || todayISO(),
      fields: mergedFields,
      answers: mergedAnswers,
      attachments: attachments.length ? attachments : Array.isArray(payload.attachments) ? payload.attachments : [],
      fieldAttachments: Object.keys(mergedFieldAtt).length ? mergedFieldAtt : existingFieldAtt,
      meta: {
        ...(isObj(payload.meta) ? payload.meta : {}),
        submitted: true,
        submittedAt,
        savedAt: (payload?.meta && payload.meta.savedAt) || new Date().toISOString(),
      },
      public: {
        mode: "SUPPLIER_LINK",
        token,
        submittedAt,
      },
    };

    await client.query(
      `UPDATE reports
          SET payload=$1::jsonb,
              updated_at=now()
        WHERE id=$2`,
      [JSON.stringify(newPayload), link.report_id]
    );

    await client.query(`UPDATE supplier_links SET used_at=now() WHERE token=$1::uuid`, [token]);

    await client.query("COMMIT");

    return res.json({ ok: true, reportId: link.report_id, token, submittedAt });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("POST /api/supplier-links/:token/submit ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

/* ======================================================================
   ✅ SUPPLIER PUBLIC TOKEN API (AUTO-CREATE if not found)
====================================================================== */
app.get("/api/reports/public/:token", async (req, res) => {
  const client = await pool.connect();
  try {
    const token = normText(req.params.token || "");
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    // 1) try find
    const q = await client.query(
      `
      SELECT *
      FROM reports
      WHERE (payload->'public'->>'token') = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [token]
    );

    if (q.rowCount) {
      return res.json({ ok: true, report: q.rows[0], created: false });
    }

    // 2) not found → auto-create placeholder report
    await client.query("BEGIN");

    const nowIso = new Date().toISOString();
    const recDate = todayISO();

    const payload = {
      recordDate: recDate,
      title: `Supplier Self-Assessment Form • Supplier • ${recDate}`,
      uniqueKey: `supplier__${recDate}__${token}`,

      fields: {},
      answers: {},
      notes: "",
      questions: [],
      attachments: [],
      fieldAttachments: {},

      public: {
        token,
        mode: "PUBLIC",
        createdAt: nowIso,
        submittedAt: null,
      },

      meta: {
        submitted: false,
        createdBy: "AUTO_PUBLIC_LINK",
        savedAt: nowIso,
      },
    };

    const ins = await client.query(
      `INSERT INTO reports (reporter, type, payload)
       VALUES ($1, $2, $3::jsonb)
       RETURNING *`,
      ["public", "supplier_self_assessment_form", JSON.stringify(payload)]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, report: ins.rows[0], created: true });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("GET /api/reports/public/:token ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

/* ✅ UPDATED submit: supports recordDate + fieldAttachments */
app.post("/api/reports/public/:token/submit", async (req, res) => {
  const client = await pool.connect();
  try {
    const token = normText(req.params.token || "");
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const body = isObj(req.body) ? req.body : {};
    const recordDate = normText(body.recordDate || "");
    const fields = isObj(body.fields) ? body.fields : {};
    const answers = isObj(body.answers) ? body.answers : {};
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const fieldAttachments =
      isObj(body.fieldAttachments) && !Array.isArray(body.fieldAttachments) ? body.fieldAttachments : {};

    await client.query("BEGIN");

    const q = await client.query(
      `
      SELECT id, type, payload
      FROM reports
      WHERE (payload->'public'->>'token') = $1
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [token]
    );

    let reportId;
    let payload;

    if (q.rowCount) {
      reportId = q.rows[0].id;
      payload = q.rows[0].payload || {};
      if (payload?.meta?.submitted === true || payload?.meta?.submittedAt) {
        await client.query("ROLLBACK");
        return res.status(409).json({ ok: false, error: "ALREADY_SUBMITTED" });
      }
    } else {
      const nowIso = new Date().toISOString();
      const recDate = todayISO();

      payload = {
        recordDate: recDate,
        title: `Supplier Self-Assessment Form • Supplier • ${recDate}`,
        uniqueKey: `supplier__${recDate}__${token}`,
        fields: {},
        answers: {},
        notes: "",
        questions: [],
        attachments: [],
        fieldAttachments: {},
        public: { token, mode: "PUBLIC", createdAt: nowIso, submittedAt: null },
        meta: { submitted: false, createdBy: "AUTO_PUBLIC_LINK", savedAt: nowIso },
      };

      const ins = await client.query(
        `INSERT INTO reports (reporter, type, payload)
         VALUES ($1, $2, $3::jsonb)
         RETURNING id, payload`,
        ["public", "supplier_self_assessment_form", JSON.stringify(payload)]
      );

      reportId = ins.rows[0].id;
      payload = ins.rows[0].payload || payload;
    }

    const submittedAt = new Date().toISOString();

    const mergedFields = { ...(isObj(payload.fields) ? payload.fields : {}), ...(fields || {}) };
    const mergedAnswers = { ...(isObj(payload.answers) ? payload.answers : {}), ...(answers || {}) };

    const existingFieldAtt = isObj(payload.fieldAttachments) ? payload.fieldAttachments : {};
    const mergedFieldAtt = { ...existingFieldAtt, ...safeObj(fieldAttachments) };

    const newPayload = {
      ...payload,
      recordDate: recordDate || normText(payload.recordDate) || todayISO(),
      fields: mergedFields,
      answers: mergedAnswers,
      attachments: attachments.length ? attachments : Array.isArray(payload.attachments) ? payload.attachments : [],
      fieldAttachments: Object.keys(mergedFieldAtt).length ? mergedFieldAtt : existingFieldAtt,
      meta: {
        ...(isObj(payload.meta) ? payload.meta : {}),
        submitted: true,
        submittedAt,
        savedAt: (payload?.meta && payload.meta.savedAt) || new Date().toISOString(),
      },
      public: {
        ...(isObj(payload.public) ? payload.public : {}),
        token,
        mode: "PUBLIC",
        submittedAt,
      },
    };

    await client.query(`UPDATE reports SET payload=$1::jsonb, updated_at=now() WHERE id=$2`, [
      JSON.stringify(newPayload),
      reportId,
    ]);

    await client.query("COMMIT");
    return res.json({ ok: true, reportId, token, submittedAt });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("POST /api/reports/public/:token/submit ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

/* ============================================================
   Training Session Token API (TEXT token stored in reports.payload.quizToken)
============================================================ */
function extractQuiz(payload) {
  const q = payload?.quiz || payload?.quizData || payload?.trainingQuiz || {};
  const questions = Array.isArray(q?.questions) ? q.questions : Array.isArray(payload?.questions) ? payload.questions : [];
  const module = q?.module || payload?.module || payload?.moduleName || "";
  const passMark = Number(q?.passMark ?? payload?.passMark ?? payload?.PASS_MARK ?? 80);

  return {
    module,
    passMark: Number.isFinite(passMark) ? passMark : 80,
    questions,
  };
}

function makeParticipantKeyFromBody(body) {
  const pk = normText(body?.participantKey);
  const pk2 = normText(body?.participant_key);
  if (pk) return pk;
  if (pk2) return pk2;

  const p = body?.participant || {};
  const employeeId = normText(p?.employeeId);
  const name = normText(p?.name).toLowerCase();

  if (employeeId) return `eid:${employeeId}`;
  if (name) return `name:${name}`;
  return "";
}

function submissionKey(token, participantKey) {
  const pk = normText(participantKey);
  if (pk) return `p:${pk}`;
  return `t:${normText(token)}`;
}

function getSubmission(payload, token, participantKey) {
  const subMap = payload?.quizSubmissions && typeof payload.quizSubmissions === "object" ? payload.quizSubmissions : null;

  if (subMap) {
    const k = submissionKey(token, participantKey);
    if (k && subMap[k]) return subMap[k];
  }

  if (payload?.quizSubmission && payload.quizSubmission?.token === token) return payload.quizSubmission;
  return null;
}

app.get("/api/training-session/by-token/:token", async (req, res) => {
  try {
    const token = normText(req.params.token);
    const pKey = normText(req.query?.p || "");
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const q = await pool.query(
      `
      SELECT id, reporter, type, created_at, updated_at, payload
      FROM reports
      WHERE type='training_session'
        AND (payload->>'quizToken') = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [token]
    );

    if (!q.rowCount) return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });

    const r = q.rows[0];
    const payload = r.payload || {};
    const quiz = extractQuiz(payload);

    if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      return res.status(400).json({ ok: false, error: "NO_QUIZ_IN_REPORT" });
    }

    const existing = pKey ? getSubmission(payload, token, pKey) : null;
    const p = payload?.participant || payload?.participants?.[0] || {};

    return res.json({
      ok: true,
      token,
      participant: {
        slNo: normText(p?.slNo),
        name: normText(p?.name),
        designation: normText(p?.designation),
        employeeId: normText(p?.employeeId),
      },
      quiz: {
        module: quiz.module,
        passMark: quiz.passMark,
        questions: quiz.questions,
      },
      alreadySubmitted: !!existing,
      lastSubmittedAt: existing?.submittedAt || existing?.submitted_at || null,
    });
  } catch (e) {
    console.error("GET /api/training-session/by-token/:token ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/training-session/by-token/:token/submit", async (req, res) => {
  const client = await pool.connect();
  try {
    const token = normText(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const answers = safeArr(req.body?.answers);
    if (!answers.length) return res.status(400).json({ ok: false, error: "answers required" });

    const participant = isObj(req.body?.participant) ? req.body.participant : {};
    const pName = normText(participant?.name);
    const pDesignation = normText(participant?.designation);
    const pEmployeeId = normText(participant?.employeeId);

    const pKey = makeParticipantKeyFromBody(req.body);
    if (!pKey) return res.status(400).json({ ok: false, error: "participantKey required (or participant.employeeId/name)" });
    if (!pName) return res.status(400).json({ ok: false, error: "participant.name required" });
    if (!pEmployeeId) return res.status(400).json({ ok: false, error: "participant.employeeId required" });

    await client.query("BEGIN");

    const q = await client.query(
      `
      SELECT id, payload
      FROM reports
      WHERE type='training_session'
        AND (payload->>'quizToken') = $1
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
      `,
      [token]
    );

    if (!q.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "SESSION_NOT_FOUND" });
    }

    const reportId = q.rows[0].id;
    const payload = q.rows[0].payload || {};
    const quiz = extractQuiz(payload);

    if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, error: "NO_QUIZ_IN_REPORT" });
    }

    const existing = getSubmission(payload, token, pKey);
    if (existing) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        error: "ALREADY_SUBMITTED",
        score: existing?.score ?? null,
        result: existing?.result ?? null,
        submittedAt: existing?.submittedAt ?? null,
      });
    }

    if (answers.length !== quiz.questions.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        ok: false,
        error: "ANSWERS_LENGTH_MISMATCH",
        expected: quiz.questions.length,
        got: answers.length,
      });
    }

    for (let i = 0; i < answers.length; i++) {
      if (!Number.isInteger(answers[i])) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: `INVALID_ANSWER_AT_${i}` });
      }
    }

    let correctCount = 0;
    for (let i = 0; i < quiz.questions.length; i++) {
      const c = Number(quiz.questions[i]?.correct);
      if (Number.isFinite(c) && answers[i] === c) correctCount++;
    }

    const score = Math.round((correctCount / quiz.questions.length) * 100);
    const passMark = quiz.passMark;
    const result = score >= passMark ? "PASS" : "FAIL";
    const submittedAt = new Date().toISOString();

    const attemptSnapshot = {
      module: quiz.module || "",
      submittedAt,
      passMark,
      score,
      result,
      answers: quiz.questions.map((qq, i) => ({
        q_ar: qq?.q_ar || "",
        q_en: qq?.q_en || "",
        options_ar: Array.isArray(qq?.options_ar) ? qq.options_ar : [],
        options_en: Array.isArray(qq?.options_en) ? qq.options_en : [],
        correct: Number.isFinite(Number(qq?.correct)) ? Number(qq.correct) : 0,
        chosen: answers[i],
      })),
    };

    const submission = {
      token,
      participantKey: pKey,
      participant: { name: pName, designation: pDesignation, employeeId: pEmployeeId },
      submittedAt,
      passMark,
      score,
      result,
      answers,
    };

    const subMap = payload?.quizSubmissions && typeof payload.quizSubmissions === "object" ? payload.quizSubmissions : {};
    const subKey = submissionKey(token, pKey);

    const participants = safeArr(payload?.participants);
    const eidKey = normKey(pEmployeeId);
    const nameKey = normKey(pName);

    let found = false;
    const updatedParticipants = participants.map((pp) => {
      const ppEid = normKey(pp?.employeeId || "");
      const ppName = normKey(pp?.name || "");

      const hit = (eidKey && ppEid && ppEid === eidKey) || (!eidKey && ppName && ppName === nameKey);
      if (!hit) return pp;

      found = true;
      return {
        ...pp,
        name: pName || pp?.name || "",
        designation: pDesignation || pp?.designation || "",
        employeeId: pEmployeeId || pp?.employeeId || "",
        score: String(score),
        result: String(result).toUpperCase(),
        lastQuizAt: todayISO(),
        quizAttempt: attemptSnapshot,
      };
    });

    let finalParticipants = updatedParticipants;
    if (!found) {
      finalParticipants = updatedParticipants.concat([
        {
          slNo: String(updatedParticipants.length + 1),
          name: pName,
          designation: pDesignation,
          employeeId: pEmployeeId,
          score: String(score),
          result: String(result).toUpperCase(),
          lastQuizAt: todayISO(),
          quizAttempt: attemptSnapshot,
        },
      ]);
    }

    const newPayload = {
      ...payload,
      participants: finalParticipants,
      quizSubmissions: { ...subMap, [subKey]: submission },
    };

    await client.query(`UPDATE reports SET payload=$1::jsonb, updated_at=now() WHERE id=$2`, [
      JSON.stringify(newPayload),
      reportId,
    ]);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      reportId,
      participantKey: pKey,
      score,
      result,
      passMark,
      submittedAt,
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("POST /api/training-session/by-token/:token/submit ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

/* ============================================================
   Product Catalog API
============================================================ */
function catalogRowToClient(row) {
  return {
    scope: row.scope,
    code: row.code,
    name: row.name,
    item_code: row.code,
    description: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function catalogScope(req, fallback = "returns_items") {
  return normText(req.body?.scope || req.query?.scope || fallback) || fallback;
}

function catalogProductInput(req, fallbackCode = "") {
  const item = safeObj(req.body?.item);
  const code = normText(
    req.body?.code ||
    req.body?.item_code ||
    req.body?.itemCode ||
    item.code ||
    item.item_code ||
    item.itemCode ||
    fallbackCode
  );
  const name = normText(
    req.body?.name ||
    req.body?.description ||
    req.body?.productName ||
    item.name ||
    item.description ||
    item.productName
  );
  return { code, name };
}

async function listCatalogProducts(req, res, fallbackScope = "returns_items") {
  try {
    const scope = catalogScope(req, fallbackScope);
    const limit = clampInt(req.query?.limit, 5000, 1, 10000);

    const { rows } = await pool.query(
      `SELECT scope, code, name, created_at, updated_at
         FROM product_catalog
        WHERE scope = $1
        ORDER BY code ASC
        LIMIT $2`,
      [scope, limit]
    );

    const items = rows.map(catalogRowToClient);
    const map = {};
    for (const item of items) map[String(item.code)] = String(item.name);

    return res.json({ ok: true, scope, count: items.length, items, map });
  } catch (e) {
    console.error("GET catalog products ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

async function upsertCatalogProduct(req, res, fallbackScope = "returns_items") {
  try {
    const scope = catalogScope(req, fallbackScope);
    const { code, name } = catalogProductInput(req);

    if (!code || !name) {
      return res.status(400).json({ ok: false, error: "code & name required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO product_catalog (scope, code, name)
       VALUES ($1, $2, $3)
       ON CONFLICT (scope, code)
       DO UPDATE SET name = EXCLUDED.name, updated_at = now()
       RETURNING scope, code, name, created_at, updated_at`,
      [scope, code, name]
    );

    return res.json({ ok: true, item: catalogRowToClient(rows[0]) });
  } catch (e) {
    console.error("UPSERT catalog products ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

async function updateCatalogProduct(req, res, fallbackScope = "returns_items") {
  const client = await pool.connect();
  try {
    const scope = catalogScope(req, fallbackScope);
    const oldCode = normText(req.params?.code || req.body?.oldCode || req.body?.old_code);
    const { code, name } = catalogProductInput(req, oldCode);

    if (!oldCode) {
      return res.status(400).json({ ok: false, error: "code param required" });
    }
    if (!code || !name) {
      return res.status(400).json({ ok: false, error: "code & name required" });
    }

    await client.query("BEGIN");

    let result;
    if (oldCode === code) {
      result = await client.query(
        `INSERT INTO product_catalog (scope, code, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (scope, code)
         DO UPDATE SET name = EXCLUDED.name, updated_at = now()
         RETURNING scope, code, name, created_at, updated_at`,
        [scope, code, name]
      );
    } else {
      result = await client.query(
        `UPDATE product_catalog
            SET code = $3, name = $4, updated_at = now()
          WHERE scope = $1 AND code = $2
          RETURNING scope, code, name, created_at, updated_at`,
        [scope, oldCode, code, name]
      );

      if (result.rowCount === 0) {
        result = await client.query(
          `INSERT INTO product_catalog (scope, code, name)
           VALUES ($1, $2, $3)
           RETURNING scope, code, name, created_at, updated_at`,
          [scope, code, name]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({ ok: true, item: catalogRowToClient(result.rows[0]) });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_CODE",
        message: "This code already exists in this scope.",
      });
    }

    console.error("PUT catalog products ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
}

async function deleteCatalogProduct(req, res, fallbackScope = "returns_items") {
  try {
    const scope = catalogScope(req, fallbackScope);
    const code = normText(req.params?.code || req.query?.code || req.body?.code || req.body?.item_code);

    if (!code) {
      return res.status(400).json({ ok: false, error: "code required" });
    }

    const { rows } = await pool.query(
      `DELETE FROM product_catalog
        WHERE scope = $1 AND code = $2
        RETURNING scope, code, name, created_at, updated_at`,
      [scope, code]
    );

    return res.json({
      ok: true,
      deleted: rows.length > 0,
      item: rows[0] ? catalogRowToClient(rows[0]) : null,
    });
  } catch (e) {
    console.error("DELETE catalog products ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

app.get(["/api/catalog/products", "/api/catalog/items", "/api/items"], (req, res) =>
  listCatalogProducts(req, res, "returns_items")
);
app.post(["/api/catalog/products", "/api/catalog/items", "/api/items"], (req, res) =>
  upsertCatalogProduct(req, res, "returns_items")
);
app.put(["/api/catalog/products/:code", "/api/catalog/items/:code", "/api/items/:code"], (req, res) =>
  updateCatalogProduct(req, res, "returns_items")
);
app.delete(["/api/catalog/products/:code", "/api/catalog/items/:code", "/api/items/:code"], (req, res) =>
  deleteCatalogProduct(req, res, "returns_items")
);

app.put("/api/product-catalog/:code", (req, res) => updateCatalogProduct(req, res, "default"));
app.delete("/api/product-catalog/:code", (req, res) => deleteCatalogProduct(req, res, "default"));

app.get("/api/product-catalog", async (req, res) => {
  try {
    const scope = normText(req.query?.scope || "default");
    const limit = clampInt(req.query?.limit, 2000, 1, 5000);

    const { rows } = await pool.query(
      `SELECT scope, code, name, created_at, updated_at
         FROM product_catalog
        WHERE scope = $1
        ORDER BY code ASC
        LIMIT $2`,
      [scope, limit]
    );

    const map = {};
    for (const r of rows) map[String(r.code)] = String(r.name);

    return res.json({ ok: true, scope, count: rows.length, items: rows, map });
  } catch (e) {
    console.error("GET /api/product-catalog ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/product-catalog", async (req, res) => {
  try {
    const scope = normText(req.body?.scope || "default");
    const code = normText(req.body?.code);
    const name = normText(req.body?.name);

    if (!code || !name) {
      return res.status(400).json({ ok: false, error: "code & name required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO product_catalog (scope, code, name)
       VALUES ($1, $2, $3)
       RETURNING scope, code, name, created_at, updated_at`,
      [scope, code, name]
    );

    return res.status(201).json({ ok: true, item: rows[0] });
  } catch (e) {
    console.error("POST /api/product-catalog ERROR =", e);

    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_CODE",
        message: "This code already exists in this scope.",
      });
    }

    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ============================================================
   Training Links API (UUID token system - still kept)
============================================================ */
app.post("/api/training-links", async (req, res) => {
  try {
    const reportId = Number(req.body?.reportId);
    const module = normText(req.body?.module || "");
    const expiresInDays = clampInt(req.body?.expiresInDays, 7, 1, 90);
    const participants = safeArr(req.body?.participants);

    if (!Number.isFinite(reportId) || reportId <= 0) {
      return res.status(400).json({ ok: false, error: "reportId required" });
    }
    if (!participants.length) {
      return res.status(400).json({ ok: false, error: "participants required" });
    }

    const r = await pool.query(`SELECT id, type, payload FROM reports WHERE id=$1`, [reportId]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "report not found" });

    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const created = [];
    for (const p of participants) {
      const slNo = normText(p?.slNo);
      const name = normText(p?.name);
      if (!name) continue;

      const ins = await pool.query(
        `INSERT INTO training_links (report_id, participant_slno, participant_name, module, expires_at, meta)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         RETURNING token, report_id, participant_slno, participant_name, module, expires_at, created_at, used_at`,
        [reportId, slNo || null, name, module || null, expiresAt, JSON.stringify({ createdBy: "admin" })]
      );
      created.push(ins.rows[0]);
    }

    if (!created.length) {
      return res.status(400).json({ ok: false, error: "no valid participants (name required)" });
    }

    return res.status(201).json({ ok: true, reportId, count: created.length, links: created });
  } catch (e) {
    console.error("POST /api/training-links ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/training-links/:token", async (req, res) => {
  try {
    const token = normText(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const q = await pool.query(
      `SELECT token, report_id, participant_slno, participant_name, module, created_at, expires_at, used_at, meta
         FROM training_links
        WHERE token = $1::uuid`,
      [token]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "invalid token" });

    const link = q.rows[0];

    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ ok: false, error: "TOKEN_EXPIRED" });
    }

    const r = await pool.query(
      `SELECT id, reporter, type, created_at, updated_at,
              payload->>'title' AS "title",
              payload->>'branch' AS "branch",
              payload->>'module' AS "module",
              payload->>'reportDate' AS "reportDate",
              payload
         FROM reports
        WHERE id=$1`,
      [link.report_id]
    );
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "report not found" });

    const report = r.rows[0];

    return res.json({
      ok: true,
      link: {
        token: link.token,
        reportId: link.report_id,
        participant: {
          slNo: link.participant_slno || "",
          name: link.participant_name || "",
        },
        module: link.module || "",
        createdAt: link.created_at,
        expiresAt: link.expires_at,
        usedAt: link.used_at,
      },
      report: {
        id: report.id,
        type: report.type,
        created_at: report.created_at,
        updated_at: report.updated_at,
        title: report.title || report.payload?.title || "",
        branch: report.branch || report.payload?.branch || "",
        module: report.module || report.payload?.module || "",
        reportDate: report.reportDate || report.payload?.reportDate || "",
      },
    });
  } catch (e) {
    console.error("GET /api/training-links/:token ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/training-links/:token/submit", async (req, res) => {
  const client = await pool.connect();
  try {
    const token = normText(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const score = Number(req.body?.score);
    const result = normText(req.body?.result);
    const passMark = Number(req.body?.passMark);
    const module = normText(req.body?.module || "");
    const answers = safeArr(req.body?.answers);

    if (!Number.isFinite(score)) return res.status(400).json({ ok: false, error: "score required" });
    if (!result) return res.status(400).json({ ok: false, error: "result required" });
    if (!Number.isFinite(passMark)) return res.status(400).json({ ok: false, error: "passMark required" });
    if (!answers.length) return res.status(400).json({ ok: false, error: "answers required" });

    await client.query("BEGIN");

    const q1 = await client.query(
      `SELECT token, report_id, participant_slno, participant_name, module, expires_at, used_at
         FROM training_links
        WHERE token = $1::uuid
        FOR UPDATE`,
      [token]
    );
    if (!q1.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "invalid token" });
    }

    const link = q1.rows[0];

    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      await client.query("ROLLBACK");
      return res.status(410).json({ ok: false, error: "TOKEN_EXPIRED" });
    }

    if (link.used_at) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, error: "TOKEN_ALREADY_USED" });
    }

    const q2 = await client.query(`SELECT id, payload FROM reports WHERE id=$1 FOR UPDATE`, [link.report_id]);
    if (!q2.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "report not found" });
    }

    const payload = q2.rows[0].payload || {};
    const participants = safeArr(payload.participants);

    const targetSl = normKey(link.participant_slno || "");
    const targetName = normKey(link.participant_name || "");

    const updatedParticipants = participants.map((p) => {
      const pSl = normKey(p?.slNo || "");
      const pName = normKey(p?.name || "");

      const hit =
        (targetSl && pSl && pSl === targetSl) ||
        (!targetSl && targetName && pName === targetName) ||
        (targetSl && targetName && pSl === targetSl && pName === targetName);

      if (!hit) return p;

      const attemptSnapshot = {
        module: module || link.module || payload.module || "",
        submittedAt: new Date().toISOString(),
        passMark,
        score,
        result,
        answers,
      };

      return {
        ...p,
        score: String(score),
        result: String(result).toUpperCase(),
        lastQuizAt: todayISO(),
        quizAttempt: attemptSnapshot,
      };
    });

    const found = updatedParticipants.some((p) => {
      const pSl = normKey(p?.slNo || "");
      const pName = normKey(p?.name || "");
      return (targetSl && pSl === targetSl) || (targetName && pName === targetName);
    });

    let finalParticipants = updatedParticipants;
    if (!found) {
      finalParticipants = updatedParticipants.concat([
        {
          slNo: link.participant_slno || "",
          name: link.participant_name || "",
          designation: "",
          score: String(score),
          result: String(result).toUpperCase(),
          lastQuizAt: todayISO(),
          quizAttempt: {
            module: module || link.module || payload.module || "",
            submittedAt: new Date().toISOString(),
            passMark,
            score,
            result,
            answers,
          },
        },
      ]);
    }

    const newPayload = {
      ...payload,
      participants: finalParticipants,
    };

    await client.query(
      `UPDATE reports
          SET payload=$1::jsonb, updated_at=now()
        WHERE id=$2`,
      [newPayload, link.report_id]
    );

    await client.query(`UPDATE training_links SET used_at=now() WHERE token=$1::uuid`, [token]);

    await client.query("COMMIT");

    return res.json({
      ok: true,
      reportId: link.report_id,
      participant: { slNo: link.participant_slno || "", name: link.participant_name || "" },
      saved: { score, result: String(result).toUpperCase(), passMark },
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    console.error("POST /api/training-links/:token/submit ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

/* --------- Cloudinary config (robust) --------- */
(function configureCloudinary() {
  const hasSplit = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;

  if (hasSplit) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  } else {
    cloudinary.config({ secure: true });
  }

  const cfg = cloudinary.config();
  const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);

  if (missing.length) {
    console.error("❌ Cloudinary config missing:", missing.join(", "));
  } else {
    console.log("🔐 Cloudinary ready → cloud_name:", cfg.cloud_name);
  }
})();

/* ============================================================
   Files helpers (Cloudinary redirect + Proxy)
============================================================ */

/** GET cloudinary url by publicId (works when you stored only public_id / filename) */
app.get("/api/files/cloudinary/:publicId", async (req, res) => {
  try {
    const cfg = cloudinary.config();
    const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);
    if (missing.length) return res.status(500).json({ ok: false, error: "CLOUDINARY_CONFIG_MISSING", missing });

    let publicId = String(req.params.publicId || "").trim();
    if (!publicId) return res.status(400).json({ ok: false, error: "publicId required" });

    // if user stored "xxxx.pdf" remove extension for api.resource
    publicId = publicId.replace(/\.(pdf|png|jpg|jpeg|webp|gif)$/i, "");

    // try raw first (PDF usually raw), then image
    let r = null;
    try {
      r = await cloudinary.api.resource(publicId, { resource_type: "raw" });
    } catch (e1) {
      r = await cloudinary.api.resource(publicId, { resource_type: "image" });
    }

    const url = r?.secure_url || r?.url;
    if (!url) return res.status(404).json({ ok: false, error: "NO_URL_FOUND" });

    // redirect so iframe can load it
    return res.redirect(302, url);
  } catch (e) {
    console.error("GET /api/files/cloudinary/:publicId ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/** Proxy any public URL (useful when url is full https but cross-site / headers issues) */
app.get("/api/files/proxy", async (req, res) => {
  try {
    const fetchFn = globalThis.fetch;
    if (typeof fetchFn !== "function") {
      return res.status(500).json({ ok: false, error: "FETCH_NOT_AVAILABLE", hint: "Use Node 18+ on server" });
    }

    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ ok: false, error: "Missing url" });

    const r = await fetchFn(url);
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return res.status(r.status).send(txt || `Upstream error ${r.status}`);
    }

    const contentType = r.headers.get("content-type") || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", "inline");

    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (e) {
    console.error("GET /api/files/proxy ERROR =", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* --------- Health routes --------- */
app.get("/health/db", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, db: "connected" });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/health/cloud", (_req, res) => {
  const cfg = cloudinary.config();
  const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);
  if (missing.length) return res.status(500).json({ ok: false, error: "CLOUDINARY_CONFIG_MISSING", missing });
  return res.json({ ok: true, cloud_name: cfg.cloud_name });
});

/* --------- Images API (no sharp) --------- */
const uploadAny = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

function uploadBufferToCloudinary(buffer, opts = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: process.env.CLOUDINARY_FOLDER || "qcs",
        resource_type: "auto",
        transformation: [{ width: 1280, height: 1280, crop: "limit", quality: "80" }],
        ...opts,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

app.post("/api/images", uploadAny.any(), async (req, res) => {
  try {
    const cfg = cloudinary.config();
    const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);
    if (missing.length) {
      return res.status(500).json({ ok: false, error: "CLOUDINARY_CONFIG_MISSING", missing });
    }

    const f = (req.files && req.files[0]) || req.file;
    const dataUrl = req.body?.data;

    let up;
    if (f?.buffer) {
      up = await uploadBufferToCloudinary(f.buffer, { resource_type: "auto" });
    } else if (typeof dataUrl === "string" && dataUrl.startsWith("data:")) {
      up = await cloudinary.uploader.upload(dataUrl, {
        folder: process.env.CLOUDINARY_FOLDER || "qcs",
        transformation: [{ width: 1280, height: 1280, crop: "limit", quality: "80" }],
      });
    } else {
      return res.status(400).json({ ok: false, error: "no file/data" });
    }

    res.json({
      ok: true,
      url: up.secure_url,
      optimized_url: up.secure_url,
      public_id: up.public_id,
      width: up.width || null,
      height: up.height || null,
      bytes: up.bytes || null,
      format: up.format || null,
      resource_type: up.resource_type || null,
    });
  } catch (e) {
    const errPayload = {
      ok: false,
      error: "cloudinary upload failed",
      reason: e?.message || String(e),
      http_code: e?.http_code || null,
      name: e?.name || null,
    };
    console.error("Cloudinary upload failed:", errPayload);
    res.status(500).json(errPayload);
  }
});

function parseCloudinaryUrl(u) {
  try {
    const { pathname } = new URL(u);
    const parts = pathname.split("/").filter(Boolean);
    const rIdx = parts.findIndex((p) => p === "image" || p === "video" || p === "raw");
    if (rIdx < 0 || !parts[rIdx + 1]) return null;
    const resource_type = parts[rIdx];
    const delivery_type = parts[rIdx + 1];

    let vIdx = rIdx + 2;
    while (vIdx < parts.length && !/^v\d+$/.test(parts[vIdx])) vIdx++;
    if (vIdx >= parts.length - 1) return null;

    const rest = parts.slice(vIdx + 1).join("/");
    const dot = rest.lastIndexOf(".");
    const public_id = dot > 0 ? rest.slice(0, dot) : rest;

    return { resource_type, delivery_type, public_id };
  } catch {
    return null;
  }
}

async function destroyOne({ public_id, resource_type = "image", delivery_type = "upload" }) {
  const out = await cloudinary.uploader.destroy(public_id, {
    resource_type,
    type: delivery_type,
    invalidate: true,
  });
  const ok = out?.result === "ok" || out?.result === "not found" || out?.result === "queued";
  if (!ok) {
    const err = new Error("CLOUDINARY_DESTROY_FAILED");
    err.details = out;
    throw err;
  }
  return out;
}

async function destroyOneByUrl(url) {
  const info = parseCloudinaryUrl(url);
  if (!info) throw new Error("BAD_CLOUDINARY_URL");
  return destroyOne({
    public_id: info.public_id,
    resource_type: info.resource_type,
    delivery_type: info.delivery_type,
  });
}

app.delete("/api/images", async (req, res) => {
  try {
    const cfg = cloudinary.config();
    const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);
    if (missing.length) return res.status(500).json({ ok: false, error: "CLOUDINARY_CONFIG_MISSING", missing });

    const qUrl = req.query?.url;
    const qPublicId = req.query?.publicId;
    const bUrl = req.body?.url;
    const bPublicId = req.body?.publicId;
    const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const publicIds = Array.isArray(req.body?.publicIds) ? req.body.publicIds : [];

    const overrideResource = req.body?.resourceType;
    const overrideDelivery = req.body?.deliveryType;

    const jobs = [];

    const allUrls = []
      .concat(qUrl ? [qUrl] : [])
      .concat(bUrl ? [bUrl] : [])
      .concat(urls)
      .filter(Boolean);

    for (const u of [...new Set(allUrls)]) {
      if (overrideResource || overrideDelivery) {
        const info = parseCloudinaryUrl(u);
        if (!info) jobs.push(Promise.reject(new Error("BAD_CLOUDINARY_URL")));
        else {
          jobs.push(
            destroyOne({
              public_id: info.public_id,
              resource_type: overrideResource || info.resource_type,
              delivery_type: overrideDelivery || info.delivery_type,
            })
          );
        }
      } else {
        jobs.push(destroyOneByUrl(u));
      }
    }

    const allPublicIds = []
      .concat(qPublicId ? [qPublicId] : [])
      .concat(bPublicId ? [bPublicId] : [])
      .concat(publicIds)
      .filter(Boolean);

    for (const pid of [...new Set(allPublicIds)]) {
      jobs.push(
        destroyOne({
          public_id: pid,
          resource_type: overrideResource || "image",
          delivery_type: overrideDelivery || "upload",
        })
      );
    }

    if (!jobs.length) return res.status(400).json({ ok: false, error: "url/publicId or arrays required" });

    const results = await Promise.allSettled(jobs);
    const deleted = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - deleted;

    res.json({
      ok: failed === 0,
      deleted,
      failed,
      results: results.map((r, i) =>
        r.status === "fulfilled"
          ? { i, status: "ok" }
          : { i, status: "error", reason: String(r.reason?.message || r.reason) }
      ),
    });
  } catch (e) {
    console.error("DELETE /api/images ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/images/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT filename,mimetype,data FROM images WHERE id=$1", [req.params.id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ ok: false, error: "not found" });
    res.setHeader("Content-Type", row.mimetype || "image/jpeg");
    res.setHeader("Content-Disposition", `inline; filename="${row.filename || "image.jpg"}"`);
    res.send(row.data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* --------- Auth: verify role password --------- */
app.post("/api/auth/verify-role", (req, res) => {
  const { roleId, password } = req.body || {};

  if (!roleId || typeof password !== "string") {
    return res.status(400).json({ success: false, error: "Missing roleId or password" });
  }

  let passwords;
  try {
    passwords = JSON.parse(process.env.ROLE_PASSWORDS_JSON || "{}");
  } catch {
    return res.status(500).json({ success: false, error: "Server config error" });
  }

  const expected = passwords[roleId] ?? passwords["default"];

  if (expected === undefined) {
    // Role not configured server-side — defer to client-side auth silently
    return res.json({ success: true });
  }

  if (password === expected) {
    return res.json({ success: true });
  }

  // تأخير 500ms لمنع brute-force
  setTimeout(() => {
    res.status(401).json({ success: false, error: "Wrong password" });
  }, 500);
});

/* ============================================================
   Reports summary — one query returns count + latest per type.
   Used by the KPI dashboard so it doesn't have to fan out N fetches.
============================================================ */
app.get("/api/reports/summary", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        type,
        COUNT(*)::int                                      AS count,
        MAX(COALESCE(
          NULLIF(payload->>'reportDate', ''),
          to_char(created_at AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD')
        ))                                                 AS latest_date,
        MAX(created_at)                                    AS last_created_at
      FROM reports
      GROUP BY type
      ORDER BY count DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error("reports/summary error:", e);
    res.status(500).json({ ok: false, error: "summary_failed" });
  }
});

/* ============================================================
   Presence / Visitor Analytics
   - POST /api/presence/ping  body:{ visitorId }  → { ok:true }
   - POST /api/presence/bye   body:{ visitorId }  → { ok:true }
   - GET  /api/presence/stats → { online, todayVisits, totalVisits }
   Online window = 60 seconds. Daily date uses Asia/Dubai timezone.
============================================================ */
const PRESENCE_ONLINE_SECONDS = 60;

app.post("/api/presence/ping", async (req, res) => {
  const visitorId = String(req.body?.visitorId || "").slice(0, 128);
  if (!visitorId) return res.status(400).json({ ok: false, error: "missingVisitorId" });

  try {
    await pool.query(
      `INSERT INTO presence (visitor_id, last_seen)
       VALUES ($1, now())
       ON CONFLICT (visitor_id) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
      [visitorId]
    );
    await pool.query(
      `INSERT INTO daily_visits (day, visitor_id)
       VALUES ((now() AT TIME ZONE 'Asia/Dubai')::date, $1)
       ON CONFLICT DO NOTHING`,
      [visitorId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("presence/ping error:", e);
    res.status(500).json({ ok: false, error: "presence_ping_failed" });
  }
});

app.post("/api/presence/bye", async (req, res) => {
  const visitorId = String(req.body?.visitorId || "").slice(0, 128);
  if (!visitorId) return res.json({ ok: true });
  try {
    await pool.query(`DELETE FROM presence WHERE visitor_id = $1`, [visitorId]);
  } catch (e) {
    console.error("presence/bye error:", e);
  }
  res.json({ ok: true });
});

app.get("/api/presence/stats", async (_req, res) => {
  try {
    const online = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM presence
        WHERE last_seen > now() - ($1 || ' seconds')::interval`,
      [String(PRESENCE_ONLINE_SECONDS)]
    );
    const today = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM daily_visits
        WHERE day = (now() AT TIME ZONE 'Asia/Dubai')::date`
    );
    const total = await pool.query(`SELECT COUNT(*)::int AS c FROM daily_visits`);
    res.json({
      online:       online.rows[0]?.c || 0,
      todayVisits:  today.rows[0]?.c  || 0,
      totalVisits:  total.rows[0]?.c  || 0,
    });
  } catch (e) {
    console.error("presence/stats error:", e);
    res.status(500).json({ ok: false, error: "presence_stats_failed" });
  }
});

/* ============================================================
   AUTH — Named Account Login / Logout
============================================================ */

/* POST /api/auth/login  { username, password } */
app.post("/api/auth/login", async (req, res) => {
  try {
    const ip       = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const username = normText(req.body?.username);
    const password = normText(req.body?.password);

    /* ── Rate limiting ── */
    if (!rlCheck(ip)) {
      return res.status(429).json({
        ok: false,
        error: "too_many_attempts",
        message: "Too many login attempts. Please wait 1 minute.",
      });
    }

    if (!username || !password)
      return res.status(400).json({ ok: false, error: "username and password required" });

    const q = await pool.query(
      `SELECT id, username, display_name, password_hash, salt,
              permissions, crud_perms, employees, allowed_branches, is_active, is_admin, is_super_admin, last_login,
              company_id
         FROM app_users WHERE username = $1 LIMIT 1`,
      [username]
    );
    /* Helper: log a failed login attempt for the security monitor */
    const logFailed = async (reason) => {
      try {
        await pool.query(
          `INSERT INTO activity_log (user_id, username, action, detail, ip_addr)
           VALUES ($1, $2, 'login_failed', $3::jsonb, $4)`,
          [null, username, JSON.stringify({ reason }), ip]
        );
      } catch { /* don't break login on logging error */ }
    };

    if (!q.rowCount) {
      await logFailed("unknown_user");
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const user = q.rows[0];

    if (!user.is_active) {
      await logFailed("account_disabled");
      return res.status(403).json({ ok: false, error: "account_disabled" });
    }

    if (!verifyPw(password, user.salt, user.password_hash)) {
      await logFailed("wrong_password");
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    /* ── On success: reset rate limit + auto-upgrade legacy HMAC hash → scrypt ── */
    rlReset(ip);
    if (!user.salt.startsWith(SCRYPT_PFX)) {
      const newSalt = genSalt();
      const newHash = hashPw(password, newSalt);
      await pool.query(
        `UPDATE app_users SET password_hash=$1, salt=$2 WHERE id=$3`,
        [newHash, newSalt, user.id]
      ).catch(() => {}); // non-fatal
    }

    /* ── Multi-tenant: resolve the user's company (NULL = platform/super-admin) ── */
    let company = null;
    if (user.company_id) {
      const cq = await pool.query(
        `SELECT c.id, c.name, c.status, c.start_date, c.end_date,
                p.name AS plan_name, p.max_branches, p.max_users
           FROM companies c
           LEFT JOIN plans p ON p.id = c.plan_id
          WHERE c.id = $1 LIMIT 1`,
        [user.company_id]
      );
      company = cq.rows[0] || null;
    }

    /* Block login if the user's company subscription has lapsed (super-admins bypass).
       Company "expired"/"suspended", or end_date in the past, denies access. */
    if (!user.is_super_admin && company) {
      const lapsed =
        company.status === "expired" ||
        company.status === "suspended" ||
        (company.end_date && new Date(company.end_date) < new Date(new Date().toDateString()));
      if (lapsed) {
        await logFailed("company_subscription_lapsed");
        return res.status(403).json({
          ok: false,
          error: "subscription_lapsed",
          company: { name: company.name, status: company.status, end_date: company.end_date },
        });
      }
    }

    /* Update last_login */
    await pool.query(`UPDATE app_users SET last_login=now() WHERE id=$1`, [user.id]);

    /* Log activity */
    await pool.query(
      `INSERT INTO activity_log (user_id, username, action, detail, ip_addr)
       VALUES ($1, $2, 'login', $3::jsonb, $4)`,
      [user.id, user.username, JSON.stringify({ displayName: user.display_name }), ip]
    );

    res.json({
      ok: true,
      user: {
        id:              user.id,
        username:        user.username,
        displayName:     user.display_name,
        permissions:     user.permissions,        // array of role IDs or ["*"]
        crudPerms:       user.crud_perms,         // { sectionId: ["view","write","edit","delete"] }
        employees:       user.employees,          // ["Name1", "Name2", ...]
        allowedBranches: user.allowed_branches || [], // [] = all, [...] = restricted
        isAdmin:         user.is_admin,
        isSuperAdmin:    user.is_super_admin,
        lastLogin:       user.last_login,
        companyId:       user.company_id || null,  // NULL = platform-level (super-admin)
        company:         company ? {               // resolved company snapshot (null for platform users)
          id:        company.id,
          name:      company.name,
          status:    company.status,
          startDate: company.start_date,
          endDate:   company.end_date,
          planName:  company.plan_name || null,
          maxBranches: company.max_branches ?? -1,
          maxUsers:    company.max_users ?? -1,
        } : null,
      },
    });
  } catch (e) {
    console.error("POST /api/auth/login ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* POST /api/auth/logout  { username } */
app.post("/api/auth/logout", async (req, res) => {
  try {
    const username = normText(req.body?.username);
    if (username) {
      const u = await pool.query(`SELECT id FROM app_users WHERE username=$1 LIMIT 1`, [username]);
      const uid = u.rows[0]?.id || null;
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
      await pool.query(
        `INSERT INTO activity_log (user_id, username, action, ip_addr)
         VALUES ($1, $2, 'logout', $3)`,
        [uid, username, ip]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/auth/logout ERROR:", e);
    res.json({ ok: true }); // always succeed
  }
});

/* ============================================================
   APP USERS — CRUD (admin only — validated client-side via isAdmin flag)
============================================================ */

/* GET /api/app-users */
app.get("/api/app-users", async (req, res) => {
  try {
    /* Multi-tenant scoping: ?company_id=N restricts to that company.
       Super-admin UI omits it to see everyone. */
    const companyId = req.query.company_id ? parseInt(req.query.company_id) : null;
    const params = [];
    let where = "";
    if (companyId) { params.push(companyId); where = `WHERE u.company_id = $1`; }

    const q = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.permissions, u.crud_perms, u.employees, u.allowed_branches,
              u.is_active, u.is_admin, u.is_super_admin, u.created_at, u.last_login,
              u.company_id, c.name AS company_name
         FROM app_users u
         LEFT JOIN companies c ON c.id = u.company_id
         ${where}
         ORDER BY u.created_at ASC`,
      params
    );
    res.json({ ok: true, users: q.rows });
  } catch (e) {
    console.error("GET /api/app-users ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* POST /api/app-users  { username, displayName, password, permissions, crudPerms, employees, isAdmin } */
app.post("/api/app-users", async (req, res) => {
  try {
    const username       = normText(req.body?.username);
    const displayName    = normText(req.body?.displayName || req.body?.display_name || username);
    const password       = normText(req.body?.password);
    const permissions    = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    const crudPerms      = (req.body?.crudPerms && typeof req.body.crudPerms === "object") ? req.body.crudPerms : {};
    const employees      = Array.isArray(req.body?.employees) ? req.body.employees : [];
    /* Accept either array (legacy) OR object { sectionId: [items...] } (new per-section format) */
    const _ab = req.body?.allowedBranches;
    const allowedBranches = (_ab && typeof _ab === "object") ? _ab : [];
    const isAdmin        = !!req.body?.isAdmin;
    /* Multi-tenant: which company this account belongs to (NULL = platform-level). */
    const companyId      = req.body?.companyId != null ? parseInt(req.body.companyId) : null;

    if (!username || !password)
      return res.status(400).json({ ok: false, error: "username and password required" });

    const salt = genSalt();
    const hash = hashPw(password, salt);

    const q = await pool.query(
      `INSERT INTO app_users (username, display_name, password_hash, salt, permissions, crud_perms, employees, allowed_branches, is_admin, company_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
       RETURNING id, username, display_name, permissions, crud_perms, employees, allowed_branches, is_active, is_admin, created_at, company_id`,
      [username, displayName, hash, salt,
       JSON.stringify(permissions), JSON.stringify(crudPerms), JSON.stringify(employees),
       JSON.stringify(allowedBranches), isAdmin, Number.isFinite(companyId) ? companyId : null]
    );

    res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    if (e.code === "23505")
      return res.status(409).json({ ok: false, error: "username_taken" });
    console.error("POST /api/app-users ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* PUT /api/app-users/:id  { displayName?, password?, permissions?, isAdmin?, isActive? } */
app.put("/api/app-users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sets = [];
    const vals = [];
    let idx = 1;

    if (req.body?.displayName !== undefined) {
      sets.push(`display_name=$${idx++}`);
      vals.push(normText(req.body.displayName));
    }
    if (req.body?.password) {
      const salt = genSalt();
      const hash = hashPw(normText(req.body.password), salt);
      sets.push(`password_hash=$${idx++}`, `salt=$${idx++}`);
      vals.push(hash, salt);
    }
    if (req.body?.permissions !== undefined) {
      sets.push(`permissions=$${idx++}::jsonb`);
      vals.push(JSON.stringify(Array.isArray(req.body.permissions) ? req.body.permissions : []));
    }
    if (req.body?.crudPerms !== undefined) {
      sets.push(`crud_perms=$${idx++}::jsonb`);
      vals.push(JSON.stringify(typeof req.body.crudPerms === "object" ? req.body.crudPerms : {}));
    }
    if (req.body?.employees !== undefined) {
      sets.push(`employees=$${idx++}::jsonb`);
      vals.push(JSON.stringify(Array.isArray(req.body.employees) ? req.body.employees : []));
    }
    if (req.body?.isAdmin !== undefined) {
      sets.push(`is_admin=$${idx++}`);
      vals.push(!!req.body.isAdmin);
    }
    if (req.body?.isActive !== undefined) {
      sets.push(`is_active=$${idx++}`);
      vals.push(!!req.body.isActive);
    }
    if (req.body?.allowedBranches !== undefined) {
      /* Accept either array (legacy) OR object { sectionId: [items...] } */
      const _ab = req.body.allowedBranches;
      sets.push(`allowed_branches=$${idx++}::jsonb`);
      vals.push(JSON.stringify((_ab && typeof _ab === "object") ? _ab : []));
    }
    if (req.body?.companyId !== undefined) {
      /* Multi-tenant: reassign account to a company (null = platform-level). */
      const cid = req.body.companyId != null ? parseInt(req.body.companyId) : null;
      sets.push(`company_id=$${idx++}`);
      vals.push(Number.isFinite(cid) ? cid : null);
    }

    if (!sets.length)
      return res.status(400).json({ ok: false, error: "nothing to update" });

    vals.push(id);
    const q = await pool.query(
      `UPDATE app_users SET ${sets.join(",")} WHERE id=$${idx}
       RETURNING id, username, display_name, permissions, crud_perms, employees, allowed_branches, is_active, is_admin, created_at, last_login, company_id`,
      vals
    );
    if (!q.rowCount)
      return res.status(404).json({ ok: false, error: "user_not_found" });

    res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/app-users/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* DELETE /api/app-users/:id */
app.delete("/api/app-users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const q = await pool.query(`DELETE FROM app_users WHERE id=$1 RETURNING username`, [id]);
    if (!q.rowCount)
      return res.status(404).json({ ok: false, error: "user_not_found" });
    res.json({ ok: true, deleted: q.rows[0].username });
  } catch (e) {
    console.error("DELETE /api/app-users/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* GET /api/activity-log?limit=50&username=xxx */
app.get("/api/activity-log", async (req, res) => {
  try {
    const limit = clampInt(req.query?.limit, 100, 1, 500);
    const usernameFilter = normText(req.query?.username || "");

    let q;
    if (usernameFilter) {
      q = await pool.query(
        `SELECT id, user_id, username, action, detail, ip_addr, created_at
           FROM activity_log WHERE username=$1
           ORDER BY created_at DESC LIMIT $2`,
        [usernameFilter, limit]
      );
    } else {
      q = await pool.query(
        `SELECT id, user_id, username, action, detail, ip_addr, created_at
           FROM activity_log ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
    }
    res.json({ ok: true, logs: q.rows });
  } catch (e) {
    console.error("GET /api/activity-log ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ─── Failed Logins Monitor — security audit ─── */
/* Returns the last N failed login attempts + per-IP aggregation for the past hour. */
app.get("/api/security/failed-logins", async (req, res) => {
  try {
    const limit = clampInt(req.query?.limit, 50, 1, 200);
    const recent = await pool.query(
      `SELECT id, username, detail, ip_addr, created_at
         FROM activity_log
        WHERE action='login_failed'
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    /* Aggregate per IP over the last hour to detect brute force */
    const byIp = await pool.query(
      `SELECT ip_addr, COUNT(*)::int AS attempts,
              MAX(created_at) AS last_at,
              ARRAY_AGG(DISTINCT username ORDER BY username) FILTER (WHERE username IS NOT NULL) AS usernames
         FROM activity_log
        WHERE action='login_failed' AND created_at > now() - INTERVAL '1 hour'
        GROUP BY ip_addr
        HAVING COUNT(*) >= 1
        ORDER BY attempts DESC
        LIMIT 50`
    );
    res.json({
      ok: true,
      recent: recent.rows,
      byIpLastHour: byIp.rows,
    });
  } catch (e) {
    console.error("GET /api/security/failed-logins ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   PLANS — CRUD
============================================================ */

app.get("/api/plans", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM plans ORDER BY price ASC`);
    res.json({ ok: true, plans: q.rows });
  } catch (e) {
    console.error("GET /api/plans ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/plans", async (req, res) => {
  try {
    const { name, price, currency, max_branches, max_users, description } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    const q = await pool.query(
      `INSERT INTO plans (name, price, currency, max_branches, max_users, description)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, price || 0, currency || "USD", max_branches ?? -1, max_users ?? -1, description || ""]
    );
    res.json({ ok: true, plan: q.rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ ok: false, error: "name_taken" });
    console.error("POST /api/plans ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.put("/api/plans/:id", async (req, res) => {
  try {
    const { name, price, currency, max_branches, max_users, description, is_active } = req.body;
    const q = await pool.query(
      `UPDATE plans SET name=$1, price=$2, currency=$3, max_branches=$4, max_users=$5,
         description=$6, is_active=$7, updated_at=now()
       WHERE id=$8 RETURNING *`,
      [name, price, currency || "USD", max_branches ?? -1, max_users ?? -1,
       description || "", is_active !== false, req.params.id]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, plan: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/plans/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.delete("/api/plans/:id", async (req, res) => {
  try {
    await pool.query(`UPDATE companies SET plan_id=NULL WHERE plan_id=$1`, [req.params.id]);
    await pool.query(`DELETE FROM plans WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/plans/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   COMPANIES — CRUD
============================================================ */

app.get("/api/companies", async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT c.*, p.name AS plan_name, p.price AS plan_price, p.currency AS plan_currency
      FROM companies c
      LEFT JOIN plans p ON p.id = c.plan_id
      ORDER BY c.created_at ASC
    `);
    res.json({ ok: true, companies: q.rows });
  } catch (e) {
    console.error("GET /api/companies ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/companies", async (req, res) => {
  try {
    const { name, contact_name, contact_email, contact_phone, plan_id, status, start_date, end_date, notes } = req.body;
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    const q = await pool.query(
      `INSERT INTO companies (name, contact_name, contact_email, contact_phone, plan_id, status, start_date, end_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [name, contact_name||"", contact_email||"", contact_phone||"",
       plan_id||null, status||"active", start_date||null, end_date||null, notes||""]
    );
    res.json({ ok: true, company: q.rows[0] });
  } catch (e) {
    console.error("POST /api/companies ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.put("/api/companies/:id", async (req, res) => {
  try {
    const { name, contact_name, contact_email, contact_phone, plan_id, status, start_date, end_date, notes } = req.body;
    const q = await pool.query(
      `UPDATE companies SET name=$1, contact_name=$2, contact_email=$3, contact_phone=$4,
         plan_id=$5, status=$6, start_date=$7, end_date=$8, notes=$9, updated_at=now()
       WHERE id=$10 RETURNING *`,
      [name, contact_name||"", contact_email||"", contact_phone||"",
       plan_id||null, status||"active", start_date||null, end_date||null, notes||"", req.params.id]
    );
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, company: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/companies/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.delete("/api/companies/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM companies WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/companies/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ============================================================
   SUBSCRIPTION — Get / Update
============================================================ */

/* GET /api/subscription */
app.get("/api/subscription", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM subscription ORDER BY id DESC LIMIT 1`);
    res.json({ ok: true, subscription: q.rows[0] || null });
  } catch (e) {
    console.error("GET /api/subscription ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* PUT /api/subscription  { plan, status, start_date, end_date, price, currency, notes, updated_by } */
app.put("/api/subscription", async (req, res) => {
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
       price || null, currency || "USD", notes || "", updated_by || "admin"]
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

app.get("/api/billing-profile", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM billing_profile ORDER BY id ASC LIMIT 1`);
    res.json({ ok: true, profile: q.rows[0] || null });
  } catch (e) {
    console.error("GET /api/billing-profile ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.put("/api/billing-profile", async (req, res) => {
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

app.get("/api/invoices", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM invoices ORDER BY id DESC LIMIT 500`);
    res.json({ ok: true, invoices: q.rows });
  } catch (e) {
    console.error("GET /api/invoices ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.get("/api/invoices/:id", async (req, res) => {
  try {
    const q = await pool.query(`SELECT * FROM invoices WHERE id=$1`, [req.params.id]);
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not_found" });
    res.json({ ok: true, invoice: q.rows[0] });
  } catch (e) {
    console.error("GET /api/invoices/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

app.post("/api/invoices", async (req, res) => {
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
        accounts_count || 0,
        branches_count || 0,
        max_branches ?? null,
        max_users ?? null,
        amount || 0,
        currency || "USD",
        notes || "",
        created_by || "admin",
      ]
    );
    res.json({ ok: true, invoice: q.rows[0] });
  } catch (e) {
    console.error("POST /api/invoices ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ════════════════════════════════════════════════════════════
   EMAIL HISTORY — log + list + stats + cleanup
═════════════════════════════════════════════════════════════ */

/* Log a single email send. Called by the frontend after each successful send. */
app.post("/api/email-history", async (req, res) => {
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
app.get("/api/email-history", async (req, res) => {
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
app.get("/api/email-history/stats", async (req, res) => {
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
app.delete("/api/email-history/:id", async (req, res) => {
  try {
    await pool.query(`DELETE FROM email_history WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /api/email-history/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* Bulk cleanup: delete entries older than `before` (YYYY-MM-DD). Manual only. */
app.delete("/api/email-history", async (req, res) => {
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

/* --------- Boot --------- */
ensureSchema()
  .then(() =>
    app.listen(PORT, () => {
      console.log(`✅ API running on :${PORT} (FULL public access: read/write/delete enabled)`);
      console.log("🔥 STARTED AT:", new Date().toISOString());
    })
  )
  .catch((err) => {
    console.error("❌ DB init failed:", err);
    process.exit(1);
  });