/* ============================================================
   Sweets industry (generic template) — reference-number rules
   ------------------------------------------------------------
   Company-scoped: NO "AM-" prefix (that is the meat company's mark)
   and one counter per company, so two tenants on the same template
   never share a sequence. Counter key `<type>:c<companyId>` → "NCR-000001".
============================================================ */
const company = {
  sweets_non_conformance: "NCR",
};

module.exports = { company };
