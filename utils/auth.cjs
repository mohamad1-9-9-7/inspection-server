const crypto = require("crypto");

// Sliding session TTL — matches the frontend's existing default session length
// (App.jsx getSessionMaxMs()), so a token issued at login stays valid as long
// as the user keeps interacting with the app.
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function extractToken(req) {
  const h = String(req.headers["authorization"] || "");
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : "";
}

async function createSession(pool, userId) {
  const token = makeToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
  return token;
}

async function destroySession(pool, token) {
  if (!token) return;
  await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
}

// requireAuth: validates the bearer token against a live DB row (session +
// app_users) on every request — never trusts anything the client claims
// about its own permissions — and attaches the fresh result as req.user.
function requireAuth(pool) {
  return async (req, res, next) => {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ ok: false, error: "auth_required" });
    }
    try {
      const q = await pool.query(
        `SELECT s.expires_at,
                u.id, u.username, u.display_name, u.permissions, u.crud_perms,
                u.employees, u.allowed_branches, u.is_active, u.is_admin,
                u.is_super_admin, u.company_id
           FROM sessions s
           JOIN app_users u ON u.id = s.user_id
          WHERE s.token = $1
          LIMIT 1`,
        [token]
      );
      const row = q.rows[0];
      if (!row || !row.is_active || new Date(row.expires_at) < new Date()) {
        return res.status(401).json({ ok: false, error: "invalid_session" });
      }

      req.user = {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        permissions: row.permissions,
        crudPerms: row.crud_perms,
        employees: row.employees,
        allowedBranches: row.allowed_branches,
        isAdmin: row.is_admin,
        isSuperAdmin: row.is_super_admin,
        companyId: row.company_id,
      };

      // Sliding expiry — extend in the background, don't block the request on it.
      const newExpiresAt = new Date(Date.now() + SESSION_TTL_MS);
      pool.query(`UPDATE sessions SET expires_at = $1 WHERE token = $2`, [newExpiresAt, token]).catch(() => {});

      next();
    } catch (e) {
      console.error("requireAuth error:", e);
      res.status(500).json({ ok: false, error: "auth_check_failed" });
    }
  };
}

function requireAdmin(pool) {
  const auth = requireAuth(pool);
  return (req, res, next) => {
    auth(req, res, () => {
      if (!req.user?.isAdmin) {
        return res.status(403).json({ ok: false, error: "admin_required" });
      }
      next();
    });
  };
}

module.exports = {
  createSession,
  destroySession,
  requireAuth,
  requireAdmin,
};
