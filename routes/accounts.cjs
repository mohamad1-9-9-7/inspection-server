/* ============================================================
   ACCOUNTS CENTRE + PERMISSIONS CENTRE
   ------------------------------------------------------------
   These routes used to live at the bottom of routes/admin.cjs as four
   thin CRUD handlers. They are moved here unchanged in URL and
   response shape, and given what a real account centre needs:

     · a role gate — the old handlers only checked that SOME token was
       present, so any logged-in user could POST themselves an account
       with `isAdmin: true`
     · company scoping — a company admin listing users no longer sees
       (or edits) another company's staff
     · validation — username format, password policy, permission
       vocabulary, all answered by the server so every screen agrees
     · seat enforcement against the company's package
     · the safety rails: you cannot delete yourself, demote yourself,
       or remove the last super-admin
     · an audit line for every change

   The permissions centre gets a real catalog endpoint, so the screen
   renders from the server's vocabulary instead of a list hard-coded in
   the client that drifted out of date.
============================================================ */

const perms = require("../utils/permissions.cjs");

module.exports = function registerAccountsRoutes(app, deps = {}) {
  const { pool, clampInt, normText, genSalt, hashPw, requireAdmin } = deps;

  const noGate = (_req, _res, next) => next();
  const admin = typeof requireAdmin === "function" ? requireAdmin : noGate;

  /* ── Rules the UI asks for up front, so both sides validate alike ── */
  const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
  const RESERVED_USERNAMES = ["system", "root", "null", "undefined", "none", "me"];
  const PASSWORD_MIN = 8;
  const MAX_PAGE = 500;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /* Columns every account response returns. Never includes password_hash
     or salt — one SELECT * on this table would leak both. */
  const USER_COLS = `
    u.id, u.username, u.display_name, u.email, u.phone, u.job_title, u.notes,
    u.permissions, u.crud_perms, u.employees, u.allowed_branches,
    u.role_template, u.is_active, u.is_admin, u.is_super_admin,
    u.must_change_password, u.password_changed_at,
    u.created_at, u.updated_at, u.created_by, u.last_login, u.company_id
  `;

  /* ============================================================
     Helpers
  ============================================================ */

  const actor = (req) => ({
    id: req.user?.uid || null,
    username: req.user?.username || "system",
    isSuperAdmin: !!req.user?.isSuperAdmin,
    /* No token at all happens only in the AUTH_SECRET-unset fallback
       (see utils/requireAuth.cjs). Treat it as platform-level so the
       dashboard keeps working on a box that has not been configured. */
    isPlatform: !req.user || !!req.user?.isSuperAdmin,
    companyId: req.user?.companyId ?? null,
  });

  /** The company a caller is confined to, or null for platform-level. */
  function scopeCompany(req) {
    const a = actor(req);
    if (a.isPlatform) return null;
    return a.companyId ?? null;
  }

  const ip = (req) =>
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";

  /** Audit line. Fire-and-forget: a logging failure must not fail the write. */
  async function logAction(req, action, detail) {
    const a = actor(req);
    try {
      await pool.query(
        `INSERT INTO activity_log (user_id, username, action, detail, ip_addr)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [a.id, a.username, action, JSON.stringify(detail || {}), ip(req)]
      );
    } catch (e) {
      console.warn(`[accounts] activity_log write failed for ${action}:`, e.message);
    }
  }

  function validateUsername(name) {
    if (!name) return "username_required";
    if (!USERNAME_RE.test(name)) return "username_invalid";
    if (RESERVED_USERNAMES.includes(name.toLowerCase())) return "username_reserved";
    return null;
  }

  /** Returns the list of rules the password fails, empty when it passes. */
  function passwordProblems(pw) {
    const out = [];
    const s = String(pw ?? "");
    if (s.length < PASSWORD_MIN) out.push("too_short");
    if (!/[A-Za-z]/.test(s)) out.push("needs_letter");
    if (!/[0-9]/.test(s)) out.push("needs_digit");
    if (/^\s|\s$/.test(s)) out.push("padded_with_space");
    return out;
  }

  /** Readable temporary password: no 0/O/1/l, so it survives a phone call. */
  function generatePassword() {
    const letters = "abcdefghjkmnpqrstuvwxyz";
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    const digits = "23456789";
    const pick = (set, n) =>
      Array.from({ length: n }, () => set[Math.floor(Math.random() * set.length)]).join("");
    return `${pick(upper, 1)}${pick(letters, 5)}${pick(digits, 3)}`;
  }

  /** Distinct report types, so the permission catalog covers what exists. */
  async function discoveredSections() {
    try {
      const q = await pool.query(`SELECT DISTINCT type FROM reports WHERE type IS NOT NULL`);
      return q.rows.map((r) => r.type);
    } catch {
      return [];
    }
  }

  /* The section ids a permission save is checked against. Cached: the write
     paths would otherwise run a DISTINCT over the reports table on every
     save, and a report type appearing five minutes late costs nothing —
     unknown ids are stored either way, they are only reported back. */
  let knownCache = { at: 0, ids: null };
  const KNOWN_TTL_MS = 5 * 60 * 1000;

  async function knownSectionIds() {
    if (knownCache.ids && Date.now() - knownCache.at < KNOWN_TTL_MS) return knownCache.ids;
    const catalog = perms.buildCatalog(await discoveredSections());
    knownCache = { at: Date.now(), ids: new Set(catalog.sections.map((s) => s.id)) };
    return knownCache.ids;
  }

  /** Seats: active accounts against the company's package limit. */
  async function seatUsage(companyId) {
    if (!companyId) return null;
    const q = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM app_users WHERE company_id = $1 AND is_active) AS used,
         p.max_users, p.name AS plan_name, c.name AS company_name
       FROM companies c
       LEFT JOIN plans p ON p.id = c.plan_id
       WHERE c.id = $1`,
      [companyId]
    );
    if (!q.rowCount) return null;
    const row = q.rows[0];
    const max = row.max_users == null ? -1 : Number(row.max_users);
    return {
      companyId,
      companyName: row.company_name,
      planName: row.plan_name || null,
      used: row.used,
      max,
      unlimited: max < 0,
      remaining: max < 0 ? null : Math.max(0, max - row.used),
      full: max >= 0 && row.used >= max,
    };
  }

  /** Load a target account, honouring the caller's company scope. */
  async function loadUser(req, id) {
    if (!UUID_RE.test(String(id || ""))) return null;
    const scope = scopeCompany(req);
    const params = [id];
    let where = `u.id = $1`;
    if (scope != null) { params.push(scope); where += ` AND u.company_id = $2`; }

    const q = await pool.query(
      `SELECT ${USER_COLS}, c.name AS company_name
         FROM app_users u
         LEFT JOIN companies c ON c.id = u.company_id
        WHERE ${where} LIMIT 1`,
      params
    );
    return q.rows[0] || null;
  }

  /** How many active super-admins are left besides this one. */
  async function otherActiveSuperAdmins(excludeId) {
    const q = await pool.query(
      `SELECT COUNT(*)::int AS c FROM app_users
        WHERE is_super_admin AND is_active AND id <> $1`,
      [excludeId]
    );
    return q.rows[0]?.c ?? 0;
  }

  /** Shape one row for the client: raw columns plus the derived answers. */
  function shapeUser(row) {
    if (!row) return null;
    const eff = perms.effectivePermissions(row);
    return {
      ...row,
      /* camelCase mirror — the account screens read these, the older
         screens keep reading the snake_case columns above. */
      displayName: row.display_name,
      isActive: row.is_active,
      isAdmin: row.is_admin,
      isSuperAdmin: row.is_super_admin,
      crudPerms: row.crud_perms,
      allowedBranches: row.allowed_branches,
      companyId: row.company_id,
      companyName: row.company_name ?? null,
      roleTemplate: row.role_template || null,
      mustChangePassword: !!row.must_change_password,
      lastLogin: row.last_login,
      effective: {
        fullAccess: eff.fullAccess,
        sectionCount: eff.sectionCount,
        role: eff.isSuperAdmin ? "super_admin" : eff.isAdmin ? "admin" : "user",
      },
    };
  }

  /* ============================================================
     GET /api/accounts/policy — the rules, so the form can show them
  ============================================================ */
  app.get("/api/accounts/policy", admin, (_req, res) => {
    res.json({
      ok: true,
      policy: {
        username: {
          pattern: USERNAME_RE.source,
          minLength: 3,
          maxLength: 32,
          reserved: RESERVED_USERNAMES,
          hint: { en: "Letters, numbers, dot, dash or underscore.", ar: "أحرف وأرقام ونقطة أو شرطة." },
        },
        password: {
          minLength: PASSWORD_MIN,
          requires: ["letter", "digit"],
          hint: {
            en: `At least ${PASSWORD_MIN} characters, with a letter and a number.`,
            ar: `${PASSWORD_MIN} خانات على الأقل وتحتوي حرفاً ورقماً.`,
          },
        },
      },
    });
  });

  /* ============================================================
     GET /api/permissions/catalog — what the permissions centre renders
  ============================================================ */
  app.get("/api/permissions/catalog", admin, async (_req, res) => {
    try {
      const catalog = perms.buildCatalog(await discoveredSections());
      res.json({ ok: true, catalog });
    } catch (e) {
      console.error("GET /api/permissions/catalog ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* GET /api/permissions/templates/:id — the concrete map a preset expands to,
     so the screen can preview it before anybody clicks save. */
  app.get("/api/permissions/templates/:id", admin, async (req, res) => {
    try {
      const catalog = perms.buildCatalog(await discoveredSections());
      const reportIds = catalog.sections.filter((s) => s.group === "reports").map((s) => s.id);
      const expanded = perms.expandTemplate(req.params.id, reportIds);
      if (!expanded) return res.status(404).json({ ok: false, error: "template_not_found" });
      res.json({
        ok: true,
        template: {
          id: expanded.template.id,
          label: expanded.template.label,
          description: expanded.template.description,
          isAdmin: expanded.isAdmin,
        },
        crudPerms: expanded.crudPerms,
      });
    } catch (e) {
      console.error("GET /api/permissions/templates/:id ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ============================================================
     GET /api/accounts/overview — the accounts centre header
  ============================================================ */
  app.get("/api/accounts/overview", admin, async (req, res) => {
    try {
      const scope = scopeCompany(req);
      const requested = req.query.company_id ? parseInt(req.query.company_id, 10) : null;
      const companyId = scope != null ? scope : Number.isFinite(requested) ? requested : null;

      const params = [];
      let where = "";
      if (companyId != null) { params.push(companyId); where = `WHERE company_id = $1`; }

      const totals = await pool.query(
        `SELECT
           COUNT(*)::int                                              AS total,
           COUNT(*) FILTER (WHERE is_active)::int                     AS active,
           COUNT(*) FILTER (WHERE NOT is_active)::int                 AS inactive,
           COUNT(*) FILTER (WHERE is_admin OR is_super_admin)::int    AS admins,
           COUNT(*) FILTER (WHERE is_super_admin)::int                AS super_admins,
           COUNT(*) FILTER (WHERE last_login IS NULL)::int            AS never_logged_in,
           COUNT(*) FILTER (WHERE last_login > now() - INTERVAL '30 days')::int AS active_last_30d,
           COUNT(*) FILTER (WHERE crud_perms = '{}'::jsonb
                              AND permissions = '[]'::jsonb
                              AND NOT is_admin AND NOT is_super_admin)::int AS without_permissions
         FROM app_users ${where}`,
        params
      );

      const byCompany = companyId != null ? { rows: [] } : await pool.query(
        `SELECT c.id, c.name,
                COUNT(u.id)::int                         AS users,
                COUNT(u.id) FILTER (WHERE u.is_active)::int AS active_users,
                p.max_users
           FROM companies c
           LEFT JOIN app_users u ON u.company_id = c.id
           LEFT JOIN plans p     ON p.id = c.plan_id
          GROUP BY c.id, c.name, p.max_users
          ORDER BY c.name ASC`
      );

      res.json({
        ok: true,
        overview: {
          scopeCompanyId: companyId,
          totals: totals.rows[0],
          seats: await seatUsage(companyId),
          byCompany: byCompany.rows.map((r) => {
            const max = r.max_users == null ? -1 : Number(r.max_users);
            return {
              id: r.id, name: r.name, users: r.users, activeUsers: r.active_users,
              maxUsers: max, unlimited: max < 0,
              remaining: max < 0 ? null : Math.max(0, max - r.active_users),
            };
          }),
        },
      });
    } catch (e) {
      console.error("GET /api/accounts/overview ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ============================================================
     GET /api/app-users — searchable, paged, company-scoped
  ============================================================ */
  app.get("/api/app-users", admin, async (req, res) => {
    try {
      const scope = scopeCompany(req);
      const requested = req.query.company_id ? parseInt(req.query.company_id, 10) : null;
      /* A company admin is pinned to their own company whatever they ask for. */
      const companyId = scope != null ? scope : Number.isFinite(requested) ? requested : null;

      const q = normText(req.query.q || "");
      const status = normText(req.query.status || "").toLowerCase();
      const role = normText(req.query.role || "").toLowerCase();
      /* Both clamped to integers here, so interpolating them into the LIMIT
         clause carries no injection risk — and it keeps one parameter list
         valid for both the page query and the COUNT beside it. */
      const limit = clampInt(req.query.limit, 200, 1, MAX_PAGE);
      const offset = clampInt(req.query.offset, 0, 0, 1_000_000);

      const params = [];
      const where = [];
      const add = (sql, val) => { params.push(val); where.push(sql.replace("?", `$${params.length}`)); };

      if (companyId != null) add(`u.company_id = ?`, companyId);
      if (q) {
        /* One parameter, three columns — the search box matches the login
           name, the person's name, or their address. */
        params.push(`%${q}%`);
        const n = `$${params.length}`;
        where.push(`(u.username ILIKE ${n} OR u.display_name ILIKE ${n} OR u.email ILIKE ${n})`);
      }
      if (status === "active") where.push(`u.is_active`);
      if (status === "inactive") where.push(`NOT u.is_active`);
      if (role === "admin") where.push(`(u.is_admin OR u.is_super_admin)`);
      if (role === "super_admin") where.push(`u.is_super_admin`);
      if (role === "user") where.push(`NOT u.is_admin AND NOT u.is_super_admin`);

      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

      const rows = await pool.query(
        `SELECT ${USER_COLS}, c.name AS company_name
           FROM app_users u
           LEFT JOIN companies c ON c.id = u.company_id
           ${whereSql}
          ORDER BY u.created_at ASC
          LIMIT ${limit} OFFSET ${offset}`,
        params
      );
      const totalQ = await pool.query(
        `SELECT COUNT(*)::int AS c FROM app_users u ${whereSql}`,
        params
      );

      res.json({
        ok: true,
        users: rows.rows.map(shapeUser),
        total: totalQ.rows[0]?.c ?? rows.rowCount,
        limit,
        offset,
        seats: await seatUsage(companyId),
      });
    } catch (e) {
      console.error("GET /api/app-users ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* GET /api/app-users/:id */
  app.get("/api/app-users/:id", admin, async (req, res) => {
    try {
      const user = await loadUser(req, req.params.id);
      if (!user) return res.status(404).json({ ok: false, error: "user_not_found" });
      res.json({ ok: true, user: shapeUser(user) });
    } catch (e) {
      console.error("GET /api/app-users/:id ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ============================================================
     POST /api/app-users — create
  ============================================================ */
  app.post("/api/app-users", admin, async (req, res) => {
    try {
      const a = actor(req);
      const username = normText(req.body?.username).toLowerCase();
      const displayName = normText(req.body?.displayName || req.body?.display_name || username);
      const password = String(req.body?.password ?? "");

      const badName = validateUsername(username);
      if (badName) return res.status(400).json({ ok: false, error: badName });

      const pwProblems = passwordProblems(password);
      if (pwProblems.length)
        return res.status(400).json({ ok: false, error: "weak_password", problems: pwProblems, minLength: PASSWORD_MIN });

      /* Privilege rules: only a super-admin can mint another super-admin,
         and only a super-admin can place an account outside a company. */
      const wantsSuper = !!req.body?.isSuperAdmin;
      if (wantsSuper && !a.isPlatform)
        return res.status(403).json({ ok: false, error: "super_admin_only" });

      const scope = scopeCompany(req);
      const requested = req.body?.companyId != null ? parseInt(req.body.companyId, 10) : null;
      const companyId = scope != null ? scope : Number.isFinite(requested) ? requested : null;
      if (companyId == null && !a.isPlatform)
        return res.status(403).json({ ok: false, error: "company_required" });

      /* Seats — the package decides how many accounts a company may run. */
      const seats = await seatUsage(companyId);
      if (seats && seats.full && !a.isPlatform) {
        return res.status(409).json({
          ok: false,
          error: "seat_limit_reached",
          seats,
          message: {
            en: `The ${seats.planName || "current"} package allows ${seats.max} active accounts.`,
            ar: `باقة ${seats.planName || "الشركة"} تسمح بـ ${seats.max} حساباً نشطاً فقط.`,
          },
        });
      }

      const { crudPerms, unknownSections } = perms.normalizeCrudPerms(req.body?.crudPerms, await knownSectionIds());
      const permissions = perms.normalizePermissions(req.body?.permissions);
      const employees = perms.normalizeEmployees(req.body?.employees);
      const allowedBranches = perms.normalizeAllowedBranches(req.body?.allowedBranches);

      const salt = genSalt();
      const hash = hashPw(password, salt);

      const q = await pool.query(
        `INSERT INTO app_users (
           username, display_name, email, phone, job_title, notes,
           password_hash, salt, permissions, crud_perms, employees, allowed_branches,
           role_template, is_admin, is_super_admin, is_active, must_change_password,
           password_changed_at, created_by, company_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,
           $13,$14,$15,$16,$17, now(), $18, $19
         )
         RETURNING ${USER_COLS.replace(/u\./g, "")}`,
        [
          username, displayName,
          normText(req.body?.email), normText(req.body?.phone),
          normText(req.body?.jobTitle || req.body?.job_title), normText(req.body?.notes),
          hash, salt,
          JSON.stringify(permissions), JSON.stringify(crudPerms),
          JSON.stringify(employees), JSON.stringify(allowedBranches),
          normText(req.body?.roleTemplate) || null,
          !!req.body?.isAdmin || wantsSuper,
          wantsSuper,
          req.body?.isActive !== false,
          req.body?.mustChangePassword !== false, /* new accounts rotate by default */
          a.username,
          companyId,
        ]
      );

      await logAction(req, "account_created", {
        targetId: q.rows[0].id, username, companyId,
        isAdmin: q.rows[0].is_admin, isSuperAdmin: q.rows[0].is_super_admin,
      });

      res.json({ ok: true, user: shapeUser(q.rows[0]), warnings: unknownSections.length ? { unknownSections } : undefined });
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ ok: false, error: "username_taken" });
      if (e.code === "23503") return res.status(400).json({ ok: false, error: "company_not_found" });
      console.error("POST /api/app-users ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ============================================================
     PUT /api/app-users/:id — update (partial)
  ============================================================ */
  app.put("/api/app-users/:id", admin, async (req, res) => {
    try {
      const a = actor(req);
      const target = await loadUser(req, req.params.id);
      if (!target) return res.status(404).json({ ok: false, error: "user_not_found" });

      if (target.is_super_admin && !a.isPlatform)
        return res.status(403).json({ ok: false, error: "super_admin_only" });

      const isSelf = a.id && String(a.id) === String(target.id);

      /* Columns are collected here and the SQL is built once at the end.
         `isSuperAdmin: true` also implies is_admin and the body may carry
         isAdmin as well; assigning one column twice in a single UPDATE is a
         Postgres error, so the map keeps the last value per column and the
         parameter list never ends up with an orphan. */
      const fields = new Map();   // column → { cast, value }
      const changed = [];
      const push = (sql, val, field) => {
        const [col, rhs] = sql.split("=");
        const cast = rhs.replace("?", "");          // "" or "::jsonb"
        if (!fields.has(col)) changed.push(field);
        fields.set(col, { cast, value: val });
      };

      const b = req.body || {};
      let touchedPasswordAt = false;

      if (b.displayName !== undefined || b.display_name !== undefined)
        push(`display_name=?`, normText(b.displayName ?? b.display_name), "displayName");
      if (b.email !== undefined) push(`email=?`, normText(b.email), "email");
      if (b.phone !== undefined) push(`phone=?`, normText(b.phone), "phone");
      if (b.jobTitle !== undefined || b.job_title !== undefined)
        push(`job_title=?`, normText(b.jobTitle ?? b.job_title), "jobTitle");
      if (b.notes !== undefined) push(`notes=?`, normText(b.notes), "notes");
      if (b.roleTemplate !== undefined) push(`role_template=?`, normText(b.roleTemplate) || null, "roleTemplate");

      if (b.password) {
        const problems = passwordProblems(b.password);
        if (problems.length)
          return res.status(400).json({ ok: false, error: "weak_password", problems, minLength: PASSWORD_MIN });
        const salt = genSalt();
        push(`password_hash=?`, hashPw(String(b.password), salt), "password");
        push(`salt=?`, salt, "salt");
        touchedPasswordAt = true;
      }
      if (b.mustChangePassword !== undefined)
        push(`must_change_password=?`, !!b.mustChangePassword, "mustChangePassword");

      if (b.permissions !== undefined)
        push(`permissions=?::jsonb`, JSON.stringify(perms.normalizePermissions(b.permissions)), "permissions");

      let unknownSections = [];
      if (b.crudPerms !== undefined) {
        const norm = perms.normalizeCrudPerms(b.crudPerms, await knownSectionIds());
        unknownSections = norm.unknownSections;
        push(`crud_perms=?::jsonb`, JSON.stringify(norm.crudPerms), "crudPerms");
      }
      if (b.employees !== undefined)
        push(`employees=?::jsonb`, JSON.stringify(perms.normalizeEmployees(b.employees)), "employees");
      if (b.allowedBranches !== undefined)
        push(`allowed_branches=?::jsonb`, JSON.stringify(perms.normalizeAllowedBranches(b.allowedBranches)), "allowedBranches");

      /* ── The rails ── */
      if (b.isAdmin !== undefined) {
        if (isSelf && !b.isAdmin)
          return res.status(409).json({ ok: false, error: "cannot_demote_self" });
        push(`is_admin=?`, !!b.isAdmin || !!target.is_super_admin, "isAdmin");
      }

      if (b.isSuperAdmin !== undefined) {
        if (!a.isPlatform) return res.status(403).json({ ok: false, error: "super_admin_only" });
        if (!b.isSuperAdmin && target.is_super_admin && !(await otherActiveSuperAdmins(target.id)))
          return res.status(409).json({ ok: false, error: "last_super_admin" });
        push(`is_super_admin=?`, !!b.isSuperAdmin, "isSuperAdmin");
        if (b.isSuperAdmin) push(`is_admin=?`, true, "isAdmin");
      }

      if (b.isActive !== undefined) {
        if (isSelf && !b.isActive)
          return res.status(409).json({ ok: false, error: "cannot_disable_self" });
        if (!b.isActive && target.is_super_admin && !(await otherActiveSuperAdmins(target.id)))
          return res.status(409).json({ ok: false, error: "last_super_admin" });
        /* Re-activating consumes a seat, so it is checked like a create. */
        if (b.isActive && !target.is_active) {
          const seats = await seatUsage(target.company_id);
          if (seats && seats.full && !a.isPlatform)
            return res.status(409).json({ ok: false, error: "seat_limit_reached", seats });
        }
        push(`is_active=?`, !!b.isActive, "isActive");
      }

      if (b.companyId !== undefined) {
        if (!a.isPlatform) return res.status(403).json({ ok: false, error: "super_admin_only" });
        const cid = b.companyId != null ? parseInt(b.companyId, 10) : null;
        push(`company_id=?`, Number.isFinite(cid) ? cid : null, "companyId");
      }

      if (!fields.size) return res.status(400).json({ ok: false, error: "nothing_to_update" });

      const vals = [];
      const sets = [];
      for (const [col, { cast, value }] of fields) {
        vals.push(value);
        sets.push(`${col}=$${vals.length}${cast}`);
      }
      if (touchedPasswordAt) sets.push(`password_changed_at=now()`);
      sets.push(`updated_at=now()`);
      vals.push(target.id);

      const q = await pool.query(
        `UPDATE app_users SET ${sets.join(",")} WHERE id=$${vals.length}
         RETURNING ${USER_COLS.replace(/u\./g, "")}`,
        vals
      );

      await logAction(req, "account_updated", {
        targetId: target.id,
        username: target.username,
        /* Field names only — never the new password or the salt. */
        fields: changed.filter((f) => f !== "salt"),
      });

      res.json({
        ok: true,
        user: shapeUser(q.rows[0]),
        warnings: unknownSections.length ? { unknownSections } : undefined,
      });
    } catch (e) {
      if (e.code === "23503") return res.status(400).json({ ok: false, error: "company_not_found" });
      console.error("PUT /api/app-users/:id ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* PATCH /api/app-users/:id/status — the enable/disable switch */
  app.patch("/api/app-users/:id/status", admin, async (req, res) => {
    try {
      const a = actor(req);
      const target = await loadUser(req, req.params.id);
      if (!target) return res.status(404).json({ ok: false, error: "user_not_found" });

      if (target.is_super_admin && !a.isPlatform)
        return res.status(403).json({ ok: false, error: "super_admin_only" });

      const next = req.body?.isActive !== undefined ? !!req.body.isActive : !target.is_active;
      if (a.id && String(a.id) === String(target.id) && !next)
        return res.status(409).json({ ok: false, error: "cannot_disable_self" });
      if (!next && target.is_super_admin && !(await otherActiveSuperAdmins(target.id)))
        return res.status(409).json({ ok: false, error: "last_super_admin" });
      if (next && !target.is_active) {
        const seats = await seatUsage(target.company_id);
        if (seats && seats.full && !a.isPlatform)
          return res.status(409).json({ ok: false, error: "seat_limit_reached", seats });
      }

      const q = await pool.query(
        `UPDATE app_users SET is_active=$1, updated_at=now() WHERE id=$2
         RETURNING ${USER_COLS.replace(/u\./g, "")}`,
        [next, target.id]
      );
      await logAction(req, next ? "account_enabled" : "account_disabled", {
        targetId: target.id, username: target.username,
      });
      res.json({ ok: true, user: shapeUser(q.rows[0]) });
    } catch (e) {
      console.error("PATCH /api/app-users/:id/status ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* POST /api/app-users/:id/reset-password  { password? , mustChange? }
     With no password the server generates one and returns it ONCE — it is
     never stored in readable form and never appears in the audit line. */
  app.post("/api/app-users/:id/reset-password", admin, async (req, res) => {
    try {
      const target = await loadUser(req, req.params.id);
      if (!target) return res.status(404).json({ ok: false, error: "user_not_found" });
      if (target.is_super_admin && !actor(req).isPlatform)
        return res.status(403).json({ ok: false, error: "super_admin_only" });

      const generated = !req.body?.password;
      const password = generated ? generatePassword() : String(req.body.password);
      if (!generated) {
        const problems = passwordProblems(password);
        if (problems.length)
          return res.status(400).json({ ok: false, error: "weak_password", problems, minLength: PASSWORD_MIN });
      }

      const salt = genSalt();
      await pool.query(
        `UPDATE app_users
            SET password_hash=$1, salt=$2, password_changed_at=now(),
                must_change_password=$3, updated_at=now()
          WHERE id=$4`,
        [hashPw(password, salt), salt, req.body?.mustChange !== false, target.id]
      );

      await logAction(req, "account_password_reset", {
        targetId: target.id, username: target.username, generated,
      });

      res.json({
        ok: true,
        username: target.username,
        /* Only echoed back when the server made it up. */
        temporaryPassword: generated ? password : undefined,
      });
    } catch (e) {
      console.error("POST /api/app-users/:id/reset-password ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ============================================================
     DELETE /api/app-users/:id
  ============================================================ */
  app.delete("/api/app-users/:id", admin, async (req, res) => {
    try {
      const a = actor(req);
      const target = await loadUser(req, req.params.id);
      if (!target) return res.status(404).json({ ok: false, error: "user_not_found" });

      if (a.id && String(a.id) === String(target.id))
        return res.status(409).json({ ok: false, error: "cannot_delete_self" });
      if (target.is_super_admin && !a.isPlatform)
        return res.status(403).json({ ok: false, error: "super_admin_only" });
      if (target.is_super_admin && !(await otherActiveSuperAdmins(target.id)))
        return res.status(409).json({ ok: false, error: "last_super_admin" });

      await pool.query(`DELETE FROM app_users WHERE id=$1`, [target.id]);
      await logAction(req, "account_deleted", {
        targetId: target.id, username: target.username, companyId: target.company_id,
      });
      res.json({ ok: true, deleted: target.username });
    } catch (e) {
      console.error("DELETE /api/app-users/:id ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* ============================================================
     PERMISSIONS CENTRE — write paths
  ============================================================ */

  /* PUT /api/app-users/:id/permissions
     { template? , crudPerms? , permissions? , allowedBranches? , employees? , mode? }
     mode "merge" adds to what the account already has; "replace" (default)
     saves exactly what was sent. */
  app.put("/api/app-users/:id/permissions", admin, async (req, res) => {
    try {
      const target = await loadUser(req, req.params.id);
      if (!target) return res.status(404).json({ ok: false, error: "user_not_found" });

      const b = req.body || {};
      const mode = String(b.mode || "replace").toLowerCase() === "merge" ? "merge" : "replace";

      let crudPerms = null;
      let templateId = null;
      let makeAdmin = null;

      if (b.template) {
        const catalog = perms.buildCatalog(await discoveredSections());
        const reportIds = catalog.sections.filter((s) => s.group === "reports").map((s) => s.id);
        const expanded = perms.expandTemplate(String(b.template), reportIds);
        if (!expanded) return res.status(400).json({ ok: false, error: "template_not_found" });
        crudPerms = expanded.crudPerms;
        templateId = expanded.template.id;
        makeAdmin = expanded.isAdmin;
      }

      let unknownSections = [];
      if (b.crudPerms !== undefined) {
        const norm = perms.normalizeCrudPerms(b.crudPerms, await knownSectionIds());
        unknownSections = norm.unknownSections;
        /* An explicit map sent alongside a template wins — the screen shows
           the template expanded and lets the admin tick a box off before saving. */
        crudPerms = norm.crudPerms;
      }
      if (crudPerms == null)
        return res.status(400).json({ ok: false, error: "crudPerms_or_template_required" });

      if (mode === "merge") {
        const current = perms.normalizeCrudPerms(target.crud_perms).crudPerms;
        const merged = { ...current };
        for (const [section, actions] of Object.entries(crudPerms)) {
          merged[section] = perms.normalizeActions([...(merged[section] || []), ...actions]);
        }
        crudPerms = merged;
      }

      const sets = [`crud_perms=$1::jsonb`, `updated_at=now()`];
      const vals = [JSON.stringify(crudPerms)];
      const add = (sql, val) => { vals.push(val); sets.push(sql.replace("?", `$${vals.length}`)); };

      if (b.permissions !== undefined)
        add(`permissions=?::jsonb`, JSON.stringify(perms.normalizePermissions(b.permissions)));
      if (b.allowedBranches !== undefined)
        add(`allowed_branches=?::jsonb`, JSON.stringify(perms.normalizeAllowedBranches(b.allowedBranches)));
      if (b.employees !== undefined)
        add(`employees=?::jsonb`, JSON.stringify(perms.normalizeEmployees(b.employees)));
      if (templateId) add(`role_template=?`, templateId);
      /* A template that implies admin only ever grants it — never silently
         strips the flag from an account that was made admin by hand. */
      if (makeAdmin === true && !target.is_admin) add(`is_admin=?`, true);

      vals.push(target.id);
      const q = await pool.query(
        `UPDATE app_users SET ${sets.join(",")} WHERE id=$${vals.length}
         RETURNING ${USER_COLS.replace(/u\./g, "")}`,
        vals
      );

      await logAction(req, "permissions_updated", {
        targetId: target.id, username: target.username, mode, template: templateId,
        sections: Object.keys(crudPerms).length,
      });

      res.json({
        ok: true,
        user: shapeUser(q.rows[0]),
        warnings: unknownSections.length ? { unknownSections } : undefined,
      });
    } catch (e) {
      console.error("PUT /api/app-users/:id/permissions ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });

  /* POST /api/permissions/bulk  { userIds:[], template? , crudPerms? , mode? }
     One template onto a whole shift, instead of opening twelve accounts. */
  app.post("/api/permissions/bulk", admin, async (req, res) => {
    try {
      const ids = (Array.isArray(req.body?.userIds) ? req.body.userIds : [])
        .map((x) => String(x || ""))
        .filter((x) => UUID_RE.test(x));
      if (!ids.length) return res.status(400).json({ ok: false, error: "userIds_required" });
      if (ids.length > 200) return res.status(400).json({ ok: false, error: "too_many_users" });

      const mode = String(req.body?.mode || "replace").toLowerCase() === "merge" ? "merge" : "replace";

      let crudPerms = null;
      let templateId = null;
      if (req.body?.template) {
        const catalog = perms.buildCatalog(await discoveredSections());
        const reportIds = catalog.sections.filter((s) => s.group === "reports").map((s) => s.id);
        const expanded = perms.expandTemplate(String(req.body.template), reportIds);
        if (!expanded) return res.status(400).json({ ok: false, error: "template_not_found" });
        crudPerms = expanded.crudPerms;
        templateId = expanded.template.id;
      } else if (req.body?.crudPerms !== undefined) {
        crudPerms = perms.normalizeCrudPerms(req.body.crudPerms).crudPerms;
      }
      if (!crudPerms) return res.status(400).json({ ok: false, error: "crudPerms_or_template_required" });

      const scope = scopeCompany(req);
      const updated = [];
      const skipped = [];

      for (const id of ids) {
        const target = await loadUser(req, id);
        /* Out of scope, or gone — reported rather than silently ignored. */
        if (!target) { skipped.push({ id, reason: scope != null ? "out_of_scope" : "not_found" }); continue; }

        let next = crudPerms;
        if (mode === "merge") {
          const current = perms.normalizeCrudPerms(target.crud_perms).crudPerms;
          next = { ...current };
          for (const [section, actions] of Object.entries(crudPerms)) {
            next[section] = perms.normalizeActions([...(next[section] || []), ...actions]);
          }
        }

        await pool.query(
          `UPDATE app_users SET crud_perms=$1::jsonb, role_template=COALESCE($2, role_template),
                                updated_at=now()
            WHERE id=$3`,
          [JSON.stringify(next), templateId, target.id]
        );
        updated.push({ id: target.id, username: target.username });
      }

      await logAction(req, "permissions_bulk_applied", {
        mode, template: templateId, updated: updated.length, skipped: skipped.length,
      });

      res.json({ ok: true, updated, skipped, mode, template: templateId });
    } catch (e) {
      console.error("POST /api/permissions/bulk ERROR:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  });
};
