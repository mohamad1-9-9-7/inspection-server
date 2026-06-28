module.exports = function registerAdminRoutes(app, deps = {}) {
  const { pool, clampInt, normText, rlCheck, rlReset, genSalt, hashPw, verifyPw } = deps;

/* --------- Auth: verify role password --------- */
app.post("/api/auth/verify-role", (req, res) => {
  const { roleId, password } = req.body || {};

  if (!roleId || typeof password !== "string") {
    return res.status(400).json({ success: false, error: "Missing roleId or password" });
  }

  let passwords;
  try {
    passwords = JSON.parse(process.env.ROLE_PASSWORDS_JSON || "{}");
  } catch {
    return res.status(500).json({ success: false, error: "Server config error" });
  }

  const expected = passwords[roleId] ?? passwords["default"];

  if (expected === undefined) {
    // Role not configured server-side — defer to client-side auth silently
    return res.json({ success: true });
  }

  if (password === expected) {
    return res.json({ success: true });
  }

  // تأخير 500ms لمنع brute-force
  setTimeout(() => {
    res.status(401).json({ success: false, error: "Wrong password" });
  }, 500);
});

/* ============================================================
   Reports summary — one query returns count + latest per type.
   Used by the KPI dashboard so it doesn't have to fan out N fetches.
============================================================ */
app.get("/api/reports/summary", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        type,
        COUNT(*)::int                                      AS count,
        MAX(COALESCE(
          NULLIF(payload->>'reportDate', ''),
          to_char(created_at AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD')
        ))                                                 AS latest_date,
        MAX(created_at)                                    AS last_created_at
      FROM reports
      GROUP BY type
      ORDER BY count DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error("reports/summary error:", e);
    res.status(500).json({ ok: false, error: "summary_failed" });
  }
});

/* ============================================================
   Presence / Visitor Analytics
   - POST /api/presence/ping  body:{ visitorId }  → { ok:true }
   - POST /api/presence/bye   body:{ visitorId }  → { ok:true }
   - GET  /api/presence/stats → { online, todayVisits, totalVisits }
   Online window = 60 seconds. Daily date uses Asia/Dubai timezone.
============================================================ */
const PRESENCE_ONLINE_SECONDS = 60;

app.post("/api/presence/ping", async (req, res) => {
  const visitorId = String(req.body?.visitorId || "").slice(0, 128);
  if (!visitorId) return res.status(400).json({ ok: false, error: "missingVisitorId" });

  try {
    await pool.query(
      `INSERT INTO presence (visitor_id, last_seen)
       VALUES ($1, now())
       ON CONFLICT (visitor_id) DO UPDATE SET last_seen = EXCLUDED.last_seen`,
      [visitorId]
    );
    await pool.query(
      `INSERT INTO daily_visits (day, visitor_id)
       VALUES ((now() AT TIME ZONE 'Asia/Dubai')::date, $1)
       ON CONFLICT DO NOTHING`,
      [visitorId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("presence/ping error:", e);
    res.status(500).json({ ok: false, error: "presence_ping_failed" });
  }
});

app.post("/api/presence/bye", async (req, res) => {
  const visitorId = String(req.body?.visitorId || "").slice(0, 128);
  if (!visitorId) return res.json({ ok: true });
  try {
    await pool.query(`DELETE FROM presence WHERE visitor_id = $1`, [visitorId]);
  } catch (e) {
    console.error("presence/bye error:", e);
  }
  res.json({ ok: true });
});

app.get("/api/presence/stats", async (_req, res) => {
  try {
    const online = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM presence
        WHERE last_seen > now() - ($1 || ' seconds')::interval`,
      [String(PRESENCE_ONLINE_SECONDS)]
    );
    const today = await pool.query(
      `SELECT COUNT(*)::int AS c
         FROM daily_visits
        WHERE day = (now() AT TIME ZONE 'Asia/Dubai')::date`
    );
    const total = await pool.query(`SELECT COUNT(*)::int AS c FROM daily_visits`);
    res.json({
      online:       online.rows[0]?.c || 0,
      todayVisits:  today.rows[0]?.c  || 0,
      totalVisits:  total.rows[0]?.c  || 0,
    });
  } catch (e) {
    console.error("presence/stats error:", e);
    res.status(500).json({ ok: false, error: "presence_stats_failed" });
  }
});

/* ============================================================
   AUTH — Named Account Login / Logout
============================================================ */

/* POST /api/auth/login  { username, password } */
app.post("/api/auth/login", async (req, res) => {
  try {
    const ip       = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const username = normText(req.body?.username);
    const password = normText(req.body?.password);

    /* ── Rate limiting ── */
    if (!rlCheck(ip)) {
      return res.status(429).json({
        ok: false,
        error: "too_many_attempts",
        message: "Too many login attempts. Please wait 1 minute.",
      });
    }

    if (!username || !password)
      return res.status(400).json({ ok: false, error: "username and password required" });

    const q = await pool.query(
      `SELECT id, username, display_name, password_hash, salt,
              permissions, crud_perms, employees, allowed_branches, is_active, is_admin, is_super_admin, last_login,
              company_id
         FROM app_users WHERE username = $1 LIMIT 1`,
      [username]
    );
    /* Helper: log a failed login attempt for the security monitor */
    const logFailed = async (reason) => {
      try {
        await pool.query(
          `INSERT INTO activity_log (user_id, username, action, detail, ip_addr)
           VALUES ($1, $2, 'login_failed', $3::jsonb, $4)`,
          [null, username, JSON.stringify({ reason }), ip]
        );
      } catch { /* don't break login on logging error */ }
    };

    if (!q.rowCount) {
      await logFailed("unknown_user");
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    const user = q.rows[0];

    if (!user.is_active) {
      await logFailed("account_disabled");
      return res.status(403).json({ ok: false, error: "account_disabled" });
    }

    if (!verifyPw(password, user.salt, user.password_hash)) {
      await logFailed("wrong_password");
      return res.status(401).json({ ok: false, error: "invalid_credentials" });
    }

    /* ── On success: reset rate limit + auto-upgrade legacy HMAC hash → scrypt ── */
    rlReset(ip);
    if (!user.salt.startsWith(SCRYPT_PFX)) {
      const newSalt = genSalt();
      const newHash = hashPw(password, newSalt);
      await pool.query(
        `UPDATE app_users SET password_hash=$1, salt=$2 WHERE id=$3`,
        [newHash, newSalt, user.id]
      ).catch(() => {}); // non-fatal
    }

    /* ── Multi-tenant: resolve the user's company (NULL = platform/super-admin) ── */
    let company = null;
    if (user.company_id) {
      const cq = await pool.query(
        `SELECT c.id, c.name, c.status, c.start_date, c.end_date,
                p.name AS plan_name, p.max_branches, p.max_users
           FROM companies c
           LEFT JOIN plans p ON p.id = c.plan_id
          WHERE c.id = $1 LIMIT 1`,
        [user.company_id]
      );
      company = cq.rows[0] || null;
    }

    /* Block login if the user's company subscription has lapsed (super-admins bypass).
       Company "expired"/"suspended", or end_date in the past, denies access. */
    if (!user.is_super_admin && company) {
      const lapsed =
        company.status === "expired" ||
        company.status === "suspended" ||
        (company.end_date && new Date(company.end_date) < new Date(new Date().toDateString()));
      if (lapsed) {
        await logFailed("company_subscription_lapsed");
        return res.status(403).json({
          ok: false,
          error: "subscription_lapsed",
          company: { name: company.name, status: company.status, end_date: company.end_date },
        });
      }
    }

    /* Update last_login */
    await pool.query(`UPDATE app_users SET last_login=now() WHERE id=$1`, [user.id]);

    /* Log activity */
    await pool.query(
      `INSERT INTO activity_log (user_id, username, action, detail, ip_addr)
       VALUES ($1, $2, 'login', $3::jsonb, $4)`,
      [user.id, user.username, JSON.stringify({ displayName: user.display_name }), ip]
    );

    res.json({
      ok: true,
      user: {
        id:              user.id,
        username:        user.username,
        displayName:     user.display_name,
        permissions:     user.permissions,        // array of role IDs or ["*"]
        crudPerms:       user.crud_perms,         // { sectionId: ["view","write","edit","delete"] }
        employees:       user.employees,          // ["Name1", "Name2", ...]
        allowedBranches: user.allowed_branches || [], // [] = all, [...] = restricted
        isAdmin:         user.is_admin,
        isSuperAdmin:    user.is_super_admin,
        lastLogin:       user.last_login,
        companyId:       user.company_id || null,  // NULL = platform-level (super-admin)
        company:         company ? {               // resolved company snapshot (null for platform users)
          id:        company.id,
          name:      company.name,
          status:    company.status,
          startDate: company.start_date,
          endDate:   company.end_date,
          planName:  company.plan_name || null,
          maxBranches: company.max_branches ?? -1,
          maxUsers:    company.max_users ?? -1,
        } : null,
      },
    });
  } catch (e) {
    console.error("POST /api/auth/login ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* POST /api/auth/logout  { username } */
app.post("/api/auth/logout", async (req, res) => {
  try {
    const username = normText(req.body?.username);
    if (username) {
      const u = await pool.query(`SELECT id FROM app_users WHERE username=$1 LIMIT 1`, [username]);
      const uid = u.rows[0]?.id || null;
      const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
      await pool.query(
        `INSERT INTO activity_log (user_id, username, action, ip_addr)
         VALUES ($1, $2, 'logout', $3)`,
        [uid, username, ip]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("POST /api/auth/logout ERROR:", e);
    res.json({ ok: true }); // always succeed
  }
});

/* ============================================================
   APP USERS — CRUD (admin only — validated client-side via isAdmin flag)
============================================================ */

/* GET /api/app-users */
app.get("/api/app-users", async (req, res) => {
  try {
    /* Multi-tenant scoping: ?company_id=N restricts to that company.
       Super-admin UI omits it to see everyone. */
    const companyId = req.query.company_id ? parseInt(req.query.company_id) : null;
    const params = [];
    let where = "";
    if (companyId) { params.push(companyId); where = `WHERE u.company_id = $1`; }

    const q = await pool.query(
      `SELECT u.id, u.username, u.display_name, u.permissions, u.crud_perms, u.employees, u.allowed_branches,
              u.is_active, u.is_admin, u.is_super_admin, u.created_at, u.last_login,
              u.company_id, c.name AS company_name
         FROM app_users u
         LEFT JOIN companies c ON c.id = u.company_id
         ${where}
         ORDER BY u.created_at ASC`,
      params
    );
    res.json({ ok: true, users: q.rows });
  } catch (e) {
    console.error("GET /api/app-users ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* POST /api/app-users  { username, displayName, password, permissions, crudPerms, employees, isAdmin } */
app.post("/api/app-users", async (req, res) => {
  try {
    const username       = normText(req.body?.username);
    const displayName    = normText(req.body?.displayName || req.body?.display_name || username);
    const password       = normText(req.body?.password);
    const permissions    = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    const crudPerms      = (req.body?.crudPerms && typeof req.body.crudPerms === "object") ? req.body.crudPerms : {};
    const employees      = Array.isArray(req.body?.employees) ? req.body.employees : [];
    /* Accept either array (legacy) OR object { sectionId: [items...] } (new per-section format) */
    const _ab = req.body?.allowedBranches;
    const allowedBranches = (_ab && typeof _ab === "object") ? _ab : [];
    const isAdmin        = !!req.body?.isAdmin;
    /* Multi-tenant: which company this account belongs to (NULL = platform-level). */
    const companyId      = req.body?.companyId != null ? parseInt(req.body.companyId) : null;

    if (!username || !password)
      return res.status(400).json({ ok: false, error: "username and password required" });

    const salt = genSalt();
    const hash = hashPw(password, salt);

    const q = await pool.query(
      `INSERT INTO app_users (username, display_name, password_hash, salt, permissions, crud_perms, employees, allowed_branches, is_admin, company_id)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10)
       RETURNING id, username, display_name, permissions, crud_perms, employees, allowed_branches, is_active, is_admin, created_at, company_id`,
      [username, displayName, hash, salt,
       JSON.stringify(permissions), JSON.stringify(crudPerms), JSON.stringify(employees),
       JSON.stringify(allowedBranches), isAdmin, Number.isFinite(companyId) ? companyId : null]
    );

    res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    if (e.code === "23505")
      return res.status(409).json({ ok: false, error: "username_taken" });
    console.error("POST /api/app-users ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* PUT /api/app-users/:id  { displayName?, password?, permissions?, isAdmin?, isActive? } */
app.put("/api/app-users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const sets = [];
    const vals = [];
    let idx = 1;

    if (req.body?.displayName !== undefined) {
      sets.push(`display_name=$${idx++}`);
      vals.push(normText(req.body.displayName));
    }
    if (req.body?.password) {
      const salt = genSalt();
      const hash = hashPw(normText(req.body.password), salt);
      sets.push(`password_hash=$${idx++}`, `salt=$${idx++}`);
      vals.push(hash, salt);
    }
    if (req.body?.permissions !== undefined) {
      sets.push(`permissions=$${idx++}::jsonb`);
      vals.push(JSON.stringify(Array.isArray(req.body.permissions) ? req.body.permissions : []));
    }
    if (req.body?.crudPerms !== undefined) {
      sets.push(`crud_perms=$${idx++}::jsonb`);
      vals.push(JSON.stringify(typeof req.body.crudPerms === "object" ? req.body.crudPerms : {}));
    }
    if (req.body?.employees !== undefined) {
      sets.push(`employees=$${idx++}::jsonb`);
      vals.push(JSON.stringify(Array.isArray(req.body.employees) ? req.body.employees : []));
    }
    if (req.body?.isAdmin !== undefined) {
      sets.push(`is_admin=$${idx++}`);
      vals.push(!!req.body.isAdmin);
    }
    if (req.body?.isActive !== undefined) {
      sets.push(`is_active=$${idx++}`);
      vals.push(!!req.body.isActive);
    }
    if (req.body?.allowedBranches !== undefined) {
      /* Accept either array (legacy) OR object { sectionId: [items...] } */
      const _ab = req.body.allowedBranches;
      sets.push(`allowed_branches=$${idx++}::jsonb`);
      vals.push(JSON.stringify((_ab && typeof _ab === "object") ? _ab : []));
    }
    if (req.body?.companyId !== undefined) {
      /* Multi-tenant: reassign account to a company (null = platform-level). */
      const cid = req.body.companyId != null ? parseInt(req.body.companyId) : null;
      sets.push(`company_id=$${idx++}`);
      vals.push(Number.isFinite(cid) ? cid : null);
    }

    if (!sets.length)
      return res.status(400).json({ ok: false, error: "nothing to update" });

    vals.push(id);
    const q = await pool.query(
      `UPDATE app_users SET ${sets.join(",")} WHERE id=$${idx}
       RETURNING id, username, display_name, permissions, crud_perms, employees, allowed_branches, is_active, is_admin, created_at, last_login, company_id`,
      vals
    );
    if (!q.rowCount)
      return res.status(404).json({ ok: false, error: "user_not_found" });

    res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error("PUT /api/app-users/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* DELETE /api/app-users/:id */
app.delete("/api/app-users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const q = await pool.query(`DELETE FROM app_users WHERE id=$1 RETURNING username`, [id]);
    if (!q.rowCount)
      return res.status(404).json({ ok: false, error: "user_not_found" });
    res.json({ ok: true, deleted: q.rows[0].username });
  } catch (e) {
    console.error("DELETE /api/app-users/:id ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* GET /api/activity-log?limit=50&username=xxx */
app.get("/api/activity-log", async (req, res) => {
  try {
    const limit = clampInt(req.query?.limit, 100, 1, 500);
    const usernameFilter = normText(req.query?.username || "");

    let q;
    if (usernameFilter) {
      q = await pool.query(
        `SELECT id, user_id, username, action, detail, ip_addr, created_at
           FROM activity_log WHERE username=$1
           ORDER BY created_at DESC LIMIT $2`,
        [usernameFilter, limit]
      );
    } else {
      q = await pool.query(
        `SELECT id, user_id, username, action, detail, ip_addr, created_at
           FROM activity_log ORDER BY created_at DESC LIMIT $1`,
        [limit]
      );
    }
    res.json({ ok: true, logs: q.rows });
  } catch (e) {
    console.error("GET /api/activity-log ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ─── Failed Logins Monitor — security audit ─── */
/* Returns the last N failed login attempts + per-IP aggregation for the past hour. */
app.get("/api/security/failed-logins", async (req, res) => {
  try {
    const limit = clampInt(req.query?.limit, 50, 1, 200);
    const recent = await pool.query(
      `SELECT id, username, detail, ip_addr, created_at
         FROM activity_log
        WHERE action='login_failed'
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    /* Aggregate per IP over the last hour to detect brute force */
    const byIp = await pool.query(
      `SELECT ip_addr, COUNT(*)::int AS attempts,
              MAX(created_at) AS last_at,
              ARRAY_AGG(DISTINCT username ORDER BY username) FILTER (WHERE username IS NOT NULL) AS usernames
         FROM activity_log
        WHERE action='login_failed' AND created_at > now() - INTERVAL '1 hour'
        GROUP BY ip_addr
        HAVING COUNT(*) >= 1
        ORDER BY attempts DESC
        LIMIT 50`
    );
    res.json({
      ok: true,
      recent: recent.rows,
      byIpLastHour: byIp.rows,
    });
  } catch (e) {
    console.error("GET /api/security/failed-logins ERROR:", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});
};
