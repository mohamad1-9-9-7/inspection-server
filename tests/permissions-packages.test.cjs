/* Unit tests for the two models the accounts, permissions and packages
   screens now depend on. No database and no network — run with:

     npm test

   Everything asserted here is a rule the UI is allowed to trust. */
const P = require("../utils/permissions.cjs");
const V = require("../utils/planView.cjs");
const assert = require("assert");

let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log("  ✔", name); } catch (e) { console.log("  ✘", name, e.message); process.exitCode = 1; } };

console.log("\n— permissions —");
t("legacy verbs are migrated, junk is dropped", () => {
  const { crudPerms } = P.normalizeCrudPerms({ returns: ["update", "remove", "banana"] });
  assert.deepStrictEqual(crudPerms.returns, ["view", "edit", "delete"]);
});
t("any action implies view", () => {
  assert.deepStrictEqual(P.normalizeActions(["delete"]), ["view", "delete"]);
});
t("empty action list drops the section", () => {
  const { crudPerms } = P.normalizeCrudPerms({ returns: [], catalog: ["view"] });
  assert.deepStrictEqual(Object.keys(crudPerms), ["catalog"]);
});
t("unknown section kept but reported", () => {
  const known = new Set(["catalog"]);
  const r = P.normalizeCrudPerms({ catalog: ["view"], ghost: ["view"] }, known);
  assert.deepStrictEqual(r.unknownSections, ["ghost"]);
  assert.ok(r.crudPerms.ghost);
});
t('"*" collapses the permission list', () => {
  assert.deepStrictEqual(P.normalizePermissions(["a", "*", "b"]), ["*"]);
});
t("branch scoping keeps both shapes", () => {
  assert.deepStrictEqual(P.normalizeAllowedBranches(["POS 10", "POS 10", " "]), ["POS 10"]);
  assert.deepStrictEqual(P.normalizeAllowedBranches({ returns: ["POS 19"], empty: [] }), { returns: ["POS 19"] });
});
t("template expands over the installation's real report list", () => {
  const e = P.expandTemplate("supervisor", ["returns", "custom_x"]);
  assert.deepStrictEqual(e.crudPerms.custom_x, ["view", "create", "edit", "export"]);
  assert.ok(e.crudPerms.dashboard.includes("view"));
});
t("effective permissions resolve the admin flag", () => {
  assert.strictEqual(P.effectivePermissions({ is_admin: true }).fullAccess, true);
  assert.strictEqual(P.effectivePermissions({ permissions: ["x"] }).fullAccess, false);
});

console.log("\n— packages —");
t("-1 is unlimited, 0 is a real zero", () => {
  assert.strictEqual(V.limitView(-1, 3).unlimited, true);
  assert.strictEqual(V.limitView(0, 0).unlimited, false);
  assert.strictEqual(V.limitView(0, 0).state, "full");
});
t("quota percentages and states", () => {
  assert.strictEqual(V.limitView(10, 4).percent, 40);
  assert.strictEqual(V.limitView(10, 8).state, "warning");
  assert.strictEqual(V.limitView(10, 10).state, "full");
  assert.strictEqual(V.limitView(10, 12).exceeded, true);
});
t("no usage figure → plain limit, no bar", () => {
  const l = V.limitView(5, null, { en: "users", ar: "مستخدم" });
  assert.strictEqual(l.percent, null);
  assert.strictEqual(l.label.en, "5 users");
});
t("expired subscription is critical whatever the status column says", () => {
  const p = V.periodView("2020-01-01", "2020-02-01", "active", new Date("2026-09-13"));
  assert.strictEqual(p.expired, true);
  assert.strictEqual(p.severity, "critical");
  assert.strictEqual(p.statusLabel.ar, "منتهي");
});
t("expiring soon is a warning, healthy is ok", () => {
  assert.strictEqual(V.periodView("2026-01-01", "2026-09-30", "active", new Date("2026-09-13")).severity, "warning");
  assert.strictEqual(V.periodView("2026-01-01", "2027-09-30", "active", new Date("2026-09-13")).severity, "ok");
});
t("a missing plan raises its own warning", () => {
  const w = V.buildWarnings(null, V.periodView("2026-01-01", "2027-01-01", "active", new Date("2026-09-13")));
  assert.ok(w.some((x) => x.code === "no_plan" && x.message.ar));
});
t("one-time plan has no monthly equivalent", () => {
  const p = V.toPlanView({ price: "500", currency: "aed", billing_period: "one_time", max_users: -1 });
  assert.strictEqual(p.pricePerMonth, null);
  assert.strictEqual(p.headlinePrice, "500.00 AED");
});
t("string features are accepted", () => {
  const p = V.toPlanView({ price: 0, features: ["Unlimited exports"] });
  assert.strictEqual(p.features[0].label.ar, "Unlimited exports");
  assert.strictEqual(p.features[0].included, true);
});
console.log(`\n${n} unit assertions passed\n`);
