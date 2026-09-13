const { verifyToken, tokenFromReq } = require("./token.cjs");

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
  const payload = raw ? verifyToken(raw) : null;

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
  const payload = raw ? verifyToken(raw) : null;

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
   requireAdmin / requireSuperAdmin — role gates

   `requireAuthStrict` only proves the caller holds a valid token.
   Every logged-in account holds one, so on its own it let any user
   POST /api/app-users and hand themselves `isAdmin: true`. The
   account and permission surfaces need the role, not just the token.

   The AUTH_SECRET escape hatch is kept deliberately: with no secret
   the server cannot issue a token at all, so demanding a role would
   lock the dashboard out of its own admin screens instead of securing
   them.
============================================================ */
function roleGate(needSuper) {
  return function gate(req, res, next) {
    const raw = tokenFromReq(req);
    const payload = raw ? verifyToken(raw) : null;

    if (payload) {
      req.user = payload;
      if (payload.isSuperAdmin) return next();
      if (!needSuper && payload.isAdmin) return next();
      return res.status(403).json({
        ok: false,
        error: needSuper ? "super_admin_only" : "admin_only",
      });
    }

    if (!hasSecret()) {
      const now = Date.now();
      if (now - warnedNoSecret > 60_000) {
        warnedNoSecret = now;
        console.warn(
          `[auth-role] AUTH_SECRET is NOT set — admin-only routes are still OPEN ` +
            `(latest: ${req.method} ${req.originalUrl}). Set AUTH_SECRET to close them.`
        );
      }
      return next();
    }

    return res.status(401).json({ ok: false, error: "auth_required" });
  };
}

const requireAdmin = roleGate(false);
const requireSuperAdmin = roleGate(true);

module.exports = { requireAuth, requireAuthStrict, requireAdmin, requireSuperAdmin, isEnforcing };
