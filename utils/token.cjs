const crypto = require("crypto");

/* ============================================================
   Stateless session tokens (mini-JWT, HS256)

   Signed with AUTH_SECRET using the built-in `crypto` module — no
   external dependency, and verification is pure CPU (no DB hit), so
   it never wakes Neon out of autosuspend.

   Format:  base64url(header) . base64url(payload) . base64url(hmac)
   Payload always carries `exp` (unix seconds). Anything past `exp`
   is rejected.
============================================================ */

const SECRET = process.env.AUTH_SECRET || "";
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

if (!SECRET) {
  console.warn(
    "[token] AUTH_SECRET is not set — session tokens will NOT be issued. " +
      "Set AUTH_SECRET in the environment to enable auth."
  );
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlToBuf(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

function hmac(data) {
  return b64url(crypto.createHmac("sha256", SECRET).update(data).digest());
}

/**
 * Sign a payload into a token string. Returns "" if AUTH_SECRET is unset
 * (caller should treat that as "no token issued", not an error).
 */
function signToken(payload = {}, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!SECRET) return "";
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds })
  );
  const sig = hmac(`${header}.${body}`);
  return `${header}.${body}.${sig}`;
}

/**
 * Verify a token. Returns the decoded payload object on success,
 * or null if the token is missing/malformed/tampered/expired.
 */
function verifyToken(token) {
  if (!SECRET || !token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const expected = hmac(`${header}.${body}`);

  // constant-time compare to avoid signature timing leaks
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlToBuf(body).toString("utf8"));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.exp === "number" && Math.floor(Date.now() / 1000) > payload.exp) {
    return null; // expired
  }
  return payload;
}

/** Pull a bearer token out of the Authorization header. */
function tokenFromReq(req) {
  const h = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : "";
}

module.exports = { signToken, verifyToken, tokenFromReq, DEFAULT_TTL_SECONDS };
