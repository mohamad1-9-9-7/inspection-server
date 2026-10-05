/* ============================================================
   Tenant isolation INSIDE the database (Postgres Row-Level Security)

   The application already filters every query by company_id. This is the
   second lock: even a query that FORGETS that filter cannot return or touch
   another company's rows, because Postgres itself hides them.

   How it works
   ------------
   • The server connects as the database owner (neondb_owner), which has
     BYPASSRLS — policies never apply to it. So every request made by a
     COMPANY account runs its queries as a separate role, `app_tenant`
     (NOBYPASSRLS), with the company in a transaction-local setting:
         BEGIN; SET LOCAL ROLE app_tenant;
         SELECT set_config('app.company_id', '<id>', true); … ; COMMIT
     (db/pool.cjs does this; see tenantContext.cjs for which requests).
   • Transaction-local on purpose: Neon's pooler (PgBouncer, transaction
     mode) hands each transaction to any server connection, so a session
     setting could leak to another request or be lost. Inside one
     transaction it can do neither.
   • The platform super-admin, public token pages, login and boot migrations
     carry no company and keep running as the owner — exactly as before.
   • A company request whose setting is somehow missing sees NOTHING
     (NULL = no row matches): the policy fails closed, never open.

   Measured before building (30 Sep 2026, copy of the live reports table):
   every query shape keeps its index scan; timings within noise.

   Idempotent — safe on every boot. Enabling RLS changes nothing for the
   owner role, so this step alone alters no behaviour; the pool switch
   (TENANT_RLS=on) is what starts using it.
============================================================ */

const TENANT_ROLE = "app_tenant";
/* Versioned name: to change the rule later, add a new version (and drop the
   old one) instead of re-creating the policy on every boot. */
const POLICY = "tenant_isolation_v1";

/* Every table holding one company's rows, and the column naming the company. */
const TENANT_TABLES = [
  ["reports", "company_id"],
  ["report_audit", "company_id"],
  ["email_history", "company_id"],
  ["product_catalog", "company_id"],
  ["app_users", "company_id"],
  ["invoices", "company_id"],
  ["subscription", "company_id"],
  ["companies", "id"],
  ["payment_proofs", "company_id"],
];

async function ensureTenantRls(pool) {
  try {
    const exists = await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [TENANT_ROLE]);
    if (!exists.rowCount) {
      await pool.query(`CREATE ROLE ${TENANT_ROLE} NOLOGIN NOBYPASSRLS NOINHERIT`);
    }
    // The owner must be able to SET ROLE to it (PG16+ does not grant SET by default).
    await pool.query(`GRANT ${TENANT_ROLE} TO CURRENT_USER WITH SET TRUE`).catch(async () => {
      await pool.query(`GRANT ${TENANT_ROLE} TO CURRENT_USER`);
    });

    // Data rights only (never DDL). Tables without a company column
    // (counters, plans, settings, logs) stay readable/writable as before —
    // the policies below are what confine the tenant tables.
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${TENANT_ROLE}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TENANT_ROLE}`);
    await pool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${TENANT_ROLE}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${TENANT_ROLE}`);
    await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${TENANT_ROLE}`);

    for (const [table, col] of TENANT_TABLES) {
      const t = await pool.query(`SELECT to_regclass($1) AS r`, [`public.${table}`]);
      if (!t.rows[0].r) continue;
      // Only what is missing: ALTER TABLE / CREATE POLICY take a brief
      // exclusive lock, which a routine boot has no reason to take.
      const st = await pool.query(
        `SELECT c.relrowsecurity AS rls_on,
                EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = $1 AND p.policyname = $2) AS has
           FROM pg_class c WHERE c.oid = $3::regclass`,
        [table, POLICY, `public.${table}`]
      );
      if (!st.rows[0].rls_on) await pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      if (st.rows[0].has) continue;
      await pool.query(`
        CREATE POLICY ${POLICY} ON ${table}
          TO ${TENANT_ROLE}
          USING      (${col} = NULLIF(current_setting('app.company_id', true), '')::int)
          WITH CHECK (${col} = NULLIF(current_setting('app.company_id', true), '')::int)`);
    }
    console.log(`[rls] tenant isolation policies in place on ${TENANT_TABLES.length} tables`);
    return true;
  } catch (e) {
    // Never block boot. Without the role, db/pool.cjs keeps the owner path.
    console.warn("[rls] setup skipped:", e?.message || e);
    return false;
  }
}

module.exports = { ensureTenantRls, TENANT_ROLE };
