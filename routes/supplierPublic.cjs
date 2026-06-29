module.exports = function registerSupplierPublicRoutes(app, deps = {}) {
  const { pool, clampInt, normText, todayISO, safeObj, rollbackQuietly, sendDbError } = deps;

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
app.get("/api/reports/public/:token", async (req, res) => {
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
    await rollbackQuietly(client);
    console.error("GET /api/reports/public/:token ERROR =", e);
    return sendDbError(res, e);
  } finally {
    if (client) client.release();
  }
});

/* ✅ UPDATED submit: supports recordDate + fieldAttachments */
app.post("/api/reports/public/:token/submit", async (req, res) => {
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

        const incomingUpdates = cleanUpdates(body.closedEvidenceUpdates);
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

        const table = Array.isArray(payload.table) ? payload.table : [];
        const nextTable = table.map((row, idx) => {
          const update = updateForRow.get(idx);
          if (!update) return row;
          const existingImgs = (Array.isArray(row?.closedEvidenceImgs) ? row.closedEvidenceImgs : [])
            .map(imageUrl)
            .filter(Boolean);
          const incomingImgs = update.images.map(imageUrl).filter(Boolean);
          return {
            ...(isObj(row) ? row : {}),
            closedEvidenceImgs: Array.from(new Set([...existingImgs, ...incomingImgs])),
            ...(update.note ? { closedEvidenceNote: update.note } : {}),
          };
        });

        const final = body.final === true;
        const newPayload = {
          ...payload,
          table: nextTable,
          fields: {
            ...existingFields,
            closedEvidenceUpdates,
            closedEvidenceProgressSavedAt: submittedAt,
            closedEvidenceSubmittedAt: final ? submittedAt : existingFields.closedEvidenceSubmittedAt || null,
            closedEvidenceUploadedBy: uploadedBy,
            submittedBy: normText(payload?.header?.location || payload?.branch || "branch"),
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
        return res.json({ ok: true, reportId, token, submittedAt, report: upd.rows[0] });
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
