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

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _loginAttempts) {
    if (now > rec.resetAt) _loginAttempts.delete(ip);
  }
}, 5 * 60_000);

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
  makeLimiter,
  clientIp,
};
