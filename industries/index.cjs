/* ============================================================
   Industry registry — the ONE place the core meets the industries
   ------------------------------------------------------------
   The platform is one codebase for every company (multi-tenant):
   the CORE (routes/*, db/*, utils/*) holds what every company
   shares — auth, tenant scoping, storage, audit, billing — and
   must never name an industry's report type. Everything that
   belongs to one line of business lives in industries/<name>/.

   Editing industries/sweets/* can therefore never change meat
   behaviour, and the other way round. Two guards keep it that way:
     • a report type may be claimed by ONE industry only — a clash
       throws at boot instead of silently overriding the other;
     • the core reaches the industries only through this file.

   Adding an industry = a folder + one line in INDUSTRIES below.
============================================================ */
const meatRefs = require("./meat/refs.cjs");
const sweetsRefs = require("./sweets/refs.cjs");
const makeMeatCutScope = require("./meat/cutScope.cjs");
const registerMeatReportRoutes = require("./meat/reportRoutes.cjs");

const INDUSTRIES = [
  { name: "meat", refs: meatRefs, training: require("./meat/training.cjs") },
  { name: "sweets", refs: sweetsRefs, training: require("./sweets/training.cjs") },
];

/* Report types that hold a training session with a public quiz token. */
const TRAINING_SESSION_TYPES = [...new Set(INDUSTRIES.map((i) => i.training?.sessionType).filter(Boolean))];

/* Merge every industry's reference rules into the three shapes the core
   allocator understands, refusing any type claimed twice. */
function buildRefRules() {
  const global = {};   // type → { prefix, mark }  → "AM-RET-000087"
  const scoped = {};   // type → { pad, scopeOf, format } → "POS 10 — 00001"
  const company = {};  // type → prefix → "NCR-000001" (counter per company)
  const owner = {};

  const claim = (type, industry) => {
    if (owner[type]) {
      throw new Error(
        `[industries] report type "${type}" is claimed by both "${owner[type]}" and "${industry}"`
      );
    }
    owner[type] = industry;
  };

  for (const { name, refs } of INDUSTRIES) {
    for (const [type, prefix] of Object.entries(refs.prefix || {})) {
      claim(type, name);
      global[type] = { prefix, mark: refs.mark };
    }
    for (const [type, rule] of Object.entries(refs.scoped || {})) {
      claim(type, name);
      scoped[type] = rule;
    }
    for (const [type, prefix] of Object.entries(refs.company || {})) {
      claim(type, name);
      company[type] = prefix;
    }
  }
  return { global, scoped, company };
}

const REF_RULES = buildRefRules();

/** Everything the reports core needs from the industries, bound to one pool. */
function forReports(pool) {
  const meatCutScope = makeMeatCutScope(pool);

  return {
    REF_RULES,

    /* Branch sites a list read must be narrowed to, or null = no narrowing.
       Only the meat butcher log narrows today. */
    branchScopeFor: (req, type) => meatCutScope(req, type),

    /* Industry-owned /api/reports routes. Called by the core at the point
       where they must sit (before the generic PUT /api/reports/:type). */
    registerReportRoutes: (app, ctx) => {
      registerMeatReportRoutes(app, ctx);
    },
  };
}

module.exports = { forReports, REF_RULES, TRAINING_SESSION_TYPES };
