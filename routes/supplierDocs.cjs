/* ============================================================
   Supplier document upload link — /api/supplier-docs/:token

   QA asks an evaluated supplier for the paperwork that is still missing
   (signed declaration, Halal declaration, Halal certificate, questionnaire
   attachments). The results page mints payload.docRequest on the evaluation:
     { token: "sdr_<32 hex>", createdAt, expiresAt, by,
       items: [{ key, en, ar }], uploads: { key: [file] } }
   and e-mails the link. The supplier opens it without an account and uploads
   each document; every upload lands straight in the evaluation where the
   results page reads it — no QA re-typing.

   Public on purpose, so it is narrow on purpose:
     • the token only resolves to an evaluation that minted it;
     • a key can only be one the request listed;
     • a file must be an https Cloudinary URL (what /api/images returns) —
       never base64, never an arbitrary link;
     • nothing else in the payload can be written from here.
============================================================ */
const { raiseAlert } = require("../utils/alertEngine.cjs");

module.exports = function registerSupplierDocsRoutes(app, deps = {}) {
  const { pool, normText, isObj, rollbackQuietly, sendDbError, makeLimiter } = deps;
  const noGate = (_req, _res, next) => next();
  const limiter = typeof makeLimiter === "function"
    ? makeLimiter({ max: 40, windowMs: 60_000, name: "supplier-docs" })
    : noGate;

  const TOKEN_RE = /^sdr_[0-9a-f]{32}$/;
  const KEY_RE = /^(signed_declaration|halal_declaration|halal_certificate|att_[a-z0-9_]{1,40})$/;
  const MAX_FILES_PER_KEY = 10;

  const obj = (v) => (isObj(v) ? v : {});
  const clean = (v, n = 300) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, n);

  function requestProblem(dr) {
    if (!dr || !dr.token) return { status: 404, error: "LINK_NOT_FOUND" };
    if (dr.revokedAt) return { status: 410, error: "LINK_DISABLED" };
    const exp = dr.expiresAt ? Date.parse(dr.expiresAt) : NaN;
    if (Number.isFinite(exp) && exp < Date.now()) return { status: 410, error: "LINK_EXPIRED", expiresAt: dr.expiresAt };
    return null;
  }

  function cleanFile(f) {
    const x = obj(f);
    const url = clean(x.url, 1000);
    let host = "";
    try {
      const u = new URL(url);
      if (u.protocol !== "https:") return null;
      host = u.hostname;
    } catch {
      return null;
    }
    if (!/(^|\.)cloudinary\.com$/i.test(host)) return null;
    return {
      url,
      name: clean(x.name, 200) || "document",
      contentType: clean(x.contentType, 100),
      uploadedAt: new Date().toISOString(),
      uploadedBy: "supplier",
    };
  }

  /* What the supplier page needs — and nothing more of the evaluation. */
  function publicView(row) {
    const p = obj(row.payload);
    const f = obj(p.fields);
    const dr = obj(p.docRequest);
    const products = (Array.isArray(p.productsList) ? p.productsList : [])
      .map((x) => clean(typeof x === "string" ? x : x?.name, 120))
      .filter(Boolean)
      .slice(0, 60);
    return {
      company: clean(f.company_name, 200),
      buyer: clean(dr.buyer, 200),
      supplierType: clean(f.supplier_type || p.public?.supplierType, 40),
      items: (Array.isArray(dr.items) ? dr.items : []).map((it) => ({
        key: clean(it?.key, 60),
        en: clean(it?.en, 200),
        ar: clean(it?.ar, 200),
      })),
      uploads: Object.fromEntries(
        Object.entries(obj(dr.uploads)).map(([k, list]) => [
          k,
          (Array.isArray(list) ? list : []).map((x) => ({ name: clean(x?.name, 200), uploadedAt: x?.uploadedAt || "" })),
        ])
      ),
      expiresAt: dr.expiresAt || "",
      halalForm: {
        company_name: clean(f.company_name, 200),
        company_address: clean(f.company_address, 300),
        tqm_contact_name: clean(f.tqm_contact_name, 120),
        tqm_telephone: clean(f.tqm_telephone, 60),
        products,
      },
    };
  }

  async function findByToken(client, token, lock) {
    const q = await client.query(
      `SELECT id, company_id, payload FROM reports
        WHERE type = 'supplier_self_assessment_form'
          AND (payload->'docRequest'->>'token') = $1
        ORDER BY id DESC LIMIT 1 ${lock ? "FOR UPDATE" : ""}`,
      [token]
    );
    return q.rows[0] || null;
  }

  app.get("/api/supplier-docs/:token", limiter, async (req, res) => {
    try {
      const token = normText(req.params.token || "");
      if (!TOKEN_RE.test(token)) return res.status(404).json({ ok: false, error: "LINK_NOT_FOUND" });
      const row = await findByToken(pool, token, false);
      if (!row) return res.status(404).json({ ok: false, error: "LINK_NOT_FOUND" });
      const problem = requestProblem(obj(row.payload).docRequest);
      if (problem) return res.status(problem.status).json({ ok: false, ...problem });
      return res.json({ ok: true, request: publicView(row) });
    } catch (e) {
      console.error("GET /api/supplier-docs/:token ERROR =", e);
      return sendDbError(res, e);
    }
  });

  app.post("/api/supplier-docs/:token/upload", limiter, async (req, res) => {
    let client;
    try {
      const token = normText(req.params.token || "");
      if (!TOKEN_RE.test(token)) return res.status(404).json({ ok: false, error: "LINK_NOT_FOUND" });
      const body = obj(req.body);
      const key = clean(body.key, 60);
      if (!KEY_RE.test(key)) return res.status(400).json({ ok: false, error: "BAD_KEY" });
      const file = cleanFile(body.file);
      if (!file) return res.status(400).json({ ok: false, error: "BAD_FILE" });

      client = await pool.connect();
      await client.query("BEGIN");
      const row = await findByToken(client, token, true);
      if (!row) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, error: "LINK_NOT_FOUND" });
      }
      const p = obj(row.payload);
      const dr = obj(p.docRequest);
      const problem = requestProblem(dr);
      if (problem) {
        await client.query("ROLLBACK");
        return res.status(problem.status).json({ ok: false, ...problem });
      }
      if (!(Array.isArray(dr.items) ? dr.items : []).some((it) => it?.key === key)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "KEY_NOT_REQUESTED" });
      }
      const uploads = obj(dr.uploads);
      const list = Array.isArray(uploads[key]) ? uploads[key] : [];
      if (list.length >= MAX_FILES_PER_KEY) {
        await client.query("ROLLBACK");
        return res.status(400).json({ ok: false, error: "TOO_MANY_FILES" });
      }

      const now = new Date().toISOString();
      const next = { ...p, docRequest: { ...dr, uploads: { ...uploads, [key]: [...list, file] }, lastUploadAt: now } };

      // land the file where the results page reads it
      if (key === "signed_declaration") {
        next.declaration = { ...obj(p.declaration), file };
      } else if (key === "halal_declaration") {
        next.halal = { ...obj(p.halal), declarationFile: file, receivedAt: now, signedOn: "" };
      } else if (key === "halal_certificate") {
        const cert = obj(body.cert);
        const expiry = /^\d{4}-\d{2}-\d{2}$/.test(clean(cert.expiry, 10)) ? clean(cert.expiry, 10) : "";
        next.halal = {
          ...obj(p.halal),
          certificateFile: file,
          hasCertificate: true,
          ...(clean(cert.no, 80) ? { certNo: clean(cert.no, 80) } : {}),
          ...(clean(cert.body, 120) ? { certBody: clean(cert.body, 120) } : {}),
          ...(expiry ? { certExpiry: expiry } : {}),
        };
      } else {
        const fa = obj(p.fieldAttachments);
        next.fieldAttachments = { ...fa, [key]: [...(Array.isArray(fa[key]) ? fa[key] : []), file] };
      }
      const log = Array.isArray(p.changeLog) ? p.changeLog : [];
      next.changeLog = [...log, { at: now, by: "Supplier (upload link)", action: "upload", detail: `${key}: ${file.name}` }].slice(-300);
      next.meta = { ...obj(p.meta), updatedAt: now };

      await client.query(`UPDATE reports SET payload = $1::jsonb, updated_at = now() WHERE id = $2`, [JSON.stringify(next), row.id]);
      await client.query("COMMIT");

      // QA's bell: the paperwork they asked for has arrived (best effort)
      try {
        const item = (dr.items || []).find((it) => it?.key === key);
        await raiseAlert(pool, {
          companyId: row.company_id ?? null,
          rule: "supplierDocs",
          severity: "info",
          title: `${clean(obj(p.fields).company_name, 120) || "Supplier"} uploaded: ${clean(item?.en, 120) || key}`,
          body: file.name,
          link: "/haccp-iso/supplier-evaluation/results",
          dedupeKey: `sdr:${row.id}:${key}:${list.length + 1}`,
        });
      } catch (e) {
        console.warn("supplier-docs alert failed:", e?.message || e);
      }
      return res.json({ ok: true, request: publicView({ payload: next }) });
    } catch (e) {
      await rollbackQuietly(client);
      console.error("POST /api/supplier-docs/:token/upload ERROR =", e);
      return sendDbError(res, e);
    } finally {
      if (client) client.release();
    }
  });
};
