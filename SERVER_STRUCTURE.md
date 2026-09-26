# Inspection Server Structure

This file explains the server refactor that split the old single `index.cjs`
file into smaller modules. The goal was organization only: routes, database
setup, and helpers were moved into clear files without changing API behavior.

## What Changed

Before, almost everything lived in:

```text
index.cjs
```

Now `index.cjs` is only the entry point. It configures Express, loads shared
dependencies, registers route modules, initializes the database schema, and
starts the server.

## Current Layout

```text
D:\inspection-server
  index.cjs

  db
    pool.cjs
    schema.cjs

  utils
    common.cjs
    password.cjs
    rateLimit.cjs

  routes
    reports.cjs
    supplierPublic.cjs
    trainingSessions.cjs
    catalog.cjs
    trainingLinks.cjs
    media.cjs
    admin.cjs
    billing.cjs
    emailHistory.cjs
```

## File Responsibilities

### `index.cjs`

Main server entry point.

Responsibilities:

- Loads `.env`
- Creates the Express app
- Enables CORS
- Enables JSON body parsing
- Builds the shared `deps` object
- Registers all route modules
- Runs `ensureSchema`
- Starts `app.listen`

This file should stay small. Avoid adding business logic here.

### `db/pool.cjs`

Database connection and database error helpers.

Contains:

- PostgreSQL `Pool`
- SSL connection setup
- connection error detection
- `rollbackQuietly`
- `sendDbError`

Use this file whenever a module needs database access.

### `db/schema.cjs`

Database bootstrap / schema creation.

Contains the old `ensureSchema` logic from `index.cjs`.

This creates or updates tables such as:

- `reports`
- `product_catalog`
- `training_links`
- `supplier_links`
- `app_users`
- `companies`
- `plans`
- `subscription`
- `invoices`
- `email_history`

For now, schema setup still runs on server startup.

### `utils/common.cjs`

Small shared helpers.

Contains:

- `clampInt`
- `normText`
- `todayISO`
- `safeArr`
- `safeObj`
- `normKey`
- `parseMaybeJSON`

### `utils/password.cjs`

Password hashing and verification.

Contains:

- `genSalt`
- `hashPw`
- `verifyPw`

Current hashing uses Node `crypto.scryptSync` for newer passwords and keeps
legacy HMAC verification support.

### `utils/rateLimit.cjs`

Simple in-memory login rate limiting.

Contains:

- `rlCheck`
- `rlReset`

This is currently used by the login endpoint.

## Route Modules

Each route file exports a function:

```js
module.exports = function registerSomethingRoutes(app, deps = {}) {
  // app.get(...)
  // app.post(...)
};
```

The route receives:

- `app`: Express app
- `deps`: shared helpers and database tools

### `routes/reports.cjs`

Main reports CRUD routes.

Includes:

- `GET /api/reports`
- `POST /api/reports`
- `PUT /api/reports`
- `PATCH /api/reports/:id`
- `DELETE /api/reports`
- `DELETE /api/reports/:id`

This is **core**: it must never name an industry's report type. Reference
numbers, branch narrowing and industry-only routes come from `industries/`.

## Core vs Industries (multi-tenant)

One codebase serves every company. Companies are isolated by **data**
(`company_id` on every row, fixed by the token) and **config** — never by
copying code per company. Code is split by line of business instead:

```text
industries
  index.cjs            the ONLY door between core and industries
  meat                 Al Mawashi (and any future meat company)
    refs.cjs           AM-RET / AM-NCR / … numbers, butcher "POS 10 — 00001"
    cutScope.cjs       a butcher reads only his own shops' cutting logs
    reportRoutes.cjs   GET /api/reports/butcher-stats,
                       PUT /api/reports/returns, PUT /api/reports/qcs
  sweets
    refs.cjs           per-company "NCR-000001"
```

Rules:

- Editing `industries/sweets/*` cannot change meat behaviour, and the other
  way round. Shared behaviour (auth, tenant scope, audit, storage) stays in
  the core and is handed to industry routes through `ctx`.
- A report type belongs to ONE industry. Claiming it twice throws at boot.
- New industry = a folder + one entry in `INDUSTRIES` in `industries/index.cjs`.
- Industry routes under `/api/reports/<word>` must be registered through
  `registerReportRoutes`, which the core mounts before the generic
  `PUT /api/reports/:type`.

### `routes/supplierPublic.cjs`

Supplier/public self-assessment links.

Includes:

- supplier link creation
- supplier link lookup
- supplier public submission
- public report token submission

### `routes/trainingSessions.cjs`

Training session token APIs stored in report payloads.

Includes:

- `GET /api/training-session/by-token/:token`
- `POST /api/training-session/by-token/:token/submit`

### `routes/catalog.cjs`

Product catalog APIs.

Includes:

- `/api/catalog/products`
- `/api/catalog/items`
- `/api/items`
- `/api/product-catalog`

### `routes/trainingLinks.cjs`

UUID based training links.

Includes:

- `POST /api/training-links`
- `GET /api/training-links/:token`
- `POST /api/training-links/:token/submit`

### `routes/media.cjs`

Cloudinary, file proxy, health, and image routes.

Includes:

- Cloudinary config
- `/api/files/cloudinary/:publicId`
- `/api/files/proxy`
- `/health/db`
- `/health/cloud`
- `/api/images`
- `/api/images/:id`

### `routes/admin.cjs`

Authentication, users, activity log, and presence.

Includes:

- role password verification
- summary endpoint
- presence endpoints
- login/logout
- app user CRUD
- activity log
- failed login analytics

### `routes/billing.cjs`

Plans, companies, subscription, billing profile, and invoices.

Includes:

- `/api/plans`
- `/api/companies`
- `/api/subscription`
- `/api/billing-profile`
- `/api/invoices`

### `routes/emailHistory.cjs`

Email history log and analytics.

Includes:

- `POST /api/email-history`
- `GET /api/email-history`
- `GET /api/email-history/stats`
- email history cleanup endpoints

## How To Add A New API Route

If the route belongs to an existing area, add it to the matching file.

Examples:

- New report endpoint -> `routes/reports.cjs`
- New subscription endpoint -> `routes/billing.cjs`
- New user/security endpoint -> `routes/admin.cjs`
- New upload/file endpoint -> `routes/media.cjs`

If it is a new area, create a new file in `routes`, for example:

```text
routes/branches.cjs
```

Use this pattern:

```js
module.exports = function registerBranchesRoutes(app, deps = {}) {
  const { pool, normText } = deps;

  app.get("/api/branches", async (req, res) => {
    // route logic
  });
};
```

Then register it in `index.cjs`:

```js
const registerBranchesRoutes = require("./routes/branches.cjs");

registerBranchesRoutes(app, deps);
```

## Important Notes

- This refactor did not intentionally change API behavior.
- The route count stayed the same after the split.
- `index.cjs` should remain small.
- Avoid duplicating database connection logic in route files.
- Use helpers from `utils` through `deps` instead of redefining them.
- Bigger future work should focus on subscription enforcement and company data isolation.

## Verification Done

After the split, these checks were run:

```text
node --check
route registration test
route count comparison
git diff --check
```

Result:

```text
All CommonJS files passed syntax check.
All route modules registered successfully.
Route count before: 69
Route count after: 69
```
