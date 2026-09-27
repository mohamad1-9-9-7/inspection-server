/* ============================================================
   tenant.cjs — which company a request acts for.

   One rule for every route that is not /api/reports (those keep their own
   copy in routes/reports.cjs, same logic):
     • an account's company comes from its verified token and cannot be
       widened by any parameter;
     • the platform super-admin (no company on the token) works inside the
       company named by ?company_id (the Platform Center switcher sends it);
     • no token, or a super-admin with no company picked → the primary
       company (Al Mawashi, id 1) — exactly what these routes did before
       they knew about companies, so nothing changes for existing callers.

   Works with or without an auth middleware in front: req.user when one
   ran, otherwise the bearer token is verified here (pure CPU, no DB).
============================================================ */
const { verifyToken, tokenFromReq } = require("./token.cjs");

const PRIMARY_COMPANY_ID = 1;

function userOf(req) {
  if (req.user) return req.user;
  const raw = tokenFromReq(req);
  return raw ? verifyToken(raw) : null;
}

function companyOf(req) {
  const u = userOf(req);
  const own = Number(u?.companyId);
  if (Number.isFinite(own) && own > 0) return own;
  if (u?.isSuperAdmin) {
    const q = Number(req.query?.company_id ?? req.body?.companyId);
    if (Number.isFinite(q) && q > 0) return q;
  }
  return PRIMARY_COMPANY_ID;
}

module.exports = { companyOf, userOf, PRIMARY_COMPANY_ID };
