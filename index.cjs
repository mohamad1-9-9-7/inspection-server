// index.cjs — Open-CRUD backend (Express + Postgres) + Cloudinary upload (no sharp)
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const pg = require("pg");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const app = express();
const PORT = process.env.PORT || 5000;

/* ========= DEPLOY FINGERPRINT ========= */
console.log("🔥 DEPLOY VERSION:", new Date().toISOString());
console.log("🔥 NODE_ENV:", process.env.NODE_ENV || "undefined");

/* --------- CORS --------- */
/* ✅ allow PATCH + allow Accept headers + correct preflight */
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

function normKey(s) {
  return String(s ?? "").trim().toLowerCase();
}

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

  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='ux_reports_type_reportdate') THEN
        EXECUTE 'CREATE UNIQUE INDEX ux_reports_type_reportdate ON reports (type, ((payload->>''reportDate'')))';
      END IF;
    END $$;
  `);

  /* ✅ Product Catalog (code -> name) saved on server */
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

  /* ✅ NEW: Training Links (token for /t/:token) */
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
}

/* ============================================================
   Reports API
============================================================ */
/**
 * ✅ supports lite=1 to return only minimal fields (prevents OOM)
 * ✅ supports limit=...
 */
app.get("/api/reports", async (req, res) => {
  try {
    const { type } = req.query;
    const lite = String(req.query?.lite || "").toLowerCase();
    const isLite = lite === "1" || lite === "true" || lite === "yes";
    const limit = clampInt(req.query?.limit, 200, 1, 500);

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

/* get single report by id */
app.get("/api/reports/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (!id) return res.status(400).json({ ok: false, error: "id required" });

    const { rows, rowCount } = await pool.query(`SELECT * FROM reports WHERE id=$1`, [id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: "not found" });
    return res.json({ ok: true, report: rows[0] });
  } catch (e) {
    console.error("GET /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/api/reports", async (req, res) => {
  try {
    let { reporter, type, payload } = req.body || {};
    payload = parseMaybeJSON(payload);

    if (!type || !isObj(payload)) {
      return res.status(400).json({ ok: false, error: "type & payload are required" });
    }

    const { rows } = await pool.query(
      `INSERT INTO reports (reporter,type,payload) VALUES ($1,$2,$3::jsonb) RETURNING *`,
      [reporter || "anonymous", type, payload]
    );

    return res.status(201).json({ ok: true, report: rows[0] });
  } catch (e) {
    console.error("POST /api/reports ERROR =", e);

    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_REPORT",
        message: "Report for this type and date already exists.",
      });
    }

    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* upsert by type + reportDate */
app.put("/api/reports", async (req, res) => {
  try {
    const { reporter, type } = req.body || {};
    let payload = parseMaybeJSON(req.body?.payload);
    const reportDate = payload?.reportDate || req.query?.reportDate || "";
    if (!type || !isObj(payload) || !reportDate)
      return res.status(400).json({ ok: false, error: "type + payload.reportDate required" });

    const upd = await pool.query(
      `UPDATE reports
         SET reporter = COALESCE($1,reporter),
             payload=$2::jsonb,
             updated_at=now()
       WHERE type=$3 AND payload->>'reportDate'=$4
       RETURNING *`,
      [reporter || "anonymous", payload, type, reportDate]
    );
    if (upd.rowCount > 0) return res.json({ ok: true, report: upd.rows[0], method: "update" });

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload) VALUES ($1,$2,$3::jsonb) RETURNING *`,
      [reporter || "anonymous", type, payload]
    );
    res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports ERROR =", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* update by ID */
async function updateReportById(req, res) {
  try {
    const id = String(req.params.id || "");
    let { reporter, type, payload } = req.body || {};
    payload = parseMaybeJSON(payload);

    if (!id) return res.status(400).json({ ok: false, error: "id required" });
    if (!isObj(payload)) return res.status(400).json({ ok: false, error: "payload is required" });

    const { rows, rowCount } = await pool.query(
      `UPDATE reports
         SET reporter   = COALESCE($1, reporter),
             type       = COALESCE($2, type),
             payload    = $3::jsonb,
             updated_at = now()
       WHERE id = $4
       RETURNING *`,
      [reporter || null, type || null, payload, id]
    );

    if (!rowCount) return res.status(404).json({ ok: false, error: "not found" });
    return res.json({ ok: true, report: rows[0] });
  } catch (e) {
    console.error("UPDATE /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

app.put("/api/reports/:id", updateReportById);
app.patch("/api/reports/:id", updateReportById);

/* Special upserts */
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
      `UPDATE reports SET reporter = COALESCE(reporter,'anonymous'), payload=$1::jsonb, updated_at=now()
       WHERE type='returns' AND payload->>'reportDate'=$2 RETURNING *`,
      [payload, reportDate]
    );
    if (upd.rowCount > 0) return res.json({ ok: true, report: upd.rows[0], method: "update" });
    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload) VALUES ('anonymous','returns',$1::jsonb) RETURNING *`,
      [payload]
    );
    res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/returns ERROR =", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
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
      `UPDATE reports SET reporter = COALESCE(reporter,'anonymous'), payload=$1::jsonb, updated_at=now()
       WHERE type='qcs' AND payload->>'reportDate'=$2 RETURNING *`,
      [payload, reportDate]
    );
    if (upd.rowCount > 0) return res.json({ ok: true, report: upd.rows[0], method: "update" });
    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload) VALUES ('anonymous','qcs',$1::jsonb) RETURNING *`,
      [payload]
    );
    res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/qcs ERROR =", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
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

app.delete("/api/reports/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM reports WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ ok: false, error: "not found" });
    res.json({ ok: true, deleted: rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ============================================================
   Product Catalog API
============================================================ */
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
   ✅ Training Links API (for /t/:token)
   - POST /api/training-links
     body: { reportId, participants:[{slNo,name}], module?, expiresInDays? }
   - GET  /api/training-links/:token
   - POST /api/training-links/:token/submit
     body: { score, result, passMark, module, answers:[...] }
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

    // ensure report exists
    const r = await pool.query(`SELECT id, type, payload FROM reports WHERE id=$1`, [reportId]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "report not found" });

    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    const created = [];
    for (const p of participants) {
      const slNo = normText(p?.slNo);
      const name = normText(p?.name);

      // allow empty slNo, but require name at least
      if (!name) continue;

      const ins = await pool.query(
        `INSERT INTO training_links (report_id, participant_slno, participant_name, module, expires_at, meta)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         RETURNING token, report_id, participant_slno, participant_name, module, expires_at, created_at, used_at`,
        [
          reportId,
          slNo || null,
          name,
          module || null,
          expiresAt,
          JSON.stringify({ createdBy: "admin" }),
        ]
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

    // expired?
    if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
      return res.status(410).json({ ok: false, error: "TOKEN_EXPIRED" });
    }

    // return minimal report info (no quiz bank here)
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

    // body
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

    // lock link row
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

    // optional: prevent retake if already used
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

    // if participant not found, we can append it (safe fallback)
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
      await pool.query("ROLLBACK");
    } catch {}
    console.error("POST /api/training-links/:token/submit ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

/* --------- Cloudinary config (robust) --------- */
(function configureCloudinary() {
  const hasSplit =
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET;

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
        // ✅ transform on upload (1280px max + quality 80) without sharp
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
      // if dataURL, still apply same transformation
      up = await cloudinary.uploader.upload(dataUrl, {
        folder: process.env.CLOUDINARY_FOLDER || "qcs",
        transformation: [{ width: 1280, height: 1280, crop: "limit", quality: "80" }],
      });
    } else {
      return res.status(400).json({ ok: false, error: "no file/data" });
    }

    // secure_url is already transformed (because we uploaded with transformation)
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

/* ========= Cloudinary delete helpers & route ========= */
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
        r.status === "fulfilled" ? { i, status: "ok" } : { i, status: "error", reason: String(r.reason?.message || r.reason) }
      ),
    });
  } catch (e) {
    console.error("DELETE /api/images ERROR:", e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* --------- Legacy DB image serve --------- */
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
