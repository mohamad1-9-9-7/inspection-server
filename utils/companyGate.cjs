/* ============================================================
   companyGate — which companies are DISABLED right now.

   A company is never deleted, only disabled (companies.disabled_at) and
   re-enabled. While disabled, nobody but the platform super-admin may use
   it: login refuses its accounts (routes/admin.cjs), and every request
   carrying a token of that company is answered 401 by the auth
   middleware — so sessions already open are thrown out on their next call.

   Kept in memory: loaded once at boot and updated by the disable / enable
   routes themselves. No polling (a timer query would keep Neon awake).
============================================================ */

const disabled = new Set();

async function loadDisabledCompanies(pool) {
  try {
    const q = await pool.query(`SELECT id FROM companies WHERE disabled_at IS NOT NULL`);
    disabled.clear();
    q.rows.forEach((r) => disabled.add(Number(r.id)));
  } catch (e) {
    console.warn("[companyGate] load skipped:", e?.message || e);
  }
}

function markCompanyDisabled(id, isDisabled) {
  const n = Number(id);
  if (!Number.isFinite(n)) return;
  if (isDisabled) disabled.add(n);
  else disabled.delete(n);
}

/** True when this token belongs to a disabled company (super-admin: never). */
function tokenBlocked(payload) {
  if (!payload || payload.isSuperAdmin) return false;
  const id = Number(payload.companyId);
  return Number.isFinite(id) && disabled.has(id);
}

module.exports = { loadDisabledCompanies, markCompanyDisabled, tokenBlocked };
