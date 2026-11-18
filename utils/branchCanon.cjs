/* ============================================================
   branchCanon — one branch, however it was typed.

   Reports store the branch as free text, so one shop arrives as
   "POS 15", "AL BARSHA BUTCHERY (POS15)", "BARSHA BUTCHERY-POS 15" and
   "Al Barsha Butchery". canonBranch() turns every spelling into one key:
     1. a branch code anywhere in the text wins  → "POS 15", "FTR 1"
     2. a known name with no code (ALIASES)      → its code
     3. anything else                            → the cleaned text, upper case
   Used to route alert e-mails (alertEngine recipientsFor) and to list the
   branches on the Alerts page. The frontend copy is src/utils/branchCanon.js —
   keep the two identical.
============================================================ */

const CODE_RE = /\b(POS|FTR)\s*[-–—_.]?\s*0*(\d{1,3})\b/i;

/* Names that carry no code. Order matters: first match wins. */
const ALIASES = [
  [/\bqcs\b/i, "QCS"],
  [/\bqu?a?s[a-z]*is\b.*\bproduction\b|\bproduction\b.*\bqu?a?s[a-z]*is\b/i, "PRODUCTION"],
  [/\bqu?a?s[a-z]*is\b|\bqusai\b/i, "QCS"],
  [/\bbarsha\b.*\bbutcher/i, "POS 15"],
  [/\babu\s*dhabi\b.*\bbutcher/i, "POS 10"],
  [/\bal\s*ain\b.*\bbutcher/i, "POS 14"],
  [/\bmotor\s*city\b/i, "POS 19"],
  [/\bmamzar\b/i, "FTR 2"],
  [/\bmushrif\b/i, "FTR 1"],
  [/\bwar[qk]a\b.*\bkitchen\b|\bkitchen\b.*\bwar[qk]a\b/i, "AL WARQA KITCHEN"],
];

function canonBranch(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  const m = CODE_RE.exec(s);
  if (m) return `${m[1].toUpperCase()} ${Number(m[2])}`;
  for (const [re, key] of ALIASES) if (re.test(s)) return key;
  return s.toUpperCase();
}

const sameBranch = (a, b) => {
  const x = canonBranch(a);
  return !!x && x === canonBranch(b);
};

module.exports = { canonBranch, sameBranch };
