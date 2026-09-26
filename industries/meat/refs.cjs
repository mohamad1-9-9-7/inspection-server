/* ============================================================
   Meat industry (Al Mawashi) — reference-number rules
   ------------------------------------------------------------
   Registered with the core allocator through industries/index.cjs.
   Changing a prefix here touches meat records only; the core
   never names a meat report type.
============================================================ */
const { normText } = require("../../utils/common.cjs");

/* One continuous counter per type, never reset: "AM-RET-000087".
   `AM` is the Al Mawashi mark — other companies never carry it. */
const mark = "AM";

const prefix = {
  destruction_record:     "CND",
  returns:                "RET",
  returns_customers:      "CRT",
  // NC numbers used to be typed by hand ("NC-001"), so two people raising a
  // finding on the same morning wrote the same number. Each NCR type keeps its
  // own counter: QCS and POS 19 store their reports separately and must not
  // share a sequence.
  qcs_non_conformance:    "NCR",
  pos19_non_conformance:  "NCP",
  // شكاوي الجودة (فروع وموردين) — كل شكوى تحمل مرجعًا مستقلًا (AM-CMP-000123)
  qa_complaint:           "CMP",
};

/* Branch-scoped references: a separate counter per branch, led by the branch
   code — the butcher's cutting log reads "POS 10 — 00001", counting from 1 for
   every branch on its own. The counter row key is `<type>:<branch>`.
   A record without a branch is left unnumbered rather than sharing some
   catch-all counter. */
const scoped = {
  butcher_cut_log: {
    pad: 5,
    scopeOf: (p) => normText(p?.branch || ""),
    format: (scope, n, pad) => `${scope} — ${String(n).padStart(pad, "0")}`,
  },
};

module.exports = { mark, prefix, scoped };
