# Accounts Centre, Permissions Centre & Packages

API contract for the three admin surfaces. Everything here is server-side:
the client no longer has to interpret raw table rows, re-derive limits, or
keep its own copy of the section list.

---

## ملخّص بالعربي

| الشاشة | ماذا تغيّر |
|---|---|
| **مركز إنشاء الحسابات** | صار محميّاً بصلاحية أدمن حقيقية (قبلها أي مستخدم مسجّل كان يقدر ينشئ حساب أدمن)، مع تحقّق من اسم المستخدم وقوة كلمة السر، وربط بعدد المقاعد المسموح في الباقة، وحماية من حذف نفسك أو حذف آخر مدير عام، وسجل تدقيق لكل عملية، وبحث وترقيم صفحات، وتصفير كلمة سر بكلمة مؤقتة. |
| **مركز الصلاحيات** | صار للصلاحيات قاموس واحد على السيرفر (`/api/permissions/catalog`) تُبنى منه الشاشة، مع تصحيح الكلمات القديمة (`update` → `edit`)، وقوالب أدوار جاهزة (مُطّلع / مفتّش / مشرف / مدير جودة / مدير شركة)، وحفظ صلاحيات لعدة مستخدمين دفعة واحدة. |
| **كرت الباقات** | نداء واحد `/api/packages/overview` يرجّع الكرت كاملاً: اسم الباقة بالعربي والإنجليزي، السعر مع مدّته، الحدود مع علامة «غير محدود» صريحة، الاستهلاك الفعلي (مستخدمون / فروع / تقارير) بالنِّسب، الأيام المتبقية، والتنبيهات مصاغة جاهزة بلغتين. لم يعد على الواجهة أن تخمّن معنى `-1`. |

---

## 1. Packages (the card)

### `GET /api/packages/overview` — one call, the whole card
Alias: `GET /api/subscription/overview`. Requires a token. A company user
always gets their own company; a super-admin may pass `?company_id=`.

```jsonc
{
  "ok": true,
  "card": {
    "company":  { "id": 1, "name": "Al Mawashi", "status": "active" },
    "plan": {
      "code": "growth",
      "name": "Growth",  "nameAr": "باقة النمو",
      "price": 99, "currency": "USD",
      "billingPeriod": "yearly",
      "periodLabel":   { "en": "per year", "ar": "سنوياً" },
      "headlinePrice": "99.00 USD per year",
      "pricePerMonth": 8.25,                 // comparable across cycles
      "limits": {
        "users":    { "used": 4,  "max": 10,   "percent": 40, "remaining": 6, "state": "ok",
                      "unlimited": false, "label": { "ar": "4 من 10 مستخدم" } },
        "branches": { "used": 12, "max": 15,   "percent": 80, "state": "warning", "unlimited": false },
        "reports":  { "used": 310,"max": 2000, "percent": 16, "state": "ok", "unlimited": false },
        "storageMb":{ "unlimited": true, "label": { "ar": "ميغابايت غير محدود" } }
      },
      "features": [ { "key": "audit", "label": { "en": "Audit trail", "ar": "سجل التدقيق" },
                      "included": true } ],
      "isPopular": true, "trialDays": 14, "color": "#6366f1"
    },
    "period":  { "startDate": "2026-01-01", "endDate": "2026-09-25",
                 "daysRemaining": 12, "percentElapsed": 96,
                 "expired": false, "expiringSoon": true, "severity": "warning",
                 "statusLabel": { "en": "Active", "ar": "نشط" } },
    "usage":   { "users": 4, "branches": 12, "reports": 310,
                 "scope": { "users": "company", "branches": "platform", "reports": "platform" } },
    "renewal": { "amount": 99, "currency": "USD", "dueOn": "2026-09-25", "periodMonths": 12 },
    "lastInvoice": null,
    "warnings": [
      { "code": "subscription_expiring", "severity": "warning",
        "message": { "en": "The subscription ends in 12 day(s).",
                     "ar": "ينتهي الاشتراك خلال 12 يوم." } }
    ],
    "severity": "warning"          // roll-up: ok | warning | critical
  },
  "plans": [ /* every active package, same shape, for the upgrade row */ ]
}
```

Rules the card no longer has to know:

- **`-1` never reaches the UI.** Every limit carries `unlimited: true` and a
  ready label instead.
- **`state`** is `ok` → `warning` (≥ 80 %) → `full` → `exceeded`, decided once
  on the server so two screens cannot disagree about the colour.
- **`severity`** on `period` and on the card: `ok` / `warning` (≤ 30 days) /
  `critical` (≤ 7 days, or expired).
- **`usage.scope`** says whether a figure is company-level or platform-wide.
  Seats are per company; branches and monthly report volume come from the
  `reports` table, which has no company column yet, so those are platform
  totals. Stated rather than implied.

### `GET /api/plans` — the pricing row
`?active=1` to hide retired tiers. Ordered by `sort_order`, then price. Each
plan is the same object as `card.plan` **plus every raw column**
(`max_users`, `price`, `is_active`, …), so existing screens keep working.

### Writes (admin token required)
| Route | Notes |
|---|---|
| `POST /api/plans` | `name` required; price must be ≥ 0; `billingPeriod` ∈ `monthly` \| `quarterly` \| `yearly` \| `one_time`; `code` is slugified and unique. |
| `PUT /api/plans/:id` | **Partial.** Only fields present in the body are written. The old handler wrote every column, so sending `{ price }` blanked the name and both limits. |
| `DELETE /api/plans/:id` | Refuses with `409 plan_in_use` and lists the companies. `?force=1` detaches them, as before. Deactivating (`is_active:false`) is usually what is wanted. |

Limits accept `-1`, `null`, `""`, `"unlimited"` or `true` for "no ceiling".

### Companies
`PUT /api/companies/:id` is partial for the same reason. `DELETE` refuses
while accounts still belong to the company (`company_id` is
`ON DELETE SET NULL`, so deleting would quietly promote its staff to
platform-level accounts); `?force=1` overrides.

---

## 2. Accounts Centre

All routes need an **admin** token (`isAdmin` or `isSuperAdmin`).
A company admin is pinned to their own company: they cannot list, read, edit
or delete an account in another company, whatever `company_id` they send.

| Route | Purpose |
|---|---|
| `GET /api/app-users` | `?q=` (username / name / email), `?status=active\|inactive`, `?role=admin\|super_admin\|user`, `?limit=&offset=`, `?company_id=`. Returns `{ users, total, limit, offset, seats }`. |
| `GET /api/app-users/:id` | One account, with `effective.role` and `effective.fullAccess`. |
| `POST /api/app-users` | Create. |
| `PUT /api/app-users/:id` | Partial update. |
| `PATCH /api/app-users/:id/status` | Enable / disable switch (`{ isActive }`, or toggles). |
| `POST /api/app-users/:id/reset-password` | With no body the server generates a readable temporary password and returns it **once** as `temporaryPassword`; sets `must_change_password`. |
| `DELETE /api/app-users/:id` | Delete. |
| `GET /api/accounts/overview` | Totals for the header: active / inactive / admins / never-logged-in / **accounts with no permissions at all**, plus seats and a per-company breakdown. |
| `GET /api/accounts/policy` | The username and password rules, so the form validates the same way the server does. |

**Validation**

- username: `^[a-zA-Z0-9._-]{3,32}$`, stored lower-case, reserved names
  refused, and now unique case-insensitively (`Ahmad` and `ahmad` are one
  account — login matches case-insensitively too).
- password: ≥ 8 chars, at least one letter and one digit. A rejection lists
  which rules failed: `{ error: "weak_password", problems: ["too_short"] }`.

**Rails** (all `409` unless noted)

`cannot_delete_self` · `cannot_disable_self` · `cannot_demote_self` ·
`last_super_admin` (the last active super-admin cannot be deleted, disabled
or demoted) · `seat_limit_reached` (creating or re-activating past the
package's `max_users`; the response carries the `seats` object and a
bilingual message) · `403 super_admin_only` (granting super-admin, moving an
account between companies, deleting a super-admin).

Every create / update / delete / password reset / permission change writes an
`activity_log` row (`account_created`, `account_updated`, `account_enabled`,
`account_disabled`, `account_deleted`, `account_password_reset`,
`permissions_updated`, `permissions_bulk_applied`). Field **names** are
logged, never values — no password or salt ever reaches the log.

---

## 3. Permissions Centre

### `GET /api/permissions/catalog`
The vocabulary the screen renders itself from:

```jsonc
{
  "actions":  [ { "id": "view", "label": { "en": "View", "ar": "عرض" } }, … ],
  "groups":   [ "general", "reports", "data", "administration" ],
  "sections": [
    { "id": "accounts", "group": "administration",
      "label": { "en": "Accounts Centre", "ar": "مركز الحسابات" },
      "actions": ["view","create","edit","delete"] },
    { "id": "qcs_non_conformance", "group": "reports",
      "label": { "en": "QCS Non-Conformance", "ar": "عدم مطابقة QCS" },
      "actions": ["view","create","edit","delete","export"], "known": true },
    …
  ],
  "templates": [ { "id": "supervisor", "label": { "ar": "مشرف" }, "isAdmin": false }, … ]
}
```

Report sections are **discovered from the data** (`SELECT DISTINCT type FROM
reports`), so a module the client adds appears in the permissions screen
without a server change. `known: false` marks one the server has no label for.

### Saving
| Route | Body |
|---|---|
| `PUT /api/app-users/:id/permissions` | `{ template? , crudPerms? , permissions? , allowedBranches? , employees? , mode? }` — `mode: "merge"` adds to what the account has, `"replace"` (default) saves exactly what was sent. A `crudPerms` map sent alongside a `template` wins, so the screen can expand a preset, untick one box, and save. |
| `POST /api/permissions/bulk` | `{ userIds: [...], template \| crudPerms, mode? }` — up to 200 accounts in one go. Out-of-scope ids come back in `skipped`, never silently ignored. |
| `GET /api/permissions/templates/:id` | Preview the concrete map a preset expands to before saving it. |

### Normalisation (applied on every write)
- Legacy verbs are migrated, not dropped: `read/show` → `view`,
  `write/add/new` → `create`, `update/modify` → `edit`, `remove` → `delete`,
  `print/download` → `export`.
- Unknown verbs are dropped — a permission the server can never check is
  worse than none.
- Any action implies `view`.
- Sections with an empty action list are removed.
- **Unknown section ids are kept** (the report list is client-driven) and
  returned as `warnings.unknownSections` so the screen can flag stale rows.
- `permissions: ["*"]` collapses the list — `["*", "inspector"]` is never stored.
- `allowedBranches` accepts both the legacy flat array and the per-section
  object `{ sectionId: [branches] }`.

### Role templates
`viewer` · `inspector` · `supervisor` · `quality_manager` · `company_admin`.
They expand over the installation's **actual** report list, not a list frozen
at build time. A template that implies admin only ever grants the flag; it
never strips it from an account that was made admin by hand.

---

## Login response additions

`POST /api/auth/login` now also returns `email`, `jobTitle`, `roleTemplate`,
`mustChangePassword` (send the user to a change-password screen when true),
and `user.company.planId` / `planNameAr`.

## Tests

`npm test` runs `tests/permissions-packages.test.cjs` — 16 assertions over
the permission normaliser and the package view model. No database, no
network.

## If the boot log warns about `ux_app_users_username_lower`

The database already holds usernames that differ only by case (`Ahmad` and
`ahmad`). The index is skipped and boot continues; login then matches one of
them arbitrarily. Rename or delete the duplicates, and the index is created
on the next boot:

```sql
SELECT lower(username), count(*), array_agg(username)
  FROM app_users GROUP BY 1 HAVING count(*) > 1;
```

New accounts are stored lower-case, so no new duplicate can be created
either way.

## Environment

`AUTH_SECRET` must be set for any of the gates to apply. Without it the
server cannot issue a token at all, so the admin routes fall open with a
logged warning rather than locking the dashboard out of itself — the same
escape hatch `requireAuthStrict` already used.
