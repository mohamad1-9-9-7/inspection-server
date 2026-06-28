const pg = require("pg");

const { Pool } = pg;

function withSSL(url) {
  if (!url) {
    console.error("Missing DATABASE_URL");
    process.exit(1);
  }
  return url.includes("?") ? `${url}&sslmode=require` : `${url}?sslmode=require`;
}

const pool = new Pool({
  connectionString: withSSL(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

pool.on("error", (err) => {
  console.error("Pool connection error (auto-recovered):", err.message);
});

const DB_CONNECTIVITY_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "08000",
  "08001",
  "08003",
  "08006",
  "53300",
  "57P01",
  "57P02",
  "57P03",
]);

function isDbConnectivityError(err) {
  const message = String(err?.message || err || "").toLowerCase();
  return (
    DB_CONNECTIVITY_ERROR_CODES.has(String(err?.code || "")) ||
    message.includes("connection terminated") ||
    message.includes("connection timeout") ||
    message.includes("timeout expired") ||
    message.includes("terminating connection")
  );
}

async function rollbackQuietly(client) {
  if (!client) return;
  try {
    await client.query("ROLLBACK");
  } catch {}
}

function sendDbError(res, err) {
  const status = isDbConnectivityError(err) ? 503 : 500;
  const error = status === 503 ? "DB_CONNECTION_FAILED" : "DB_QUERY_FAILED";
  return res.status(status).json({ ok: false, error, message: String(err?.message || err) });
}

module.exports = {
  pool,
  rollbackQuietly,
  sendDbError,
  isDbConnectivityError,
};
