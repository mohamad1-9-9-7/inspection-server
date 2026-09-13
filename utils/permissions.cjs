/* ============================================================
   Permission model — one shared vocabulary for the whole app
   ------------------------------------------------------------
   Until now the permission blobs on app_users were free-form: the
   accounts screen wrote whatever object it felt like into
   `crud_perms`, the server stored it untouched, and nothing could
   answer "which sections exist?" or "is `edit` spelled edit or
   update?". A typo silently became a permission nobody had.

   This file is the single source of truth:

     - ACTIONS         the only verbs that mean anything
     - CORE_SECTIONS   the fixed admin/system areas
     - REPORT_SECTIONS the report modules (labelled, Arabic + English)
     - ROLE_TEMPLATES  ready-made permission sets for the UI
     - normalize*()    validators the write routes run before saving

   Unknown section ids are NOT dropped. The report list grows from the
   client and a strict whitelist would silently delete a real
   permission on the next save. Unknown ACTIONS are dropped — there is
   no valid reason to store a verb the server can never check.
============================================================ */

/* Every verb the app can check. `view` is the base: holding any other
   action implies you can at least open the section. */
const ACTIONS = ["view", "create", "edit", "delete", "export", "approve"];

const ACTION_LABELS = {
  view:    { en: "View",    ar: "عرض" },
  create:  { en: "Create",  ar: "إضافة" },
  edit:    { en: "Edit",    ar: "تعديل" },
  delete:  { en: "Delete",  ar: "حذف" },
  export:  { en: "Export",  ar: "تصدير" },
  approve: { en: "Approve", ar: "اعتماد" },
};

/* Legacy spellings the old accounts screen wrote. Mapped, not dropped,
   so an account saved last year keeps the access it was given. */
const ACTION_ALIASES = {
  read:   "view",
  show:   "view",
  write:  "create",
  add:    "create",
  new:    "create",
  update: "edit",
  modify: "edit",
  remove: "delete",
  destroy: "delete",
  print:  "export",
  download: "export",
  sign:   "approve",
  confirm: "approve",
};

/* Fixed system areas. These never come from report data. */
const CORE_SECTIONS = [
  { id: "dashboard",     group: "general",        label: { en: "Dashboard",         ar: "لوحة المؤشرات" },     actions: ["view"] },
  { id: "accounts",      group: "administration", label: { en: "Accounts Centre",   ar: "مركز الحسابات" },      actions: ["view", "create", "edit", "delete"] },
  { id: "permissions",   group: "administration", label: { en: "Permissions Centre", ar: "مركز الصلاحيات" },    actions: ["view", "edit"] },
  { id: "packages",      group: "administration", label: { en: "Packages & Billing", ar: "الباقات والفوترة" },  actions: ["view", "create", "edit", "delete"] },
  { id: "companies",     group: "administration", label: { en: "Companies",         ar: "الشركات" },            actions: ["view", "create", "edit", "delete"] },
  { id: "activity_log",  group: "administration", label: { en: "Activity Log",      ar: "سجل النشاط" },         actions: ["view", "export"] },
  { id: "audit_trail",   group: "administration", label: { en: "Audit Trail",       ar: "سجل التدقيق" },        actions: ["view", "export"] },
  { id: "security",      group: "administration", label: { en: "Security Monitor",  ar: "مراقبة الأمان" },      actions: ["view"] },
  { id: "catalog",       group: "data",           label: { en: "Product Catalog",   ar: "دليل المنتجات" },      actions: ["view", "create", "edit", "delete"] },
  { id: "email_history", group: "data",           label: { en: "Email History",     ar: "سجل المراسلات" },      actions: ["view", "export"] },
  { id: "media",         group: "data",           label: { en: "Attachments",       ar: "المرفقات" },           actions: ["view", "create", "delete"] },
];

/* Report modules the server already knows by name. Any other `type`
   found in the reports table is added to the catalog at request time
   with a prettified label — see buildCatalog(). */
const REPORT_SECTIONS = [
  { id: "destruction_record",    label: { en: "Destruction Record",        ar: "محضر إتلاف" } },
  { id: "returns",               label: { en: "Supplier Returns",          ar: "مرتجعات الموردين" } },
  { id: "returns_customers",     label: { en: "Customer Returns",          ar: "مرتجعات العملاء" } },
  { id: "qcs_non_conformance",   label: { en: "QCS Non-Conformance",       ar: "عدم مطابقة QCS" } },
  { id: "pos19_non_conformance", label: { en: "POS 19 Non-Conformance",    ar: "عدم مطابقة POS 19" } },
  { id: "butcher_cut_log",       label: { en: "Butcher Cutting Log",       ar: "سجل التقطيع" } },
  { id: "training_session",      label: { en: "Training Sessions",         ar: "الجلسات التدريبية" } },
  { id: "maintenance",           label: { en: "Maintenance Requests",      ar: "طلبات الصيانة" } },
  { id: "supplier_evaluation",   label: { en: "Supplier Evaluation",       ar: "تقييم الموردين" } },
];

const REPORT_ACTIONS = ["view", "create", "edit", "delete", "export"];

/* Ready-made permission sets. The permissions centre offers these as
   one click instead of asking someone to tick forty boxes by hand —
   which is how half-configured accounts happened. */
const ROLE_TEMPLATES = [
  {
    id: "viewer",
    label: { en: "Viewer", ar: "مُطّلع" },
    description: { en: "Read-only access to reports and the dashboard.", ar: "اطلاع فقط على التقارير ولوحة المؤشرات." },
    isAdmin: false,
    sections: { scope: "reports", actions: ["view"] },
    extra: { dashboard: ["view"] },
  },
  {
    id: "inspector",
    label: { en: "Inspector", ar: "مفتّش" },
    description: { en: "Creates and edits their own reports.", ar: "ينشئ ويعدّل التقارير." },
    isAdmin: false,
    sections: { scope: "reports", actions: ["view", "create", "edit"] },
    extra: { dashboard: ["view"], media: ["view", "create"] },
  },
  {
    id: "supervisor",
    label: { en: "Supervisor", ar: "مشرف" },
    description: { en: "Full report access plus export and approval.", ar: "صلاحية كاملة على التقارير مع التصدير والاعتماد." },
    isAdmin: false,
    sections: { scope: "reports", actions: ["view", "create", "edit", "export"] },
    extra: { dashboard: ["view"], media: ["view", "create", "delete"], email_history: ["view"] },
  },
  {
    id: "quality_manager",
    label: { en: "Quality Manager", ar: "مدير الجودة" },
    description: { en: "Everything on reports, plus the audit trail.", ar: "كل صلاحيات التقارير إضافة إلى سجل التدقيق." },
    isAdmin: false,
    sections: { scope: "reports", actions: REPORT_ACTIONS },
    extra: {
      dashboard: ["view"], media: ["view", "create", "delete"],
      email_history: ["view", "export"], audit_trail: ["view", "export"],
      catalog: ["view", "edit"],
    },
  },
  {
    id: "company_admin",
    label: { en: "Company Admin", ar: "مدير الشركة" },
    description: { en: "Manages accounts and permissions inside one company.", ar: "يدير حسابات وصلاحيات شركته." },
    isAdmin: true,
    sections: { scope: "reports", actions: REPORT_ACTIONS },
    extra: {
      dashboard: ["view"], media: ["view", "create", "delete"],
      accounts: ["view", "create", "edit", "delete"],
      permissions: ["view", "edit"],
      packages: ["view"],
      activity_log: ["view", "export"], audit_trail: ["view", "export"],
      security: ["view"], catalog: ["view", "create", "edit", "delete"],
      email_history: ["view", "export"],
    },
  },
];

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);

/** "qcs_non_conformance" → "Qcs Non Conformance" (unknown types only). */
function prettify(id) {
  return String(id || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Map one action word onto the canonical verb, or null if it is junk. */
function canonicalAction(a) {
  const k = String(a ?? "").trim().toLowerCase();
  if (!k) return null;
  if (ACTIONS.includes(k)) return k;
  return ACTION_ALIASES[k] || null;
}

/** Sort actions into a stable order so two equal permission sets compare equal. */
function sortActions(list) {
  return ACTIONS.filter((a) => list.includes(a));
}

/**
 * Clean one section's action list.
 * Returns [] when nothing survives — the caller drops the section.
 * Any action implies `view`: a user who may edit must be able to open it.
 */
function normalizeActions(value) {
  const raw = Array.isArray(value) ? value : value === true ? ACTIONS : [];
  const out = new Set();
  for (const a of raw) {
    const c = canonicalAction(a);
    if (c) out.add(c);
  }
  if (out.size) out.add("view");
  return sortActions([...out]);
}

/**
 * Clean a whole `{ sectionId: [actions] }` map.
 * Returns { crudPerms, unknownSections } — unknown ids are KEPT (the report
 * list is client-driven) but reported back so the UI can flag stale rows.
 */
function normalizeCrudPerms(input, knownSections = null) {
  const src = isObj(input) ? input : {};
  const crudPerms = {};
  const unknownSections = [];

  for (const [rawKey, value] of Object.entries(src)) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    const actions = normalizeActions(value);
    if (!actions.length) continue;
    crudPerms[key] = actions;
    if (knownSections && !knownSections.has(key)) unknownSections.push(key);
  }

  return { crudPerms, unknownSections };
}

/**
 * Clean the role-id list. `"*"` means everything and collapses the rest —
 * storing ["*", "inspector"] only invites disagreement about which wins.
 */
function normalizePermissions(input) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  for (const p of raw) {
    const v = String(p ?? "").trim();
    if (!v) continue;
    if (v === "*") return ["*"];
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Branch scoping. Two shapes are accepted and both are preserved:
 *   []                      → every branch (no restriction)
 *   ["POS 10", "POS 19"]    → legacy flat list, applies to all sections
 *   { sectionId: [...] }    → per-section restriction (current UI)
 */
function normalizeAllowedBranches(input) {
  if (Array.isArray(input)) {
    const out = [];
    for (const b of input) {
      const v = String(b ?? "").trim();
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  }
  if (!isObj(input)) return [];

  const out = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const key = String(rawKey || "").trim();
    if (!key) continue;
    const list = [];
    for (const b of Array.isArray(value) ? value : []) {
      const v = String(b ?? "").trim();
      if (v && !list.includes(v)) list.push(v);
    }
    if (list.length) out[key] = list;
  }
  return out;
}

/** Employee name list attached to an account (used by "My Work" filters). */
function normalizeEmployees(input) {
  const out = [];
  for (const e of Array.isArray(input) ? input : []) {
    const v = String(e ?? "").trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Build the catalog the permissions centre renders itself from.
 * `discoveredTypes` are the distinct `reports.type` values actually in the
 * database, so a module added by the client shows up without a code change.
 */
function buildCatalog(discoveredTypes = []) {
  const known = new Map(REPORT_SECTIONS.map((s) => [s.id, s]));
  const ids = new Set([...known.keys()]);
  for (const t of discoveredTypes) {
    const id = String(t ?? "").trim();
    if (id && !id.startsWith("__")) ids.add(id);
  }

  const reports = [...ids].sort().map((id) => {
    const hit = known.get(id);
    return {
      id,
      group: "reports",
      label: hit ? hit.label : { en: prettify(id), ar: prettify(id) },
      actions: REPORT_ACTIONS,
      known: !!hit,
    };
  });

  return {
    actions: ACTIONS.map((id) => ({ id, label: ACTION_LABELS[id] })),
    groups: [
      { id: "general",        label: { en: "General",        ar: "عام" } },
      { id: "reports",        label: { en: "Reports",        ar: "التقارير" } },
      { id: "data",           label: { en: "Data & Files",   ar: "البيانات والملفات" } },
      { id: "administration", label: { en: "Administration", ar: "الإدارة" } },
    ],
    sections: [...CORE_SECTIONS, ...reports],
    templates: ROLE_TEMPLATES.map((t) => ({
      id: t.id,
      label: t.label,
      description: t.description,
      isAdmin: t.isAdmin,
    })),
  };
}

/**
 * Expand a role template into a concrete `crud_perms` map.
 * `reportIds` comes from the catalog, so "all reports" means the modules
 * this installation actually has — not a list frozen at build time.
 */
function expandTemplate(templateId, reportIds = []) {
  const tpl = ROLE_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return null;

  const crudPerms = {};
  if (tpl.sections?.scope === "reports") {
    for (const id of reportIds) crudPerms[id] = sortActions(tpl.sections.actions);
  }
  for (const [section, actions] of Object.entries(tpl.extra || {})) {
    crudPerms[section] = sortActions(normalizeActions(actions));
  }
  return { template: tpl, crudPerms, isAdmin: tpl.isAdmin };
}

/**
 * What this account can actually do, after admin flags are applied.
 * The accounts screen kept re-deriving this in three places and got a
 * different answer each time.
 */
function effectivePermissions(user = {}) {
  const isSuperAdmin = !!(user.is_super_admin ?? user.isSuperAdmin);
  const isAdmin = isSuperAdmin || !!(user.is_admin ?? user.isAdmin);
  const permissions = normalizePermissions(user.permissions);
  const { crudPerms } = normalizeCrudPerms(user.crud_perms ?? user.crudPerms);

  return {
    isAdmin,
    isSuperAdmin,
    /* An admin bypasses the section map entirely — that is what the flag
       has always meant at the API layer; now it is stated once. */
    fullAccess: isAdmin || permissions.includes("*"),
    permissions,
    crudPerms,
    sectionCount: Object.keys(crudPerms).length,
  };
}

module.exports = {
  ACTIONS,
  ACTION_LABELS,
  CORE_SECTIONS,
  REPORT_SECTIONS,
  REPORT_ACTIONS,
  ROLE_TEMPLATES,
  buildCatalog,
  expandTemplate,
  effectivePermissions,
  normalizeActions,
  normalizeCrudPerms,
  normalizePermissions,
  normalizeAllowedBranches,
  normalizeEmployees,
  canonicalAction,
};
