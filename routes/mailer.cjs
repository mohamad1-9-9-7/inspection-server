/* mailer.cjs — direct SMTP sending.

   Config comes entirely from environment variables (Render dashboard),
   never from the request body, so a caller can never point the server at
   a different mail host or leak the password back out:

     MAIL_HOST       e.g. mail.almawashi.ae
     MAIL_PORT       e.g. 465
     MAIL_SECURE     "true" for implicit TLS (port 465), "false" for STARTTLS (587)
     MAIL_USER       the mailbox — also the From address and where replies land
     MAIL_PASS       mailbox password
     MAIL_FROM_NAME  display name, optional

   SMTP_* is accepted as a fallback for every one of the above.
   Replies go back to MAIL_USER by design — no separate Reply-To is set.
*/

let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch {
  console.warn("[mailer] nodemailer not installed — /api/email/send will report not_configured");
}

/* MailComposer ships inside nodemailer — lets us build the raw MIME of an
   outgoing message so we can drop an identical copy into the IMAP Sent folder. */
let MailComposer = null;
try {
  MailComposer = require("nodemailer/lib/mail-composer");
} catch {
  /* nodemailer missing — already warned above. */
}

/* imapflow is optional. When present (and IMAP_* configured) every successful
   send also gets appended to the Sent folder so it shows up in Outlook. */
let ImapFlow = null;
try {
  ({ ImapFlow } = require("imapflow"));
} catch {
  console.warn("[mailer] imapflow not installed — sent copies won't be saved to the Sent folder");
}

/* Kept below express's 20 MB JSON limit (20 MB of base64 ≈ 15 MB binary) so
   oversized payloads get this friendly JSON error rather than the body-parser
   HTML 413 the client can't parse. */
const MAX_TOTAL_ATTACHMENT_BYTES = 12 * 1024 * 1024;
const MAX_RECIPIENTS = 50;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/* Own rate-limit bucket so email sends never eat into the login limiter. */
const _sendHits = new Map();
const SEND_MAX = 20;
const SEND_WIN_MS = 60_000;

function sendRateOk(key) {
  const now = Date.now();
  let rec = _sendHits.get(key);
  if (!rec || now > rec.resetAt) {
    rec = { count: 0, resetAt: now + SEND_WIN_MS };
    _sendHits.set(key, rec);
  }
  rec.count++;
  return rec.count <= SEND_MAX;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of _sendHits) if (now > rec.resetAt) _sendHits.delete(k);
}, 5 * 60_000);

/* Reads MAIL_* first (what Render is configured with), falling back to SMTP_*
   so either naming works without a dashboard edit. */
function envVar(name) {
  const v = process.env[`MAIL_${name}`];
  return v != null && v !== "" ? v : process.env[`SMTP_${name}`];
}

function smtpConfig() {
  const host = String(envVar("HOST") || "").trim();
  const user = String(envVar("USER") || "").trim();
  const pass = String(envVar("PASS") || "");
  const port = Number(envVar("PORT")) || 465;
  /* Default to implicit TLS on 465, STARTTLS otherwise, unless overridden. */
  const rawSecure = envVar("SECURE");
  const secure = rawSecure != null
    ? String(rawSecure).toLowerCase() === "true"
    : port === 465;
  return {
    host, port, secure, user, pass,
    fromName: String(envVar("FROM_NAME") || "").trim(),
    configured: Boolean(host && user && pass && nodemailer),
  };
}

/* IMAP settings for saving a copy in Sent. Falls back to the SMTP mailbox so a
   single set of credentials works: IMAP_HOST defaults to MAIL_HOST, the user and
   password default to MAIL_USER / MAIL_PASS, port defaults to 993 (implicit TLS).
   Set IMAP_SAVE_SENT=false to turn the whole feature off. */
function imapConfig() {
  const smtp = smtpConfig();
  const host = String(process.env.IMAP_HOST || smtp.host || "").trim();
  const user = String(process.env.IMAP_USER || smtp.user || "").trim();
  const pass = process.env.IMAP_PASS != null && process.env.IMAP_PASS !== ""
    ? String(process.env.IMAP_PASS)
    : smtp.pass;
  const port = Number(process.env.IMAP_PORT) || 993;
  const rawSecure = process.env.IMAP_SECURE;
  const secure = rawSecure != null
    ? String(rawSecure).toLowerCase() === "true"
    : port === 993;
  /* Explicit override of the Sent mailbox name, if auto-detection ever misses. */
  const sentBox = String(process.env.IMAP_SENT_MAILBOX || "").trim();
  const enabled = String(process.env.IMAP_SAVE_SENT || "true").toLowerCase() !== "false";
  return {
    host, port, secure, user, pass, sentBox, enabled,
    configured: Boolean(host && user && pass && ImapFlow),
  };
}

/* Build the raw MIME bytes of the message we just sent. */
function buildRaw(mailOptions) {
  return new Promise((resolve, reject) => {
    if (!MailComposer) return reject(new Error("MailComposer unavailable"));
    new MailComposer(mailOptions).compile().build((err, message) =>
      err ? reject(err) : resolve(message)
    );
  });
}

/* Best-effort: append a copy of the sent message to the IMAP Sent folder so it
   appears in Outlook. Never throws — a failure here must not fail the send. */
async function saveToSent(mailOptions) {
  const cfg = imapConfig();
  if (!cfg.enabled) return { saved: false, reason: "disabled" };
  if (!cfg.configured) return { saved: false, reason: "not_configured" };

  let client;
  try {
    const raw = await buildRaw(mailOptions);
    client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
      connectTimeout: 20_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
    });
    await client.connect();

    /* Find the Sent folder: prefer the one flagged \Sent, then fall back to the
       usual names across Outlook / cPanel / Dovecot servers. */
    let mailbox = cfg.sentBox;
    if (!mailbox) {
      const boxes = await client.list();
      const flagged = boxes.find(
        (b) => Array.isArray(b.flags) && b.flags.includes("\\Sent")
      ) || boxes.find((b) => b.specialUse === "\\Sent");
      if (flagged) {
        mailbox = flagged.path;
      } else {
        const names = new Set(boxes.map((b) => b.path));
        mailbox = ["Sent", "Sent Items", "INBOX.Sent", "INBOX.Sent Items"]
          .find((n) => names.has(n)) || "Sent";
      }
    }

    /* \Seen so the copy isn't shown as unread; internal date = now. */
    await client.append(mailbox, raw, ["\\Seen"], new Date());
    return { saved: true, mailbox };
  } catch (e) {
    console.error("[mailer] saveToSent failed:", e?.message || e);
    return { saved: false, reason: String(e?.message || e).slice(0, 200) };
  } finally {
    try { if (client) await client.logout(); } catch { /* ignore */ }
  }
}

let _transporter = null;
let _transporterKey = "";

function getTransporter(cfg) {
  const key = `${cfg.host}:${cfg.port}:${cfg.secure}:${cfg.user}`;
  if (_transporter && _transporterKey === key) return _transporter;
  _transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
  });
  _transporterKey = key;
  return _transporter;
}

function cleanList(v, cap = MAX_RECIPIENTS) {
  const arr = Array.isArray(v)
    ? v
    : String(v || "").split(/[,;\n]+/);
  const out = [];
  const seen = new Set();
  for (const raw of arr) {
    const e = String(raw || "").trim();
    if (!e) continue;
    const k = e.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= cap) break;
  }
  return out;
}

module.exports = function registerMailerRoutes(app, deps = {}) {
  const { requireAuth } = deps;
  const auth = typeof requireAuth === "function" ? requireAuth : (req, res, next) => next();

  /* Is direct sending available? Never exposes the password. */
  app.get("/api/email/status", (req, res) => {
    const cfg = smtpConfig();
    res.json({
      ok: true,
      configured: cfg.configured,
      nodemailer: Boolean(nodemailer),
      host: cfg.host || null,
      port: cfg.port,
      secure: cfg.secure,
      from: cfg.user || null,
      fromName: cfg.fromName || null,
    });
  });

  /* Handshake check — proves host/port/credentials before anyone sends. */
  app.post("/api/email/verify", auth, async (req, res) => {
    const cfg = smtpConfig();
    if (!cfg.configured) {
      return res.status(503).json({ ok: false, error: "not_configured" });
    }
    try {
      await getTransporter(cfg).verify();
      res.json({ ok: true, message: `SMTP OK — ${cfg.host}:${cfg.port}` });
    } catch (e) {
      console.error("POST /api/email/verify ERROR:", e?.message || e);
      res.status(502).json({ ok: false, error: "smtp_verify_failed", detail: String(e?.message || e).slice(0, 300) });
    }
  });

  /* Send. Attachments arrive as base64 so the same payload the .eml builder
     already produces on the client can be reused unchanged. */
  app.post("/api/email/send", auth, async (req, res) => {
    const cfg = smtpConfig();
    if (!cfg.configured) {
      return res.status(503).json({ ok: false, error: "not_configured" });
    }

    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    if (!sendRateOk(String(ip))) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }

    const b = req.body || {};
    const to  = cleanList(b.to);
    const cc  = cleanList(b.cc);
    const bcc = cleanList(b.bcc);
    const subject = String(b.subject || "").trim().slice(0, 500);

    if (!to.length) return res.status(400).json({ ok: false, error: "no_recipients" });
    const bad = [...to, ...cc, ...bcc].find((e) => !EMAIL_RE.test(e));
    if (bad) return res.status(400).json({ ok: false, error: "invalid_email", detail: bad });
    if (!subject) return res.status(400).json({ ok: false, error: "no_subject" });

    /* Decode + size-check attachments before opening a connection. */
    const attachments = [];
    let totalBytes = 0;
    for (const a of Array.isArray(b.attachments) ? b.attachments : []) {
      const base64 = String(a?.base64 || "").replace(/^data:[^;]+;base64,/, "");
      if (!base64) continue;
      let buf;
      try {
        buf = Buffer.from(base64, "base64");
      } catch {
        return res.status(400).json({ ok: false, error: "bad_attachment" });
      }
      totalBytes += buf.length;
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        return res.status(413).json({ ok: false, error: "attachments_too_large" });
      }
      attachments.push({
        filename: String(a?.filename || "attachment").slice(0, 200),
        content: buf,
        contentType: String(a?.contentType || "application/octet-stream").slice(0, 100),
      });
    }

    const headers = {};
    if (b.priority === "high") { headers["X-Priority"] = "1"; headers.Importance = "High"; }
    else if (b.priority === "low") { headers["X-Priority"] = "5"; headers.Importance = "Low"; }

    const mailOptions = {
      from: cfg.fromName ? `"${cfg.fromName}" <${cfg.user}>` : cfg.user,
      to, cc, bcc,
      subject,
      html: b.html ? String(b.html) : undefined,
      text: b.text ? String(b.text) : undefined,
      attachments,
      headers,
    };

    try {
      const info = await getTransporter(cfg).sendMail(mailOptions);
      console.log(`[mailer] sent "${subject}" → ${to.length + cc.length + bcc.length} recipient(s), ${attachments.length} attachment(s)`);

      /* Save a copy in the Sent folder so it shows up in Outlook. Best-effort:
         the send already succeeded, so we never let this turn it into a failure. */
      const sent = await saveToSent(mailOptions);
      if (sent.saved) console.log(`[mailer] copy saved to "${sent.mailbox}"`);
      else console.warn(`[mailer] sent copy NOT saved (${sent.reason})`);

      res.json({
        ok: true,
        messageId: info.messageId,
        accepted: info.accepted || [],
        rejected: info.rejected || [],
        savedToSent: sent.saved,
      });
    } catch (e) {
      console.error("POST /api/email/send ERROR:", e?.message || e);
      res.status(502).json({ ok: false, error: "smtp_send_failed", detail: String(e?.message || e).slice(0, 300) });
    }
  });
};
