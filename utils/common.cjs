const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

const parseMaybeJSON = (x) =>
  isObj(x)
    ? x
    : typeof x === "string"
    ? (() => {
        try {
          return JSON.parse(x);
        } catch {
          return x;
        }
      })()
    : x;

function clampInt(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ""), 10);
  const x = Number.isFinite(n) ? n : def;
  return Math.max(min, Math.min(max, x));
}

function normText(v) {
  return String(v ?? "").trim();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function safeObj(x) {
  return isObj(x) ? x : {};
}

function normKey(s) {
  return String(s ?? "").trim().toLowerCase();
}

module.exports = {
  isObj,
  parseMaybeJSON,
  clampInt,
  normText,
  todayISO,
  safeArr,
  safeObj,
  normKey,
};
