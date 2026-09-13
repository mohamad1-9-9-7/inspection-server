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
    requireAuth.cjs
    token.cjs
    permissions.cjs
    planView.cjs

  routes
    reports.cjs
    supplierPublic.cjs
    trainingSessions.cjs
    catalog.cjs
    trainingLinks.cjs
    media.cjs
    admin.cjs
    accounts.cjs
    billing.cjs
    emailHistory.cjs
    mailer.cjs
    audit.cjs

  docs
    ACCOUNTS_PERMISSIONS_PACKAGES.md
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

### `utils/permissions.cjs`

The permission vocabulary shared by the whole app.

Contains:

- `ACTIONS` — the only verbs that mean anything (`view`, `create`, `edit`,
  `delete`, `export`, `approve`)
- `CORE_SECTIONS` / `REPORT_SECTIONS` — labelled sections (Arabic + English)
- `ROLE_TEMPLATES` — ready-made permission sets
- `buildCatalog` — the catalog the permissions screen renders itself from,
  with report modules discovered from the data
- `normalizeCrudPerms` / `normalizePermissions` / `normalizeAllowedBranches`
  — run by every write route before anything is stored

Before this file existed the permission blob was free-form, so a typo became
a permission nobody had and no screen could list the sections.

### `utils/planView.cjs`

The package (plan) view model behind the packages card.

Contains:

- `toPlanView` — a `plans` row turned into a card: explicit `unlimited`
  flags, a headline price with its period, bilingual labels, quota bars
- `periodView` — days remaining, percent elapsed, expiry severity
- `buildWarnings` — the card's banners, already phrased in both languages
- `limitView`, `money`, `PERIODS`

### `utils/requireAuth.cjs`

Auth middleware.

Contains:

- `requireAuth` — soft gate for `/api/reports` (audit or enforce, per `REQUIRE_AUTH`)
- `requireAuthStrict` — token required
- `requireAdmin` / `requireSuperAdmin` — role required

All three fall open with a logged warning when `AUTH_SECRET` is unset, since
the server cannot issue a token in that state.

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

Authentication, activity log, and presence.

Includes:

- role password verification
- summary endpoint
- presence endpoints
- login/logout
- activity log
- failed login analytics

App user CRUD used to live here and now lives in `routes/accounts.cjs`.

### `routes/accounts.cjs`

The accounts centre and the permissions centre.

Includes:

- `/api/app-users` CRUD (moved from `admin.cjs`, same URLs and shapes)
- `/api/app-users/:id/status`, `/reset-password`, `/permissions`
- `/api/accounts/overview`, `/api/accounts/policy`
- `/api/permissions/catalog`, `/api/permissions/templates/:id`,
  `/api/permissions/bulk`

Every route needs an admin token, is scoped to the caller's company,
validates its input, enforces the package's seat limit, and writes an
audit line. See `docs/ACCOUNTS_PERMISSIONS_PACKAGES.md` for the contract.

### `routes/billing.cjs`

Packages (plans), companies, subscription, billing profile, and invoices.

Includes:

- `/api/plans`, `/api/plans/:id`
- `/api/packages/overview` (alias `/api/subscription/overview`) — the whole
  packages card in one call: plan, limits, real usage, days remaining,
  bilingual warnings
- `/api/companies`
- `/api/subscription`
- `/api/billing-profile`
- `/api/invoices`

Plans are returned through `utils/planView.cjs`, with the raw columns still
on the object so older screens keep working. `PUT` on plans and companies is
partial — the previous full-row update blanked any field the caller omitted.

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
- `reports` still has no `company_id`. Seats are counted per company, but
  branch and monthly report usage on the packages card are platform-wide
  totals — `usage.scope` in the response says which is which.

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

## Accounts / Permissions / Packages Update

The accounts centre, the permissions centre and the packages card were
reworked; `docs/ACCOUNTS_PERMISSIONS_PACKAGES.md` holds the full API
contract. Verification after that change:

```text
node --check on every changed file
route registration diff against origin/main: +12 routes, 0 removed, 0 duplicated
32 in-process API assertions (fake pg pool, real express + route modules)
16 unit assertions on utils/permissions.cjs and utils/planView.cjs
```
