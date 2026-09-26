const { verifyTokenRaw, tokenFromReq } = require("./token.cjs");
const { tokenBlocked } = require("./companyGate.cjs");

/* A valid token whose company is DISABLED: 401 even in audit mode, so the
   frontend (authFetch) signs that session out on its next request. */
function companyDisabled(res) {
  return res.status(401).json({ ok: false, error: "company_disabled" });
}

/* ============================================================
   requireAuth middleware factory

   Behaviour is controlled by the REQUIRE_AUTH env var so enforcement
   can be toggled from the Render dashboard WITHOUT a code redeploy:

     REQUIRE_AUTH = "on"      → reject (401) when the token is
                                missing / invalid / expired.
     REQUIRE_AUTH = anything  → AUDIT mode (default): verify the token
       else (unset/"audit")     if present and attach req.user, but
                                NEVER reject. Missing-token requests are
                                counted + sampled to the log so we can
                                measure readiness before flipping to "on".

   Either way, a valid token is decoded onto `req.user`.
============================================================ */

let auditMisses = 0;
let lastAuditLog = 0;

function isEnforcing() {
  return String(process.env.REQUIRE_AUTH || "").toLowerCase() === "on";
}

function requireAuth(req, res, next) {
  const raw = tokenFromReq(req);
  const payload = raw ? verifyTokenRaw(raw) : null;

  if (payload && tokenBlocked(payload)) return companyDisabled(res);
  if (payload) {
    req.user = payload;
    return next();
  }

  // No valid token beyond this point.
  if (isEnforcing()) {
    return res.status(401).json({ ok: false, error: "auth_required" });
  }

  // AUDIT mode — allow, but keep a running count of unauthenticated
  // hits and log a sample at most once a minute so it doesn't spam.
  auditMisses += 1;
  const now = Date.now();
  if (now - lastAuditLog > 60_000) {
    lastAuditLog = now;
    console.warn(
      `[auth-audit] ${auditMisses} unauthenticated /api/reports requests so far ` +
        `(latest: ${req.method} ${req.originalUrl}). Enforcement OFF.`
    );
  }
  return next();
}

/* ============================================================
   requireAuthStrict — for routes that were never meant to be public

   `requireAuth` above is deliberately soft: it guards /api/reports,
   which every one of 250+ call sites already hits, so it waits for
   REQUIRE_AUTH before rejecting anything.

   Admin surfaces (user accounts, billing, activity log, link minting)
   have no such migration problem — the browser app sends the bearer
   token on every API call via the global fetch wrapper, and nothing
   else is supposed to reach them. So they enforce immediately.

   The one thing that MUST NOT happen is locking everybody out: with
   no AUTH_SECRET the server cannot issue a token at all (signToken
   returns ""), so no caller could ever pass. In that state we fall
   back to open + a loud warning rather than bricking the dashboard.
============================================================ */
function hasSecret() {
  return !!process.env.AUTH_SECRET;
}

let warnedNoSecret = 0;

function requireAuthStrict(req, res, next) {
  const raw = tokenFromReq(req);
  const payload = raw ? verifyTokenRaw(raw) : null;

  if (payload && tokenBlocked(payload)) return companyDisabled(res);
  if (payload) {
    req.user = payload;
    return next();
  }

  if (!hasSecret()) {
    const now = Date.now();
    if (now - warnedNoSecret > 60_000) {
      warnedNoSecret = now;
      console.warn(
        `[auth-strict] AUTH_SECRET is NOT set — admin routes are still OPEN ` +
          `(latest: ${req.method} ${req.originalUrl}). Set AUTH_SECRET to close them.`
      );
    }
    return next();
  }

  return res.status(401).json({ ok: false, error: "auth_required" });
}

/* ============================================================
   requireSuperAdmin — the platform owner (INSPECT PRO) only.

   Runs AFTER requireAuthStrict, so req.user is already the verified token.
   `strict` proves "a valid session"; this proves "the session is the
   platform owner" — tenant admins, however senior, are refused.
   Same pre-configuration escape hatch as requireAuthStrict: with no
   AUTH_SECRET no token can exist, so refusing here would only 403 every
   caller in an environment that simply isn't set up yet (local/dev).
============================================================ */
function requireSuperAdmin(req, res, next) {
  if (req.user && req.user.isSuperAdmin) return next();
  if (!hasSecret()) return next();
  return res.status(403).json({ ok: false, error: "super_admin_required" });
}

module.exports = { requireAuth, requireAuthStrict, requireSuperAdmin, isEnforcing };
