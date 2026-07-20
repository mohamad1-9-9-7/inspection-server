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

module.exports = { requireAuth, isEnforcing };
