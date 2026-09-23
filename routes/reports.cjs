const cloudinary = require("cloudinary").v2;

module.exports = function registerReportsRoutes(app, deps = {}) {
  const { pool, clampInt, normText, isObj, requireAuth, requireAuthStrict, makeLimiter } = deps;

  // Fallback no-op if the middleware wasn't wired in (keeps routes working
  // on an older deps shape); real enforcement comes from utils/requireAuth.
  const auth = typeof requireAuth === "function" ? requireAuth : (_req, _res, next) => next();

  // Maintenance routes are admin-only regardless of REQUIRE_AUTH.
  const authStrict =
    typeof requireAuthStrict === "function" ? requireAuthStrict : auth;

  /* A single `?type=X&limit=5000` read can return several MB, so this is by
     far the most expensive route to leave unmetered — one scraper looping it
     is enough to blow through a month of bandwidth. The cap is per IP and
     generous enough that a whole branch office behind one NAT address never
     reaches it during normal use. Note this bounds the damage but does not
     close the hole: until REQUIRE_AUTH=on, these reads are still anonymous. */
  const readLimiter =
    typeof makeLimiter === "function"
      ? makeLimiter({ max: 120, windowMs: 60_000, name: "reports-read" })
      : (_req, _res, next) => next();

  // Liveness probes (server wake-up banner + ServerHealth tool) only care
  // whether the process responds — they must NOT query the DB (would wake
  // Neon out of autosuspend) AND must skip auth (they carry no token).
  const pingBypass = (req, res, next) => {
    const t = req.query?.type;
    if (t === "__ping__" || t === "__health_probe__") return res.json([]);
    next();
  };

/* ============================================================
   Reference numbers  (AM-CND-000142)
   ------------------------------------------------------------
   One continuous counter per report type, never reset, so a
   reference identifies a record for all time. The counter is
   bumped with a single atomic UPSERT, which means two concurrent
   saves can never be handed the same number.

   Add a type here and it starts getting references — nothing
   else in the app needs to change.
============================================================ */
const REF_PREFIX = {
  destruction_record:     "CND",
  returns:                "RET",
  returns_customers:      "CRT",
  // NC numbers used to be typed by hand ("NC-001"), so two people raising a
  // finding on the same morning wrote the same number. Each NCR type keeps its
  // own counter: QCS and POS 19 store their reports separately and must not
  // share a sequence.
  qcs_non_conformance:    "NCR",
  pos19_non_conformance:  "NCP",
  sweets_non_conformance: "NCR",
  // شكاوي الجودة (فروع وموردين) — كل شكوى تحمل مرجعًا مستقلًا (AM-CMP-000123)
  qa_complaint:           "CMP",
};

const REF_PAD = 6;

/* Branch-scoped references: instead of one global counter per type, these keep
   a separate counter per branch and lead the number with the branch code —
   e.g. the butcher's cutting log reads "POS 10 — 00001", counting from 1 for
   every branch on its own. The counter row key is `<type>:<branch>`, so no
   schema change is needed (report_counters.type is just text).

   scopeOf() pulls the branch out of the payload; a record without a branch is
   left unnumbered rather than sharing some catch-all counter. */
const REF_SCOPED = {
  butcher_cut_log: {
    pad: 5,
    scopeOf: (p) => normText(p?.branch || ""),
    format: (scope, n, pad) => `${scope} — ${String(n).padStart(pad, "0")}`,
  },
};

function hasRef(payload) {
  return !!(payload && typeof payload.refNo === "string" && payload.refNo.trim());
}

/** Bump the counter for `type` and return the next reference, or null if the
 *  type isn't reference-tracked. `q` is a pool or a transaction client. */
async function bumpCounter(q, key) {
  const { rows } = await q.query(
    `INSERT INTO report_counters (type, last)
     VALUES ($1, 1)
     ON CONFLICT (type) DO UPDATE
       SET last = report_counters.last + 1, updated_at = now()
     RETURNING last`,
    [key]
  );
  return rows[0].last;
}

async function allocRef(q, type, payload) {
  // Branch-scoped types count per branch: "POS 10 — 00001".
  const scoped = REF_SCOPED[type];
  if (scoped) {
    const scope = scoped.scopeOf(payload);
    if (!scope) return null;                       // no branch → no number
    const n = await bumpCounter(q, `${type}:${scope}`);
    return scoped.format(scope, n, scoped.pad);
  }

  const prefix = REF_PREFIX[type];
  if (!prefix) return null;

  const n = await bumpCounter(q, type);
  return `AM-${prefix}-${String(n).padStart(REF_PAD, "0")}`;
}

/** Stamp a reference onto a payload that is about to be INSERTed.
 *  Never overwrites one the caller already supplied (restore / import). */
async function stampRef(q, type, payload) {
  if ((!REF_PREFIX[type] && !REF_SCOPED[type]) || hasRef(payload)) return payload;
  const refNo = await allocRef(q, type, payload);
  return refNo ? { ...payload, refNo } : payload;
}

/* An UPDATE replaces the whole payload, and clients happily PUT payloads that
   predate references — so re-merge the stored refNo whenever the row has one.
   Used as the SET expression everywhere payload is overwritten; $N is the
   incoming payload parameter. */
const KEEP_REF = (p) => `
  CASE WHEN payload ? 'refNo'
       THEN ${p}::jsonb || jsonb_build_object('refNo', payload->'refNo')
       ELSE ${p}::jsonb
  END`;

/* ============================================================
   Audit trail (report_audit table)
   ------------------------------------------------------------
   Every UPDATE/DELETE on reports is recorded with full before/
   after payloads: who (token username, else reporter), when, and
   what changed. Fire-and-forget — an audit failure must never
   fail or slow down the save itself. No-op saves (identical
   payload) are skipped so autosaves don't flood the log.
============================================================ */

/** JSON.stringify with recursively sorted object keys, so two payloads
 *  compare equal regardless of key order (jsonb from PG is key-sorted,
 *  fresh client objects are not). */
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  return (
    "{" +
    Object.keys(v)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k]))
      .join(",") +
    "}"
  );
}

function samePayload(a, b) {
  try {
    return stableStringify(a) === stableStringify(b);
  } catch {
    return false;
  }
}

function auditUser(req) {
  const u = req.user || {};
  const name = String(u.username || req.body?.reporter || "").trim();
  return name || "unknown";
}

function auditIp(req) {
  return (
    String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

/** Fire-and-forget audit insert. `action` is 'update' | 'delete'. */
function auditWrite(req, { action, reportId, reportType, oldPayload, newPayload }) {
  if (action === "update" && samePayload(oldPayload, newPayload)) return;
  pool
    .query(
      `INSERT INTO report_audit
         (report_id, report_type, action, username, old_payload, new_payload, route, ip_addr)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [
        reportId ?? null,
        String(reportType || ""),
        action,
        auditUser(req),
        oldPayload == null ? null : JSON.stringify(oldPayload),
        newPayload == null ? null : JSON.stringify(newPayload),
        `${req.method} ${req.originalUrl || req.url || ""}`.slice(0, 300),
        auditIp(req),
      ]
    )
    .catch((e) => console.warn("[audit] insert failed:", e?.message || e));
}

/* Types that are pure lookup/dictionary rows (vehicle numbers, driver names…)
   or internal probes: high volume, zero compliance value. Their CREATEs are
   not logged. Edits/deletes on them still are. */
const AUDIT_SKIP_CREATE = /(^__)|lookup/i;

/** Log a record creation.
 *  Metadata only — the created payload still lives in `reports`, so storing a
 *  second full copy would roughly double the database for no extra evidence.
 *  If the record is later edited or deleted, THOSE entries carry the full
 *  before-state, so nothing is lost. We keep just enough here (reportDate,
 *  refNo) to make the audit row readable on its own. */
function auditCreate(req, row) {
  if (!row || AUDIT_SKIP_CREATE.test(String(row.type || ""))) return;
  const p = row.payload || {};
  auditWrite(req, {
    action: "create",
    reportId: row.id,
    reportType: row.type,
    oldPayload: null,
    newPayload: { reportDate: p.reportDate ?? null, refNo: p.refNo ?? null },
  });
}

/** Fetch the current row for a (type, reportDate) pair — used to capture
 *  the "old" payload before an upsert-style UPDATE overwrites it. */
/** `companyId` لازم يكون رقم حقيقي (نتيجة companyIdForWrite)، حتى ما نجيب
 *  "القديم" من صف شركة تانية بالغلط لمّا يتوسّع القيد الفريد ليصير
 *  (company_id, type, reportDate) ويسمح بأكتر من صف لنفس النوع والتاريخ. */
async function fetchOldByTypeDate(type, reportDate, companyId) {
  try {
    const q = await pool.query(
      `SELECT id, payload FROM reports WHERE type=$1 AND payload->>'reportDate'=$2 AND company_id=$3 LIMIT 1`,
      [type, reportDate, companyId]
    );
    return q.rows[0] || null;
  } catch {
    return null;
  }
}

/** Same, by numeric id. */
async function fetchOldById(id) {
  try {
    const q = await pool.query(`SELECT id, type, payload, company_id FROM reports WHERE id=$1`, [id]);
    return q.rows[0] || null;
  } catch {
    return null;
  }
}

/* ============================================================
   نطاق سجلات التقطيع حسب الملحمة (butcher_cut_log)

   المتصفّح عم يحصر لوحة المشرف على ملاحمه، بس حصر الواجهة بيتجاوزه أي حدا
   بيفتح /api/reports بنفسه. هون منفرضه على السيرفر.

   القاعدة مقصودة ضيّقة، حتى ما تكسر ولا شاشة من مئات الشاشات اللي بتضرب
   /api/reports:

     • بتنطبق على نوع واحد فقط: butcher_cut_log.
     • ما بتنطبق إذا ما عرفنا مين المستخدم (توكن غايب أو AUTH_SECRET مش
       مضبوط) — نفس فلسفة requireAuth بوضع التدقيق: ما منكسر شي هلق،
       ومنفرض لحظة ما تنضبط البيئة.
     • ما بتنطبق على الأدمن — هو اللي بيراقب كل الملاحم.
     • ما بتنطبق على حساب مش مربوط بموظف نشط بالقوى العاملة.

   المصدر: نفس سجل workforce_config اللي بتقرأه الواجهة، مخبّأ دقيقة
   بالذاكرة — استعلام مع كل طلب بيوقظ Neon من السبات بلا داعٍ.
============================================================ */
const WF_TYPE = "workforce_config";
const WF_TTL_MS = 60_000;
let wfCache = { at: 0, people: [] };

async function workforcePeople() {
  if (Date.now() - wfCache.at < WF_TTL_MS) return wfCache.people;
  try {
    const { rows } = await pool.query(
      `SELECT payload FROM reports
         WHERE type = $1
         ORDER BY updated_at DESC NULLS LAST, created_at DESC
         LIMIT 1`,
      [WF_TYPE]
    );
    const people = Array.isArray(rows?.[0]?.payload?.people) ? rows[0].payload.people : [];
    wfCache = { at: Date.now(), people };
  } catch (e) {
    /* السجل مش موجود أو القراءة فشلت → بلا حصر. الفشل هون ما بيجوز يقفل
       شاشة على حدا؛ الحصر ميزة فوق، مش شرط تشغيل. */
    console.warn("[cut-scope] workforce_config read failed:", e?.message || e);
    wfCache = { at: Date.now(), people: [] };
  }
  return wfCache.people;
}

/** أكواد ملاحم صاحب الطلب، أو null = بلا حصر. */
async function cutScopeSites(req, type) {
  if (type !== "butcher_cut_log") return null;

  const u = req.user;
  if (!u || u.isAdmin) return null;

  const key = String(u.username || "").trim().toLowerCase();
  if (!key) return null;

  const people = await workforcePeople();
  const me = people.find(
    (x) => String(x?.username || "").trim().toLowerCase() === key
  );
  if (!me || me.status !== "active") return null;

  /* «مسؤول المخزون» صلاحياته داخل المخزون كاملة متل الأدمن — بيشوف كل
     الملاحم. لازم يضل مطابق للواجهة، وإلا بتوريه اللوحة كل شي والسيرفر
     بيرجّعله ملحمته وبس. */
  if (me.role === "inventoryOfficer") return null;

  const sites = Array.isArray(me.sites) && me.sites.length
    ? me.sites
    : (me.site ? [me.site] : []);
  return sites.length ? sites.map(String) : null;
}

/** فلترة صفوف بتحمل payload على الملاحم المسموحة. */
const scopeRows = (rows, sites) =>
  sites
    ? (rows || []).filter((r) => sites.includes(String(r?.payload?.branch || "")))
    : rows;

/** payload.draft = شغل نصف مكتوب من نموذج عام (تقييم المورد) — بيهمّ صاحب
    الرابط لحاله لمّا يفتح صفحته، وما بتقراه ولا شاشة قائمة. لو تركناه بيمشي
    مع كل صف بكل طلب قائمة، وهيدا بالضبط نوع التضخّم اللي كلّفنا باندويث قبل.
    الصف المفرد (GET /api/reports/public/:token) بيرجّعه كما هو. */
const stripDrafts = (rows) =>
  (rows || []).map((r) =>
    r && r.payload && r.payload.draft
      ? { ...r, payload: { ...r.payload, draft: undefined } }
      : r
  );

/* ============================================================
   نطاق الشركة (multi-tenant)
   ------------------------------------------------------------
   كل تقرير تابع لشركة. صاحب حساب عادي عنده company_id ثابت جوّا التوكن
   (من app_users) — هو نطاقه ولا ينكسر بأي باراميتر من العميل، حتى لو
   حاول يمرّر ?company_id لشركة ثانية.

   حساب المنصّة (سوبر أدمن، companyId=null بالتوكن) بيقدر يحدد
   ?company_id=N بالطلب ليشتغل داخل شركة معيّنة — شاشة تبديل الشركة
   بالواجهة رح ترسلها. إذا ما حددها، منرجّع null = بلا حصر (أدوات الأدمن
   العامة زي النسخ الاحتياطي والتصدير اللي بتشتغل عبر كل الشركات).

   بلا توكن معروف إطلاقاً (المرحلة الانتقالية، أو AUTH_SECRET مش مضبوط
   بعد) → المواشي. هاد مطابق تماماً للواقع الحالي بالكامل (كل حساب
   موجود اليوم أصلاً company_id=1)، فتفعيل الفلترة هون ما بيغيّر أي سلوك
   ظاهر قبل ما تنضاف شركة تانية فعلاً. */
const DEFAULT_COMPANY_ID = 1;

function companyIdOf(req) {
  const u = req.user;
  const fromToken = u && Number.isFinite(Number(u.companyId)) && Number(u.companyId) > 0
    ? Number(u.companyId)
    : null;
  if (fromToken) return fromToken;

  if (u && u.isSuperAdmin) {
    const q = Number(req.query?.company_id ?? req.body?.companyId);
    return Number.isFinite(q) && q > 0 ? q : null;
  }

  return DEFAULT_COMPANY_ID;
}

/** لأي كتابة أو استهداف سجل بعينه: لازم رقم شركة حقيقي دايمًا. "بلا حصر"
 *  ما إلوش معنى هون — سوبر أدمن ما اختار شركة بعد بينكتب للمواشي افتراضيًا،
 *  بدل ما يضيع الصف بدون شركة أو يهرب من فحص التطابق تحت. */
function companyIdForWrite(req) {
  return companyIdOf(req) || DEFAULT_COMPANY_ID;
}

/** true إذا الصف تابع لشركة غير نطاق الطالب — يعني "مش موجود" بالنسبة إلو.
 *  سوبر أدمن بلا نطاق (null) ما إلوش تعارض، بيشوف/يعدّل أي صف. */
function companyMismatch(scope, rowCompanyId) {
  return scope != null && Number(rowCompanyId) !== Number(scope);
}

/* ============================================================
   Reports API  (all routes gated by `auth` — audit or enforce
   depending on REQUIRE_AUTH; ping probes bypass via pingBypass)
============================================================ */
app.get("/api/reports", pingBypass, readLimiter, auth, async (req, res) => {
  try {
    const { type } = req.query;

    const lite = String(req.query?.lite || "").toLowerCase();
    const isLite = lite === "1" || lite === "true" || lite === "yes";
    const limit = clampInt(req.query?.limit, 200, 1, 5000);

    const truthy = (v) => ["1", "true", "yes"].includes(String(v || "").toLowerCase());

    // null = بلا حصر (الحالة الغالبة). مصفوفة = ملاحم صاحب التوكن.
    const scopeSites = await cutScopeSites(req, type);

    // null = بلا حصر شركة (سوبر أدمن بلا اختيار — أدوات الأدمن العامة).
    // رقم = يقتصر على تقارير هالشركة فقط.
    const companyScope = companyIdOf(req);

    // One canonical business date for every report shape. Older forms use
    // payload.date or payload.cutDate, while newer forms use reportDate.
    // Keeping this expression shared by the date index, selected-record read,
    // and range read prevents the calendar from disagreeing with the record.
    const BUSINESS_DATE = `
      COALESCE(
        NULLIF(payload->>'cutDate', ''),
        NULLIF(payload->>'date', ''),
        NULLIF(LEFT(payload->>'reportDate', 10), ''),
        NULLIF(payload#>>'{entries,0,date}', ''),
        NULLIF(payload#>>'{header,reportDate}', ''),
        NULLIF(payload#>>'{header,dateIssued}', ''),
        NULLIF(payload#>>'{header,month}', ''),
        NULLIF(payload#>>'{header,issueDate}', ''),
        NULLIF(payload#>>'{headRow,reportDate}', ''),
        /* The FTR pre-loading sheets keep their date only at header.date, so
           every one of their records resolved to NULL here: a reportDate=
           query never matched them, dates=1 filtered them out of the calendar
           entirely, and the input screen fell back to downloading all 259
           records on every save. Appended last so it fires only when nothing
           above resolves - no existing record changes the date it reports. */
        NULLIF(LEFT(payload#>>'{header,date}', 10), '')
      )`;

    // `?type=X&dates=1` — the calendar of a report type: one { id, reportDate }
    // per record, no payload and no LIMIT. A few hundred date strings weigh
    // nothing, while `SELECT *` on the same rows drags every JSON payload across
    // the wire. Backs the Date Tree; the id lets the client then fetch exactly
    // the record the user clicked via GET /api/reports/:id.
    //
    // Callers send `&lite=1&limit=5000` alongside, so a server that predates
    // this branch still answers with the same { id, reportDate } shape.
    if (truthy(req.query?.dates) && type) {
      // هالفرع بيرجّع تواريخ بلا payload، فما فينا نفلتر بعدين — الشرط بالـSQL.
      const dp = [type];
      let where = "";
      if (companyScope != null) { dp.push(companyScope); where += ` AND company_id = $${dp.length}`; }
      if (scopeSites) { dp.push(scopeSites); where += ` AND payload->>'branch' = ANY($${dp.length})`; }
      const { rows } = await pool.query(
        `SELECT id, ${BUSINESS_DATE} AS "reportDate"
           FROM reports
          WHERE type = $1 AND ${BUSINESS_DATE} IS NOT NULL${where}
          ORDER BY ${BUSINESS_DATE} DESC, created_at DESC`,
        dp
      );
      return res.json({ ok: true, data: rows });
    }

    // `?type=X&reportDate=YYYY-MM-DD` — the one record the user opened.
    // Hits ux_reports_type_reportdate directly.
    const reportDate = normText(req.query?.reportDate || "");
    if (type && reportDate) {
      const rdp = [type, reportDate];
      let rdWhere = "";
      if (companyScope != null) { rdp.push(companyScope); rdWhere = ` AND company_id = $${rdp.length}`; }
      const { rows } = await pool.query(
        `SELECT * FROM reports
          WHERE type = $1 AND ${BUSINESS_DATE} = $2${rdWhere}
          ORDER BY created_at DESC
          LIMIT 1`,
        rdp
      );
      return res.json({ ok: true, data: stripDrafts(scopeRows(rows, scopeSites)) });
    }

    /* `?type=X&from=YYYY-MM-DD&to=YYYY-MM-DD` — only the window the screen
       actually shows. Report pages used to pull every record ever written and
       filter in the browser, which grows without bound; this keeps the payload
       proportional to the period on screen.

       The date compared is the **business** date, not created_at: entries can
       be backdated (a carcass cut yesterday, keyed in today), so filtering on
       the row timestamp would silently drop them. We take the first of
       cutDate / date / the leading YYYY-MM-DD of reportDate.

       Payload-only, with no created_at fallback: the matching index expression
       must be IMMUTABLE and created_at needs to_char/::date, which are merely
       STABLE. A row carrying none of the three keys has no business date to
       range over, so it stays out of a dated query by design.
       `idx_reports_business_date` backs this — keep the two in sync. */
    const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const from = normText(req.query?.from || "");
    const to = normText(req.query?.to || "");

    /* `?employeeNo=875` — سجلات موظّف واحد.
       شاشة «شغلي» بتعرض شغل جزار واحد؛ بدون هالفلتر كانت تسحب سجلات كل
       الملاحم للنافذة كلها (بالـpayload كامل) وتفلتر بالمتصفّح — أثقل طلب
       بالنظام لأقل فائدة، وعلى جهاز كشك بالملحمة. الفلتر نصّي على
       payload->>'employeeNo' لأن الرقم بينحفظ نصّ (بيحتمل أصفار بادئة). */
    const employeeNo = normText(req.query?.employeeNo || "");

    if (type && (isDay(from) || isDay(to))) {
      const where = ["type = $1"];
      const p = [type];
      if (companyScope != null) { p.push(companyScope); where.push(`company_id = $${p.length}`); }
      if (isDay(from)) { p.push(from); where.push(`${BUSINESS_DATE} >= $${p.length}`); }
      if (isDay(to)) { p.push(to); where.push(`${BUSINESS_DATE} <= $${p.length}`); }
      if (employeeNo) {
        p.push(employeeNo);
        where.push(`payload->>'employeeNo' = $${p.length}`);
      }
      p.push(limit);
      const { rows } = await pool.query(
        `SELECT * FROM reports
          WHERE ${where.join(" AND ")}
          ORDER BY created_at DESC
          LIMIT $${p.length}`,
        p
      );
      return res.json({ ok: true, data: stripDrafts(scopeRows(rows, scopeSites)) });
    }

    let q = "";
    let params = [];

    if (isLite) {
      if (type) {
        const lp = [type];
        let lWhere = "";
        if (companyScope != null) { lp.push(companyScope); lWhere += ` AND company_id = $${lp.length}`; }
        if (scopeSites) { lp.push(scopeSites); lWhere += ` AND payload->>'branch' = ANY($${lp.length})`; }
        lp.push(limit);
        q = `
          SELECT
            id,
            reporter,
            type,
            created_at,
            updated_at,
            ${BUSINESS_DATE} AS "reportDate",
            payload->>'invoiceNo'  AS "invoiceNo"
          FROM reports
          WHERE type = $1${lWhere}
          ORDER BY created_at DESC
          LIMIT $${lp.length}
        `;
        // lite ما بيرجّع payload، فما فينا نفلتر بعدين — الشرط لازم يكون بالـSQL.
        params = lp;
      } else {
        const lp = [];
        let lWhere = "";
        if (companyScope != null) { lp.push(companyScope); lWhere = ` WHERE company_id = $1`; }
        lp.push(limit);
        q = `
          SELECT
            id,
            reporter,
            type,
            created_at,
            updated_at,
            ${BUSINESS_DATE} AS "reportDate",
            payload->>'invoiceNo'  AS "invoiceNo"
          FROM reports${lWhere}
          ORDER BY created_at DESC
          LIMIT $${lp.length}
        `;
        params = lp;
      }
    } else {
      const gp = [];
      const gWhere = [];
      if (type) { gp.push(type); gWhere.push(`type = $${gp.length}`); }
      if (companyScope != null) { gp.push(companyScope); gWhere.push(`company_id = $${gp.length}`); }
      if (type && employeeNo) {
        // نفس فلتر الموظّف لما ما في نافذة تاريخ
        gp.push(employeeNo); gWhere.push(`payload->>'employeeNo' = $${gp.length}`);
      }
      gp.push(limit);
      q = `SELECT * FROM reports${gWhere.length ? ` WHERE ${gWhere.join(" AND ")}` : ""}
           ORDER BY created_at DESC LIMIT $${gp.length}`;
      params = gp;
    }

    const { rows } = await pool.query(q, params);
    /* الفروع اللي بترجّع payload بتنفلتر هون؛ فرع lite المطبوع فوق انفلتر
       بالـSQL أصلاً، و`scopeRows` بتمرّق صفوفه كما هي لأنها ما بتلاقي payload
       — فما منشيل شي بالغلط. */
    res.json({ ok: true, data: isLite ? rows : stripDrafts(scopeRows(rows, scopeSites)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db select failed" });
  }
});

/** تاريخ عملية التقطيع — نفس أول ثلاث مفاتيح من BUSINESS_DATE. */
const BUTCHER_DATE = `
  COALESCE(
    NULLIF(payload->>'cutDate', ''),
    NULLIF(payload->>'date', ''),
    NULLIF(LEFT(payload->>'reportDate', 10), '')
  )`;

/* ============================================================
   GET /api/reports/butcher-stats?from=YYYY-MM-DD&to=YYYY-MM-DD

   سطر مجمَّع لكل جزار — لشاشة «أدائي» بكرت الجزار (ترتيب داخل ملحمته
   وعلى مستوى كل الملاحم).

   ليش مسار لحاله بدل ما الشاشة تحسب لحالها: القائمة بدها أرقام **كل**
   الجزارين. لو حسبناها بالمتصفّح، كل جزار بيفتح الصفحة بينزّل سجلات كل
   الملاحم بالـpayload كامل (١٫٥ كيلوبايت للعملية) — نفس السحب اللي شلناه
   من هالصفحة بالضبط. هون الحساب بالـSQL جوّا القاعدة، والجواب سطر لكل
   جزار: بضع كيلوبايتات مهما كبر التاريخ.

   الأرقام حقائق فقط — **النتيجة والترتيب بينحسبوا بالواجهة**، حتى تتعدّل
   الأوزان بلا نشرة سيرفر.

   بلا حصر ملاحم عن قصد (بعكس قراءة السجلات): المطلوب مقارنة مع كل
   الجزارين، والراجع مجاميع بلا أي تفصيل عملية.

   قواعد الحساب مطابقة لـnormalizeRecord بالواجهة:
     • الملغى (changeRequest.status = approved) برّا كل رقم.
     • النواتج = أسطر kind=product ، الهدر = الباقي + wasteBoneKg.
     • الأساس = وزن الخام، وإذا مش موجود فمجموع الداخل.
     • المطابقة = العملية اللي كل أسطرها المعيارية ضمن التسامح.
============================================================ */
app.get("/api/reports/butcher-stats", pingBypass, readLimiter, auth, async (req, res) => {
  try {
    const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    const to = isDay(req.query?.to) ? req.query.to : new Date().toISOString().slice(0, 10);
    const from = isDay(req.query?.from)
      ? req.query.from
      : new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10);

    const D = BUTCHER_DATE;
    const N = (e) => `NULLIF(${e}, '')::numeric`;

    // null = بلا حصر شركة (سوبر أدمن بلا اختيار). غير هيك، أرقام كل شركة
    // منفصلة عن التانية — جزار شركة ما بيظهر بترتيب جزارين شركة تانية.
    const companyScope = companyIdOf(req);
    const statsParams = [from, to];
    let companyWhere = "";
    if (companyScope != null) { statsParams.push(companyScope); companyWhere = ` AND r.company_id = $${statsParams.length}`; }

    const sql = `
      WITH ops AS (
        SELECT
          r.id,
          NULLIF(TRIM(r.payload->>'employeeNo'), '')           AS emp,
          COALESCE(NULLIF(r.payload->>'butcherName', ''), '')  AS name,
          COALESCE(NULLIF(r.payload->>'branch', ''), '')       AS branch,
          ${D}                                                 AS day,
          COALESCE(${N("r.payload->>'carcassWeightKg'")}, 0)   AS raw,
          (r.payload->>'stdYieldOn' = 'true')                  AS std_on,
          COALESCE(ABS(${N("r.payload->>'stdTolPct'")}), 0)     AS tol,
          COALESCE(${N("r.payload->>'durationMin'")}, 0)        AS dur,
          r.payload->'cuts'                                    AS cuts
        FROM reports r
        WHERE r.type = 'butcher_cut_log'
          AND COALESCE(r.payload->'changeRequest'->>'status', '') <> 'approved'
          AND ${D} >= $1
          AND ${D} <= $2${companyWhere}
      ),
      sums AS (
        SELECT
          o.id,
          COALESCE(SUM(CASE WHEN COALESCE(c->>'kind', 'product') = 'product'
                            THEN COALESCE(${N("c->>'weightKg'")}, 0) ELSE 0 END), 0) AS products,
          COALESCE(SUM(CASE WHEN COALESCE(c->>'kind', 'product') <> 'product'
                            THEN COALESCE(${N("c->>'weightKg'")}, 0) ELSE 0 END), 0)
          + COALESCE(SUM(COALESCE(${N("c->>'wasteBoneKg'")}, 0)), 0)                 AS waste
        FROM ops o
        LEFT JOIN LATERAL jsonb_array_elements(o.cuts) c ON TRUE
        GROUP BY o.id
      ),
      calc AS (
        SELECT o.*, s.products, s.waste,
               CASE WHEN o.raw > 0 THEN o.raw ELSE s.products + s.waste END AS base
        FROM ops o JOIN sums s USING (id)
      ),
      std AS (
        SELECT
          k.id,
          COUNT(*) FILTER (
            WHERE COALESCE(${N("c->>'stdPct'")}, 0) > 0
              AND COALESCE(${N("c->>'weightKg'")}, 0) > 0
          ) AS lines_checked,
          COUNT(*) FILTER (
            WHERE COALESCE(${N("c->>'stdPct'")}, 0) > 0
              AND COALESCE(${N("c->>'weightKg'")}, 0) > 0
              AND k.base > 0
              AND ABS(COALESCE(${N("c->>'weightKg'")}, 0) / k.base * 100
                      - COALESCE(${N("c->>'stdPct'")}, 0)) > k.tol
          ) AS lines_off
        FROM calc k
        LEFT JOIN LATERAL jsonb_array_elements(k.cuts) c ON TRUE
        GROUP BY k.id
      ),
      per_op AS (
        SELECT k.*, st.lines_checked, st.lines_off,
               CASE WHEN k.base > 0 THEN k.products / k.base * 100 END AS yield_pct,
               (k.std_on AND st.lines_checked > 0)                      AS std_checked,
               (k.std_on AND st.lines_checked > 0 AND st.lines_off = 0) AS std_pass
        FROM calc k JOIN std st USING (id)
      )
      SELECT
        emp                                                        AS "empNo",
        (ARRAY_AGG(name ORDER BY day DESC, id DESC)
           FILTER (WHERE name <> ''))[1]                           AS "name",
        (ARRAY_AGG(branch ORDER BY day DESC, id DESC)
           FILTER (WHERE branch <> ''))[1]                         AS "branch",
        ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(branch, '')), NULL) AS "branches",
        COUNT(*)::int                                              AS "ops",
        ROUND(SUM(raw)::numeric, 3)::float8                        AS "rawKg",
        ROUND(SUM(products)::numeric, 3)::float8                   AS "productsKg",
        ROUND(SUM(waste)::numeric, 3)::float8                      AS "wasteKg",
        ROUND(SUM(base)::numeric, 3)::float8                       AS "baseKg",
        ROUND(AVG(yield_pct)::numeric, 2)::float8                  AS "avgYieldPct",
        ROUND(STDDEV_SAMP(yield_pct)::numeric, 2)::float8          AS "yieldSd",
        COUNT(*) FILTER (WHERE yield_pct IS NOT NULL)::int         AS "yieldOps",
        ROUND(SUM(dur)::numeric, 1)::float8                        AS "durMin",
        COUNT(*) FILTER (WHERE dur > 0)::int                       AS "durOps",
        ROUND(SUM(base) FILTER (WHERE dur > 0)::numeric, 3)::float8 AS "durBaseKg",
        COUNT(*) FILTER (WHERE std_checked)::int                   AS "stdOps",
        COUNT(*) FILTER (WHERE std_pass)::int                      AS "stdPassOps",
        MAX(day)                                                   AS "lastDay"
      FROM per_op
      WHERE emp IS NOT NULL
      GROUP BY emp
      ORDER BY "ops" DESC`;

    const { rows } = await pool.query(sql, statsParams);
    res.json({ ok: true, from, to, data: rows });
  } catch (e) {
    console.error("[butcher-stats]", e);
    res.status(500).json({ ok: false, error: "stats failed" });
  }
});

app.post("/api/reports", auth, async (req, res) => {
  try {
    const reporter = normText(req.body?.reporter || "anonymous");
    const type = normText(req.body?.type);
    const payload = req.body?.payload;

    if (!type) return res.status(400).json({ ok: false, error: "type required" });
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const stamped = await stampRef(pool, type, payload);
    const companyId = companyIdForWrite(req);

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload, company_id)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING *`,
      [reporter, type, JSON.stringify(stamped), companyId]
    );

    auditCreate(req, ins.rows[0]);
    return res.status(201).json({ ok: true, report: ins.rows[0] });
  } catch (e) {
    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_REPORT_FOR_DATE",
        message: "Report already exists for this type and reportDate.",
      });
    }
    console.error("POST /api/reports ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports", auth, async (req, res) => {
  try {
    const reporter = normText(req.body?.reporter || "anonymous");
    const type = normText(req.body?.type);
    const payload0 = req.body?.payload;

    if (!type) return res.status(400).json({ ok: false, error: "type required" });
    if (!payload0 || typeof payload0 !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const reportDate = normText(payload0?.reportDate || "");
    if (!reportDate) {
      return res.status(400).json({ ok: false, error: "payload.reportDate required" });
    }

    const payload = { ...payload0, reportDate };
    const companyId = companyIdForWrite(req);

    const old = await fetchOldByTypeDate(type, reportDate, companyId);

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE($1, reporter),
              payload=${KEEP_REF("$2")},
              updated_at=now()
        WHERE type=$3 AND payload->>'reportDate'=$4 AND company_id=$5
        RETURNING *`,
      [reporter || null, JSON.stringify(payload), type, reportDate, companyId]
    );

    if (upd.rowCount > 0) {
      auditWrite(req, {
        action: "update",
        reportId: upd.rows[0].id,
        reportType: type,
        oldPayload: old?.payload ?? null,
        newPayload: upd.rows[0].payload,
      });
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const stamped = await stampRef(pool, type, payload);

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload, company_id)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING *`,
      [reporter, type, JSON.stringify(stamped), companyId]
    );

    auditCreate(req, ins.rows[0]);
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_REPORT_FOR_DATE",
        message: "Report already exists for this type and reportDate.",
      });
    }
    console.error("PUT /api/reports ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/returns", auth, async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { items = [], _clientSavedAt } = req.body || {};

    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });

    const payload = {
      reportDate,
      items: Array.isArray(items) ? items : [],
      _clientSavedAt: _clientSavedAt || Date.now(),
    };

    const companyId = companyIdForWrite(req);
    const old = await fetchOldByTypeDate("returns", reportDate, companyId);

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE(reporter,'anonymous'),
              payload=${KEEP_REF("$1")},
              updated_at=now()
        WHERE type='returns' AND payload->>'reportDate'=$2 AND company_id=$3
        RETURNING *`,
      [payload, reportDate, companyId]
    );

    if (upd.rowCount > 0) {
      auditWrite(req, {
        action: "update",
        reportId: upd.rows[0].id,
        reportType: "returns",
        oldPayload: old?.payload ?? null,
        newPayload: upd.rows[0].payload,
      });
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload,company_id)
       VALUES ('anonymous','returns',$1::jsonb,$2)
       RETURNING *`,
      [await stampRef(pool, "returns", payload), companyId]
    );

    auditCreate(req, ins.rows[0]);
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/returns ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/qcs", auth, async (req, res) => {
  try {
    const reportDate = String(req.query.reportDate || "");
    const { details = {}, _clientSavedAt } = req.body || {};
    if (!reportDate) return res.status(400).json({ ok: false, error: "reportDate query required" });

    const payload = {
      reportDate,
      details: isObj(details) ? details : {},
      _clientSavedAt: _clientSavedAt || Date.now(),
    };

    const companyId = companyIdForWrite(req);
    const old = await fetchOldByTypeDate("qcs", reportDate, companyId);

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE(reporter,'anonymous'),
              payload=${KEEP_REF("$1")},
              updated_at=now()
        WHERE type='qcs' AND payload->>'reportDate'=$2 AND company_id=$3
        RETURNING *`,
      [payload, reportDate, companyId]
    );
    if (upd.rowCount > 0) {
      auditWrite(req, {
        action: "update",
        reportId: upd.rows[0].id,
        reportType: "qcs",
        oldPayload: old?.payload ?? null,
        newPayload: upd.rows[0].payload,
      });
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const ins = await pool.query(
      `INSERT INTO reports (reporter,type,payload,company_id)
       VALUES ('anonymous','qcs',$1::jsonb,$2)
       RETURNING *`,
      [await stampRef(pool, "qcs", payload), companyId]
    );
    auditCreate(req, ins.rows[0]);
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/qcs ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/:type([A-Za-z_][A-Za-z0-9_-]*)", auth, async (req, res) => {
  try {
    const type = normText(req.params.type);
    if (!type) return res.status(400).json({ ok: false, error: "type param required" });

    let payload = req.body?.payload;
    if (!payload || typeof payload !== "object") {
      payload = { ...(req.body || {}) };
      delete payload.reporter;
      delete payload.type;
      delete payload.payload;
    }

    const reportDate = normText(payload?.reportDate || req.query?.reportDate || "");
    if (!reportDate) {
      return res.status(400).json({
        ok: false,
        error: "reportDate required (payload.reportDate or ?reportDate=)",
      });
    }

    payload.reportDate = reportDate;
    const reporter = normText(req.body?.reporter || "anonymous");
    const companyId = companyIdForWrite(req);

    const old = await fetchOldByTypeDate(type, reportDate, companyId);

    const upd = await pool.query(
      `UPDATE reports
          SET reporter = COALESCE($1, reporter),
              payload=${KEEP_REF("$2")},
              updated_at=now()
        WHERE type=$3 AND payload->>'reportDate'=$4 AND company_id=$5
        RETURNING *`,
      [reporter || null, JSON.stringify(payload), type, reportDate, companyId]
    );

    if (upd.rowCount > 0) {
      auditWrite(req, {
        action: "update",
        reportId: upd.rows[0].id,
        reportType: type,
        oldPayload: old?.payload ?? null,
        newPayload: upd.rows[0].payload,
      });
      return res.json({ ok: true, report: upd.rows[0], method: "update" });
    }

    const stamped = await stampRef(pool, type, payload);

    const ins = await pool.query(
      `INSERT INTO reports (reporter, type, payload, company_id)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING *`,
      [reporter, type, JSON.stringify(stamped), companyId]
    );

    auditCreate(req, ins.rows[0]);
    return res.status(201).json({ ok: true, report: ins.rows[0], method: "insert" });
  } catch (e) {
    console.error("PUT /api/reports/:type ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* ============================================================
   POST /api/reports/backfill-refs?type=returns[&dryRun=1]
   ------------------------------------------------------------
   Gives every pre-existing record of a type a reference number.
   Numbers are handed out in created_at order (oldest first), so
   the sequence matches the order records entered the system.

   Safe to re-run: records that already carry a refNo are skipped
   and do not consume a number. `dryRun=1` reports exactly what
   would be written without touching anything.
============================================================ */
app.post("/api/reports/backfill-refs", auth, async (req, res) => {
  const type = normText(req.query?.type || req.body?.type || "");
  const truthy = (v) => ["1", "true", "yes"].includes(String(v || "").toLowerCase());
  const dryRun = truthy(req.query?.dryRun ?? req.body?.dryRun);

  if (!type) return res.status(400).json({ ok: false, error: "type required" });
  if (!REF_PREFIX[type]) {
    return res.status(400).json({
      ok: false,
      error: "TYPE_NOT_REF_TRACKED",
      message: `'${type}' has no reference prefix. Known: ${Object.keys(REF_PREFIX).join(", ")}`,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the counter row first so a concurrent save can't interleave.
    await client.query(
      `INSERT INTO report_counters (type, last) VALUES ($1, 0)
       ON CONFLICT (type) DO NOTHING`,
      [type]
    );
    await client.query(`SELECT last FROM report_counters WHERE type=$1 FOR UPDATE`, [type]);

    const { rows } = await client.query(
      `SELECT id,
              created_at,
              payload->>'reportDate' AS "reportDate",
              payload->>'refNo'      AS "refNo"
         FROM reports
        WHERE type = $1
        ORDER BY created_at ASC, id ASC`,
      [type]
    );

    const pending = rows.filter((r) => !r.refNo);
    const assigned = [];

    for (const row of pending) {
      const refNo = await allocRef(client, type);
      assigned.push({ id: row.id, reportDate: row.reportDate, refNo });

      if (!dryRun) {
        await client.query(
          `UPDATE reports
              SET payload = payload || jsonb_build_object('refNo', $1::text),
                  updated_at = now()
            WHERE id = $2`,
          [refNo, row.id]
        );
      }
    }

    if (dryRun) await client.query("ROLLBACK");
    else await client.query("COMMIT");

    return res.json({
      ok: true,
      type,
      dryRun,
      total: rows.length,
      alreadyHadRef: rows.length - pending.length,
      assigned: assigned.length,
      preview: assigned.slice(0, 200),
    });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("POST /api/reports/backfill-refs ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  } finally {
    client.release();
  }
});

/* ============================================================
   POST /api/reports/migrate-base64
   ------------------------------------------------------------
   Gets the embedded files out of stored payloads. Runs
   server-side on purpose: doing this from the browser would mean
   downloading the 125 MB it is trying to remove.

   mode=migrate (default) uploads each blob to Cloudinary and puts
   the URL in its place, so the photo survives and the payload
   shrinks from ~90 KB to ~90 bytes.
   mode=strip throws the blob away instead.

   Works in batches — the caller repeats until `more` is false.

   Deliberately does NOT write to report_audit: that trail keeps
   old and new payloads, so logging this would copy every blob
   straight back into another table.
============================================================ */
app.post("/api/reports/migrate-base64", authStrict, async (req, res) => {
  const truthy = (v) => ["1", "true", "yes"].includes(String(v || "").toLowerCase());
  const dryRun = truthy(req.query?.dryRun ?? req.body?.dryRun);
  const type = normText(req.query?.type || req.body?.type || "");
  const strip = String(req.query?.mode || req.body?.mode || "migrate").toLowerCase() === "strip";
  // Uploads dominate the runtime, so batches are small by default — a
  // request that tries to move 200 files at once will hit a proxy timeout.
  const batch = clampInt(req.query?.limit ?? req.body?.limit, 10, 1, 100);

  const DATA_URI = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)?;base64,/i;
  const isBlob = (v) => typeof v === "string" && v.length >= 2048 && DATA_URI.test(v);

  /* Rewrites a payload, replacing each blob with whatever `swap` returns.
     Async because migrating means awaiting an upload per blob. */
  async function transform(value, swap, depth = 0) {
    if (depth > 12) return value;
    if (isBlob(value)) return swap(value);
    if (Array.isArray(value)) {
      const out = [];
      for (const v of value) out.push(await transform(v, swap, depth + 1));
      return out;
    }
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = await transform(v, swap, depth + 1);
      return out;
    }
    return value;
  }

  try {
    if (!strip) {
      const cfg = cloudinary.config();
      const missing = ["cloud_name", "api_key", "api_secret"].filter((k) => !cfg[k]);
      if (missing.length) {
        return res.status(500).json({ ok: false, error: "CLOUDINARY_CONFIG_MISSING", missing });
      }
    }

    // LIKE on the cast text is a sequential scan, but Postgres stops as soon
    // as it has filled the LIMIT, so a run with work left to do is cheap.
    // Asking for one extra row is how we learn whether to come back.
    const where = type
      ? `type = $1 AND payload::text LIKE '%;base64,%'`
      : `payload::text LIKE '%;base64,%'`;
    const params = type ? [type, batch + 1] : [batch + 1];

    const { rows } = await pool.query(
      `SELECT id, type, payload FROM reports
        WHERE ${where}
        ORDER BY id ASC
        LIMIT $${params.length}`,
      params
    );

    const more = rows.length > batch;
    const work = rows.slice(0, batch);

    const byType = {};
    const failures = [];
    let handled = 0;
    let bytes = 0;
    let skipped = 0;

    const bucket = (t) =>
      (byType[t] = byType[t] || { rows: 0, blobs: 0, bytes: 0, failed: 0 });

    for (const row of work) {
      let count = 0;
      let size = 0;
      let failed = null;

      const cleaned = await transform(row.payload, async (blob) => {
        if (failed) return blob; // already giving up on this row
        size += blob.length;
        count++;
        if (strip) return "";
        try {
          const up = await cloudinary.uploader.upload(blob, {
            folder: `${process.env.CLOUDINARY_FOLDER || "qcs"}/migrated/${row.type}`,
            transformation: [{ width: 1280, height: 1280, crop: "limit", quality: "80" }],
          });
          return up.secure_url;
        } catch (e) {
          failed = e?.message || String(e);
          return blob;
        }
      });

      // A row is all-or-nothing: a half-migrated payload would leave the
      // record pointing at some photos and still carrying others, and a
      // retry could not tell the two apart.
      if (failed) {
        bucket(row.type).failed++;
        failures.push({ id: row.id, type: row.type, error: failed });
        continue;
      }

      // The LIKE matched somewhere the walker did not — a data: URI under
      // the 2 KB floor, or text that merely contains the marker. Leave it
      // alone, but report it, otherwise the caller loops on it forever.
      if (!count) {
        skipped++;
        continue;
      }

      handled += count;
      bytes += size;
      const b = bucket(row.type);
      b.rows++;
      b.blobs += count;
      b.bytes += size;

      if (!dryRun) {
        await pool.query(
          `UPDATE reports SET payload = $1::jsonb, updated_at = now() WHERE id = $2`,
          [JSON.stringify(cleaned), row.id]
        );
      }
    }

    console.log(
      `[migrate-base64] ${dryRun ? "DRY RUN " : ""}${strip ? "strip" : "migrate"}: ` +
        `${work.length} rows, ${handled} blobs, ${bytes} bytes, ` +
        `${failures.length} failed, ${skipped} skipped, more=${more}`
    );

    return res.json({
      ok: true,
      mode: strip ? "strip" : "migrate",
      dryRun,
      type: type || null,
      scanned: work.length,
      rowsChanged: work.length - failures.length - skipped,
      blobsHandled: handled,
      bytesFreed: bytes,
      skipped,
      failures,
      byType,
      // A dry run changes nothing, so the same rows match again next call —
      // reporting `more` would send the caller into an endless loop. Rows that
      // failed also still match, so stop rather than spin on them.
      more: dryRun ? false : more && failures.length === 0,
    });
  } catch (e) {
    console.error("POST /api/reports/migrate-base64 ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/reports/:id(\\d+)", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "bad id" });
    }

    const q = await pool.query(`SELECT * FROM reports WHERE id=$1`, [id]);
    if (!q.rowCount) return res.status(404).json({ ok: false, error: "not found" });
    // سجل موجود بس تابع لشركة تانية = "مش موجود" بالنسبة لصاحب الطلب —
    // ما منفرّق بين الحالتين حتى ما نأكّد وجود سجل هو أصلاً ما إلوش صلاحية يشوفه.
    if (companyMismatch(companyIdOf(req), q.rows[0].company_id)) {
      return res.status(404).json({ ok: false, error: "not found" });
    }

    return res.json({ ok: true, report: q.rows[0] });
  } catch (e) {
    console.error("GET /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.patch("/api/reports/:id(\\d+)", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: "bad id" });

    const payload = req.body?.payload;
    const reporter = req.body?.reporter;

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const old = await fetchOldById(id);
    if (old && companyMismatch(companyIdOf(req), old.company_id)) {
      return res.status(404).json({ ok: false, error: "not found" });
    }
    // سجل موجود = بيحمل شركته الحقيقية أصلاً (فحصناها فوق)؛ استخدامها هون بدل
    // إعادة اشتقاق النطاق بيضمن التحديث يلاقي نفس الصف حتى لو سوبر أدمن بلا
    // نطاق محدد كان عم يعدّل تقرير شركة تانية.
    const companyForFilter = old ? old.company_id : companyIdForWrite(req);

    const upd = await pool.query(
      `UPDATE reports
          SET payload=${KEEP_REF("$1")},
              reporter=COALESCE($2, reporter),
              updated_at=now()
        WHERE id=$3 AND company_id=$4
        RETURNING *`,
      [JSON.stringify(payload), reporter ? String(reporter) : null, id, companyForFilter]
    );

    if (!upd.rowCount) return res.status(404).json({ ok: false, error: "not found" });
    auditWrite(req, {
      action: "update",
      reportId: id,
      reportType: upd.rows[0].type,
      oldPayload: old?.payload ?? null,
      newPayload: upd.rows[0].payload,
    });
    return res.json({ ok: true, report: upd.rows[0] });
  } catch (e) {
    console.error("PATCH /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.put("/api/reports/:id(\\d+)", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "bad id" });
    }

    const type = normText(req.body?.type);
    const payload = req.body?.payload;

    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ ok: false, error: "payload object required" });
    }

    const old = await fetchOldById(id);
    if (old && companyMismatch(companyIdOf(req), old.company_id)) {
      return res.status(404).json({ ok: false, error: "not found" });
    }
    const companyForFilter = old ? old.company_id : companyIdForWrite(req);

    const upd = await pool.query(
      `UPDATE reports
          SET type = COALESCE(NULLIF($1,''), type),
              payload=${KEEP_REF("$2")},
              updated_at=now()
        WHERE id=$3 AND company_id=$4
        RETURNING *`,
      [type || null, JSON.stringify(payload), id, companyForFilter]
    );

    if (!upd.rowCount) return res.status(404).json({ ok: false, error: "not found" });
    auditWrite(req, {
      action: "update",
      reportId: id,
      reportType: upd.rows[0].type,
      oldPayload: old?.payload ?? null,
      newPayload: upd.rows[0].payload,
    });
    return res.json({ ok: true, report: upd.rows[0] });
  } catch (e) {
    if (e && e.code === "23505") {
      return res.status(409).json({
        ok: false,
        error: "DUPLICATE_REPORT_FOR_DATE",
        message: "Report already exists for this type and reportDate.",
      });
    }
    console.error("PUT /api/reports/:id ERROR =", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/api/reports", auth, async (req, res) => {
  try {
    const { type, reportDate } = req.query;
    if (!type || !reportDate) return res.status(400).json({ ok: false, error: "type & reportDate required" });

    const del = await pool.query(
      `DELETE FROM reports WHERE type=$1 AND payload->>'reportDate'=$2 AND company_id=$3 RETURNING id, type, payload`,
      [type, reportDate, companyIdForWrite(req)]
    );
    del.rows.forEach((row) =>
      auditWrite(req, {
        action: "delete",
        reportId: row.id,
        reportType: row.type,
        oldPayload: row.payload,
        newPayload: null,
      })
    );
    res.json({ ok: true, deleted: del.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.delete("/api/reports/:id(\\d+)", auth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const old = await fetchOldById(id);
    if (old && companyMismatch(companyIdOf(req), old.company_id)) {
      return res.status(404).json({ ok: false, error: "not found" });
    }
    const companyForFilter = old ? old.company_id : companyIdForWrite(req);

    const del = await pool.query(
      `DELETE FROM reports WHERE id=$1 AND company_id=$2 RETURNING id, type, payload`,
      [id, companyForFilter]
    );
    if (!del.rowCount) return res.status(404).json({ ok: false, error: "not found" });
    auditWrite(req, {
      action: "delete",
      reportId: del.rows[0].id,
      reportType: del.rows[0].type,
      oldPayload: del.rows[0].payload,
      newPayload: null,
    });
    res.json({ ok: true, deleted: del.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
};
