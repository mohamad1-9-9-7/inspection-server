require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { pool, rollbackQuietly, sendDbError, isDbConnectivityError, setTenantRlsReady } = require("./db/pool.cjs");
const ensureSchema = require("./db/schema.cjs");
const { ensureTenantRls } = require("./db/tenantRls.cjs");
const { tenantMiddleware, tenantRlsEnabled } = require("./utils/tenantContext.cjs");
const { loadDisabledCompanies } = require("./utils/companyGate.cjs");
const common = require("./utils/common.cjs");
const password = require("./utils/password.cjs");
const rateLimit = require("./utils/rateLimit.cjs");
const token = require("./utils/token.cjs");
const { requireAuth, requireAuthStrict, requireSuperAdmin } = require("./utils/requireAuth.cjs");
const { rejectBase64 } = require("./utils/noBase64.cjs");

const registerReportsRoutes = require("./routes/reports.cjs");
const registerSupplierPublicRoutes = require("./routes/supplierPublic.cjs");
const registerTrainingSessionRoutes = require("./routes/trainingSessions.cjs");
const registerCatalogRoutes = require("./routes/catalog.cjs");
const registerMediaRoutes = require("./routes/media.cjs");
const registerAdminRoutes = require("./routes/admin.cjs");
const registerBillingRoutes = require("./routes/billing.cjs");
const registerQuotationRoutes = require("./routes/quotations.cjs");
const registerEmailHistoryRoutes = require("./routes/emailHistory.cjs");
const registerMailerRoutes = require("./routes/mailer.cjs");
const registerAuditRoutes = require("./routes/audit.cjs");
const registerDemoRequestRoutes = require("./routes/demoRequests.cjs");
const registerTrialRoutes = require("./routes/trial.cjs");
const registerPromoCodeRoutes = require("./routes/promoCodes.cjs");

const app = express();
const PORT = process.env.PORT || 5000;

app.disable("x-powered-by");

/* Express 4 does not catch a rejected promise from an async handler: the
   request hangs until the client times out, and on Node 18 the unhandled
   rejection takes the WHOLE process down — every company's session with it.
   Every route here is async, so each handler is wrapped once, centrally:
   a throw or rejection goes to next(err) and is answered by the JSON error
   handler at the bottom. Routes that already try/catch behave exactly as
   before. app.get(name) with a single string is Express's settings getter. */
function asyncSafe(fn) {
  if (typeof fn !== "function" || fn.length >= 4) return fn; // error handlers keep their arity
  return function safeHandler(req, res, next) {
    try {
      const out = fn(req, res, next);
      if (out && typeof out.catch === "function") out.catch(next);
      return out;
    } catch (e) {
      return next(e);
    }
  };
}
for (const m of ["get", "post", "put", "patch", "delete", "all", "use"]) {
  const orig = app[m].bind(app);
  app[m] = (...args) => {
    if (m === "get" && args.length === 1 && typeof args[0] === "string") return orig(...args);
    return orig(...args.map((a) => (Array.isArray(a) ? a.map(asyncSafe) : asyncSafe(a))));
  };
}

console.log("DEPLOY VERSION:", new Date().toISOString());
console.log("NODE_ENV:", process.env.NODE_ENV || "undefined");

/* CORS allow-list.

   ALLOWED_ORIGINS = comma-separated list of site origins, e.g.
     https://almawashi-qms.netlify.app,http://localhost:3000
   Unset (the default) keeps the previous wide-open "*" behaviour so this
   deploy cannot break anything on its own — set the variable in Render to
   actually close it. Requests with no Origin (server-to-server, the Netlify
   /api/* proxy, curl, health checks) are always allowed: CORS is a browser
   control and blocking them would only break monitoring. */
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

if (!ALLOWED_ORIGINS.length) {
  console.warn(
    "[cors] ALLOWED_ORIGINS is not set — every origin is accepted. " +
      "Set it to your site origin(s) to restrict browser access."
  );
}

/* An entry may name every company site at once with ONE leading wildcard
   label: "https://*.example.com" matches https://exaltis.example.com (one
   label only, never the bare domain or a deeper name), so a new company's
   own frontend needs no server change. */
const ORIGIN_PATTERNS = ALLOWED_ORIGINS.filter((o) => o.includes("*")).map((o) => {
  const m = /^(https?):\/\/\*\.([a-z0-9.-]+(?::\d+)?)$/i.exec(o);
  if (!m) { console.warn(`[cors] ignored pattern "${o}" — use https://*.domain.tld`); return null; }
  const esc = m[2].replace(/[.]/g, "\\.");
  return new RegExp(`^${m[1]}://[a-z0-9-]+\\.${esc}$`, "i");
}).filter(Boolean);

function originAllowed(origin) {
  if (!origin) return true;
  if (!ALLOWED_ORIGINS.length) return true;
  const o = String(origin).replace(/\/$/, "");
  return ALLOWED_ORIGINS.includes(o) || ORIGIN_PATTERNS.some((re) => re.test(o));
}

app.use(
  cors({
    origin: (origin, cb) => cb(null, originAllowed(origin)),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Authorization"],
  })
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (originAllowed(origin)) {
    // Echo the caller's origin rather than "*" so the header stays correct
    // once the allow-list is narrowed.
    res.header("Access-Control-Allow-Origin", origin || "*");
    if (origin) res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "20mb" }));

/* Company accounts' requests run confined to their company inside the
   database (TENANT_RLS=on) — see db/tenantRls.cjs. Before every route. */
app.use(tenantMiddleware);

/* No file may be stored inside a report payload — see utils/noBase64.cjs for
   the measurements behind this. Mounted here rather than on each route so it
   covers all seven write verbs under /api/reports, and every one added later.
   Reads and deletes carry no body; e-mail routes are deliberately excluded
   because attachments legitimately travel as base64 in transit. */
app.use("/api/reports", (req, res, next) => {
  if (req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS") {
    return next();
  }
  return rejectBase64(req, res, next);
});
/* INSPECT PRO's own documents (quotations + their settings) live outside
   /api/reports now, and get the same no-embedded-files rule. */
for (const base of ["/api/quotations", "/api/platform-settings"]) {
  app.use(base, (req, res, next) =>
    req.method === "GET" || req.method === "DELETE" || req.method === "OPTIONS"
      ? next()
      : rejectBase64(req, res, next));
}

const deps = {
  pool,
  rollbackQuietly,
  sendDbError,
  ...common,
  ...password,
  ...rateLimit,
  ...token,
  requireAuth,
  requireAuthStrict,
  requireSuperAdmin,
};

registerReportsRoutes(app, deps);
registerSupplierPublicRoutes(app, deps);
registerTrainingSessionRoutes(app, deps);
registerCatalogRoutes(app, deps);
/* routes/trainingLinks.cjs retired (Sep 2026): no screen called it, the
   training_links table never held a row, and its submit trusted the score
   and PASS/FAIL sent by the browser. Public quizzes run through
   routes/trainingSessions.cjs, which grades on the server. */
registerMediaRoutes(app, deps);
registerAdminRoutes(app, deps);
registerBillingRoutes(app, deps);
registerQuotationRoutes(app, deps);
registerEmailHistoryRoutes(app, deps);
registerMailerRoutes(app, deps);
registerAuditRoutes(app, deps);
registerDemoRequestRoutes(app, deps);
registerTrialRoutes(app, deps);
registerPromoCodeRoutes(app, deps);

// Schema migrations are meant to be additive/idempotent, and every table
// that matters has existed for a long time — one bad migration step should
// never take the whole app down, since the DB is almost certainly still
// perfectly usable for everything except whatever that one step was trying
// to add. Repeated live incidents (a duplicate-data-triggered index build
// crashing boot, more than once, from more than one angle) showed the old
// "any schema error kills the process" behaviour is worse than the disease:
// it turns one bad row somewhere into a full outage. Log loudly and start
// serving traffic regardless — a half-applied migration can be retried on
// the next boot once the underlying data or code issue is fixed.
/* Unknown /api path → JSON 404 (was Express's HTML page, which the app
   cannot parse and reported as a network failure). */
app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: "not_found", path: req.path });
});

/* One JSON answer for everything a route did not handle itself: malformed
   JSON bodies (were an HTML "Bad Request" page), oversize bodies, and any
   throw that reached next(err) through asyncSafe. Internals are logged,
   never sent — a DB error message can name tables and columns. */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return;
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "bad_json" });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: "payload_too_large" });
  }
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, error: "file_too_large" });
  }
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  if (isDbConnectivityError(err)) {
    return res.status(503).json({ ok: false, error: "DB_CONNECTION_FAILED" });
  }
  return res.status(500).json({ ok: false, error: "server_error" });
});

/* Last line of defence. A stray rejection is one request's problem: log it
   and keep serving. An uncaught exception leaves the process in an unknown
   state, so it exits and Render restarts it cleanly within seconds. */
process.on("unhandledRejection", (reason) => {
  console.error("[process] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException — exiting for a clean restart:", err);
  process.exit(1);
});

let server = null;
/* Render sends SIGTERM on every deploy and restart. Let the requests in
   flight (saves included) finish and close the DB pool, instead of cutting
   them mid-write. Forced exit after 10 s so a stuck socket can't block it. */
function shutdown(signal) {
  console.log(`[process] ${signal} received — draining connections`);
  const force = setTimeout(() => process.exit(0), 10_000);
  force.unref();
  (server ? new Promise((r) => server.close(r)) : Promise.resolve())
    .then(() => pool.end().catch(() => {}))
    .finally(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

ensureSchema({ pool, genSalt: password.genSalt, hashPw: password.hashPw })
  .catch((err) => {
    console.error("DB init had a problem (continuing to start anyway):", err);
  })
  .then(() => loadDisabledCompanies(pool))
  .then(() => ensureTenantRls(pool))
  .then((ready) => {
    const on = !!ready && tenantRlsEnabled();
    setTenantRlsReady(on);
    console.log(`[rls] database tenant isolation: ${on ? "ON" : "off"} (TENANT_RLS=${process.env.TENANT_RLS || "unset"}, policies ${ready ? "ready" : "MISSING"})`);
  })
  .finally(() => {
    server = app.listen(PORT, () => {
      console.log(
        `API running on :${PORT} — REQUIRE_AUTH=${String(process.env.REQUIRE_AUTH || "audit")}, ` +
          `AUTH_SECRET ${process.env.AUTH_SECRET ? "set" : "MISSING"}`
      );
      console.log("STARTED AT:", new Date().toISOString());
    });
  });
