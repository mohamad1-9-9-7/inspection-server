/* ============================================================
   Package (plan) view model
   ------------------------------------------------------------
   The packages card used to be unreadable because the API handed
   the UI raw table rows:

     { price: "49.00", max_users: -1, max_branches: 5, currency: "USD" }

   Nothing there says whether -1 is "none" or "unlimited", what the
   price is per, how much of the quota is already spent, or when the
   subscription runs out. Every screen guessed, and each guessed
   differently.

   This module turns a row into a card the UI can render without
   interpreting anything: explicit `unlimited` flags, ready labels in
   Arabic and English, percentages, and a severity-tagged warning list.
============================================================ */

/* -1 (and NULL) have always meant "no ceiling" in the plans table. */
const UNLIMITED = -1;

const PERIODS = {
  monthly:   { months: 1,  label: { en: "per month",   ar: "شهرياً" },    short: { en: "/mo", ar: "/شهر" } },
  quarterly: { months: 3,  label: { en: "per quarter", ar: "كل 3 أشهر" }, short: { en: "/qtr", ar: "/ربع" } },
  yearly:    { months: 12, label: { en: "per year",    ar: "سنوياً" },     short: { en: "/yr", ar: "/سنة" } },
  one_time:  { months: 0,  label: { en: "one-time",    ar: "دفعة واحدة" }, short: { en: "", ar: "" } },
};

const STATUS_LABELS = {
  active:    { en: "Active",    ar: "نشط" },
  trial:     { en: "Trial",     ar: "تجريبي" },
  suspended: { en: "Suspended", ar: "موقوف" },
  expired:   { en: "Expired",   ar: "منتهي" },
  cancelled: { en: "Cancelled", ar: "ملغى" },
};

/* Inside this many days of the end date the card turns amber. */
const EXPIRY_WARNING_DAYS = 30;
/* And red. */
const EXPIRY_CRITICAL_DAYS = 7;
/* Quota bar turns amber here. */
const QUOTA_WARNING_PERCENT = 80;

const num = (v, def = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

const isUnlimited = (max) => max == null || num(max, UNLIMITED) < 0;

function normalizePeriod(p) {
  const k = String(p ?? "").trim().toLowerCase();
  return PERIODS[k] ? k : "monthly";
}

function money(amount, currency) {
  const n = num(amount, 0);
  const cur = String(currency || "USD").toUpperCase();
  /* Fixed 2dp rather than Intl: the server has no guaranteed ICU build,
     and a card that reads "49.00 AED" everywhere beats one that reads
     "٤٩٫٠٠" on one host and "49" on another. */
  return { amount: n, currency: cur, formatted: `${n.toFixed(2)} ${cur}` };
}

/**
 * One quota line of the card: "Users 7 / 10".
 * `used` may be null when the caller has no usage figure — the line then
 * renders as a plain limit with no bar.
 */
function limitView(max, used = null, unit = { en: "", ar: "" }) {
  const unlimited = isUnlimited(max);
  const cap = unlimited ? null : Math.max(0, Math.trunc(num(max, 0)));
  const spent = used == null ? null : Math.max(0, Math.trunc(num(used, 0)));

  const remaining = unlimited || spent == null ? null : Math.max(0, cap - spent);
  const percent =
    unlimited || spent == null ? null : cap === 0 ? 100 : Math.min(100, Math.round((spent / cap) * 100));

  let state = "ok";
  if (!unlimited && spent != null) {
    if (spent >= cap) state = "full";
    else if (percent >= QUOTA_WARNING_PERCENT) state = "warning";
  }

  return {
    used: spent,
    max: unlimited ? null : cap,
    rawMax: unlimited ? UNLIMITED : cap,
    unlimited,
    remaining,
    percent,
    state,
    exceeded: !unlimited && spent != null && spent > cap,
    label: unlimited
      ? { en: `Unlimited ${unit.en}`.trim(), ar: `${unit.ar} غير محدود`.trim() }
      : spent == null
      ? { en: `${cap} ${unit.en}`.trim(), ar: `${cap} ${unit.ar}`.trim() }
      : { en: `${spent} of ${cap} ${unit.en}`.trim(), ar: `${spent} من ${cap} ${unit.ar}`.trim() },
  };
}

/**
 * Turn a `plans` row into the card object.
 * `usage` is optional — pass { users, branches, reports } to get the
 * quota bars filled in for the company currently on this plan.
 */
function toPlanView(row, usage = null) {
  if (!row) return null;

  const period = normalizePeriod(row.billing_period);
  const meta = PERIODS[period];
  const price = money(row.price, row.currency);

  /* Monthly equivalent so three plans billed on different cycles can be
     compared in one row of cards. one_time has no equivalent. */
  const perMonth =
    meta.months > 0 ? money(price.amount / meta.months, price.currency) : null;

  const features = Array.isArray(row.features)
    ? row.features
        .map((f) =>
          typeof f === "string"
            ? { key: null, label: { en: f, ar: f }, included: true }
            : {
                key: f?.key ?? null,
                label: {
                  en: String(f?.label?.en ?? f?.en ?? f?.label ?? ""),
                  ar: String(f?.label?.ar ?? f?.ar ?? f?.label?.en ?? f?.label ?? ""),
                },
                included: f?.included !== false,
              }
        )
        .filter((f) => f.label.en || f.label.ar)
    : [];

  return {
    /* Raw columns stay on the object so the existing screens, which read
       plan.max_users and plan.price directly, keep working unchanged. */
    ...row,

    id: row.id,
    code: row.code || null,
    name: row.name || "",
    nameAr: row.name_ar || row.name || "",
    description: row.description || "",
    descriptionAr: row.description_ar || row.description || "",

    price: price.amount,
    currency: price.currency,
    priceLabel: price.formatted,
    billingPeriod: period,
    periodLabel: meta.label,
    periodShort: meta.short,
    pricePerMonth: perMonth ? perMonth.amount : null,
    pricePerMonthLabel: perMonth ? perMonth.formatted : null,
    /* The one string a card headline needs: "99.00 USD / per month". */
    headlinePrice: meta.months === 0 ? price.formatted : `${price.formatted} ${meta.label.en}`,

    limits: {
      users:    limitView(row.max_users,             usage?.users,    { en: "users",    ar: "مستخدم" }),
      branches: limitView(row.max_branches,          usage?.branches, { en: "branches", ar: "فرع" }),
      reports:  limitView(row.max_reports_per_month, usage?.reports,  { en: "reports/month", ar: "تقرير شهرياً" }),
      storageMb: limitView(row.max_storage_mb,       usage?.storageMb, { en: "MB", ar: "ميغابايت" }),
    },

    features,
    trialDays: num(row.trial_days, 0),
    isActive: row.is_active !== false,
    isPopular: !!row.is_popular,
    sortOrder: num(row.sort_order, 0),
    color: row.color || null,
  };
}

/**
 * Subscription window maths — the part of the card that answers
 * "how long do I have left?".
 */
function periodView(startDate, endDate, status = "active", today = new Date()) {
  const day = 24 * 60 * 60 * 1000;
  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;
  const now = new Date(today.toISOString().slice(0, 10));

  const valid = (d) => d instanceof Date && !Number.isNaN(d.getTime());
  const daysRemaining = valid(end) ? Math.ceil((end - now) / day) : null;
  const daysTotal = valid(start) && valid(end) ? Math.max(1, Math.round((end - start) / day)) : null;
  const daysElapsed = valid(start) ? Math.max(0, Math.round((now - start) / day)) : null;
  const percentElapsed =
    daysTotal != null && daysElapsed != null ? Math.min(100, Math.round((daysElapsed / daysTotal) * 100)) : null;

  const rawStatus = String(status || "active").toLowerCase();
  const expired = rawStatus === "expired" || (daysRemaining != null && daysRemaining < 0);
  const effective = expired ? "expired" : rawStatus;

  return {
    startDate: valid(start) ? start.toISOString().slice(0, 10) : null,
    endDate: valid(end) ? end.toISOString().slice(0, 10) : null,
    status: effective,
    statusLabel: STATUS_LABELS[effective] || { en: effective, ar: effective },
    daysRemaining,
    daysTotal,
    daysElapsed,
    percentElapsed,
    expired,
    expiringSoon: !expired && daysRemaining != null && daysRemaining <= EXPIRY_WARNING_DAYS,
    /* What colour the card should be, decided once, on the server. */
    severity: expired
      ? "critical"
      : daysRemaining != null && daysRemaining <= EXPIRY_CRITICAL_DAYS
      ? "critical"
      : daysRemaining != null && daysRemaining <= EXPIRY_WARNING_DAYS
      ? "warning"
      : "ok",
  };
}

/**
 * The banner list on the card. Each entry is already phrased in both
 * languages so no screen has to build a sentence out of numbers.
 */
function buildWarnings(planView, period) {
  const out = [];

  if (!planView) {
    out.push({
      code: "no_plan",
      severity: "critical",
      message: { en: "No package is assigned to this company.", ar: "لا توجد باقة مرتبطة بهذه الشركة." },
    });
  }

  if (period?.expired) {
    out.push({
      code: "subscription_expired",
      severity: "critical",
      message: { en: "The subscription has expired.", ar: "انتهى اشتراك الشركة." },
    });
  } else if (period?.expiringSoon) {
    out.push({
      code: "subscription_expiring",
      severity: period.severity === "critical" ? "critical" : "warning",
      message: {
        en: `The subscription ends in ${period.daysRemaining} day(s).`,
        ar: `ينتهي الاشتراك خلال ${period.daysRemaining} يوم.`,
      },
    });
  }

  for (const [key, ar] of [["users", "المستخدمين"], ["branches", "الفروع"], ["reports", "التقارير"]]) {
    const limit = planView?.limits?.[key];
    if (!limit || limit.unlimited || limit.used == null) continue;
    if (limit.exceeded) {
      out.push({
        code: `${key}_limit_exceeded`,
        severity: "critical",
        message: {
          en: `${key} in use (${limit.used}) exceed the package limit of ${limit.max}.`,
          ar: `عدد ${ar} المستخدم (${limit.used}) تجاوز حد الباقة (${limit.max}).`,
        },
      });
    } else if (limit.state === "full") {
      out.push({
        code: `${key}_limit_reached`,
        severity: "warning",
        message: {
          en: `The package limit of ${limit.max} ${key} has been reached.`,
          ar: `تم الوصول إلى حد الباقة: ${limit.max} من ${ar}.`,
        },
      });
    } else if (limit.state === "warning") {
      out.push({
        code: `${key}_limit_near`,
        severity: "info",
        message: {
          en: `${limit.percent}% of the ${key} quota is in use.`,
          ar: `تم استهلاك ${limit.percent}% من حصة ${ar}.`,
        },
      });
    }
  }

  return out;
}

module.exports = {
  UNLIMITED,
  PERIODS,
  STATUS_LABELS,
  EXPIRY_WARNING_DAYS,
  EXPIRY_CRITICAL_DAYS,
  QUOTA_WARNING_PERCENT,
  isUnlimited,
  normalizePeriod,
  money,
  limitView,
  toPlanView,
  periodView,
  buildWarnings,
};
