require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { pool, rollbackQuietly, sendDbError } = require("./db/pool.cjs");
const ensureSchema = require("./db/schema.cjs");
const common = require("./utils/common.cjs");
const password = require("./utils/password.cjs");
const rateLimit = require("./utils/rateLimit.cjs");
const token = require("./utils/token.cjs");
const { requireAuth, requireAuthStrict, requireAdmin, requireSuperAdmin } = require("./utils/requireAuth.cjs");
const { rejectBase64 } = require("./utils/noBase64.cjs");

const registerReportsRoutes = require("./routes/reports.cjs");
const registerSupplierPublicRoutes = require("./routes/supplierPublic.cjs");
const registerTrainingSessionRoutes = require("./routes/trainingSessions.cjs");
const registerCatalogRoutes = require("./routes/catalog.cjs");
const registerTrainingLinkRoutes = require("./routes/trainingLinks.cjs");
const registerMediaRoutes = require("./routes/media.cjs");
const registerAdminRoutes = require("./routes/admin.cjs");
const registerAccountsRoutes = require("./routes/accounts.cjs");
const registerBillingRoutes = require("./routes/billing.cjs");
const registerEmailHistoryRoutes = require("./routes/emailHistory.cjs");
const registerMailerRoutes = require("./routes/mailer.cjs");
const registerAuditRoutes = require("./routes/audit.cjs");

const app = express();
const PORT = process.env.PORT || 5000;

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

function originAllowed(origin) {
  if (!origin) return true;
  if (!ALLOWED_ORIGINS.length) return true;
  return ALLOWED_ORIGINS.includes(String(origin).replace(/\/$/, ""));
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
  requireAdmin,
  requireSuperAdmin,
};

registerReportsRoutes(app, deps);
registerSupplierPublicRoutes(app, deps);
registerTrainingSessionRoutes(app, deps);
registerCatalogRoutes(app, deps);
registerTrainingLinkRoutes(app, deps);
registerMediaRoutes(app, deps);
registerAdminRoutes(app, deps);
registerAccountsRoutes(app, deps);
registerBillingRoutes(app, deps);
registerEmailHistoryRoutes(app, deps);
registerMailerRoutes(app, deps);
registerAuditRoutes(app, deps);

ensureSchema({ pool, genSalt: password.genSalt, hashPw: password.hashPw })
  .then(() =>
    app.listen(PORT, () => {
      console.log(`API running on :${PORT} (FULL public access: read/write/delete enabled)`);
      console.log("STARTED AT:", new Date().toISOString());
    })
  )
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });
