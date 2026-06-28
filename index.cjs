require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { pool, rollbackQuietly, sendDbError } = require("./db/pool.cjs");
const ensureSchema = require("./db/schema.cjs");
const common = require("./utils/common.cjs");
const password = require("./utils/password.cjs");
const rateLimit = require("./utils/rateLimit.cjs");

const registerReportsRoutes = require("./routes/reports.cjs");
const registerSupplierPublicRoutes = require("./routes/supplierPublic.cjs");
const registerTrainingSessionRoutes = require("./routes/trainingSessions.cjs");
const registerCatalogRoutes = require("./routes/catalog.cjs");
const registerTrainingLinkRoutes = require("./routes/trainingLinks.cjs");
const registerMediaRoutes = require("./routes/media.cjs");
const registerAdminRoutes = require("./routes/admin.cjs");
const registerBillingRoutes = require("./routes/billing.cjs");
const registerEmailHistoryRoutes = require("./routes/emailHistory.cjs");

const app = express();
const PORT = process.env.PORT || 5000;

console.log("DEPLOY VERSION:", new Date().toISOString());
console.log("NODE_ENV:", process.env.NODE_ENV || "undefined");

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

app.use(express.json({ limit: "20mb" }));

const deps = {
  pool,
  rollbackQuietly,
  sendDbError,
  ...common,
  ...password,
  ...rateLimit,
};

registerReportsRoutes(app, deps);
registerSupplierPublicRoutes(app, deps);
registerTrainingSessionRoutes(app, deps);
registerCatalogRoutes(app, deps);
registerTrainingLinkRoutes(app, deps);
registerMediaRoutes(app, deps);
registerAdminRoutes(app, deps);
registerBillingRoutes(app, deps);
registerEmailHistoryRoutes(app, deps);

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
