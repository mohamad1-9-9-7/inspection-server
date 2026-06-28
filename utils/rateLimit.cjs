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

module.exports = {
  rlCheck,
  rlReset,
};
