
module.exports = function registerSupplierPublicRoutes(app, deps = {}) {
  const { pool, clampInt, normText, todayISO, safeObj, isObj, rollbackQuietly, sendDbError,
          makeLimiter, requireAuthStrict } = deps;
  const noGate = (_req, _res, next) => next();
  const mk = typeof makeLimiter === "function" ? makeLimiter : () => noGate;
  const strict = typeof requireAuthStrict === "function" ? requireAuthStrict : noGate;

  /* Token endpoints are reachable by anyone holding the link, so they are the
     part of the API most exposed to scanning. A real recipient opens a link
     once and submits once; 40 hits a minute leaves enormous headroom while
     making enumeration of the token space pointless. */
  const publicLimiter = mk({ max: 40, windowMs: 60_000, name: "public-token" });

/* ======================================================================
   Supplier Links API (UUID token system)
====================================================================== */
const SUPPLIER_TYPE = "supplier_self_assessment_form";
const MAX_JSON_ARRAY_ITEMS = 500;
const MAX_JSON_OBJECT_KEYS = 1000;

function cleanJsonbValue(value, depth = 0) {
  if (depth > 20) return null;
  if (value == null) return value;
  if (typeof value === "string") return value.replace(/\u0000/g, "");
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, MAX_JSON_ARRAY_ITEMS).map((item) => cleanJsonbValue(item, depth + 1));
  if (!isObj(value)) return null;

  const out = {};
  Object.keys(value).slice(0, MAX_JSON_OBJECT_KEYS).forEach((key) => {
    const cleanKey = String(key || "").replace(/\u0000/g, "");
    if (!cleanKey) return;
    out[cleanKey] = cleanJsonbValue(value[key], depth + 1);
  });
  return out;
}

function cleanJsonbObject(value) {
  const cleaned = cleanJsonbValue(value);
  return isObj(cleaned) ? cleaned : {};
}

function cleanJsonbArray(value) {
  const cleaned = cleanJsonbValue(value);
  return Array.isArray(cleaned) ? cleaned : [];
}

/* ======================================================================
   Inspection "closed evidence" links (internal audit / CAPA)
   ----------------------------------------------------------------------
   These share the /api/reports/public/:token endpoints with the supplier
   self-assessment form, but they are a different animal: the token points
   at an EXISTING internal audit report, the recipient is a branch (not a
   supplier), and most of the report is none of their business.
====================================================================== */
const INSPECTION_TYPE = "internal_multi_audit";
const INSPECTION_MODE = "INSPECTION_CLOSED_EVIDENCE_ONLY";
/* Tokens minted by src/utils/inspectionPublicLink.js all start with iev_. */
const INSPECTION_TOKEN_RE = /^iev_/i;

function isInspectionRow(row) {
  if (!row) return false;
  const payload = isObj(row.payload) ? row.payload : {};
  const mode = normText(payload?.public?.mode || "");
  return String(row.type) === INSPECTION_TYPE || mode === INSPECTION_MODE;
}

function isRowClosed(row) {
  return /^\s*closed\s*$/i.test(String(row?.status ?? ""));
}

/* Status a finding carries between "branch sent evidence" and "QA ruled on it".
   Deliberately not "Closed" — closure rate must not count unverified work. */
const PENDING_VERIFICATION_STATUS = "Pending QA Verification";

/* null when the link is usable, otherwise {status, error} to send back. */
function inspectionLinkProblem(payload) {
  const pub = isObj(payload?.public) ? payload.public : {};
  if (pub.revokedAt) return { status: 410, error: "LINK_REVOKED", revokedAt: pub.revokedAt };
  const exp = pub.expiresAt ? Date.parse(pub.expiresAt) : NaN;
  if (Number.isFinite(exp) && exp < Date.now()) {
    return { status: 410, error: "LINK_EXPIRED", expiresAt: pub.expiresAt };
  }
  return null;
}

/* What the branch is allowed to see: every finding of the audit — closed ones
   included, so they can re-read what was already accepted — but only the
   columns they need. QA-only footer notes, KPIs and internal metadata never
   leave the server.

   Closed rows are reference material: the POST handler below refuses any
   evidence aimed at one, so sending them is safe.

   Each row carries its ORIGINAL index as `rowIndex` so evidence posted back
   still lands on the right finding no matter how the portal orders them. */
function sanitizeInspectionReport(row) {
  const payload = isObj(row.payload) ? row.payload : {};
  const header = isObj(payload.header) ? payload.header : {};
  const fields = isObj(payload.fields) ? payload.fields : {};
  const pub = isObj(payload.public) ? payload.public : {};
  const table = Array.isArray(payload.table) ? payload.table : [];

  let closedCount = 0;
  const visible = table.map((r, idx) => {
    if (isRowClosed(r)) closedCount += 1;
    const src = isObj(r) ? r : {};
    return {
      rowIndex: idx,
      nonConformance: src.nonConformance ?? "",
      rootCause: src.rootCause ?? "",
      corrective: src.corrective ?? "",
      risk: src.risk ?? "",
      status: src.status ?? "",
      evidenceImgs: Array.isArray(src.evidenceImgs) ? src.evidenceImgs : [],
      closedEvidenceImgs: Array.isArray(src.closedEvidenceImgs) ? src.closedEvidenceImgs : [],
      closedEvidenceNote: src.closedEvidenceNote ?? "",
      /* The verdict is meant for the branch to read — a rejection is useless
         if they can't see why it was rejected. */
      verification: isObj(src.verification) ? src.verification : null,
    };
  });

  const visibleIdx = new Set(visible.map((r) => r.rowIndex));
  const updates = (Array.isArray(fields.closedEvidenceUpdates) ? fields.closedEvidenceUpdates : [])
    .filter((u) => visibleIdx.has(Number(u?.rowIndex)));

  return {
    id: row.id,
    type: row.type,
    /* header.location is legacy-only — reports saved before the Location field
       was removed kept the branch there and nowhere else. */
    branch: row.branch || payload.branch || header.branch || header.location || "",
    created_at: row.created_at,
    payload: {
      title: payload.title || "Internal Audit Report",
      branch: payload.branch ?? "",
      header: {
        date: header.date ?? "",
        reportNo: header.reportNo ?? "",
        auditConductedBy: header.auditConductedBy ?? "",
        branch: header.branch ?? "",
        location: header.location ?? "",
      },
      table: visible,
      fields: {
        closedEvidenceUpdates: updates,
        closedEvidenceUploadedBy: fields.closedEvidenceUploadedBy ?? "",
        closedEvidenceProgressSavedAt: fields.closedEvidenceProgressSavedAt ?? null,
        closedEvidenceSubmittedAt: fields.closedEvidenceSubmittedAt ?? null,
      },
      public: {
        token: pub.token ?? "",
        mode: pub.mode || INSPECTION_MODE,
        status: pub.status ?? "pending_evidence",
        createdAt: pub.createdAt ?? null,
        expiresAt: pub.expiresAt ?? null,
        submittedAt: pub.submittedAt ?? null,
        openedAt: pub.openedAt ?? null,
      },
      summary: {
        totalFindings: table.length,
        openFindings: visible.length - closedCount,
        closedFindings: closedCount,
      },
    },
  };
}

app.post("/api/supplier-links", strict, async (req, res) => {
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

app.get("/api/supplier-links/:token", publicLimiter, async (req, res) => {
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
app.post("/api/supplier-links/:token/submit", publicLimiter, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const token = normText(req.params.token);
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const body = isObj(req.body) ? req.body : {};
    const recordDate = normText(body.recordDate || "");
    const fields = cleanJsonbObject(body.fields);
    const answers = cleanJsonbObject(body.answers);
    const attachments = cleanJsonbArray(body.attachments);
    const fieldAttachments =
      isObj(body.fieldAttachments) && !Array.isArray(body.fieldAttachments) ? cleanJsonbObject(body.fieldAttachments) : {};
    const productsList = cleanJsonbArray(body.productsList);
    const declaration = cleanJsonbObject(body.declaration);
    const supplierType = normText(body.supplierType || fields.supplier_type || "");

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

    const mergedFields = cleanJsonbObject({ ...(isObj(payload.fields) ? payload.fields : {}), ...(fields || {}) });
    const mergedAnswers = cleanJsonbObject({ ...(isObj(payload.answers) ? payload.answers : {}), ...(answers || {}) });

    const existingFieldAtt = isObj(payload.fieldAttachments) ? payload.fieldAttachments : {};
    const mergedFieldAtt = cleanJsonbObject({ ...existingFieldAtt, ...safeObj(fieldAttachments) });

    const newPayload = cleanJsonbObject({
      ...payload,
      recordDate: recordDate || normText(payload.recordDate) || todayISO(),
      fields: mergedFields,
      answers: mergedAnswers,
      attachments: attachments.length ? attachments : Array.isArray(payload.attachments) ? cleanJsonbArray(payload.attachments) : [],
      fieldAttachments: Object.keys(mergedFieldAtt).length ? mergedFieldAtt : existingFieldAtt,
      productsList: productsList.length ? productsList : Array.isArray(payload.productsList) ? cleanJsonbArray(payload.productsList) : [],
      declaration: Object.keys(declaration).length ? declaration : cleanJsonbObject(payload.declaration),
      supplierType: supplierType || normText(payload.supplierType || payload?.public?.supplierType || ""),
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
        supplierType: supplierType || normText(payload?.public?.supplierType || ""),
      },
    });

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
    await rollbackQuietly(client);
    console.error("POST /api/supplier-links/:token/submit ERROR =", e);
    return sendDbError(res, e);
  } finally {
    if (client) client.release();
  }
});

/* ======================================================================
   ✅ SUPPLIER PUBLIC TOKEN API (AUTO-CREATE if not found)
====================================================================== */
app.get("/api/reports/public/:token", publicLimiter, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
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
      const row = q.rows[0];
      if (isInspectionRow(row)) {
        const problem = inspectionLinkProblem(row.payload);
        if (problem) return res.status(problem.status).json({ ok: false, ...problem });
        /* Branches get the filtered projection — never the raw row. */
        return res.json({ ok: true, report: sanitizeInspectionReport(row), created: false });
      }
      return res.json({ ok: true, report: row, created: false });
    }

    /* An inspection token that resolves to nothing is a dead link (report
       deleted, token rotated, or a typo). Auto-creating a blank supplier form
       for it would both mislead the branch and litter the reports table with
       junk rows from an unauthenticated endpoint. */
    if (INSPECTION_TOKEN_RE.test(token)) {
      return res.status(404).json({ ok: false, error: "LINK_NOT_FOUND" });
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
    await rollbackQuietly(client);
    console.error("GET /api/reports/public/:token ERROR =", e);
    return sendDbError(res, e);
  } finally {
    if (client) client.release();
  }
});

/* Best-effort: record the first time a supplier opened the link.
   Public (no auth) but strictly scoped — it ONLY ever writes
   payload.public.openedAt on the report that owns this token, and only
   once (WHERE openedAt IS NULL). No client-supplied payload is trusted,
   so the generic PUT /api/reports/:id can stay behind requireAuth. */
app.post("/api/reports/public/:token/opened", publicLimiter, async (req, res) => {
  try {
    const token = normText(req.params.token || "");
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const upd = await pool.query(
      `UPDATE reports
          SET payload = jsonb_set(payload, '{public,openedAt}', to_jsonb($2::text), true),
              updated_at = now()
        WHERE (payload->'public'->>'token') = $1
          AND (payload->'public'->>'openedAt') IS NULL`,
      [token, new Date().toISOString()]
    );
    return res.json({ ok: true, updated: upd.rowCount });
  } catch (e) {
    console.error("POST /api/reports/public/:token/opened ERROR =", e);
    // never fail the supplier's page open over a tracking write
    return res.json({ ok: true, updated: 0 });
  }
});

/* ✅ UPDATED submit: supports recordDate + fieldAttachments */
app.post("/api/reports/public/:token/submit", publicLimiter, async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    const token = normText(req.params.token || "");
    if (!token) return res.status(400).json({ ok: false, error: "token required" });

    const body = isObj(req.body) ? req.body : {};
    const recordDate = normText(body.recordDate || "");
    const fields = cleanJsonbObject(body.fields);
    const answers = cleanJsonbObject(body.answers);
    const attachments = cleanJsonbArray(body.attachments);
    const fieldAttachments =
      isObj(body.fieldAttachments) && !Array.isArray(body.fieldAttachments) ? cleanJsonbObject(body.fieldAttachments) : {};
    const productsList = cleanJsonbArray(body.productsList);
    const declaration = cleanJsonbObject(body.declaration);
    const supplierType = normText(body.supplierType || fields.supplier_type || "");

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
      const submissionType = normText(body.submissionType || fields.submissionType || "");
      const publicMode = normText(payload?.public?.mode || "");
      const isInspectionEvidence =
        submissionType === "inspection_closed_evidence" ||
        publicMode === "INSPECTION_CLOSED_EVIDENCE_ONLY" ||
        q.rows[0].type === "internal_multi_audit";

      if (isInspectionEvidence) {
        const payloadToken = normText(payload?.public?.token || "");
        if (payloadToken !== token) {
          await client.query("ROLLBACK");
          return res.status(403).json({ ok: false, error: "TOKEN_MISMATCH" });
        }

        /* Same gate as the GET — an expired or revoked link must not accept
           uploads either, otherwise revoking it means nothing. */
        const problem = inspectionLinkProblem(payload);
        if (problem) {
          await client.query("ROLLBACK");
          return res.status(problem.status).json({ ok: false, ...problem });
        }

        const uploadedBy = normText(body.uploadedBy || fields.closedEvidenceUploadedBy || "");
        if (!uploadedBy) {
          await client.query("ROLLBACK");
          return res.status(400).json({ ok: false, error: "uploadedBy required" });
        }

        const imageUrl = (img) => {
          if (!img) return "";
          if (typeof img === "string") return normText(img);
          if (!isObj(img)) return "";
          return normText(
            img.url ||
            img.optimized_url ||
            img.optimizedUrl ||
            img.secure_url ||
            img.secureUrl ||
            img.originalUrl ||
            img.original_url ||
            img.src ||
            img.href ||
            ""
          );
        };
        const cleanImages = (images) =>
          (Array.isArray(images) ? images : [])
            .map((img) => {
              const url = imageUrl(img);
              return url ? { ...(isObj(img) ? img : {}), url } : null;
            })
            .filter(Boolean);
        const cleanUpdates = (updates) =>
          (Array.isArray(updates) ? updates : [])
            .map((item) => {
              const rowIndex = Number(item?.rowIndex);
              if (!Number.isInteger(rowIndex) || rowIndex < 0) return null;
              return {
                rowIndex,
                images: cleanImages(item?.images),
                note: normText(item?.note || ""),
              };
            })
            .filter((item) => item && (item.images.length || item.note));

        const auditTable = Array.isArray(payload.table) ? payload.table : [];
        /* The portal lists closed findings as read-only reference, so this is
           the gate that makes "read-only" real: anything aimed at a closed row
           (or at an index that no longer exists after a QA edit) is dropped
           rather than silently written to the wrong finding. */
        const incomingUpdates = cleanUpdates(body.closedEvidenceUpdates)
          .filter((item) => item.rowIndex < auditTable.length && !isRowClosed(auditTable[item.rowIndex]));
        if (!incomingUpdates.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({ ok: false, error: "closedEvidenceUpdates required" });
        }

        const submittedAt = new Date().toISOString();
        const existingFields = isObj(payload.fields) ? payload.fields : {};
        const previousUpdates = cleanUpdates(existingFields.closedEvidenceUpdates);
        const updatesByRow = new Map();
        [...previousUpdates, ...incomingUpdates].forEach((item) => {
          const previous = updatesByRow.get(item.rowIndex) || { rowIndex: item.rowIndex, images: [], note: "" };
          const seen = new Set(previous.images.map((img) => imageUrl(img)).filter(Boolean));
          item.images.forEach((img) => {
            const url = imageUrl(img);
            if (url && !seen.has(url)) {
              previous.images.push(img);
              seen.add(url);
            }
          });
          if (item.note) previous.note = item.note;
          updatesByRow.set(item.rowIndex, previous);
        });
        const closedEvidenceUpdates = Array.from(updatesByRow.values()).sort((a, b) => a.rowIndex - b.rowIndex);
        const updateForRow = new Map(closedEvidenceUpdates.map((item) => [item.rowIndex, item]));

        const final = body.final === true;
        const table = Array.isArray(payload.table) ? payload.table : [];
        const nextTable = table.map((row, idx) => {
          const update = updateForRow.get(idx);
          if (!update) return row;
          const base = isObj(row) ? row : {};
          const existingImgs = (Array.isArray(base.closedEvidenceImgs) ? base.closedEvidenceImgs : [])
            .map(imageUrl)
            .filter(Boolean);
          const incomingImgs = update.images.map(imageUrl).filter(Boolean);
          const mergedImgs = Array.from(new Set([...existingImgs, ...incomingImgs]));
          const next = {
            ...base,
            closedEvidenceImgs: mergedImgs,
            ...(update.note ? { closedEvidenceNote: update.note } : {}),
          };
          /* A final submission hands the finding over to QA. Without this the
             row stayed "Open" until somebody remembered to edit it by hand,
             which is exactly how findings went stale. Saving progress does
             NOT trigger it — the branch is still working. */
          if (final && mergedImgs.length && !isRowClosed(base)) {
            next.status = PENDING_VERIFICATION_STATUS;
            next.verification = { state: "pending", at: submittedAt, by: uploadedBy };
          }
          return next;
        });

        const newPayload = {
          ...payload,
          table: nextTable,
          fields: {
            ...existingFields,
            closedEvidenceUpdates,
            closedEvidenceProgressSavedAt: submittedAt,
            closedEvidenceSubmittedAt: final ? submittedAt : existingFields.closedEvidenceSubmittedAt || null,
            closedEvidenceUploadedBy: uploadedBy,
            /* The entry form retired the free-text Location field; the branch
               now lives in payload.branch / header.branch. Legacy reports only
               have header.location, so it stays last in the chain. */
            submittedBy: normText(
              payload?.branch || payload?.header?.branch || payload?.header?.location || "branch"
            ),
            submissionType: "inspection_closed_evidence",
          },
          public: {
            ...(isObj(payload.public) ? payload.public : {}),
            token,
            mode: publicMode || "INSPECTION_CLOSED_EVIDENCE_ONLY",
            submittedAt: final ? submittedAt : payload?.public?.submittedAt || null,
            status: final ? "evidence_submitted" : "evidence_in_progress",
          },
        };

        const upd = await client.query(
          `UPDATE reports SET payload=$1::jsonb, updated_at=now() WHERE id=$2 RETURNING *`,
          [JSON.stringify(newPayload), reportId]
        );

        await client.query("COMMIT");
        /* Filtered again on the way out — the client re-renders from this. */
        return res.json({
          ok: true,
          reportId,
          token,
          submittedAt,
          report: sanitizeInspectionReport(upd.rows[0]),
        });
      }

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

    const mergedFields = cleanJsonbObject({ ...(isObj(payload.fields) ? payload.fields : {}), ...(fields || {}) });
    const mergedAnswers = cleanJsonbObject({ ...(isObj(payload.answers) ? payload.answers : {}), ...(answers || {}) });

    const existingFieldAtt = isObj(payload.fieldAttachments) ? payload.fieldAttachments : {};
    const mergedFieldAtt = cleanJsonbObject({ ...existingFieldAtt, ...safeObj(fieldAttachments) });

    const newPayload = cleanJsonbObject({
      ...payload,
      recordDate: recordDate || normText(payload.recordDate) || todayISO(),
      fields: mergedFields,
      answers: mergedAnswers,
      attachments: attachments.length ? attachments : Array.isArray(payload.attachments) ? cleanJsonbArray(payload.attachments) : [],
      fieldAttachments: Object.keys(mergedFieldAtt).length ? mergedFieldAtt : existingFieldAtt,
      productsList: productsList.length ? productsList : Array.isArray(payload.productsList) ? cleanJsonbArray(payload.productsList) : [],
      declaration: Object.keys(declaration).length ? declaration : cleanJsonbObject(payload.declaration),
      supplierType: supplierType || normText(payload.supplierType || payload?.public?.supplierType || ""),
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
        supplierType: supplierType || normText(payload?.public?.supplierType || ""),
      },
    });

    await client.query(`UPDATE reports SET payload=$1::jsonb, updated_at=now() WHERE id=$2`, [
      JSON.stringify(newPayload),
      reportId,
    ]);

    await client.query("COMMIT");
    return res.json({ ok: true, reportId, token, submittedAt });
  } catch (e) {
    await rollbackQuietly(client);
    console.error("POST /api/reports/public/:token/submit ERROR =", e);
    return sendDbError(res, e);
  } finally {
    if (client) client.release();
  }
});
};
