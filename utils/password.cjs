const crypto = require("crypto");

const SCRYPT_PFX = "scrypt:";
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

function genSalt() {
  return SCRYPT_PFX + crypto.randomBytes(32).toString("hex");
}

function hashPw(password, salt) {
  if (salt.startsWith(SCRYPT_PFX)) {
    const rawSalt = Buffer.from(salt.slice(SCRYPT_PFX.length), "hex");
    return crypto.scryptSync(String(password), rawSalt, 64, SCRYPT_PARAMS).toString("hex");
  }
  return crypto.createHmac("sha256", salt).update(String(password)).digest("hex");
}

/* Constant-time: a plain === leaks, through timing, how many leading
   characters of the stored hash a guess matched. */
function verifyPw(password, salt, hash) {
  const a = Buffer.from(String(hashPw(password, salt)));
  const b = Buffer.from(String(hash || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  genSalt,
  hashPw,
  verifyPw,
};
