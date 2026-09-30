const pg = require("pg");

const { Pool } = pg;

function withSSL(url) {
  if (!url) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
  }
  return url.includes("?") ? `${url}&sslmode=require` : `${url}?sslmode=require`;
}

const pool = new Pool({
  connectionString: withSSL(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
  /* No statement_timeout here: DATABASE_URL goes through Neon's pooler
     (PgBouncer, transaction mode), which silently IGNORES connection
     settings — measured 30 Sep 2026: SHOW statement_timeout = 0. Timeouts
     are set per transaction instead (SET LOCAL, see confine() below). */
});

pool.on("error", (err) => {
  console.error("Pool connection error (auto-recovered):", err.message);
});

/* ============================================================
   Tenant confinement (see db/tenantRls.cjs + utils/tenantContext.cjs)

   While a COMPANY account's request is running, every query it makes goes
   through the database as `app_tenant` with that company's id set, inside
   a transaction — Postgres then refuses any row of another company, even
   if a route forgets its company filter. Nothing changes for requests
   without a company (super-admin, public pages, login, boot): they keep
   the plain owner path below.

   Two entry points are wrapped, because routes use both:
     • pool.query(...)  → one confined transaction around the statement;
     • pool.connect()   → the client confines the transaction the route
       opens itself (right after its BEGIN), and wraps any lone statement
       it runs outside one.
   The company id is an integer from a verified token, never user text.
============================================================ */
const { currentTenant } = require("../utils/tenantContext.cjs");

let tenantRlsReady = false; // set at boot once the role + policies exist AND TENANT_RLS=on
function setTenantRlsReady(v) { tenantRlsReady = !!v; }
const tenantOf = () => (tenantRlsReady ? currentTenant() : null);

/* Also a 60 s ceiling per statement: every company shares these 5
   connections, and one company's runaway query must not hold one of them
   for everybody. Far above any real request (a 5000-row read takes seconds). */
const confine = (id) =>
  `SET LOCAL ROLE app_tenant; SET LOCAL statement_timeout = '60s'; SELECT set_config('app.company_id', '${Number(id)}', true)`;
const origQuery = pool.query.bind(pool);
const origConnect = pool.connect.bind(pool);

async function inConfinedTx(q, id, args) {
  await q(`BEGIN; ${confine(id)}`);
  try {
    const r = await q(...args);
    await q("COMMIT");
    return r;
  } catch (e) {
    await q("ROLLBACK").catch(() => {});
    throw e;
  }
}

pool.query = function tenantAwareQuery(...args) {
  const id = tenantOf();
  if (id == null || typeof args[args.length - 1] === "function") return origQuery(...args);
  return (async () => {
    const client = await origConnect();
    let broken = null;
    try {
      return await inConfinedTx(client.query.bind(client), id, args);
    } catch (e) {
      if (isDbConnectivityError(e)) broken = e;
      throw e;
    } finally {
      client.release(broken || undefined);
    }
  })();
};

const TX_OPEN = /^\s*(BEGIN|START\s+TRANSACTION)\b/i;
const TX_CLOSE = /^\s*(COMMIT|END|ROLLBACK|ABORT)\b(?!\s+TO\b)/i;

pool.connect = function tenantAwareConnect(...args) {
  const id = tenantOf();
  if (id == null || typeof args[0] === "function") return origConnect(...args);
  return origConnect().then((client) => {
    const q = client.query.bind(client);
    const release = client.release.bind(client);
    let inTx = false;
    client.query = async function confinedClientQuery(...qa) {
      const text = typeof qa[0] === "string" ? qa[0] : String(qa[0]?.text || "");
      if (TX_OPEN.test(text)) {
        const r = await q(...qa);
        inTx = true;
        await q(confine(id));
        return r;
      }
      if (TX_CLOSE.test(text)) { inTx = false; return q(...qa); }
      if (inTx) return q(...qa);
      return inConfinedTx(q, id, qa);
    };
    // pg reuses client objects: hand the pool back an unwrapped one.
    client.release = (err) => {
      client.query = q;
      client.release = release;
      return release(err);
    };
    return client;
  });
};

const DB_CONNECTIVITY_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "08000",
  "08001",
  "08003",
  "08006",
  "53300",
  "57P01",
  "57P02",
  "57P03",
]);

function isDbConnectivityError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    DB_CONNECTIVITY_ERROR_CODES.has(String(err?.code || "")) ||
    message.includes("connection terminated") ||
    message.includes("connection timeout") ||
    message.includes("timeout expired") ||
    message.includes("terminating connection")
  );
}

async function rollbackQuietly(client) {
  if (!client) return;
  try {
    await client.query("ROLLBACK");
  } catch {}
}

function sendDbError(res, err) {
  const status = isDbConnectivityError(err) ? 503 : 500;
  const error = status === 503 ? "DB_CONNECTION_FAILED" : "DB_QUERY_FAILED";
  return res.status(status).json({ ok: false, error, message: String(err?.message || err) });
}

module.exports = {
  pool,
  setTenantRlsReady,
  rollbackQuietly,
  sendDbError,
  isDbConnectivityError,
};
