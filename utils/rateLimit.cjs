const _loginAttempts = new Map();
const RATE_MAX = 10;
const RATE_WIN_MS = 60_000;

function rlCheck(ip) {
  const now = Date.now();
  let rec = _loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + RATE_WIN_MS };
    _loginAttempts.set(ip, rec);
  }
  rec.count++;
  return rec.count <= RATE_MAX;
}

function rlReset(ip) {
  _loginAttempts.delete(ip);
}

/* Per-ACCOUNT failure throttle. The per-IP bucket above keys on the first
   X-Forwarded-For hop, which the caller writes — a script rotating that
   header gets unlimited guesses at one password. This one keys on the
   username instead, so it holds whatever the header says: 8 wrong
   passwords lock that account's logins for 15 minutes. Only failures count,
   and a successful login clears it, so staff typing slowly are unaffected. */
const _userFails = new Map();
const USER_FAIL_MAX = 8;
const USER_FAIL_WIN_MS = 15 * 60_000;

function userLocked(username) {
  const rec = _userFails.get(String(username || "").toLowerCase());
  if (!rec) return 0;
  if (Date.now() > rec.resetAt) { _userFails.delete(String(username).toLowerCase()); return 0; }
  return rec.count >= USER_FAIL_MAX ? Math.ceil((rec.resetAt - Date.now()) / 1000) : 0;
}
function userFailed(username) {
  const k = String(username || "").toLowerCase();
  if (!k) return;
  const now = Date.now();
  let rec = _userFails.get(k);
  if (!rec || now > rec.resetAt) rec = { count: 0, resetAt: now + USER_FAIL_WIN_MS };
  rec.count += 1;
  _userFails.set(k, rec);
}
function userReset(username) {
  _userFails.delete(String(username || "").toLowerCase());
}

const _loginSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _loginAttempts) {
    if (now > rec.resetAt) _loginAttempts.delete(ip);
  }
  for (const [k, rec] of _userFails) {
    if (now > rec.resetAt) _userFails.delete(k);
  }
}, 5 * 60_000);
if (typeof _loginSweep.unref === "function") _loginSweep.unref();

/* ============================================================
   Generic per-IP limiter factory

   `rlCheck` above is the login-specific bucket and stays as-is.
   Everything else (public token endpoints, uploads, report reads)
   gets its own isolated bucket via makeLimiter so one noisy caller
   can never lock a user out of an unrelated route.

   Behind Render the socket address is the load balancer, so the
   real client is the first hop of X-Forwarded-For.
============================================================ */
function clientIp(req) {
  const xf = String(req.headers?.["x-forwarded-for"] || "");
  if (xf) return xf.split(",")[0].trim();
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function makeLimiter({ max = 60, windowMs = 60_000, name = "rl" } = {}) {
  const buckets = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of buckets) {
      if (now > rec.resetAt) buckets.delete(ip);
    }
  }, 5 * 60_000);
  // Never keep the process alive just for the sweep.
  if (typeof sweep.unref === "function") sweep.unref();

  return function limiter(req, res, next) {
    const ip = clientIp(req);
    const now = Date.now();

    let rec = buckets.get(ip);
    if (!rec || now > rec.resetAt) {
      rec = { count: 0, resetAt: now + windowMs };
      buckets.set(ip, rec);
    }
    rec.count++;

    if (rec.count > max) {
      const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      // Logged once per window per IP so a scraper can't flood the log either.
      if (rec.count === max + 1) {
        console.warn(`[${name}] rate limit hit by ${ip} — ${req.method} ${req.originalUrl}`);
      }
      return res.status(429).json({ ok: false, error: "rate_limited", retryAfter });
    }

    next();
  };
}

module.exports = {
  rlCheck,
  rlReset,
  userLocked,
  userFailed,
  userReset,
  makeLimiter,
  clientIp,
};
