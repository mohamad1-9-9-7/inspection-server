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

module.exports = function makeCutScope(pool) {
  /* كاش لكل شركة: كان سجل واحد لكل المنصّة (آخر workforce_config انحفظ من أي
     شركة)، فلو شركة تانية حفظت قواها العاملة، جزارين المواشي بيطلعوا «مش
     موجودين» وبينشال الحصر عنهم. هلق كل شركة بتقرأ سجلها هي. */
  const wfCache = new Map(); // companyId → { at, people }

  async function workforcePeople(companyId) {
    const hit = wfCache.get(companyId);
    if (hit && Date.now() - hit.at < WF_TTL_MS) return hit.people;
    let people = [];
    try {
      const { rows } = await pool.query(
        `SELECT payload FROM reports
           WHERE type = $1 AND company_id = $2
           ORDER BY updated_at DESC NULLS LAST, created_at DESC
           LIMIT 1`,
        [WF_TYPE, companyId]
      );
      people = Array.isArray(rows?.[0]?.payload?.people) ? rows[0].payload.people : [];
    } catch (e) {
      /* السجل مش موجود أو القراءة فشلت → بلا حصر. الفشل هون ما بيجوز يقفل
         شاشة على حدا؛ الحصر ميزة فوق، مش شرط تشغيل. */
      console.warn("[cut-scope] workforce_config read failed:", e?.message || e);
    }
    wfCache.set(companyId, { at: Date.now(), people });
    return people;
  }

  /** أكواد ملاحم صاحب الطلب، أو null = بلا حصر. */
  return async function cutScopeSites(req, type) {
    if (type !== "butcher_cut_log") return null;

    const u = req.user;
    if (!u || u.isAdmin) return null;

    const key = String(u.username || "").trim().toLowerCase();
    if (!key) return null;

    // حساب الشركة دايمًا عنده companyId بالتوكن؛ بلا شركة = بلا حصر.
    const companyId = Number(u.companyId);
    if (!(Number.isFinite(companyId) && companyId > 0)) return null;

    const people = await workforcePeople(companyId);
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
  };
};
