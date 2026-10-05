/* ============================================================
   tenantContext — which company the CURRENT request belongs to,
   for the database-level isolation in db/tenantRls.cjs.

   A request made with a valid token of a COMPANY account runs inside
   an AsyncLocalStorage store { companyId }. db/pool.cjs reads it and runs
   that request's queries as the `app_tenant` role, confined by Postgres to
   that company's rows.

   Everything else carries no store and keeps the owner connection,
   exactly as before:
     • the platform super-admin (works across companies on purpose);
     • requests with no token or an invalid one — public token pages,
       login, the butcher kiosk, health checks;
     • boot-time migrations.

   Switch: TENANT_RLS=on in the environment (Render → Environment), read
   at boot. Off (the default) = this middleware does nothing, so the
   feature can be enabled — and disabled again — without a code deploy.
============================================================ */
const { AsyncLocalStorage } = require("async_hooks");
const { verifyToken, tokenFromReq } = require("./token.cjs");

const als = new AsyncLocalStorage();
const enabled = () => String(process.env.TENANT_RLS || "").toLowerCase() === "on";

/** The company the current request is confined to, or null. */
function currentTenant() {
  const s = als.getStore();
  return s && Number.isInteger(s.companyId) ? s.companyId : null;
}

function tenantMiddleware(req, _res, next) {
  if (!enabled()) return next();
  const raw = tokenFromReq(req);
  const u = raw ? verifyToken(raw) : null;
  const id = Number(u?.companyId);
  if (!u || u.isSuperAdmin || !(Number.isInteger(id) && id > 0)) return next();
  return als.run({ companyId: id }, next);
}

/** Run `fn` as the platform (no tenant confinement). ONLY for server-owned
    work a company request triggers but that must see platform-wide rows —
    e.g. issuing an invoice, whose number is unique across ALL companies
    (routes/myBilling.cjs). The caller has already checked the company; no
    request input may choose what runs here. */
function runAsPlatform(fn) {
  return als.run({ companyId: null }, fn);
}

module.exports = { tenantMiddleware, currentTenant, runAsPlatform, tenantRlsEnabled: enabled };
