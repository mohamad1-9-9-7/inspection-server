/* ============================================================
   Erase a company for good, with everything it owns.

   Shared by the owner's manual delete (routes/billing.cjs — password +
   exact name checked THERE, before calling this) and the self-service
   trial sweep (routes/trial.cjs — expired trial companies only).
   This function checks nothing about WHO asked: callers must.

   ONE transaction: every row goes, or none does. Order = children before
   the company, whose FKs RESTRICT: report_audit, email_history, invoices,
   subscription, product_catalog, the accounts' activity_log and the
   accounts themselves, the reports (training_links / supplier_links
   cascade with them), the company's reference counters, then the company
   row. Platform quotations keep their copy of the client's name (their FK
   is ON DELETE SET NULL). The company's upload folder on Cloudinary is
   emptied afterwards, best effort — a storage hiccup never undoes a
   finished delete. The primary company (id 1) can never be erased.
============================================================ */
const { markCompanyDisabled } = require("./companyGate.cjs");

const DELETE_COUNTS_SQL = `
  SELECT
    (SELECT COUNT(*)::int FROM reports       WHERE company_id = $1) AS reports,
    (SELECT COUNT(*)::int FROM app_users     WHERE company_id = $1) AS accounts,
    (SELECT COUNT(*)::int FROM report_audit  WHERE company_id = $1) AS audit_rows,
    (SELECT COUNT(*)::int FROM email_history WHERE company_id = $1) AS emails,
    (SELECT COUNT(*)::int FROM invoices      WHERE company_id = $1) AS invoices,
    (SELECT COUNT(*)::int FROM product_catalog WHERE company_id = $1) AS catalog_items`;

/** → { company, counts } or null when there is no such company. Throws on DB errors (rolled back). */
async function eraseCompany(pool, id) {
  if (!(Number.isInteger(id) && id > 1)) throw new Error("erase_refused_primary_or_bad_id");
  const company = (await pool.query(`SELECT id, name, industry, logo_url FROM companies WHERE id = $1`, [id])).rows[0];
  if (!company) return null;

  const client = await pool.connect();
  let counts;
  try {
    await client.query("BEGIN");
    counts = (await client.query(DELETE_COUNTS_SQL, [id])).rows[0];
    await client.query(`DELETE FROM report_audit    WHERE company_id = $1`, [id]);
    await client.query(`DELETE FROM email_history   WHERE company_id = $1`, [id]);
    await client.query(`DELETE FROM invoices        WHERE company_id = $1`, [id]);
    await client.query(`DELETE FROM subscription    WHERE company_id = $1`, [id]);
    await client.query(`DELETE FROM product_catalog WHERE company_id = $1`, [id]);
    await client.query(`DELETE FROM activity_log WHERE user_id IN (SELECT id FROM app_users WHERE company_id = $1)`, [id]);
    await client.query(`DELETE FROM app_users       WHERE company_id = $1`, [id]);
    await client.query(`DELETE FROM reports         WHERE company_id = $1`, [id]);
    await client.query(`DELETE FROM report_counters WHERE type LIKE $1`, [`%:c${id}`]);
    await client.query(`DELETE FROM companies       WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* already gone */ }
    throw e;
  } finally {
    client.release();
  }
  markCompanyDisabled(id, false);

  // After the commit: empty its storage folder (and its card picture).
  purgeCompanyFiles(company).catch((e) => console.warn("[companies] file purge:", e?.message || e));
  return { company, counts };
}

/* Same folder rule as routes/media.cjs folderFor(): <base>/companies/<industry>/c<id>. */
async function purgeCompanyFiles(company) {
  const cloudinary = require("cloudinary").v2;
  const cfg = cloudinary.config();
  if (!cfg.cloud_name || !cfg.api_key || !cfg.api_secret) return;
  const base = process.env.CLOUDINARY_FOLDER || "qcs";
  const seg = String(company.industry || "other").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "other";
  const prefix = `${base}/companies/${seg}/c${company.id}/`;
  for (const resource_type of ["image", "raw", "video"]) {
    for (let i = 0; i < 20; i++) { // 1000 per call; 20 rounds = far beyond any real company
      const out = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type });
      if (!out?.partial) break;
    }
  }
  // The card picture was uploaded from the Platform Center, outside that folder.
  const m = /\/upload\/(?:[^/]+\/)*v\d+\/(.+)\.[a-z0-9]+$/i.exec(String(company.logo_url || ""));
  if (m) await cloudinary.uploader.destroy(m[1], { invalidate: true });
}

module.exports = { eraseCompany, DELETE_COUNTS_SQL };
